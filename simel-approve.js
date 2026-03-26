const { chromium } = require("playwright");

const SIMEL_LOGIN_URL = "https://simel.ambiente.gob.ar/me/login/login_usuario.php";

async function clickPrimerElementoDisponible(locators, timeout = 10000) {
  let ultimoError = null;

  for (const locator of locators) {
    try {
      await locator.waitFor({ state: "visible", timeout });
      await locator.click({ timeout });
      return true;
    } catch (error) {
      ultimoError = error;
    }
  }

  if (ultimoError) {
    throw ultimoError;
  }

  return false;
}

async function abrirPendientes(page) {
  const intentos = [
    page.getByRole("link", { name: /pendientes/i }).first(),
    page.getByRole("button", { name: /pendientes/i }).first(),
    page.locator("a, button, span, div").filter({ hasText: /^Pendientes$/i }).first(),
    page.getByText(/^Pendientes$/i).first()
  ];

  await clickPrimerElementoDisponible(intentos, 15000);
  await page.getByText(/MANIFIESTOS PENDIENTES/i).waitFor({ timeout: 30000 });
}

async function loginYEntrarAPendientes(page, user, pass) {
  await page.goto(SIMEL_LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.locator("input").nth(0).fill(user);
  await page.locator("input").nth(1).fill(pass);
  await page.getByRole("button", { name: /ingresar/i }).click();

  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
  await page.waitForTimeout(2000);
  await abrirPendientes(page);
}

async function contarFilasPendientes(page) {
  const sinResultados = await page
    .getByText(/No se han encontrado resultados\./i)
    .isVisible()
    .catch(() => false);

  if (sinResultados) return 0;

  const posiblesFilas = page.locator("table tbody tr");
  const total = await posiblesFilas.count();

  if (total > 0) return total;

  const filasGenericas = page.locator("tr");
  const totalGenerico = await filasGenericas.count();
  return totalGenerico > 1 ? totalGenerico - 1 : 0;
}

async function ejecutarAprobacion(page) {
  const botonesAprobacion = [
    page.getByRole("button", { name: /aprobar seleccionad/i }).first(),
    page.getByRole("button", { name: /^aprobar$/i }).first(),
    page.getByRole("button", { name: /aprobar/i }).first(),
    page.locator("input[type='submit'][value*='Aprobar' i]").first(),
    page.locator("input[type='button'][value*='Aprobar' i]").first(),
    page.locator("button, a, span, div").filter({ hasText: /aprobar/i }).first()
  ];

  await clickPrimerElementoDisponible(botonesAprobacion, 10000);

  const botonesConfirmacion = [
    page.getByRole("button", { name: /^confirmar$/i }).first(),
    page.getByRole("button", { name: /^aceptar$/i }).first(),
    page.getByRole("button", { name: /^si$/i }).first(),
    page.getByRole("button", { name: /^s[ií]$/i }).first(),
    page.locator("input[type='submit'][value*='Confirmar' i]").first(),
    page.locator("input[type='button'][value*='Confirmar' i]").first()
  ];

  try {
    await clickPrimerElementoDisponible(botonesConfirmacion, 3000);
  } catch {
    // No siempre hay segundo paso de confirmacion.
  }

  await page.waitForTimeout(2500);
}

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

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await loginYEntrarAPendientes(page, user, pass);

    const pendientesAntes = await contarFilasPendientes(page);

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

    await ejecutarAprobacion(page);
    const pendientesDespues = await contarFilasPendientes(page);
    const aprobados = Math.max(pendientesAntes - pendientesDespues, 0);
    const aprobadoCompleto = pendientesDespues === 0;

    return {
      ok: true,
      estado: aprobadoCompleto ? "APROBADO" : "PARCIAL",
      pendientesAntes,
      pendientesDespues,
      aprobados,
      detalle: aprobadoCompleto
        ? `Aprobacion automatica completada (${aprobados} manifiesto(s)).`
        : `Aprobacion parcial: antes ${pendientesAntes}, despues ${pendientesDespues}.`
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
    await browser.close();
  }
}

async function aprobarPendientesSimel(user, pass) {
  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("Timeout: SIMEL no respondio en 60 segundos durante aprobacion")),
      60000
    )
  );

  return Promise.race([aprobarPendientesSimelInterno(user, pass), timeout]).catch((err) => ({
    ok: false,
    estado: "ERROR",
    pendientesAntes: 0,
    pendientesDespues: 0,
    aprobados: 0,
    detalle: err.message
  }));
}

module.exports = { aprobarPendientesSimel };

