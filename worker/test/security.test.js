import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnv, installFetchMock, call, waMessage, webhookPath, SECRETS, ADMIN_PHONE } from "./helpers/env.js";
import { tenantPanelKey } from "../src/lib/auth.js";

test("webhook: sin secreto, con secreto incorrecto o sin WEBHOOK_SECRET configurado → rechazado", async (t) => {
  const { env } = createEnv();
  const mock = installFetchMock(t);
  const body = waMessage({ text: "Hola" });

  assert.equal((await call(env, "POST", "/api/whatsapp/webhook?t=sgc", { body })).status, 401);
  assert.equal((await call(env, "POST", "/api/whatsapp/webhook?t=sgc&k=malo", { body })).status, 401);
  const noSecret = createEnv({ overrides: { WEBHOOK_SECRET: undefined } });
  assert.equal((await call(noSecret.env, "POST", webhookPath("sgc"), { body })).status, 503);
  assert.equal(mock.sent().length, 0, "no debe enviar mensajes");
});

test("webhook: el secreto también se acepta por header X-Webhook-Secret", async (t) => {
  const { env } = createEnv();
  const mock = installFetchMock(t);
  const r = await call(env, "POST", "/api/whatsapp/webhook", {
    body: waMessage({ text: "Hola" }),
    headers: { "X-Webhook-Secret": SECRETS.WEBHOOK_SECRET }
  });
  assert.equal(r.status, 200);
  assert.equal(mock.sent().length, 1);
});

test("webhook: comando APROBAR falsificado sin secreto no modifica el tenant", async (t) => {
  const { env, db } = createEnv();
  installFetchMock(t);
  const forged = waMessage({ from: ADMIN_PHONE, text: "APROBAR pendiente" });
  const r = await call(env, "POST", "/api/whatsapp/webhook", { body: forged });
  assert.equal(r.status, 401);
  assert.equal(db.row("SELECT status FROM tenants WHERE slug = 'pendiente'").status, "pending_approval");
});

test("webhook: comando admin por la instancia de un tenant no se ejecuta (se trata como cliente)", async (t) => {
  const { env, db } = createEnv();
  const mock = installFetchMock(t);
  await call(env, "POST", webhookPath("barberia"), { body: waMessage({ instance: "t_barberia", from: ADMIN_PHONE, text: "APROBAR pendiente" }) });
  assert.equal(db.row("SELECT status FROM tenants WHERE slug = 'pendiente'").status, "pending_approval");
  assert.equal(mock.sent()[0].instance, "t_barberia");
});

test("endpoints admin: 401 sin token, 401 con token incorrecto, 503 si ADMIN_TOKEN no está configurado", async (t) => {
  const { env } = createEnv();
  installFetchMock(t);
  const paths = [
    ["GET", "/api/admin/servicios"], ["POST", "/api/admin/servicios"], ["PUT", "/api/admin/servicios/1"], ["DELETE", "/api/admin/servicios/1"],
    ["GET", "/api/citas-admin"], ["POST", "/api/citas-admin/1/aprobar"], ["POST", "/api/citas-admin/1/rechazar"],
    ["GET", "/api/citas/stats"], ["GET", "/api/citas/rango?inicio=2026-01-01&fin=2026-12-31"],
    ["GET", "/api/consultar-citas?patente=ABCD12"], ["POST", "/api/consultar-vehiculo"],
    ["GET", "/api/onboarding/list"], ["GET", "/api/migrate"], ["GET", "/api/superadmin/tenants"], ["POST", "/api/superadmin/sync-webhooks"]
  ];
  for (const [m, p] of paths) {
    assert.equal((await call(env, m, p, { body: m === "GET" ? undefined : {} })).status, 401, `${m} ${p} sin token`);
    assert.equal((await call(env, m, p, { token: "malo", body: m === "GET" ? undefined : {} })).status, 401, `${m} ${p} token malo`);
  }
  const noAdmin = createEnv({ overrides: { ADMIN_TOKEN: undefined } });
  assert.equal((await call(noAdmin.env, "GET", "/api/admin/servicios", { token: "" })).status, 503);
});

test("endpoints admin: con ADMIN_TOKEN funcionan y /api/migrate ya no ejecuta ALTER TABLE", async (t) => {
  const { env } = createEnv();
  installFetchMock(t);
  const r = await call(env, "GET", "/api/admin/servicios", { token: SECRETS.ADMIN_TOKEN });
  assert.equal(r.status, 200);
  assert.ok(r.data.servicios.every((s) => s.tenant_id === 1), "solo servicios del tenant sgc");
  assert.equal((await call(env, "GET", "/api/migrate", { token: SECRETS.ADMIN_TOKEN })).status, 410);
});

test("panel de tenant: requiere la clave del propio tenant", async (t) => {
  const { env } = createEnv();
  installFetchMock(t);
  const keySgc = await tenantPanelKey(env, "sgc");
  const keyBarberia = await tenantPanelKey(env, "barberia");

  assert.equal((await call(env, "GET", "/api/tenant/dashboard?t=sgc")).status, 401);
  assert.equal((await call(env, "GET", "/api/tenant/dashboard?t=sgc", { token: keyBarberia })).status, 401, "clave de otro tenant");
  assert.equal((await call(env, "GET", "/api/tenant/dashboard?t=no-existe", { token: keySgc })).status, 401, "no revela si el slug existe");
  const ok = await call(env, "GET", "/api/tenant/dashboard?t=sgc", { token: keySgc });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.tenant.slug, "sgc");
  assert.equal((await call(env, "GET", "/api/tenant/dashboard?t=barberia", { token: SECRETS.ADMIN_TOKEN })).status, 200, "super-admin entra a cualquier panel");
});

test("panel de tenant: sin PANEL_SECRET nadie entra (falla cerrado)", async (t) => {
  const { env } = createEnv({ overrides: { PANEL_SECRET: undefined } });
  installFetchMock(t);
  assert.equal((await call(env, "GET", "/api/tenant/dashboard?t=sgc", { token: "cualquiera" })).status, 401);
});

test("todas las rutas mutantes del panel exigen clave", async (t) => {
  const { env } = createEnv();
  installFetchMock(t);
  for (const [m, p] of [["POST", "/api/tenant/citas?t=sgc"], ["POST", "/api/tenant/citas/1/aprobar?t=sgc"], ["POST", "/api/tenant/citas/1/rechazar?t=sgc"],
    ["POST", "/api/tenant/servicios?t=sgc"], ["PUT", "/api/tenant/servicios/1?t=sgc"], ["DELETE", "/api/tenant/servicios/1?t=sgc"],
    ["GET", "/api/tenant/horarios?t=sgc"], ["PUT", "/api/tenant/horarios?t=sgc"]]) {
    assert.equal((await call(env, m, p, { body: m === "GET" ? undefined : {} })).status, 401, `${m} ${p}`);
  }
});

test("QR de onboarding requiere la clave del tenant", async (t) => {
  const { env } = createEnv();
  installFetchMock(t);
  assert.equal((await call(env, "GET", "/api/onboarding/qr?slug=barberia")).status, 401);
  const key = await tenantPanelKey(env, "barberia");
  const r = await call(env, "GET", "/api/onboarding/qr?slug=barberia", { token: key });
  assert.equal(r.status, 200);
  assert.equal(r.data.qr_base64, "UVJDT0RF");
});

test("onboarding/status no expone la instancia ni una URL de Evolution", async (t) => {
  const { env } = createEnv();
  installFetchMock(t);
  const r = await call(env, "GET", "/api/onboarding/status?slug=barberia");
  assert.equal(r.status, 200);
  assert.equal(r.data.tenant.evolution_instance, undefined);
  assert.equal(r.data.qr_url, undefined);
  assert.equal(r.data.qr_available, true);
});

test("send-link: respuesta genérica y envío solo al WhatsApp registrado del tenant", async (t) => {
  const { env } = createEnv();
  const mock = installFetchMock(t);
  const r1 = await call(env, "POST", "/api/tenant/send-link", { body: { t: "barberia", whatsapp_number: "56900000000" } });
  const r2 = await call(env, "POST", "/api/tenant/send-link", { body: { t: "no-existe" } });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.data, r2.data, "no revela si el tenant existe");
  const sent = mock.sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].number, "56911111111");
  assert.match(sent[0].text, /panel\.test\/admin\?t=barberia#k=[0-9a-f]{32}/);
});

test("errores internos no filtran detalles", async (t) => {
  const { env } = createEnv();
  installFetchMock(t);
  env.DB.prepare = () => { throw new Error("SQLITE secreto: tabla interna"); };
  const r = await call(env, "GET", "/api/servicios");
  assert.equal(r.status, 500);
  assert.doesNotMatch(JSON.stringify(r.data), /secreto/);
});
