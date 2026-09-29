// ============================================================
// Resolución de tenant
// ============================================================

import { hasTenantAccess } from "./auth.js";
import { jsonError } from "./http.js";

export const OPERATIONAL_STATUSES = ["active", "approved"];
export const DEFAULT_PUBLIC_SLUG = "sgc";

export function isOperational(tenant) {
  return !!tenant && OPERATIONAL_STATUSES.includes(tenant.status);
}

export async function getTenantBySlug(env, slug) {
  if (!slug) return null;
  return await env.DB.prepare("SELECT * FROM tenants WHERE slug = ?").bind(slug).first();
}

export async function getTenantByInstance(env, instance) {
  if (!instance) return null;
  return await env.DB.prepare("SELECT * FROM tenants WHERE evolution_instance = ?").bind(instance).first();
}

// Endpoints públicos (chat web, servicios, disponibilidad, agendar).
// Sin ?t= usan el tenant de la landing SGC; el tenant debe estar operativo.
export async function resolvePublicTenant(env, url) {
  const slug = url.searchParams.get("t") || url.searchParams.get("tenant") || DEFAULT_PUBLIC_SLUG;
  const tenant = await getTenantBySlug(env, slug);
  if (!tenant) return { response: jsonError("Tenant no encontrado", 404) };
  if (!isOperational(tenant)) return { response: jsonError("Tenant inactivo", 403, { status: tenant.status }) };
  return { tenant };
}

// Webhook de Evolution: la instancia que recibe el mensaje identifica al tenant.
// ?t= es respaldo (URL configurada por tenant). Nunca se asume un tenant por defecto.
export async function resolveTenantForWebhook(env, body, url) {
  const byInstance = await getTenantByInstance(env, body && body.instance);
  if (byInstance) return byInstance;
  return await getTenantBySlug(env, url.searchParams.get("t"));
}

// Panel admin del tenant: requiere ?t=<slug> + clave del tenant (o ADMIN_TOKEN)
export async function requireTenantPanel(request, env, url) {
  const slug = url.searchParams.get("t") || url.searchParams.get("tenant");
  if (!slug) return { response: jsonError("slug requerido (?t=<slug>)", 400) };
  if (!(await hasTenantAccess(request, env, slug))) {
    return { response: jsonError("No autorizado: clave de acceso inválida", 401) };
  }
  const tenant = await getTenantBySlug(env, slug);
  if (!tenant) return { response: jsonError("Tenant no encontrado", 404) };
  if (tenant.status === "rejected") return { response: jsonError("Tenant rechazado", 403) };
  return { tenant };
}
