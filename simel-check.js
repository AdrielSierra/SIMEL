require("./env-loader");

const { SimelClient, withTimeout } = require("./simel-client");

async function checkSimelInterno(user, pass) {
  if (!user || !pass) {
    return {
      ok: false,
      usuario: user || "",
      hayManifiesto: false,
      filas: 0,
      estado: "ERROR",
      detalle: "Faltan credenciales user/pass",
      error: "Faltan credenciales user/pass"
    };
  }

  const client = await new SimelClient({ headless: true }).start();

  try {
    await client.loginYAbrirPendientes(user, pass);
    const filas = await client.contarPendientes();
    const hayManifiesto = filas > 0;

    return {
      ok: true,
      usuario: user,
      hayManifiesto,
      filas,
      estado: hayManifiesto ? "CON_MANIFIESTO" : "SIN_MANIFIESTO",
      detalle: hayManifiesto
        ? `Se encontraron ${filas} fila(s) pendiente(s).`
        : "No se han encontrado resultados.",
      error: ""
    };
  } catch (error) {
    return {
      ok: false,
      usuario: user,
      hayManifiesto: false,
      filas: 0,
      estado: "ERROR",
      detalle: error.message,
      error: error.message
    };
  } finally {
    await client.close();
  }
}

async function checkSimel(user, pass) {
  return withTimeout(
    () => checkSimelInterno(user, pass),
    45000,
    "Timeout: SIMEL no respondió en 45 segundos"
  ).catch((err) => ({
    ok: false,
    usuario: user || "",
    hayManifiesto: false,
    filas: 0,
    estado: "ERROR",
    detalle: err.message,
    error: err.message
  }));
}

module.exports = { checkSimel };

function describirResultado(resultado) {
  const base = `${resultado.usuario || "[sin usuario]"} → ${resultado.estado}`;
  if (resultado.estado === "SIN_MANIFIESTO") {
    return `${base}: sin manifiestos (${resultado.filas || 0} filas)`;
  }
  if (resultado.estado === "CON_MANIFIESTO") {
    return `${base}: ${resultado.filas || 0} manifiesto(s) pendientes`;
  }
  return `${base}: error -> ${resultado.detalle || resultado.error || "sin detalle"}`;
}

if (require.main === module) {
  const user = process.env.SIMEL_USER;
  const pass = process.env.SIMEL_PASS;

  checkSimel(user, pass)
    .then((resultado) => {
      console.log("Resultado simel-check:", JSON.stringify(resultado, null, 2));
      console.log(describirResultado(resultado));
    })
    .catch((err) => {
      console.error("Error general:", err);
      process.exit(1);
    });
}
