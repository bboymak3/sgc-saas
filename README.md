# BotWA — SaaS de Bots de IA para WhatsApp

Sistema SaaS multi-tenant de bots de IA para WhatsApp. Cada negocio tiene su propio bot que atiende 24/7, agenda citas automáticamente, y el dueño solo aprueba.

## 🚀 URLs en producción

| Servicio | URL |
|----------|-----|
| **Landing + Registro** | https://sgc-saas.pages.dev |
| **SuperAdmin** | https://sgc-saas.pages.dev/superadmin |
| **API Worker** | https://sgc-saas.activo.workers.dev |
| **Hosting** | Cloudflare Pages + Workers |

## 📋 Características

- Bot de WhatsApp con IA 24/7 (Cloudflare AI / Llama 3.3 70B)
- Agenda citas automáticamente con timezone por país
- Funciona con el número actual del negocio (sin cambiar)
- Panel SuperAdmin multi-tenant con gestión completa
- Sistema de flujos deterministas integrado (sgc-flujos)
- 3 modos de atención: Solo IA, Solo Flujo, Mixto
- Soporte para formato AM/PM en horas
- Soporte para LID de WhatsApp (remoteJidAlt)
- 41+ categorías de negocio con plantillas de IA específicas
- Auto-asignación de flujo + prompt al aprobar negocio
- Recordatorios automáticos
- QR de WhatsApp con Evolution API
- Config Bot unificado: General, IA, Flujos (modal con 3 tabs)
- Pausar/Reactivar bot por tenant
- Notificaciones al dueño por WhatsApp

## 🏗️ Arquitectura

```
sgc-saas.pages.dev (Pages)
├── index.html (landing + registro)
├── superadmin.html (panel SuperAdmin)
├── _worker.js (Pages Advanced Mode)
└── wrangler.toml (bindings)

sgc-saas.activo.workers.dev (Worker standalone)
└── API: /api/* (citas, webhook, superadmin, IA)

DB: citas (D1)
├── sgc_cit_* (citas, config, servicios, WhatsApp)
├── sgc_flu_* (flujos, plantillas, sesiones)
└── tenants (multi-tenant)
```

## 🔧 Bindings del Worker

| Binding | Tipo | Valor |
|---------|------|-------|
| DB | D1 | citas (678b4adc-...) |
| TALLER_DB | D1 | citas (mismo) |
| AI | AI | Cloudflare AI |
| FOTOS | R2 | my-emdash-media |
| EVOLUTION_API_KEY | Secret | Evolution API |
| EVOLUTION_API_URL | Var | Railway |
| ADMIN_PHONE | Var | 584167775771 |

## 🔗 Proyectos del ecosistema

| Proyecto | URL | Función |
|----------|-----|---------|
| SGC SaaS (este) | sgc-saas.pages.dev | Bot WhatsApp citas |
| SGC Tienda | sgc-tienda.pages.dev | Bot de pedidos/productos |
| SGC Flujos | sgc-flujos.pages.dev | Motor de flujos deterministas |
| MakeSEO Academy | makeseo-mml.pages.dev | Academia MML |

## 🔐 Credenciales

- **SuperAdmin:** https://sgc-saas.pages.dev/superadmin (pwd: admin123)
- **Cloudflare Account:** 6fc12c9a89723c0039cf189380c0b02f
- **D1 Database:** citas (678b4adc-232d-43db-86ec-230828268161)

## 📊 Estado actual

- 19 negocios activos
- 41+ categorías con plantillas de IA
- 41 plantillas de flujo determinista
- Integración con Evolution API (WhatsApp)
- Integración con sgc-flujos (motor determinista)
- Modo Mixto (flujo + IA fallback)

---
**BotWA · MakeSEO Academy · Edward Valencia · @makeseo**
