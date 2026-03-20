const Airtable = require("airtable");

const base = new Airtable({
  apiKey: process.env.AIRTABLE_TOKEN
}).base(process.env.AIRTABLE_BASE_ID);

async function obtenerUsuariosSimelActivos({ limit = 5 } = {}) {
  const records = await base(process.env.AIRTABLE_TABLE_NAME)
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
      activo: record.get("Activo"),
      ejecutarBatch: record.get("Ejecutar batch")
    }))
    .filter((r) => !!r.activo && !!r.ejecutarBatch)
    .slice(0, limit);
}

async function obtenerTodosLosUsuariosSimelPendientes() {
  const records = await base(process.env.AIRTABLE_TABLE_NAME)
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
      activo: record.get("Activo"),
      ejecutarBatch: record.get("Ejecutar batch")
    }))
    .filter((r) => !!r.activo && !!r.ejecutarBatch);
}

async function actualizarResultadoSimel(resultado) {
  if (!resultado.recordId) return;

  await base(process.env.AIRTABLE_TABLE_NAME).update([
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

  const created = await base(process.env.AIRTABLE_JOBS_TABLE).create([
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
  const records = await base(process.env.AIRTABLE_JOBS_TABLE)
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
    jobId: r.get("Job ID"),
    estado: r.get("Estado"),
    totalEmpresas: r.get("Total empresas") || 0,
    procesadas: r.get("Procesadas") || 0,
    conManifiesto: r.get("Con manifiesto") || 0,
    sinManifiesto: r.get("Sin manifiesto") || 0,
    conError: r.get("Con error") || 0
  };
}

async function buscarJobPendienteOEnProceso() {
  const records = await base(process.env.AIRTABLE_JOBS_TABLE)
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
    jobId: r.get("Job ID"),
    estado: r.get("Estado"),
    totalEmpresas: r.get("Total empresas") || 0,
    procesadas: r.get("Procesadas") || 0,
    conManifiesto: r.get("Con manifiesto") || 0,
    sinManifiesto: r.get("Sin manifiesto") || 0,
    conError: r.get("Con error") || 0
  };
}

async function actualizarJobSimel(airtableRecordId, fields) {
  await base(process.env.AIRTABLE_JOBS_TABLE).update([
    {
      id: airtableRecordId,
      fields
    }
  ]);
}

async function crearDetalleJobSimel({ jobRecordId, jobIdTexto, resultado }) {
  await base(process.env.AIRTABLE_JOBS_DETAIL_TABLE).create([
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
  const records = await base(process.env.AIRTABLE_JOBS_TABLE)
    .select({
      filterByFormula: `{Job ID}="${jobId}"`,
      maxRecords: 1
    })
    .all();

  if (!records.length) return null;

  const r = records[0];

  return {
    airtableRecordId: r.id,
    jobId: r.get("Job ID"),
    estado: r.get("Estado"),
    totalEmpresas: r.get("Total empresas") || 0,
    procesadas: r.get("Procesadas") || 0,
    conManifiesto: r.get("Con manifiesto") || 0,
    sinManifiesto: r.get("Sin manifiesto") || 0,
    conError: r.get("Con error") || 0,
    inicio: r.get("Inicio") || "",
    fin: r.get("Fin") || "",
    detalle: r.get("Detalle") || ""
  };
}
async function obtenerDetallesJobSimel(jobId) {
  const records = await base(process.env.AIRTABLE_JOBS_DETAIL_TABLE)
    .select({
      filterByFormula: `{Job ID Texto}="${jobId}"`,
      sort: [{ field: "Empresa", direction: "asc" }]
    })
    .all();

  return records.map((r) => ({
    airtableRecordId: r.id,
    empresa: r.get("Empresa") || "",
    usuario: r.get("Usuario") || "",
    estado: r.get("Estado") || "",
    filas: r.get("Filas") || 0,
    detalle: r.get("Detalle") || "",
    fecha: r.get("Fecha") || "",
    jobIdTexto: r.get("Job ID Texto") || ""
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
  obtenerDetallesJobSimel
};
