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
  obtenerUltimoJobSimel,
  buscarAutorizadoWhatsApp,
  actualizarUltimaInteraccionWhatsApp,
  crearLogWhatsApp,
  obtenerMenuWhatsApp,
  obtenerConfigWhatsApp,
  listarManifiestosPendientesActivos
} = require("./airtable");
const { iniciarWorker } = require("./worker");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const mensajesProcesados = new Set();

function limpiarMensajesProcesados() {
  if (mensajesProcesados.size > 1000) {
    mensajesProcesados.clear();
  }
}

function armarResumenDetalle(items) {
  return {
    ok: items.filter((x) => x.estado === "OK").length,
    sinManifiesto: items.filter((x) => x.estado === "SIN_MANIFIESTO").length,
    error: items.filter((x) => x.estado === "ERROR").length
  };
}

function tienePermiso(contacto, permisoRequerido = "") {
  if (!contacto) return false;

  const mapa = {
    "Puede ver menú": contacto.puedeVerMenu,
    "Puede consultar estado": contacto.puedeConsultarEstado,
    "Puede consultar errores": contacto.puedeConsultarErrores,
    "Puede ver detalle job": contacto.puedeVerDetalleJob,
    "Puede ejecutar batch": contacto.puedeEjecutarBatch,
    "Puede ver manifiestos pendientes": contacto.puedeVerManifiestosPendientes,
    "Puede solicitar aprobación": contacto.puedeSolicitarAprobacion,
    "Puede confirmar aprobación": contacto.puedeConfirmarAprobacion,
    "Puede aprobar manifiestos": contacto.puedeAprobarManifiestos
  };

  return !!mapa[permisoRequerido];
}

function detectarComando(texto = "") {
  const t = texto.trim();

  if (/^(menu|ayuda|hola|opciones|0)$/i.test(t)) {
    return { codigo: "MENU" };
  }

  if (/^(1|simel estado)$/i.test(t)) {
    return { codigo: "SIMEL_ESTADO" };
  }

  if (/^(2|simel errores)$/i.test(t)) {
    return { codigo: "SIMEL_ERRORES" };
  }

  const detalleMatch = t.match(/^simel detalle\s+(JOB-[A-Za-z0-9-]+)$/i);
  if (detalleMatch) {
    return { codigo: "SIMEL_DETALLE", jobId: detalleMatch[1] };
  }

  if (/^(4|simel start)$/i.test(t)) {
    return { codigo: "SIMEL_START" };
  }

  if (/^(3|manifiestos pendientes|pendientes|pendientes aprobar)$/i.test(t)) {
    return { codigo: "MANIFIESTOS_PENDIENTES" };
  }

  return { codigo: "DESCONOCIDO" };
}

async function construirMenu(contacto) {
  const configBotNombre = await obtenerConfigWhatsApp("BOT_NOMBRE");
  const configBienvenida = await obtenerConfigWhatsApp("MENU_BIENVENIDA");

  const botNombre = configBotNombre?.valorTexto || "HySA Bot";
  const bienvenida =
    configBienvenida?.valorTexto ||
    `Hola, soy ${botNombre}. Elegí una opción o escribí un comando.`;

  const menuDesdeTabla = await obtenerMenuWhatsApp();

  let items = menuDesdeTabla.filter((item) => {
    if (!item.activo) return false;
    if (!item.requiereAutorizacion) return true;
    return tienePermiso(contacto, item.permisoRequerido);
  });

  if (!items.length) {
    items = [
      { titulo: "Estado del último job", comandoExacto: "simel estado" },
      { titulo: "Errores del último job", comandoExacto: "simel errores" },
      { titulo: "Manifiestos pendientes", comandoExacto: "manifiestos pendientes" },
      { titulo: "Ejecutar batch SIMEL", comandoExacto: "simel start" }
    ];
  }

  const lineas = items.map((item, index) => {
    const comando = item.comandoExacto ? ` → ${item.comandoExacto}` : "";
    return `${index + 1}. ${item.titulo}${comando}`;
  });

  return `${bienvenida}\n\n${lineas.join("\n")}`;
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

async function crearJobDesdeBackend(disparadoPor = "Manual") {
  const jobExistente = await buscarJobPendienteOEnProceso();

  if (jobExistente) {
    return {
      ok: false,
      yaExiste: true,
      mensaje: `Ya existe un job en curso (${jobExistente.estado})`,
      jobId: jobExistente.jobId
    };
  }

  const usuarios = await obtenerUsuariosSimelActivos({ limit: 1000 });

  if (!usuarios.length) {
    return {
      ok: false,
      sinPendientes: true,
      mensaje: "No hay empresas pendientes para procesar"
    };
  }

  const job = await crearJobSimel({
    totalEmpresas: usuarios.length,
    disparadoPor,
    detalle: "Job creado desde backend"
  });

  return {
    ok: true,
    mensaje: "Job creado correctamente",
    jobId: job.jobId,
    totalEmpresas: usuarios.length
  };
}

app.get("/", (req, res) => {
  res.send("SIMEL bot funcionando en Railway 🚀 - WhatsApp + menú + start + pendientes");
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

    const resultado = await crearJobDesdeBackend("Manual");

    return res.status(200).json(resultado);
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
    const payloadCrudo = JSON.stringify(req.body);
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const status = value?.statuses?.[0];
    if (status) {
      console.log("[WhatsApp] Status recibido:", status.status, "-", status.recipient_id);

      await crearLogWhatsApp({
        telefonoRemitente: status.recipient_id || "",
        tipoEvento: "Status Meta",
        payloadCrudoEntrada: payloadCrudo,
        estadoEjecucion: "OK",
        statusEntregaMeta: status.status || ""
      });

      return res.status(200).json({ ok: true });
    }

    const message = value?.messages?.[0];

    if (!message) {
      console.log("[WhatsApp] Evento sin mensaje");
      return res.status(200).json({ ok: true });
    }

    const messageId = message.id || "";
    const from = message.from || "";
    const type = message.type || "";
    const text = (message.text?.body || "").trim();

    if (messageId && mensajesProcesados.has(messageId)) {
      console.log("[WhatsApp] Mensaje duplicado ignorado:", messageId);
      return res.status(200).json({ ok: true });
    }

    if (messageId) {
      mensajesProcesados.add(messageId);
      limpiarMensajesProcesados();
    }

    console.log("[WhatsApp] Mensaje recibido");
    console.log("From:", from);
    console.log("Type:", type);
    console.log("Text:", text);

    const comando = detectarComando(text);
    const contacto = await buscarAutorizadoWhatsApp(from);

    await crearLogWhatsApp({
      telefonoRemitente: from,
      autorizado: !!(contacto && contacto.activo),
      contactoAutorizadoRecordId: contacto?.airtableRecordId || null,
      nombreRemitente: contacto?.nombre || value?.contacts?.[0]?.profile?.name || "",
      tipoEvento: "Mensaje entrante",
      messageIdMeta: messageId,
      payloadCrudoEntrada: payloadCrudo,
      textoRecibido: text,
      comandoDetectado: comando.codigo,
      estadoEjecucion: "OK"
    });

    if (!contacto || !contacto.activo) {
      const respuesta = "Tu número no está autorizado para usar este bot.";

      const destinoWhatsapp = process.env.WHATSAPP_TEST_TO || from;

      try {
        await enviarWhatsAppTexto({
          to: destinoWhatsapp,
          body: respuesta
        });
      } catch (sendError) {
        console.error("[WhatsApp] Error enviando respuesta de no autorizado:", sendError.message);
      }

      await crearLogWhatsApp({
        telefonoRemitente: from,
        autorizado: false,
        nombreRemitente: value?.contacts?.[0]?.profile?.name || "",
        tipoEvento: "Mensaje saliente",
        messageIdMeta: messageId,
        textoRecibido: text,
        comandoDetectado: comando.codigo,
        respuestaEnviada: respuesta,
        estadoEjecucion: "Sin permiso"
      });

      return res.status(200).json({ ok: true });
    }

    await actualizarUltimaInteraccionWhatsApp(contacto.airtableRecordId, comando.codigo);

    if (type !== "text") {
      const respuesta = "Solo acepto mensajes de texto por ahora.";
      const destinoWhatsapp = process.env.WHATSAPP_TEST_TO || from;

      try {
        await enviarWhatsAppTexto({
          to: destinoWhatsapp,
          body: respuesta
        });
      } catch (sendError) {
        console.error("[WhatsApp] Error enviando respuesta de tipo no soportado:", sendError.message);
      }

      await crearLogWhatsApp({
        telefonoRemitente: from,
        autorizado: true,
        contactoAutorizadoRecordId: contacto.airtableRecordId,
        nombreRemitente: contacto.nombre || "",
        tipoEvento: "Mensaje saliente",
        messageIdMeta: messageId,
        textoRecibido: text,
        comandoDetectado: comando.codigo,
        respuestaEnviada: respuesta,
        estadoEjecucion: "Ignorado"
      });

      return res.status(200).json({ ok: true });
    }

    let respuesta = "Comando no reconocido.\n\nEscribí MENU para ver las opciones.";
    let jobRelacionado = null;

    if (comando.codigo === "MENU") {
      if (!contacto.puedeVerMenu) {
        respuesta = "No tenés permiso para ver el menú.";
      } else {
        respuesta = await construirMenu(contacto);
      }
    }

    if (comando.codigo === "SIMEL_ESTADO") {
      if (!contacto.puedeConsultarEstado) {
        respuesta = "No tenés permiso para consultar el estado.";
      } else {
        const job = await obtenerUltimoJobSimel();

        if (!job) {
          respuesta = "No hay jobs registrados.";
        } else {
          jobRelacionado = job;
          respuesta =
            `Último job: ${job.jobId}\n` +
            `Estado: ${job.estado}\n` +
            `Empresas: ${job.totalEmpresas}\n` +
            `Procesadas: ${job.procesadas}\n` +
            `Sin manifiesto: ${job.sinManifiesto}\n` +
            `Con error: ${job.conError}`;
        }
      }
    }

    if (comando.codigo === "SIMEL_ERRORES") {
      if (!contacto.puedeConsultarErrores) {
        respuesta = "No tenés permiso para consultar errores.";
      } else {
        const job = await obtenerUltimoJobSimel();

        if (!job) {
          respuesta = "No hay jobs registrados.";
        } else {
          jobRelacionado = job;
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
    }

    if (comando.codigo === "SIMEL_DETALLE") {
      if (!contacto.puedeVerDetalleJob) {
        respuesta = "No tenés permiso para ver detalle de jobs.";
      } else {
        const job = await obtenerJobPorTexto(comando.jobId);

        if (!job) {
          respuesta = `No encontré el job ${comando.jobId}.`;
        } else {
          jobRelacionado = job;
          const items = await obtenerDetallesJobSimel(comando.jobId);
          const resumen = armarResumenDetalle(items);
          const errores = items.filter((x) => x.estado === "ERROR").slice(0, 3);

          respuesta =
            `Detalle ${comando.jobId}\n` +
            `Total: ${items.length}\n` +
            `OK: ${resumen.ok}\n` +
            `Sin manifiesto: ${resumen.sinManifiesto}\n` +
            `Con error: ${resumen.error}`;

          if (errores.length) {
            respuesta +=
              `\n\nErrores:\n` +
              errores.map((e, i) => `${i + 1}. ${e.empresa}`).join("\n");
          }
        }
      }
    }

    if (comando.codigo === "SIMEL_START") {
      if (!contacto.puedeEjecutarBatch) {
        respuesta = "No tenés permiso para ejecutar batch.";
      } else {
        const resultadoStart = await crearJobDesdeBackend(`WhatsApp - ${contacto.nombre || contacto.telefono}`);

        if (resultadoStart.ok) {
          respuesta =
            `Job creado correctamente.\n` +
            `Job ID: ${resultadoStart.jobId}\n` +
            `Empresas a procesar: ${resultadoStart.totalEmpresas}`;
        } else {
          respuesta = resultadoStart.mensaje || "No se pudo crear el job.";
        }
      }
    }

    if (comando.codigo === "MANIFIESTOS_PENDIENTES") {
      if (!contacto.puedeVerManifiestosPendientes) {
        respuesta = "No tenés permiso para ver manifiestos pendientes.";
      } else {
        const pendientes = await listarManifiestosPendientesActivos({ limit: 10 });

        if (!pendientes.length) {
          respuesta = "No hay manifiestos pendientes de aprobación.";
        } else {
          const lineas = pendientes.map((p, i) => {
            const empresa = p.empresa || "Empresa sin nombre";
            const cantidad = p.cantidadPendientes || 0;
            return `${i + 1}. ${empresa} (${cantidad})`;
          });

          respuesta =
            `Empresas con manifiestos pendientes:\n\n` +
            lineas.join("\n");
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

      await crearLogWhatsApp({
        telefonoRemitente: from,
        autorizado: true,
        contactoAutorizadoRecordId: contacto.airtableRecordId,
        nombreRemitente: contacto.nombre || "",
        tipoEvento: "Error",
        messageIdMeta: messageId,
        textoRecibido: text,
        comandoDetectado: comando.codigo,
        jobIdRelacionado: jobRelacionado?.jobId || "",
        jobAirtableRecordId: jobRelacionado?.airtableRecordId || null,
        respuestaEnviada: respuesta,
        estadoEjecucion: "Error",
        errorTecnico: sendError.message
      });

      return res.status(200).json({ ok: true });
    }

    await crearLogWhatsApp({
      telefonoRemitente: from,
      autorizado: true,
      contactoAutorizadoRecordId: contacto.airtableRecordId,
      nombreRemitente: contacto.nombre || "",
      tipoEvento: "Mensaje saliente",
      messageIdMeta: messageId,
      textoRecibido: text,
      comandoDetectado: comando.codigo,
      jobIdRelacionado: jobRelacionado?.jobId || "",
      jobAirtableRecordId: jobRelacionado?.airtableRecordId || null,
      respuestaEnviada: respuesta,
      estadoEjecucion: "OK",
      statusEnvioMeta: "sent"
    });

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