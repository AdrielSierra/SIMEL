const { checkSimel } = require("./simel-check");

async function runBatch({ usuarios }) {
  if (!Array.isArray(usuarios) || usuarios.length === 0) {
    throw new Error("Falta el array de usuarios");
  }

  const resultados = [];
  const conManifiesto = [];
  const sinManifiesto = [];
  const conError = [];

  for (const item of usuarios) {
    const empresa = String(item.empresa || "").trim();
    const usuario = String(item.usuario || "").trim();
    const password = String(item.password || "").trim();

    if (!empresa || !usuario || !password) {
      const r = {
        ok: false,
        empresa,
        usuario,
        hayManifiesto: false,
        filas: 0,
        estado: "ERROR",
        detalle: "Datos incompletos",
        error: "DATOS_INCOMPLETOS"
      };
      resultados.push(r);
      conError.push(r);
      continue;
    }

    const resultado = await checkSimel(usuario, password);

    const enriquecido = {
      ...resultado,
      empresa
    };

    resultados.push(enriquecido);

    if (enriquecido.estado === "CON_MANIFIESTO") {
      conManifiesto.push({
        empresa: enriquecido.empresa,
        usuario: enriquecido.usuario,
        filas: enriquecido.filas,
        estado: enriquecido.estado,
        detalle: enriquecido.detalle
      });
    } else if (enriquecido.estado === "SIN_MANIFIESTO") {
      sinManifiesto.push({
        empresa: enriquecido.empresa,
        usuario: enriquecido.usuario,
        filas: enriquecido.filas,
        estado: enriquecido.estado,
        detalle: enriquecido.detalle
      });
    } else {
      conError.push({
        empresa: enriquecido.empresa,
        usuario: enriquecido.usuario,
        filas: enriquecido.filas,
        estado: enriquecido.estado,
        detalle: enriquecido.detalle,
        error: enriquecido.error
      });
    }
  }

  return {
    ok: true,
    total: usuarios.length,
    revisados: resultados.length,
    cantidadConManifiesto: conManifiesto.length,
    cantidadSinManifiesto: sinManifiesto.length,
    cantidadConError: conError.length,
    conManifiesto,
    sinManifiesto,
    conError,
    resultados
  };
}

module.exports = { runBatch };
