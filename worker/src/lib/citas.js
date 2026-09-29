// ============================================================
// Operaciones de citas compartidas (panel del tenant + endpoints legacy)
// ============================================================

import { sendText, instanceForTenant } from "./evolution.js";
import { asegurarOrdenParaCita } from "./ordenes.js";
import { formatDateSpanish } from "./time.js";

export async function getCita(env, tenantId, citaId) {
  return await env.DB.prepare("SELECT * FROM sgc_cit_Citas WHERE id = ? AND tenant_id = ?").bind(citaId, tenantId).first();
}

export async function listCitas(env, tenantId, { estado = "", limit = 100, canal = null, hoy = null } = {}) {
  let query = "SELECT * FROM sgc_cit_Citas WHERE tenant_id = ?";
  const params = [tenantId];
  if (canal) { query += " AND canal = ?"; params.push(canal); }
  if (estado === "pendiente") query += " AND (estado_aprobacion = 'pendiente' OR estado_aprobacion IS NULL)";
  else if (estado === "aprobada") query += " AND estado_aprobacion = 'aprobada'";
  else if (estado === "rechazada") query += " AND estado_aprobacion = 'rechazada'";
  else if (estado === "hoy" && hoy) { query += " AND fecha_cita = ?"; params.push(hoy); }
  query += " ORDER BY created_at DESC LIMIT ?";
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
  const citas = await env.DB.prepare(query).bind(...params).all();

  const base = "SELECT COUNT(*) AS c FROM sgc_cit_Citas WHERE tenant_id = ?" + (canal ? " AND canal = ?" : "");
  const b = canal ? [tenantId, canal] : [tenantId];
  const [total, pendientes, aprobadas, rechazadas] = await Promise.all([
    env.DB.prepare(base).bind(...b).first(),
    env.DB.prepare(base + " AND (estado_aprobacion = 'pendiente' OR estado_aprobacion IS NULL)").bind(...b).first(),
    env.DB.prepare(base + " AND estado_aprobacion = 'aprobada'").bind(...b).first(),
    env.DB.prepare(base + " AND estado_aprobacion = 'rechazada'").bind(...b).first()
  ]);
  return {
    citas: citas.results || [],
    stats: {
      total: (total && total.c) || 0,
      pendientes: (pendientes && pendientes.c) || 0,
      aprobadas: (aprobadas && aprobadas.c) || 0,
      rechazadas: (rechazadas && rechazadas.c) || 0
    }
  };
}

function firma(tenant) {
  const phone = tenant.business_phone || tenant.whatsapp_number;
  return `*${tenant.business_name}*` + (phone ? `\n📞 +${String(phone).replace(/[^0-9]/g, "")}` : "");
}

export async function aprobarCita(env, tenant, citaId) {
  const cita = await getCita(env, tenant.id, citaId);
  if (!cita) return { success: false, status: 404, error: "Cita no encontrada en este tenant" };
  await env.DB.prepare(
    "UPDATE sgc_cit_Citas SET estado_aprobacion = 'aprobada', estado = 'confirmada', updated_at = datetime('now') WHERE id = ? AND tenant_id = ?"
  ).bind(citaId, tenant.id).run();

  const orden = await asegurarOrdenParaCita(env, cita);
  const numeroOt = orden.numero || cita.numero_orden_sgc;

  let notificado = false;
  if (cita.telefono) {
    const lineas = [
      "✅ *Tu cita ha sido APROBADA*",
      "",
      `🗓️ Fecha: ${formatDateSpanish(cita.fecha_cita)}`,
      `⏰ Hora: ${cita.hora_cita}`,
      `📋 Servicio: ${cita.servicio}`
    ];
    if (cita.patente) lineas.push(`🚗 Vehículo: ${[cita.patente, cita.marca, cita.modelo].filter(Boolean).join(" ")}`);
    if (numeroOt) lineas.push(`🧾 Orden de trabajo: EXP${String(numeroOt).padStart(6, "0")}`);
    lineas.push("", "Te esperamos. " + firma(tenant));
    const r = await sendText(env, instanceForTenant(env, tenant), cita.telefono, lineas.join("\n"));
    notificado = r.success;
  }
  return { success: true, notificado, orden_creada: !!orden.creada, numero_orden: numeroOt || null };
}

export async function rechazarCita(env, tenant, citaId, motivo) {
  const cita = await getCita(env, tenant.id, citaId);
  if (!cita) return { success: false, status: 404, error: "Cita no encontrada en este tenant" };
  const motivoFinal = String(motivo || "No especificado").slice(0, 500);
  await env.DB.prepare(
    "UPDATE sgc_cit_Citas SET estado_aprobacion = 'rechazada', estado = 'cancelada', motivo_rechazo = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?"
  ).bind(motivoFinal, citaId, tenant.id).run();
  let notificado = false;
  if (cita.telefono) {
    const msg = [
      "❌ *Tu cita no pudo ser confirmada*",
      "",
      `📋 Servicio: ${cita.servicio}`,
      `🗓️ Fecha: ${formatDateSpanish(cita.fecha_cita)} ${cita.hora_cita || ""}`.trim(),
      `Motivo: ${motivoFinal}`,
      "",
      "Escríbenos por aquí para buscar otro horario. " + firma(tenant)
    ].join("\n");
    const r = await sendText(env, instanceForTenant(env, tenant), cita.telefono, msg);
    notificado = r.success;
  }
  return { success: true, notificado };
}
