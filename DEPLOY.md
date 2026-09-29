# Despliegue de la actualización de seguridad (sistema SGC completo)

Esta actualización toca los 5 repos (rama `ccr-4e6b2ec7-k1drmk`). **El orden importa**: los workers nuevos fallan cerrado
(responden 401/503) si falta un secret, y el webhook de WhatsApp deja de responder hasta sincronizarlo.
Tiempo estimado: 20–30 minutos. Corte de WhatsApp esperado: ~1 minuto (entre el paso 4 y el 5).

> **Estado 2026-09-29 10:15 UTC:** pasos 1, 2 y 3 ya ejecutados en producción. Migraciones 0001–0006 aplicadas y
> registradas en `d1_migrations`. Punto de restauración: `--timestamp=2026-09-29T10:10:57Z`. Continúa desde el paso 0
> (secretos) y luego el paso 4.

## 0. Generar secretos

```bash
openssl rand -hex 32   # ADMIN_TOKEN      (super-admin de sgc-saas; también SGC_SAAS_ADMIN_TOKEN en sgc-ordenes)
openssl rand -hex 32   # PANEL_SECRET     (firma las claves del panel de cada negocio)
openssl rand -hex 32   # WEBHOOK_SECRET   (webhook de Evolution)
openssl rand -hex 32   # JWT_SECRET       (sgc-admin-pages)
openssl rand -hex 32   # CRON_SECRET      (sgc-recordatorios, disparo manual)
```

Guárdalos en un gestor de contraseñas. **No** los pongas en `wrangler.toml` ni en el repo.

## 1. Respaldo de la base D1

```bash
npx wrangler d1 time-travel info citas            # anota el bookmark actual (restauración punto en el tiempo)
npx wrangler d1 export citas --remote --output backup-citas-$(date +%F).sql
```

## 2. Verificación previa de las migraciones

La migración 0006 agrega columnas. Si el código viejo ya las agregó "sobre la marcha", fallaría. Revisa que esta consulta
devuelva **0 filas** (si devuelve alguna, borra esa línea de `worker/migrations/0006_ordenes_columnas_faltantes.sql`):

```bash
npx wrangler d1 execute citas --remote --command "SELECT name FROM pragma_table_info('sgc_ord_OrdenesTrabajo') WHERE name IN ('notas','pagado','tecnico_lat','tecnico_lng','token_firma_tecnico') UNION ALL SELECT name FROM pragma_table_info('sgc_ord_AdelantosTecnico') WHERE name = 'notas'"
```

## 3. Aplicar migraciones (desde `sgc-saas/worker`)

```bash
cd sgc-saas/worker
npx wrangler d1 migrations list citas --remote     # debe listar 0001–0006 como pendientes
npx wrangler d1 migrations apply citas --remote
```

| Migración | Qué corrige |
|---|---|
| 0001 | Conversaciones únicas por `(phone, tenant_id)`: un cliente que ya habló con SGC no podía escribirle a otro negocio |
| 0002 | Horarios duplicados (tenant 3) + índice único por día |
| 0003 | `sgc_cit_config` y `sgc_cit_bloqueos` por tenant |
| 0004 | Borra 12 tablas vacías sin prefijo y crea `sgc_ord_TrackingTecnico` |
| 0005 | `sgc_ord_ConfigKV` con las columnas que usa sgc-ordenes (cobro a domicilio / UltraMsg) |
| 0006 | Columnas faltantes en órdenes (lista del técnico, tracking, firma, exportación) |

Todas se probaron sobre una copia del esquema de producción, en SQLite y en la D1 local de Wrangler.

## 4. sgc-saas (worker)

```bash
cd sgc-saas/worker
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put PANEL_SECRET
npx wrangler secret put WEBHOOK_SECRET
# EVOLUTION_API_KEY ya existe; si no: npx wrangler secret put EVOLUTION_API_KEY
npm test                      # 73 tests
npx wrangler deploy
```

## 5. Reconfigurar los webhooks de Evolution

El worker nuevo rechaza webhooks sin el secreto. Apunta todas las instancias (incluida `make peueba`) a la URL con `?k=`:

```bash
curl -X POST https://sgc-saas.activo.workers.dev/api/superadmin/sync-webhooks -H "Authorization: Bearer $ADMIN_TOKEN"
```

(o escribe `SYNC` desde el WhatsApp admin cuando el webhook de la instancia principal ya esté actualizado).
Si la instancia principal apuntaba a `sgc-citas`, este paso la mueve a `sgc-saas`.

## 6. Páginas de sgc-saas (`sgc-saas/pages`)

```bash
npx wrangler pages deploy pages --project-name sgc-saas
```

Luego envía a cada negocio su enlace privado del panel:

```bash
curl https://sgc-saas.activo.workers.dev/api/superadmin/tenants/sgc/panel-link -H "Authorization: Bearer $ADMIN_TOKEN"
# o por WhatsApp admin: LINK <slug>
```

## 7. sgc-ordenes-pages

```bash
cd sgc-ordenes-pages
npx wrangler pages secret put SGC_SAAS_ADMIN_TOKEN --project-name sgc-ordenes   # = ADMIN_TOKEN de sgc-saas
npm test
npx wrangler pages deploy . --project-name sgc-ordenes
```

Entra al panel con `admin` / `admin123`: pedirá cambiar la contraseña. **Hazlo.**
Los técnicos deben volver a iniciar sesión en la app (ahora hay sesión con token). Recuerda que la app del técnico no funcionaba antes:
el login daba 500 y la lista de órdenes también.

## 8. sgc-admin-pages

```bash
cd sgc-admin-pages
npx wrangler pages secret put JWT_SECRET --project-name sgc-admin
npm test
npx wrangler pages deploy . --project-name sgc-admin
```

Si el proyecto se despliega por integración con Git, el `JWT_SECRET` que estaba en `[vars]` desaparece con este cambio:
configura el secret **antes** de hacer merge. Cambia también aquí la contraseña de `admin`.

## 9. sgc-recordatorios-worker

```bash
cd sgc-recordatorios-worker
npx wrangler secret put CRON_SECRET
npx wrangler secret put EVOLUTION_API_KEY    # recomendado; si no, ULTRAMSG_TOKEN
npm test
npx wrangler deploy                          # activa el cron diario 13:00 UTC
```

## 10. sgc-citas-worker (legacy)

Opción recomendada: **eliminarlo** (`npx wrangler delete sgc-citas`) una vez verificado el paso 5.
Si prefieres mantenerlo: `wrangler secret put ADMIN_TOKEN`, `wrangler secret put WEBHOOK_SECRET` y `npx wrangler deploy`.

## 11. Verificación rápida

```bash
W=https://sgc-saas.activo.workers.dev
curl -s -o /dev/null -w "%{http_code}\n" $W/api/admin/servicios                      # 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST $W/api/whatsapp/webhook -d '{}'     # 401
curl -s -o /dev/null -w "%{http_code}\n" "$W/api/tenant/dashboard?t=sgc"             # 401
curl -s -o /dev/null -w "%{http_code}\n" "$W/api/servicios?t=sgc"                    # 200
curl -s -o /dev/null -w "%{http_code}\n" https://sgc-ordenes-di7.pages.dev/api/admin/todas-ordenes   # 401
curl -s -o /dev/null -w "%{http_code}\n" https://sgc-admin-8yf.pages.dev/api/citas                   # 401
```

Y prueba real: escribe "Hola" al WhatsApp de SGC desde otro teléfono; luego pide una hora y confirma. La cita debe aparecer
en `/admin?t=sgc` (panel del negocio) y en el panel de órdenes (sección Citas IA).

## Reversión

- Workers: `npx wrangler rollback` en cada worker (vuelve a la versión anterior).
- Pages: re-publica el deployment anterior desde el dashboard de Cloudflare.
- Base: `npx wrangler d1 time-travel restore citas --timestamp=2026-09-29T10:10:57Z` (o `--bookmark=<bookmark del paso 1>`).
  Ojo: las migraciones 0001, 0003 y 0005 cambian restricciones; el código viejo sigue funcionando con el esquema nuevo,
  así que normalmente **no** hace falta revertir la base al revertir el código.
