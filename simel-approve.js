const { SimelClient, withTimeout } = require("./simel-client");

async function aprobarPendientesSimelInterno(user, pass) {
  if (!user || !pass) {
    return {
      ok: false,
      estado: "ERROR",
      pendientesAntes: 0,
      pendientesDespues: 0,
      aprobados: 0,
      detalle: "Faltan credenciales user/pass"
    };
  }

  const client = await new SimelClient({ headless: true }).start();

  try {
    await client.loginYAbrirPendientes(user, pass);

    const pendientesAntes = await client.contarPendientes();
    if (pendientesAntes === 0) {
      return {
        ok: true,
        estado: "SIN_MANIFIESTO",
        pendientesAntes: 0,
        pendientesDespues: 0,
        aprobados: 0,
        detalle: "No habia manifiestos pendientes para aprobar."
      };
    }

    const listado = await client.listarPendientes({ maxItems: pendientesAntes });
    let aprobados = 0;
    let errores = 0;

    for (const item of listado.items) {
      const resultado = await client.operarManifiesto({
        idOperacion: item.idOperacion,
        accion: "ACEPTAR"
      });

      if (resultado.ok) aprobados++;
      else errores++;
    }

    const pendientesDespues = await client.contarPendientes();
    const aprobadoCompleto = pendientesDespues === 0;

    return {
      ok: errores === 0 || aprobados > 0,
      estado: aprobadoCompleto ? "APROBADO" : errores > 0 ? "PARCIAL" : "ERROR",
      pendientesAntes,
      pendientesDespues,
      aprobados,
      detalle: aprobadoCompleto
        ? `Aprobacion automatica completada (${aprobados} manifiesto(s)).`
        : `Aprobacion parcial: antes ${pendientesAntes}, despues ${pendientesDespues}, errores ${errores}.`
    };
  } catch (error) {
    return {
      ok: false,
      estado: "ERROR",
      pendientesAntes: 0,
      pendientesDespues: 0,
      aprobados: 0,
      detalle: error.message
    };
  } finally {
    await client.close();
  }
}

async function aprobarPendientesSimel(user, pass) {
  return withTimeout(
    () => aprobarPendientesSimelInterno(user, pass),
    90000,
    "Timeout: SIMEL no respondio en 90 segundos durante aprobacion"
  ).catch((err) => ({
    ok: false,
    estado: "ERROR",
    pendientesAntes: 0,
    pendientesDespues: 0,
    aprobados: 0,
    detalle: err.message
  }));
}

module.exports = { aprobarPendientesSimel };
