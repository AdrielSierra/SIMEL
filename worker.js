const { checkSimel } = require("./simel-check");
const {
  obtenerTodosLosUsuariosSimelPendientes,
  actualizarResultadoSimel,
  buscarJobPendiente,
  actualizarJobSimel,
  crearDetalleJobSimel
} = require("./airtable");

let trabajando = false;

async function procesarJobPendiente() {
  if (trabajando) return;
  trabajando = true;

  try {
    const job = await buscarJobPendiente();
    if (!job) {
      trabajando = false;
      return;
    }

    await actualizarJobSimel(job.airtableRecordId, {
      "Estado": "En proceso"
    });

    const usuarios = await obtenerTodosLosUsuariosSimelPendientes();

    let procesadas = 0;
    let conManifiesto = 0;
    let sinManifiesto = 0;
    let conError = 0;

    for (const item of usuarios) {
      const r = await checkSimel(item.usuario, item.password);

      const resultado = {
        ...r,
        empresa: item.empresa,
        recordId: item.recordId
      };

      await actualizarResultadoSimel(resultado);

      await crearDetalleJobSimel({
        jobRecordId: job.airtableRecordId,
        jobIdTexto: job.jobId,
        resultado
      });

      procesadas++;

      if (resultado.estado === "CON_MANIFIESTO") conManifiesto++;
      else if (resultado.estado === "SIN_MANIFIESTO") sinManifiesto++;
      else conError++;

      await actualizarJobSimel(job.airtableRecordId, {
        "Procesadas": procesadas,
        "Con manifiesto": conManifiesto,
        "Sin manifiesto": sinManifiesto,
        "Con error": conError,
        "Detalle": `Procesadas ${procesadas} de ${usuarios.length}`
      });
    }

    await actualizarJobSimel(job.airtableRecordId, {
      "Estado": "Finalizado",
      "Procesadas": procesadas,
      "Con manifiesto": conManifiesto,
      "Sin manifiesto": sinManifiesto,
      "Con error": conError,
      "Fin": new Date().toISOString(),
      "Detalle": `Finalizado. Procesadas ${procesadas} empresa(s).`
    });
  } catch (error) {
    console.error("Error worker:", error);
  } finally {
    trabajando = false;
  }
}

function iniciarWorker() {
  setInterval(() => {
    procesarJobPendiente().catch((err) => console.error(err));
  }, 15000);
}

module.exports = { iniciarWorker };
