# SaaS multi-tenant de bots WhatsApp con IA — BotWA

Plataforma SaaS multi-tenant para crear bots de WhatsApp con IA para cualquier negocio basado en citas (talleres, barberías, clínicas dentales, salones de belleza, veterinarias, etc.). 100% serverless sobre Cloudflare, multi-tenant real con aislamiento por `tenant_id`, IA generativa con Llama 3.2 3B, y bridge WhatsApp vía Evolution API.

Reemplaza y mejora a [`sgc-citas-worker`](https://github.com/bboymak3/sgc-citas-worker) (single-tenant) agregando capa multi-tenant, onboarding self-service, panel admin por tenant y provisioning automático de instancias Evolution API.

---

## Badges

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-F38020?logo=cloudflare&logoColor=white)
![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-F38020?logo=cloudflare&logoColor=white)
![Workers AI](https://img.shields.io/badge/Cloudflare-Workers_AI-F38020?logo=cloudflare&logoColor=white)
![Evolution API](https://img.shields.io/badge/Evolution_API-v2.3.7-25D366?logo=whatsapp&logoColor=white)
![Llama 3.2 3B](https://img.shields.io/badge/Llama-3.2_3B-0866FF?logo=meta&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-vanilla-F7DF1E?logo=javascript&logoColor=black)
![License](https://img.shields.io/badge/license-Proprietary-red)

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CLOUDFLARE PAGES                                │
│                       https://sgc-saas.pages.dev                        │
│                                                                         │
│   /                  → Landing BotWA (hero, demo, pricing, FAQ, form)   │
│   /status?slug=     → Estado de solicitud + QR del tenant               │
│   /chat?t=          → Chat web público de cada tenant                   │
│   /admin?t=         → Panel admin multi-tenant (citas, servicios)       │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │  HTTP (fetch)
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE WORKER (multi-tenant)                     │
│                  https://sgc-saas.activo.workers.dev                    │
│                                                                         │
│   • Detección de tenant: ?t=<slug> | X-Tenant-Slug | body.instance      │
│   • Default: tenant_id=1 (SGC)                                          │
│   • Routing por path + query param                                      │
│   • Aislamiento estricto por tenant_id en TODA query SQL                │
└───────┬───────────────────────┬───────────────────────┬─────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌──────────────────┐  ┌─────────────────────┐  ┌────────────────────────┐
│  CLOUDFLARE D1   │  │  CLOUDFLARE WORKERS │  │  CLOUDFLARE ASSETS     │
│  DB "citas"      │  │  AI (Llama 3.2 3B)  │  │  (HTML estático chat)  │
│  uuid: 678b4adc- │  │  @cf/meta/llama-    │  │  binding: ASSETS       │
│  232d-43db-86ec- │  │  3.2-3b-instruct    │  │                        │
│  230828268161    │  │                     │  │                        │
│                  │  │  • Chat con tools   │  │                        │
│  tenants (cent.) │  │  • agendar_cita     │  │                        │
│  sgc_cit_*       │  │  • verificar_disp.  │  │                        │
│  sgc_ord_*       │  │  • consultar_citas  │  │                        │
│  sgc_rec_*       │  │                     │  │                        │
│  admin_commands  │  │                     │  │                        │
│  (todas con      │  │                     │  │                        │
│   tenant_id)     │  │                     │  │                        │
└──────────────────┘  └─────────────────────┘  └────────────────────────┘
        ▲                       │
        │                       │ sendText / sendMedia
        │                       ▼
        │              ┌─────────────────────────────────┐
        │              │   EVOLUTION API v2.3.7 (Railway)│
        │              │   https://evolution-api-        │
        │              │   production-91a07.up.railway.app│
        │              │                                 │
        │              │   • 1 instancia por tenant       │
        │              │   • instance name: t_<slug>      │
        │              │   • Webhook entrante → /api/     │
        │              │     whatsapp/webhook?t=<slug>    │
        │              └──────┬───────────────┬──────────┘
        │                     │               │
        │              ┌──────┴───────┐  ┌────┴──────────────┐
        │              │  WhatsApp    │  │  WhatsApp         │
        │              │  clientes    │  │  ADMIN            │
        │              │  (por tenant)│  │  +58 416 777 5771 │
        └──────────────┘              └─────────────────────┘
                  (comandos: APROBAR / RECHAZAR / LISTAR / ...)
```

---

## Tech Stack

| Capa | Tecnología | Versión / Detalle |
|---|---|---|
| Runtime | Cloudflare Workers | `compatibility_date = "2025-10-08"`, flag `nodejs_compat` |
| IA | Cloudflare Workers AI | modelo `@cf/meta/llama-3.2-3b-instruct` |
| DB | Cloudflare D1 (SQLite) | DB `citas` (uuid `678b4adc-232d-43db-86ec-230828268161`) |
| Hosting frontend | Cloudflare Pages | proyecto `sgc-saas`, branch `main` |
| WhatsApp bridge | Evolution API | v2.3.7 |
| WhatsApp hosting | Railway | free tier (500 h/mes) |
| Auth | Query param `?t=<slug>` | TODO: JWT |
| Payments | Ninguno | 100% gratis |
| Lenguaje | JavaScript | vanilla, sin framework |
| Build tool | Wrangler | 4.x |
| Multi-tenancy | Aislamiento por `tenant_id` | todas las tablas con columna `tenant_id` |

---

## APIs y Connectors

### Endpoints del Worker

#### Públicos (sin auth)

| Método | Path | Descripción | Auth |
|---|---|---|---|
| `POST` | `/api/onboarding/register` | Alta de tenant (form landing). Crea `tenants` con status `pending` y notifica al admin por WhatsApp. | — |
| `GET` | `/api/onboarding/status?slug=` | Estado de la solicitud de onboarding del tenant (pending / approved / rejected) + QR si está activo. | — |
| `GET` | `/api/onboarding/list` | Lista todos los tenants (para debugging / panel interno). | — |
| `GET` | `/api/tenant/public?t=` | Config pública del tenant (nombre, rubro, horarios) para render del chat web. | `?t=` |
| `POST` | `/api/chat?t=` | Chat web con IA. Recibe `{ message, history }`, responde con texto generado por Llama 3.2 3B + tools. | `?t=` |
| `GET` | `/api/servicios?t=` | Lista de servicios activos del tenant (público, para catálogo). | `?t=` |
| `GET` | `/api/disponibilidad?t=&fecha=` | Slots disponibles para una fecha (`YYYY-MM-DD`). Considera horarios, bloqueos y citas existentes. | `?t=` |
| `POST` | `/api/agendar?t=` | Crea cita en estado `pendiente_aprobacion`. Body: `{ telefono, nombre, servicio, fecha, hora }`. | `?t=` |
| `GET` | `/api/consultar-citas?t=` | Consulta citas por teléfono (`?telefono=`) o por rango de fechas. | `?t=` |
| `GET` | `/api/whatsapp/test` | Healthcheck del webhook de WhatsApp. | — |
| `POST` | `/api/whatsapp/webhook?t=` | Webhook entrante de Evolution API. Procesa mensajes de clientes y comandos del admin. | `?t=` |

#### Admin multi-tenant (`?t=<slug>`)

| Método | Path | Descripción | Auth |
|---|---|---|---|
| `GET` | `/api/tenant/dashboard?t=` | Métricas del tenant: citas hoy, pendientes, aprobadas, total servicios, estado del bot. | `?t=` |
| `GET` | `/api/tenant/citas?t=` | Lista citas del tenant con filtros (`?estado=`, `?fecha=`, `?desde=`, `?hasta=`). | `?t=` |
| `POST` | `/api/tenant/citas?t=` | Crear cita manual desde panel admin. | `?t=` |
| `POST` | `/api/tenant/citas/:id/aprobar?t=` | Aprueba cita → `estado=confirmada`, notifica al cliente por WhatsApp. | `?t=` |
| `POST` | `/api/tenant/citas/:id/rechazar?t=` | Rechaza cita (body `motivo`) → `estado=cancelada`, notifica al cliente. | `?t=` |
| `GET` | `/api/tenant/servicios?t=` | Lista servicios del tenant (incluye inactivos). | `?t=` |
| `POST` | `/api/tenant/servicios?t=` | Crea servicio nuevo (nombre, descripción, categoría, precio, duración, etc.). | `?t=` |
| `PUT` | `/api/tenant/servicios/:id?t=` | Actualiza campos del servicio (PATCH-like, solo campos enviados). | `?t=` |
| `DELETE` | `/api/tenant/servicios/:id?t=` | Soft-delete: marca `activo=0` (preserva integridad de citas históricas). | `?t=` |

#### Admin WhatsApp (vía `+584167775771`)

Procesados por `handleAdminCommand` cuando el mensaje entra desde `ADMIN_PHONE`:

| Comando | Descripción |
|---|---|
| `APROBAR <slug>` | Aprueba tenant pending → actualiza estado, crea instancia Evolution API, genera QR, carga servicios default según rubro, carga horarios default, envía QR al cliente. |
| `RECHAZAR <slug>` | Rechaza solicitud. Marca tenant como `rejected` y notifica. |
| `LISTAR` | Lista tenants pendientes de aprobación. |
| `ACTIVOS` | Lista tenants activos (`approved` + `connected`). |
| `SUSPENDER <slug>` | Suspende tenant activo (status `suspended`), detiene el bot. |
| `AYUDA` | Muestra todos los comandos disponibles. |

Todos los comandos se registran en la tabla `admin_commands` (auditoría).

### Connectors externos

| Connector | Versión | Función |
|---|---|---|
| **Evolution API** | v2.3.7 | Webhook entrante (`POST /api/whatsapp/webhook?t=`), `sendText` (`enviarWhatsAppEvolution`), `sendMedia` (`enviarImagenWhatsAppEvolution` para QR). Una instancia por tenant con nombre `t_<slug>`. |
| **Cloudflare Workers AI** | — | Modelo `@cf/meta/llama-3.2-3b-instruct` para chat conversacional con tools (`agendar_cita`, `verificar_disponibilidad`, `consultar_citas`). |
| **Cloudflare D1** | — | Persistencia multi-tenant. Tanto `DB` como `TALLER_DB` apuntan a la misma base `citas`. |
| **Cloudflare ASSETS** | binding | Sirve HTML estático del chat web desde el Worker (`/chat?t=`, fallbacks). |

---

## Funciones principales del Worker (`worker/index.js`)

| Función | Línea aprox. | Descripción |
|---|---|---|
| `handleWhatsAppWebhook` | 2022 | Punto de entrada de mensajes WhatsApp. Distingue admin (`ADMIN_PHONE`) → `handleAdminCommand`; cliente → flujo IA con tools. |
| `handleAdminCommand` | 2845 | Procesa comandos del admin (APROBAR, RECHAZAR, LISTAR, ACTIVOS, SUSPENDER, AYUDA). Orquesta auto-provisioning al aprobar. |
| `handleOnboardingRegister` | 3068 | Alta de tenant desde el form de la landing. Inserta en `tenants` con status `pending`, genera slug, notifica admin por WhatsApp. |
| `handleOnboardingStatus` | 3138 | Devuelve estado de la solicitud + QR (si fue aprobado) para la `/status` page. |
| `buildWhatsAppSystemPrompt` | 2367 | Construye el system prompt multi-nicho para Llama 3.2 3B. Inyecta nombre del tenant, rubro, servicios, horarios y reglas de tools. |
| `executeWhatsAppTool` | 2608 | Ejecuta tools invocadas por la IA: `agendar_cita`, `verificar_disponibilidad`, `consultar_citas`. Devuelve resultado estructurado al modelo. |
| `parseCitaFromHistory` | 2732 | Parser de backup: extrae datos de cita (servicio, fecha, hora, teléfono) del historial de conversación cuando el modelo no invoca la tool correctamente. |
| `loadDefaultServices` | 3183 | Carga servicios default según rubro del tenant (`taller`, `barberia`, `clinica_dental`, `salon_beleza`, `veterinaria`, `otro`) en `sgc_cit_servicios_unificados`. |
| `getOrCreateWhatsAppConversation` | 2439 | Gestiona la conversación por tenant + teléfono. Crea registro en `sgc_cit_WhatsApp_conversations` si no existe, devuelve `conversationId`. |
| `enviarWhatsAppEvolution` | 2498 | Envía mensaje de texto WhatsApp vía Evolution API (`sendText`). Usa la instancia del tenant (`t_<slug>`). |
| `enviarImagenWhatsAppEvolution` | 2543 | Envía imagen (base64) con caption vía Evolution API (`sendMedia`). Usado para enviar el QR de conexión al cliente. |
| `getTenantFromRequest` | 1129 | Resolución de tenant por query param `?t=` o header `X-Tenant-Slug`. Default `tenant_id=1`. |
| `getTenantFromPhone` | 1146 | Resolución de tenant por número de teléfono del remitente (webhook entrante). |
| `resolveTenantForWebhook` | 1163 | Resolución de tenant para webhook Evolution API: prioriza `?t=`, luego `body.instance` (`t_<slug>`), luego default. |
| `resolveTenantForAdminPanel` | 1198 | Resolución estricta de tenant para endpoints admin. Requiere `?t=` válido; si no, 400. |
| `getDisponibilidad` | 1075 | Calcula slots disponibles para una fecha: aplica horarios, bloqueos y citas ya ocupadas del tenant. |
| `consultarCitas` | 968 | Consulta citas con filtros (teléfono, fecha, estado, rango). |
| `enviarWhatsApp` | 1037 | Wrapper legacy de envío WhatsApp (compatibilidad con sgc-citas-worker). |
| `getSystemPrompt` | 845 | System prompt legacy (web chat). |
| `formatForWhatsApp` | 2589 | Formatea texto markdown a formato WhatsApp (`*negrita*`, `_cursiva_`, saltos). |
| `handleCors` | 1121 | Headers CORS para endpoints públicos. |

---

## Páginas (Cloudflare Pages)

| Ruta | Archivo | Descripción |
|---|---|---|
| `/` | `pages/index.html` | Landing page **BotWA**: hero, demo de chat interactivo, pricing ($0), FAQ, form de registro (POST a `/api/onboarding/register`). |
| `/status?slug=` | `pages/status.html` | Estado de la solicitud del tenant: pending → spinner, approved → QR para escanear, rejected → mensaje. |
| `/chat?t=` | `pages/chat.html` (+ fallback en `worker/assets/index.html`) | Chat web público de cada tenant. Cada tenant tiene su URL única `https://sgc-saas.pages.dev/chat?t=<slug>`. |
| `/admin?t=` | `pages/admin.html` (+ fallback en `worker/assets/admin.html`) | Panel admin multi-tenant: dashboard de citas, gestión de servicios (CRUD), configuración, aprobar/rechazar citas. |

---

## Tablas D1 (multi-tenant)

Todas las tablas de negocio incluyen la columna `tenant_id` para aislamiento. La tabla `tenants` es central (sin prefijo).

### Tabla central

| Tabla | Descripción |
|---|---|
| `tenants` | Registro central de tenants: `id`, `slug`, `business_name`, `whatsapp_number`, `rubro`, `status` (`pending`/`approved`/`rejected`/`suspended`/`connected`), `instance_name`, `created_at`. |

### Módulo Citas (`sgc_cit_*`)

| Tabla | Descripción |
|---|---|
| `sgc_cit_Citas` | Citas agendadas: servicio, fecha, hora, teléfono, estado, estado_aprobacion, motivo_rechazo. |
| `sgc_cit_servicios_unificados` | Catálogo de servicios: nombre, descripción, categoría, precio, duración_minutos, activo, origen, requiere_vehiculo, es_domicilio. |
| `sgc_cit_horarios` | Horarios de atención por día de la semana. |
| `sgc_cit_bloqueos` | Bloqueos manuales de slots (feriados, vacaciones, etc.). |
| `sgc_cit_config` | Configuración del tenant (nombre, teléfono, mensaje bienvenida, etc.). |
| `sgc_cit_AdminUsers` | Usuarios admin del tenant (para login futuro). |
| `sgc_cit_Clientes` | Maestro de clientes del tenant. |
| `sgc_cit_WhatsApp_conversations` | Conversaciones WhatsApp por teléfono+tenant: estado, contexto, última interacción. |
| `sgc_cit_WhatsApp_messages` | Mensajes individuales (user/assistant) de cada conversación. |

### Módulo Órdenes de Trabajo (`sgc_ord_*`) — heredado de sgc-ordenes

| Tabla | Descripción |
|---|---|
| `sgc_ord_OrdenesTrabajo` | Órdenes de trabajo generadas al aprobar citas (integración con taller). |
| `sgc_ord_Vehiculos` | Vehículos de los clientes. |
| `sgc_ord_Tecnicos` | Técnicos asignables. |
| `sgc_ord_Clientes` | Clientes del módulo órdenes. |
| *(+ tablas auxiliares: estados, items, diagnósticos, etc.)* | |

### Módulo Recordatorios (`sgc_rec_*`)

| Tabla | Descripción |
|---|---|
| `sgc_rec_recordatorios_revision` | Recordatorios de revisión/mantenimiento programados. |

### Auditoría

| Tabla | Descripción |
|---|---|
| `admin_commands` | Log de todos los comandos admin por WhatsApp: comando, slug, teléfono, timestamp, resultado. |

---

## Configuración

### Variables (`wrangler.toml` → `[vars]`)

| Variable | Descripción | Default en repo |
|---|---|---|
| `BUSINESS_NAME` | Nombre default del negocio (tenant 1) | `SGC` |
| `BUSINESS_PHONE` | Teléfono default (tenant 1) | `56939026185` |
| `EVOLUTION_API_URL` | URL base de Evolution API | `https://evolution-api-production-91a07.up.railway.app` |
| `EVOLUTION_INSTANCE_NAME` | Instance name admin (Evolution API) | `make peueba` |
| `ADMIN_PHONE` | Tu WhatsApp que recibe comandos admin | `584167775771` |
| `SGCORDENES_URL` | URL del frontend de órdenes (legacy) | `https://sgc-ordenes-di7.pages.dev` |

### Secrets

| Secret | Descripción |
|---|---|
| `EVOLUTION_API_KEY` | API key de Evolution API (Railway). Setear con `wrangler secret put`. |

### Bindings

| Binding | Tipo | Detalle |
|---|---|---|
| `DB` | D1 | database `citas` (uuid `678b4adc-232d-43db-86ec-230828268161`) |
| `TALLER_DB` | D1 | mismo database `citas` (alias para compatibilidad con `sgc-citas-worker`) |
| `AI` | Workers AI | binding para Llama 3.2 3B |
| `ASSETS` | Assets | directorio `./assets` (HTML estático del chat web) |

---

## Deploy

```bash
# 1. Clonar
git clone https://github.com/bboymak3/sgc-saas.git
cd sgc-saas/worker

# 2. Configurar secret de Evolution API
echo "tu-api-key" | wrangler secret put EVOLUTION_API_KEY

# 3. Deploy del Worker
wrangler deploy

# 4. Deploy de las Pages (landing + status + chat + admin)
cd ../pages
wrangler pages deploy . --project-name=sgc-saas --branch=main
```

### URLs resultantes

- **Worker**: https://sgc-saas.activo.workers.dev
- **Pages**: https://sgc-saas.pages.dev
- **Chat de un tenant**: `https://sgc-saas.pages.dev/chat?t=<slug>`
- **Admin de un tenant**: `https://sgc-saas.pages.dev/admin?t=<slug>`

---

## Costo mensual: $0

| Servicio | Costo | Límite free tier |
|---|---|---|
| Cloudflare Workers | $0 | 100k requests/día |
| Cloudflare Workers AI | $0 | 10k neuronos/día |
| Cloudflare D1 | $0 | 5M reads + 100k writes/día |
| Cloudflare Pages | $0 | 500 builds/mes, ancho de banda ilimitado |
| Railway (Evolution API) | $0 | 500h/mes (~20 días continuo) |
| **Total** | **$0** | Suficiente para ~20-30 tenants activos |

> Si creces más allá de ~30 tenants activos, Cloudflare Workers Paid ($5/mes) cubre todo el stack de Cloudflare. Railway Developer ($5/mes) elimina el límite de horas.

---

## Arquitectura multi-tenant

### Detección del tenant

El worker resuelve el `tenant_id` en este orden de prioridad:

1. **Query param `?t=<slug>`** — usado por Pages y endpoints admin.
2. **Header `X-Tenant-Slug`** — alternativa para integraciones programáticas.
3. **Body `instance`** (Evolution API webhook) — los webhooks entrantes incluyen `instance: "t_<slug>"`.
4. **Teléfono del remitente** (`getTenantFromPhone`) — lookup en `tenants.whatsapp_number`.
5. **Default**: `tenant_id=1` (SGC, legacy single-tenant).

Funciones de resolución:
- `getTenantFromRequest` — para endpoints HTTP estándar.
- `resolveTenantForWebhook` — para `/api/whatsapp/webhook`.
- `resolveTenantForAdminPanel` — para `/api/tenant/*` (estricto: requiere `?t=` válido, sino 400).
- `getTenantFromPhone` — fallback por teléfono.

### Aislamiento de datos

- **Toda** query SQL a tablas de negocio incluye `WHERE tenant_id = ?`.
- Las funciones `resolveTenant*` devuelven el `tenant.id` que se bind a cada query.
- No existe forma de cross-tenant access: el `tenant_id` se valida antes de cada operación.

### Provisioning automático al aprobar

Cuando el admin envía `APROBAR <slug>`, `handleAdminCommand` ejecuta atómicamente:

1. `UPDATE tenants SET status='approved' WHERE slug=?`
2. Crea instancia en Evolution API (`POST /instance/create`, nombre `t_<slug>`)
3. Configura webhook de la instancia → `/api/whatsapp/webhook?t=<slug>`
4. Genera QR de conexión
5. `loadDefaultServices(tenantId, rubro)` — inserta servicios según rubro
6. Inserta horarios default (Lun-Vie 9-18, Sáb 9-14, Dom cerrado)
7. `enviarImagenWhatsAppEvolution` — envía QR al cliente por WhatsApp

### Rubros soportados (servicios default)

| Rubro | Slug | Ejemplos de servicios default |
|---|---|---|
| Taller mecánico | `taller` | Cambio de aceite, frenos, scanner, revisión técnica, alineación, balanceo |
| Barbería | `barberia` | Corte, barba, corte+barba, tinte, cejas, diseño |
| Clínica dental | `clinica_dental` | Limpieza, empaste, endodoncia, ortodoncia, blanqueamiento |
| Salón de belleza | `salon_beleza` | Manicure, pedicure, uñas acrílicas, tinte, maquillaje |
| Veterinaria | `veterinaria` | Consulta, vacunación, esterilización, baño, desparasitación |
| Otro | `otro` | Consulta general + servicio premium |

Para agregar un rubro nuevo: editar la función `loadDefaultServices` en `worker/index.js` (~línea 3183).

---

## Flujo de onboarding (5 min)

```
1. Cliente llena form en landing                          (30 seg)
   └─ POST /api/onboarding/register
   └─ Worker crea tenant pending + WhatsApp a admin

2. Admin ve WhatsApp, responde "APROBAR <slug>"           (15 seg)
   └─ handleAdminCommand procesa el comando

3. Worker automáticamente (auto-provisioning):
   a. UPDATE tenants SET status='approved'                (1 seg)
   b. Crea instancia en Evolution API (t_<slug>)          (3 seg)
   c. Genera QR code de conexión                          (2 seg)
   d. loadDefaultServices(tenantId, rubro)                (2 seg)
   e. Carga horarios default (Lun-Vie 9-18, Sáb 9-14)    (1 seg)
   f. enviarImagenWhatsAppEvolution → QR al cliente       (2 seg)

4. Cliente escanea QR desde su WhatsApp                   (1 min)
   └─ Evolution API confirma conexión → status='connected'

5. Bot activo 🎉                                          (5 seg)

TOTAL: ~3-5 minutos desde el form hasta el bot respondiendo.
```

---

## Repos relacionados

| Repo | Rol |
|---|---|
| [sgc-citas-worker](https://github.com/bboymak3/sgc-citas-worker) | Worker original **single-tenant** (legacy). `sgc-saas` lo reemplaza y mejora. |
| [sgc-admin-pages](https://github.com/bboymak3/sgc-admin-pages) | Panel admin original (single-tenant). |
| [sgc-ordenes-pages](https://github.com/bboymak3/sgc-ordenes-pages) | Frontend del sistema de órdenes de trabajo. |
| [sgc-recordatorios-worker](https://github.com/bboymak3/sgc-recordatorios-worker) | Worker de recordatorios de revisión/mantenimiento. |

---

## Licencia

Propietario — **BotWA / SGC**. Todos los derechos reservados. Uso interno únicamente.
