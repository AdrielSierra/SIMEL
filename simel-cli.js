require("./env-loader");

const { checkSimel } = require("./simel-check");
const { aprobarPendientesSimel } = require("./simel-approve");
const { runBatch } = require("./simel-batch");
const {
  listarEmpresasSimel,
  obtenerUsuarioSimelPorEmpresa,
  obtenerTodosLosUsuariosSimelPendientes
} = require("./airtable");

function normalizarTexto(valor = "") {
  return String(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseArgs(argv) {
  const args = [...argv];
  const flags = {};
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith("--")) {
      const [key, inlineValue] = token.slice(2).split("=", 2);
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }

  return { flags, positionals };
}

function matchEmpresa(empresas, termino) {
  const term = normalizarTexto(termino);
  const exacta = empresas.find((e) => normalizarTexto(e) === term);
  if (exacta) return { empresa: exacta, coincidencias: [exacta] };

  const parciales = empresas.filter((e) => normalizarTexto(e).includes(term));
  if (parciales.length === 1) return { empresa: parciales[0], coincidencias: parciales };
  return { empresa: null, coincidencias: parciales };
}

async function obtenerCredencialesPorEmpresa(empresaInput) {
  const empresas = await listarEmpresasSimel({ soloActivas: true });
  const { empresa, coincidencias } = matchEmpresa(empresas, empresaInput);

  if (!empresa) {
    return {
      ok: false,
      error: !coincidencias.length
        ? `No encontré empresa para "${empresaInput}".`
        : `Encontré varias coincidencias: ${coincidencias.join(", ")}`
    };
  }

  const cred = await obtenerUsuarioSimelPorEmpresa(empresa);
  if (!cred?.usuario || !cred?.password) {
    return {
      ok: false,
      empresa,
      error: `No encontré credenciales activas para ${empresa}.`
    };
  }

  return { ok: true, empresa, cred };
}

async function ejecutarConsultaEmpresa(empresaInput) {
  const credencial = await obtenerCredencialesPorEmpresa(empresaInput);
  if (!credencial.ok) return credencial;

  const resultado = await checkSimel(credencial.cred.usuario, credencial.cred.password);
  return {
    ok: resultado.ok,
    modo: "check",
    empresa: credencial.empresa,
    usuario: credencial.cred.usuario,
    resultado
  };
}

async function ejecutarAprobacionEmpresa(empresaInput) {
  const credencial = await obtenerCredencialesPorEmpresa(empresaInput);
  if (!credencial.ok) return credencial;

  const resultado = await aprobarPendientesSimel(credencial.cred.usuario, credencial.cred.password, {
    empresa: credencial.empresa
  });
  return {
    ok: resultado.ok,
    modo: "approve",
    empresa: credencial.empresa,
    usuario: credencial.cred.usuario,
    resultado
  };
}

async function ejecutarBatch({ soloMarcadosBatch = false } = {}) {
  const usuarios = await obtenerTodosLosUsuariosSimelPendientes({ soloMarcadosBatch });
  const resumen = await runBatch({ usuarios });
  return {
    ok: true,
    modo: "batch",
    criterio: soloMarcadosBatch ? "solo_marcados_batch" : "todos_los_activos",
    resumen
  };
}

function imprimirAyuda() {
  console.log(`SIMEL CLI\n\nUso:\n  node simel-cli.js batch\n  node simel-cli.js check --empresa "United"\n  node simel-cli.js approve --empresa "United"\n\nRequiere variables de entorno de Airtable para modos por empresa y batch.`);
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const comando = positionals[0];

  if (!comando || ["help", "--help", "-h"].includes(comando)) {
    imprimirAyuda();
    return;
  }

  let salida;

  if (comando === "batch") {
    const soloMarcadosBatch = /^(1|true|si|yes)$/i.test(String(flags['solo-marcados'] || flags.soloMarcados || 'false'));
    salida = await ejecutarBatch({ soloMarcadosBatch });
  } else if (comando === "check") {
    const empresa = flags.empresa || flags.company || positionals.slice(1).join(" ");
    if (!empresa) throw new Error("Falta --empresa para la consulta puntual.");
    salida = await ejecutarConsultaEmpresa(empresa);
  } else if (comando === "approve") {
    const empresa = flags.empresa || flags.company || positionals.slice(1).join(" ");
    if (!empresa) throw new Error("Falta --empresa para la aprobación puntual.");
    salida = await ejecutarAprobacionEmpresa(empresa);
  } else {
    throw new Error(`Comando no soportado: ${comando}`);
  }

  console.log(JSON.stringify(salida, null, 2));

  if (salida && salida.ok === false) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[simel-cli] Error:", error.message || error);
    process.exit(1);
  });
}

module.exports = {
  ejecutarBatch,
  ejecutarConsultaEmpresa,
  ejecutarAprobacionEmpresa,
  obtenerCredencialesPorEmpresa
};
