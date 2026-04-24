require("./env-loader");

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";

  if (!token) {
    throw new Error("Falta TELEGRAM_BOT_TOKEN");
  }

  if (!baseUrl) {
    throw new Error("Falta PUBLIC_BASE_URL");
  }

  const webhookUrl = `${baseUrl}/telegram/webhook`;
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret || undefined,
      allowed_updates: ["message", "edited_message"]
    })
  });

  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(`No pude registrar el webhook: ${JSON.stringify(data)}`);
  }

  console.log(`Webhook registrado en ${webhookUrl}`);
  console.log(JSON.stringify(data, null, 2));
}

main().catch((error) => {
  console.error("Error configurando webhook de Telegram:", error.message);
  process.exit(1);
});
