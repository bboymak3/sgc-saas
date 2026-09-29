// ============================================================
// Evolution API v2 (bridge WhatsApp)
//
// Cada tenant tiene su propia instancia (tenants.evolution_instance).
// La instancia de la plataforma (env.EVOLUTION_INSTANCE_NAME) se usa para
// hablar con el admin y para mensajes de onboarding (QR, enlace del panel).
// ============================================================

export function platformInstance(env) {
  return env.EVOLUTION_INSTANCE_NAME || "make peueba";
}

export function instanceForTenant(env, tenant) {
  return (tenant && tenant.evolution_instance) || platformInstance(env);
}

export function instanceNameForSlug(slug) {
  return "t_" + slug.replace(/-/g, "_");
}

export function cleanPhone(phone) {
  return String(phone || "").replace(/[^0-9]/g, "");
}

function evolutionConfigured(env) {
  if (!env.EVOLUTION_API_KEY || !env.EVOLUTION_API_URL) {
    console.error("Evolution API no configurada. Falta EVOLUTION_API_KEY o EVOLUTION_API_URL");
    return false;
  }
  return true;
}

async function evolutionFetch(env, path, init = {}) {
  const res = await fetch(`${env.EVOLUTION_API_URL}${path}`, {
    ...init,
    headers: { "apikey": env.EVOLUTION_API_KEY, "Content-Type": "application/json", ...(init.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function sendText(env, instance, phone, text) {
  try {
    if (!evolutionConfigured(env)) return { success: false, error: "Evolution API no configurada" };
    const number = cleanPhone(phone);
    const r = await evolutionFetch(env, `/message/sendText/${encodeURIComponent(instance)}`, {
      method: "POST",
      body: JSON.stringify({ number, text })
    });
    if (r.ok) return { success: true };
    console.error("Evolution sendText error:", r.status, JSON.stringify(r.data));
    return { success: false, error: r.data.message || `HTTP ${r.status}` };
  } catch (error) {
    console.error("Error sendText:", error);
    return { success: false, error: error.message };
  }
}

export async function sendImage(env, instance, phone, base64, caption) {
  try {
    if (!evolutionConfigured(env)) return { success: false, error: "Evolution API no configurada" };
    const media = String(base64 || "").replace(/^data:image\/[a-z]+;base64,/, "");
    if (!media) return { success: false, error: "base64 vacío" };
    const r = await evolutionFetch(env, `/message/sendMedia/${encodeURIComponent(instance)}`, {
      method: "POST",
      body: JSON.stringify({
        number: cleanPhone(phone),
        mediatype: "image",
        mimetype: "image/png",
        fileName: "qr.png",
        caption: caption || "",
        media
      })
    });
    if (r.ok) return { success: true };
    console.error("Evolution sendMedia error:", r.status, JSON.stringify(r.data));
    return { success: false, error: r.data.message || r.data.error || `HTTP ${r.status}` };
  } catch (error) {
    console.error("Error sendImage:", error);
    return { success: false, error: error.message };
  }
}

// Divide mensajes largos (límite WhatsApp ~4096) y los envía en orden
export async function sendLongText(env, instance, phone, text, max = 3500) {
  const parts = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = remaining.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trim();
  }
  parts.push(remaining);
  let result = { success: true };
  for (const p of parts) {
    result = await sendText(env, instance, phone, p);
  }
  return result;
}

export const WEBHOOK_EVENTS = ["MESSAGES_UPSERT", "CONNECTION_UPDATE"];

export function webhookUrlForTenant(env, slug) {
  const base = env.PUBLIC_WORKER_URL || "https://sgc-saas.activo.workers.dev";
  return `${base}/api/whatsapp/webhook?t=${encodeURIComponent(slug)}&k=${encodeURIComponent(env.WEBHOOK_SECRET || "")}`;
}

function webhookConfig(env, slug) {
  return {
    enabled: true,
    url: webhookUrlForTenant(env, slug),
    byEvents: false,
    base64: false,
    headers: { "X-Webhook-Secret": env.WEBHOOK_SECRET || "" },
    events: WEBHOOK_EVENTS
  };
}

export async function createInstance(env, instanceName, slug) {
  if (!evolutionConfigured(env)) return { success: false, error: "Evolution API no configurada" };
  const r = await evolutionFetch(env, "/instance/create", {
    method: "POST",
    body: JSON.stringify({
      instanceName,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
      webhook: webhookConfig(env, slug)
    })
  });
  if (!r.ok) console.error("Evolution instance/create error:", r.status, JSON.stringify(r.data));
  return { success: r.ok, status: r.status, data: r.data };
}

// Reconfigura el webhook de una instancia existente (p.ej. tras rotar WEBHOOK_SECRET)
export async function setWebhook(env, instanceName, slug) {
  if (!evolutionConfigured(env)) return { success: false, error: "Evolution API no configurada" };
  const r = await evolutionFetch(env, `/webhook/set/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    body: JSON.stringify({ webhook: webhookConfig(env, slug) })
  });
  if (!r.ok) console.error("Evolution webhook/set error:", instanceName, r.status, JSON.stringify(r.data));
  return { success: r.ok, status: r.status, error: r.ok ? null : (r.data.message || `HTTP ${r.status}`) };
}

// Obtiene el QR (base64 sin prefijo) para vincular la instancia
export async function getQr(env, instanceName) {
  if (!evolutionConfigured(env)) return null;
  const r = await evolutionFetch(env, `/instance/connect/${encodeURIComponent(instanceName)}`, { method: "GET" });
  const raw = r.data.base64 || r.data.qr || null;
  return raw ? String(raw).replace(/^data:image\/[a-z]+;base64,/, "") : null;
}
