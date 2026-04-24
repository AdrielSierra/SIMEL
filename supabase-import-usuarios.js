const fs = require("fs");
const path = require("path");
const { upsertEmpresaConCredencial } = require("./supabase-store");

function parseCsvLine(line = "") {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function parseCsv(content = "") {
  const normalized = String(content || "").replace(/^\uFEFF/, "");
  const lines = normalized
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    return row;
  });
}

function parseFechaDdMmYyyy(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;

  const [, dd, mm, yyyy] = match;
  const day = dd.padStart(2, "0");
  const month = mm.padStart(2, "0");
  return `${yyyy}-${month}-${day}T00:00:00.000Z`;
}

function extraerCuit(usuario = "") {
  return String(usuario || "").split("/")[0].trim();
}

async function main() {
  const inputPath = process.argv[2] || path.join(process.cwd(), "Usuarios_SIMEL-Grid view.csv");
  if (!fs.existsSync(inputPath)) {
    throw new Error(`No existe el archivo CSV: ${inputPath}`);
  }

  const content = fs.readFileSync(inputPath, "utf8");
  const rows = parseCsv(content);
  let importadas = 0;

  for (const row of rows) {
    const empresa = String(row.Empresa || "").trim();
    const usuario = String(row.Usuario || "").trim();
    const password = String(row.Password || "").trim();

    if (!empresa || !usuario || !password) {
      continue;
    }

    await upsertEmpresaConCredencial({
      nombre: empresa,
      usuarioSimel: usuario,
      passwordPlano: password,
      cuit: extraerCuit(usuario),
      activa: String(row.Activo || "").trim().toLowerCase() === "checked",
      credencialActiva: String(row.Activo || "").trim().toLowerCase() === "checked",
      ultimoCheckAt: parseFechaDdMmYyyy(row["Último check"]),
      ultimoEstado: String(row["Último estado"] || "").trim(),
      ultimoDetalle: String(row["Último detalle"] || "").trim(),
      cantidadFilasPendientes: Number(row["Cantidad filas pendientes"] || 0)
    });

    importadas++;
  }

  console.log(`Importación completa. Filas importadas: ${importadas}`);
}

main().catch((error) => {
  console.error("Error importando usuarios SIMEL:", error.message);
  process.exit(1);
});
