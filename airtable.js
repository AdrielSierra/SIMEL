require("./env-loader");

const Airtable = require("airtable");
const supabaseStore = require("./supabase-store");

let airtableBase = null;

function getBase() {
  if (airtableBase) return airtableBase;

  if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID) {
    throw new Error("Airtable no configurado. Faltan AIRTABLE_TOKEN y/o AIRTABLE_BASE_ID");
  }

  airtableBase = new Airtable({
    apiKey: process.env.AIRTABLE_TOKEN
  }).base(process.env.AIRTABLE_BASE_ID);

  return airtableBase;
}

const TABLAS = {
  usuariosSimel: process.env.AIRTABLE_TABLE_NAME || "Usuarios_SIMEL",
  jobsSimel: process.env.AIRTABLE_JOBS_TABLE || "Jobs_SIMEL",
  jobsSimelDetalle: process.env.AIRTABLE_JOBS_DETAIL_TABLE || "Jobs_SIMEL_Detalle",
  whatsappAutorizados: process.env.AIRTABLE_WHATSAPP_AUTH_TABLE || "WhatsApp_Autorizados",
  whatsappLog: process.env.AIRTABLE_WHATSAPP_LOG_TABLE || "WhatsApp_Log",
  whatsappMenu: process.env.AIRTABLE_WHATSAPP_MENU_TABLE || "WhatsApp_Menu",
  simelPendientes: process.env.AIRTABLE_SIMEL_PENDING_TABLE || "SIMEL_Manifiestos_Pendientes",
  whatsappConfig: process.env.AIRTABLE_WHATSAPP_CONFIG_TABLE || "WhatsApp_Configuracion",
  whatsappSesiones: process.env.AIRTABLE_WHATSAPP_SESSIONS_TABLE || "WhatsApp_Sesiones",
  aprobaciones: process.env.AIRTABLE_SIMEL_APROBACIONES_TABLE || "SIMEL_Aprobaciones"
};

function escaparFormula(valor = "") {
  return String(valor)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

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

function textoDesdeLookup(valor) {
  if (Array.isArray(valor)) return valor.join(", ");
  return valor || "";
}

function limpiarCampos(fields) {
  const limpio = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v === null) continue;
    limpio[k] = v;
  }
  return limpio;
}

function parsearJSONSeguro(valor, fallback = {}) {
  if (!valor) return fallback;
  if (typeof valor === "object") return valor;

  try {
    return JSON.parse(valor);
  } catch {
    return fallback;
  }
}

function serializarObservacionesSesion({ observaciones, workflowEstado, workflowUltimoComando }) {
  const baseObservaciones =
    typeof observaciones === "string"
      ? parsearJSONSeguro(observaciones, observaciones ? { nota: observaciones } : {})
      : parsearJSONSeguro(observaciones, {});

  const payload = {
    ...baseObservaciones,
    workflowEstado: workflowEstado || "",
    workflowUltimoComando: workflowUltimoComando || ""
  };

  return JSON.stringify(payload);
}

function normalizarComandoAirtable(valor = "") {
  const comando = String(valor || "").trim().toUpperCase();

  const comandosPermitidos = new Set([
    "",
    "DESCONOCIDO",
    "MENU",
    "SIMEL_ESTADO",
    "SIMEL_ERRORES",
    "SIMEL_DETALLE",
    "SIMEL_START"
  ]);

  if (comandosPermitidos.has(comando)) {
    return comando;
  }

  if (
    comando === "MANIFIESTOS_PENDIENTES" ||
    comando === "BUSCAR_EMPRESA" ||
    comando === "SOLICITAR_APROBACION" ||
    comando === "CONFIRMAR_APROBACION" ||
    comando === "SELECCION_EMPRESA" ||
    comando === "SELECCION_EMPRESA_INVALIDA" ||
    comando === "BUSCAR_EMPRESA_AYUDA" ||
    comando === "APROBAR_EMPRESA_AYUDA" ||
    comando === "CONSULTAR_EMPRESA_AYUDA" ||
    comando === "CONSULTAR_EMPRESA"
  ) {
    return "DESCONOCIDO";
  }

  if (
    comando === "MENU_MANIFIESTOS" ||
    comando === "MENU_JOBS"
  ) {
    return "MENU";
  }

  return "DESCONOCIDO";
}

function normalizarEstadoSesionAirtable(valor = "") {
  const estado = String(valor || "").trim();

  if (!estado || estado === "Activa" || estado === "Cerrada") {
    return estado || "Activa";
  }

  if (estado === "Esperando empresa" || estado === "Esperando confirmación aprobación") {
    return estado;
  }

  return "Activa";
}

async function obtenerUsuariosSimelActivos({ limit = 5 } = {}) {
  const records = await getBase()(TABLAS.usuariosSimel)
    .select({
      sort: [{ field: "Empresa", direction: "asc" }]
    })
    .all();

  return records
    .map((record) => ({
      recordId: record.id,
      empresa: record.get("Empresa") || "",
      usuario: record.get("Usuario") || "",
      password: record.get("Password") || "",
      activo: !!record.get("Activo"),
      ejecutarBatch: !!record.get("Ejecutar batch")
    }))
    .filter((r) => r.activo && r.ejecutarBatch)
    .slice(0, limit);
}

async function obtenerTodosLosUsuariosSimelPendientes({ soloMarcadosBatch = true } = {}) {
  const records = await getBase()(TABLAS.usuariosSimel)
    .select({
      sort: [{ field: "Empresa", direction: "asc" }]
    })
    .all();

  return records
    .map((record) => ({
      recordId: record.id,
      empresa: record.get("Empresa") || "",
      usuario: record.get("Usuario") || "",
      password: record.get("Password") || "",
      activo: !!record.get("Activo"),
      ejecutarBatch: !!record.get("Ejecutar batch")
    }))
    .filter((r) => {
      if (!r.activo) return false;
      return soloMarcadosBatch ? r.ejecutarBatch : true;
    });
}

async function actualizarResultadoSimel(resultado) {
  if (supabaseStore.isSupabaseEnabled()) {
    return supabaseStore.actualizarResultadoSimel(resultado);
  }

  if (!resultado.recordId) return;

  await getBase()(TABLAS.usuariosSimel).update([
    {
      id: resultado.recordId,
      fields: {
        "Último check": new Date().toISOString().slice(0, 10),
        "Último estado": resultado.estado || "",
        "Último detalle": resultado.detalle || "",
        "Cantidad filas pendientes": Number(resultado.filas || 0),
        "Ejecutar batch": false
      }
    }
  ]);
}

async function crearJobSimel({ totalEmpresas, disparadoPor = "Sistema", detalle = "" }) {
  const jobId = `JOB-${Date.now()}`;

  const created = await getBase()(TABLAS.jobsSimel).create([
    {
      fields: {
        "Job ID": jobId,
        "Estado": "Pendiente",
        "Total empresas": Number(totalEmpresas || 0),
        "Procesadas": 0,
        "Con manifiesto": 0,
        "Sin manifiesto": 0,
        "Con error": 0,
        "Inicio": new Date().toISOString(),
        "Detalle": detalle,
        "Disparado por": disparadoPor
      }
    }
  ]);

  return {
    airtableRecordId: created[0].id,
    jobId
  };
}

async function buscarJobPendiente() {
  const records = await getBase()(TABLAS.jobsSimel)
    .select({
      filterByFormula: `{Estado}="Pendiente"`,
      maxRecords: 1,
      sort: [{ field: "Inicio", direction: "asc" }]
    })
    .all();

  if (!records.length) return null;

  const r = records[0];

  return {
    airtableRecordId: r.id,
    jobId: r.get("Job ID") || "",
    estado: r.get("Estado") || "",
    totalEmpresas: Number(r.get("Total empresas") || 0),
    procesadas: Number(r.get("Procesadas") || 0),
    conManifiesto: Number(r.get("Con manifiesto") || 0),
    sinManifiesto: Number(r.get("Sin manifiesto") || 0),
    conError: Number(r.get("Con error") || 0)
  };
}

async function buscarJobPendienteOEnProceso() {
  const records = await getBase()(TABLAS.jobsSimel)
    .select({
      filterByFormula: `OR({Estado}="Pendiente", {Estado}="En proceso")`,
      maxRecords: 1,
      sort: [{ field: "Inicio", direction: "asc" }]
    })
    .all();

  if (!records.length) return null;

  const r = records[0];

  return {
    airtableRecordId: r.id,
    jobId: r.get("Job ID") || "",
    estado: r.get("Estado") || "",
    totalEmpresas: Number(r.get("Total empresas") || 0),
    procesadas: Number(r.get("Procesadas") || 0),
    conManifiesto: Number(r.get("Con manifiesto") || 0),
    sinManifiesto: Number(r.get("Sin manifiesto") || 0),
    conError: Number(r.get("Con error") || 0)
  };
}

async function actualizarJobSimel(airtableRecordId, fields) {
  await getBase()(TABLAS.jobsSimel).update([
    {
      id: airtableRecordId,
      fields
    }
  ]);
}

async function crearDetalleJobSimel({ jobRecordId, jobIdTexto, resultado }) {
  await getBase()(TABLAS.jobsSimelDetalle).create([
    {
      fields: {
        "Job": [jobRecordId],
        "Empresa": resultado.empresa || "",
        "Usuario": resultado.usuario || "",
        "Estado": resultado.estado || "ERROR",
        "Filas": Number(resultado.filas || 0),
        "Detalle": resultado.detalle || "",
        "Fecha": new Date().toISOString().slice(0, 10),
        "Record ID Usuario SIMEL": resultado.recordId || "",
        "Job ID Texto": jobIdTexto || ""
      }
    }
  ]);
}

async function obtenerJobPorTexto(jobId) {
  const records = await getBase()(TABLAS.jobsSimel)
    .select({
      filterByFormula: `{Job ID}="${escaparFormula(jobId)}"`,
      maxRecords: 1
    })
    .all();

  if (!records.length) return null;

  const r = records[0];

  return {
    airtableRecordId: r.id,
    jobId: r.get("Job ID") || "",
    estado: r.get("Estado") || "",
    totalEmpresas: Number(r.get("Total empresas") || 0),
    procesadas: Number(r.get("Procesadas") || 0),
    conManifiesto: Number(r.get("Con manifiesto") || 0),
    sinManifiesto: Number(r.get("Sin manifiesto") || 0),
    conError: Number(r.get("Con error") || 0),
    inicio: r.get("Inicio") || "",
    fin: r.get("Fin") || "",
    detalle: r.get("Detalle") || "",
    disparadoPor: r.get("Disparado por") || ""
  };
}

async function obtenerDetallesJobSimel(jobId) {
  const records = await getBase()(TABLAS.jobsSimelDetalle)
    .select({
      filterByFormula: `{Job ID Texto}="${escaparFormula(jobId)}"`,
      sort: [{ field: "Empresa", direction: "asc" }]
    })
    .all();

  return records.map((r) => ({
    airtableRecordId: r.id,
    empresa: r.get("Empresa") || "",
    usuario: r.get("Usuario") || "",
    estado: r.get("Estado") || "",
    filas: Number(r.get("Filas") || 0),
    detalle: r.get("Detalle") || "",
    fecha: r.get("Fecha") || "",
    jobIdTexto: r.get("Job ID Texto") || "",
    recordIdUsuario: r.get("Record ID Usuario SIMEL") || ""
  }));
}

async function obtenerUltimoJobSimel() {
  const records = await getBase()(TABLAS.jobsSimel)
    .select({
      sort: [{ field: "Inicio", direction: "desc" }],
      maxRecords: 1
    })
    .all();

  if (!records.length) return null;

  const r = records[0];

  return {
    airtableRecordId: r.id,
    jobId: r.get("Job ID") || "",
    estado: r.get("Estado") || "",
    totalEmpresas: Number(r.get("Total empresas") || 0),
    procesadas: Number(r.get("Procesadas") || 0),
    conManifiesto: Number(r.get("Con manifiesto") || 0),
    sinManifiesto: Number(r.get("Sin manifiesto") || 0),
    conError: Number(r.get("Con error") || 0),
    inicio: r.get("Inicio") || "",
    fin: r.get("Fin") || "",
    detalle: r.get("Detalle") || "",
    disparadoPor: r.get("Disparado por") || ""
  };
}

async function buscarAutorizadoWhatsApp(telefono) {
  if (supabaseStore.isSupabaseEnabled()) {
    return supabaseStore.buscarAutorizadoWhatsApp(telefono);
  }

  const telefonoNormalizado = normalizarTelefono(telefono);

  const records = await getBase()(TABLAS.whatsappAutorizados)
    .select({
      filterByFormula: `OR({Teléfono normalizado}="${escaparFormula(telefonoNormalizado)}",{Teléfono}="${escaparFormula(telefonoNormalizado)}",{Teléfono}="${escaparFormula(telefono)}")`,
      maxRecords: 1
    })
    .all();

  if (!records.length) return null;

  const r = records[0];

  return {
    airtableRecordId: r.id,
    telefono: r.get("Tel\u00e9fono") || "",
    telefonoNormalizado: r.get("Teléfono normalizado") || telefonoNormalizado,
    nombre: r.get("Nombre") || "",
    activo: !!r.get("Activo"),
    rol: r.get("Rol") || "",
    puedeVerMenu: !!r.get("Puede ver menú"),
    puedeConsultarEstado: !!r.get("Puede consultar estado"),
    puedeConsultarErrores: !!r.get("Puede consultar errores"),
    puedeVerDetalleJob: !!r.get("Puede ver detalle job"),
    puedeEjecutarBatch: !!r.get("Puede ejecutar batch"),
    puedeVerManifiestosPendientes: !!r.get("Puede ver manifiestos pendientes"),
    puedeSolicitarAprobacion: !!r.get("Puede solicitar aprobación"),
    puedeConfirmarAprobacion: !!r.get("Puede confirmar aprobación"),
    puedeAprobarManifiestos: !!r.get("Puede aprobar manifiestos")
  };
}

async function actualizarUltimaInteraccionWhatsApp(airtableRecordId, ultimoComando = "") {
  if (supabaseStore.isSupabaseEnabled()) {
    return supabaseStore.actualizarUltimaInteraccionWhatsApp(airtableRecordId, ultimoComando);
  }

  if (!airtableRecordId) return;

  await getBase()(TABLAS.whatsappAutorizados).update([
    {
      id: airtableRecordId,
      fields: limpiarCampos({
        "\u00daltima interacci\u00f3n": new Date().toISOString(),
        "\u00daltimo comando": normalizarComandoAirtable(ultimoComando)
      })
    }
  ]);
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
  jobIdRelacionado = "",
  jobAirtableRecordId = null,
  respuestaEnviada = "",
  estadoEjecucion = "OK",
  errorTecnico = "",
  statusEnvioMeta = "",
  statusEntregaMeta = ""
} = {}) {
  if (supabaseStore.isSupabaseEnabled()) {
    return supabaseStore.crearLogWhatsApp({
      telefonoRemitente,
      autorizado,
      contactoAutorizadoRecordId,
      nombreRemitente,
      tipoEvento,
      messageIdMeta,
      payloadCrudoEntrada,
      textoRecibido,
      comandoDetectado,
      respuestaEnviada,
      estadoEjecucion,
      errorTecnico,
      statusEnvioMeta,
      statusEntregaMeta
    });
  }

  const fields = limpiarCampos({
    "Teléfono remitente": telefonoRemitente,
    "Autorizado": !!autorizado,
    "Contacto autorizado": contactoAutorizadoRecordId ? [contactoAutorizadoRecordId] : undefined,
    "Nombre remitente": nombreRemitente,
    "Canal": "WhatsApp",
    "Tipo evento": tipoEvento,
    "Message ID Meta": messageIdMeta,
    "Payload crudo entrada": payloadCrudoEntrada,
    "Texto recibido": textoRecibido,
    "Comando detectado": normalizarComandoAirtable(comandoDetectado),
    "Job ID relacionado": jobIdRelacionado,
    "Job relacionado": jobAirtableRecordId ? [jobAirtableRecordId] : undefined,
    "Respuesta enviada": respuestaEnviada,
    "Estado ejecución": estadoEjecucion,
    "Error técnico": errorTecnico,
    "Status envío Meta": statusEnvioMeta,
    "Status entrega Meta": statusEntregaMeta
  });

  try {
    await getBase()(TABLAS.whatsappLog).create([{ fields }]);
  } catch (error) {
    console.error("[Airtable] Error creando WhatsApp_Log:", error.message);
  }
}

async function obtenerMenuWhatsApp() {
  try {
    const records = await getBase()(TABLAS.whatsappMenu)
      .select({
        filterByFormula: `{Activo}=1`,
        sort: [{ field: "Orden", direction: "asc" }]
      })
      .all();

    return records.map((r) => ({
      airtableRecordId: r.id,
      codigoOpcion: r.get("Código opción") || "",
      orden: Number(r.get("Orden") || 0),
      titulo: r.get("Título") || "",
      descripcion: r.get("Descripción") || "",
      comandoExacto: r.get("Comando exacto") || "",
      activo: !!r.get("Activo"),
      requiereAutorizacion: !!r.get("Requiere autorización"),
      permisoRequerido: r.get("Permiso requerido") || "",
      tipoOpcion: r.get("Tipo opción") || "",
      respuestaEjemplo: r.get("Respuesta ejemplo") || ""
    }));
  } catch (error) {
    console.error("[Airtable] Error obteniendo WhatsApp_Menu:", error.message);
    return [];
  }
}

async function obtenerConfigWhatsApp(clave) {
  try {
    const records = await getBase()(TABLAS.whatsappConfig)
      .select({
        filterByFormula: `{Clave}="${escaparFormula(clave)}"`,
        maxRecords: 1
      })
      .all();

    if (!records.length) return null;

    const r = records[0];

    return {
      clave: r.get("Clave") || "",
      valorTexto: r.get("Valor texto") || "",
      valorLargo: r.get("Valor largo") || "",
      valorNumero: Number(r.get("Valor número") || 0),
      activo: !!r.get("Activo")
    };
  } catch (error) {
    console.error("[Airtable] Error obteniendo WhatsApp_Configuracion:", error.message);
    return null;
  }
}

async function registrarManifiestoPendienteSimel({ jobRecordId, jobIdTexto, resultado }) {
  if (!resultado || resultado.estado !== "CON_MANIFIESTO") return;

  const fields = limpiarCampos({
    "Job relacionado": jobRecordId ? [jobRecordId] : undefined,
    "Job ID Texto": jobIdTexto || "",
    "Usuario SIMEL relacionado": resultado.recordId ? [resultado.recordId] : undefined,
    "Cantidad pendientes": Number(resultado.filas || 0),
    "Estado pendiente": "Pendiente de aprobación",
    "Detalle resumido": resultado.detalle || "",
    "Detalle técnico": resultado.detalle || "",
    "Requiere aprobación humana": true,
    "Activo": true,
    "Observaciones": "Creado automáticamente por worker SIMEL"
  });

  try {
    await getBase()(TABLAS.simelPendientes).create([{ fields }]);
  } catch (error) {
    console.error("[Airtable] Error creando SIMEL_Manifiestos_Pendientes:", error.message);
  }
}

async function listarManifiestosPendientesActivos({ limit = 10 } = {}) {
  const formula = `AND({Activo}=1,OR({Estado pendiente}="Pendiente de revisión",{Estado pendiente}="Pendiente de aprobación",{Estado pendiente}="Aprobación solicitada"))`;

  const records = await getBase()(TABLAS.simelPendientes)
    .select({
      filterByFormula: formula,
      sort: [{ field: "Fecha detección", direction: "desc" }],
      maxRecords: limit
    })
    .all();

  return records.map((r) => ({
    airtableRecordId: r.id,
    idPendiente: r.get("ID Pendiente") || "",
    jobIdTexto: r.get("Job ID Texto") || "",
    empresa: textoDesdeLookup(r.get("Empresa")),
    usuarioSimel: textoDesdeLookup(r.get("Usuario SIMEL")),
    cantidadPendientes: Number(r.get("Cantidad pendientes") || 0),
    estadoPendiente: r.get("Estado pendiente") || "",
    detalleResumido: r.get("Detalle resumido") || "",
    detalleTecnico: r.get("Detalle técnico") || ""
  }));
}

async function listarEmpresasSimel({ soloActivas = true } = {}) {
  if (supabaseStore.isSupabaseEnabled()) {
    return supabaseStore.listarEmpresasSimel({ soloActivas });
  }

  const records = await getBase()(TABLAS.usuariosSimel)
    .select({
      fields: ["Empresa", "Activo"],
      sort: [{ field: "Empresa", direction: "asc" }]
    })
    .all();

  const unicas = new Set();

  for (const r of records) {
    const empresa = (r.get("Empresa") || "").trim();
    const activo = !!r.get("Activo");

    if (!empresa) continue;
    if (soloActivas && !activo) continue;

    unicas.add(empresa);
  }

  return Array.from(unicas).sort((a, b) =>
    a.localeCompare(b, "es", { sensitivity: "base" })
  );
}

async function listarPendientesPorEmpresa(nombreEmpresa) {
  const formula = `AND({Activo}=1,OR({Estado pendiente}="Pendiente de revisión",{Estado pendiente}="Pendiente de aprobación",{Estado pendiente}="Aprobación solicitada"))`;

  const records = await getBase()(TABLAS.simelPendientes)
    .select({
      filterByFormula: formula,
      sort: [{ field: "Fecha detección", direction: "desc" }]
    })
    .all();

  const empresaNormalizada = normalizarTexto(nombreEmpresa);

  return records
    .map((r) => ({
      airtableRecordId: r.id,
      idPendiente: r.get("ID Pendiente") || "",
      jobIdTexto: r.get("Job ID Texto") || "",
      empresa: textoDesdeLookup(r.get("Empresa")),
      usuarioSimel: textoDesdeLookup(r.get("Usuario SIMEL")),
      cantidadPendientes: Number(r.get("Cantidad pendientes") || 0),
      estadoPendiente: r.get("Estado pendiente") || "",
      detalleResumido: r.get("Detalle resumido") || "",
      detalleTecnico: r.get("Detalle técnico") || ""
    }))
    .filter((p) => normalizarTexto(p.empresa) === empresaNormalizada);
}

async function buscarSesionWhatsAppRecord(telefono) {
  const telefonoNormalizado = normalizarTelefono(telefono);

  const records = await getBase()(TABLAS.whatsappSesiones)
    .select({
      filterByFormula: `{Teléfono}="${escaparFormula(telefonoNormalizado)}"`,
      maxRecords: 1,
      sort: [{ field: "Última actualización", direction: "desc" }]
    })
    .all();

  return records[0] || null;
}

async function obtenerSesionWhatsApp(telefono) {
  if (supabaseStore.isSupabaseEnabled()) {
    return supabaseStore.obtenerSesionWhatsApp(telefono);
  }

  const r = await buscarSesionWhatsAppRecord(telefono);
  if (!r) return null;

  const observaciones = r.get("Observaciones") || "";
  const dataSesion = parsearJSONSeguro(observaciones, {});
  const estadoSesionGuardado = r.get("Estado sesi\u00f3n") || "";
  const ultimoComandoGuardado = r.get("\u00daltimo comando") || "";
  const estadoSesion = dataSesion.workflowEstado || estadoSesionGuardado;
  if (estadoSesion === "Cerrada") return null;

  const expiraEn = r.get("Expira en");
  if (expiraEn && new Date(expiraEn) < new Date()) return null;

  return {
    airtableRecordId: r.id,
    telefono: r.get("Tel\u00e9fono") || "",
    ultimoMensaje: r.get("\u00daltimo mensaje") || "",
    ultimoComando: dataSesion.workflowUltimoComando || ultimoComandoGuardado,
    estadoSesion,
    jobIdEnContexto: r.get("Job ID en contexto") || "",
    empresaEnContexto: r.get("Empresa en contexto") || "",
    observaciones
  };
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
  if (supabaseStore.isSupabaseEnabled()) {
    return supabaseStore.guardarSesionWhatsApp({
      telefono,
      contactoAutorizadoRecordId,
      ultimoMensaje,
      ultimoComando,
      estadoSesion,
      jobIdEnContexto,
      empresaEnContexto,
      observaciones,
      ttlSegundos
    });
  }

  const telefonoNormalizado = normalizarTelefono(telefono);
  const existente = await buscarSesionWhatsAppRecord(telefonoNormalizado);
  const observacionesSerializadas = serializarObservacionesSesion({
    observaciones,
    workflowEstado: estadoSesion,
    workflowUltimoComando: ultimoComando
  });

  const fields = limpiarCampos({
    "Tel\u00e9fono": telefonoNormalizado,
    "Contacto autorizado": contactoAutorizadoRecordId ? [contactoAutorizadoRecordId] : undefined,
    "\u00daltimo mensaje": ultimoMensaje,
    "\u00daltimo comando": normalizarComandoAirtable(ultimoComando),
    "Estado sesi\u00f3n": normalizarEstadoSesionAirtable(estadoSesion),
    "Job ID en contexto": jobIdEnContexto,
    "Empresa en contexto": empresaEnContexto,
    "Expira en": new Date(Date.now() + Number(ttlSegundos || 0) * 1000).toISOString(),
    "Observaciones": observacionesSerializadas
  });

  if (existente) {
    await getBase()(TABLAS.whatsappSesiones).update([
      {
        id: existente.id,
        fields
      }
    ]);

    return existente.id;
  }

  const created = await getBase()(TABLAS.whatsappSesiones).create([{ fields }]);
  return created[0].id;
}

async function cerrarSesionWhatsApp(telefono) {
  if (supabaseStore.isSupabaseEnabled()) {
    return supabaseStore.cerrarSesionWhatsApp(telefono);
  }

  const existente = await buscarSesionWhatsAppRecord(telefono);
  if (!existente) return;

  await getBase()(TABLAS.whatsappSesiones).update([
    {
      id: existente.id,
      fields: {
        "Estado sesi\u00f3n": "Cerrada",
        "Job ID en contexto": "",
        "Empresa en contexto": "",
        "Observaciones": ""
      }
    }
  ]);
}

async function crearAprobacionSimel({ empresaNombre, pendienteRecordId, solicitanteRecordId, solicitanteTelefono, solicitanteNombre, cantidadPendientes, token }) {
  const fields = limpiarCampos({
    "Empresa": empresaNombre || "",
    "Pendiente relacionado": pendienteRecordId ? [pendienteRecordId] : undefined,
    "Solicitante": solicitanteRecordId ? [solicitanteRecordId] : undefined,
    "Teléfono solicitante": solicitanteTelefono || "",
    "Nombre solicitante": solicitanteNombre || "",
    "Cantidad a aprobar": Number(cantidadPendientes || 0),
    "Token confirmación": token || "",
    "Estado": "Pendiente confirmación",
    "Fecha solicitud": new Date().toISOString()
  });

  try {
    const created = await getBase()(TABLAS.aprobaciones).create([{ fields }]);
    return {
      airtableRecordId: created[0].id,
      token
    };
  } catch (error) {
    console.error("[Airtable] Error creando aprobación:", error.message);
    throw error;
  }
}

async function buscarAprobacionPorToken(token) {
  try {
    const records = await getBase()(TABLAS.aprobaciones)
      .select({
        filterByFormula: `AND({Token confirmación}="${escaparFormula(token)}",{Estado}="Pendiente confirmación")`,
        maxRecords: 1
      })
      .all();

    if (!records.length) return null;

    const r = records[0];

    return {
      airtableRecordId: r.id,
      empresa: r.get("Empresa") || "",
      token: r.get("Token confirmación") || "",
      estado: r.get("Estado") || "",
      solicitanteTelefono: r.get("Teléfono solicitante") || "",
      cantidadAprobar: Number(r.get("Cantidad a aprobar") || 0),
      pendienteRecordId: r.get("Pendiente relacionado") || [],
      fechaSolicitud: r.get("Fecha solicitud") || ""
    };
  } catch (error) {
    console.error("[Airtable] Error buscando aprobación por token:", error.message);
    return null;
  }
}

async function actualizarEstadoAprobacion(airtableRecordId, { estado, fechaEjecucion, resultadoEjecucion, errorEjecucion }) {
  const fields = limpiarCampos({
    "Estado": estado,
    "Fecha ejecución": fechaEjecucion,
    "Resultado ejecución": resultadoEjecucion,
    "Error ejecución": errorEjecucion
  });

  try {
    await getBase()(TABLAS.aprobaciones).update([
      {
        id: airtableRecordId,
        fields
      }
    ]);
  } catch (error) {
    console.error("[Airtable] Error actualizando estado de aprobación:", error.message);
  }
}

async function obtenerAprobacionesPendientesConfirmacion() {
  try {
    const records = await getBase()(TABLAS.aprobaciones)
      .select({
        filterByFormula: `{Estado}="Pendiente confirmación"`,
        sort: [{ field: "Fecha solicitud", direction: "desc" }]
      })
      .all();

    return records.map((r) => ({
      airtableRecordId: r.id,
      empresa: r.get("Empresa") || "",
      token: r.get("Token confirmación") || "",
      solicitanteNombre: r.get("Nombre solicitante") || "",
      cantidadAprobar: Number(r.get("Cantidad a aprobar") || 0),
      fechaSolicitud: r.get("Fecha solicitud") || ""
    }));
  } catch (error) {
    console.error("[Airtable] Error obteniendo aprobaciones pendientes:", error.message);
    return [];
  }
}

async function obtenerHistorialAprobacionesEmpresa(nombreEmpresa, limit = 5) {
  if (supabaseStore.isSupabaseEnabled()) {
    return supabaseStore.obtenerHistorialAprobacionesEmpresa(nombreEmpresa, limit);
  }

  try {
    const records = await getBase()(TABLAS.aprobaciones)
      .select({
        filterByFormula: `{Empresa}="${escaparFormula(nombreEmpresa)}"`,
        sort: [{ field: "Fecha solicitud", direction: "desc" }],
        maxRecords: limit
      })
      .all();

    return records.map((r) => ({
      airtableRecordId: r.id,
      empresa: r.get("Empresa") || "",
      estado: r.get("Estado") || "",
      cantidadAprobar: Number(r.get("Cantidad a aprobar") || 0),
      fechaSolicitud: r.get("Fecha solicitud") || "",
      fechaEjecucion: r.get("Fecha ejecución") || "",
      solicitanteNombre: r.get("Nombre solicitante") || ""
    }));
  } catch (error) {
    console.error("[Airtable] Error obteniendo historial de aprobaciones:", error.message);
    return [];
  }
}

async function obtenerDatosEmpresaSimel(nombreEmpresa) {
  if (supabaseStore.isSupabaseEnabled()) {
    return supabaseStore.obtenerDatosEmpresaSimel(nombreEmpresa);
  }

  try {
    const records = await getBase()(TABLAS.usuariosSimel)
      .select({
        filterByFormula: `{Empresa}="${escaparFormula(nombreEmpresa)}"`,
        maxRecords: 1,
        fields: ["Empresa", "Activo", "Último check", "Último estado", "Último detalle", "Cantidad filas pendientes"]
      })
      .all();

    if (!records.length) return null;

    const r = records[0];

    return {
      recordId: r.id,
      empresa: r.get("Empresa") || nombreEmpresa,
      activo: !!r.get("Activo"),
      ultimoCheck: r.get("Último check") || "",
      ultimoEstado: r.get("Último estado") || "",
      ultimoDetalle: r.get("Último detalle") || "",
      cantidadFilasPendientes: Number(r.get("Cantidad filas pendientes") || 0)
    };
  } catch (error) {
    console.error("[Airtable] Error obteniendo datos de empresa:", error.message);
    return null;
  }
}

async function marcarEmpresasParaReintentar(recordIds) {
  if (!recordIds || !recordIds.length) return;

  try {
    const updates = recordIds.map((id) => ({
      id,
      fields: {
        "Ejecutar batch": true
      }
    }));

    // Airtable permite máximo 10 updates por batch
    for (let i = 0; i < updates.length; i += 10) {
      const batch = updates.slice(i, i + 10);
      await getBase()(TABLAS.usuariosSimel).update(batch);
    }

    console.log(`[Airtable] Marcadas ${recordIds.length} empresa(s) para reintentar`);
  } catch (error) {
    console.error("[Airtable] Error marcando empresas para reintentar:", error.message);
  }
}

async function obtenerAdminsWhatsApp() {
  try {
    const records = await getBase()(TABLAS.whatsappAutorizados)
      .select({
        filterByFormula: `AND({Activo}=1,{Rol}="Admin")`,
        fields: ["Teléfono", "Teléfono normalizado", "Nombre"]
      })
      .all();

    return records.map((r) => ({
      airtableRecordId: r.id,
      telefono: r.get("Teléfono") || "",
      telefonoNormalizado: r.get("Teléfono normalizado") || "",
      nombre: r.get("Nombre") || ""
    }));
  } catch (error) {
    console.error("[Airtable] Error obteniendo admins WhatsApp:", error.message);
    return [];
  }
}

async function obtenerUsuarioSimelPorEmpresa(nombreEmpresa) {
  if (supabaseStore.isSupabaseEnabled()) {
    return supabaseStore.obtenerUsuarioSimelPorEmpresa(nombreEmpresa);
  }

  try {
    const records = await getBase()(TABLAS.usuariosSimel)
      .select({
        filterByFormula: `{Empresa}="${escaparFormula(nombreEmpresa)}"`,
        maxRecords: 1,
        fields: ["Empresa", "Usuario", "Password", "Activo"]
      })
      .all();

    if (!records.length) return null;

    const r = records[0];

    return {
      recordId: r.id,
      empresa: r.get("Empresa") || "",
      usuario: r.get("Usuario") || "",
      password: r.get("Password") || "",
      activo: !!r.get("Activo")
    };
  } catch (error) {
    console.error("[Airtable] Error obteniendo usuario SIMEL por empresa:", error.message);
    return null;
  }
}

module.exports = {
  obtenerUsuariosSimelActivos,
  obtenerTodosLosUsuariosSimelPendientes,
  actualizarResultadoSimel,
  crearJobSimel,
  buscarJobPendiente,
  buscarJobPendienteOEnProceso,
  actualizarJobSimel,
  crearDetalleJobSimel,
  obtenerJobPorTexto,
  obtenerDetallesJobSimel,
  obtenerUltimoJobSimel,
  buscarAutorizadoWhatsApp,
  actualizarUltimaInteraccionWhatsApp,
  crearLogWhatsApp,
  obtenerMenuWhatsApp,
  obtenerConfigWhatsApp,
  registrarManifiestoPendienteSimel,
  listarManifiestosPendientesActivos,
  listarEmpresasSimel,
  listarPendientesPorEmpresa,
  obtenerSesionWhatsApp,
  guardarSesionWhatsApp,
  cerrarSesionWhatsApp,
  crearAprobacionSimel,
  buscarAprobacionPorToken,
  actualizarEstadoAprobacion,
  obtenerAprobacionesPendientesConfirmacion,
  obtenerHistorialAprobacionesEmpresa,
  obtenerDatosEmpresaSimel,
  marcarEmpresasParaReintentar,
  obtenerAdminsWhatsApp,
  obtenerUsuarioSimelPorEmpresa,
  upsertEmpresaSimelEnSupabase: supabaseStore.upsertEmpresaConCredencial
};


