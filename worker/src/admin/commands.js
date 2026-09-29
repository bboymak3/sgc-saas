// ============================================================
// Comandos del admin de la plataforma vía WhatsApp y ciclo de vida
// de los tenants (aprobar, activar, suspender, enlaces de acceso).
//
// Solo llegan aquí mensajes que pasaron la verificación del webhook
// (WEBHOOK_SECRET), vienen de ADMIN_PHONE y entran por la instancia
// de la plataforma.
// ============================================================

import { sendText, sendImage, platformInstance, instanceNameForSlug, createInstance, setWebhook, getQr, cleanPhone } from "../lib/evolution.js";
import { tenantPanelKey } from "../lib/auth.js";
import { getTenantBySlug } from "../lib/tenant.js";
import { loadDefaultServices } from "../onboarding.js";

const COMMANDS = ["APROBAR", "APROBADO", "RECHAZAR", "RECHAZADO", "LISTAR", "LISTA", "PENDIENTES", "ACTIVOS", "ACTIVO",
  "SUSPENDER", "REACTIVAR", "LINK", "SYNC", "AYUDA", "HELP", "COMANDOS"];

function parseCommand(text) {
  const parts = String(text || "").trim().split(/\s+/);
  const cmd = (parts[0] || "").toUpperCase().replace(/[.:!]+$/, "");
  const slug = (parts[1] || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return { cmd, slug };
}

export function isAdminCommand(text) {
  return COMMANDS.includes(parseCommand(text).cmd);
}

export function panelUrl(env) {
  return env.PANEL_URL || "https://sgc-saas.pages.dev";
}

export async function panelLinks(env, slug) {
  const key = await tenantPanelKey(env, slug);
  const base = panelUrl(env);
  // La clave va en el fragmento (#k=): no se envía al servidor ni queda en logs
  return {
    panel: key ? `${base}/admin?t=${encodeURIComponent(slug)}#k=${key}` : `${base}/admin?t=${encodeURIComponent(slug)}`,
    status: key ? `${base}/status?slug=${encodeURIComponent(slug)}#k=${key}` : `${base}/status?slug=${encodeURIComponent(slug)}`,
    chat: `${base}/chat?t=${encodeURIComponent(slug)}`
  };
}

async function logCommand(env, command, slug, adminPhone, result) {
  await env.DB.prepare(
    "INSERT INTO admin_commands (command, slug, admin_phone, result) VALUES (?, ?, ?, ?)"
  ).bind(command, slug || null, adminPhone, String(result).slice(0, 500)).run();
}

async function waitMs(env, ms) {
  if (env.__TEST_NO_WAIT) return;
  await new Promise((r) => setTimeout(r, ms));
}

// Envía al dueño del negocio el enlace privado de su panel
export async function sendPanelLink(env, tenant) {
  if (!tenant.whatsapp_number) return { success: false, error: "El tenant no tiene WhatsApp registrado" };
  const links = await panelLinks(env, tenant.slug);
  return await sendText(env, platformInstance(env), tenant.whatsapp_number,
    `🔐 *Acceso al panel de ${tenant.business_name}*\n\n` +
    `Desde aquí ves y apruebas tus citas y editas tus servicios y horarios:\n${links.panel}\n\n` +
    `Este enlace es privado: no lo compartas.`);
}

export async function approveTenant(env, tenant) {
  if (tenant.status === "active") return { ok: false, reply: `⚠️ El tenant "${tenant.slug}" ya está activo.` };

  await env.DB.prepare(
    "UPDATE tenants SET status = 'approved', approved_at = datetime('now','-3 hours') WHERE id = ?"
  ).bind(tenant.id).run();

  const instanceName = tenant.evolution_instance || instanceNameForSlug(tenant.slug);
  let instanceOk = false;
  let qr = null;
  try {
    const created = await createInstance(env, instanceName, tenant.slug);
    // Si ya existía (re-aprobación), solo se actualiza su webhook
    instanceOk = created.success || (await setWebhook(env, instanceName, tenant.slug)).success;
    if (instanceOk) {
      for (let attempt = 1; attempt <= 3 && !qr; attempt++) {
        await waitMs(env, 4000);
        qr = await getQr(env, instanceName).catch(() => null);
      }
    }
  } catch (e) {
    console.error("Error creando instancia Evolution:", e);
  }
  await env.DB.prepare("UPDATE tenants SET evolution_instance = ? WHERE id = ?").bind(instanceName, tenant.id).run();

  const cargados = await loadDefaultServices(env, tenant.id, tenant.rubro || "otro");
  const links = await panelLinks(env, tenant.slug);

  let qrEnviado = false;
  if (tenant.whatsapp_number) {
    const to = cleanPhone(tenant.whatsapp_number);
    await sendText(env, platformInstance(env), to,
      `🎉 ¡Tu bot está casi listo, ${tenant.business_name}!\n\n` +
      `Para activarlo vincula el WhatsApp del negocio:\n` +
      `1. Abre WhatsApp → Configuración → Dispositivos vinculados → Vincular dispositivo\n` +
      `2. Escanea el QR que te envío a continuación\n\n` +
      `Si el QR expira, genera uno nuevo aquí:\n${links.status}`);
    if (qr) {
      const r = await sendImage(env, platformInstance(env), to, qr, `📱 QR para activar el bot de ${tenant.business_name}`);
      qrEnviado = r.success;
    }
    await sendPanelLink(env, { ...tenant, evolution_instance: instanceName });
  }

  const reply = `✅ *Tenant aprobado: ${tenant.business_name}*\n\n` +
    `Slug: ${tenant.slug}\nRubro: ${tenant.rubro || "otro"}\nWhatsApp: ${tenant.whatsapp_number || "no configurado"}\n` +
    `Instancia Evolution: ${instanceName} ${instanceOk ? "✅" : "⚠️ (revisar Evolution)"}\n` +
    `Servicios default: ${cargados.servicios ? cargados.servicios + " cargados" : "ya existían"}\n` +
    `QR: ${qrEnviado ? "enviado como imagen ✅" : "no enviado, el cliente puede verlo en su página de estado"}`;
  return { ok: true, reply, instanceName };
}

// Evolution avisa connection.update con state=open cuando el cliente escanea el QR
export async function onTenantConnected(env, tenant) {
  if (tenant.status !== "approved") return;
  await env.DB.prepare(
    "UPDATE tenants SET status = 'active', active_at = datetime('now','-3 hours') WHERE id = ? AND status = 'approved'"
  ).bind(tenant.id).run();
  if (tenant.whatsapp_number) {
    await sendText(env, platformInstance(env), tenant.whatsapp_number,
      `✅ *¡${tenant.business_name}, tu bot ya está activo!*\n\nPrueba escribiéndole "Hola" al WhatsApp del negocio desde otro teléfono.`);
  }
  if (env.ADMIN_PHONE) {
    await sendText(env, platformInstance(env), env.ADMIN_PHONE, `🟢 Tenant activo: ${tenant.business_name} (${tenant.slug})`);
  }
}

export async function syncWebhooks(env) {
  const res = await env.DB.prepare(
    "SELECT slug, evolution_instance FROM tenants WHERE evolution_instance IS NOT NULL AND evolution_instance != '' AND status IN ('active','approved')"
  ).all();
  const results = [];
  for (const t of res.results || []) {
    const r = await setWebhook(env, t.evolution_instance, t.slug);
    results.push({ slug: t.slug, instance: t.evolution_instance, ok: r.success, error: r.error || null });
  }
  return results;
}

export async function handleAdminCommand(env, adminPhone, text) {
  const { cmd, slug } = parseCommand(text);
  let reply = "";
  const needsSlug = ["APROBAR", "APROBADO", "RECHAZAR", "RECHAZADO", "SUSPENDER", "REACTIVAR", "LINK"].includes(cmd);
  const tenant = needsSlug && slug ? await getTenantBySlug(env, slug) : null;

  if (needsSlug && !slug) {
    reply = `Falta el slug. Ejemplo: *${cmd} barberia-don-juan*`;
  } else if (needsSlug && !tenant) {
    reply = `❌ No se encontró el tenant "${slug}".\n\nUsa *LISTAR* para ver pendientes.`;
  } else if (cmd === "APROBAR" || cmd === "APROBADO") {
    const r = await approveTenant(env, tenant);
    reply = r.reply;
    if (r.ok) await logCommand(env, "APROBAR", slug, adminPhone, "approved");
  } else if (cmd === "RECHAZAR" || cmd === "RECHAZADO") {
    await env.DB.prepare("UPDATE tenants SET status = 'rejected' WHERE id = ?").bind(tenant.id).run();
    reply = `🚫 Tenant rechazado: ${tenant.business_name} (${slug})`;
    await logCommand(env, "RECHAZAR", slug, adminPhone, "rejected");
  } else if (cmd === "SUSPENDER") {
    await env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(tenant.id).run();
    reply = `⏸️ Tenant suspendido: ${tenant.business_name} (${slug}). El bot dejará de responder.`;
    await logCommand(env, "SUSPENDER", slug, adminPhone, "suspended");
  } else if (cmd === "REACTIVAR") {
    const nuevo = tenant.active_at ? "active" : "approved";
    await env.DB.prepare("UPDATE tenants SET status = ? WHERE id = ?").bind(nuevo, tenant.id).run();
    reply = `▶️ Tenant reactivado: ${tenant.business_name} (${slug}) → ${nuevo}`;
    await logCommand(env, "REACTIVAR", slug, adminPhone, nuevo);
  } else if (cmd === "LINK") {
    const r = await sendPanelLink(env, tenant);
    reply = r.success ? `🔐 Enlace del panel enviado a ${tenant.business_name}.` : `⚠️ No se pudo enviar: ${r.error}`;
  } else if (cmd === "SYNC") {
    const results = await syncWebhooks(env);
    reply = `🔄 *Webhooks reconfigurados (${results.length}):*\n\n` +
      (results.map((r) => `${r.ok ? "✅" : "❌"} ${r.slug} (${r.instance})${r.error ? " — " + r.error : ""}`).join("\n") || "Sin instancias");
  } else if (cmd === "LISTAR" || cmd === "LISTA" || cmd === "PENDIENTES") {
    const res = await env.DB.prepare(
      "SELECT slug, business_name, whatsapp_number, rubro, created_at FROM tenants WHERE status = 'pending_approval' ORDER BY created_at DESC LIMIT 20"
    ).all();
    const rows = res.results || [];
    reply = rows.length
      ? `📋 *Tenants pendientes (${rows.length}):*\n\n` + rows.map((t) =>
        `• *${t.slug}*\n  ${t.business_name} | ${t.rubro} | ${t.whatsapp_number}\n  Creado: ${t.created_at}\n  Aprobar: APROBAR ${t.slug}`).join("\n\n")
      : "✅ No hay tenants pendientes de aprobación.";
  } else if (cmd === "ACTIVOS" || cmd === "ACTIVO") {
    const res = await env.DB.prepare(
      "SELECT slug, business_name, whatsapp_number, rubro, status FROM tenants WHERE status IN ('active','approved') ORDER BY id ASC LIMIT 50"
    ).all();
    const rows = res.results || [];
    reply = rows.length
      ? `✅ *Tenants operativos (${rows.length}):*\n\n` + rows.map((t) => `• ${t.business_name} (${t.slug}) — ${t.status}\n  ${t.rubro} | ${t.whatsapp_number || "-"}`).join("\n\n")
      : "No hay tenants operativos todavía.";
  } else {
    reply = `🤖 *Comandos admin SGC-SaaS:*\n\n` +
      `*LISTAR* - Ver pendientes\n*ACTIVOS* - Ver tenants operativos\n` +
      `*APROBAR <slug>* - Aprobar y crear bot\n*RECHAZAR <slug>* - Rechazar solicitud\n` +
      `*SUSPENDER <slug>* - Suspender bot\n*REACTIVAR <slug>* - Reactivar bot\n` +
      `*LINK <slug>* - Reenviar enlace del panel al dueño\n*SYNC* - Reconfigurar webhooks de todas las instancias\n` +
      `*AYUDA* - Esta ayuda`;
  }

  await sendText(env, platformInstance(env), adminPhone, reply);
  return reply;
}
