function normalizarTextoBusqueda(valor = "") {
  return String(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function distanciaLevenshtein(a = "", b = "") {
  const matriz = Array.from({ length: b.length + 1 }, () => []);
  for (let i = 0; i <= b.length; i++) matriz[i][0] = i;
  for (let j = 0; j <= a.length; j++) matriz[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const costo = a[j - 1] === b[i - 1] ? 0 : 1;
      matriz[i][j] = Math.min(
        matriz[i - 1][j] + 1,
        matriz[i][j - 1] + 1,
        matriz[i - 1][j - 1] + costo
      );
    }
  }

  return matriz[b.length][a.length];
}

function buscarEmpresasInteligente(empresas, termino) {
  const t = normalizarTextoBusqueda(termino);

  return empresas
    .map((empresa) => {
      const e = normalizarTextoBusqueda(empresa);
      let score = 0;

      if (e === t) score = 100;
      else if (e.startsWith(t)) score = 92;
      else if (e.includes(t)) score = 84;
      else {
        const dist = distanciaLevenshtein(e, t);
        const ratio = 1 - dist / Math.max(e.length, t.length, 1);
        score = Math.round(ratio * 70);
      }

      return { empresa, score };
    })
    .filter((x) => x.score >= 45)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.empresa.localeCompare(b.empresa, "es", { sensitivity: "base" })
    )
    .slice(0, 5);
}

function parsearJSONSeguro(texto, fallback = null) {
  try {
    return JSON.parse(texto || "");
  } catch {
    return fallback;
  }
}

function normalizarTextoPlano(valor = "") {
  return String(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function construirListadoRevision(items = []) {
  if (!items.length) return "No hay manifiestos pendientes.";

  return items
    .map((m, idx) => {
      const primerResiduo = m.residuos?.[0]?.residuo || "N/D";
      const primerCantidad = m.residuos?.[0]?.cantidadEst || "N/D";
      const transportista = m.transportistas?.[0]?.nombre || "N/D";
      return `${idx + 1}. ID ${m.idOperacion} | Residuo: ${primerResiduo} | Cant. Est: ${primerCantidad} | Transportista: ${transportista}`;
    })
    .join("\n");
}

function construirDetalleRevision(item, idx, total) {
  const residuos = (item.residuos || [])
    .slice(0, 5)
    .map((r, i) => `${i + 1}. ${r.residuo || "N/D"} | Cant. Est: ${r.cantidadEst || "N/D"} ${r.unidad || ""}`.trim())
    .join("\n");

  const transportistas = (item.transportistas || [])
    .slice(0, 5)
    .map((t, i) => `${i + 1}. ${t.nombre || "N/D"} | CUIT: ${t.cuit || "N/D"}`)
    .join("\n");

  return (
    `*Manifiesto ${idx + 1}/${total}*\n` +
    `ID Operacion: ${item.idOperacion}\n` +
    `Fecha: ${item.fechaCreacion || "N/D"}\n` +
    `Empresa creadora: ${item.empresaCreadora || "N/D"}\n` +
    `Est. creador: ${item.establecimientoCreador || "N/D"}\n\n` +
    `*Residuos*\n${residuos || "Sin datos"}\n\n` +
    `*Transportistas*\n${transportistas || "Sin datos"}\n\n` +
    `Opciones:\n` +
    `1. Aceptar este manifiesto\n` +
    `2. Rechazar este manifiesto\n` +
    `3. Cancelar\n` +
    `4. Aceptar todos\n` +
    `5. Ver lista\n` +
    `6. Siguiente\n\n` +
    `Tambien podes escribir: Aceptar, Rechazar, Cancelar, Aceptar todos, Lista o Siguiente`
  );
}

function buscarIndiceManifiesto(items = [], target = "", indiceFallback = 0) {
  const limpio = String(target || "").trim();
  if (!limpio) return indiceFallback;

  if (/^\d+$/.test(limpio)) {
    const numero = Number(limpio);
    const porIndice = numero - 1;
    if (porIndice >= 0 && porIndice < items.length) return porIndice;

    const porId = items.findIndex((x) => String(x.idOperacion) === limpio);
    return porId >= 0 ? porId : -1;
  }

  const porIdTexto = items.findIndex((x) => String(x.idOperacion) === limpio);
  return porIdTexto >= 0 ? porIdTexto : -1;
}

function resumirErrorPendientesSimel(error = "") {
  const detalle = String(error || "").trim();
  const detallePlano = detalle.replace(/\s+/g, " ");

  if (!detallePlano) {
    return "No pude consultar los pendientes en SIMEL. Intenta de nuevo en unos segundos.";
  }

  if (/timeout/i.test(detallePlano)) {
    return "SIMEL tardó demasiado en responder al consultar pendientes. Intenta nuevamente.";
  }

  if (/login|credencial|usuario|password/i.test(detallePlano)) {
    return "No pude entrar a SIMEL con las credenciales de esa empresa.";
  }

  return "No pude consultar los pendientes en SIMEL en este momento.";
}

function detectarComando(texto = "") {
  const t = texto.trim();

  if (/^(menu|ayuda|hola|opciones|0)$/i.test(t)) return { codigo: "MENU" };
  if (/^(1|manifiestos|menu manifiestos)$/i.test(t)) return { codigo: "MENU_MANIFIESTOS" };
  if (/^(2|jobs|menu jobs)$/i.test(t)) return { codigo: "MENU_JOBS" };
  if (/^(3|buscar empresa)$/i.test(t)) return { codigo: "BUSCAR_EMPRESA_AYUDA" };
  if (/^(4|simel start|ejecutar batch)$/i.test(t)) return { codigo: "SIMEL_START" };
  if (/^(5|mi perfil|perfil|mis permisos)$/i.test(t)) return { codigo: "MI_PERFIL" };
  if (/^(simel estado|job estado|estado job)$/i.test(t)) return { codigo: "SIMEL_ESTADO" };
  if (/^(simel errores|job errores|errores job)$/i.test(t)) return { codigo: "SIMEL_ERRORES" };
  if (/^(simel detalle|job detalle)$/i.test(t)) return { codigo: "SIMEL_DETALLE" };

  const detalleMatch = t.match(/^simel detalle\s+(JOB-[A-Za-z0-9-]+)$/i);
  if (detalleMatch) return { codigo: "SIMEL_DETALLE", jobId: detalleMatch[1] };

  if (/^(manifiestos pendientes|pendientes|pendientes aprobar)$/i.test(t)) {
    return { codigo: "MANIFIESTOS_PENDIENTES" };
  }

  const buscarEmpresaMatch = t.match(/^(buscar empresa|empresa)\s+(.+)$/i);
  if (buscarEmpresaMatch) return { codigo: "BUSCAR_EMPRESA", termino: buscarEmpresaMatch[2].trim() };

  const aprobarMatch = t.match(/^(aprobar empresa|aprobar)\s+(.+)$/i);
  if (aprobarMatch) return { codigo: "SOLICITAR_APROBACION", termino: aprobarMatch[2].trim() };

  const confirmarMatch = t.match(/^confirmar\s+([A-Z0-9]{6})$/i);
  if (confirmarMatch) return { codigo: "CONFIRMAR_APROBACION", token: confirmarMatch[1].toUpperCase() };

  const historialMatch = t.match(/^(historial|historial empresa)\s+(.+)$/i);
  if (historialMatch) return { codigo: "HISTORIAL_EMPRESA", termino: historialMatch[2].trim() };

  if (/^reintentar errores$/i.test(t)) return { codigo: "REINTENTAR_ERRORES" };

  const estadoEmpresaMatch = t.match(/^(estado empresa|empresa estado)\s+(.+)$/i);
  if (estadoEmpresaMatch) return { codigo: "ESTADO_EMPRESA", termino: estadoEmpresaMatch[2].trim() };

  const consultarMatch = t.match(/^consultar\s+(.+)$/i);
  if (consultarMatch) return { codigo: "CONSULTAR_EMPRESA", termino: consultarMatch[1].trim() };

  return { codigo: "DESCONOCIDO" };
}

async function construirMenu(contacto, { obtenerConfigWhatsApp }) {
  const configBotNombre = await obtenerConfigWhatsApp("BOT_NOMBRE");
  const configBienvenida = await obtenerConfigWhatsApp("MENU_BIENVENIDA");

  const botNombre = configBotNombre?.valorTexto || "HySA Bot";
  const bienvenida =
    configBienvenida?.valorTexto ||
    `Hola, soy ${botNombre}. Elegi una opcion o escribi un comando.`;

  const lineas = [
    "1. *Ver y aprobar manifiestos* -> _manifiestos_",
    "2. *Ver estado del sistema* -> _jobs_",
    "3. *Consultar una empresa* -> _empresa NOMBRE_"
  ];

  if (contacto?.puedeEjecutarBatch) lineas.push("4. *Ejecutar batch* -> _simel start_");
  lineas.push("5. *Mi perfil* -> _mi perfil_");

  return (
    `${bienvenida}\n\n` +
    `*Menu principal*\n` +
    `${lineas.join("\n")}\n\n` +
    `_Tip: si queres aprobar una empresa, entra en "Manifiestos"._`
  );
}

function construirSubmenuManifiestos() {
  return (
    "*Submenu Manifiestos*\n\n" +
    "1. Ver empresas con pendientes -> manifiestos pendientes\n" +
    "2. Buscar una empresa -> empresa NOMBRE\n" +
    "3. Aprobar una empresa -> aprobar empresa NOMBRE\n" +
    "4. Consultar si una empresa tiene pendientes -> empresa NOMBRE\n\n" +
    "Escribi menu para volver al menu principal."
  );
}

function construirSubmenuJobs(contacto) {
  const lineas = [
    "*Submenu Jobs*\n",
    "1. Estado del ultimo job -> simel estado",
    "2. Errores del ultimo job -> simel errores",
    "3. Detalle de un job -> simel detalle JOB-XXXXXXXX"
  ];

  if (contacto?.puedeEjecutarBatch) lineas.push("4. Ejecutar batch -> simel start");
  lineas.push("\nEscribi menu para volver al menu principal.");
  return lineas.join("\n");
}

function construirAyudaAprobarEmpresa() {
  return (
    "📄 *Aprobar manifiestos por empresa*\n\n" +
    "Escribi el nombre (o parte del nombre) de la empresa que queres aprobar.\n\n" +
    "Ejemplos:\n" +
    "• united\n" +
    "• ypf\n" +
    "• petrolfe\n\n" +
    "Escribi *menu* para cancelar."
  );
}

function construirAyudaConsultarEmpresa() {
  return (
    "🔎 *Consultar empresa*\n\n" +
    "Escribi el nombre de la empresa para ver si tiene manifiestos pendientes.\n\n" +
    "Ejemplos:\n" +
    "• united\n" +
    "• ypf\n" +
    "• petrolfe\n\n" +
    "Escribi *menu* para cancelar."
  );
}

module.exports = {
  buscarEmpresasInteligente,
  parsearJSONSeguro,
  normalizarTextoPlano,
  construirListadoRevision,
  construirDetalleRevision,
  buscarIndiceManifiesto,
  resumirErrorPendientesSimel,
  detectarComando,
  construirMenu,
  construirSubmenuManifiestos,
  construirSubmenuJobs,
  construirAyudaAprobarEmpresa,
  construirAyudaConsultarEmpresa
};
