const express = require("express");

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

app.get("/check", (req, res) => {
  res.status(200).json({
    ok: true,
    action: "check",
    message: "Ruta /check funcionando",
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
