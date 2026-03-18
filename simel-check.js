const { chromium } = require('playwright');

async function checkSimel(user, pass) {
  if (!user || !pass) {
    return {
      ok: false,
      usuario: user || '',
      hayManifiesto: false,
      filas: 0,
      estado: 'ERROR',
      detalle: 'Faltan credenciales user/pass',
      error: 'Faltan credenciales user/pass',
    };
  }

  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage();

  try {
    await page.goto('https://simel.ambiente.gob.ar/me/login/login_usuario.php', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await page.locator('input').nth(0).fill(user);
    await page.locator('input').nth(1).fill(pass);
    await page.getByRole('button', { name: /ingresar/i }).click();

    await page.waitForLoadState('networkidle', { timeout: 60000 });

    await page.getByText(/^Pendientes$/i).first().click();
    await page.getByText(/MANIFIESTOS PENDIENTES/i).waitFor({ timeout: 30000 });

    const sinResultados = await page
      .getByText(/No se han encontrado resultados\./i)
      .isVisible()
      .catch(() => false);

    let hayManifiesto = false;
    let filas = 0;
    let estado = 'SIN_MANIFIESTO';
    let detalle = 'No se han encontrado resultados.';

    if (!sinResultados) {
      const posiblesFilas = page.locator('table tbody tr');
      const total = await posiblesFilas.count();

      if (total > 0) {
        hayManifiesto = true;
        filas = total;
      } else {
        const filasGenericas = page.locator('tr');
        const totalGenerico = await filasGenericas.count();
        if (totalGenerico > 1) {
          hayManifiesto = true;
          filas = totalGenerico - 1;
        }
      }

      if (hayManifiesto) {
        estado = 'CON_MANIFIESTO';
        detalle = `Se encontraron ${filas} fila(s) pendiente(s).`;
      }
    }

    return {
      ok: true,
      usuario: user,
      hayManifiesto,
      filas,
      estado,
      detalle,
      error: '',
    };
  } catch (error) {
    return {
      ok: false,
      usuario: user,
      hayManifiesto: false,
      filas: 0,
      estado: 'ERROR',
      detalle: error.message,
      error: error.message,
    };
  } finally {
    await browser.close();
  }
}

module.exports = { checkSimel };

if (require.main === module) {
  const user = process.env.SIMEL_USER;
  const pass = process.env.SIMEL_PASS;

  checkSimel(user, pass)
    .then((resultado) => {
      console.log(JSON.stringify(resultado, null, 2));
    })
    .catch((err) => {
      console.error('Error general:', err);
      process.exit(1);
    });
}
