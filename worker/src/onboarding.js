// ============================================================
// Onboarding SaaS: registro público, estado, QR y enlace de acceso
// ============================================================

import { json, jsonError, readJson } from "./lib/http.js";
import { hasTenantAccess } from "./lib/auth.js";
import { getTenantBySlug } from "./lib/tenant.js";
import { sendText, platformInstance, getQr, cleanPhone } from "./lib/evolution.js";
import { allowOnce, clientIp } from "./lib/ratelimit.js";

export const RUBROS_VALIDOS = ["taller", "barberia", "clinica_dental", "salon_belleza", "veterinaria", "otro"];

export function slugify(name) {
  return String(name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 30)
    .replace(/-$/, "");
}

export async function handleOnboardingRegister(request, env) {
  const body = await readJson(request);
  const businessName = String(body.business_name || "").trim().slice(0, 80);
  const whatsapp = cleanPhone(body.whatsapp_number);
  const email = body.email ? String(body.email).trim().slice(0, 120) : null;
  const rubro = RUBROS_VALIDOS.includes(body.rubro) ? body.rubro : "otro";

  if (!businessName || !whatsapp) return jsonError("Faltan campos requeridos: business_name, whatsapp_number", 400);
  if (whatsapp.length < 8 || whatsapp.length > 15) return jsonError("Número de WhatsApp inválido (incluye código de país)", 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError("Email inválido", 400);

  if (!(await allowOnce("register", clientIp(request), 60))) {
    return jsonError("Demasiadas solicitudes, intenta en un minuto", 429);
  }
  const pendiente = await env.DB.prepare(
    "SELECT slug FROM tenants WHERE REPLACE(whatsapp_number, '+', '') = ? AND status = 'pending_approval'"
  ).bind(whatsapp).first();
  if (pendiente) {
    return json({ success: true, slug: pendiente.slug, message: "Ya tienes una solicitud pendiente.", status_url: `${env.PANEL_URL || "https://sgc-saas.pages.dev"}/status?slug=${pendiente.slug}` });
  }

  const baseSlug = slugify(businessName) || "negocio";
  let slug = baseSlug;
  for (let suffix = 2; await getTenantBySlug(env, slug); suffix++) slug = `${baseSlug}-${suffix}`;

  const result = await env.DB.prepare(
    "INSERT INTO tenants (slug, business_name, whatsapp_number, business_phone, email, rubro, status) VALUES (?, ?, ?, ?, ?, ?, 'pending_approval')"
  ).bind(slug, businessName, whatsapp, whatsapp, email, rubro).run();

  if (env.ADMIN_PHONE) {
    await sendText(env, platformInstance(env), env.ADMIN_PHONE,
      `🔔 *Nueva solicitud de bot*\n\n📌 *Negocio:* ${businessName}\n📱 *WhatsApp:* ${whatsapp}\n📧 *Email:* ${email || "no informado"}\n🏷️ *Rubro:* ${rubro}\n🆔 *Slug:* ${slug}\n\n` +
      `Para aprobar responde:\n*APROBAR ${slug}*\n\nPara rechazar:\n*RECHAZAR ${slug}*`);
  }
  return json({
    success: true,
    slug,
    tenant_id: result.meta && result.meta.last_row_id,
    message: "Solicitud creada. Te avisaremos por WhatsApp cuando sea aprobada.",
    status_url: `${env.PANEL_URL || "https://sgc-saas.pages.dev"}/status?slug=${slug}`
  }, 201);
}

export async function handleOnboardingStatus(request, env, url) {
  const slug = url.searchParams.get("slug");
  if (!slug) return jsonError("slug requerido", 400);
  const tenant = await env.DB.prepare(
    "SELECT slug, business_name, status, evolution_instance, created_at, approved_at, active_at FROM tenants WHERE slug = ?"
  ).bind(slug).first();
  if (!tenant) return jsonError("Tenant no encontrado", 404);
  const qrAvailable = tenant.status === "approved" && !!tenant.evolution_instance;
  const { evolution_instance, ...publicTenant } = tenant;
  return json({ success: true, tenant: publicTenant, qr_available: qrAvailable });
}

// QR para vincular WhatsApp. Requiere la clave del tenant (llega por WhatsApp al aprobar).
export async function handleOnboardingQr(request, env, url) {
  const slug = url.searchParams.get("slug") || url.searchParams.get("t");
  if (!slug) return jsonError("slug requerido", 400);
  if (!(await hasTenantAccess(request, env, slug))) return jsonError("No autorizado", 401);
  const tenant = await getTenantBySlug(env, slug);
  if (!tenant) return jsonError("Tenant no encontrado", 404);
  if (tenant.status !== "approved" || !tenant.evolution_instance) {
    return jsonError(tenant.status === "active" ? "El bot ya está conectado" : "El bot aún no está aprobado", 409);
  }
  const qr = await getQr(env, tenant.evolution_instance);
  if (!qr) return jsonError("QR no disponible todavía, reintenta en unos segundos", 503);
  return json({ success: true, qr_base64: qr });
}

// El dueño pide que le reenvíen el enlace del panel: siempre se envía al
// WhatsApp registrado del tenant, nunca a un número elegido por quien llama.
export async function handleSendPanelLink(request, env, url, sendPanelLink) {
  const body = await readJson(request);
  const slug = String(body.t || body.slug || url.searchParams.get("t") || "").trim();
  const generic = json({ success: true, message: "Si el negocio existe, enviamos el enlace al WhatsApp registrado." });
  if (!slug) return jsonError("slug requerido", 400);
  if (!(await allowOnce("panel-link", slug, 300))) return generic;
  const tenant = await getTenantBySlug(env, slug);
  if (!tenant || !["active", "approved"].includes(tenant.status)) return generic;
  await sendPanelLink(env, tenant);
  return generic;
}

// ============================================================
// Servicios y horarios por defecto según rubro (idempotente)
// ============================================================

const DEFAULTS_BY_RUBRO = {
  taller: [
    ["Cambio de Aceite", 15000, 30, "Mantenimiento", "Cambio de aceite de motor y filtro"],
    ["Revisión General", 25000, 60, "Mantenimiento", "Revisión completa del vehículo"],
    ["Scanner Diagnóstico", 20000, 45, "Diagnóstico", "Diagnóstico computarizado de fallas"],
    ["Frenos", 35000, 90, "Reparación", "Revisión y reparación de frenos"],
    ["Revisión Eléctrica", 20000, 60, "Diagnóstico", "Diagnóstico del sistema eléctrico"],
    ["Aire Acondicionado", 25000, 60, "Servicio", "Revisión y carga de aire acondicionado"],
    ["Revisión Técnica", 30000, 45, "Inspección", "Pre-check antes de la revisión técnica"],
    ["Servicio a Domicilio", 50000, 120, "Servicio", "Traslado y atención a domicilio"]
  ],
  barberia: [
    ["Corte de Cabello", 8000, 30, "Cabello", "Corte tradicional o moderno"],
    ["Barba", 5000, 20, "Barba", "Perfilado y arreglo de barba"],
    ["Corte + Barba", 12000, 45, "Combo", "Corte completo + barba"],
    ["Corte Niño", 6000, 25, "Cabello", "Corte para menores de 12"],
    ["Tinte de Cabello", 15000, 60, "Color", "Coloración completa"],
    ["Cejas", 3000, 15, "Extras", "Perfilado de cejas"]
  ],
  clinica_dental: [
    ["Limpieza Dental", 25000, 45, "Higiene", "Profilaxis y limpieza profesional"],
    ["Consulta General", 15000, 30, "Consulta", "Evaluación y diagnóstico"],
    ["Empaste", 35000, 60, "Restauración", "Obturación de caries"],
    ["Endodoncia", 80000, 90, "Endodoncia", "Tratamiento de conducto"],
    ["Extracción", 30000, 45, "Cirugía", "Extracción dental simple"],
    ["Ortodoncia (consulta)", 20000, 60, "Ortodoncia", "Evaluación para brackets"],
    ["Blanqueamiento", 80000, 90, "Estética", "Blanqueamiento dental profesional"]
  ],
  salon_belleza: [
    ["Manicure", 10000, 45, "Uñas", "Manicure tradicional"],
    ["Pedicure", 12000, 60, "Uñas", "Pedicure completa"],
    ["Uñas Acrílicas", 20000, 90, "Uñas", "Extensión acrílica"],
    ["Corte y Peinado", 15000, 60, "Cabello", "Corte + peinado"],
    ["Tinte", 25000, 90, "Color", "Coloración"],
    ["Maquillaje Social", 20000, 60, "Maquillaje", "Maquillaje para eventos"],
    ["Depilación Cejas", 5000, 20, "Depilación", "Perfilado de cejas"]
  ],
  veterinaria: [
    ["Consulta General", 15000, 30, "Consulta", "Evaluación y diagnóstico"],
    ["Vacunación", 10000, 15, "Prevención", "Vacunas anuales"],
    ["Desparasitación", 8000, 15, "Prevención", "Tratamiento antiparasitario"],
    ["Esterilización", 45000, 120, "Cirugía", "Esterilización canina/felina"],
    ["Baño y Peluquería", 18000, 90, "Estética", "Baño + corte + limpieza"],
    ["Control Sano", 10000, 30, "Consulta", "Chequeo general"]
  ],
  otro: [
    ["Consulta General", 15000, 30, "General", "Consulta estándar"],
    ["Servicio Premium", 35000, 60, "Premium", "Servicio premium"]
  ]
};

export const DEFAULT_HORARIOS = [
  ["lunes", "09:00", "18:00", 1], ["martes", "09:00", "18:00", 1], ["miercoles", "09:00", "18:00", 1],
  ["jueves", "09:00", "18:00", 1], ["viernes", "09:00", "18:00", 1], ["sabado", "09:00", "14:00", 1],
  ["domingo", "09:00", "14:00", 0]
];

export async function loadDefaultServices(env, tenantId, rubro) {
  const loaded = { servicios: 0, horarios: 0 };
  const [srv, hor] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS c FROM sgc_cit_servicios_unificados WHERE tenant_id = ?").bind(tenantId).first(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM sgc_cit_horarios WHERE tenant_id = ?").bind(tenantId).first()
  ]);
  const stmts = [];
  if (!srv || srv.c === 0) {
    const services = DEFAULTS_BY_RUBRO[rubro] || DEFAULTS_BY_RUBRO.otro;
    services.forEach(([nombre, precio, duracion, categoria, descripcion], i) => {
      const esDomicilio = /domicilio/i.test(nombre) ? 1 : 0;
      stmts.push(env.DB.prepare(
        "INSERT INTO sgc_cit_servicios_unificados (nombre, descripcion, duracion_minutos, precio, categoria, activo, orden, requiere_vehiculo, es_domicilio, origen, tenant_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'default', ?)"
      ).bind(nombre, descripcion, duracion, precio, categoria, i + 1, rubro === "taller" ? 1 : 0, esDomicilio, tenantId));
    });
    loaded.servicios = services.length;
  }
  if (!hor || hor.c === 0) {
    for (const [dia, apertura, cierre, activo] of DEFAULT_HORARIOS) {
      stmts.push(env.DB.prepare(
        "INSERT INTO sgc_cit_horarios (dia_semana, hora_apertura, hora_cierre, intervalo_minutos, activo, tenant_id) VALUES (?, ?, ?, 30, ?, ?)"
      ).bind(dia, apertura, cierre, activo, tenantId));
    }
    loaded.horarios = DEFAULT_HORARIOS.length;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return loaded;
}
