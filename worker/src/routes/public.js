// ============================================================
// Endpoints públicos (landing, chat web, reservas web, onboarding)
// ============================================================

import { json, jsonError, readJson, CORS_HEADERS } from "../lib/http.js";
import { resolvePublicTenant, getTenantBySlug } from "../lib/tenant.js";
import { validarSlot, getDisponibilidad, describeHorario } from "../lib/schedule.js";
import { tenantUsesOrdenes, asegurarOrdenParaCita, consultarVehiculo } from "../lib/ordenes.js";
import { allowOnce, clientIp } from "../lib/ratelimit.js";
import { buildWebChatPrompt, formatServicios, rubroInfo } from "../whatsapp/prompt.js";
import { matchServicio } from "../whatsapp/tools.js";
import { MODEL_ID } from "../whatsapp/webhook.js";
import { handleOnboardingRegister, handleOnboardingStatus, handleOnboardingQr, handleSendPanelLink } from "../onboarding.js";
import { sendPanelLink } from "../admin/commands.js";

async function serviciosActivos(env, tenantId) {
  const res = await env.DB.prepare(
    "SELECT id, nombre, descripcion, categoria, precio, duracion_minutos, requiere_vehiculo, es_domicilio FROM sgc_cit_servicios_unificados WHERE activo = 1 AND tenant_id = ? ORDER BY orden ASC, id ASC"
  ).bind(tenantId).all();
  return res.results || [];
}

export async function handlePublicRoutes(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/onboarding/register" && method === "POST") return handleOnboardingRegister(request, env);
  if (path === "/api/onboarding/status" && method === "GET") return handleOnboardingStatus(request, env, url);
  if (path === "/api/onboarding/qr" && method === "GET") return handleOnboardingQr(request, env, url);
  if (path === "/api/tenant/send-link" && method === "POST") return handleSendPanelLink(request, env, url, sendPanelLink);

  if (path === "/api/tenant/public" && method === "GET") {
    const slug = url.searchParams.get("t") || url.searchParams.get("slug");
    if (!slug) return jsonError("slug requerido", 400);
    const tenant = await getTenantBySlug(env, slug);
    if (!tenant) return jsonError("Tenant no encontrado", 404);
    if (!["active", "approved"].includes(tenant.status)) return jsonError("Tenant inactivo", 403, { status: tenant.status });
    const servicios = await serviciosActivos(env, tenant.id);
    return json({
      success: true,
      tenant: { slug: tenant.slug, business_name: tenant.business_name, business_phone: tenant.business_phone, rubro: tenant.rubro },
      servicios: servicios.map(({ nombre, descripcion, precio, categoria, duracion_minutos }) => ({ nombre, descripcion, precio, categoria, duracion_minutos })),
      horario: await describeHorario(env, tenant.id)
    });
  }

  if (path === "/api/servicios" && method === "GET") {
    const { tenant, response } = await resolvePublicTenant(env, url);
    if (response) return response;
    return json({ servicios: await serviciosActivos(env, tenant.id) });
  }

  if (path === "/api/disponibilidad" && method === "GET") {
    const { tenant, response } = await resolvePublicTenant(env, url);
    if (response) return response;
    const fecha = url.searchParams.get("fecha");
    if (!fecha) return jsonError("Fecha requerida (formato YYYY-MM-DD)", 400);
    const srv = matchServicio(await serviciosActivos(env, tenant.id), url.searchParams.get("servicio") || "");
    return json(await getDisponibilidad(env, tenant.id, fecha, { duracion: srv ? srv.duracion_minutos : 60 }));
  }

  if (path === "/api/agendar" && method === "POST") {
    const { tenant, response } = await resolvePublicTenant(env, url);
    if (response) return response;
    const body = await readJson(request);
    const pideVehiculo = rubroInfo(tenant.rubro).pideVehiculo;
    const requeridos = ["nombre", "telefono", "servicio", "fecha", "hora", ...(pideVehiculo ? ["patente"] : [])];
    if (requeridos.some((k) => !String(body[k] || "").trim())) {
      return json({ success: false, error: "Faltan campos requeridos", requeridos }, 400);
    }
    const telefono = String(body.telefono).trim().slice(0, 30);
    if (!(await allowOnce("agendar", `${clientIp(request)}:${telefono}`, 10))) {
      return jsonError("Espera unos segundos antes de reintentar", 429);
    }
    const servicios = await serviciosActivos(env, tenant.id);
    const srv = matchServicio(servicios, body.servicio);
    if (servicios.length && !srv) return jsonError("Servicio no disponible", 400);
    const nombreServicio = srv ? srv.nombre : String(body.servicio).trim().slice(0, 120);
    const duracion = (srv && srv.duracion_minutos) || 60;

    const v = await validarSlot(env, tenant.id, body.fecha, body.hora, { duracion });
    if (!v.ok) return jsonError(v.error, 409);

    const patente = body.patente ? String(body.patente).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) : null;
    const dup = await env.DB.prepare(
      "SELECT id FROM sgc_cit_Citas WHERE tenant_id = ? AND fecha_cita = ? AND hora_cita = ? AND (telefono = ? OR (patente IS NOT NULL AND patente = ?)) AND estado NOT IN ('cancelada', 'no_asistio')"
    ).bind(tenant.id, v.fecha, v.hora, telefono, patente).first();
    if (dup) return jsonError("Ya existe una cita para ese horario", 409);

    let vehiculo = null;
    if (patente && tenantUsesOrdenes(env, tenant)) vehiculo = (await consultarVehiculo(env, patente)).vehiculo || null;
    const nombreCompleto = [String(body.nombre).trim(), body.apellido ? String(body.apellido).trim() : ""].filter(Boolean).join(" ").slice(0, 120);
    const canal = ["chat", "web", "whatsapp"].includes(body.canal) ? body.canal : "chat";
    const result = await env.DB.prepare(
      "INSERT INTO sgc_cit_Citas (patente, marca, modelo, anio, color, nombre_cliente, telefono, email, servicio, fecha_cita, hora_cita, duracion_minutos, observaciones, canal, direccion, referencia_direccion, tipo_atencion, estado, estado_aprobacion, tenant_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', 'pendiente', ?)"
    ).bind(
      patente,
      (vehiculo && vehiculo.marca) || body.marca || null,
      (vehiculo && vehiculo.modelo) || body.modelo || null,
      (vehiculo && vehiculo.anio) || parseInt(body.anio, 10) || null,
      body.color || null,
      nombreCompleto, telefono, body.email || null,
      nombreServicio, v.fecha, v.hora, duracion,
      String(body.requerimientos || body.observaciones || "").slice(0, 1000) || null,
      canal,
      body.direccion || null, body.referencia_direccion || null,
      body.tipo_atencion === "domicilio" || (srv && srv.es_domicilio) ? "domicilio" : "taller",
      tenant.id
    ).run();
    const citaId = result.meta && result.meta.last_row_id;
    const cita = await env.DB.prepare("SELECT * FROM sgc_cit_Citas WHERE id = ?").bind(citaId).first();
    const orden = await asegurarOrdenParaCita(env, cita);
    return json({
      success: true,
      mensaje: orden.creada ? "Cita agendada y orden creada exitosamente" : "Cita agendada (pendiente de confirmación)",
      cita: {
        id: citaId, patente: cita.patente, nombre: cita.nombre_cliente, telefono: cita.telefono,
        servicio: cita.servicio, fecha: cita.fecha_cita, hora: cita.hora_cita, estado: cita.estado
      },
      orden_globalprov2: orden.creada ? { numero: orden.numero, formato: "EXP" + String(orden.numero).padStart(6, "0") } : null,
      orden_error: orden.error || null
    });
  }

  if (path === "/api/chat" && method === "POST") {
    const { tenant, response } = await resolvePublicTenant(env, url);
    if (response) return response;
    const body = await readJson(request);
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (!messages.length) return jsonError("No se proporcionaron mensajes", 400);
    if (!(await allowOnce("chat", clientIp(request), 1))) return jsonError("Vas muy rápido, espera un segundo", 429);

    const [servicios, horarioText] = await Promise.all([serviciosActivos(env, tenant.id), describeHorario(env, tenant.id)]);
    const systemPrompt = buildWebChatPrompt({ tenant, serviciosText: formatServicios(servicios), horarioText });
    const stream = await env.AI.run(MODEL_ID, {
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      max_tokens: 512,
      stream: true
    });
    return new Response(stream, {
      headers: { ...CORS_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" }
    });
  }

  return null;
}
