require("./env-loader");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

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

async function postTelegramApi(method, payload) {
  const url = getTelegramApiUrl(method);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(`Telegram ${method} error: ${response.status} - ${JSON.stringify(data)}`);
    }

    return data;
  } catch (fetchError) {
    const { stdout } = await execFileAsync("curl", [
      "-sS",
      "-X",
      "POST",
      url,
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify(payload)
    ]);

    const data = JSON.parse(stdout || "{}");
    if (data.ok === false) {
      throw new Error(`Telegram ${method} error via curl: ${JSON.stringify(data)}`);
    }

    return data;
  }
}

async function sendTelegramText(chatId, text) {
  return postTelegramApi("sendMessage", {
    chat_id: chatId,
    text: text || "Sin respuesta"
  });
}

async function sendTelegramMessage(chatId, text, extra = {}) {
  return postTelegramApi("sendMessage", {
    chat_id: chatId,
    text: text || "Sin respuesta",
    ...extra
  });
}

function sanitizeOutgoingText(text = "") {
  return String(text || "")
    .replace(/\*/g, "")
    .replace(/_/g, "")
    .replace(/`/g, "")
    .replace(/Ã¢â‚¬Â¢/g, "-")
    .replace(/Ã°Å¸/g, "");
}

function normalizeTelegramText(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const normalizedPlain = raw.toLowerCase();

  if (["menu", "inicio", "volver al menu"].includes(normalizedPlain)) {
    return "menu";
  }

  if (["ver pendientes", "empresas con pendientes"].includes(normalizedPlain)) {
    return "manifiestos pendientes";
  }

  if (["consultar empresa", "buscar empresa"].includes(normalizedPlain)) {
    return "buscar empresa";
  }

  if (normalizedPlain === "mi perfil") {
    return "mi perfil";
  }

  if (normalizedPlain === "ejecutar batch") {
    return "simel start";
  }

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

function buildMainKeyboard(contacto) {
  const keyboard = [
    [{ text: "Ver pendientes" }, { text: "Consultar empresa" }],
    [{ text: "Mi perfil" }, { text: "Menu" }]
  ];

  if (contacto?.puedeEjecutarBatch) {
    keyboard.splice(1, 0, [{ text: "Ejecutar batch" }]);
  }

  return {
    keyboard,
    resize_keyboard: true,
    persistent_keyboard: true
  };
}

function buildSuggestionsKeyboard(coincidencias = [], contacto) {
  const rows = coincidencias
    .slice(0, 4)
    .map((item) => [{ text: `/empresa ${item.empresa}` }]);

  rows.push([{ text: "Menu" }]);

  return {
    keyboard: rows.length ? rows : buildMainKeyboard(contacto).keyboard,
    resize_keyboard: true,
    persistent_keyboard: true
  };
}

async function buildTelegramResponse({ contacto, comando }) {
  if (comando.codigo === "MENU") {
    const lineas = [
      "Simelito",
      "",
      "Que quieres hacer?",
      "",
      "1. Ver empresas con pendientes",
      "2. Consultar una empresa",
      "3. Ver tu perfil"
    ];

    if (contacto?.puedeEjecutarBatch) {
      lineas.push("4. Ejecutar batch");
    }

    lineas.push("", "Tambien puedes escribir:", "/pendientes", "/empresa COLON", "/perfil");

    return {
      text: lineas.join("\n"),
      replyMarkup: buildMainKeyboard(contacto)
    };
  }

  if (comando.codigo === "MENU_MANIFIESTOS") {
    return {
      text:
        "Manifiestos\n\n" +
        "1. Ver empresas con pendientes\n" +
        "2. Consultar una empresa\n" +
        "3. Aprobar una empresa\n\n" +
        "Prueba con: /pendientes o /empresa COLON",
      replyMarkup: buildMainKeyboard(contacto)
    };
  }

  if (comando.codigo === "BUSCAR_EMPRESA_AYUDA") {
    return {
      text:
        "Para consultar una empresa, escribe por ejemplo:\n\n" +
        "/empresa COLON\n" +
        "/empresa TERGEN\n\n" +
        "Si quieres, escribe solo una parte del nombre y te sugiero coincidencias.",
      replyMarkup: buildMainKeyboard(contacto)
    };
  }

  if (comando.codigo === "MANIFIESTOS_PENDIENTES") {
    if (!contacto.puedeVerManifiestosPendientes) {
      return {
        text: "No tienes permiso para ver manifiestos pendientes.",
        replyMarkup: buildMainKeyboard(contacto)
      };
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
      return {
        text:
          "No hay empresas con manifiestos pendientes ahora.\n\n" +
          "Puedes consultar una empresa puntual con /empresa NOMBRE.",
        replyMarkup: buildMainKeyboard(contacto)
      };
    }

    return {
      text:
        `Empresas con pendientes (${resumen.length})\n\n${resumen.join("\n")}\n\n` +
        "Para ver una empresa en detalle, escribe /empresa NOMBRE.",
      replyMarkup: buildMainKeyboard(contacto)
    };
  }

  if (comando.codigo === "BUSCAR_EMPRESA" || comando.codigo === "CONSULTAR_EMPRESA") {
    const termino = (comando.termino || "").trim();
    if (!termino) {
      return {
        text: "Escribe /empresa NOMBRE para consultar una empresa.",
        replyMarkup: buildMainKeyboard(contacto)
      };
    }

    const empresas = await listarEmpresasSimel({ soloActivas: true });
    const coincidencias = buscarEmpresasInteligente(empresas, termino);

    if (!coincidencias.length) {
      return {
        text:
          `No encontre la empresa "${termino}".\n\n` +
          "Prueba con una parte del nombre o usa /pendientes para ver empresas activas.",
        replyMarkup: buildMainKeyboard(contacto)
      };
    }

    if (coincidencias[0].score !== 100 && !(coincidencias.length === 1 && coincidencias[0].score >= 92)) {
      return {
        text:
          `Encontre ${coincidencias.length} empresa(s) parecida(s):\n\n` +
          coincidencias.map((item, idx) => `${idx + 1}. ${item.empresa}`).join("\n") +
          "\n\nToca una sugerencia o escribe /empresa NOMBRE_EXACTO.",
        replyMarkup: buildSuggestionsKeyboard(coincidencias, contacto)
      };
    }

    const empresa = coincidencias[0].empresa;
    const datos = await obtenerDatosEmpresaSimel(empresa);
    const total = Number(datos?.cantidadFilasPendientes || 0);

    if (!total) {
      return {
        text:
          `${empresa}\n\n` +
          "Estado: sin manifiestos pendientes de aprobacion.\n\n" +
          `Ultimo check: ${datos?.ultimoCheck || "Sin datos"}\n` +
          `Ultimo estado: ${datos?.ultimoEstado || "Sin datos"}`,
        replyMarkup: buildMainKeyboard(contacto)
      };
    }

    return {
      text:
        `${empresa}\n\n` +
        "Estado: con manifiestos pendientes\n" +
        `Total: ${total}\n\n` +
        `Ultimo check: ${datos?.ultimoCheck || "Sin datos"}\n` +
        `Ultimo estado: ${datos?.ultimoEstado || "Sin datos"}\n` +
        `Detalle: ${datos?.ultimoDetalle || "Sin detalle"}\n\n` +
        `Si quieres aprobarla, escribe: aprobar empresa ${empresa}`,
      replyMarkup: buildMainKeyboard(contacto)
    };
  }

  if (comando.codigo === "MI_PERFIL") {
    return {
      text:
        `Tu perfil\n\n` +
        `Nombre: ${contacto.nombre}\n` +
        `Rol: ${contacto.rol}\n\n` +
        `Permisos:\n` +
        `Menu: ${contacto.puedeVerMenu ? "si" : "no"}\n` +
        `Consultar empresas: ${contacto.puedeVerManifiestosPendientes ? "si" : "no"}\n` +
        `Aprobar manifiestos: ${contacto.puedeAprobarManifiestos ? "si" : "no"}`,
      replyMarkup: buildMainKeyboard(contacto)
    };
  }

  if (comando.codigo === "SIMEL_START") {
    if (!contacto?.puedeEjecutarBatch) {
      return {
        text: "No tienes permiso para ejecutar el batch.",
        replyMarkup: buildMainKeyboard(contacto)
      };
    }

    return {
      text:
        "La ejecucion de batch por Telegram todavia no esta conectada al flujo operativo.\n\n" +
        "El acceso ya figura en tu menu porque eres Admin, pero antes de activarlo quiero dejar listas las validaciones y el monitoreo.",
      replyMarkup: buildMainKeyboard(contacto)
    };
  }

  return {
    text:
      "No entendi ese comando.\n\n" +
      "Prueba con una de estas opciones:\n" +
      "- Ver pendientes\n" +
      "- Consultar empresa\n" +
      "- Mi perfil\n\n" +
      "O escribe: /empresa COLON",
    replyMarkup: buildMainKeyboard(contacto)
  };
}

async function handleTelegramWebhook(req, res) {
  try {
    const configuredSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
    const incomingSecret = req.headers["x-telegram-bot-api-secret-token"] || "";

    if (configuredSecret && incomingSecret !== configuredSecret) {
      return res.status(401).json({ ok: false, error: "Telegram secret invalido" });
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
      await sendTelegramMessage(chatId, `Tu telegram_chat_id es: ${chatId}`, {
        reply_markup: buildMainKeyboard(null)
      });
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
      const respuesta = `Tu usuario no esta autorizado para usar este bot.\n\nTu telegram_chat_id es: ${chatId}`;
      await sendTelegramMessage(chatId, respuesta, {
        reply_markup: {
          keyboard: [[{ text: "/start" }], [{ text: "/id" }]],
          resize_keyboard: true
        }
      });
      return res.status(200).json({ ok: true });
    }

    const comando = detectarComando(incomingText || "menu");
    await actualizarUltimaInteraccionWhatsApp(contacto.airtableRecordId, comando.codigo);

    const respuesta = await buildTelegramResponse({
      contacto,
      comando
    });

    await sendTelegramMessage(chatId, sanitizeOutgoingText(respuesta.text), {
      reply_markup: respuesta.replyMarkup || buildMainKeyboard(contacto)
    });

    await crearLogTelegram({
      telegramChatId: chatId,
      autorizado: true,
      contactoAutorizadoRecordId: contacto.airtableRecordId,
      nombreRemitente: contacto.nombre || fromName,
      tipoEvento: "Mensaje saliente",
      messageId,
      textoRecibido: incomingText,
      comandoDetectado: comando.codigo,
      respuestaEnviada: respuesta.text,
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
