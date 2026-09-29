// ============================================================
// Conversaciones y mensajes de WhatsApp (por tenant)
// ============================================================

export async function getOrCreateConversation(env, tenantId, phone, pushName) {
  const select = () => env.DB.prepare(
    "SELECT * FROM sgc_cit_WhatsApp_conversations WHERE phone = ? AND tenant_id = ?"
  ).bind(phone, tenantId).first();

  let conv = await select();
  if (conv) {
    if (pushName && pushName !== conv.contact_name) {
      await env.DB.prepare("UPDATE sgc_cit_WhatsApp_conversations SET contact_name = ? WHERE id = ?").bind(pushName, conv.id).run();
      conv.contact_name = pushName;
    }
    return conv;
  }
  try {
    await env.DB.prepare(
      "INSERT INTO sgc_cit_WhatsApp_conversations (phone, contact_name, tenant_id) VALUES (?, ?, ?)"
    ).bind(phone, pushName || "", tenantId).run();
  } catch (e) {
    // Esquema antiguo: phone era UNIQUE global, así que un cliente que ya habló
    // con otro negocio no puede tener conversación aquí. Se responde igual, sin
    // historial persistente, hasta aplicar la migración 0001.
    if (/UNIQUE/i.test(String(e && e.message))) {
      console.error("Conversación no persistida (falta migración 0001_conversations_unique_por_tenant):", phone, tenantId);
      return { id: null, phone, tenant_id: tenantId, contact_name: pushName || "", client_context: null, status: "active", ephemeral: true };
    }
    throw e;
  }
  conv = await select();
  return conv;
}

export async function getHistory(env, conversationId, limit = 6) {
  if (!conversationId) return [];
  const res = await env.DB.prepare(
    "SELECT direction, content FROM sgc_cit_WhatsApp_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?"
  ).bind(conversationId, limit).all();
  return (res.results || []).reverse().map((m) => ({
    role: m.direction === "inbound" ? "user" : "assistant",
    content: m.content
  }));
}

export async function saveMessages(env, conversation, userMsg, botMsg, tool = {}) {
  if (!conversation || !conversation.id) return;
  const tid = conversation.tenant_id;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sgc_cit_WhatsApp_messages (conversation_id, direction, content, tenant_id) VALUES (?, 'inbound', ?, ?)"
    ).bind(conversation.id, userMsg, tid),
    env.DB.prepare(
      "INSERT INTO sgc_cit_WhatsApp_messages (conversation_id, direction, content, tool_used, tool_input, tool_result, tenant_id) VALUES (?, 'outbound', ?, ?, ?, ?, ?)"
    ).bind(conversation.id, botMsg, tool.used || null, tool.input || null, tool.result || null, tid),
    env.DB.prepare(
      "UPDATE sgc_cit_WhatsApp_conversations SET last_message_at = datetime('now','-3 hours'), last_user_message = ?, last_bot_message = ?, total_messages = total_messages + 2 WHERE id = ?"
    ).bind(userMsg.slice(0, 500), botMsg.slice(0, 500), conversation.id)
  ]);
}

export async function updateClientContext(env, conversation, patch) {
  if (!conversation || !conversation.id) return;
  let ctx = {};
  try { ctx = JSON.parse(conversation.client_context || "{}") || {}; } catch (e) { ctx = {}; }
  for (const [k, v] of Object.entries(patch)) if (v) ctx[k] = v;
  const value = JSON.stringify(ctx);
  conversation.client_context = value;
  await env.DB.prepare("UPDATE sgc_cit_WhatsApp_conversations SET client_context = ? WHERE id = ?").bind(value, conversation.id).run();
}
