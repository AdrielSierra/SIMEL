const Airtable = require("airtable");

const base = new Airtable({
  apiKey: process.env.AIRTABLE_TOKEN
}).base(process.env.AIRTABLE_BASE_ID);

async function obtenerUsuariosSimelActivos({ limit = 5 } = {}) {
  const records = await base(process.env.AIRTABLE_TABLE_NAME)
    .select()
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

async function actualizarResultadoSimel(resultado) {
  if (!resultado.recordId) return;

  await base(process.env.AIRTABLE_TABLE_NAME).update([
    {
      id: resultado.recordId,
      fields: {
        "Último check": new Date().toISOString().slice(0, 10),
        "Último estado": resultado.estado || "",
        "Último detalle": resultado.detalle || "",
        "Cantidad filas pendientes": Number(resultado.filas || 0)
      }
    }
  ]);
}

module.exports = {
  obtenerUsuariosSimelActivos,
  actualizarResultadoSimel
};
