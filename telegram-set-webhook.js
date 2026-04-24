require("./env-loader");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

async function postJson(url, payload) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok || data.ok === false) {
      throw new Error(`No pude registrar el webhook: ${JSON.stringify(data)}`);
    }

    return data;
  } catch (fetchError) {
    const { stdout } = await execFileAsync("curl", [
      "-sS",
      "-X",
      "POST",
      url,
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify(payload)
    ]);

    const data = JSON.parse(stdout || "{}");
    if (data.ok === false) {
      throw new Error(`No pude registrar el webhook: ${JSON.stringify(data)}`);
    }

    return data;
  }
}

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
  const data = await postJson(`https://api.telegram.org/bot${token}/setWebhook`, {
    url: webhookUrl,
    secret_token: secret || undefined,
    allowed_updates: ["message", "edited_message"]
  });

  console.log(`Webhook registrado en ${webhookUrl}`);
  console.log(JSON.stringify(data, null, 2));
}

main().catch((error) => {
  console.error("Error configurando webhook de Telegram:", error.message);
  process.exit(1);
});
