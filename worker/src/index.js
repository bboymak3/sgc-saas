// ============================================================
// SGC SaaS - Worker multi-tenant de bots WhatsApp con IA
//
// Rutas:
//   Públicas        → routes/public.js   (chat web, reservas, onboarding)
//   Panel tenant    → routes/tenant.js   (/api/tenant/*, clave del tenant)
//   Administración  → routes/admin.js    (ADMIN_TOKEN)
//   Webhook         → whatsapp/webhook.js (WEBHOOK_SECRET)
//   Resto           → assets estáticos (./assets)
// ============================================================

import { handleCors, json, jsonError } from "./lib/http.js";
import { handleWhatsAppWebhook } from "./whatsapp/webhook.js";
import { handleAdminRoutes } from "./routes/admin.js";
import { handleTenantRoutes } from "./routes/tenant.js";
import { handlePublicRoutes } from "./routes/public.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return handleCors();

    try {
      if (path === "/api/whatsapp/webhook" && request.method === "POST") {
        return await handleWhatsAppWebhook(request, env, url, ctx);
      }
      if (path === "/api/whatsapp/test" && request.method === "GET") {
        return json({ ok: true, msg: "Webhook endpoint activo", time: new Date().toISOString() });
      }
      const res = (await handleAdminRoutes(request, env, url))
        || (await handleTenantRoutes(request, env, url))
        || (await handlePublicRoutes(request, env, url));
      if (res) return res;
      if (path.startsWith("/api/")) return jsonError("Ruta no encontrada", 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("Worker error:", path, error);
      // Sin detalles internos en la respuesta: quedan en los logs del worker
      return jsonError("Error interno", 500);
    }
  }
};
