const { upsertEmpresaConCredencial } = require("./supabase-store");

async function main() {
  const [, , nombre, usuarioSimel, passwordPlano, cuit = ""] = process.argv;

  if (!nombre || !usuarioSimel || !passwordPlano) {
    console.error("Uso: node supabase-seed.js \"EMPRESA\" \"USUARIO_SIMEL\" \"PASSWORD\" \"CUIT_OPCIONAL\"");
    process.exit(1);
  }

  const result = await upsertEmpresaConCredencial({
    nombre,
    usuarioSimel,
    passwordPlano,
    cuit,
    activa: true,
    credencialActiva: true
  });

  console.log("Empresa/credencial guardada en Supabase:", JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Error cargando datos en Supabase:", error.message);
  process.exit(1);
});
