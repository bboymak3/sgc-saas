// ============================================================
// Endpoints de administración (requieren ADMIN_TOKEN)
//
//  - Super-admin de la plataforma: /api/superadmin/*
//  - Endpoints legacy del taller SGC usados por sgc-ordenes y los HTML
//    del worker: /api/admin/servicios, /api/citas-admin, /api/citas/*,
//    /api/consultar-*. Operan sobre ?t=<slug> (por defecto "sgc").
// ============================================================

import { json, jsonError, readJson } from "../lib/http.js";
import { requireAdmin } from "../lib/auth.js";
import { getTenantBySlug, DEFAULT_PUBLIC_SLUG } from "../lib/tenant.js";
import { listCitas, aprobarCita, rechazarCita } from "../lib/citas.js";
import { consultarVehiculo } from "../lib/ordenes.js";
import { hoyChile, isValidFecha } from "../lib/time.js";
import { approveTenant, syncWebhooks, sendPanelLink, panelLinks } from "../admin/commands.js";

const ADMIN_PATHS = [/^\/api\/admin\//, /^\/api\/superadmin\//, /^\/api\/citas-admin(\/|$)/, /^\/api\/citas\/(stats|rango)$/,
  /^\/api\/consultar-(vehiculo|citas)$/, /^\/api\/onboarding\/list$/, /^\/api\/migrate$/];

async function adminTenant(env, url) {
  const slug = url.searchParams.get("t") || url.searchParams.get("tenant") || DEFAULT_PUBLIC_SLUG;
  const tenant = await getTenantBySlug(env, slug);
  return tenant ? { tenant } : { response: jsonError("Tenant no encontrado", 404) };
}

export async function handleAdminRoutes(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  if (!ADMIN_PATHS.some((re) => re.test(path))) return null;

  const denied = requireAdmin(request, env);
  if (denied) return denied;

  if (path === "/api/migrate") {
    return jsonError("Eliminado: las migraciones se aplican con `wrangler d1 migrations apply` (ver worker/migrations)", 410);
  }

  // ---------------- Super-admin ----------------
  if ((path === "/api/superadmin/tenants" || path === "/api/onboarding/list") && method === "GET") {
    const res = await env.DB.prepare(
      "SELECT id, slug, business_name, rubro, whatsapp_number, email, status, evolution_instance, created_at, approved_at, active_at FROM tenants ORDER BY id DESC LIMIT 200"
    ).all();
    return json({ success: true, tenants: res.results || [] });
  }
  if (path === "/api/superadmin/sync-webhooks" && method === "POST") {
    if (!env.WEBHOOK_SECRET) return jsonError("Configura WEBHOOK_SECRET antes de sincronizar", 400);
    return json({ success: true, results: await syncWebhooks(env) });
  }
  const saMatch = path.match(/^\/api\/superadmin\/tenants\/([a-z0-9-]+)\/(aprobar|panel-link|enviar-link)$/);
  if (saMatch) {
    const tenant = await getTenantBySlug(env, saMatch[1]);
    if (!tenant) return jsonError("Tenant no encontrado", 404);
    if (saMatch[2] === "aprobar" && method === "POST") {
      const r = await approveTenant(env, tenant);
      return r.ok ? json({ success: true, mensaje: r.reply, instance: r.instanceName }) : jsonError(r.reply, 409);
    }
    if (saMatch[2] === "panel-link" && method === "GET") return json({ success: true, ...(await panelLinks(env, tenant.slug)) });
    if (saMatch[2] === "enviar-link" && method === "POST") return json(await sendPanelLink(env, tenant));
  }

  // ---------------- Servicios (legacy panel del worker) ----------------
  if (path === "/api/admin/servicios" && method === "GET") {
    const { tenant, response } = await adminTenant(env, url);
    if (response) return response;
    const res = await env.DB.prepare("SELECT * FROM sgc_cit_servicios_unificados WHERE tenant_id = ? ORDER BY orden ASC, id ASC").bind(tenant.id).all();
    return json({ success: true, servicios: res.results || [], total: (res.results || []).length });
  }
  if (path === "/api/admin/servicios" && method === "POST") {
    const { tenant, response } = await adminTenant(env, url);
    if (response) return response;
    const body = await readJson(request);
    const nombre = String(body.nombre || "").trim();
    if (!nombre) return jsonError("Nombre del servicio requerido", 400);
    const maxOrd = await env.DB.prepare("SELECT MAX(orden) AS m FROM sgc_cit_servicios_unificados WHERE tenant_id = ?").bind(tenant.id).first();
    const result = await env.DB.prepare(
      "INSERT INTO sgc_cit_servicios_unificados (nombre, descripcion, categoria, precio, duracion_minutos, activo, origen, orden, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      nombre, body.descripcion || "", body.categoria || "General", Number(body.precio) || 0,
      Number(body.duracion_minutos) || 60, body.activo === undefined ? 1 : (Number(body.activo) ? 1 : 0),
      body.origen || "manual", Number(body.orden) || ((maxOrd && maxOrd.m) || 0) + 1, tenant.id
    ).run();
    return json({ success: true, id: result.meta && result.meta.last_row_id, mensaje: "Servicio creado" });
  }
  const srvMatch = path.match(/^\/api\/admin\/servicios\/(\d+)$/);
  if (srvMatch && (method === "PUT" || method === "DELETE")) {
    const { tenant, response } = await adminTenant(env, url);
    if (response) return response;
    const id = parseInt(srvMatch[1], 10);
    if (method === "DELETE") {
      const r = await env.DB.prepare("UPDATE sgc_cit_servicios_unificados SET activo = 0, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?").bind(id, tenant.id).run();
      return (r.meta && r.meta.changes) ? json({ success: true, mensaje: "Servicio desactivado" }) : jsonError("Servicio no encontrado", 404);
    }
    const body = await readJson(request);
    const fields = ["nombre", "descripcion", "categoria", "precio", "duracion_minutos", "activo", "orden", "origen"];
    const sets = [];
    const vals = [];
    for (const f of fields) {
      if (body[f] === undefined) continue;
      sets.push(`${f} = ?`);
      vals.push(f === "nombre" ? String(body[f]).trim() : body[f]);
    }
    if (!sets.length) return jsonError("Nada que actualizar", 400);
    const r = await env.DB.prepare(
      `UPDATE sgc_cit_servicios_unificados SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`
    ).bind(...vals, id, tenant.id).run();
    return (r.meta && r.meta.changes) ? json({ success: true, mensaje: "Servicio actualizado" }) : jsonError("Servicio no encontrado", 404);
  }

  // ---------------- Citas (legacy: panel de sgc-ordenes y ordenes.html) ----------------
  if (path === "/api/citas-admin" && method === "GET") {
    const { tenant, response } = await adminTenant(env, url);
    if (response) return response;
    const data = await listCitas(env, tenant.id, {
      estado: url.searchParams.get("estado") || "",
      limit: url.searchParams.get("limit") || 50,
      canal: url.searchParams.get("canal") || null,
      hoy: hoyChile()
    });
    return json({ success: true, ...data });
  }
  const citaMatch = path.match(/^\/api\/citas-admin\/(\d+)\/(aprobar|rechazar)$/);
  if (citaMatch && method === "POST") {
    const { tenant, response } = await adminTenant(env, url);
    if (response) return response;
    const id = parseInt(citaMatch[1], 10);
    const r = citaMatch[2] === "aprobar"
      ? await aprobarCita(env, tenant, id)
      : await rechazarCita(env, tenant, id, (await readJson(request)).motivo);
    if (!r.success) return jsonError(r.error, r.status || 400);
    return json({
      ...r,
      mensaje: citaMatch[2] === "aprobar"
        ? (r.orden_creada ? "Cita aprobada, orden de trabajo creada y notificación enviada" : "Cita aprobada")
        : "Cita rechazada"
    });
  }
  if (path === "/api/citas/stats" && method === "GET") {
    const { tenant, response } = await adminTenant(env, url);
    if (response) return response;
    const tid = tenant.id;
    const [total, hoy, pendientes, ordenes] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS c FROM sgc_cit_Citas WHERE tenant_id = ?").bind(tid).first(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM sgc_cit_Citas WHERE tenant_id = ? AND fecha_cita = ?").bind(tid, hoyChile()).first(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM sgc_cit_Citas WHERE tenant_id = ? AND (estado_aprobacion = 'pendiente' OR estado_aprobacion IS NULL)").bind(tid).first(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM sgc_cit_Citas WHERE tenant_id = ? AND orden_enviada = 1").bind(tid).first()
    ]);
    return json({ total: total.c, hoy: hoy.c, pendientes: pendientes.c, ordenes_enviadas_globalprov2: ordenes.c });
  }
  if (path === "/api/citas/rango" && method === "GET") {
    const { tenant, response } = await adminTenant(env, url);
    if (response) return response;
    const inicio = url.searchParams.get("inicio");
    const fin = url.searchParams.get("fin");
    if (!isValidFecha(inicio) || !isValidFecha(fin)) return jsonError("Parámetros inicio y fin requeridos (YYYY-MM-DD)", 400);
    const res = await env.DB.prepare(
      "SELECT id, patente, marca, modelo, anio, color, nombre_cliente, telefono, servicio, fecha_cita, hora_cita, estado, estado_aprobacion, observaciones, canal, duracion_minutos, tipo_atencion, direccion, referencia_direccion, created_at " +
      "FROM sgc_cit_Citas WHERE tenant_id = ? AND fecha_cita >= ? AND fecha_cita <= ? AND estado NOT IN ('cancelada', 'no_asistio') ORDER BY fecha_cita, hora_cita"
    ).bind(tenant.id, inicio, fin).all();
    return json({ success: true, citas: res.results || [] });
  }
  if (path === "/api/consultar-vehiculo" && method === "POST") {
    const body = await readJson(request);
    if (!body.patente) return jsonError("Patente requerida", 400);
    return json(await consultarVehiculo(env, body.patente));
  }
  if (path === "/api/consultar-citas" && method === "GET") {
    const { tenant, response } = await adminTenant(env, url);
    if (response) return response;
    const patente = url.searchParams.get("patente");
    const telefono = url.searchParams.get("telefono");
    if (!patente && !telefono) return jsonError("Se requiere patente o teléfono", 400);
    let q = "SELECT id, patente, nombre_cliente, telefono, servicio, fecha_cita, hora_cita, estado, observaciones, canal FROM sgc_cit_Citas WHERE tenant_id = ? AND estado NOT IN ('cancelada', 'no_asistio') AND fecha_cita >= ?";
    const params = [tenant.id, hoyChile()];
    if (patente) { q += " AND UPPER(patente) = ?"; params.push(patente.toUpperCase().trim()); }
    else { q += " AND telefono = ?"; params.push(telefono.trim()); }
    const res = await env.DB.prepare(q + " ORDER BY fecha_cita ASC, hora_cita ASC LIMIT 10").bind(...params).all();
    return json({ success: true, citas: res.results || [] });
  }

  return jsonError("Ruta no encontrada", 404);
}
