const { chromium } = require("playwright");

const SIMEL_LOGIN_URL = "https://simel.ambiente.gob.ar/me/login/login_usuario.php";

async function clickPrimerElementoDisponible(locators, timeout = 12000) {
  let ultimoError = null;

  for (const locator of locators) {
    try {
      await locator.waitFor({ state: "visible", timeout });
      await locator.click({ timeout });
      return;
    } catch (error) {
      ultimoError = error;
    }
  }

  throw ultimoError || new Error("No se encontro un elemento clickeable.");
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

async function loginYAbrirPendientes(page, user, pass) {
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

async function extraerFilasPendientes(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("table tbody tr"));

    return rows
      .map((tr, idx) => {
        const celdas = Array.from(tr.querySelectorAll("td")).map((td) =>
          (td.textContent || "").replace(/\s+/g, " ").trim()
        );

        if (celdas.length < 6) return null;
        if (!/^\d+$/.test(celdas[0] || "")) return null;

        const botonVisualizar =
          tr.querySelector("td:last-child a, td:last-child button, td:last-child i");

        if (!botonVisualizar) return null;

        return {
          rowIndex: idx,
          idOperacion: celdas[0] || "",
          fechaCreacion: celdas[1] || "",
          empresaCreadora: celdas[2] || "",
          establecimientoCreador: celdas[3] || "",
          aprobadoPor: celdas[4] || ""
        };
      })
      .filter(Boolean);
  });
}

function parsearTabla(headers, rows) {
  return rows.map((row) => {
    const item = {};
    headers.forEach((h, i) => {
      item[h] = row[i] || "";
    });
    return item;
  });
}

async function extraerDetalleModal(page) {
  return page.evaluate(() => {
    const modal =
      document.querySelector(".modal.in .modal-content") ||
      document.querySelector(".modal.show .modal-content");

    if (!modal) return { residuos: [], transportistas: [], bloques: [] };

    const tablas = Array.from(modal.querySelectorAll("table")).map((table) => {
      const headers = Array.from(table.querySelectorAll("thead th, tr:first-child th")).map((th) =>
        (th.textContent || "").replace(/\s+/g, " ").trim()
      );

      const bodyRows = Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) =>
          (td.textContent || "").replace(/\s+/g, " ").trim()
        )
      );

      const rows = bodyRows.filter((r) => r.some((x) => x));

      let titulo = "";
      let prev = table.previousElementSibling;
      while (prev && !titulo) {
        const t = (prev.textContent || "").replace(/\s+/g, " ").trim();
        if (t) titulo = t;
        prev = prev.previousElementSibling;
      }

      return { titulo, headers, rows };
    });

    return { tablas };
  });
}

function normalizarTexto(v = "") {
  return String(v)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function mapearDetalle(detalleCrudo) {
  const tablas = detalleCrudo?.tablas || [];

  let residuos = [];
  let transportistas = [];

  for (const tabla of tablas) {
    const headers = (tabla.headers || []).map((h) => normalizarTexto(h));
    const titulo = normalizarTexto(tabla.titulo || "");

    if (headers.some((h) => h.includes("residuo"))) {
      const parsed = parsearTabla(tabla.headers, tabla.rows || []);
      residuos = parsed.map((r) => ({
        residuo: r["Residuo"] || r["Residuo(s)"] || "",
        cantidadEst: r["Cantidad Est."] || r["Cantidad Est"] || "",
        unidad: r["Unidad"] || "",
        estado: r["Estado"] || "",
        tipoContenedor: r["Tipo Cont."] || r["Tipo Cont"] || ""
      }));
    }

    if (
      titulo.includes("transportistas") ||
      (headers.includes("estado") && headers.includes("nombre") && headers.includes("cuit"))
    ) {
      const parsed = parsearTabla(tabla.headers, tabla.rows || []);
      const mapped = parsed.map((r) => ({
        nombre: r["Nombre"] || "",
        cuit: r["Cuit"] || "",
        estado: r["Estado"] || "",
        expediente: r["Expediente"] || ""
      }));
      if (mapped.length) {
        transportistas = mapped;
      }
    }
  }

  return { residuos, transportistas };
}

async function abrirDetallePorIndice(page, indice) {
  await page
    .locator('.modal[aria-hidden="false"], .modal.in, .modal.show')
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {});

  const filas = page.locator("table tbody tr");
  const fila = filas.nth(indice);
  const celdaVisualizar = fila.locator("td").nth(5);
  const boton = celdaVisualizar.locator("a, button, i").first();

  await boton.waitFor({ state: "visible", timeout: 10000 });
  await boton.click({ timeout: 10000, force: true });

  const modal = page.locator(".modal-content").filter({ hasText: /Informaci.n del Manifiesto|Residuos/i }).first();
  await modal.waitFor({ state: "visible", timeout: 15000 });
}

async function cerrarModal(page) {
  const modalVisible = page.locator('.modal[aria-hidden="false"], .modal.in, .modal.show').last();

  if (!await modalVisible.count()) return;

  const intentos = [
    modalVisible.locator("button.close, .close").first(),
    modalVisible.getByRole("button", { name: /cancelar/i }).first()
  ];

  for (const intento of intentos) {
    try {
      if (await intento.count()) {
        await intento.click({ timeout: 3000, force: true });
        break;
      }
    } catch {
      // no-op
    }
  }

  await page.keyboard.press("Escape").catch(() => {});
  await page
    .locator('.modal[aria-hidden="false"], .modal.in, .modal.show')
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
  await page.waitForTimeout(500);
}

async function listarPendientesSimelInterno(user, pass, { maxItems = 10 } = {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await loginYAbrirPendientes(page, user, pass);
    const filas = await extraerFilasPendientes(page);
    const seleccion = filas.slice(0, maxItems);
    const items = [];

    for (let i = 0; i < seleccion.length; i++) {
      const fila = seleccion[i];
      await abrirDetallePorIndice(page, fila.rowIndex);

      const detalleCrudo = await extraerDetalleModal(page);
      const detalle = mapearDetalle(detalleCrudo);

      items.push({
        ...fila,
        residuos: detalle.residuos,
        transportistas: detalle.transportistas
      });

      await cerrarModal(page);
      await page.waitForTimeout(300);
    }

    return {
      ok: true,
      total: filas.length,
      items
    };
  } catch (error) {
    return {
      ok: false,
      total: 0,
      items: [],
      error: error.message
    };
  } finally {
    await browser.close();
  }
}

async function clickAccionEnModal(page, accion) {
  const regex =
    accion === "ACEPTAR"
      ? /^Aceptar$/i
      : accion === "RECHAZAR"
        ? /^Rechazar$/i
        : /^Cancelar$/i;

  const boton = page.getByRole("button", { name: regex }).first();
  await boton.waitFor({ state: "visible", timeout: 10000 });
  await boton.click({ timeout: 10000 });

  if (accion !== "CANCELAR") {
    const confirmadores = [
      page.getByRole("button", { name: /^Confirmar$/i }).first(),
      page.getByRole("button", { name: /^Aceptar$/i }).first(),
      page.getByRole("button", { name: /^Si$/i }).first(),
      page.getByRole("button", { name: /^S[ií]$/i }).first()
    ];

    for (const c of confirmadores) {
      try {
        await c.waitFor({ state: "visible", timeout: 1500 });
        await c.click({ timeout: 1500 });
        break;
      } catch {
        // no-op
      }
    }
  }
}

async function operarManifiestoSimelInterno(user, pass, { idOperacion, accion }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await loginYAbrirPendientes(page, user, pass);
    const filas = await extraerFilasPendientes(page);
    const objetivo = filas.find((f) => f.idOperacion === String(idOperacion));

    if (!objetivo) {
      return {
        ok: false,
        accion,
        idOperacion,
        error: `No se encontro el manifiesto ${idOperacion} en pendientes.`
      };
    }

    await abrirDetallePorIndice(page, objetivo.rowIndex);
    await clickAccionEnModal(page, accion);
    await page.waitForTimeout(2500);

    const textoPagina = await page.locator("body").innerText().catch(() => "");
    const aprobado = /manifiesto aprobado/i.test(textoPagina);
    const rechazado = /manifiesto rechazado/i.test(textoPagina);

    return {
      ok: true,
      accion,
      idOperacion,
      confirmadoUI: accion === "ACEPTAR" ? aprobado : accion === "RECHAZAR" ? rechazado : true
    };
  } catch (error) {
    return {
      ok: false,
      accion,
      idOperacion,
      error: error.message
    };
  } finally {
    await browser.close();
  }
}

async function listarPendientesSimel(user, pass, options = {}) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout listando pendientes en SIMEL")), 90000)
  );

  return Promise.race([listarPendientesSimelInterno(user, pass, options), timeout]).catch((err) => ({
    ok: false,
    total: 0,
    items: [],
    error: err.message
  }));
}

async function operarManifiestoSimel(user, pass, payload) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout operando manifiesto en SIMEL")), 90000)
  );

  return Promise.race([operarManifiestoSimelInterno(user, pass, payload), timeout]).catch((err) => ({
    ok: false,
    accion: payload?.accion || "",
    idOperacion: payload?.idOperacion || "",
    error: err.message
  }));
}

module.exports = {
  listarPendientesSimel,
  operarManifiestoSimel
};
