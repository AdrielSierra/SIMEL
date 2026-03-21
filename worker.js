const { checkSimel } = require("./simel-check");
const {
  obtenerTodosLosUsuariosSimelPendientes,
  actualizarResultadoSimel,
  buscarJobPendiente,
  actualizarJobSimel,
  crearDetalleJobSimel,
  registrarManifiestoPendienteSimel,
  obtenerAdminsWhatsApp
} = require("./airtable");

let trabajando = false;

// === MEJORA 2: NOTIFICACIONES PROACTIVAS DESDE EL WORKER ===

async function notificarAdmins(mensaje) {
  const admins = await obtenerAdminsWhatsApp();

  if (!admins.length) {
    console.log("[Worker] No hay admins configurados para notificar");
    return;
  }

  for (const admin of admins) {
    const telefonoDestino = process.env.WHATSAPP_TEST_TO || admin.telefonoNormalizado;

    try {
      const version = process.env.WHATSAPP_API_VERSION || "v22.0";
      const url = `https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: telefonoDestino,
        type: "text",
        text: { body: mensaje }
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json();
        console.error(`[Worker] Error notificando admin ${admin.nombre}:`, data);
      } else {
        console.log(`[Worker] Notificación enviada a admin ${admin.nombre}`);
      }
    } catch (error) {
      console.error(`[Worker] Error enviando notificación a ${admin.nombre}:`, error.message);
    }
  }
}

async function procesarJobPendiente() {
  if (trabajando) return;
  trabajando = true;

  let job = null;

  try {
    job = await buscarJobPendiente();

    if (!job) {
      trabajando = false;
      return;
    }

    console.log(`[Worker] Iniciando procesamiento del job ${job.jobId}`);

    await actualizarJobSimel(job.airtableRecordId, {
      "Estado": "En proceso"
    });

    const usuarios = await obtenerTodosLosUsuariosSimelPendientes();

    let procesadas = 0;
    let conManifiesto = 0;
    let sinManifiesto = 0;
    let conError = 0;

    for (const item of usuarios) {
      try {
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

        if (resultado.estado === "CON_MANIFIESTO") {
          await registrarManifiestoPendienteSimel({
            jobRecordId: job.airtableRecordId,
            jobIdTexto: job.jobId,
            resultado
          });
        }

        procesadas++;

        if (resultado.estado === "CON_MANIFIESTO") conManifiesto++;
        else if (resultado.estado === "SIN_MANIFIESTO") sinManifiesto++;
        else conError++;

        console.log(
          `[Worker] Procesada empresa ${procesadas}/${usuarios.length}: ${item.empresa} (${resultado.estado})`
        );

        await actualizarJobSimel(job.airtableRecordId, {
          "Procesadas": procesadas,
          "Con manifiesto": conManifiesto,
          "Sin manifiesto": sinManifiesto,
          "Con error": conError,
          "Detalle": `Procesadas ${procesadas} de ${usuarios.length}`
        });
      } catch (itemError) {
        console.error(`[Worker] Error procesando empresa ${item.empresa}:`, itemError.message);

        conError++;
        procesadas++;

        await crearDetalleJobSimel({
          jobRecordId: job.airtableRecordId,
          jobIdTexto: job.jobId,
          resultado: {
            empresa: item.empresa,
            usuario: item.usuario,
            estado: "ERROR",
            filas: 0,
            detalle: `Error: ${itemError.message}`,
            recordId: item.recordId
          }
        });

        await actualizarJobSimel(job.airtableRecordId, {
          "Procesadas": procesadas,
          "Con manifiesto": conManifiesto,
          "Sin manifiesto": sinManifiesto,
          "Con error": conError,
          "Detalle": `Procesadas ${procesadas} de ${usuarios.length}`
        });
      }
    }

    console.log(
      `[Worker] Job ${job.jobId} finalizado. Procesadas ${procesadas}, Con manifiesto ${conManifiesto}, Sin manifiesto ${sinManifiesto}, Con error ${conError}`
    );

    await actualizarJobSimel(job.airtableRecordId, {
      "Estado": "Finalizado",
      "Procesadas": procesadas,
      "Con manifiesto": conManifiesto,
      "Sin manifiesto": sinManifiesto,
      "Con error": conError,
      "Fin": new Date().toISOString(),
      "Detalle": `Finalizado. Procesadas ${procesadas} empresa(s).`
    });

    // Notificar a admins cuando job finaliza exitosamente
    await notificarAdmins(
      `✅ *Job finalizado*\n\nJob ID: ${job.jobId}\nProcesadas: ${procesadas}\nCon manifiesto: ${conManifiesto}\nSin manifiesto: ${sinManifiesto}\nCon error: ${conError}`
    );
  } catch (error) {
    console.error("[Worker] Error crítico:", error.message);

    if (job) {
      try {
        await actualizarJobSimel(job.airtableRecordId, {
          "Estado": "Error",
          "Fin": new Date().toISOString(),
          "Detalle": `Error crítico: ${error.message}`
        });
        console.log(`[Worker] Job ${job.jobId} marcado como Error`);

        // Notificar a admins en caso de error crítico
        await notificarAdmins(
          `🚨 *Error crítico en job*\n\nJob ID: ${job.jobId}\nError: ${error.message}`
        );
      } catch (updateError) {
        console.error("[Worker] Error actualizando job a Error:", updateError.message);
      }
    }
  } finally {
    trabajando = false;
  }
}

function iniciarWorker() {
  console.log("[Worker] Iniciando worker de background. Revisando jobs cada 15 segundos...");
  setInterval(() => {
    procesarJobPendiente().catch((err) => {
      console.error("[Worker] Error no capturado en procesarJobPendiente:", err);
    });
  }, 15000);
}

module.exports = { iniciarWorker };
