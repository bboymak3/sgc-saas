import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnv, installFetchMock, call, waMessage, webhookPath, SECRETS, ADMIN_PHONE } from "./helpers/env.js";

const adminMsg = (text) => waMessage({ instance: "make peueba", from: ADMIN_PHONE, text });
const hook = `/api/whatsapp/webhook?k=${SECRETS.WEBHOOK_SECRET}`;

test("APROBAR: crea instancia con webhook autenticado, carga servicios, envía QR y enlace del panel", async (t) => {
  const { env, db } = createEnv();
  const mock = installFetchMock(t);
  await call(env, "POST", hook, { body: adminMsg("APROBAR pendiente") });

  const tenant = db.row("SELECT * FROM tenants WHERE slug = 'pendiente'");
  assert.equal(tenant.status, "approved");
  assert.equal(tenant.evolution_instance, "t_pendiente");

  const create = mock.calls.find((c) => c.url.endsWith("/instance/create"));
  assert.equal(create.body.instanceName, "t_pendiente");
  assert.equal(create.body.webhook.url, `https://worker.test/api/whatsapp/webhook?t=pendiente&k=${SECRETS.WEBHOOK_SECRET}`);
  assert.deepEqual(create.body.webhook.events, ["MESSAGES_UPSERT", "CONNECTION_UPDATE"]);

  const media = mock.calls.find((c) => c.url.includes("/message/sendMedia/"));
  assert.equal(media.body.number, "56922222222");
  assert.equal(media.body.media, "UVJDT0RF");

  const sent = mock.sent();
  const toOwner = sent.filter((s) => s.number === "56922222222").map((s) => s.text).join("\n");
  assert.match(toOwner, /panel\.test\/admin\?t=pendiente#k=[0-9a-f]{32}/);
  assert.doesNotMatch(toOwner, /evolution\.test/, "no se envía la URL de Evolution (requiere apikey)");
  const toAdmin = sent.find((s) => s.number === ADMIN_PHONE);
  assert.match(toAdmin.text, /Tenant aprobado/);

  assert.equal(db.row("SELECT COUNT(*) AS c FROM sgc_cit_servicios_unificados WHERE tenant_id = 3").c, 2);
  assert.equal(db.row("SELECT COUNT(*) AS c FROM sgc_cit_horarios WHERE tenant_id = 3").c, 7);
  assert.equal(db.row("SELECT command FROM admin_commands").command, "APROBAR");
});

test("APROBAR dos veces no duplica servicios ni horarios", async (t) => {
  const { env, db } = createEnv();
  installFetchMock(t, { "/instance/create": () => Response.json({ error: "already in use" }, { status: 403 }) });
  await call(env, "POST", hook, { body: adminMsg("APROBAR pendiente") });
  await call(env, "POST", hook, { body: adminMsg("aprobar pendiente") });
  assert.equal(db.row("SELECT COUNT(*) AS c FROM sgc_cit_servicios_unificados WHERE tenant_id = 3").c, 2);
  assert.equal(db.row("SELECT COUNT(*) AS c FROM sgc_cit_horarios WHERE tenant_id = 3").c, 7);
});

test("instancia ya existente: se reconfigura su webhook", async (t) => {
  const { env } = createEnv();
  const mock = installFetchMock(t, { "/instance/create": () => Response.json({ error: "already in use" }, { status: 403 }) });
  await call(env, "POST", hook, { body: adminMsg("APROBAR pendiente") });
  assert.ok(mock.calls.some((c) => c.url.endsWith("/webhook/set/t_pendiente")));
});

test("connection.update open: el tenant aprobado pasa a activo y se avisa", async (t) => {
  const { env, db } = createEnv();
  const mock = installFetchMock(t);
  await call(env, "POST", webhookPath("barberia"), { body: { event: "CONNECTION_UPDATE", instance: "t_barberia", data: { state: "open" } } });
  const t2 = db.row("SELECT status, active_at FROM tenants WHERE id = 2");
  assert.equal(t2.status, "active");
  assert.ok(t2.active_at);
  assert.ok(mock.sent().some((s) => s.number === "56911111111" && /ya está activo/.test(s.text)));
});

test("SUSPENDER detiene el bot y REACTIVAR lo vuelve a encender", async (t) => {
  const { env, db } = createEnv();
  const mock = installFetchMock(t);
  await call(env, "POST", hook, { body: adminMsg("SUSPENDER sgc") });
  assert.equal(db.row("SELECT status FROM tenants WHERE id = 1").status, "suspended");
  const before = mock.sent().length;
  await call(env, "POST", webhookPath("sgc"), { body: waMessage({ text: "Hola" }) });
  assert.equal(mock.sent().length, before, "suspendido: no responde");
  await call(env, "POST", hook, { body: adminMsg("REACTIVAR sgc") });
  assert.equal(db.row("SELECT status FROM tenants WHERE id = 1").status, "active");
});

test("RECHAZAR, LISTAR, ACTIVOS, LINK, AYUDA y errores de slug", async (t) => {
  const { env, db } = createEnv();
  const mock = installFetchMock(t);
  const last = () => mock.sent().filter((s) => s.number === ADMIN_PHONE).at(-1).text;
  await call(env, "POST", hook, { body: adminMsg("LISTAR") });
  assert.match(last(), /pendiente/);
  await call(env, "POST", hook, { body: adminMsg("ACTIVOS") });
  assert.match(last(), /SGC Taller/);
  assert.match(last(), /Barbería Don Juan/);
  await call(env, "POST", hook, { body: adminMsg("APROBAR") });
  assert.match(last(), /Falta el slug/);
  await call(env, "POST", hook, { body: adminMsg("APROBAR no-existe") });
  assert.match(last(), /No se encontró/);
  await call(env, "POST", hook, { body: adminMsg("LINK barberia") });
  assert.ok(mock.sent().some((s) => s.number === "56911111111" && /#k=/.test(s.text)));
  await call(env, "POST", hook, { body: adminMsg("RECHAZAR pendiente") });
  assert.equal(db.row("SELECT status FROM tenants WHERE id = 3").status, "rejected");
  await call(env, "POST", hook, { body: adminMsg("AYUDA") });
  assert.match(last(), /SYNC/);
});

test("SYNC reconfigura el webhook de todas las instancias operativas", async (t) => {
  const { env } = createEnv();
  const mock = installFetchMock(t);
  await call(env, "POST", hook, { body: adminMsg("SYNC") });
  const sets = mock.calls.filter((c) => c.url.includes("/webhook/set/")).map((c) => decodeURIComponent(c.url.split("/webhook/set/")[1]));
  assert.deepEqual(sets.sort(), ["make peueba", "t_barberia"]);
  const set = mock.calls.find((c) => c.url.includes("/webhook/set/t_barberia"));
  assert.match(set.body.webhook.url, /\?t=barberia&k=webhook-secret-de-prueba$/);
});

test("el admin puede probar el bot: texto que no es comando se trata como cliente", async (t) => {
  const { env, aiCalls } = createEnv();
  const mock = installFetchMock(t);
  await call(env, "POST", hook, { body: adminMsg("Hola, quiero una hora") });
  assert.equal(aiCalls.length, 1);
  assert.equal(mock.sent()[0].instance, "make peueba");
});

test("super-admin HTTP: listar tenants, obtener enlace del panel y sincronizar", async (t) => {
  const { env } = createEnv();
  installFetchMock(t);
  const list = await call(env, "GET", "/api/superadmin/tenants", { token: SECRETS.ADMIN_TOKEN });
  assert.equal(list.data.tenants.length, 4);
  const link = await call(env, "GET", "/api/superadmin/tenants/barberia/panel-link", { token: SECRETS.ADMIN_TOKEN });
  assert.match(link.data.panel, /^https:\/\/panel\.test\/admin\?t=barberia#k=[0-9a-f]{32}$/);
  const sync = await call(env, "POST", "/api/superadmin/sync-webhooks", { token: SECRETS.ADMIN_TOKEN });
  assert.equal(sync.data.results.length, 2);
});
