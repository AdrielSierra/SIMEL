const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { chromium } = require('playwright');

async function checkSimel(user, pass) {
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

async function main() {
  const csvPath = path.resolve(__dirname, 'usuarios.csv');

  if (!fs.existsSync(csvPath)) {
    throw new Error('No existe usuarios.csv en la carpeta del proyecto');
  }

  const csvText = fs.readFileSync(csvPath, 'utf8');
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const resultados = [];
  const conManifiesto = [];
  const sinManifiesto = [];
  const conError = [];

  for (const row of records) {
    const usuario = row.usuario;
    const password = row.password;

    console.log(`Revisando ${usuario}...`);
    const resultado = await checkSimel(usuario, password);

    resultados.push(resultado);

    if (resultado.estado === 'CON_MANIFIESTO') {
      conManifiesto.push({
        usuario: resultado.usuario,
        estado: resultado.estado,
        detalle: resultado.detalle,
      });
    } else if (resultado.estado === 'SIN_MANIFIESTO') {
      sinManifiesto.push({
        usuario: resultado.usuario,
        estado: resultado.estado,
        detalle: resultado.detalle,
      });
    } else {
      conError.push({
        usuario: resultado.usuario,
        estado: resultado.estado,
        detalle: resultado.detalle,
      });
    }

    console.log(`${usuario}: ${resultado.estado}`);
  }

  const salida = [
    'usuario,ok,hayManifiesto,filas,estado,detalle,error',
    ...resultados.map((r) => {
      const detalle = String(r.detalle || '').replace(/"/g, '""');
      const error = String(r.error || '').replace(/"/g, '""');
      return `${r.usuario},${r.ok},${r.hayManifiesto},${r.filas},${r.estado},"${detalle}","${error}"`;
    }),
  ].join('\n');

  const outPath = path.resolve(__dirname, 'resultados.csv');
  fs.writeFileSync(outPath, salida, 'utf8');

  console.log('\n========================================');
  console.log('RESUMEN FINAL');
  console.log('========================================');

  console.log(`Con manifiesto: ${conManifiesto.length}`);
  conManifiesto.forEach((x) => console.log(`- ${x.usuario}`));

  console.log(`\nSin manifiesto: ${sinManifiesto.length}`);
  sinManifiesto.forEach((x) => console.log(`- ${x.usuario}`));

  console.log(`\nCon error: ${conError.length}`);
  conError.forEach((x) => console.log(`- ${x.usuario} -> ${x.detalle}`));

  console.log('========================================\n');

  console.log('Terminado.');
  console.log(`Resultados guardados en: ${outPath}`);
}

main().catch((err) => {
  console.error('Error general:', err);
  process.exit(1);
});