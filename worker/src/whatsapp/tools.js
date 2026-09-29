// ============================================================
// Tools que la IA puede invocar desde WhatsApp. Todas operan sobre
// el tenant de la conversación y el teléfono real del remitente.
// ============================================================

import { validarSlot } from "../lib/schedule.js";
import { hoyChile, normalizeHora } from "../lib/time.js";
import { normalizeText } from "./format.js";
import { updateClientContext } from "./conversation.js";

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "agendar_cita",
      description: "Agenda una cita nueva. SOLO llamar cuando el cliente haya confirmado explícitamente (sí, confirmo, dale, ok).",
      parameters: {
        type: "object",
        properties: {
          fecha: { type: "string", description: "Fecha en formato YYYY-MM-DD" },
          hora: { type: "string", description: "Hora en formato HH:MM (24h)" },
          servicio: { type: "string", description: "Nombre exacto del servicio de la lista" },
          patente: { type: "string", description: "Patente del vehículo (solo talleres, opcional)" },
          marca: { type: "string", description: "Marca del vehículo (opcional)" },
          modelo: { type: "string", description: "Modelo del vehículo (opcional)" }
        },
        required: ["fecha", "hora", "servicio"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "verificar_disponibilidad",
      description: "Verifica si un horario está disponible antes de confirmar la cita",
      parameters: {
        type: "object",
        properties: {
          fecha: { type: "string", description: "YYYY-MM-DD" },
          hora: { type: "string", description: "HH:MM" }
        },
        required: ["fecha", "hora"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "consultar_citas_cliente",
      description: "Consulta las citas futuras del cliente que está escribiendo",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "cancelar_cita",
      description: "Cancela una cita existente del cliente",
      parameters: {
        type: "object",
        properties: { cita_id: { type: "number", description: "ID de la cita a cancelar" } },
        required: ["cita_id"]
      }
    }
  }
];

// Busca el servicio del tenant que mejor coincide con lo que dijo la IA
export function matchServicio(servicios, nombre) {
  const n = normalizeText(nombre).trim();
  if (!n) return null;
  return servicios.find((s) => normalizeText(s.nombre) === n)
    || servicios.find((s) => normalizeText(s.nombre).includes(n) || n.includes(normalizeText(s.nombre)))
    || null;
}

function digits(s) {
  return String(s || "").replace(/[^0-9]/g, "");
}

export async function executeTool(env, ctx, toolName, params = {}) {
  const { tenant, conversation, servicios } = ctx;
  try {
    if (toolName === "agendar_cita") {
      const servicio = matchServicio(servicios, params.servicio);
      const nombreServicio = servicio ? servicio.nombre : String(params.servicio || "").trim();
      if (!nombreServicio) return { success: false, error: "Falta el servicio" };
      const duracion = (servicio && servicio.duracion_minutos) || 60;
      const hora = normalizeHora(params.hora);

      // Idempotencia: si la IA repite la llamada, no duplicar la cita
      const existente = await env.DB.prepare(
        "SELECT id FROM sgc_cit_Citas WHERE tenant_id = ? AND telefono = ? AND fecha_cita = ? AND hora_cita = ? AND estado NOT IN ('cancelada', 'no_asistio')"
      ).bind(tenant.id, conversation.phone, params.fecha, hora).first();
      if (existente) return { success: true, cita_id: existente.id, fecha: params.fecha, hora, servicio: nombreServicio, ya_existia: true };

      const v = await validarSlot(env, tenant.id, params.fecha, params.hora, { duracion });
      if (!v.ok) return { success: false, error: v.error };

      const patente = params.patente ? String(params.patente).toUpperCase().replace(/[^A-Z0-9]/g, "") : null;
      const result = await env.DB.prepare(
        "INSERT INTO sgc_cit_Citas (fecha_cita, hora_cita, servicio, duracion_minutos, estado, nombre_cliente, telefono, patente, marca, modelo, canal, tipo_atencion, estado_aprobacion, tenant_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?, 'whatsapp', ?, 'pendiente', ?, datetime('now','-3 hours'), datetime('now','-3 hours'))"
      ).bind(
        v.fecha, v.hora, nombreServicio, duracion,
        conversation.contact_name || "", conversation.phone,
        patente, params.marca || null, params.modelo || null,
        servicio && servicio.es_domicilio ? "domicilio" : "taller",
        tenant.id
      ).run();

      await updateClientContext(env, conversation, {
        patente, marca: params.marca, modelo: params.modelo, nombre: conversation.contact_name
      });
      return { success: true, cita_id: result.meta && result.meta.last_row_id, fecha: v.fecha, hora: v.hora, servicio: nombreServicio };
    }

    if (toolName === "verificar_disponibilidad") {
      const v = await validarSlot(env, tenant.id, params.fecha, params.hora);
      return { success: true, disponible: v.ok, motivo: v.ok ? "disponible" : v.error };
    }

    if (toolName === "consultar_citas_cliente") {
      // Siempre el teléfono del remitente: nunca se consultan citas de terceros
      const res = await env.DB.prepare(
        "SELECT id, fecha_cita, hora_cita, servicio, estado, estado_aprobacion FROM sgc_cit_Citas " +
        "WHERE tenant_id = ? AND REPLACE(REPLACE(REPLACE(telefono, '+', ''), ' ', ''), '-', '') = ? " +
        "AND estado NOT IN ('cancelada', 'no_asistio') AND fecha_cita >= ? ORDER BY fecha_cita ASC, hora_cita ASC LIMIT 10"
      ).bind(tenant.id, digits(conversation.phone), hoyChile()).all();
      return { success: true, citas: res.results || [] };
    }

    if (toolName === "cancelar_cita") {
      const citaId = parseInt(params.cita_id, 10);
      if (!Number.isFinite(citaId)) return { success: false, error: "Indica el número de la cita a cancelar" };
      const cita = await env.DB.prepare(
        "SELECT id, telefono, estado FROM sgc_cit_Citas WHERE id = ? AND tenant_id = ?"
      ).bind(citaId, tenant.id).first();
      if (!cita || digits(cita.telefono) !== digits(conversation.phone)) return { success: false, error: "No encontré esa cita a tu nombre" };
      if (cita.estado === "cancelada") return { success: false, error: "Esa cita ya estaba cancelada" };
      await env.DB.prepare(
        "UPDATE sgc_cit_Citas SET estado = 'cancelada', estado_aprobacion = 'cancelada', updated_at = datetime('now','-3 hours') WHERE id = ? AND tenant_id = ?"
      ).bind(citaId, tenant.id).run();
      return { success: true, cita_id: citaId };
    }

    return { success: false, error: "Función desconocida: " + toolName };
  } catch (error) {
    console.error("Error en executeTool:", toolName, error);
    return { success: false, error: "No pude completar la operación, intenta de nuevo" };
  }
}
