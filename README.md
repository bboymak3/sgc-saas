# BotWA — SaaS de Bots de IA para WhatsApp

Sistema SaaS multi-tenant de bots de IA para WhatsApp. Cada negocio tiene su propio bot que atiende 24/7, agenda citas automáticamente, y el dueño solo aprueba.

## 🚀 URLs

| Servicio | URL |
|----------|-----|
| **Bot de Citas (principal)** | https://bot.makeseo.app |
| **Landing + Registro** | https://bot.makeseo.app/ |
| **SuperAdmin** | https://bot.makeseo.app/superadmin |
| **API Worker** | https://sgc-saas.activo.workers.dev |
| **Hosting** | Cloudflare Pages + Workers |

## 🌐 Ecosistema makeseo.app

| Subdominio | Proyecto | Función |
|------------|----------|---------|
| makeseo.app | MakeSEO Academy | Academia + Landing principal |
| bot.makeseo.app | SGC SaaS (este) | Bot WhatsApp citas |
| botproducto.makeseo.app | SGC Tienda | Bot de pedidos/productos |
| flujos.makeseo.app | SGC Flujos | Motor de flujos deterministas |

## 📋 Características

- Bot de WhatsApp con IA 24/7 (Cloudflare AI / Llama 3.3 70B)
- 3 modos: Solo IA, Solo Flujo, Mixto (flujo + IA fallback)
- 41+ categorías con plantillas de IA específicas
- Auto-asignación de flujo + prompt al aprobar negocio
- Timezone por país, formato 12h AM/PM
- Soporte LID de WhatsApp
- Panel SuperAdmin con Config Bot unificado (General + IA + Flujos)
- QR de WhatsApp con Evolution API
- Recordatorios automáticos

## 🔐 Credenciales

- **SuperAdmin:** https://bot.makeseo.app/superadmin (pwd: admin123)
- **Cloudflare Account:** 6fc12c9a89723c0039cf189380c0b02f
- **D1 Database:** citas (678b4adc-232d-43db-86ec-230828268161)

---
**BotWA · makeseo.app · Edward Valencia · @makeseo**
