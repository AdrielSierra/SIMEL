const Airtable = require("airtable");

const base = new Airtable({
  apiKey: process.env.AIRTABLE_TOKEN
}).base(process.env.AIRTABLE_BASE_ID);

const TABLAS = {
  usuariosSimel: process.env.AIRTABLE_TABLE_NAME || "Usuarios_SIMEL",
  jobsSimel: process.env.AIRTABLE_JOBS_TABLE || "Jobs_SIMEL",
  jobsSimelDetalle: process.env.AIRTABLE_JOBS_DETAIL_TABLE || "Jobs_SIMEL_Detalle",
  whatsappAutorizados: process.env.AIRTABLE_WHATSAPP_AUTH_TABLE || "WhatsApp_Autorizados",
  whatsappLog: process.env.AIRTABLE_WHATSAPP_LOG_TABLE || "WhatsApp_Log",
  whatsappMenu: process.env.AIRTABLE_WHATSAPP_MENU_TABLE || "WhatsApp_Menu",
  simelPendientes: process.env.AIRTABLE_SIMEL_PENDING_TABLE || "SIMEL_Manifiestos_Pendientes",
  whatsappConfig: process.env.AIRTABLE_WHATSAPP_CONFIG_TABLE || "WhatsApp_Configuracion"
};

function escaparFormula(valor = "") {
  return String(valor)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function normalizarTelefono(valor = "") {
  return String(valor).replace(/\D/g, "");
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

async function obtenerUsuariosSimelActivos({ limit = 5 } = {}) {
  const records = await base(TABLAS.usuariosSimel)
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

async function obtenerTodosLosUsuariosSimelPendientes() {
  const records = await base(TABLAS.usuariosSimel)
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
    .filter((r) => r.activo && r.ejecutarBatch);
}

async function actualizarResultadoSimel(resultado) {
  if (!resultado.recordId) return;

  await base(TABLAS.usuariosSimel).update([
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

  const created = await base(TABLAS.jobsSimel).create([
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
  const records = await base(TABLAS.jobsSimel)
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
  const records = await base(TABLAS.jobsSimel)
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
  await base(TABLAS.jobsSimel).update([
    {
      id: airtableRecordId,
      fields
    }
  ]);
}

async function crearDetalleJobSimel({ jobRecordId, jobIdTexto, resultado }) {
  await base(TABLAS.jobsSimelDetalle).create([
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
  const records = await base(TABLAS.jobsSimel)
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
  const records = await base(TABLAS.jobsSimelDetalle)
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
    jobIdTexto: r.get("Job ID Texto") || ""
  }));
}

async function obtenerUltimoJobSimel() {
  const records = await base(TABLAS.jobsSimel)
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
  const telefonoNormalizado = normalizarTelefono(telefono);

  const records = await base(TABLAS.whatsappAutorizados)
    .select({
      filterByFormula: `OR({Teléfono normalizado}="${escaparFormula(telefonoNormalizado)}",{Teléfono}="${escaparFormula(telefonoNormalizado)}",{Teléfono}="${escaparFormula(telefono)}")`,
      maxRecords: 1
    })
    .all();

  if (!records.length) return null;

  const r = records[0];

  return {
    airtableRecordId: r.id,
    telefono: r.get("Teléfono") || "",
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
  if (!airtableRecordId) return;

  await base(TABLAS.whatsappAutorizados).update([
    {
      id: airtableRecordId,
      fields: limpiarCampos({
        "Última interacción": new Date().toISOString(),
        "Último comando": ultimoComando
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
    "Comando detectado": comandoDetectado,
    "Job ID relacionado": jobIdRelacionado,
    "Job relacionado": jobAirtableRecordId ? [jobAirtableRecordId] : undefined,
    "Respuesta enviada": respuestaEnviada,
    "Estado ejecución": estadoEjecucion,
    "Error técnico": errorTecnico,
    "Status envío Meta": statusEnvioMeta,
    "Status entrega Meta": statusEntregaMeta
  });

  try {
    await base(TABLAS.whatsappLog).create([{ fields }]);
  } catch (error) {
    console.error("[Airtable] Error creando WhatsApp_Log:", error.message);
  }
}

async function obtenerMenuWhatsApp() {
  try {
    const records = await base(TABLAS.whatsappMenu)
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
    const records = await base(TABLAS.whatsappConfig)
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
    await base(TABLAS.simelPendientes).create([{ fields }]);
  } catch (error) {
    console.error("[Airtable] Error creando SIMEL_Manifiestos_Pendientes:", error.message);
  }
}

async function listarManifiestosPendientesActivos({ limit = 10 } = {}) {
  const formula = `AND({Activo}=1,OR({Estado pendiente}="Pendiente de revisión",{Estado pendiente}="Pendiente de aprobación",{Estado pendiente}="Aprobación solicitada"))`;

  const records = await base(TABLAS.simelPendientes)
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
  listarManifiestosPendientesActivos
};