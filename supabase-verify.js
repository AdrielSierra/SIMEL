const store = require("./supabase-store");

async function main() {
  const empresa = process.argv[2] || "COLON S R L";
  const cred = await store.obtenerUsuarioSimelPorEmpresa(empresa);

  if (!cred) {
    console.error(`No se encontró credencial activa para ${empresa}`);
    process.exit(1);
  }

  console.log(JSON.stringify({
    empresa: cred.empresa,
    usuario: cred.usuario,
    password: cred.password ? "[ok]" : "",
    activo: cred.activo
  }, null, 2));
}

main().catch((error) => {
  console.error("Error verificando Supabase:", error.message);
  process.exit(1);
});
