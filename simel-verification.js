const { obtenerHistorialAprobacionesEmpresa } = require('./airtable');
const { normalizarTexto } = require('./simel-client');

function empresaCoincide(a = '', b = '') {
  return normalizarTexto(a) === normalizarTexto(b);
}

function fechaReciente(valor, ventanaMin = 20) {
  if (!valor) return false;
  const t = new Date(valor).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= ventanaMin * 60 * 1000;
}

async function verificarAprobacionPorHistorial({ empresa, aprobadosEsperados = 1, ventanaMin = 20 }) {
  const historial = await obtenerHistorialAprobacionesEmpresa(empresa, 10);
  const candidato = historial.find((item) => {
    const estadoOk = /aprobada|aprobado|ejecutada|ejecutado|finalizada|finalizado/i.test(item.estado || '');
    const empresaOk = empresaCoincide(item.empresa || '', empresa);
    const cantidadOk = Number(item.cantidadAprobar || 0) >= aprobadosEsperados;
    const fechaOk = fechaReciente(item.fechaEjecucion || item.fechaSolicitud, ventanaMin);
    return estadoOk && empresaOk && cantidadOk && fechaOk;
  });

  return {
    ok: !!candidato,
    fuente: 'historial_airtable',
    candidato: candidato || null,
    historial
  };
}

module.exports = { verificarAprobacionPorHistorial };
