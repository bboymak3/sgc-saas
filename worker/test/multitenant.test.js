import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnv, installFetchMock, call, waMessage, webhookPath, nextDay, SECRETS } from "./helpers/env.js";
import { tenantPanelKey } from "../src/lib/auth.js";

const toolCall = (name, args) => ({ response: "", tool_calls: [{ name, arguments: args }] });

test("cada tenant responde desde SU instancia de Evolution", async (t) => {
  const { env } = createEnv();
  const mock = installFetchMock(t);
  await call(env, "POST", webhookPath("sgc"), { body: waMessage({ instance: "make peueba", text: "Hola" }) });
  await call(env, "POST", webhookPath("barberia"), { body: waMessage({ instance: "t_barberia", text: "Hola" }) });
  const sent = mock.sent();
  assert.deepEqual(sent.map((s) => s.instance), ["make peueba", "t_barberia"]);
});

test("el tenant se identifica por la instancia aunque la URL traiga otro ?t=", async (t) => {
  const { env, aiCalls } = createEnv();
  const mock = installFetchMock(t);
  await call(env, "POST", webhookPath("sgc"), { body: waMessage({ instance: "t_barberia", text: "Hola" }) });
  assert.equal(mock.sent()[0].instance, "t_barberia");
  assert.match(aiCalls[0].opts.messages[0].content, /Barbería Don Juan/);
  assert.match(aiCalls[0].opts.messages[0].content, /una barbería/);
  assert.doesNotMatch(aiCalls[0].opts.messages[0].content, /taller mec/);
});

test("instancia desconocida sin ?t= válido: no se responde (antes caía en el tenant 1)", async (t) => {
  const { env, aiCalls } = createEnv();
  const mock = installFetchMock(t);
  const r = await call(env, "POST", `/api/whatsapp/webhook?k=${SECRETS.WEBHOOK_SECRET}`, { body: waMessage({ instance: "t_desconocida" }) });
  assert.equal(r.status, 200);
  assert.equal(mock.sent().length, 0);
  assert.equal(aiCalls.length, 0);
});

test("tenants pendientes o suspendidos no responden", async (t) => {
  const { env } = createEnv();
  const mock = installFetchMock(t);
  await call(env, "POST", webhookPath("suspendido"), { body: waMessage({ instance: "t_suspendido" }) });
  await call(env, "POST", webhookPath("pendiente"), { body: waMessage({ instance: "t_pendiente" }) });
  assert.equal(mock.sent().length, 0);
});

test("un mismo cliente puede hablar con dos negocios (con migración 0001)", async (t) => {
  const { env, db } = createEnv();
  const mock = installFetchMock(t);
  await call(env, "POST", webhookPath("sgc"), { body: waMessage({ instance: "make peueba", from: "56955555555" }) });
  await call(env, "POST", webhookPath("barberia"), { body: waMessage({ instance: "t_barberia", from: "56955555555" }) });
  assert.equal(mock.sent().length, 2);
  const convs = db.rows("SELECT tenant_id FROM sgc_cit_WhatsApp_conversations WHERE phone = '56955555555' ORDER BY tenant_id");
  assert.deepEqual(convs.map((c) => c.tenant_id), [1, 2]);
});

test("sin migración 0001 el bot igual responde al segundo negocio (sin historial)", async (t) => {
  const { env, db } = createEnv({ migrated: false });
  const mock = installFetchMock(t);
  await call(env, "POST", webhookPath("sgc"), { body: waMessage({ instance: "make peueba", from: "56955555555" }) });
  await call(env, "POST", webhookPath("barberia"), { body: waMessage({ instance: "t_barberia", from: "56955555555" }) });
  assert.equal(mock.sent().length, 2, "antes: UNIQUE constraint → excepción → sin respuesta");
  assert.equal(db.rows("SELECT * FROM sgc_cit_WhatsApp_conversations").length, 1);
});

test("el historial de un negocio no se mezcla con el de otro", async (t) => {
  const { env, aiCalls } = createEnv();
  installFetchMock(t);
  await call(env, "POST", webhookPath("sgc"), { body: waMessage({ instance: "make peueba", from: "56955555555", text: "Quiero cambio de aceite" }) });
  await call(env, "POST", webhookPath("barberia"), { body: waMessage({ instance: "t_barberia", from: "56955555555", text: "Hola barbería" }) });
  const msgs = aiCalls[1].opts.messages.map((m) => m.content).join("\n");
  assert.doesNotMatch(msgs, /cambio de aceite/i);
});

test("la disponibilidad es por tenant: una cita del taller no bloquea la barbería", async (t) => {
  const { env, db, aiQueue } = createEnv();
  const mock = installFetchMock(t);
  const fecha = nextDay("martes");
  db.exec_(`INSERT INTO sgc_cit_Citas (fecha_cita, hora_cita, servicio, estado, telefono, tenant_id) VALUES ('${fecha}', '11:00', 'Frenos', 'confirmada', '569000', 1)`);
  aiQueue.push(toolCall("agendar_cita", JSON.stringify({ fecha, hora: "11:00", servicio: "Corte de Cabello" })));
  await call(env, "POST", webhookPath("barberia"), { body: waMessage({ instance: "t_barberia", text: "sí, agenda" }) });
  const cita = db.row("SELECT * FROM sgc_cit_Citas WHERE tenant_id = 2");
  assert.ok(cita, "la barbería pudo agendar a la misma hora que el taller");
  assert.equal(cita.hora_cita, "11:00");
  assert.match(mock.sent()[0].text, /Cita agendada/);
});

test("el horario es el de cada tenant (no el horario fijo del taller)", async (t) => {
  const { env, db, aiQueue } = createEnv();
  const mock = installFetchMock(t);
  const martes = nextDay("martes");
  const domingo = nextDay("domingo");
  // Barbería abre 10:00: 09:00 debe rechazarse aunque el taller abra a las 08:00
  aiQueue.push(toolCall("agendar_cita", JSON.stringify({ fecha: martes, hora: "09:00", servicio: "Barba" })));
  await call(env, "POST", webhookPath("barberia"), { body: waMessage({ instance: "t_barberia", text: "sí" }) });
  assert.match(mock.sent()[0].text, /atendemos de 10:00 a 19:00/);
  // Barbería abre los domingos; el taller no
  aiQueue.push(toolCall("agendar_cita", JSON.stringify({ fecha: domingo, hora: "11:00", servicio: "Barba" })));
  await call(env, "POST", webhookPath("barberia"), { body: waMessage({ instance: "t_barberia", text: "sí" }) });
  assert.equal(db.rows("SELECT * FROM sgc_cit_Citas WHERE tenant_id = 2").length, 1);
  aiQueue.push(toolCall("agendar_cita", JSON.stringify({ fecha: domingo, hora: "11:00", servicio: "Frenos" })));
  await call(env, "POST", webhookPath("sgc"), { body: waMessage({ instance: "make peueba", text: "sí" }) });
  assert.match(mock.sent()[2].text, /cerrados/);
});

test("consultar_citas_cliente solo devuelve citas del remitente y del tenant", async (t) => {
  const { env, db, aiQueue } = createEnv();
  const mock = installFetchMock(t);
  const f = nextDay("jueves");
  db.exec_(`INSERT INTO sgc_cit_Citas (fecha_cita, hora_cita, servicio, estado, telefono, tenant_id) VALUES
    ('${f}', '10:00', 'Frenos', 'pendiente', '56987654321', 1),
    ('${f}', '12:00', 'Cambio de Aceite', 'pendiente', '56911112222', 1),
    ('${f}', '15:00', 'Corte de Cabello', 'pendiente', '56987654321', 2)`);
  // La IA intenta consultar el teléfono de otra persona: se ignora
  aiQueue.push(toolCall("consultar_citas_cliente", JSON.stringify({ telefono: "56911112222" })));
  await call(env, "POST", webhookPath("sgc"), { body: waMessage({ instance: "make peueba", from: "56987654321", text: "mis citas?" }) });
  const text = mock.sent()[0].text;
  assert.match(text, /Frenos/);
  assert.doesNotMatch(text, /Cambio de Aceite/);
  assert.doesNotMatch(text, /Corte de Cabello/);
});

test("cancelar_cita no permite cancelar citas de otro cliente u otro tenant", async (t) => {
  const { env, db, aiQueue } = createEnv();
  installFetchMock(t);
  const f = nextDay("jueves");
  db.exec_(`INSERT INTO sgc_cit_Citas (id, fecha_cita, hora_cita, servicio, estado, telefono, tenant_id) VALUES
    (50, '${f}', '10:00', 'Frenos', 'pendiente', '56911112222', 1),
    (51, '${f}', '15:00', 'Barba', 'pendiente', '56987654321', 2)`);
  aiQueue.push(toolCall("cancelar_cita", JSON.stringify({ cita_id: 50 })));
  await call(env, "POST", webhookPath("sgc"), { body: waMessage({ instance: "make peueba", from: "56987654321", text: "cancela la 50" }) });
  aiQueue.push(toolCall("cancelar_cita", JSON.stringify({ cita_id: 51 })));
  await call(env, "POST", webhookPath("sgc"), { body: waMessage({ instance: "make peueba", from: "56987654321", text: "cancela la 51" }) });
  assert.equal(db.row("SELECT estado FROM sgc_cit_Citas WHERE id = 50").estado, "pendiente");
  assert.equal(db.row("SELECT estado FROM sgc_cit_Citas WHERE id = 51").estado, "pendiente");
});

test("panel: un tenant no puede ver ni aprobar citas de otro", async (t) => {
  const { env, db } = createEnv();
  const mock = installFetchMock(t);
  db.exec_(`INSERT INTO sgc_cit_Citas (id, fecha_cita, hora_cita, servicio, estado, telefono, tenant_id) VALUES (70, '2026-12-01', '10:00', 'Frenos', 'pendiente', '569', 1)`);
  const key = await tenantPanelKey(env, "barberia");
  const list = await call(env, "GET", "/api/tenant/citas?t=barberia", { token: key });
  assert.equal(list.data.citas.length, 0);
  const r = await call(env, "POST", "/api/tenant/citas/70/aprobar?t=barberia", { token: key, body: {} });
  assert.equal(r.status, 404);
  assert.equal(db.row("SELECT estado_aprobacion FROM sgc_cit_Citas WHERE id = 70").estado_aprobacion, "pendiente");
  assert.equal(mock.sent().length, 0);
});

test("panel: no se pueden editar servicios de otro tenant", async (t) => {
  const { env, db } = createEnv();
  installFetchMock(t);
  const key = await tenantPanelKey(env, "barberia");
  const r = await call(env, "PUT", "/api/tenant/servicios/1?t=barberia", { token: key, body: { precio: 1 } });
  assert.equal(r.status, 404);
  assert.equal(db.row("SELECT precio FROM sgc_cit_servicios_unificados WHERE id = 1").precio, 15000);
});

test("endpoints públicos filtran por tenant", async (t) => {
  const { env } = createEnv();
  installFetchMock(t);
  const sgc = await call(env, "GET", "/api/servicios");
  const barb = await call(env, "GET", "/api/servicios?t=barberia");
  assert.deepEqual(sgc.data.servicios.map((s) => s.nombre), ["Cambio de Aceite", "Frenos"]);
  assert.deepEqual(barb.data.servicios.map((s) => s.nombre), ["Corte de Cabello", "Barba"]);
  assert.equal((await call(env, "GET", "/api/servicios?t=no-existe")).status, 404, "antes caía al tenant sgc");
  assert.equal((await call(env, "GET", "/api/servicios?t=suspendido")).status, 403);
});

test("citas-admin (legacy) solo muestra el tenant pedido e incluye citas de WhatsApp", async (t) => {
  const { env, db } = createEnv();
  installFetchMock(t);
  db.exec_(`INSERT INTO sgc_cit_Citas (fecha_cita, hora_cita, servicio, canal, telefono, tenant_id) VALUES
    ('2026-12-01','10:00','Frenos','whatsapp','1',1), ('2026-12-01','11:00','Frenos','chat','2',1), ('2026-12-01','12:00','Barba','whatsapp','3',2)`);
  const r = await call(env, "GET", "/api/citas-admin", { token: SECRETS.ADMIN_TOKEN });
  assert.equal(r.data.citas.length, 2);
  assert.ok(r.data.citas.every((c) => c.tenant_id === 1));
});
