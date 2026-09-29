// ============================================================
// Autenticación
//
//  - ADMIN_TOKEN     (secret): super-admin de la plataforma. Header
//                    "Authorization: Bearer <ADMIN_TOKEN>".
//  - PANEL_SECRET    (secret): firma las claves de acceso de cada tenant.
//                    clave = HMAC-SHA256(PANEL_SECRET, "panel:<slug>") (32 hex).
//                    No requiere columnas nuevas en D1; rotar PANEL_SECRET
//                    invalida todas las claves.
//  - WEBHOOK_SECRET  (secret): Evolution API lo envía en la URL del webhook
//                    (?k=...) o en el header X-Webhook-Secret.
//
// Todo falla cerrado: si el secret no está configurado, se rechaza.
// ============================================================

import { jsonError } from "./http.js";

const encoder = new TextEncoder();

export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length || ab.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function getBearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function isAdminRequest(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  return timingSafeEqual(getBearer(request) || "", env.ADMIN_TOKEN);
}

// Devuelve null si está autorizado, o una Response de error
export function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) {
    console.error("ADMIN_TOKEN no configurado: endpoints admin deshabilitados");
    return jsonError("Admin deshabilitado: falta configurar ADMIN_TOKEN", 503);
  }
  if (!isAdminRequest(request, env)) {
    return jsonError("No autorizado", 401);
  }
  return null;
}

export async function tenantPanelKey(env, slug) {
  if (!env.PANEL_SECRET) return null;
  const hex = await hmacHex(env.PANEL_SECRET, `panel:${slug}`);
  return hex.slice(0, 32);
}

// true si el request trae la clave del tenant (o el ADMIN_TOKEN)
export async function hasTenantAccess(request, env, slug) {
  if (isAdminRequest(request, env)) return true;
  const provided = getBearer(request);
  if (!provided) return false;
  const expected = await tenantPanelKey(env, slug);
  if (!expected) return false;
  return timingSafeEqual(provided, expected);
}

export function verifyWebhook(request, env, url) {
  if (!env.WEBHOOK_SECRET) {
    console.error("WEBHOOK_SECRET no configurado: webhook rechazado");
    return false;
  }
  const provided = url.searchParams.get("k") || request.headers.get("X-Webhook-Secret") || "";
  return timingSafeEqual(provided, env.WEBHOOK_SECRET);
}
