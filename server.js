const express = require("express");
const fs = require("fs");
const path = require("path");
const { checkSimel } = require("./simel-check");
const { runBatch } = require("./simel-batch");
const { listarPendientesSimel, operarManifiestoSimel, limpiarArchivoTemporal } = require("./simel-pendientes");

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
  listarManifiestosPendientesActivos,
  listarEmpresasSimel,
  listarPendientesPorEmpresa,
  obtenerSesionWhatsApp,
  guardarSesionWhatsApp,
  cerrarSesionWhatsApp,
  crearAprobacionSimel,
  buscarAprobacionPorToken,
  actualizarEstadoAprobacion,
  obtenerHistorialAprobacionesEmpresa,
  obtenerDatosEmpresaSimel,
  marcarEmpresasParaReintentar,
  obtenerUsuarioSimelPorEmpresa
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

// === MEJORA 3: RATE LIMITING POR N�MERO ===

const contadorMensajes = new Map();

function verificarRateLimit(telefono) {
  const ahora = Date.now();
  const ventana = 60 * 1000; // 1 minuto
  const limite = 15; // m�ximo 15 mensajes por minuto

  if (!contadorMensajes.has(telefono)) {
    contadorMensajes.set(telefono, []);
  }

  const timestamps = contadorMensajes.get(telefono).filter(t => ahora - t < ventana);
  timestamps.push(ahora);
  contadorMensajes.set(telefono, timestamps);

  return timestamps.length <= limite;
}

// Limpiar contadores cada 5 minutos
setInterval(() => {
  const ahora = Date.now();
  const ventana = 60 * 1000;
  for (const [tel, timestamps] of contadorMensajes.entries()) {
    const activos = timestamps.filter(t => ahora - t < ventana);
    if (activos.length === 0) contadorMensajes.delete(tel);
    else contadorMensajes.set(tel, activos);
  }
}, 5 * 60 * 1000);

function normalizarTextoBusqueda(valor = "") {
  return String(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function distanciaLevenshtein(a = "", b = "") {
  const matriz = Array.from({ length: b.length + 1 }, () => []);
  for (let i = 0; i <= b.length; i++) matriz[i][0] = i;
  for (let j = 0; j <= a.length; j++) matriz[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const costo = a[j - 1] === b[i - 1] ? 0 : 1;
      matriz[i][j] = Math.min(
        matriz[i - 1][j] + 1,
        matriz[i][j - 1] + 1,
        matriz[i - 1][j - 1] + costo
      );
    }
  }

  return matriz[b.length][a.length];
}

function buscarEmpresasInteligente(empresas, termino) {
  const t = normalizarTextoBusqueda(termino);

  return empresas
    .map((empresa) => {
      const e = normalizarTextoBusqueda(empresa);
      let score = 0;

      if (e === t) {
        score = 100;
      } else if (e.startsWith(t)) {
        score = 92;
      } else if (e.includes(t)) {
        score = 84;
      } else {
        const dist = distanciaLevenshtein(e, t);
        const ratio = 1 - dist / Math.max(e.length, t.length, 1);
        score = Math.round(ratio * 70);
      }

      return { empresa, score };
    })
    .filter((x) => x.score >= 45)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.empresa.localeCompare(b.empresa, "es", { sensitivity: "base" })
    )
    .slice(0, 5);
}

function parsearJSONSeguro(texto, fallback = null) {
  try {
    return JSON.parse(texto || "");
  } catch {
    return fallback;
  }
}

function normalizarTextoPlano(valor = "") {
  return String(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function construirListadoRevision(items = []) {
  if (!items.length) return "No hay manifiestos pendientes.";

  return items
    .map((m, idx) => {
      const primerResiduo = m.residuos?.[0]?.residuo || "N/D";
      const primerCantidad = m.residuos?.[0]?.cantidadEst || "N/D";
      const transportista = m.transportistas?.[0]?.nombre || "N/D";
      return `${idx + 1}. ID ${m.idOperacion} | Residuo: ${primerResiduo} | Cant. Est: ${primerCantidad} | Transportista: ${transportista}`;
    })
    .join("\n");
}

function construirDetalleRevision(item, idx, total) {
  const residuos = (item.residuos || [])
    .slice(0, 5)
    .map((r, i) => `${i + 1}. ${r.residuo || "N/D"} | Cant. Est: ${r.cantidadEst || "N/D"} ${r.unidad || ""}`.trim())
    .join("\n");

  const transportistas = (item.transportistas || [])
    .slice(0, 5)
    .map((t, i) => `${i + 1}. ${t.nombre || "N/D"} | CUIT: ${t.cuit || "N/D"}`)
    .join("\n");

  return (
    `*Manifiesto ${idx + 1}/${total}*\n` +
    `ID Operacion: ${item.idOperacion}\n` +
    `Fecha: ${item.fechaCreacion || "N/D"}\n` +
    `Empresa creadora: ${item.empresaCreadora || "N/D"}\n` +
    `Est. creador: ${item.establecimientoCreador || "N/D"}\n\n` +
    `*Residuos*\n${residuos || "Sin datos"}\n\n` +
    `*Transportistas*\n${transportistas || "Sin datos"}\n\n` +
    `Opciones:\n` +
    `1. Aceptar este manifiesto\n` +
    `2. Rechazar este manifiesto\n` +
    `3. Cancelar\n` +
    `4. Aceptar todos\n` +
    `5. Ver lista\n` +
    `6. Siguiente\n\n` +
    `Tambien podes escribir: Aceptar, Rechazar, Cancelar, Aceptar todos, Lista o Siguiente`
  );
}

function buscarIndiceManifiesto(items = [], target = "", indiceFallback = 0) {
  const limpio = String(target || "").trim();
  if (!limpio) return indiceFallback;

  if (/^\d+$/.test(limpio)) {
    const numero = Number(limpio);
    const porIndice = numero - 1;
    if (porIndice >= 0 && porIndice < items.length) return porIndice;

    const porId = items.findIndex((x) => String(x.idOperacion) === limpio);
    return porId >= 0 ? porId : -1;
  }

  const porIdTexto = items.findIndex((x) => String(x.idOperacion) === limpio);
  return porIdTexto >= 0 ? porIdTexto : -1;
}

function resumirErrorPendientesSimel(error = "") {
  const detalle = String(error || "").trim();
  const detallePlano = detalle.replace(/\s+/g, " ");

  if (!detallePlano) {
    return "No pude consultar los pendientes en SIMEL. Intenta de nuevo en unos segundos.";
  }

  if (/timeout/i.test(detallePlano)) {
    return "SIMEL tard� demasiado en responder al consultar pendientes. Intenta nuevamente.";
  }

  if (/login|credencial|usuario|password/i.test(detallePlano)) {
    return "No pude entrar a SIMEL con las credenciales de esa empresa.";
  }

  return "No pude consultar los pendientes en SIMEL en este momento.";
}

async function construirRespuestaPendientesEmpresa(nombreEmpresa) {
  const pendientes = await listarPendientesPorEmpresa(nombreEmpresa);

  if (!pendientes.length) {
    return `? *${nombreEmpresa}*\n\nNo tiene manifiestos pendientes de aprobaci�n.`;
  }

  const total = pendientes.reduce(
    (acc, item) => acc + Number(item.cantidadPendientes || 0),
    0
  );

  const detalle = pendientes
    .slice(0, 5)
    .map((p, i) => {
      const cantidad = p.cantidadPendientes || 0;
      const job = p.jobIdTexto || "Sin job";
      return `${i + 1}. ${cantidad} pendiente(s) - ${job}`;
    })
    .join("\n");

  return (
    `?? *${nombreEmpresa}*\n\n` +
    `Tiene manifiestos pendientes de aprobaci�n.\n` +
    `Total: *${total}*\n\n` +
    `${detalle}`
  );
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
    "Puede ver men�": contacto.puedeVerMenu,
    "Puede consultar estado": contacto.puedeConsultarEstado,
    "Puede consultar errores": contacto.puedeConsultarErrores,
    "Puede ver detalle job": contacto.puedeVerDetalleJob,
    "Puede ejecutar batch": contacto.puedeEjecutarBatch,
    "Puede ver manifiestos pendientes": contacto.puedeVerManifiestosPendientes,
    "Puede solicitar aprobaci�n": contacto.puedeSolicitarAprobacion,
    "Puede confirmar aprobaci�n": contacto.puedeConfirmarAprobacion,
    "Puede aprobar manifiestos": contacto.puedeAprobarManifiestos
  };

  return !!mapa[permisoRequerido];
}

// === MEJORA 1: GENERADOR DE TOKENS ===

function generarTokenAprobacion() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function detectarComando(texto = "") {
  const t = texto.trim();

  if (/^(menu|ayuda|hola|opciones|0)$/i.test(t)) {
    return { codigo: "MENU" };
  }

  if (/^(1|manifiestos|menu manifiestos)$/i.test(t)) {
    return { codigo: "MENU_MANIFIESTOS" };
  }

  if (/^(2|jobs|menu jobs)$/i.test(t)) {
    return { codigo: "MENU_JOBS" };
  }

  if (/^(3|buscar empresa)$/i.test(t)) {
    return { codigo: "BUSCAR_EMPRESA_AYUDA" };
  }

  if (/^(4|simel start|ejecutar batch)$/i.test(t)) {
    return { codigo: "SIMEL_START" };
  }

  if (/^(5|mi perfil|perfil|mis permisos)$/i.test(t)) {
    return { codigo: "MI_PERFIL" };
  }

  if (/^(simel estado|job estado|estado job)$/i.test(t)) {
    return { codigo: "SIMEL_ESTADO" };
  }

  if (/^(simel errores|job errores|errores job)$/i.test(t)) {
    return { codigo: "SIMEL_ERRORES" };
  }

  if (/^(simel detalle|job detalle)$/i.test(t)) {
    return { codigo: "SIMEL_DETALLE" };
  }

  const detalleMatch = t.match(/^simel detalle\s+(JOB-[A-Za-z0-9-]+)$/i);
  if (detalleMatch) {
    return { codigo: "SIMEL_DETALLE", jobId: detalleMatch[1] };
  }

  if (/^(manifiestos pendientes|pendientes|pendientes aprobar)$/i.test(t)) {
    return { codigo: "MANIFIESTOS_PENDIENTES" };
  }

  const buscarEmpresaMatch = t.match(/^(buscar empresa|empresa)\s+(.+)$/i);
  if (buscarEmpresaMatch) {
    return {
      codigo: "BUSCAR_EMPRESA",
      termino: buscarEmpresaMatch[2].trim()
    };
  }

  // === MEJORA 1: NUEVOS COMANDOS ===

  const aprobarMatch = t.match(/^(aprobar empresa|aprobar)\s+(.+)$/i);
  if (aprobarMatch) {
    return { codigo: "SOLICITAR_APROBACION", termino: aprobarMatch[2].trim() };
  }

  const confirmarMatch = t.match(/^confirmar\s+([A-Z0-9]{6})$/i);
  if (confirmarMatch) {
    return { codigo: "CONFIRMAR_APROBACION", token: confirmarMatch[1].toUpperCase() };
  }

  const historialMatch = t.match(/^(historial|historial empresa)\s+(.+)$/i);
  if (historialMatch) {
    return { codigo: "HISTORIAL_EMPRESA", termino: historialMatch[2].trim() };
  }

  if (/^reintentar errores$/i.test(t)) {
    return { codigo: "REINTENTAR_ERRORES" };
  }

  const estadoEmpresaMatch = t.match(/^(estado empresa|empresa estado)\s+(.+)$/i);
  if (estadoEmpresaMatch) {
    return { codigo: "ESTADO_EMPRESA", termino: estadoEmpresaMatch[2].trim() };
  }

  const consultarMatch = t.match(/^consultar\s+(.+)$/i);
  if (consultarMatch) {
    return { codigo: "CONSULTAR_EMPRESA", termino: consultarMatch[1].trim() };
  }

  return { codigo: "DESCONOCIDO" };
}

async function construirMenu(contacto) {
  const configBotNombre = await obtenerConfigWhatsApp("BOT_NOMBRE");
  const configBienvenida = await obtenerConfigWhatsApp("MENU_BIENVENIDA");

  const botNombre = configBotNombre?.valorTexto || "HySA Bot";
  const bienvenida =
    configBienvenida?.valorTexto ||
    `Hola, soy ${botNombre}. Elegi una opcion o escribi un comando.`;

  const lineas = [
    "1. *Ver y aprobar manifiestos* -> _manifiestos_",
    "2. *Ver estado del sistema* -> _jobs_",
    "3. *Consultar una empresa* -> _empresa NOMBRE_"
  ];

  if (contacto?.puedeEjecutarBatch) {
    lineas.push("4. *Ejecutar batch* -> _simel start_");
  }

  lineas.push("5. *Mi perfil* -> _mi perfil_");

  return (
    `${bienvenida}\n\n` +
    `*Menu principal*\n` +
    `${lineas.join("\n")}\n\n` +
    `_Tip: si queres aprobar una empresa, entra en "Manifiestos"._`
  );
}

function construirSubmenuManifiestos() {
  return (
    "*Submenu Manifiestos*\n\n" +
    "1. Ver empresas con pendientes -> manifiestos pendientes\n" +
    "2. Buscar una empresa -> empresa NOMBRE\n" +
    "3. Aprobar una empresa -> aprobar empresa NOMBRE\n" +
    "4. Consultar si una empresa tiene pendientes -> empresa NOMBRE\n\n" +
    "Escribi menu para volver al menu principal."
  );
}

function construirSubmenuJobs(contacto) {
  const lineas = [
    "*Submenu Jobs*\n",
    "1. Estado del ultimo job -> simel estado",
    "2. Errores del ultimo job -> simel errores",
    "3. Detalle de un job -> simel detalle JOB-XXXXXXXX"
  ];

  if (contacto?.puedeEjecutarBatch) {
    lineas.push("4. Ejecutar batch -> simel start");
  }

  lineas.push("\nEscribi menu para volver al menu principal.");
  return lineas.join("\n");
}

function construirAyudaAprobarEmpresa() {
  return (
    "?? *Aprobar manifiestos por empresa*\n\n" +
    "Escribi el nombre (o parte del nombre) de la empresa que queres aprobar.\n\n" +
    "Ejemplos:\n" +
    "� united\n" +
    "� ypf\n" +
    "� petrolfe\n\n" +
    "Escribi *menu* para cancelar."
  );
}

function construirAyudaConsultarEmpresa() {
  return (
    "?? *Consultar empresa*\n\n" +
    "Escribi el nombre de la empresa para ver si tiene manifiestos pendientes.\n\n" +
    "Ejemplos:\n" +
    "� united\n" +
    "� ypf\n" +
    "� petrolfe\n\n" +
    "Escribi *menu* para cancelar."
  );
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

  console.log("[WhatsApp] Status env�o:", response.status);
  console.log("[WhatsApp] Respuesta Graph:", JSON.stringify(data));

  if (!response.ok) {
    throw new Error(
      `WhatsApp API error: ${response.status} - ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function subirMediaWhatsApp({ filePath, mimeType = "image/png" }) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID");
  }

  const version = process.env.WHATSAPP_API_VERSION || "v22.0";
  const url = `https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`;
  const form = new FormData();
  const fileBuffer = fs.readFileSync(filePath);

  form.append("messaging_product", "whatsapp");
  form.append(
    "file",
    new Blob([fileBuffer], { type: mimeType }),
    path.basename(filePath)
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
    },
    body: form
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`WhatsApp media upload error: ${response.status} - ${JSON.stringify(data)}`);
  }

  return data.id;
}

async function enviarWhatsAppDocumento({ to, filePath, caption = "", filename = "captura.png" }) {
  const mediaId = await subirMediaWhatsApp({ filePath, mimeType: "image/png" });
  const version = process.env.WHATSAPP_API_VERSION || "v22.0";
  const url = `https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "document",
    document: {
      id: mediaId,
      caption,
      filename
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`WhatsApp document send error: ${response.status} - ${JSON.stringify(data)}`);
  }

  return data;
}

async function enviarCapturasOperacionWhatsApp({ to, resultado, accion, idOperacion }) {
  const paths = [
    resultado?.screenshotAntes
      ? {
          filePath: resultado.screenshotAntes,
          caption: `Captura previa a ${accion.toLowerCase()} el manifiesto ${idOperacion}`,
          filename: `previo_${accion.toLowerCase()}_${idOperacion}.png`
        }
      : null,
    !resultado?.ok && resultado?.screenshotError
      ? {
          filePath: resultado.screenshotError,
          caption: `Captura de error al ${accion.toLowerCase()} el manifiesto ${idOperacion}`,
          filename: `error_${accion.toLowerCase()}_${idOperacion}.png`
        }
      : null
  ].filter(Boolean);

  for (const item of paths) {
    try {
      await enviarWhatsAppDocumento({
        to,
        filePath: item.filePath,
        caption: item.caption,
        filename: item.filename
      });
    } catch (error) {
      console.error("[WhatsApp] Error enviando captura:", error.message);
    } finally {
      limpiarArchivoTemporal(item.filePath);
    }
  }
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
      mensaje:
        "No hay empresas pendientes para procesar.\n\nPara ejecutar un batch desde WhatsApp, marc� 'Ejecutar batch' = true en uno o m�s registros de Usuarios_SIMEL."
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
  res.send("SIMEL bot funcionando en Railway ?? - WhatsApp + men� + start + pendientes");
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
        error:
          "Faltan credenciales. Envi� ?user=...&pass=... o configur� SIMEL_USER y SIMEL_PASS."
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
        error: "Token inv�lido"
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
    error: "Verificaci�n inv�lida"
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

    // === MEJORA 3: RATE LIMITING ===
    if (!verificarRateLimit(from)) {
      console.log("[WhatsApp] Rate limit excedido para:", from);
      return res.status(200).json({ ok: true });
    }

    if (messageId && mensajesProcesados.has(messageId)) {
      console.log("[WhatsApp] Mensaje duplicado ignorado:", messageId);
      return res.status(200).json({ ok: true });
    }

    if (messageId) {
      mensajesProcesados.add(messageId);
      limpiarMensajesProcesados();
    }

    const sesionActiva = await obtenerSesionWhatsApp(from);

    console.log("[WhatsApp] Mensaje recibido");
    console.log("From:", from);
    console.log("Type:", type);
    console.log("Text:", text);
    console.log("[WhatsApp] Sesion activa:", sesionActiva ? {
      estadoSesion: sesionActiva.estadoSesion,
      empresaEnContexto: sesionActiva.empresaEnContexto || "",
      ultimoComando: sesionActiva.ultimoComando || ""
    } : null);

    let comando = detectarComando(text);

    if (sesionActiva && sesionActiva.estadoSesion === "Esperando empresa") {
      if (/^(menu|ayuda|hola|opciones|0)$/i.test(text.trim())) {
        await cerrarSesionWhatsApp(from);
        comando = { codigo: "MENU" };
      } else if (/^\d+$/.test(text.trim())) {
        const dataSesion = parsearJSONSeguro(sesionActiva.observaciones, { candidatos: [] });
        const candidatos = Array.isArray(dataSesion?.candidatos) ? dataSesion.candidatos : [];
        const indice = Number(text.trim()) - 1;

        if (candidatos[indice]) {
          comando = {
            codigo: "SELECCION_EMPRESA",
            empresa: candidatos[indice]
          };
        } else {
          comando = {
            codigo: "SELECCION_EMPRESA_INVALIDA",
            candidatos
          };
        }
      } else {
        comando = {
          codigo: "BUSCAR_EMPRESA",
          termino: text.trim()
        };
      }
    }

    if (sesionActiva && sesionActiva.estadoSesion === "Menu manifiestos") {
      if (/^(menu|ayuda|hola|opciones|0)$/i.test(text.trim())) {
        await cerrarSesionWhatsApp(from);
        comando = { codigo: "MENU" };
      } else if (/^1$/.test(text.trim())) {
        comando = { codigo: "MANIFIESTOS_PENDIENTES" };
      } else if (/^2$/.test(text.trim())) {
        comando = { codigo: "BUSCAR_EMPRESA_AYUDA" };
      } else if (/^3$/.test(text.trim())) {
        comando = { codigo: "APROBAR_EMPRESA_AYUDA" };
      } else if (/^4$/.test(text.trim())) {
        comando = { codigo: "CONSULTAR_EMPRESA_AYUDA" };
      }
    }

    if (sesionActiva && sesionActiva.estadoSesion === "Esperando empresa aprobacion") {
      if (/^(menu|ayuda|hola|opciones|0)$/i.test(text.trim())) {
        await cerrarSesionWhatsApp(from);
        comando = { codigo: "MENU" };
      } else {
        comando = { codigo: "SOLICITAR_APROBACION", termino: text.trim() };
      }
    }

    if (sesionActiva && sesionActiva.estadoSesion === "Empresa en contexto") {
      if (/^(menu|ayuda|hola|opciones|0)$/i.test(text.trim())) {
        await cerrarSesionWhatsApp(from);
        comando = { codigo: "MENU" };
      } else if (/^(aprobar|aceptar)$/i.test(text.trim())) {
        comando = { codigo: "SOLICITAR_APROBACION", termino: sesionActiva.empresaEnContexto || "" };
      } else if (/^(consultar|ver|revisar)$/i.test(text.trim())) {
        comando = { codigo: "CONSULTAR_EMPRESA", termino: sesionActiva.empresaEnContexto || "" };
      }
    }

    if (sesionActiva && sesionActiva.estadoSesion === "Aprobacion interactiva") {
      if (/^(menu|ayuda|hola|opciones|0)$/i.test(text.trim())) {
        await cerrarSesionWhatsApp(from);
        comando = { codigo: "MENU" };
      } else {
        comando = { codigo: "APROBACION_INTERACTIVA", texto: text.trim() };
      }
    }

    const dataSesionActiva = parsearJSONSeguro(sesionActiva?.observaciones, {});
    const tieneItemsAprobacion = Array.isArray(dataSesionActiva?.items) && dataSesionActiva.items.length > 0;

    if (
      sesionActiva &&
      sesionActiva.empresaEnContexto &&
      tieneItemsAprobacion &&
      /^(1|2|3|4|5|6|aceptar|aprobar|rechazar|cancelar|lista|ver todos|siguiente|aceptar todos|aprobar todos|confirmar aceptar todos|confirmar aprobar todos|confirmar rechazar|confirmar rechazar definitivo|volver|atras)$/i.test(text.trim())
    ) {
      comando = { codigo: "APROBACION_INTERACTIVA", texto: text.trim() };
    }

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
      comandoDetectado: ["BUSCAR_EMPRESA", "BUSCAR_EMPRESA_AYUDA", "SELECCION_EMPRESA", "SELECCION_EMPRESA_INVALIDA"].includes(comando.codigo)
        ? "DESCONOCIDO"
        : comando.codigo,
      estadoEjecucion: "OK"
    });

    if (!contacto || !contacto.activo) {
      const respuesta = "Tu n�mero no est� autorizado para usar este bot.";
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

    let respuesta = "Comando no reconocido.\n\nEscrib� MENU para ver las opciones.";
    let jobRelacionado = null;

    if (comando.codigo === "MENU") {
      await cerrarSesionWhatsApp(from);

      if (!contacto.puedeVerMenu) {
        respuesta = "No ten�s permiso para ver el men�.";
      } else {
        respuesta = await construirMenu(contacto);
      }
    }

    if (comando.codigo === "MENU_MANIFIESTOS") {
      if (!contacto.puedeVerManifiestosPendientes) {
        respuesta = "No tenes permiso para ver manifiestos pendientes.";
      } else {
        await guardarSesionWhatsApp({
          telefono: from,
          contactoAutorizadoRecordId: contacto.airtableRecordId,
          ultimoMensaje: text,
          ultimoComando: "MENU_MANIFIESTOS",
          estadoSesion: "Menu manifiestos",
          empresaEnContexto: "",
          observaciones: JSON.stringify({})
        });
        respuesta = construirSubmenuManifiestos();
      }
    }

    if (comando.codigo === "MENU_JOBS") {
      if (!contacto.puedeConsultarEstado && !contacto.puedeConsultarErrores && !contacto.puedeVerDetalleJob) {
        respuesta = "No tenes permisos para ver el submenu de jobs.";
      } else {
        respuesta = construirSubmenuJobs(contacto);
      }
    }

    if (comando.codigo === "SIMEL_ESTADO") {
      if (!contacto.puedeConsultarEstado) {
        respuesta = "No ten�s permiso para consultar el estado.";
      } else {
        const job = await obtenerUltimoJobSimel();

        if (!job) {
          respuesta = "No hay jobs registrados.";
        } else {
          jobRelacionado = job;
          respuesta =
            `�ltimo job: ${job.jobId}\n` +
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
        respuesta = "No ten�s permiso para consultar errores.";
      } else {
        const job = await obtenerUltimoJobSimel();

        if (!job) {
          respuesta = "No hay jobs registrados.";
        } else {
          jobRelacionado = job;
          const items = await obtenerDetallesJobSimel(job.jobId);
          const errores = items.filter((x) => x.estado === "ERROR");

          if (!errores.length) {
            respuesta = `El �ltimo job (${job.jobId}) no tiene errores.`;
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
        respuesta = "No ten�s permiso para ver detalle de jobs.";
      } else if (!comando.jobId) {
        respuesta = "Para ver el detalle, escrib�:\n\nsimel detalle JOB-XXXXXXXXXXXX";
      } else {
        const job = await obtenerJobPorTexto(comando.jobId);

        if (!job) {
          respuesta = `No encontr� el job ${comando.jobId}.`;
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
        respuesta = "No ten�s permiso para ejecutar batch.";
      } else {
        const resultadoStart = await crearJobDesdeBackend("WhatsApp");

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
        respuesta = "No ten�s permiso para ver manifiestos pendientes.";
      } else {
        const pendientes = await listarManifiestosPendientesActivos({ limit: 10 });

        if (!pendientes.length) {
          respuesta = "No hay manifiestos pendientes de aprobaci�n.";
        } else {
          const lineas = pendientes.map((p, i) => {
            const empresa = p.empresa || "Empresa sin nombre";
            const cantidad = p.cantidadPendientes || 0;
            return `${i + 1}. ${empresa} (${cantidad})`;
          });

          respuesta =
            `Empresas con manifiestos pendientes:\n\n` +
            lineas.join("\n") +
            "\n\nPara aprobar una empresa: aprobar empresa NOMBRE";
        }
      }
    }

    if (comando.codigo === "BUSCAR_EMPRESA_AYUDA") {
      if (!contacto.puedeVerManifiestosPendientes) {
        respuesta = "No tenes permiso para consultar empresas.";
      } else {
        await guardarSesionWhatsApp({
          telefono: from,
          contactoAutorizadoRecordId: contacto.airtableRecordId,
          ultimoMensaje: text,
          ultimoComando: "BUSCAR_EMPRESA_AYUDA",
          estadoSesion: "Esperando empresa",
          empresaEnContexto: "",
          observaciones: JSON.stringify({ candidatos: [] })
        });

        respuesta = construirAyudaConsultarEmpresa();
      }
    }

    if (comando.codigo === "APROBAR_EMPRESA_AYUDA") {
      await guardarSesionWhatsApp({
        telefono: from,
        contactoAutorizadoRecordId: contacto.airtableRecordId,
        ultimoMensaje: text,
        ultimoComando: "APROBAR_EMPRESA_AYUDA",
        estadoSesion: "Esperando empresa aprobacion",
        empresaEnContexto: "",
        observaciones: JSON.stringify({})
      });

      respuesta = construirAyudaAprobarEmpresa();
    }

    if (comando.codigo === "CONSULTAR_EMPRESA_AYUDA") {
      if (!contacto.puedeVerManifiestosPendientes) {
        respuesta = "No tenes permiso para consultar empresas.";
      } else {
        await guardarSesionWhatsApp({
          telefono: from,
          contactoAutorizadoRecordId: contacto.airtableRecordId,
          ultimoMensaje: text,
          ultimoComando: "CONSULTAR_EMPRESA_AYUDA",
          estadoSesion: "Esperando empresa",
          empresaEnContexto: "",
          observaciones: JSON.stringify({ candidatos: [] })
        });

        respuesta = construirAyudaConsultarEmpresa();
      }
    }

    if (comando.codigo === "BUSCAR_EMPRESA") {
      if (!contacto.puedeVerManifiestosPendientes) {
        respuesta = "No tenes permiso para consultar empresas.";
      } else {
        const termino = (comando.termino || "").trim();

        if (!termino || termino.toUpperCase() === "NOMBRE") {
          await guardarSesionWhatsApp({
            telefono: from,
            contactoAutorizadoRecordId: contacto.airtableRecordId,
            ultimoMensaje: text,
            ultimoComando: "BUSCAR_EMPRESA",
            estadoSesion: "Esperando empresa",
            empresaEnContexto: "",
            observaciones: JSON.stringify({ candidatos: [] })
          });

          respuesta =
            "?? *B�squeda de empresa*\n\n" +
            "Escrib� el nombre de la empresa que quer�s buscar.\n\n" +
            "Ejemplos:\n" +
            "� petrolfe\n" +
            "� roal\n" +
            "� ypf";
        } else {
          const empresas = await listarEmpresasSimel({ soloActivas: true });
          const coincidencias = buscarEmpresasInteligente(empresas, termino);

          if (!coincidencias.length) {
            // Mantener sesi�n activa para que pueda seguir buscando
            await guardarSesionWhatsApp({
              telefono: from,
              contactoAutorizadoRecordId: contacto.airtableRecordId,
              ultimoMensaje: text,
              ultimoComando: "BUSCAR_EMPRESA",
              estadoSesion: "Esperando empresa",
              empresaEnContexto: "",
              observaciones: JSON.stringify({ candidatos: [], ultimaBusqueda: termino })
            });

            respuesta =
              `? No encontr� empresas parecidas a "${termino}".\n\n` +
              "Prob� con otro nombre o una parte del nombre.\n" +
              "Escrib� *menu* para salir.";

          } else if (coincidencias[0].score === 100 || (coincidencias.length === 1 && coincidencias[0].score >= 84)) {
            // Coincidencia muy fuerte o �nica ? responder directo
            await guardarSesionWhatsApp({
              telefono: from,
              contactoAutorizadoRecordId: contacto.airtableRecordId,
              ultimoMensaje: text,
              ultimoComando: "BUSCAR_EMPRESA",
              estadoSesion: "Empresa en contexto",
              empresaEnContexto: coincidencias[0].empresa,
              observaciones: JSON.stringify({ empresa: coincidencias[0].empresa })
            });
            respuesta = await construirRespuestaPendientesEmpresa(coincidencias[0].empresa);
            respuesta += `\n\nTambien podes responder solo: aprobar`;

          } else {
            const candidatos = coincidencias.map((x) => x.empresa);

            await guardarSesionWhatsApp({
              telefono: from,
              contactoAutorizadoRecordId: contacto.airtableRecordId,
              ultimoMensaje: text,
              ultimoComando: "BUSCAR_EMPRESA",
              estadoSesion: "Esperando empresa",
              empresaEnContexto: "",
              observaciones: JSON.stringify({ termino, candidatos })
            });

            respuesta =
              `?? Encontr� ${candidatos.length} empresa(s) parecida(s) a "${termino}":\n\n` +
              candidatos.map((empresa, i) => `${i + 1}. ${empresa}`).join("\n") +
              "\n\n?? Respond� con el *n�mero* de la empresa.\n" +
              "O escrib� otro nombre para buscar de nuevo.\n" +
              "Escrib� *menu* para salir.";
          }
        }
      }
    }

    if (comando.codigo === "SELECCION_EMPRESA_INVALIDA") {
      if (!comando.candidatos?.length) {
        respuesta =
          "No encontr� una b�squeda activa.\n\n" +
          "Escrib� el nombre de la empresa o:\n" +
          "buscar empresa NOMBRE";
      } else {
        respuesta =
          "?? N�mero inv�lido. Las opciones son:\n\n" +
          comando.candidatos.map((empresa, i) => `${i + 1}. ${empresa}`).join("\n") +
          "\n\nRespond� con un n�mero de la lista.\n" +
          "O escrib� otro nombre para buscar de nuevo.";
      }
    }

    if (comando.codigo === "SELECCION_EMPRESA") {
      await guardarSesionWhatsApp({
        telefono: from,
        contactoAutorizadoRecordId: contacto.airtableRecordId,
        ultimoMensaje: text,
        ultimoComando: "SELECCION_EMPRESA",
        estadoSesion: "Empresa en contexto",
        empresaEnContexto: comando.empresa,
        observaciones: JSON.stringify({ empresa: comando.empresa })
      });
      respuesta = await construirRespuestaPendientesEmpresa(comando.empresa);
      respuesta += `\n\nTambien podes responder solo: aprobar`;
    }

    if (comando.codigo === "APROBACION_INTERACTIVA") {
      const dataSesion = parsearJSONSeguro(sesionActiva?.observaciones, {});
      const empresa = dataSesion?.empresa || sesionActiva?.empresaEnContexto || "";
      let items = Array.isArray(dataSesion?.items) ? dataSesion.items : [];
      let indiceActual = Number(dataSesion?.indiceActual || 0);
      let pendienteRechazo = dataSesion?.pendienteRechazo || null;
      let pasoRechazo = Number(dataSesion?.pasoRechazo || 0);
      let confirmarAceptarTodos = !!dataSesion?.confirmarAceptarTodos;
      const textoSesion = (comando.texto || "").trim();
      let textoNorm = normalizarTextoPlano(textoSesion);
      const opcionNumero = /^\d+$/.test(textoNorm) ? Number(textoNorm) : null;

      if (confirmarAceptarTodos && opcionNumero === 1) {
        textoNorm = "confirmar aceptar todos";
      } else if (confirmarAceptarTodos && opcionNumero === 2) {
        textoNorm = "volver";
      } else if (pasoRechazo === 1 && opcionNumero === 1) {
        textoNorm = "confirmar rechazar";
      } else if (pasoRechazo === 1 && opcionNumero === 2) {
        textoNorm = "volver";
      } else if (pasoRechazo === 2 && opcionNumero === 1) {
        textoNorm = "confirmar rechazar definitivo";
      } else if (pasoRechazo === 2 && opcionNumero === 2) {
        textoNorm = "volver";
      } else if (opcionNumero === 1) {
        textoNorm = "aceptar";
      } else if (opcionNumero === 2) {
        textoNorm = "rechazar";
      } else if (opcionNumero === 3) {
        textoNorm = "cancelar";
      } else if (opcionNumero === 4) {
        textoNorm = "aceptar todos";
      } else if (opcionNumero === 5) {
        textoNorm = "lista";
      } else if (opcionNumero === 6) {
        textoNorm = "siguiente";
      }

      if (!empresa) {
        await cerrarSesionWhatsApp(from);
        respuesta = "La sesion de aprobacion vencio. Escribi: aprobar empresa NOMBRE";
      } else if (textoNorm === "cancelar") {
        await cerrarSesionWhatsApp(from);
        respuesta = "Operacion cancelada. Volves al menu principal.";
      } else {
        const cred = await obtenerUsuarioSimelPorEmpresa(empresa);

        if (!cred?.usuario || !cred?.password) {
          await cerrarSesionWhatsApp(from);
          respuesta = `No encontre credenciales activas para ${empresa}.`;
        } else {
          const aceptarTodosConfirmado = textoNorm === "confirmar aceptar todos" || textoNorm === "confirmar aprobar todos";
          const volver = textoNorm === "volver" || textoNorm === "atras";
          const aceptarTodos = textoNorm === "aceptar todos" || textoNorm === "aprobar todos";
          const lista = textoNorm === "lista" || textoNorm === "ver todos";
          const siguiente = textoNorm === "siguiente";
          const aceptarMatch = textoNorm.match(/^(aceptar|aprobar)(?:\s+(.+))?$/i);
          const rechazarMatch = textoNorm.match(/^rechazar(?:\s+(.+))?$/i);

          if (!items.length) {
            const recarga = await listarPendientesSimel(cred.usuario, cred.password, { maxItems: 20 });
            if (!recarga.ok) {
              console.error("[WhatsApp] Error consultando pendientes en SIMEL:", recarga.error || "sin detalle");
              await cerrarSesionWhatsApp(from);
              respuesta = resumirErrorPendientesSimel(recarga.error);
            } else {
              items = recarga.items;
            }
          }

          if (!respuesta && !items.length) {
            await cerrarSesionWhatsApp(from);
            respuesta = `? ${empresa} no tiene manifiestos pendientes.`;
          }

          if (!respuesta && lista) {
            respuesta =
              `*Pendientes de ${empresa}*\n\n` +
              construirListadoRevision(items) +
              "\n\nOpciones: 1 Aceptar actual, 2 Rechazar actual, 3 Cancelar, 4 Aceptar todos, 5 Ver lista, 6 Siguiente";

            await guardarSesionWhatsApp({
              telefono: from,
              contactoAutorizadoRecordId: contacto.airtableRecordId,
              ultimoMensaje: text,
              ultimoComando: "APROBACION_INTERACTIVA",
              estadoSesion: "Aprobacion interactiva",
              empresaEnContexto: empresa,
              observaciones: JSON.stringify({
                empresa,
                items,
                indiceActual,
                pendienteRechazo,
                pasoRechazo,
                confirmarAceptarTodos
              }),
              ttlSegundos: 120
            });
          }

          if (!respuesta && siguiente) {
            indiceActual = (indiceActual + 1) % items.length;
            const actual = items[indiceActual];
            respuesta = construirDetalleRevision(actual, indiceActual, items.length);

            await guardarSesionWhatsApp({
              telefono: from,
              contactoAutorizadoRecordId: contacto.airtableRecordId,
              ultimoMensaje: text,
              ultimoComando: "APROBACION_INTERACTIVA",
              estadoSesion: "Aprobacion interactiva",
              empresaEnContexto: empresa,
              observaciones: JSON.stringify({
                empresa,
                items,
                indiceActual,
                pendienteRechazo: null,
                pasoRechazo: 0,
                confirmarAceptarTodos: false
              }),
              ttlSegundos: 120
            });
          }

          if (!respuesta && aceptarTodos) {
            confirmarAceptarTodos = true;
            respuesta =
              `Vas a aprobar *${items.length}* manifiesto(s) de ${empresa}.\n` +
              `Opciones:\n` +
              `1. Confirmar aprobar todos\n` +
              `2. Volver al manifiesto actual\n` +
              `3. Cancelar operacion`;

            await guardarSesionWhatsApp({
              telefono: from,
              contactoAutorizadoRecordId: contacto.airtableRecordId,
              ultimoMensaje: text,
              ultimoComando: "APROBACION_INTERACTIVA",
              estadoSesion: "Aprobacion interactiva",
              empresaEnContexto: empresa,
              observaciones: JSON.stringify({
                empresa,
                items,
                indiceActual,
                pendienteRechazo: null,
                pasoRechazo: 0,
                confirmarAceptarTodos
              }),
              ttlSegundos: 120
            });
          }

          if (!respuesta && aceptarTodosConfirmado) {
            if (!confirmarAceptarTodos) {
              respuesta = "Primero responde: *aceptar todos*";
            } else {
              let okCount = 0;
              let errCount = 0;

              for (const m of items) {
                const r = await operarManifiestoSimel(cred.usuario, cred.password, {
                  idOperacion: m.idOperacion,
                  accion: "ACEPTAR"
                });
                await enviarCapturasOperacionWhatsApp({
                  to: process.env.WHATSAPP_TEST_TO || from,
                  resultado: r,
                  accion: "ACEPTAR",
                  idOperacion: m.idOperacion
                });
                if (r.ok) okCount++;
                else errCount++;
              }

              const recarga = await listarPendientesSimel(cred.usuario, cred.password, { maxItems: 20 });
              const restantes = recarga.ok ? recarga.items : [];

              if (!restantes.length) {
                await cerrarSesionWhatsApp(from);
                respuesta =
                  `? Aprobacion masiva finalizada.\n` +
                  `Aprobados: ${okCount}\nErrores: ${errCount}\n` +
                  `No quedan pendientes en ${empresa}.`;
              } else {
                indiceActual = 0;
                await guardarSesionWhatsApp({
                  telefono: from,
                  contactoAutorizadoRecordId: contacto.airtableRecordId,
                  ultimoMensaje: text,
                  ultimoComando: "APROBACION_INTERACTIVA",
                  estadoSesion: "Aprobacion interactiva",
                  empresaEnContexto: empresa,
                  observaciones: JSON.stringify({
                    empresa,
                    items: restantes,
                    indiceActual,
                    pendienteRechazo: null,
                    pasoRechazo: 0,
                    confirmarAceptarTodos: false
                  }),
                  ttlSegundos: 120
                });

                respuesta =
                  `Aprobados: ${okCount}. Errores: ${errCount}. Restan ${restantes.length}.\n\n` +
                  construirDetalleRevision(restantes[indiceActual], indiceActual, restantes.length);
              }
            }
          }

          if (!respuesta && aceptarMatch) {
            const target = (aceptarMatch[2] || "").trim();
            const idx = buscarIndiceManifiesto(items, target, indiceActual);

            if (idx < 0 || !items[idx]) {
              respuesta = "No encontre ese manifiesto. Usa lista para ver opciones.";
            } else {
              const objetivo = items[idx];
              console.log("[WhatsApp] Aprobacion interactiva: aceptar", { empresa, idOperacion: objetivo.idOperacion, indiceActual: idx, totalItems: items.length });
              const r = await operarManifiestoSimel(cred.usuario, cred.password, {
                idOperacion: objetivo.idOperacion,
                accion: "ACEPTAR"
              });

              await enviarCapturasOperacionWhatsApp({
                to: process.env.WHATSAPP_TEST_TO || from,
                resultado: r,
                accion: "ACEPTAR",
                idOperacion: objetivo.idOperacion
              });

              console.log("[WhatsApp] Resultado aprobar", { idOperacion: objetivo.idOperacion, ok: r.ok, confirmadoUI: r.confirmadoUI || false, error: r.error || "" });

              if (!r.ok) {
                respuesta = `No pude aprobar ${objetivo.idOperacion}: ${r.error || "sin detalle"}`;
              } else {
                const recarga = await listarPendientesSimel(cred.usuario, cred.password, { maxItems: 20 });
                const restantes = recarga.ok ? recarga.items : [];

                if (!restantes.length) {
                  await cerrarSesionWhatsApp(from);
                  respuesta = `? Manifiesto ${objetivo.idOperacion} aprobado. No quedan pendientes en ${empresa}.`;
                } else {
                  const nextIndex = Math.min(idx, restantes.length - 1);
                  await guardarSesionWhatsApp({
                    telefono: from,
                    contactoAutorizadoRecordId: contacto.airtableRecordId,
                    ultimoMensaje: text,
                    ultimoComando: "APROBACION_INTERACTIVA",
                    estadoSesion: "Aprobacion interactiva",
                    empresaEnContexto: empresa,
                    observaciones: JSON.stringify({
                      empresa,
                      items: restantes,
                      indiceActual: nextIndex,
                      pendienteRechazo: null,
                      pasoRechazo: 0,
                      confirmarAceptarTodos: false
                    }),
                    ttlSegundos: 120
                  });

                  respuesta =
                    `? Manifiesto ${objetivo.idOperacion} aprobado.\n\n` +
                    construirDetalleRevision(restantes[nextIndex], nextIndex, restantes.length);
                }
              }
            }
          }

          if (!respuesta && rechazarMatch) {
            const target = (rechazarMatch[1] || "").trim();
            const idx = buscarIndiceManifiesto(items, target, indiceActual);

            if (idx < 0 || !items[idx]) {
              respuesta = "No encontre ese manifiesto. Usa lista para ver opciones.";
            } else {
              const objetivo = items[idx];
              pendienteRechazo = objetivo.idOperacion;
              pasoRechazo = 1;

              await guardarSesionWhatsApp({
                telefono: from,
                contactoAutorizadoRecordId: contacto.airtableRecordId,
                ultimoMensaje: text,
                ultimoComando: "APROBACION_INTERACTIVA",
                estadoSesion: "Aprobacion interactiva",
                empresaEnContexto: empresa,
                observaciones: JSON.stringify({
                  empresa,
                  items,
                  indiceActual: idx,
                  pendienteRechazo,
                  pasoRechazo,
                  confirmarAceptarTodos: false
                }),
                ttlSegundos: 120
              });

              respuesta =
                `Vas a rechazar ${objetivo.idOperacion}.\n` +
                `Opciones:\n` +
                `1. Confirmar rechazo\n` +
                `2. Volver`;
            }
          }

          if (!respuesta && textoNorm === "confirmar rechazar") {
            if (!pendienteRechazo || pasoRechazo !== 1) {
              respuesta = "Primero escribe: rechazar sobre un manifiesto.";
            } else {
              pasoRechazo = 2;
              await guardarSesionWhatsApp({
                telefono: from,
                contactoAutorizadoRecordId: contacto.airtableRecordId,
                ultimoMensaje: text,
                ultimoComando: "APROBACION_INTERACTIVA",
                estadoSesion: "Aprobacion interactiva",
                empresaEnContexto: empresa,
                observaciones: JSON.stringify({
                  empresa,
                  items,
                  indiceActual,
                  pendienteRechazo,
                  pasoRechazo,
                  confirmarAceptarTodos: false
                }),
                ttlSegundos: 120
              });

              respuesta = `Confirmacion 2/2 para ${pendienteRechazo}.\nOpciones:\n1. Confirmar rechazo definitivo\n2. Volver`;
            }
          }

          if (!respuesta && volver) {
            pendienteRechazo = null;
            pasoRechazo = 0;
            confirmarAceptarTodos = false;
            const actual = items[indiceActual] || items[0];
            const indice = items[indiceActual] ? indiceActual : 0;

            await guardarSesionWhatsApp({
              telefono: from,
              contactoAutorizadoRecordId: contacto.airtableRecordId,
              ultimoMensaje: text,
              ultimoComando: "APROBACION_INTERACTIVA",
              estadoSesion: "Aprobacion interactiva",
              empresaEnContexto: empresa,
              observaciones: JSON.stringify({
                empresa,
                items,
                indiceActual: indice,
                pendienteRechazo: null,
                pasoRechazo: 0,
                confirmarAceptarTodos: false
              }),
              ttlSegundos: 120
            });

            respuesta = construirDetalleRevision(actual, indice, items.length);
          }

          if (!respuesta && textoNorm === "confirmar rechazar definitivo") {
            if (!pendienteRechazo || pasoRechazo !== 2) {
              respuesta = "No hay un rechazo pendiente para confirmar.";
            } else {
              const rechazoId = pendienteRechazo;
              const r = await operarManifiestoSimel(cred.usuario, cred.password, {
                idOperacion: rechazoId,
                accion: "RECHAZAR"
              });

              await enviarCapturasOperacionWhatsApp({
                to: process.env.WHATSAPP_TEST_TO || from,
                resultado: r,
                accion: "RECHAZAR",
                idOperacion: rechazoId
              });

              if (!r.ok) {
                respuesta = `No pude rechazar ${rechazoId}: ${r.error || "sin detalle"}`;
              } else {
                const recarga = await listarPendientesSimel(cred.usuario, cred.password, { maxItems: 20 });
                const restantes = recarga.ok ? recarga.items : [];

                if (!restantes.length) {
                  await cerrarSesionWhatsApp(from);
                  respuesta = `? Manifiesto ${rechazoId} rechazado. No quedan pendientes en ${empresa}.`;
                } else {
                  const nextIndex = Math.min(indiceActual, restantes.length - 1);
                  await guardarSesionWhatsApp({
                    telefono: from,
                    contactoAutorizadoRecordId: contacto.airtableRecordId,
                    ultimoMensaje: text,
                    ultimoComando: "APROBACION_INTERACTIVA",
                    estadoSesion: "Aprobacion interactiva",
                    empresaEnContexto: empresa,
                    observaciones: JSON.stringify({
                      empresa,
                      items: restantes,
                      indiceActual: nextIndex,
                      pendienteRechazo: null,
                      pasoRechazo: 0,
                      confirmarAceptarTodos: false
                    }),
                    ttlSegundos: 120
                  });

                  respuesta =
                    `? Manifiesto ${rechazoId} rechazado.\n\n` +
                    construirDetalleRevision(restantes[nextIndex], nextIndex, restantes.length);
                }
              }
            }
          }

          if (!respuesta) {
            const actual = items[indiceActual] || items[0];
            const indice = items[indiceActual] ? indiceActual : 0;

            await guardarSesionWhatsApp({
              telefono: from,
              contactoAutorizadoRecordId: contacto.airtableRecordId,
              ultimoMensaje: text,
              ultimoComando: "APROBACION_INTERACTIVA",
              estadoSesion: "Aprobacion interactiva",
              empresaEnContexto: empresa,
              observaciones: JSON.stringify({
                empresa,
                items,
                indiceActual: indice,
                pendienteRechazo: null,
                pasoRechazo: 0,
                confirmarAceptarTodos: false
              }),
              ttlSegundos: 120
            });

            respuesta =
              "Comando no valido para esta etapa.\n\n" +
              construirDetalleRevision(actual, indice, items.length);
          }
        }
      }
    }

    if (comando.codigo === "SOLICITAR_APROBACION") {
      const termino = (comando.termino || "").trim();
      const empresas = await listarEmpresasSimel({ soloActivas: true });
      const coincidencias = buscarEmpresasInteligente(empresas, termino);

      if (!coincidencias.length) {
        respuesta = `No encontre la empresa "${termino}".`;
      } else if (coincidencias[0].score !== 100 && !(coincidencias.length === 1 && coincidencias[0].score >= 92)) {
        const candidatos = coincidencias.map((x) => x.empresa);
        respuesta =
          `Encontre ${candidatos.length} empresa(s) parecida(s):\n\n` +
          candidatos.map((empresa, i) => `${i + 1}. ${empresa}`).join("\n") +
          "\n\nEscribi: aprobar empresa NOMBRE EXACTO";
      } else {
        const empresa = coincidencias[0].empresa;
        const cred = await obtenerUsuarioSimelPorEmpresa(empresa);

        if (!cred?.usuario || !cred?.password) {
          respuesta = `No encontre credenciales activas para ${empresa}.`;
        } else {
          const pendientes = await listarPendientesSimel(cred.usuario, cred.password, { maxItems: 20 });

          if (!pendientes.ok) {
            console.error("[WhatsApp] Error consultando pendientes en SIMEL:", pendientes.error || "sin detalle");
            respuesta = resumirErrorPendientesSimel(pendientes.error);
          } else if (!pendientes.items.length) {
            respuesta = `? ${empresa} no tiene manifiestos pendientes de aprobacion.`;
          } else {
            const indiceActual = 0;
            await guardarSesionWhatsApp({
              telefono: from,
              contactoAutorizadoRecordId: contacto.airtableRecordId,
              ultimoMensaje: text,
              ultimoComando: "SOLICITAR_APROBACION",
              estadoSesion: "Aprobacion interactiva",
              empresaEnContexto: empresa,
              observaciones: JSON.stringify({
                empresa,
                items: pendientes.items,
                indiceActual,
                pendienteRechazo: null,
                pasoRechazo: 0,
                confirmarAceptarTodos: false
              }),
              ttlSegundos: 120
            });

            respuesta =
              `*Pendientes de ${empresa}* (${pendientes.items.length})\n\n` +
              construirDetalleRevision(pendientes.items[indiceActual], indiceActual, pendientes.items.length);
          }
        }
      }
    }

    // === MEJORA 1: NUEVOS COMANDOS ===

    if (false && comando.codigo === "SOLICITAR_APROBACION") {
      if (!contacto.puedeSolicitarAprobacion) {
        respuesta = "No ten�s permiso para solicitar aprobaciones.";
      } else {
        const termino = (comando.termino || "").trim();
        const empresas = await listarEmpresasSimel({ soloActivas: true });
        const coincidencias = buscarEmpresasInteligente(empresas, termino);

        if (!coincidencias.length) {
          respuesta = `? No encontr� la empresa "${termino}". Verific� el nombre o escrib�:\nbuscar empresa NOMBRE`;
        } else if (coincidencias[0].score !== 100 && !(coincidencias.length === 1 && coincidencias[0].score >= 92)) {
          // M�ltiples opciones
          const candidatos = coincidencias.map((x) => x.empresa);

          respuesta =
            `Encontr� ${candidatos.length} empresa(s) parecida(s):\n\n` +
            candidatos.map((empresa, i) => `${i + 1}. ${empresa}`).join("\n") +
            "\n\nPara aprobar manifiestos de una empresa, escrib�:\n" +
            "aprobar empresa NOMBRE EXACTO";
        } else {
          // Una sola opci�n o coincidencia perfecta
          const empresa = coincidencias[0].empresa;
          const pendientes = await listarPendientesPorEmpresa(empresa);

          if (!pendientes.length) {
            respuesta = `? ${empresa} no tiene manifiestos pendientes de aprobaci�n.`;
          } else {
            const cantidad = pendientes.reduce(
              (acc, item) => acc + Number(item.cantidadPendientes || 0),
              0
            );
            const token = generarTokenAprobacion();

            await crearAprobacionSimel({
              empresaNombre: empresa,
              pendienteRecordId: pendientes[0]?.airtableRecordId || "",
              solicitanteRecordId: contacto.airtableRecordId,
              solicitanteTelefono: from,
              solicitanteNombre: contacto.nombre,
              cantidadPendientes: cantidad,
              token
            });

            await guardarSesionWhatsApp({
              telefono: from,
              contactoAutorizadoRecordId: contacto.airtableRecordId,
              ultimoMensaje: text,
              ultimoComando: "SOLICITAR_APROBACION",
              estadoSesion: "Esperando confirmaci�n aprobaci�n",
              empresaEnContexto: empresa,
              observaciones: JSON.stringify({ token, empresa, cantidad })
            });

            respuesta =
              `?? *Solicitud de aprobaci�n*\n\n` +
              `Empresa: ${empresa}\n` +
              `Manifiestos a aprobar: ${cantidad}\n\n` +
              `C�digo de confirmaci�n:\n` +
              `*${token}*\n\n` +
              `Escrib�:\n` +
              `confirmar ${token}\n\n` +
              `para confirmar. Esta acci�n no se puede deshacer.`;
          }
        }
      }
    }

    if (false && comando.codigo === "CONFIRMAR_APROBACION") {
      if (!contacto.puedeConfirmarAprobacion) {
        respuesta = "No ten�s permiso para confirmar aprobaciones.";
      } else {
        const aprobacion = await buscarAprobacionPorToken(comando.token);

        if (!aprobacion) {
          respuesta = `? El c�digo ${comando.token} no es v�lido o ya fue usado.`;
        } else {
          await actualizarEstadoAprobacion(aprobacion.airtableRecordId, {
            estado: "Confirmada",
            fechaEjecucion: new Date().toISOString()
          });

          await cerrarSesionWhatsApp(from);

          respuesta =
            `? *Aprobaci�n confirmada*\n\n` +
            `Empresa: ${aprobacion.empresa}\n` +
            `Manifiestos: ${aprobacion.cantidadAprobar}\n\n` +
            `La aprobaci�n qued� registrada.\n` +
            `ID: ${aprobacion.airtableRecordId}`;
        }
      }
    }

    if (comando.codigo === "MI_PERFIL") {
      const permisos = [
        { nombre: "Ver men�", valor: !!contacto.puedeVerMenu },
        { nombre: "Consultar estado", valor: !!contacto.puedeConsultarEstado },
        { nombre: "Consultar errores", valor: !!contacto.puedeConsultarErrores },
        { nombre: "Ver detalle job", valor: !!contacto.puedeVerDetalleJob },
        { nombre: "Ejecutar batch", valor: !!contacto.puedeEjecutarBatch },
        { nombre: "Ver manifiestos pendientes", valor: !!contacto.puedeVerManifiestosPendientes },
        { nombre: "Solicitar aprobaci�n", valor: !!contacto.puedeSolicitarAprobacion },
        { nombre: "Confirmar aprobaci�n", valor: !!contacto.puedeConfirmarAprobacion },
        { nombre: "Aprobar manifiestos", valor: !!contacto.puedeAprobarManifiestos }
      ];

      const listaPermisos = permisos
        .map((p) => `${p.valor ? "?" : "?"} ${p.nombre}`)
        .join("\n");

      respuesta =
        `?? *Tu perfil*\n\n` +
        `Nombre: ${contacto.nombre}\n` +
        `Rol: ${contacto.rol}\n\n` +
        `*Permisos:*\n` +
        `${listaPermisos}`;
    }

    if (comando.codigo === "REINTENTAR_ERRORES") {
      if (!contacto.puedeEjecutarBatch) {
        respuesta = "No ten�s permiso para ejecutar batch.";
      } else {
        const job = await obtenerUltimoJobSimel();

        if (!job) {
          respuesta = "No hay jobs registrados.";
        } else {
          const items = await obtenerDetallesJobSimel(job.jobId);
          const errores = items.filter((x) => x.estado === "ERROR");

          if (!errores.length) {
            respuesta = "? El �ltimo job no tiene errores para reintentar.";
          } else {
            // Extraer recordIds v�lidos
            const recordIds = errores
              .map((e) => e.recordIdUsuario)
              .filter((id) => id && id.length > 0);

            if (recordIds.length > 0) {
              await marcarEmpresasParaReintentar(recordIds);
            }

            const resultadoStart = await crearJobDesdeBackend("Reintento WhatsApp");

            respuesta =
              `?? *Reintento iniciado*\n\n` +
              `${errores.length} empresa(s) con error marcadas para reprocesar.\n` +
              `Job ID: ${resultadoStart.jobId}`;
          }
        }
      }
    }

    if (comando.codigo === "ESTADO_EMPRESA") {
      if (contacto.rol !== "Admin") {
        respuesta = "Esta opci�n est� disponible solo para administradores.";
      } else {
        const termino = (comando.termino || "").trim();
        const empresas = await listarEmpresasSimel({ soloActivas: true });
        const coincidencias = buscarEmpresasInteligente(empresas, termino);

        if (!coincidencias.length) {
          respuesta = `? No encontr� la empresa "${termino}".`;
        } else if (coincidencias[0].score !== 100 && !(coincidencias.length === 1 && coincidencias[0].score >= 92)) {
          // M�ltiples opciones
          const candidatos = coincidencias.map((x) => x.empresa);

          respuesta =
            `Encontr� ${candidatos.length} empresa(s) parecida(s):\n\n` +
            candidatos.map((empresa, i) => `${i + 1}. ${empresa}`).join("\n") +
            "\n\nEscrib� el nombre exacto para ver el estado.";
        } else {
          // Una sola opci�n
          const empresa = coincidencias[0].empresa;
          const datos = await obtenerDatosEmpresaSimel(empresa);

          if (!datos) {
            respuesta = `? No encontr� datos para ${empresa}.`;
          } else {
            const activa = datos.activo ? "?" : "?";

            respuesta =
              `?? *${datos.empresa}*\n\n` +
              `Activa: ${activa}\n` +
              `�ltimo check: ${datos.ultimoCheck || "Sin datos"}\n` +
              `�ltimo estado: ${datos.ultimoEstado || "Sin datos"}\n` +
              `Filas pendientes: ${datos.cantidadFilasPendientes}\n\n` +
              `Detalle: ${datos.ultimoDetalle || "Sin detalle"}`;
          }
        }
      }
    }

    if (comando.codigo === "HISTORIAL_EMPRESA") {
      if (contacto.rol !== "Admin") {
        respuesta = "Esta opci�n est� disponible solo para administradores.";
      } else {
        const termino = (comando.termino || "").trim();
        const empresas = await listarEmpresasSimel({ soloActivas: true });
        const coincidencias = buscarEmpresasInteligente(empresas, termino);

        if (!coincidencias.length) {
          respuesta = `? No encontr� la empresa "${termino}".`;
        } else if (coincidencias[0].score !== 100 && !(coincidencias.length === 1 && coincidencias[0].score >= 92)) {
          // M�ltiples opciones
          const candidatos = coincidencias.map((x) => x.empresa);

          respuesta =
            `Encontr� ${candidatos.length} empresa(s) parecida(s):\n\n` +
            candidatos.map((empresa, i) => `${i + 1}. ${empresa}`).join("\n") +
            "\n\nEscrib� el nombre exacto para ver el historial.";
        } else {
          // Una sola opci�n
          const empresa = coincidencias[0].empresa;
          const historial = await obtenerHistorialAprobacionesEmpresa(empresa);

          if (!historial.length) {
            respuesta = `?? No hay aprobaciones registradas para ${empresa}.`;
          } else {
            const lineas = historial.map((h, i) => {
              const fecha = h.fechaSolicitud ? h.fechaSolicitud.split("T")[0] : "N/A";
              const ejecucion = h.fechaEjecucion ? h.fechaEjecucion.split("T")[0] : "Pendiente";
              return `${i + 1}. ${fecha} - ${h.estado} - ${h.cantidadAprobar} aprobada(s) por ${h.solicitanteNombre} (Ejecuci�n: ${ejecucion})`;
            });

            respuesta =
              `?? *Historial ${empresa}*\n\n` +
              lineas.join("\n") +
              `\n\nTotal: ${historial.length} aprobaci�n(es)`;
          }
        }
      }
    }

    if (comando.codigo === "CONSULTAR_EMPRESA") {
      if (contacto.rol !== "Admin") {
        respuesta = "Esta opci�n est� disponible solo para administradores.";
      } else {
        const termino = (comando.termino || "").trim();
        const empresas = await listarEmpresasSimel({ soloActivas: true });
        const coincidencias = buscarEmpresasInteligente(empresas, termino);

        if (!coincidencias.length) {
          respuesta = `? No encontr� la empresa "${termino}".`;
        } else if (coincidencias[0].score !== 100 && !(coincidencias.length === 1 && coincidencias[0].score >= 92)) {
          // M�ltiples opciones
          const candidatos = coincidencias.map((x) => x.empresa);

          respuesta =
            `Encontr� ${candidatos.length} empresa(s) parecida(s):\n\n` +
            candidatos.map((empresa, i) => `${i + 1}. ${empresa}`).join("\n") +
            "\n\nS� m�s espec�fico para consultar SIMEL.";
        } else {
          // Una sola opci�n - CONSULTAR SIMEL
          const empresa = coincidencias[0].empresa;
          const usuarioData = await obtenerUsuarioSimelPorEmpresa(empresa);

          if (!usuarioData) {
            respuesta = `? No encontr� credenciales para ${empresa} en Usuarios_SIMEL.`;
          } else {
            // Enviar mensaje de "consultando..." primero
            const mensajeConsultando = `?? Consultando SIMEL para ${empresa}... Esto puede tardar unos segundos.`;
            const destinoWhatsapp = process.env.WHATSAPP_TEST_TO || from;

            try {
              await enviarWhatsAppTexto({
                to: destinoWhatsapp,
                body: mensajeConsultando
              });
            } catch (sendError) {
              console.error("[WhatsApp] Error enviando mensaje de consultando:", sendError.message);
            }

            // Ejecutar checkSimel
            const resultado = await checkSimel(usuarioData.usuario, usuarioData.password);

            // Actualizar datos en Usuarios_SIMEL
            await actualizarResultadoSimel({
              ...resultado,
              recordId: usuarioData.recordId
            });

            // Construir respuesta final
            if (resultado.estado === "CON_MANIFIESTO") {
              respuesta =
                `?? *${empresa}*\n\n` +
                `Tiene manifiestos pendientes.\n` +
                `Filas detectadas: ${resultado.filas}\n\n` +
                `�ltimo check: ${new Date().toISOString().slice(0, 10)}\n\n` +
                `Para revisar/aprobar ahora:\n` +
                `aprobar empresa ${empresa}`;
            } else if (resultado.estado === "SIN_MANIFIESTO") {
              respuesta =
                `? *${empresa}*\n\n` +
                `Sin manifiestos pendientes.\n\n` +
                `�ltimo check: ${new Date().toISOString().slice(0, 10)}`;
            } else {
              respuesta =
                `? *${empresa}*\n\n` +
                `Error al consultar SIMEL.\n\n` +
                `Detalle: ${resultado.detalle}`;
            }
          }
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






