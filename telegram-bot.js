require("./env-loader");

const {
  buscarAutorizadoTelegram,
  actualizarUltimaInteraccionWhatsApp,
  crearLogTelegram,
  listarEmpresasSimel,
  obtenerDatosEmpresaSimel
} = require("./supabase-store");
const {
  buscarEmpresasInteligente,
  detectarComando
} = require("./whatsapp-menu");

function getTelegramApiUrl(method) {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!token) {
    throw new Error("Falta TELEGRAM_BOT_TOKEN");
  }
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function sendTelegramText(chatId, text) {
  const response = await fetch(getTelegramApiUrl("sendMessage"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: text || "Sin respuesta"
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(`Telegram sendMessage error: ${response.status} - ${JSON.stringify(data)}`);
  }

  return data;
}

function sanitizeOutgoingText(text = "") {
  return String(text || "")
    .replace(/\*/g, "")
    .replace(/_/g, "")
    .replace(/`/g, "")
    .replace(/â€¢/g, "-")
    .replace(/ðŸ/g, "");
}

function normalizeTelegramText(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const simpleSlash = raw.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i);
  if (!simpleSlash) return raw;

  const command = simpleSlash[1].toLowerCase();
  const arg = (simpleSlash[2] || "").trim();

  if (command === "start" || command === "menu" || command === "help") return "menu";
  if (command === "perfil") return "mi perfil";
  if (command === "manifiestos" || command === "pendientes") return "manifiestos pendientes";
  if (command === "empresa" && arg) return `empresa ${arg}`;
  if (command === "consultar" && arg) return `consultar ${arg}`;
  if (command === "aprobar" && arg) return `aprobar empresa ${arg}`;

  return raw;
}

async function buildTelegramResponse({ contacto, comando, text }) {
  if (comando.codigo === "MENU") {
    const lineas = [
      "Menu principal",
      "",
      "1. Ver empresas con pendientes -> /pendientes",
      "2. Consultar una empresa -> /empresa NOMBRE",
      "3. Mi perfil -> /perfil"
    ];

    if (contacto?.puedeEjecutarBatch) {
      lineas.push("4. Ejecutar batch -> simel start");
    }

    return lineas.join("\n");
  }

  if (comando.codigo === "MENU_MANIFIESTOS") {
    return (
      "Submenu Manifiestos\n\n" +
      "1. Ver empresas con pendientes -> /pendientes\n" +
      "2. Consultar una empresa -> /empresa NOMBRE\n" +
      "3. Aprobar una empresa -> aprobar empresa NOMBRE"
    );
  }

  if (comando.codigo === "BUSCAR_EMPRESA_AYUDA") {
    return "Escribe /empresa NOMBRE para consultar una empresa.";
  }

  if (comando.codigo === "MANIFIESTOS_PENDIENTES") {
    if (!contacto.puedeVerManifiestosPendientes) {
      return "No tienes permiso para ver manifiestos pendientes.";
    }

    const empresas = await listarEmpresasSimel({ soloActivas: true });
    const resumen = [];

    for (const empresa of empresas) {
      const datos = await obtenerDatosEmpresaSimel(empresa);
      const total = Number(datos?.cantidadFilasPendientes || 0);
      if (total > 0) {
        resumen.push(`${empresa}: ${total}`);
      }
    }

    if (!resumen.length) {
      return "No hay empresas con manifiestos pendientes.";
    }

    return `Empresas con pendientes:\n\n${resumen.join("\n")}`;
  }

  if (comando.codigo === "BUSCAR_EMPRESA" || comando.codigo === "CONSULTAR_EMPRESA") {
    const termino = (comando.termino || "").trim();
    if (!termino) {
      return "Escribe /empresa NOMBRE para consultar una empresa.";
    }

    const empresas = await listarEmpresasSimel({ soloActivas: true });
    const coincidencias = buscarEmpresasInteligente(empresas, termino);

    if (!coincidencias.length) {
      return `No encontré la empresa "${termino}".`;
    }

    if (coincidencias[0].score !== 100 && !(coincidencias.length === 1 && coincidencias[0].score >= 92)) {
      return (
        `Encontré ${coincidencias.length} empresa(s) parecida(s):\n\n` +
        coincidencias.map((item, idx) => `${idx + 1}. ${item.empresa}`).join("\n") +
        `\n\nEscribe: /empresa NOMBRE_EXACTO`
      );
    }

    const empresa = coincidencias[0].empresa;
    const datos = await obtenerDatosEmpresaSimel(empresa);
    const total = Number(datos?.cantidadFilasPendientes || 0);

    if (!total) {
      return `${empresa}\n\nNo tiene manifiestos pendientes de aprobación.`;
    }

    return (
      `${empresa}\n\n` +
      `Tiene manifiestos pendientes.\n` +
      `Total: ${total}\n\n` +
      `Ultimo check: ${datos?.ultimoCheck || "Sin datos"}\n` +
      `Ultimo estado: ${datos?.ultimoEstado || "Sin datos"}\n` +
      `Detalle: ${datos?.ultimoDetalle || "Sin detalle"}`
    );
  }

  if (comando.codigo === "MI_PERFIL") {
    return (
      `Tu perfil\n\n` +
      `Nombre: ${contacto.nombre}\n` +
      `Rol: ${contacto.rol}\n\n` +
      `Permisos:\n` +
      `Menu: ${contacto.puedeVerMenu ? "si" : "no"}\n` +
      `Consultar empresas: ${contacto.puedeVerManifiestosPendientes ? "si" : "no"}\n` +
      `Aprobar manifiestos: ${contacto.puedeAprobarManifiestos ? "si" : "no"}`
    );
  }

  return (
    `Comando no reconocido.\n\n` +
    `Prueba con:\n` +
    `/menu\n` +
    `/pendientes\n` +
    `/empresa COLON\n` +
    `/perfil`
  );
}

async function handleTelegramWebhook(req, res) {
  try {
    const configuredSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
    const incomingSecret = req.headers["x-telegram-bot-api-secret-token"] || "";

    if (configuredSecret && incomingSecret !== configuredSecret) {
      return res.status(401).json({ ok: false, error: "Telegram secret inválido" });
    }

    const update = req.body || {};
    const message = update.message || update.edited_message;
    if (!message) {
      return res.status(200).json({ ok: true });
    }

    const chatId = String(message.chat?.id || "");
    const messageId = String(message.message_id || "");
    const fromName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ").trim();
    const incomingText = normalizeTelegramText(message.text || "");
    const payloadCrudo = JSON.stringify(update);

    if (!chatId) {
      return res.status(200).json({ ok: true });
    }

    if (/^\/?(id|whoami)$/i.test((message.text || "").trim())) {
      await sendTelegramText(chatId, `Tu telegram_chat_id es: ${chatId}`);
      return res.status(200).json({ ok: true });
    }

    const contacto = await buscarAutorizadoTelegram(chatId);

    await crearLogTelegram({
      telegramChatId: chatId,
      autorizado: !!(contacto && contacto.activo),
      contactoAutorizadoRecordId: contacto?.airtableRecordId || null,
      nombreRemitente: fromName,
      tipoEvento: "Mensaje entrante",
      messageId,
      payloadCrudoEntrada: payloadCrudo,
      textoRecibido: incomingText,
      comandoDetectado: "TELEGRAM_IN",
      estadoEjecucion: "OK"
    });

    if (!contacto || !contacto.activo) {
      const respuesta = `Tu usuario no está autorizado para usar este bot.\n\nTu telegram_chat_id es: ${chatId}`;
      await sendTelegramText(chatId, respuesta);
      return res.status(200).json({ ok: true });
    }

    const comando = detectarComando(incomingText || "menu");
    await actualizarUltimaInteraccionWhatsApp(contacto.airtableRecordId, comando.codigo);

    const respuesta = sanitizeOutgoingText(
      await buildTelegramResponse({
        contacto,
        comando,
        text: incomingText
      })
    );

    await sendTelegramText(chatId, respuesta);

    await crearLogTelegram({
      telegramChatId: chatId,
      autorizado: true,
      contactoAutorizadoRecordId: contacto.airtableRecordId,
      nombreRemitente: contacto.nombre || fromName,
      tipoEvento: "Mensaje saliente",
      messageId,
      textoRecibido: incomingText,
      comandoDetectado: comando.codigo,
      respuestaEnviada: respuesta,
      estadoEjecucion: "OK"
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[Telegram] Error en webhook:", error.message);
    return res.status(200).json({ ok: true });
  }
}

module.exports = {
  handleTelegramWebhook,
  sendTelegramText
};
