require("./env-loader");

const { SimelClient, withTimeout } = require("./simel-client");
const { verificarAprobacionPorHistorial } = require("./simel-verification");

async function aprobarPendientesSimelInterno(user, pass, { empresa = "" } = {}) {
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

    await client.refrescarPendientes().catch(() => {});
    const pendientesDespues = await client.contarPendientes();
    const aprobadoCompleto = pendientesDespues === 0;
    const disminuyeronPendientes = pendientesDespues < pendientesAntes;
    const ok = aprobadoCompleto || (errores === 0 && aprobados > 0 && disminuyeronPendientes);

    let verificacionHistorial = null;
    let okFinal = ok;
    let estadoFinal = aprobadoCompleto ? "APROBADO" : aprobados > 0 && disminuyeronPendientes ? "PARCIAL" : "ERROR";
    let detalleFinal = aprobadoCompleto
      ? `Aprobacion automatica completada (${aprobados} manifiesto(s)).`
      : aprobados > 0 && disminuyeronPendientes
        ? `Aprobacion parcial: antes ${pendientesAntes}, despues ${pendientesDespues}, errores ${errores}.`
        : `No se pudieron confirmar aprobaciones. Antes ${pendientesAntes}, despues ${pendientesDespues}, errores ${errores}.`;

    if (!okFinal && empresa && aprobados > 0) {
      verificacionHistorial = await verificarAprobacionPorHistorial({
        empresa,
        aprobadosEsperados: aprobados
      }).catch(() => null);

      if (verificacionHistorial?.ok) {
        okFinal = true;
        estadoFinal = "APROBADO_CONFIRMADO_HISTORIAL";
        detalleFinal = `La UI de pendientes no confirmó a tiempo, pero Airtable/Historial registró la aprobación de ${empresa}.`;
      }
    }

    return {
      ok: okFinal,
      estado: estadoFinal,
      pendientesAntes,
      pendientesDespues,
      aprobados,
      errores,
      verificacionHistorial,
      detalle: detalleFinal
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

async function aprobarPendientesSimel(user, pass, options = {}) {
  return withTimeout(
    () => aprobarPendientesSimelInterno(user, pass, options),
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

function describirAprobacion(resultado) {
  const base = `Aprobacion: ${resultado.estado} (${resultado.aprobados || 0} aprobados)`;
  if (resultado.estado === "SIN_MANIFIESTO") {
    return `${base} → no había manifiestos pendientes.`;
  }
  if (resultado.estado === "APROBADO") {
    return `${base} → sin pendientes al final (${resultado.pendientesDespues} restantes).`;
  }
  if (resultado.estado === "PARCIAL") {
    return `${base} → antes ${resultado.pendientesAntes}, despues ${resultado.pendientesDespues}.`;
  }
  return `${base} → error: ${resultado.detalle || "sin detalle"}`;
}

if (require.main === module) {
  const user = process.env.SIMEL_USER;
  const pass = process.env.SIMEL_PASS;

  aprobarPendientesSimel(user, pass)
    .then((resultado) => {
      console.log("Resultado simel-approve:", JSON.stringify(resultado, null, 2));
      console.log(describirAprobacion(resultado));
    })
    .catch((err) => {
      console.error("Error general en aprobacion:", err);
      process.exit(1);
    });
}
