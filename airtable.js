const Airtable = require("airtable");

const base = new Airtable({
  apiKey: process.env.AIRTABLE_TOKEN
}).base(process.env.AIRTABLE_BASE_ID);

async function obtenerUsuariosSimelActivos() {
  const records = await base(process.env.AIRTABLE_TABLE_NAME)
    .select()
    .all();

  return records
    .map((record) => ({
      empresa: record.get("Empresa") || "",
      usuario: record.get("Usuario") || "",
      password: record.get("Password") || "",
      activo: record.get("Activo"),
      ejecutarBatch: record.get("Ejecutar batch")
    }))
    .filter((r) => !!r.activo && !!r.ejecutarBatch)
    .slice(0, 3);
}

module.exports = { obtenerUsuariosSimelActivos };
