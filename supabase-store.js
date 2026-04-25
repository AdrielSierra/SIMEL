const { decryptText, encryptText } = require("./crypto-utils");
const { isSupabaseEnabled, supabaseRequest } = require("./supabase");
const crypto = require("crypto");

function normalizarTelefono(valor = "") {
  return String(valor).replace(/\D/g, "");
}

function normalizarTexto(valor = "") {
  return String(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function buildSessionPayload(row) {
  if (!row) return null;
  if (row.estado_sesion === "Cerrada") return null;
  if (row.expira_at && new Date(row.expira_at) < new Date()) return null;

  return {
    airtableRecordId: row.id,
    telefono: row.telefono || "",
    ultimoMensaje: row.ultimo_mensaje || "",
    ultimoComando: row.ultimo_comando || "",
    estadoSesion: row.estado_sesion || "",
    jobIdEnContexto: row.job_id_en_contexto || "",
    empresaEnContexto: row.empresa_nombre || "",
    observaciones: JSON.stringify(row.datos_json || {})
  };
}

async function maybeSingle(path, query) {
  const rows = await supabaseRequest(path, { query });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function obtenerEmpresaPorNombre(nombreEmpresa) {
  return maybeSingle("/rest/v1/empresas", {
    select: "*",
    nombre: `eq.${nombreEmpresa}`,
    limit: "1"
  });
}

async function obtenerCredencialActivaPorEmpresaId(empresaId) {
  if (!empresaId) return null;

  return maybeSingle("/rest/v1/credenciales_simel", {
    select: "*",
    empresa_id: `eq.${empresaId}`,
    activo: "eq.true",
    limit: "1"
  });
}

async function obtenerUsuarioSimelPorEmpresa(nombreEmpresa) {
  const empresa = await obtenerEmpresaPorNombre(nombreEmpresa);
  if (!empresa || !empresa.activa) return null;

  const credencial = await obtenerCredencialActivaPorEmpresaId(empresa.id);
  if (!credencial) return null;

  return {
    recordId: credencial.id,
    empresa: empresa.nombre || "",
    usuario: credencial.usuario_simel || "",
    password: decryptText(credencial.password_cifrada || ""),
    activo: !!credencial.activo
  };
}

async function listarEmpresasSimel({ soloActivas = true } = {}) {
  const rows = await supabaseRequest("/rest/v1/empresas", {
    query: {
      select: "nombre,activa",
      order: "nombre.asc"
    }
  });

  return rows
    .filter((row) => (soloActivas ? row.activa : true))
    .map((row) => row.nombre)
    .filter(Boolean);
}

async function listarUsuariosSimelActivos() {
  const rows = await supabaseRequest("/rest/v1/credenciales_simel", {
    query: {
      select: "id,usuario_simel,password_cifrada,activo,empresa:empresa_id(id,nombre,activa)",
      activo: "eq.true",
      order: "updated_at.desc"
    }
  });

  return (rows || [])
    .filter((row) => row?.empresa?.activa)
    .map((row) => ({
      recordId: row.id,
      empresa: row.empresa?.nombre || "",
      usuario: row.usuario_simel || "",
      password: decryptText(row.password_cifrada || ""),
      activo: !!row.activo
    }))
    .filter((row) => row.empresa && row.usuario && row.password);
}

async function buscarAutorizadoWhatsApp(telefono) {
  const telefonoNormalizado = normalizarTelefono(telefono);
  const rows = await supabaseRequest("/rest/v1/usuarios_chat", {
    query: {
      select: "*",
      or: `(${[
        `telefono.eq.${telefonoNormalizado}`,
        `telefono.eq.${telefono}`
      ].join(",")})`,
      limit: "1"
    }
  });

  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!row) return null;

  return {
    airtableRecordId: row.id,
    telefono: row.telefono || "",
    telefonoNormalizado,
    nombre: row.nombre || "",
    activo: !!row.activo,
    rol: row.rol || "",
    puedeVerMenu: !!row.puede_ver_menu,
    puedeConsultarEstado: !!row.puede_consultar_estado,
    puedeConsultarErrores: !!row.puede_consultar_errores,
    puedeVerDetalleJob: !!row.puede_ver_detalle_job,
    puedeEjecutarBatch: !!row.puede_ejecutar_batch,
    puedeVerManifiestosPendientes: !!row.puede_ver_manifiestos_pendientes,
    puedeSolicitarAprobacion: !!row.puede_solicitar_aprobacion,
    puedeConfirmarAprobacion: !!row.puede_confirmar_aprobacion,
    puedeAprobarManifiestos: !!row.puede_aprobar_manifiestos
  };
}

async function buscarAutorizadoTelegram(chatId) {
  const rows = await supabaseRequest("/rest/v1/usuarios_chat", {
    query: {
      select: "*",
      telegram_chat_id: `eq.${chatId}`,
      limit: "1"
    }
  });

  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!row) return null;

  return {
    airtableRecordId: row.id,
    telegramChatId: row.telegram_chat_id || "",
    telefono: row.telefono || "",
    nombre: row.nombre || "",
    activo: !!row.activo,
    rol: row.rol || "",
    puedeVerMenu: !!row.puede_ver_menu,
    puedeConsultarEstado: !!row.puede_consultar_estado,
    puedeConsultarErrores: !!row.puede_consultar_errores,
    puedeVerDetalleJob: !!row.puede_ver_detalle_job,
    puedeEjecutarBatch: !!row.puede_ejecutar_batch,
    puedeVerManifiestosPendientes: !!row.puede_ver_manifiestos_pendientes,
    puedeSolicitarAprobacion: !!row.puede_solicitar_aprobacion,
    puedeConfirmarAprobacion: !!row.puede_confirmar_aprobacion,
    puedeAprobarManifiestos: !!row.puede_aprobar_manifiestos
  };
}

async function actualizarUltimaInteraccionWhatsApp(recordId, ultimoComando = "") {
  if (!recordId) return;

  await supabaseRequest(`/rest/v1/usuarios_chat?id=eq.${recordId}`, {
    method: "PATCH",
    body: {
      ultima_interaccion_at: new Date().toISOString(),
      ultimo_comando: ultimoComando || ""
    }
  });
}

async function crearLogWhatsApp({
  telefonoRemitente = "",
  autorizado = false,
  contactoAutorizadoRecordId = null,
  nombreRemitente = "",
  tipoEvento = "Mensaje entrante",
  messageIdMeta = "",
  payloadCrudoEntrada = "",
  textoRecibido = "",
  comandoDetectado = "DESCONOCIDO",
  respuestaEnviada = "",
  estadoEjecucion = "OK",
  errorTecnico = "",
  statusEnvioMeta = "",
  statusEntregaMeta = ""
} = {}) {
  await supabaseRequest("/rest/v1/logs_bot", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      canal: "WhatsApp",
      telefono_remitente: telefonoRemitente,
      usuario_chat_id: contactoAutorizadoRecordId,
      autorizado,
      nombre_remitente: nombreRemitente,
      tipo_evento: tipoEvento,
      message_id: messageIdMeta,
      comando_detectado: comandoDetectado,
      texto_recibido: textoRecibido,
      respuesta_enviada: respuestaEnviada,
      estado_ejecucion: estadoEjecucion,
      error_tecnico: errorTecnico,
      status_envio_meta: statusEnvioMeta,
      status_entrega_meta: statusEntregaMeta,
      payload_json: payloadCrudoEntrada ? { raw: payloadCrudoEntrada } : {}
    }
  });
}

async function crearLogTelegram({
  telegramChatId = "",
  autorizado = false,
  contactoAutorizadoRecordId = null,
  nombreRemitente = "",
  tipoEvento = "Mensaje entrante",
  messageId = "",
  payloadCrudoEntrada = "",
  textoRecibido = "",
  comandoDetectado = "DESCONOCIDO",
  respuestaEnviada = "",
  estadoEjecucion = "OK",
  errorTecnico = ""
} = {}) {
  await supabaseRequest("/rest/v1/logs_bot", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      canal: "Telegram",
      telefono_remitente: telegramChatId,
      usuario_chat_id: contactoAutorizadoRecordId,
      autorizado,
      nombre_remitente: nombreRemitente,
      tipo_evento: tipoEvento,
      message_id: messageId,
      comando_detectado: comandoDetectado,
      texto_recibido: textoRecibido,
      respuesta_enviada: respuestaEnviada,
      estado_ejecucion: estadoEjecucion,
      error_tecnico: errorTecnico,
      payload_json: payloadCrudoEntrada ? { raw: payloadCrudoEntrada } : {}
    }
  });
}

function hashPayload(payload = "") {
  return crypto.createHash("sha256").update(String(payload || "")).digest("hex");
}

async function registrarMensajeProcesado({ canal, messageId, usuarioOrigen = "", payload = "" }) {
  if (!canal || !messageId) return { procesado: false, duplicado: false };

  try {
    await supabaseRequest("/rest/v1/mensajes_procesados", {
      method: "POST",
      prefer: "return=minimal",
      body: {
        canal,
        message_id: String(messageId),
        usuario_origen: String(usuarioOrigen || ""),
        payload_hash: hashPayload(payload)
      }
    });

    return { procesado: true, duplicado: false };
  } catch (error) {
    if (/duplicate key|23505|409/i.test(error.message)) {
      return { procesado: false, duplicado: true };
    }

    throw error;
  }
}

async function limpiarLocksExpirados() {
  await supabaseRequest(`/rest/v1/locks_operacion?expira_at=lt.${new Date().toISOString()}`, {
    method: "DELETE",
    prefer: "return=minimal"
  });
}

async function adquirirLockOperacion({
  tipoLock,
  clave,
  owner = "",
  ttlSegundos = 30 * 60
}) {
  if (!tipoLock || !clave) {
    throw new Error("Faltan tipoLock o clave para adquirir lock");
  }

  await limpiarLocksExpirados().catch(() => {});

  try {
    const inserted = await supabaseRequest("/rest/v1/locks_operacion", {
      method: "POST",
      prefer: "return=representation",
      body: {
        tipo_lock: tipoLock,
        clave,
        owner,
        expira_at: new Date(Date.now() + Number(ttlSegundos || 0) * 1000).toISOString()
      }
    });

    return { adquirido: true, lock: inserted?.[0] || null };
  } catch (error) {
    if (/duplicate key|23505|409/i.test(error.message)) {
      return { adquirido: false, lock: null };
    }

    throw error;
  }
}

async function liberarLockOperacion({ tipoLock, clave }) {
  if (!tipoLock || !clave) return;

  await supabaseRequest(`/rest/v1/locks_operacion?tipo_lock=eq.${tipoLock}&clave=eq.${clave}`, {
    method: "DELETE",
    prefer: "return=minimal"
  });
}

async function obtenerSesionWhatsApp(telefono) {
  const telefonoNormalizado = normalizarTelefono(telefono);
  const row = await maybeSingle("/rest/v1/sesiones_chat", {
    select: "*,empresa:empresa_id(nombre)",
    canal: "eq.whatsapp",
    telefono: `eq.${telefonoNormalizado}`,
    order: "updated_at.desc",
    limit: "1"
  });

  if (!row) return null;

  const hydrated = {
    ...row,
    empresa_nombre: row.empresa?.nombre || ""
  };

  return buildSessionPayload(hydrated);
}

async function guardarSesionWhatsApp({
  telefono,
  contactoAutorizadoRecordId = null,
  ultimoMensaje = "",
  ultimoComando = "",
  estadoSesion = "Activa",
  jobIdEnContexto = "",
  empresaEnContexto = "",
  observaciones = "",
  ttlSegundos = 15 * 60
}) {
  const telefonoNormalizado = normalizarTelefono(telefono);
  const actual = await maybeSingle("/rest/v1/sesiones_chat", {
    select: "id",
    canal: "eq.whatsapp",
    telefono: `eq.${telefonoNormalizado}`,
    order: "updated_at.desc",
    limit: "1"
  });

  let empresaId = null;
  if (empresaEnContexto) {
    const empresa = await maybeSingle("/rest/v1/empresas", {
      select: "id",
      nombre: `eq.${empresaEnContexto}`,
      limit: "1"
    });
    empresaId = empresa?.id || null;
  }

  const payload = {
    canal: "whatsapp",
    telefono: telefonoNormalizado,
    usuario_chat_id: contactoAutorizadoRecordId,
    estado_sesion: estadoSesion,
    empresa_id: empresaId,
    ultimo_comando: ultimoComando,
    ultimo_mensaje: ultimoMensaje,
    job_id_en_contexto: jobIdEnContexto,
    datos_json:
      typeof observaciones === "string"
        ? (() => {
            try {
              return observaciones ? JSON.parse(observaciones) : {};
            } catch {
              return observaciones ? { nota: observaciones } : {};
            }
          })()
        : observaciones || {},
    expira_at: new Date(Date.now() + Number(ttlSegundos || 0) * 1000).toISOString()
  };

  if (actual?.id) {
    await supabaseRequest(`/rest/v1/sesiones_chat?id=eq.${actual.id}`, {
      method: "PATCH",
      body: payload,
      prefer: "return=minimal"
    });
    return;
  }

  await supabaseRequest("/rest/v1/sesiones_chat", {
    method: "POST",
    body: payload,
    prefer: "return=minimal"
  });
}

async function cerrarSesionWhatsApp(telefono) {
  const telefonoNormalizado = normalizarTelefono(telefono);
  await supabaseRequest(`/rest/v1/sesiones_chat?canal=eq.whatsapp&telefono=eq.${telefonoNormalizado}`, {
    method: "PATCH",
    body: {
      estado_sesion: "Cerrada",
      empresa_id: null,
      job_id_en_contexto: "",
      datos_json: {}
    },
    prefer: "return=minimal"
  });
}

async function obtenerHistorialAprobacionesEmpresa(nombreEmpresa, limit = 5) {
  const rows = await supabaseRequest("/rest/v1/historial_aprobaciones", {
    query: {
      select: "id,estado,cantidad,detalle,created_at,fecha_ejecucion,accion,empresa:empresa_id(nombre),usuario:usuario_chat_id(nombre)",
      order: "created_at.desc",
      limit: String(limit)
    }
  });

  const empresaNormalizada = normalizarTexto(nombreEmpresa);
  return rows
    .filter((row) => normalizarTexto(row.empresa?.nombre || "") === empresaNormalizada)
    .map((row) => ({
      airtableRecordId: row.id,
      empresa: row.empresa?.nombre || "",
      estado: row.estado || "",
      cantidadAprobar: Number(row.cantidad || 0),
      fechaSolicitud: row.created_at || "",
      fechaEjecucion: row.fecha_ejecucion || "",
      solicitanteNombre: row.usuario?.nombre || ""
    }));
}

async function obtenerDatosEmpresaSimel(nombreEmpresa) {
  const empresa = await obtenerEmpresaPorNombre(nombreEmpresa);
  if (!empresa) return null;

  const credencial = await obtenerCredencialActivaPorEmpresaId(empresa.id);
  if (!credencial) {
    return {
      recordId: empresa.id,
      empresa: empresa.nombre || nombreEmpresa,
      activo: !!empresa.activa,
      ultimoCheck: "",
      ultimoEstado: "",
      ultimoDetalle: "",
      cantidadFilasPendientes: 0
    };
  }

  return {
    recordId: empresa.id,
    empresa: empresa.nombre || nombreEmpresa,
    activo: !!empresa.activa,
    ultimoCheck: credencial.ultimo_check_at || "",
    ultimoEstado: credencial.ultimo_estado || "",
    ultimoDetalle: credencial.ultimo_detalle || "",
    cantidadFilasPendientes: Number(credencial.cantidad_filas_pendientes || 0)
  };
}

async function upsertEmpresaConCredencial({
  nombre,
  cuit = "",
  activa = true,
  usuarioSimel,
  passwordPlano,
  credencialActiva = true,
  ultimoCheckAt = null,
  ultimoEstado = "",
  ultimoDetalle = "",
  cantidadFilasPendientes = 0
}) {
  if (!nombre || !usuarioSimel) {
    throw new Error("Faltan nombre o usuarioSimel para guardar credencial SIMEL");
  }

  let empresa = await maybeSingle("/rest/v1/empresas", {
    select: "id",
    nombre: `eq.${nombre}`,
    limit: "1"
  });

  if (!empresa) {
    const created = await supabaseRequest("/rest/v1/empresas", {
      method: "POST",
      prefer: "return=representation",
      body: {
        nombre,
        cuit,
        activa
      }
    });
    empresa = created[0];
  } else {
    await supabaseRequest(`/rest/v1/empresas?id=eq.${empresa.id}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        cuit,
        activa,
        updated_at: new Date().toISOString()
      }
    });
  }

  const existing = await maybeSingle("/rest/v1/credenciales_simel", {
    select: "id",
    empresa_id: `eq.${empresa.id}`,
    limit: "1"
  });

  const credencialPayload = {
    empresa_id: empresa.id,
    usuario_simel: usuarioSimel,
    password_cifrada: encryptText(passwordPlano || ""),
    activo: credencialActiva,
    ultimo_check_at: ultimoCheckAt,
    ultimo_estado: ultimoEstado,
    ultimo_detalle: ultimoDetalle,
    cantidad_filas_pendientes: Number(cantidadFilasPendientes || 0),
    updated_at: new Date().toISOString()
  };

  if (existing?.id) {
    await supabaseRequest(`/rest/v1/credenciales_simel?id=eq.${existing.id}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: credencialPayload
    });
    return { empresaId: empresa.id, credencialId: existing.id };
  }

  const inserted = await supabaseRequest("/rest/v1/credenciales_simel", {
    method: "POST",
    prefer: "return=representation",
    body: credencialPayload
  });

  return { empresaId: empresa.id, credencialId: inserted[0]?.id || "" };
}

module.exports = {
  isSupabaseEnabled,
  obtenerUsuarioSimelPorEmpresa,
  listarEmpresasSimel,
  listarUsuariosSimelActivos,
  buscarAutorizadoWhatsApp,
  buscarAutorizadoTelegram,
  actualizarUltimaInteraccionWhatsApp,
  crearLogWhatsApp,
  crearLogTelegram,
  registrarMensajeProcesado,
  adquirirLockOperacion,
  liberarLockOperacion,
  obtenerSesionWhatsApp,
  guardarSesionWhatsApp,
  cerrarSesionWhatsApp,
  obtenerHistorialAprobacionesEmpresa,
  obtenerDatosEmpresaSimel,
  upsertEmpresaConCredencial
};
