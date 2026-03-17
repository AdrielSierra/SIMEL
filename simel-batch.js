const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { chromium } = require('playwright');

const rl = readline.createInterface({ input, output });

const URL_LOGIN = 'https://simel.ambiente.gob.ar/me/login/login_usuario.php';

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function preguntarSiNo(texto) {
  while (true) {
    const r = normalizeText(await rl.question(`${texto} (s/n): `)).toLowerCase();
    if (['s', 'si', 'sí'].includes(r)) return true;
    if (['n', 'no'].includes(r)) return false;
    console.log('Respuesta inválida. Escribí s o n.');
  }
}

async function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickSiVisible(locator, timeout = 2000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    await locator.click();
    return true;
  } catch {
    return false;
  }
}

async function existeVisible(locator, timeout = 1500) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function detectarLoginInvalido(page) {
  const textoPagina = normalizeText(await page.locator('body').innerText().catch(() => ''));
  const sigueEnLogin = /login_usuario\.php/i.test(page.url());

  if (/Usuario o contraseñ[ao] incorrectas/i.test(textoPagina)) {
    return {
      hayError: true,
      codigo: 'USUARIO_O_PASSWORD_INCORRECTO',
      detalle: 'Usuario o contraseña incorrectos.',
      estado: 'USUARIO_O_PASSWORD_INCORRECTO',
    };
  }

  const botonIngresarVisible = await existeVisible(
    page.getByRole('button', { name: /ingresar/i }).first(),
    1200
  );

  if (sigueEnLogin && botonIngresarVisible) {
    return {
      hayError: true,
      codigo: 'USUARIO_O_PASSWORD_INCORRECTO',
      detalle: 'No se pudo iniciar sesión. El sistema permaneció en login.',
      estado: 'USUARIO_O_PASSWORD_INCORRECTO',
    };
  }

  return {
    hayError: false,
    codigo: '',
    detalle: '',
    estado: '',
  };
}

async function detectarErrorOperativoInicial(page) {
  const pendientesVisible = await page.getByText(/^Pendientes$/i).first().isVisible().catch(() => false);
  const enProcesoVisible = await page.getByText(/^En Proceso$/i).first().isVisible().catch(() => false);
  const historialVisible = await page.getByText(/^Historial$/i).first().isVisible().catch(() => false);

  const textoPagina = normalizeText(await page.locator('body').innerText().catch(() => ''));

  if (!pendientesVisible && !enProcesoVisible && historialVisible) {
    if (/CAA .*vencid/i.test(textoPagina)) {
      return {
        hayError: true,
        codigo: 'CAA_VENCIDO',
        detalle: 'No aparece la pestaña Pendientes; solo Historial. El CAA está vencido.',
      };
    }

    if (/Certificado:\s*No disponible/i.test(textoPagina)) {
      return {
        hayError: true,
        codigo: 'CERTIFICADO_NO_DISPONIBLE',
        detalle: 'No aparece la pestaña Pendientes; solo Historial. El certificado no está disponible.',
      };
    }

    return {
      hayError: true,
      codigo: 'SIN_PENDIENTES_SOLO_HISTORIAL',
      detalle: 'No aparece la pestaña Pendientes; solo está visible Historial.',
    };
  }

  return {
    hayError: false,
    codigo: '',
    detalle: '',
  };
}

async function clickPendientes(page) {
  const pendientesTab = page.getByText(/^Pendientes$/i).first();
  const visible = await pendientesTab.isVisible().catch(() => false);

  if (!visible) {
    throw new Error('No se encontró la pestaña Pendientes.');
  }

  await pendientesTab.click();
  await page.getByText(/MANIFIESTOS PENDIENTES/i).waitFor({ timeout: 10000 });
}

async function clickEnProceso(page) {
  const enProcesoTab = page.getByText(/^En Proceso$/i).first();
  const visible = await enProcesoTab.isVisible().catch(() => false);

  if (!visible) {
    throw new Error('No se encontró la pestaña En Proceso.');
  }

  await enProcesoTab.click();
  await page.getByText(/MANIFIESTOS EN PROCESO/i).waitFor({ timeout: 10000 });
}

async function hayMensajeSinResultados(page) {
  return await page
    .getByText(/No se han encontrado resultados\./i)
    .first()
    .isVisible()
    .catch(() => false);
}

async function obtenerPrimeraFilaPendiente(page) {
  const tabla = page.locator('table').filter({ hasText: /Id Operación|Fecha creación|Visualizar/i }).first();
  const filas = tabla.locator('tbody tr');
  const total = await filas.count();

  if (total === 0) return null;

  for (let idx = 0; idx < total; idx++) {
    const fila = filas.nth(idx);
    const textoFila = normalizeText(await fila.innerText().catch(() => ''));

    if (!textoFila || /No se han encontrado resultados/i.test(textoFila)) {
      continue;
    }

    const celdas = fila.locator('td');
    const count = await celdas.count();
    if (count < 2) continue;

    const datos = [];
    for (let i = 0; i < count; i++) {
      datos.push(normalizeText(await celdas.nth(i).innerText().catch(() => '')));
    }

    return {
      locator: fila,
      idOperacion: datos[0] || '',
      fechaCreacion: datos[1] || '',
      empCreador: datos[2] || '',
      estCreador: datos[3] || '',
      aprobadoPor: datos[4] || '',
    };
  }

  return null;
}

async function abrirModalDeFila(fila) {
  const ultimaCelda = fila.locator('td').last();

  const candidatos = [
    ultimaCelda.locator('a').first(),
    ultimaCelda.locator('button').first(),
    ultimaCelda.locator('i').first(),
    ultimaCelda.locator('svg').first(),
  ];

  for (const c of candidatos) {
    if (await c.count().catch(() => 0)) {
      try {
        await c.click({ timeout: 5000 });
        return;
      } catch {}
    }
  }

  throw new Error('No se pudo hacer click en Visualizar.');
}

async function obtenerModal(page) {
  await page.getByText(/OPERAR CON EL MANIFIESTO SELECCIONADO/i).waitFor({ timeout: 20000 });

  const modal = page.locator('.modal-content').filter({
    hasText: /OPERAR CON EL MANIFIESTO SELECCIONADO/i,
  }).last();

  await modal.waitFor({ state: 'visible', timeout: 20000 });
  return modal;
}

async function extraerDatosDelModal(modal) {
  return await modal.evaluate((root) => {
    function limpiar(txt) {
      return String(txt || '').replace(/\s+/g, ' ').trim();
    }

    function toRows(table) {
      const headers = Array.from(table.querySelectorAll('th')).map((x) => limpiar(x.innerText));
      const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => limpiar(td.innerText))
      );
      return { headers, rows };
    }

    const texto = limpiar(root.innerText);
    const tablas = Array.from(root.querySelectorAll('table')).map(toRows);

    let generador = {};
    let residuos = [];

    for (const t of tablas) {
      const headersLower = t.headers.map((x) => x.toLowerCase());

      const esTablaGenerador =
        headersLower.includes('nombre') &&
        headersLower.includes('domicilio') &&
        headersLower.includes('expediente') &&
        headersLower.includes('cuit');

      if (esTablaGenerador && t.rows.length > 0) {
        const row = t.rows[0] || [];
        const posibleNombre = row[1] || '';
        const posibleCuit = row[4] || '';

        if (posibleNombre || posibleCuit) {
          generador = {
            estado: row[0] || '',
            nombre: row[1] || '',
            domicilio: row[2] || '',
            expediente: row[3] || '',
            cuit: row[4] || '',
            caa: row[5] || '',
          };
          break;
        }
      }
    }

    for (const t of tablas) {
      const headersLower = t.headers.map((x) => x.toLowerCase());

      const esTablaResiduos =
        headersLower.some((x) => x.includes('residuo')) &&
        headersLower.some((x) => x.includes('cantidad est'));

      if (esTablaResiduos) {
        residuos = t.rows.map((r) => ({
          tipoContenedor: r[0] || '',
          cantidadContenedores: r[1] || '',
          csc: r[2] || '',
          cantidadKg: r[3] || '',
          unidad: r[4] || '',
          estado: r[5] || '',
          descripcion: r[0] || '',
        }));
        break;
      }
    }

    const fechaCreacionMatch = texto.match(/Fecha de Creación\s+([0-9/:\-\s]+)/i);

    return {
      fechaCreacion: limpiar(fechaCreacionMatch?.[1] || ''),
      generador,
      residuos,
      textoCompleto: texto,
    };
  });
}

function imprimirManifiestoEnConsola(empresa, usuario, fila, modalData) {
  console.log('\n==================================================');
  console.log(`EMPRESA CSV: ${empresa}`);
  console.log(`USUARIO: ${usuario}`);
  console.log('MANIFIESTO ENCONTRADO');
  console.log('==================================================');
  console.log(`Id operación: ${fila.idOperacion}`);
  console.log(`Fecha creación (tabla): ${fila.fechaCreacion}`);
  console.log(`Emp. creador: ${fila.empCreador}`);
  console.log(`Est. creador: ${fila.estCreador}`);
  console.log(`Aprobado por: ${fila.aprobadoPor}`);

  if (modalData.fechaCreacion) {
    console.log(`Fecha creación (modal): ${modalData.fechaCreacion}`);
  }

  if (modalData.generador?.nombre || modalData.generador?.cuit) {
    console.log('\nDatos del generador:');
    console.log(`- Nombre: ${modalData.generador.nombre || ''}`);
    console.log(`- CUIT: ${modalData.generador.cuit || ''}`);
    console.log(`- Domicilio: ${modalData.generador.domicilio || ''}`);
    console.log(`- Expediente: ${modalData.generador.expediente || ''}`);
    console.log(`- CAA: ${modalData.generador.caa || ''}`);
  }

  console.log('\nResiduos:');
  if (!modalData.residuos.length) {
    console.log('- No se pudieron leer residuos del modal.');
  } else {
    modalData.residuos.forEach((r, i) => {
      console.log(`  Residuo ${i + 1}`);
      console.log(`  - CSC: ${r.csc}`);
      console.log(`  - Descripción: ${r.descripcion}`);
      console.log(`  - Cantidad kg: ${r.cantidadKg} ${r.unidad}`.trim());
      console.log(`  - Tipo contenedor: ${r.tipoContenedor}`);
      console.log(`  - Cant. contenedores: ${r.cantidadContenedores}`);
      console.log(`  - Estado: ${r.estado}`);
    });
  }

  console.log('==================================================\n');
}

async function cancelarModal(modal) {
  const botonCancelar = modal.getByRole('button', { name: /^Cancelar$/i }).last();
  if (await botonCancelar.isVisible().catch(() => false)) {
    await botonCancelar.click();
    await modal.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    return true;
  }

  const botonCerrar = modal.locator('button.close, .close').first();
  if (await botonCerrar.isVisible().catch(() => false)) {
    await botonCerrar.click().catch(() => {});
    await modal.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    return true;
  }

  return false;
}

async function aceptarManifiesto(page, modal) {
  const botonAceptar = modal.getByRole('button', { name: /^Aceptar$/i }).last();
  const visible = await botonAceptar.isVisible().catch(() => false);

  if (!visible) {
    throw new Error('No se encontró el botón Aceptar en el modal.');
  }

  await botonAceptar.click({ timeout: 10000 });

  await Promise.race([
    page.waitForURL(/manifiestos_proceso\.php/i, { timeout: 30000 }).catch(() => null),
    page.getByText(/MANIFIESTOS EN PROCESO/i).waitFor({ timeout: 30000 }).catch(() => null),
    page.getByText(/Manifiesto Aprobado/i).waitFor({ timeout: 30000 }).catch(() => null),
  ]);

  await page.waitForTimeout(4000);
}

async function procesarUsuario(empresa, user, pass) {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 250,
  });

  const page = await browser.newPage();

  const resultadoBase = {
    ok: true,
    empresa,
    usuario: user,
    estado: 'SIN_MANIFIESTO',
    detalle: '',
    error: '',
    manifiestosDetectados: 0,
    manifiestosAprobados: 0,
    manifiestosNoAprobados: 0,
    residuosResumen: [],
    manifiestosPendientesInfo: [],
  };

  try {
    await page.goto(URL_LOGIN, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await page.locator('input').nth(0).fill(user);
    await page.locator('input').nth(1).fill(pass);
    await page.getByRole('button', { name: /ingresar/i }).click();

    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await esperar(2500);

    const loginInvalido = await detectarLoginInvalido(page);
    if (loginInvalido.hayError) {
      return {
        ...resultadoBase,
        ok: false,
        estado: loginInvalido.estado,
        detalle: loginInvalido.detalle,
        error: loginInvalido.codigo,
      };
    }

    const errorInicial = await detectarErrorOperativoInicial(page);
    if (errorInicial.hayError) {
      return {
        ...resultadoBase,
        ok: false,
        estado: 'ERROR',
        detalle: errorInicial.detalle,
        error: errorInicial.codigo,
      };
    }

    await clickPendientes(page);

    let guard = 0;
    const resultado = { ...resultadoBase };

    while (guard < 20) {
      guard++;

      const sinResultados = await hayMensajeSinResultados(page);
      if (sinResultados) {
        if (resultado.manifiestosAprobados > 0) {
          resultado.estado = 'APROBADO_Y_SIN_PENDIENTES';
          resultado.detalle = `Se aprobaron ${resultado.manifiestosAprobados} manifiesto(s).`;
        } else {
          resultado.estado = 'SIN_MANIFIESTO';
          resultado.detalle = 'No se han encontrado resultados.';
        }
        break;
      }

      const fila = await obtenerPrimeraFilaPendiente(page);
      if (!fila) {
        if (resultado.manifiestosAprobados > 0) {
          resultado.estado = 'APROBADO_Y_SIN_PENDIENTES';
          resultado.detalle = `Se aprobaron ${resultado.manifiestosAprobados} manifiesto(s).`;
        } else {
          resultado.estado = 'SIN_MANIFIESTO';
          resultado.detalle = 'No se encontraron filas válidas en pendientes.';
        }
        break;
      }

      resultado.manifiestosDetectados++;

      await abrirModalDeFila(fila.locator);
      const modal = await obtenerModal(page);
      const modalData = await extraerDatosDelModal(modal);

      imprimirManifiestoEnConsola(empresa, user, fila, modalData);

      resultado.residuosResumen.push(
        ...modalData.residuos.map((r) => ({
          idOperacion: fila.idOperacion,
          csc: r.csc,
          descripcion: r.descripcion,
          cantidadKg: r.cantidadKg,
          unidad: r.unidad,
        }))
      );

      const aceptar = await preguntarSiNo(
        `¿Querés aceptar el manifiesto ${fila.idOperacion} de ${empresa}?`
      );

      if (!aceptar) {
        resultado.manifiestosNoAprobados++;
        resultado.estado = 'TIENE_MANIFIESTO_PENDIENTE';
        resultado.detalle = `Quedó pendiente de confirmación el manifiesto ${fila.idOperacion}.`;

        resultado.manifiestosPendientesInfo.push({
          idOperacion: fila.idOperacion,
          fechaCreacion: fila.fechaCreacion,
          empCreador: fila.empCreador,
          estCreador: fila.estCreador,
        });

        await cancelarModal(modal);

        console.log(`Se canceló la aprobación de ${empresa}. El programa sigue con la siguiente empresa.`);
        break;
      }

      await aceptarManifiesto(page, modal);
      resultado.manifiestosAprobados++;

      await clickEnProceso(page).catch(() => {});
      await esperar(3000);

      const volvioAPendientes = await clickSiVisible(page.getByText(/^Pendientes$/i).first(), 3000);
      if (!volvioAPendientes) {
        await clickPendientes(page).catch(() => {});
      }
      await esperar(2000);
    }

    if (guard >= 20) {
      resultado.estado = 'ERROR';
      resultado.ok = false;
      resultado.error = 'LIMITE_ITERACIONES';
      resultado.detalle = 'Se alcanzó el límite de iteraciones del loop.';
    }

    return resultado;
  } catch (error) {
    return {
      ...resultadoBase,
      ok: false,
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
    relax_column_count: true,
  });

  const resultados = [];
  const conManifiestoProcesado = [];
  const conManifiestoPendiente = [];
  const sinManifiesto = [];
  const loginIncorrecto = [];
  const conError = [];

  for (const row of records) {
    const empresa = normalizeText(row.empresa || '');
    const usuario = normalizeText(row.usuario || '');
    const password = normalizeText(row.password || '');

    if (!empresa || !usuario || !password) {
      console.log('\n========================================');
      console.log('Fila omitida por datos incompletos');
      console.log('========================================');
      console.log(row);
      continue;
    }

    console.log('\n========================================');
    console.log(`Revisando ${empresa} (${usuario})...`);
    console.log('========================================\n');

    const resultado = await procesarUsuario(empresa, usuario, password);
    resultados.push(resultado);

    if (resultado.estado === 'APROBADO_Y_SIN_PENDIENTES') {
      conManifiestoProcesado.push({
        empresa: resultado.empresa,
        usuario: resultado.usuario,
        estado: resultado.estado,
        detalle: resultado.detalle,
      });
    } else if (resultado.estado === 'TIENE_MANIFIESTO_PENDIENTE') {
      conManifiestoPendiente.push({
        empresa: resultado.empresa,
        usuario: resultado.usuario,
        estado: resultado.estado,
        detalle: resultado.detalle,
        pendientes: resultado.manifiestosPendientesInfo || [],
      });
    } else if (resultado.estado === 'SIN_MANIFIESTO') {
      sinManifiesto.push({
        empresa: resultado.empresa,
        usuario: resultado.usuario,
        estado: resultado.estado,
        detalle: resultado.detalle,
      });
    } else if (resultado.estado === 'USUARIO_O_PASSWORD_INCORRECTO') {
      loginIncorrecto.push({
        empresa: resultado.empresa,
        usuario: resultado.usuario,
        estado: resultado.estado,
        detalle: resultado.detalle,
      });
    } else {
      conError.push({
        empresa: resultado.empresa,
        usuario: resultado.usuario,
        estado: resultado.estado,
        detalle: resultado.detalle,
      });
    }

    console.log(`${resultado.empresa} (${resultado.usuario}): ${resultado.estado}`);
  }

  const salidaResultados = [
    'empresa,usuario,ok,estado,detalle,error,manifiestosDetectados,manifiestosAprobados,manifiestosNoAprobados',
    ...resultados.map((r) =>
      [
        csvEscape(r.empresa),
        csvEscape(r.usuario),
        csvEscape(r.ok),
        csvEscape(r.estado),
        csvEscape(r.detalle),
        csvEscape(r.error),
        csvEscape(r.manifiestosDetectados),
        csvEscape(r.manifiestosAprobados),
        csvEscape(r.manifiestosNoAprobados),
      ].join(',')
    ),
  ].join('\n');

  fs.writeFileSync(path.resolve(__dirname, 'resultados.csv'), salidaResultados, 'utf8');

  const salidaResiduos = ['empresa,usuario,idOperacion,csc,descripcion,cantidadKg,unidad'];

  for (const r of resultados) {
    for (const rr of r.residuosResumen || []) {
      salidaResiduos.push(
        [
          csvEscape(r.empresa),
          csvEscape(r.usuario),
          csvEscape(rr.idOperacion),
          csvEscape(rr.csc),
          csvEscape(rr.descripcion),
          csvEscape(rr.cantidadKg),
          csvEscape(rr.unidad),
        ].join(',')
      );
    }
  }

  fs.writeFileSync(path.resolve(__dirname, 'residuos.csv'), salidaResiduos.join('\n'), 'utf8');

  const salidaPendientes = [
    'empresa,usuario,idOperacion,fechaCreacion,empCreador,estCreador',
  ];

  for (const r of resultados) {
    for (const p of r.manifiestosPendientesInfo || []) {
      salidaPendientes.push(
        [
          csvEscape(r.empresa),
          csvEscape(r.usuario),
          csvEscape(p.idOperacion),
          csvEscape(p.fechaCreacion),
          csvEscape(p.empCreador),
          csvEscape(p.estCreador),
        ].join(',')
      );
    }
  }

  fs.writeFileSync(
    path.resolve(__dirname, 'pendientes_por_confirmar.csv'),
    salidaPendientes.join('\n'),
    'utf8'
  );

  console.log('\n========================================');
  console.log('RESUMEN FINAL');
  console.log('========================================');

  console.log(`Con manifiesto aprobado: ${conManifiestoProcesado.length}`);
  conManifiestoProcesado.forEach((x) =>
    console.log(`- ${x.empresa} (${x.usuario}) -> ${x.estado}`)
  );

  console.log(`\nCon manifiesto pendiente de confirmación: ${conManifiestoPendiente.length}`);
  conManifiestoPendiente.forEach((x) => {
    console.log(`- ${x.empresa} (${x.usuario}) -> ${x.detalle}`);
    (x.pendientes || []).forEach((p) => {
      console.log(`  • Id operación: ${p.idOperacion} | Fecha: ${p.fechaCreacion} | Creador: ${p.empCreador}`);
    });
  });

  console.log(`\nSin manifiesto: ${sinManifiesto.length}`);
  sinManifiesto.forEach((x) => console.log(`- ${x.empresa} (${x.usuario})`));

  console.log(`\nUsuario o contraseña incorrectos: ${loginIncorrecto.length}`);
  loginIncorrecto.forEach((x) =>
    console.log(`- ${x.empresa} (${x.usuario}) -> ${x.detalle}`)
  );

  console.log(`\nCon error: ${conError.length}`);
  conError.forEach((x) => console.log(`- ${x.empresa} (${x.usuario}) -> ${x.detalle}`));

  console.log('========================================\n');
  console.log('Archivos generados:');
  console.log('- resultados.csv');
  console.log('- residuos.csv');
  console.log('- pendientes_por_confirmar.csv');

  await rl.close();
}

main().catch(async (err) => {
  console.error('Error general:', err);
  try {
    await rl.close();
  } catch {}
  process.exit(1);
});