const { checkSimel } = require("./simel-check");

function logResultado(resultado) {
  const contexto = `${resultado.empresa || "[sin empresa]"} (${resultado.usuario || "sin usuario"})`;

  if (resultado.estado === "SIN_MANIFIESTO") {
    console.log(`✅ ${contexto}: sin manifiestos (${resultado.filas || 0} filas)`);
  } else if (resultado.estado === "CON_MANIFIESTO") {
    console.log(`⚠️ ${contexto}: ${resultado.filas || "?"} pendientes — ${resultado.detalle || "n/d"}`);
  } else {
    console.log(`❌ ${contexto}: error -> ${resultado.detalle || resultado.error || "n/d"}`);
  }
}

async function runBatch({ usuarios, onResultado }) {
  if (!Array.isArray(usuarios) || usuarios.length === 0) {
    throw new Error("Falta el array de usuarios");
  }

  console.log(`Iniciando batch con ${usuarios.length} empresas`);

  const resumen = {
    ok: true,
    total: usuarios.length,
    revisados: 0,
    cantidadConManifiesto: 0,
    cantidadSinManifiesto: 0,
    cantidadConError: 0,
    empresasConManifiesto: [],
    empresasSinManifiesto: [],
    empresasConError: []
  };

  for (const item of usuarios) {
    const empresa = String(item.empresa || "").trim();
    const usuario = String(item.usuario || "").trim();
    const password = String(item.password || "").trim();
    const recordId = item.recordId || null;

    let resultado;

    if (!empresa || !usuario || !password) {
      resultado = {
        ok: false,
        empresa,
        usuario,
        filas: 0,
        estado: "ERROR",
        detalle: "Datos incompletos",
        error: "DATOS_INCOMPLETOS",
        recordId
      };
    } else {
      const r = await checkSimel(usuario, password);
      resultado = {
        ...r,
        empresa,
        recordId
      };
    }

    resumen.revisados++;

    if (resultado.estado === "CON_MANIFIESTO") {
      resumen.cantidadConManifiesto++;
      resumen.empresasConManifiesto.push({
        empresa: resultado.empresa,
        usuario: resultado.usuario,
        filas: resultado.filas || 0,
        detalle: resultado.detalle || ""
      });
    } else if (resultado.estado === "SIN_MANIFIESTO") {
      resumen.cantidadSinManifiesto++;
      resumen.empresasSinManifiesto.push({
        empresa: resultado.empresa,
        usuario: resultado.usuario
      });
    } else {
      resumen.cantidadConError++;
      resumen.empresasConError.push({
        empresa: resultado.empresa,
        usuario: resultado.usuario,
        detalle: resultado.detalle || resultado.error || ""
      });
    }

    logResultado(resultado);

    if (typeof onResultado === "function") {
      await onResultado(resultado);
    }
  }

  console.log("Batch terminado", {
    total: resumen.total,
    revisados: resumen.revisados,
    conManifiesto: resumen.cantidadConManifiesto,
    sinManifiesto: resumen.cantidadSinManifiesto,
    conError: resumen.cantidadConError
  });

  return resumen;
}

module.exports = { runBatch };
