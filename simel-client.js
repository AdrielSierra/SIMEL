const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const SIMEL_LOGIN_URL = "https://simel.ambiente.gob.ar/me/login/login_usuario.php";

function normalizarTexto(v = "") {
  return String(v)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function valorPorHeader(row = {}, aliases = []) {
  for (const alias of aliases) {
    if (row[alias] !== undefined && row[alias] !== null && String(row[alias]).trim()) {
      return row[alias];
    }
  }
  return "";
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

function limpiarArchivoTemporal(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // no-op
  }
}

async function guardarScreenshotTemporal(page, nombreBase) {
  const nombreSeguro = String(nombreBase || "simel")
    .replace(/[^a-zA-Z0-9-_]/g, "_")
    .slice(0, 80);
  const filePath = path.join(os.tmpdir(), `${Date.now()}_${nombreSeguro}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

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

class SimelClient {
  constructor({ headless = true } = {}) {
    this.headless = headless;
    this.browser = null;
    this.page = null;
  }

  async start() {
    this.browser = await chromium.launch({ headless: this.headless });
    this.page = await this.browser.newPage();
    return this;
  }

  async close() {
    if (this.browser) await this.browser.close();
  }

  async login(user, pass) {
    if (!user || !pass) throw new Error("Faltan credenciales user/pass");

    await this.page.goto(SIMEL_LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await this.page.locator("#usuario, input[name='usuario']").first().fill(user);
    await this.page.locator("#contrasenia, input[name='contrasenia']").first().fill(pass);
    await this.page.getByRole("button", { name: /ingresar/i }).click();
    await this.page.waitForLoadState("domcontentloaded", { timeout: 60000 });
    await this.page.waitForTimeout(2000);
  }

  async abrirPendientes() {
    const intentos = [
      this.page.getByRole("link", { name: /pendientes/i }).first(),
      this.page.getByRole("button", { name: /pendientes/i }).first(),
      this.page.locator("a, button, span, div").filter({ hasText: /^Pendientes$/i }).first(),
      this.page.getByText(/^Pendientes$/i).first()
    ];

    await clickPrimerElementoDisponible(intentos, 15000);
    await this.page.getByText(/MANIFIESTOS PENDIENTES/i).waitFor({ timeout: 30000 });
  }

  async loginYAbrirPendientes(user, pass) {
    await this.login(user, pass);
    await this.abrirPendientes();
  }

  async sinResultadosPendientes() {
    return this.page
      .getByText(/No se han encontrado resultados\./i)
      .isVisible()
      .catch(() => false);
  }

  async extraerFilasPendientes() {
    return this.page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows
        .map((tr, idx) => {
          const celdas = Array.from(tr.querySelectorAll("td")).map((td) =>
            (td.textContent || "").replace(/\s+/g, " ").trim()
          );

          if (celdas.length < 6) return null;
          if (!/^\d+$/.test(celdas[0] || "")) return null;

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

  async refrescarPendientes() {
    const botonBuscar = this.page.getByRole("button", { name: /buscar/i }).first();
    try {
      if (await botonBuscar.isVisible({ timeout: 2000 })) {
        await botonBuscar.click({ timeout: 5000 });
        await this.page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
        await this.page.waitForTimeout(1500);
        return;
      }
    } catch {
      // no-op
    }

    await this.page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await this.page.waitForTimeout(2000);
    await this.abrirPendientes().catch(() => {});
  }

  async contarPendientes() {
    const sinResultados = await this.sinResultadosPendientes();
    if (sinResultados) return 0;
    const filas = await this.extraerFilasPendientes();
    return filas.length;
  }

  async abrirDetallePorIndice(indice) {
    await this.page
      .locator('.modal[aria-hidden="false"], .modal.in, .modal.show')
      .waitFor({ state: "hidden", timeout: 5000 })
      .catch(() => {});

    const fila = this.page.locator("table tbody tr").nth(indice);
    const boton = fila
      .locator("td")
      .nth(5)
      .locator("div.btn_operar_manifiesto, a, button, i.fa-search")
      .first();

    await boton.waitFor({ state: "visible", timeout: 10000 });
    await boton.click({ timeout: 10000, force: true });

    const modal = this.page.locator(".modal-content").filter({ hasText: /Informaci.n del Manifiesto|Residuos/i }).first();
    await modal.waitFor({ state: "visible", timeout: 15000 });
  }

  async extraerDetalleModal() {
    const detalleCrudo = await this.page.evaluate(() => {
      const modal =
        document.querySelector(".modal.in .modal-content") ||
        document.querySelector(".modal.show .modal-content");

      if (!modal) return { tablas: [] };

      const tablas = Array.from(modal.querySelectorAll("table")).map((table) => {
        let headers = Array.from(table.querySelectorAll("thead th, thead td")).map((th) =>
          (th.textContent || "").replace(/\s+/g, " ").trim()
        );

        if (!headers.length) {
          headers = Array.from(table.querySelectorAll("tr:first-child th, tr:first-child td")).map((th) =>
            (th.textContent || "").replace(/\s+/g, " ").trim()
          );
        }

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
          const esTitulo =
            prev.matches?.("p, .bg-info, .bg-danger, .bg-primary, .headerPopup") ||
            /transportistas|residuos|vehiculos|operador|generadores|informacion/i.test(t);
          if (t && esTitulo) titulo = t;
          prev = prev.previousElementSibling;
        }

        return { titulo, headers, rows };
      });

      return { tablas };
    });

    const tablas = detalleCrudo?.tablas || [];
    let residuos = [];
    let transportistas = [];

    for (const tabla of tablas) {
      const headers = (tabla.headers || []).map((h) => normalizarTexto(h));
      const titulo = normalizarTexto(tabla.titulo || "");

      if (headers.some((h) => h.includes("residuo"))) {
        const parsed = parsearTabla(tabla.headers, tabla.rows || []);
        residuos = parsed.map((r, idx) => {
          const raw = tabla.rows?.[idx] || [];
          return {
            tipoContenedor: valorPorHeader(r, ["Tipo Cont.", "Tipo Cont"]) || raw[0] || "",
            residuo: valorPorHeader(r, ["Residuo", "Residuo(s)"]) || raw[2] || "",
            cantidadEst: valorPorHeader(r, ["Cantidad Est.", "Cantidad Est"]) || raw[3] || "",
            unidad: valorPorHeader(r, ["Unidad"]) || raw[4] || "",
            estado: valorPorHeader(r, ["Estado"]) || raw[5] || ""
          };
        });
      }

      if (
        titulo.includes("transportistas") ||
        (headers.includes("estado") && headers.includes("nombre") && headers.includes("cuit"))
      ) {
        const parsed = parsearTabla(tabla.headers, tabla.rows || []);
        const mapped = parsed.map((r, idx) => {
          const raw = tabla.rows?.[idx] || [];
          return {
            estado: valorPorHeader(r, ["Estado"]) || raw[0] || "",
            nombre: valorPorHeader(r, ["Nombre"]) || raw[1] || "",
            expediente: valorPorHeader(r, ["Expediente"]) || raw[3] || "",
            cuit: valorPorHeader(r, ["Cuit", "CUIT"]) || raw[4] || ""
          };
        });
        if (mapped.length) transportistas = mapped;
      }
    }

    return { residuos, transportistas };
  }

  async cerrarModal() {
    const modalVisible = this.page.locator('.modal[aria-hidden="false"], .modal.in, .modal.show').last();
    if (!await modalVisible.count()) return;

    const intentos = [
      modalVisible.locator('button[data-dismiss="modal"]').filter({ hasText: /cancelar/i }).first(),
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

    await this.page.keyboard.press("Escape").catch(() => {});
    await this.page
      .locator('.modal[aria-hidden="false"], .modal.in, .modal.show')
      .waitFor({ state: "hidden", timeout: 8000 })
      .catch(() => {});
    await this.page.waitForTimeout(500);
  }

  async listarPendientes({ maxItems = 10 } = {}) {
    const filas = await this.extraerFilasPendientes();
    const seleccion = filas.slice(0, maxItems);
    const items = [];

    for (const fila of seleccion) {
      await this.abrirDetallePorIndice(fila.rowIndex);
      const detalle = await this.extraerDetalleModal();
      items.push({ ...fila, residuos: detalle.residuos, transportistas: detalle.transportistas });
      await this.cerrarModal();
      await this.page.waitForTimeout(300);
    }

    return { total: filas.length, items };
  }

  async operarManifiesto({ idOperacion, accion }) {
    const filas = await this.extraerFilasPendientes();
    const objetivo = filas.find((f) => f.idOperacion === String(idOperacion));

    if (!objetivo) {
      return {
        ok: false,
        accion,
        idOperacion,
        estadoVerificacion: "NO_ENCONTRADO_EN_PENDIENTES",
        error: `No se encontro el manifiesto ${idOperacion} en pendientes.`
      };
    }

    await this.abrirDetallePorIndice(objetivo.rowIndex);
    const screenshotAntes = await guardarScreenshotTemporal(this.page, `simel_previo_${accion}_${idOperacion}`).catch(() => "");

    try {
      const modalVisible = this.page.locator('.modal[aria-hidden="false"], .modal.in, .modal.show').last();
      const selectores =
        accion === "ACEPTAR"
          ? [
              modalVisible.locator('button[id^="btn_aceptar_"]').first(),
              modalVisible.getByRole("button", { name: /^Aceptar$/i }).first()
            ]
          : [
              modalVisible.locator('button[id^="btn_rechazar_"]').first(),
              modalVisible.getByRole("button", { name: /^Rechazar$/i }).first()
            ];

      await clickPrimerElementoDisponible(selectores, 10000);

      const confirmadores = [
        this.page.getByRole("button", { name: /^Confirmar$/i }).first(),
        this.page.getByRole("button", { name: /^Aceptar$/i }).first(),
        this.page.getByRole("button", { name: /^Si$/i }).first(),
        this.page.getByRole("button", { name: /^S[ií]$/i }).first()
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

      await this.page.waitForTimeout(2500);
      const pendientesAntesRefresh = await this.contarPendientes();
      const siguePresenteAntesRefresh = (await this.extraerFilasPendientes()).some((f) => f.idOperacion === String(idOperacion));
      const textoPagina = await this.page.locator("body").innerText().catch(() => "");
      const confirmacionTexto = accion === "ACEPTAR"
        ? /manifiesto aprobado|aprobado/i.test(textoPagina)
        : /manifiesto rechazado|rechazado/i.test(textoPagina);

      let pendientesDespues = pendientesAntesRefresh;
      let siguePresente = siguePresenteAntesRefresh;

      if (confirmacionTexto || siguePresenteAntesRefresh) {
        await this.refrescarPendientes().catch(() => {});
        pendientesDespues = await this.contarPendientes();
        siguePresente = (await this.extraerFilasPendientes()).some((f) => f.idOperacion === String(idOperacion));
      }

      const confirmadoUI = confirmacionTexto || !siguePresente;

      return {
        ok: confirmadoUI,
        accion,
        idOperacion,
        estadoVerificacion: confirmadoUI ? "CONFIRMADO_EN_PENDIENTES" : "NO_CONFIRMADO",
        confirmadoUI,
        pendientesAntesRefresh,
        pendientesDespues,
        screenshotAntes,
        error: confirmadoUI ? "" : `No pude confirmar por UI que ${idOperacion} fue ${accion.toLowerCase()}.`
      };
    } catch (error) {
      const screenshotError = await guardarScreenshotTemporal(this.page, `simel_error_${accion}_${idOperacion}`).catch(() => "");
      return {
        ok: false,
        accion,
        idOperacion,
        error: error.message,
        screenshotAntes,
        screenshotError
      };
    }
  }
}

async function withTimeout(promiseFactory, ms, onTimeoutMessage) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(onTimeoutMessage)), ms)
  );
  return Promise.race([promiseFactory(), timeout]);
}

module.exports = {
  SimelClient,
  withTimeout,
  limpiarArchivoTemporal,
  guardarScreenshotTemporal,
  normalizarTexto
};
