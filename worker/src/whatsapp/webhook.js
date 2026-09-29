// ============================================================
// Webhook de Evolution API v2
// ============================================================

import { verifyWebhook } from "../lib/auth.js";
import { ok, jsonError } from "../lib/http.js";
import { resolveTenantForWebhook, isOperational } from "../lib/tenant.js";
import { sendText, sendLongText, instanceForTenant, platformInstance } from "../lib/evolution.js";
import { describeHorario } from "../lib/schedule.js";
import { formatDateSpanish } from "../lib/time.js";
import { buildWhatsAppSystemPrompt, formatServicios } from "./prompt.js";
import { getOrCreateConversation, getHistory, saveMessages } from "./conversation.js";
import { TOOLS, executeTool } from "./tools.js";
import { parseCitaFromHistory } from "./parser.js";
import { formatForWhatsApp, normalizeText } from "./format.js";
import { isAdminCommand, handleAdminCommand, onTenantConnected } from "../admin/commands.js";

export const MODEL_ID = "@cf/meta/llama-3.2-3b-instruct";

function normalizeEvent(ev) {
  return String(ev || "").toLowerCase().replace(/_/g, ".");
}

export function extractText(message) {
  const msg = message || {};
  return String(
    msg.conversation
    || (msg.extendedTextMessage && msg.extendedTextMessage.text)
    || (msg.imageMessage && msg.imageMessage.caption)
    || (msg.videoMessage && msg.videoMessage.caption)
    || ""
  ).trim();
}

// Workers AI puede devolver tool_calls en la raíz o en formato OpenAI
function toolCallsOf(aiResponse) {
  if (!aiResponse) return [];
  if (Array.isArray(aiResponse.tool_calls) && aiResponse.tool_calls.length) return aiResponse.tool_calls;
  const c = aiResponse.choices && aiResponse.choices[0] && aiResponse.choices[0].message;
  return (c && Array.isArray(c.tool_calls)) ? c.tool_calls : [];
}

function parseArgs(call) {
  const raw = (call.function && call.function.arguments) || call.arguments || call.parameters;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    const m = raw.match(/\{[\s\S]*\}/);
    try { return m ? JSON.parse(m[0]) : {}; } catch (e2) { return {}; }
  }
}

function confirmacionCita(p) {
  return `*¡Cita agendada con éxito!* ✅

🗓️ *Fecha:* ${formatDateSpanish(p.fecha)}
⏰ *Hora:* ${p.hora}
📋 *Servicio:* ${p.servicio}
${p.patente ? "🚗 *Vehículo:* " + p.patente + "\n" : ""}
Queda *pendiente de confirmación* por el negocio; te avisaremos por aquí. Si necesitas cambiarla, escríbeme 😊`;
}

// Se evalúa sobre texto normalizado (sin tildes): \b de JS no reconoce "í"
const USER_CONFIRMS = /\b(si|confirmo|dale|ok|okay|claro|perfecto|de acuerdo|agendala|agendalo|listo)\b/;
const BOT_ASKED_CONFIRM = /(confirmas|te agendo|agendar|reservar|tu cita)/i;

// Ejecuta trabajo lento después de responder 200 a Evolution (evita reintentos
// y respuestas duplicadas si la IA tarda)
function background(ctx, promise) {
  const p = promise.catch((e) => console.error("Error en tarea de webhook:", e));
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  return p;
}

export async function handleWhatsAppWebhook(request, env, url, ctx) {
  if (!verifyWebhook(request, env, url)) {
    return env.WEBHOOK_SECRET ? jsonError("No autorizado", 401) : jsonError("Webhook deshabilitado: falta WEBHOOK_SECRET", 503);
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return ok();
  }

  try {
    const event = normalizeEvent(body.event);
    const tenant = await resolveTenantForWebhook(env, body, url);

    if (event === "connection.update") {
      const state = body.data && (body.data.state || body.data.status);
      if (tenant && state === "open") background(ctx, onTenantConnected(env, tenant));
      return ok();
    }
    if (event !== "messages.upsert") return ok();

    const data = body.data || {};
    const key = data.key || {};
    if (key.fromMe === true) return ok();
    const remoteJid = key.remoteJid || "";
    if (!remoteJid.endsWith("@s.whatsapp.net")) return ok(); // grupos, broadcast, etc.
    const phone = remoteJid.replace("@s.whatsapp.net", "");
    const text = extractText(data.message);

    // Comandos del admin de la plataforma (solo por la instancia de la plataforma)
    if (env.ADMIN_PHONE && phone === env.ADMIN_PHONE && body.instance === platformInstance(env) && isAdminCommand(text)) {
      background(ctx, handleAdminCommand(env, phone, text));
      return ok();
    }

    // Sin tenant identificado o tenant no operativo (pendiente/suspendido/rechazado): no responder
    if (!isOperational(tenant)) {
      if (!tenant) console.warn("Webhook sin tenant identificado:", body.instance, url.searchParams.get("t"));
      return ok();
    }

    background(ctx, handleCustomerMessage(env, tenant, phone, data.pushName || "", text));
    return ok();
  } catch (error) {
    console.error("WhatsApp webhook error:", error);
    return ok(); // 200 para que Evolution no reintente en bucle
  }
}

export async function handleCustomerMessage(env, tenant, phone, pushName, text) {
  const instance = instanceForTenant(env, tenant);
  if (!text) {
    await sendText(env, instance, phone, "👋 ¡Hola! Por ahora solo puedo leer mensajes de texto. Escríbeme qué servicio necesitas y te ayudo a agendar.");
    return;
  }

  const conversation = await getOrCreateConversation(env, tenant.id, phone, pushName);
  if (conversation.status === "blocked") return;

  const [history, serviciosRes, horarioText] = await Promise.all([
    getHistory(env, conversation.id, 6),
    env.DB.prepare(
      "SELECT nombre, descripcion, duracion_minutos, precio, categoria, es_domicilio FROM sgc_cit_servicios_unificados WHERE activo = 1 AND tenant_id = ? ORDER BY orden ASC, id ASC"
    ).bind(tenant.id).all(),
    describeHorario(env, tenant.id)
  ]);
  const servicios = serviciosRes.results || [];
  const systemPrompt = buildWhatsAppSystemPrompt({
    tenant, serviciosText: formatServicios(servicios), horarioText, conversation, pushName
  });
  const chatMessages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: text }];
  const ctx = { tenant, conversation, servicios };

  let aiResponse = await env.AI.run(MODEL_ID, { messages: chatMessages, tools: TOOLS, max_tokens: 512 });
  let toolCalls = toolCallsOf(aiResponse);

  // Estrategia híbrida: el cliente confirma pero el modelo no llamó a la tool
  const lastBot = [...history].reverse().find((h) => h.role === "assistant");
  if (!toolCalls.length && USER_CONFIRMS.test(normalizeText(text)) && lastBot && BOT_ASKED_CONFIRM.test(lastBot.content)) {
    const forced = await env.AI.run(MODEL_ID, {
      messages: [
        { role: "system", content: systemPrompt + "\n\nIMPORTANTE: El cliente confirmó. Llama a agendar_cita AHORA con los datos de la conversación." },
        ...history,
        { role: "user", content: text }
      ],
      tools: TOOLS,
      tool_choice: { type: "function", function: { name: "agendar_cita" } },
      max_tokens: 512
    });
    toolCalls = toolCallsOf(forced);
    if (!toolCalls.length) {
      const parsed = parseCitaFromHistory(history, text, servicios.map((s) => s.nombre));
      if (parsed) toolCalls = [{ function: { name: "agendar_cita", arguments: JSON.stringify(parsed) } }];
    }
    if (toolCalls.length) aiResponse = forced;
  }

  let reply = "";
  const tool = {};
  for (const call of toolCalls) {
    const name = (call.function && call.function.name) || call.name;
    const params = parseArgs(call);
    const result = await executeTool(env, ctx, name, params);
    tool.used = name;
    tool.input = JSON.stringify(params);
    tool.result = JSON.stringify(result);

    if (name === "agendar_cita" && result.success) {
      reply = confirmacionCita({ ...params, fecha: result.fecha, hora: result.hora, servicio: result.servicio });
    } else if (name === "consultar_citas_cliente" && result.success) {
      reply = result.citas.length
        ? "*Tus próximas citas:*\n\n" + result.citas.map((c) => `• #${c.id} ${formatDateSpanish(c.fecha_cita)} a las ${c.hora_cita} — ${c.servicio} (${c.estado_aprobacion || c.estado})`).join("\n") + "\n\n¿Necesitas cambiar alguna? 😊"
        : "No tienes citas próximas. ¿Quieres agendar una? 😊";
    } else if (name === "cancelar_cita" && result.success) {
      reply = "Listo, tu cita fue cancelada ✅\n\nSi quieres reagendar, dime la fecha y hora que te acomode.";
    } else if (name === "verificar_disponibilidad") {
      // Segunda vuelta: el modelo redacta la respuesta con el resultado
      const follow = await env.AI.run(MODEL_ID, {
        messages: [
          ...chatMessages,
          { role: "assistant", content: aiResponse.response || "Verificando disponibilidad..." },
          { role: "user", content: `Resultado de verificar_disponibilidad: ${JSON.stringify(result)}. Responde al cliente según este resultado; si no está disponible, ofrece otro horario.` }
        ],
        max_tokens: 512
      });
      reply = follow.response || (result.disponible ? "¡Ese horario está disponible! ¿Confirmas la cita?" : `Ese horario no está disponible: ${result.motivo}. ¿Te acomoda otro?`);
    } else if (!result.success) {
      reply = `Lo siento, ${result.error} 😕\n\n¿Probamos con otro horario?`;
    }
    if (reply) break;
  }
  if (!reply) reply = aiResponse.response || "Lo siento, no pude procesar tu mensaje 😕 ¿Podrías repetirlo?";

  reply = formatForWhatsApp(reply);
  await sendLongText(env, instance, phone, reply);
  await saveMessages(env, conversation, text, reply, tool);
}
