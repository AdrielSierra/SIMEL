const express = require("express");
const { checkSimel } = require("./simel-check");
const { runBatch } = require("./simel-batch");
const {
  obtenerUsuariosSimelActivos,
  actualizarResultadoSimel,
  crearJobSimel,
  buscarJobPendienteOEnProceso,
  obtenerJobPorTexto,
  obtenerDetallesJobSimel,
  obtenerUltimoJobSimel
} = require("./airtable");
const { iniciarWorker } = require("./worker");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

function armarResumenDetalle(items) {
  return {
    ok: items.filter((x) => x.estado === "OK").length,
    sinManifiesto: items.filter((x) => x.estado === "SIN_MANIFIESTO").length,
    error: items.filter((x) => x.estado === "ERROR").length
  };
}

async function enviarWhatsAppTexto({ to, body }) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID");
  }

  const version = process.env.WHATSAPP_API_VERSION || "v22.0";
  const url = `https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body }
  };

  console.log("[WhatsApp] Enviando mensaje a:", to);
  console.log("[WhatsApp] Payload:", JSON.stringify(payload));

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  console.log("[WhatsApp] Status envío:", response.status);
  console.log("[WhatsApp] Respuesta Graph:", JSON.stringify(data));

  if (!response.ok) {
    throw new Error(`WhatsApp API error: ${response.status} - ${JSON.stringify(data)}`);
  }

  return data;
}

app.get("/", (req, res) => {
  res.send("SIMEL bot funcionando en Railway 🚀 - WhatsApp activo");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "simel-bot",
    timestamp: new Date().toISOString()
  });
});

app.get("/check", async (req, res) => {
  try {
    const user = req.query.user || process.env.SIMEL_USER;
    const pass = req.query.pass || process.env.SIMEL_PASS;

    if (!user || !pass) {
      return res.status(400).json({
        ok: false,
        error: "Faltan credenciales. Enviá ?user=...&pass=... o configurá SIMEL_USER y SIMEL_PASS."
      });
    }

    const resultado = await checkSimel(user, pass);

    return res.status(200).json(resultado);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/batch/run", async (req, res) => {
  try {
    const secret = req.headers["x-batch-secret"];

    if (!process.env.BATCH_SECRET || secret !== process.env.BATCH_SECRET) {
      return res.status(401).json({
        ok: false,
        error: "No autorizado"
      });
    }

    const usuarios = req.body.usuarios;

    const resultado = await runBatch({
      usuarios,
      onResultado: actualizarResultadoSimel
    });

    return res.status(200).json(resultado);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/batch/url-run", async (req, res) => {
  try {
    const token = req.query.token;
    const limit = Number(req.query.limit || 5);

    if (!process.env.BATCH_URL_TOKEN || token !== process.env.BATCH_URL_TOKEN) {
      return res.status(401).json({
        ok: false,
        error: "Token inválido"
      });
    }

    const usuarios = await obtenerUsuariosSimelActivos({ limit });

    if (!usuarios.length) {
      return res.status(200).json({
        ok: true,
        total: 0,
        mensaje: "No hay usuarios activos para batch"
      });
    }

    const resultado = await runBatch({
      usuarios,
      onResultado: actualizarResultadoSimel
    });

    return res.status(200).json(resultado);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/jobs/simel/start", async (req, res) => {
  try {
    const secret = req.headers["x-batch-secret"];

    if (!process.env.BATCH_SECRET || secret !== process.env.BATCH_SECRET) {
      return res.status(401).json({
        ok: false,
        error: "No autorizado"
      });
    }

    const jobExistente = await buscarJobPendienteOEnProceso();

    if (jobExistente) {
      return res.status(200).json({
        ok: false,
        mensaje: `Ya existe un job en curso (${jobExistente.estado})`,
        jobId: jobExistente.jobId,
        estado: jobExistente.estado
      });
    }

    const usuarios = await obtenerUsuariosSimelActivos({ limit: 1000 });

    if (!usuarios.length) {
      return res.status(200).json({
        ok: true,
        mensaje: "No hay empresas pendientes para procesar"
      });
    }

    const job = await crearJobSimel({
      totalEmpresas: usuarios.length,
      disparadoPor: "Manual",
      detalle: "Job creado desde endpoint"
    });

    return res.status(200).json({
      ok: true,
      mensaje: "Job creado correctamente",
      jobId: job.jobId,
      totalEmpresas: usuarios.length
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/jobs/simel/ultimo/errores", async (req, res) => {
  try {
    const job = await obtenerUltimoJobSimel();

    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "No hay jobs registrados"
      });
    }

    const items = await obtenerDetallesJobSimel(job.jobId);
    const errores = items.filter((x) => x.estado === "ERROR");

    return res.status(200).json({
      ok: true,
      jobId: job.jobId,
      totalErrores: errores.length,
      items: errores
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/jobs/simel/ultimo", async (req, res) => {
  try {
    const job = await obtenerUltimoJobSimel();

    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "No hay jobs registrados"
      });
    }

    return res.status(200).json({
      ok: true,
      job
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/jobs/simel/:jobId/detalle", async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const job = await obtenerJobPorTexto(jobId);

    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "Job no encontrado"
      });
    }

    const items = await obtenerDetallesJobSimel(jobId);
    const resumen = armarResumenDetalle(items);

    return res.status(200).json({
      ok: true,
      jobId,
      total: items.length,
      resumen,
      items
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/jobs/simel/:jobId/errores", async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const job = await obtenerJobPorTexto(jobId);

    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "Job no encontrado"
      });
    }

    const items = await obtenerDetallesJobSimel(jobId);
    const errores = items.filter((x) => x.estado === "ERROR");

    return res.status(200).json({
      ok: true,
      jobId,
      totalErrores: errores.length,
      items: errores
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/jobs/simel/:jobId", async (req, res) => {
  try {
    const job = await obtenerJobPorTexto(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "Job no encontrado"
      });
    }

    return res.status(200).json({
      ok: true,
      job
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.status(403).json({
    ok: false,
    error: "Verificación inválida"
  });
});

app.post("/whatsapp/webhook", async (req, res) => {
  try {
    console.log("[WhatsApp] Payload crudo:", JSON.stringify(req.body));

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) {
      console.log("[WhatsApp] Evento sin mensaje");
      return res.status(200).json({ ok: true });
    }

    const from = message.from || "";
    const type = message.type || "";
    const text = (message.text?.body || "").trim();

    console.log("[WhatsApp] Mensaje recibido");
    console.log("From:", from);
    console.log("Type:", type);
    console.log("Text:", text);

    if (type !== "text") {
      console.log("[WhatsApp] Tipo no soportado, no se responde");
      return res.status(200).json({ ok: true });
    }

    let respuesta = "Comando no reconocido.\n\nProbá:\n- simel estado\n- simel errores";

    if (/^simel estado$/i.test(text)) {
      const job = await obtenerUltimoJobSimel();

      if (!job) {
        respuesta = "No hay jobs registrados.";
      } else {
        respuesta =
          `Último job: ${job.jobId}\n` +
          `Estado: ${job.estado}\n` +
          `Empresas: ${job.totalEmpresas}\n` +
          `Procesadas: ${job.procesadas}\n` +
          `Sin manifiesto: ${job.sinManifiesto}\n` +
          `Con error: ${job.conError}`;
      }
    } else if (/^simel errores$/i.test(text)) {
      const job = await obtenerUltimoJobSimel();

      if (!job) {
        respuesta = "No hay jobs registrados.";
      } else {
        const items = await obtenerDetallesJobSimel(job.jobId);
        const errores = items.filter((x) => x.estado === "ERROR");

        if (!errores.length) {
          respuesta = `El último job (${job.jobId}) no tiene errores.`;
        } else {
          const top = errores.slice(0, 5).map((e, i) =>
            `${i + 1}. ${e.empresa} - ${(e.detalle || "ERROR").split("\n")[0]}`
          );

          respuesta =
            `Errores en ${job.jobId}: ${errores.length}\n\n` +
            top.join("\n");
        }
      }
    }

    const destinoWhatsapp = process.env.WHATSAPP_TEST_TO || from;

    console.log("[WhatsApp] From recibido:", from);
    console.log("[WhatsApp] Destino usado para enviar:", destinoWhatsapp);

    try {
      await enviarWhatsAppTexto({
        to: destinoWhatsapp,
        body: respuesta
      });

      console.log("[WhatsApp] Respuesta enviada correctamente");
    } catch (sendError) {
      console.error("[WhatsApp] Error enviando respuesta:", sendError.message);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[WhatsApp] Error en webhook:", error.message);
    return res.status(200).json({ ok: true });
  }
});

iniciarWorker();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});