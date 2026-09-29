# SGC SaaS — Plataforma multi-tenant de Bots WhatsApp con IA

Plataforma SaaS para crear bots de WhatsApp con IA para cualquier negocio basado en citas (talleres, barberías, clínicas, salones, etc.). Multi-tenant real, 100% serverless, $0/mes en free tiers.

## 🏗️ Arquitectura

```
┌─────────────────────────────────────────────────────────────────┐
│  LANDING + FORM (Cloudflare Pages)                              │
│  https://sgc-saas.pages.dev                                     │
│  - Hero, features, pricing                                      │
│  - Form de registro (crea tenant pending)                       │
│  - Status page (cliente ve su QR)                               │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  WORKER MULTI-TENANT (Cloudflare Workers)                       │
│  https://sgc-saas.activo.workers.dev                            │
│                                                                 │
│  Endpoints:                                                     │
│  • POST /api/onboarding/register  - Alta de tenant              │
│  • GET  /api/onboarding/status    - Estado del tenant           │
│  • POST /api/whatsapp/webhook?t=  - Webhook Evolution API       │
│  • POST /api/chat?t=              - Chat web                   │
│  • GET  /api/servicios?t=         - Lista servicios del tenant  │
│  • ... (hereda todos los endpoints de sgc-citas-worker)         │
│                                                                 │
│  Detección de tenant:                                           │
│  • Query param ?t=<slug>                                        │
│  • Header X-Tenant-Slug                                         │
│  • Body.instance (Evolution API: t_<slug_con_underscores>)      │
│  • Default: tenant_id=1 (SGC)                                   │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  D1 ÚNICA — Multi-tenant con tenant_id                          │
│                                                                 │
│  tenants (id, slug, business_name, whatsapp_number, status)     │
│  sgc_cit_Citas (..., tenant_id)                                 │
│  sgc_cit_servicios_unificados (..., tenant_id)                  │
│  sgc_cit_horarios (..., tenant_id)                              │
│  sgc_cit_WhatsApp_conversations (..., tenant_id)                │
│  sgc_cit_WhatsApp_messages (..., tenant_id)                     │
│  admin_commands (auditoría)                                     │
│  ... (30+ tablas con tenant_id)                                 │
└─────────────────────────────────────────────────────────────────┘
```

## ✨ Funcionalidades

### Para el cliente final (negocio)
- **Registro self-service**: llena form en landing → solicitud creada
- **Aprobación rápida**: admin aprueba por WhatsApp en minutos
- **Conexión simple**: escanea QR desde su WhatsApp → bot activo
- **Bot con IA**: responde 24/7, agenda citas, consulta disponibilidad
- **Servicios precargados**: según rubro (taller, barbería, dental, etc.)
- **Horarios default**: Lun-Vie 9-18, Sáb 9-14, Dom cerrado
- **Personalizable**: cambia servicios, precios, horarios sin código

### Para el admin (tú)
- **Aprobación por WhatsApp**: comandos `APROBAR slug`, `RECHAZAR slug`
- **Listado en WhatsApp**: `LISTAR` muestra pendientes
- **Suspender**: `SUSPENDER slug` desactiva un tenant
- **Auto-provisioning**: al aprobar, crea instancia Evolution API + carga servicios
- **Aislamiento total**: cada tenant solo ve sus datos
- **Auditoría**: todos los comandos admin se registran en `admin_commands`

## 📋 Comandos admin por WhatsApp

Desde el número configurado como `ADMIN_PHONE`:

| Comando | Descripción |
|---|---|
| `LISTAR` | Ver tenants pendientes de aprobación |
| `ACTIVOS` | Ver tenants activos |
| `APROBAR <slug>` | Aprobar tenant + crear instancia Evolution + cargar servicios |
| `RECHAZAR <slug>` | Rechazar solicitud |
| `SUSPENDER <slug>` | Suspender tenant activo |
| `AYUDA` | Ver todos los comandos |

## 🏷️ Rubros soportados (con servicios default)

| Rubro | Slug | Servicios default |
|---|---|---|
| Taller mecánico | `taller` | Cambio de aceite, frenos, scanner, revisión técnica... |
| Barbería | `barberia` | Corte, barba, corte+barba, tinte, cejas... |
| Clínica dental | `clinica_dental` | Limpieza, empaste, endodoncia, ortodoncia... |
| Salón de belleza | `salon_beleza` | Manicure, pedicure, uñas acrílicas, tinte... |
| Veterinaria | `veterinaria` | Consulta, vacunación, esterilización, baño... |
| Otro | `otro` | Consulta general + servicio premium |

Para agregar más rubros: editar función `loadDefaultServices` en `worker/index.js`.

## 🔧 Configuración

### Variables (wrangler.toml)
| Variable | Descripción | Default |
|---|---|---|
| `BUSINESS_NAME` | Nombre default | `SGC` |
| `BUSINESS_PHONE` | Teléfono default | `56939026185` |
| `EVOLUTION_API_URL` | URL base Evolution API | - |
| `EVOLUTION_INSTANCE_NAME` | Instancia admin | `make peueba` |
| `ADMIN_PHONE` | Tu WhatsApp (comandos admin) | `584167775771` |
| `SGCORDENES_URL` | URL sgc-ordenes (legacy) | - |

### Secrets
- `EVOLUTION_API_KEY`: API key de Evolution API

### Bindings
- `DB` — D1 database `citas` (multi-tenant)
- `TALLER_DB` — D1 database `citas` (mismo, para compatibilidad con sgc-citas)
- `AI` — Cloudflare Workers AI (Llama 3.2 3B)
- `ASSETS` — HTML del chat web

## 🚀 Deploy

```bash
git clone https://github.com/bboymak3/sgc-saas.git
cd sgc-saas/worker

# Editar wrangler.toml
nano wrangler.toml

# Setear secret
echo "tu-api-key" | wrangler secret put EVOLUTION_API_KEY

# Deploy worker
wrangler deploy

# Deploy landing
cd ../pages
wrangler pages deploy . --project-name=sgc-saas --branch=main
```

## 📁 Estructura

```
sgc-saas/
├── README.md
├── worker/
│   ├── index.js              # Worker multi-tenant (118KB)
│   ├── wrangler.toml
│   └── assets/               # HTML del chat web
└── pages/
    ├── index.html            # Landing + form
    └── status.html           # Estado de solicitud + QR
```

## 🔄 Flujo completo (5 min)

```
1. Cliente llena form en landing                        (30 seg)
2. Worker crea tenant pending + WhatsApp a admin        (5 seg)
3. Admin ve WhatsApp, responde "APROBAR slug"           (15 seg)
4. Worker automáticamente:
   a. UPDATE tenant → approved                          (1 seg)
   b. Crea instancia en Evolution API                   (3 seg)
   c. Genera QR code                                    (2 seg)
   d. Carga servicios default según rubro               (2 seg)
   e. Carga horarios default                            (1 seg)
   f. Envía QR al cliente por WhatsApp                  (2 seg)
5. Cliente escanea QR desde su WhatsApp                 (1 min)
6. Evolution API confirma conexión → tenant active      (5 seg)
7. Bot activo 🎉                                        (5 seg)

Total: ~3-5 minutos
```

## 💰 Costo mensual: $0

| Servicio | Costo | Límite free |
|---|---|---|
| Cloudflare Workers | $0 | 100k requests/día |
| Cloudflare Workers AI | $0 | 10k neuronos/día |
| Cloudflare D1 | $0 | 5M reads + 100k writes/día |
| Cloudflare Pages | $0 | 500 builds/mes |
| Railway Evolution API | $0 | 500h/mes |
| **Total** | **$0** | |

Hasta ~20-30 clientes activos. Si creces más, Cloudflare Workers Paid $5/mes cubre todo.

## 📚 Repos relacionados

- [sgc-citas-worker](https://github.com/bboymak3/sgc-citas-worker) — Worker original (single-tenant)
- [sgc-admin-pages](https://github.com/bboymak3/sgc-admin-pages) — Panel admin
- [sgc-ordenes-pages](https://github.com/bboymak3/sgc-ordenes-pages) — Sistema de órdenes
- [sgc-recordatorios-worker](https://github.com/bboymak3/sgc-recordatorios-worker) — Recordatorios

## 📄 Licencia

Propietario — SGC
