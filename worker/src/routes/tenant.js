// ============================================================
// Panel admin de cada tenant: /api/tenant/*
// Autenticación: ?t=<slug> + "Authorization: Bearer <clave del tenant>"
// ============================================================

import { json, jsonError, readJson } from "../lib/http.js";
import { requireTenantPanel } from "../lib/tenant.js";
import { listCitas, aprobarCita, rechazarCita } from "../lib/citas.js";
import { getHorarios, getConfig } from "../lib/schedule.js";
import { hoyChile, isValidFecha, normalizeHora } from "../lib/time.js";

const DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"];
const CONFIG_KEYS = ["max_citas_por_dia", "citas_simultaneas", "limite_horas_antes", "anticipacion_dias"];
const SERVICIO_FIELDS = ["nombre", "descripcion", "categoria", "precio", "duracion_minutos", "activo", "orden", "requiere_vehiculo", "es_domicilio"];

function servicioValue(field, v) {
  if (field === "nombre") return String(v || "").trim().slice(0, 120);
  if (field === "descripcion" || field === "categoria") return String(v || "").slice(0, 300);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function handleTenantRoutes(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  if (!path.startsWith("/api/tenant/") || path === "/api/tenant/public" || path === "/api/tenant/send-link") return null;

  const { tenant, response } = await requireTenantPanel(request, env, url);
  if (response) return response;
  const tid = tenant.id;

  if (path === "/api/tenant/dashboard" && method === "GET") {
    const hoy = hoyChile();
    const [total, deHoy, pendientes, activas, conversaciones, servicios] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS c FROM sgc_cit_Citas WHERE tenant_id = ?").bind(tid).first(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM sgc_cit_Citas WHERE tenant_id = ? AND fecha_cita = ?").bind(tid, hoy).first(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM sgc_cit_Citas WHERE tenant_id = ? AND (estado_aprobacion = 'pendiente' OR estado_aprobacion IS NULL)").bind(tid).first(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM sgc_cit_Citas WHERE tenant_id = ? AND estado = 'confirmada'").bind(tid).first(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM sgc_cit_WhatsApp_conversations WHERE tenant_id = ?").bind(tid).first(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM sgc_cit_servicios_unificados WHERE tenant_id = ? AND activo = 1").bind(tid).first()
    ]);
    return json({
      success: true,
      tenant: {
        id: tenant.id, slug: tenant.slug, business_name: tenant.business_name, rubro: tenant.rubro,
        whatsapp_number: tenant.whatsapp_number, email: tenant.email, status: tenant.status,
        evolution_instance: tenant.evolution_instance, ai_tone: tenant.ai_tone,
        created_at: tenant.created_at, approved_at: tenant.approved_at, active_at: tenant.active_at
      },
      kpis: {
        citas_total: (total && total.c) || 0,
        citas_hoy: (deHoy && deHoy.c) || 0,
        citas_pendientes: (pendientes && pendientes.c) || 0,
        citas_activas: (activas && activas.c) || 0,
        conversaciones_unicas: (conversaciones && conversaciones.c) || 0,
        servicios_activos: (servicios && servicios.c) || 0
      }
    });
  }

  if (path === "/api/tenant/citas" && method === "GET") {
    const data = await listCitas(env, tid, {
      estado: url.searchParams.get("estado") || "",
      limit: url.searchParams.get("limit") || 100,
      hoy: hoyChile()
    });
    return json({ success: true, ...data });
  }

  if (path === "/api/tenant/citas" && method === "POST") {
    const body = await readJson(request);
    const hora = normalizeHora(body.hora);
    if (!body.nombre || !body.telefono || !body.servicio || !body.fecha || !body.hora) {
      return jsonError("Faltan campos: nombre, telefono, servicio, fecha, hora", 400);
    }
    if (!isValidFecha(body.fecha) || !hora) return jsonError("Fecha u hora inválida (YYYY-MM-DD / HH:MM)", 400);
    // Creada por el propio negocio: queda aprobada
    const result = await env.DB.prepare(
      "INSERT INTO sgc_cit_Citas (patente, marca, modelo, nombre_cliente, telefono, email, servicio, fecha_cita, hora_cita, duracion_minutos, observaciones, canal, tipo_atencion, estado, estado_aprobacion, tenant_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?, 'confirmada', 'aprobada', ?)"
    ).bind(
      body.patente || "", body.marca || "", body.modelo || "",
      String(body.nombre).slice(0, 120), String(body.telefono).slice(0, 30), body.email || "",
      String(body.servicio).slice(0, 120), body.fecha, hora,
      parseInt(body.duracion_minutos, 10) || 60, body.observaciones || "",
      body.tipo_atencion === "domicilio" ? "domicilio" : "taller", tid
    ).run();
    return json({ success: true, id: result.meta && result.meta.last_row_id, mensaje: "Cita creada" });
  }

  const citaMatch = path.match(/^\/api\/tenant\/citas\/(\d+)\/(aprobar|rechazar)$/);
  if (citaMatch && method === "POST") {
    const citaId = parseInt(citaMatch[1], 10);
    const r = citaMatch[2] === "aprobar"
      ? await aprobarCita(env, tenant, citaId)
      : await rechazarCita(env, tenant, citaId, (await readJson(request)).motivo);
    if (!r.success) return jsonError(r.error, r.status || 400);
    return json({ ...r, mensaje: citaMatch[2] === "aprobar" ? "Cita aprobada" : "Cita rechazada" });
  }

  if (path === "/api/tenant/servicios" && method === "GET") {
    const res = await env.DB.prepare(
      "SELECT id, nombre, descripcion, categoria, precio, duracion_minutos, activo, orden, origen, requiere_vehiculo, es_domicilio FROM sgc_cit_servicios_unificados WHERE tenant_id = ? ORDER BY orden ASC, id ASC"
    ).bind(tid).all();
    return json({ success: true, servicios: res.results || [], total: (res.results || []).length });
  }

  if (path === "/api/tenant/servicios" && method === "POST") {
    const body = await readJson(request);
    const nombre = servicioValue("nombre", body.nombre);
    if (!nombre) return jsonError("Nombre del servicio requerido", 400);
    const maxOrd = await env.DB.prepare("SELECT MAX(orden) AS m FROM sgc_cit_servicios_unificados WHERE tenant_id = ?").bind(tid).first();
    const result = await env.DB.prepare(
      "INSERT INTO sgc_cit_servicios_unificados (nombre, descripcion, categoria, precio, duracion_minutos, activo, origen, orden, requiere_vehiculo, es_domicilio, tenant_id) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)"
    ).bind(
      nombre,
      servicioValue("descripcion", body.descripcion),
      servicioValue("categoria", body.categoria || "General"),
      servicioValue("precio", body.precio),
      servicioValue("duracion_minutos", body.duracion_minutos) || 60,
      body.activo === undefined ? 1 : (Number(body.activo) ? 1 : 0),
      body.orden ? servicioValue("orden", body.orden) : ((maxOrd && maxOrd.m) || 0) + 1,
      Number(body.requiere_vehiculo) ? 1 : 0,
      Number(body.es_domicilio) ? 1 : 0,
      tid
    ).run();
    return json({ success: true, id: result.meta && result.meta.last_row_id, mensaje: "Servicio creado" });
  }

  const srvMatch = path.match(/^\/api\/tenant\/servicios\/(\d+)$/);
  if (srvMatch && method === "PUT") {
    const sid = parseInt(srvMatch[1], 10);
    const body = await readJson(request);
    const sets = [];
    const vals = [];
    for (const f of SERVICIO_FIELDS) {
      if (body[f] === undefined) continue;
      const v = servicioValue(f, body[f]);
      if (f === "nombre" && !v) return jsonError("Nombre del servicio requerido", 400);
      sets.push(`${f} = ?`);
      vals.push(v);
    }
    if (!sets.length) return jsonError("Nada que actualizar", 400);
    const r = await env.DB.prepare(
      `UPDATE sgc_cit_servicios_unificados SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`
    ).bind(...vals, sid, tid).run();
    if (!(r.meta && r.meta.changes)) return jsonError("Servicio no encontrado en este tenant", 404);
    return json({ success: true, mensaje: "Servicio actualizado" });
  }

  if (srvMatch && method === "DELETE") {
    // Soft-delete: preserva la integridad de las citas históricas
    const r = await env.DB.prepare(
      "UPDATE sgc_cit_servicios_unificados SET activo = 0, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?"
    ).bind(parseInt(srvMatch[1], 10), tid).run();
    if (!(r.meta && r.meta.changes)) return jsonError("Servicio no encontrado en este tenant", 404);
    return json({ success: true, mensaje: "Servicio desactivado" });
  }

  if (path === "/api/tenant/horarios" && method === "GET") {
    const [byDay, config] = await Promise.all([getHorarios(env, tid), getConfig(env, tid)]);
    const horarios = DIAS.map((d) => byDay[d]
      ? { dia_semana: d, hora_apertura: byDay[d].hora_apertura, hora_cierre: byDay[d].hora_cierre, intervalo_minutos: byDay[d].intervalo_minutos || 30, activo: byDay[d].activo ? 1 : 0 }
      : { dia_semana: d, hora_apertura: "09:00", hora_cierre: "18:00", intervalo_minutos: 30, activo: 0 });
    return json({ success: true, horarios, config });
  }

  if (path === "/api/tenant/horarios" && method === "PUT") {
    const body = await readJson(request);
    const stmts = [];
    if (Array.isArray(body.horarios)) {
      for (const h of body.horarios) {
        if (!DIAS.includes(h.dia_semana)) return jsonError(`Día inválido: ${h.dia_semana}`, 400);
        const ap = normalizeHora(h.hora_apertura);
        const ci = normalizeHora(h.hora_cierre);
        const activo = Number(h.activo) ? 1 : 0;
        if (activo && (!ap || !ci || ap >= ci)) return jsonError(`Horario inválido para ${h.dia_semana}`, 400);
        const intervalo = [15, 20, 30, 45, 60].includes(Number(h.intervalo_minutos)) ? Number(h.intervalo_minutos) : 30;
        stmts.push(env.DB.prepare("DELETE FROM sgc_cit_horarios WHERE tenant_id = ? AND dia_semana = ?").bind(tid, h.dia_semana));
        stmts.push(env.DB.prepare(
          "INSERT INTO sgc_cit_horarios (dia_semana, hora_apertura, hora_cierre, intervalo_minutos, activo, tenant_id) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(h.dia_semana, ap || "09:00", ci || "18:00", intervalo, activo, tid));
      }
    }
    if (body.config && typeof body.config === "object") {
      for (const k of CONFIG_KEYS) {
        if (body.config[k] === undefined) continue;
        const n = parseInt(body.config[k], 10);
        if (!Number.isFinite(n) || n < 0 || n > 1000) return jsonError(`Valor inválido para ${k}`, 400);
        stmts.push(env.DB.prepare("DELETE FROM sgc_cit_config WHERE tenant_id = ? AND clave = ?").bind(tid, k));
        stmts.push(env.DB.prepare("INSERT INTO sgc_cit_config (clave, valor, tenant_id) VALUES (?, ?, ?)").bind(k, String(n), tid));
      }
    }
    if (!stmts.length) return jsonError("Nada que actualizar", 400);
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      if (/UNIQUE|PRIMARY/i.test(String(e.message))) {
        return jsonError("La configuración por negocio requiere aplicar la migración 0003 en D1", 409);
      }
      throw e;
    }
    return json({ success: true, mensaje: "Horarios actualizados" });
  }

  return jsonError("Ruta no encontrada", 404);
}
