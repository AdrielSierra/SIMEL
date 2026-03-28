const { SimelClient, withTimeout, limpiarArchivoTemporal } = require("./simel-client");

async function listarPendientesSimelInterno(user, pass, { maxItems = 10 } = {}) {
  const client = await new SimelClient({ headless: true }).start();

  try {
    await client.loginYAbrirPendientes(user, pass);
    const { total, items } = await client.listarPendientes({ maxItems });
    return { ok: true, total, items };
  } catch (error) {
    return {
      ok: false,
      total: 0,
      items: [],
      error: error.message
    };
  } finally {
    await client.close();
  }
}

async function operarManifiestoSimelInterno(user, pass, { idOperacion, accion }) {
  const client = await new SimelClient({ headless: true }).start();

  try {
    await client.loginYAbrirPendientes(user, pass);
    return await client.operarManifiesto({ idOperacion, accion });
  } finally {
    await client.close();
  }
}

async function listarPendientesSimel(user, pass, options = {}) {
  return withTimeout(
    () => listarPendientesSimelInterno(user, pass, options),
    90000,
    "Timeout listando pendientes en SIMEL"
  ).catch((err) => ({
    ok: false,
    total: 0,
    items: [],
    error: err.message
  }));
}

async function operarManifiestoSimel(user, pass, payload) {
  return withTimeout(
    () => operarManifiestoSimelInterno(user, pass, payload),
    90000,
    "Timeout operando manifiesto en SIMEL"
  ).catch((err) => ({
    ok: false,
    accion: payload?.accion || "",
    idOperacion: payload?.idOperacion || "",
    error: err.message,
    screenshotAntes: "",
    screenshotError: ""
  }));
}

module.exports = {
  listarPendientesSimel,
  operarManifiestoSimel,
  limpiarArchivoTemporal
};
