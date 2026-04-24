require("./env-loader");

const DEFAULT_HEADERS = {
  "Content-Type": "application/json"
};

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL || "";
  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "";

  return {
    url: url.replace(/\/+$/, ""),
    key
  };
}

function isSupabaseEnabled() {
  const { url, key } = getSupabaseConfig();
  return !!url && !!key;
}

async function supabaseRequest(path, { method = "GET", body, prefer, query } = {}) {
  const { url, key } = getSupabaseConfig();
  if (!url || !key) {
    throw new Error("Supabase no configurado. Faltan SUPABASE_URL y/o SUPABASE_SECRET_KEY");
  }

  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  const headers = {
    ...DEFAULT_HEADERS,
    apikey: key,
    Authorization: `Bearer ${key}`
  };

  if (prefer) {
    headers.Prefer = prefer;
  }

  const response = await fetch(`${url}${path}${qs}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Supabase ${method} ${path} -> ${response.status}: ${errorText}`);
  }

  if (response.status === 204) return null;

  const text = await response.text().catch(() => "");
  if (!text) return null;

  return JSON.parse(text);
}

module.exports = {
  getSupabaseConfig,
  isSupabaseEnabled,
  supabaseRequest
};
