const { checkSimel } = require("./simel-check");

async function runBatch({ usuarios, onResultado }) {
  if (!Array.isArray(usuarios) || usuarios.length === 0) {
    throw new Error("Falta el array de usuarios");
  }

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
        filas: resultado.filas
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
        detalle: resultado.detalle
      });
    }

    if (typeof onResultado === "function") {
      await onResultado(resultado);
    }
  }

  return resumen;
}

module.exports = { runBatch };
