const express = require("express");
const { checkSimel } = require("./simel-check");
const { runBatch } = require("./simel-batch");
const { obtenerUsuariosSimelActivos } = require("./airtable");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("SIMEL bot funcionando en Railway 🚀");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "simel-bot",
    timestamp: new Date().toISOString()
  });
});

app.get("/check", async (req, res) => {
  try {
    const user = req.query.user || process.env.SIMEL_USER;
    const pass = req.query.pass || process.env.SIMEL_PASS;

    if (!user || !pass) {
      return res.status(400).json({
        ok: false,
        error: "Faltan credenciales. Enviá ?user=...&pass=... o configurá SIMEL_USER y SIMEL_PASS."
      });
    }

    const resultado = await checkSimel(user, pass);
    return res.status(200).json(resultado);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/batch/run", async (req, res) => {
  try {
    const secret = req.headers["x-batch-secret"];

    if (!process.env.BATCH_SECRET || secret !== process.env.BATCH_SECRET) {
      return res.status(401).json({
        ok: false,
        error: "No autorizado"
      });
    }

    const usuarios = req.body.usuarios;
    const resultado = await runBatch({ usuarios });

    return res.status(200).json(resultado);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/batch/url-run", async (req, res) => {
  try {
    const token = req.query.token;

    if (!process.env.BATCH_URL_TOKEN || token !== process.env.BATCH_URL_TOKEN) {
      return res.status(401).json({
        ok: false,
        error: "Token inválido"
      });
    }

    const usuarios = await obtenerUsuariosSimelActivos();

    if (!usuarios.length) {
      return res.status(200).json({
        ok: true,
        total: 0,
        mensaje: "No hay usuarios activos en Airtable"
      });
    }

    const resultado = await runBatch({ usuarios });
    return res.status(200).json(resultado);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});