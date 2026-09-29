import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeD1 } from "./helpers/d1.js";
import { createEnv, installFetchMock, call, ADMIN_PHONE } from "./helpers/env.js";

function prodLikeDb() {
  const db = new FakeD1();
  db.execFile("schema/schema.sql");
  // Tablas huérfanas presentes en producción (vacías)
  for (const tname of ["AdminUsers", "SesionesAdmin", "AgendaTecnicos", "CostosAdicionales", "FotosTrabajo", "GastosNegocio",
    "LiquidacionOrden", "ModelosVehiculo", "NotasTrabajo", "NotificacionesWhatsApp", "Pagos", "ServiciosCatalogo", "Clientes"]) {
    db.exec_(`CREATE TABLE ${tname} (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT)`);
  }
  db.exec_(`
    INSERT INTO tenants (id, slug, business_name) VALUES (1,'sgc','SGC'),(2,'b','B'),(3,'c','C');
    INSERT INTO sgc_cit_WhatsApp_conversations (id, phone, tenant_id, client_context) VALUES (1,'569111',1,'{"patente":"AB1234"}'),(2,'569222',2,NULL);
    INSERT INTO sgc_cit_WhatsApp_messages (conversation_id, direction, content, tenant_id) VALUES (1,'inbound','hola',1),(1,'outbound','hola!',1),(2,'inbound','x',2);
    INSERT INTO sgc_cit_horarios (dia_semana, tenant_id) VALUES ('lunes',3),('martes',3),('lunes',3),('martes',3),('lunes',1);
    INSERT INTO sgc_cit_config (clave, valor, tenant_id) VALUES ('max_citas_por_dia','20',1),('anticipacion_dias','30',1);
    INSERT INTO sgc_cit_bloqueos (fecha, motivo, tenant_id) VALUES ('2026-12-25','Navidad',1);
    INSERT INTO sgc_ord_ConfigKV (key, value) VALUES ('tarifa_km','500');
  `);
  return db;
}

test("migraciones: se aplican sobre un esquema como el de producción sin perder datos", () => {
  const db = prodLikeDb();
  db.applyMigrations();

  const convs = db.rows("SELECT id, phone, tenant_id, client_context FROM sgc_cit_WhatsApp_conversations ORDER BY id");
  assert.deepEqual(convs.map((c) => [c.id, c.phone, c.tenant_id]), [[1, "569111", 1], [2, "569222", 2]]);
  assert.equal(convs[0].client_context, '{"patente":"AB1234"}');
  assert.equal(db.rows("SELECT * FROM sgc_cit_WhatsApp_messages").length, 3, "mensajes conservados");
  assert.equal(db.rows("PRAGMA foreign_key_check").length, 0, "sin FKs rotas");

  // 0001: mismo teléfono en otro tenant permitido, duplicado en el mismo tenant no
  db.exec_("INSERT INTO sgc_cit_WhatsApp_conversations (phone, tenant_id) VALUES ('569111', 2)");
  assert.throws(() => db.exec_("INSERT INTO sgc_cit_WhatsApp_conversations (phone, tenant_id) VALUES ('569111', 2)"), /UNIQUE/);

  // 0002: horarios deduplicados y protegidos
  assert.equal(db.rows("SELECT * FROM sgc_cit_horarios WHERE tenant_id = 3").length, 2);
  assert.throws(() => db.exec_("INSERT INTO sgc_cit_horarios (dia_semana, tenant_id) VALUES ('lunes', 3)"), /UNIQUE/);

  // 0003: config y bloqueos por tenant
  assert.equal(db.rows("SELECT * FROM sgc_cit_config").length, 2);
  db.exec_("INSERT INTO sgc_cit_config (clave, valor, tenant_id) VALUES ('max_citas_por_dia','5',2)");
  db.exec_("INSERT INTO sgc_cit_bloqueos (fecha, tenant_id) VALUES ('2026-12-25', 2)");
  assert.equal(db.row("SELECT motivo FROM sgc_cit_bloqueos WHERE tenant_id = 1").motivo, "Navidad");

  // 0004: huérfanas eliminadas salvo Clientes; TrackingTecnico creado
  const tables = db.rows("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  for (const gone of ["AdminUsers", "SesionesAdmin", "Pagos", "ServiciosCatalogo"]) assert.ok(!tables.includes(gone), gone);
  assert.ok(tables.includes("Clientes"));
  assert.ok(tables.includes("sgc_ord_TrackingTecnico"));

  // 0005: ConfigKV con las columnas que usa sgc-ordenes
  assert.equal(db.row("SELECT valor FROM sgc_ord_ConfigKV WHERE clave = 'tarifa_km'").valor, "500");
  db.exec_("INSERT INTO sgc_ord_ConfigKV (clave, valor, fecha_actualizacion) VALUES ('x','1',CURRENT_TIMESTAMP) ON CONFLICT(clave) DO UPDATE SET valor = '2'");
});

test("migraciones: 0001 funciona con foreign_keys activas y mensajes referenciando conversaciones", () => {
  const db = prodLikeDb();
  assert.equal(db.row("PRAGMA foreign_keys").foreign_keys, 1);
  db.applyMigrations();
  db.exec_("INSERT INTO sgc_cit_WhatsApp_messages (conversation_id, direction, content) VALUES (2, 'inbound', 'ok')");
  assert.throws(() => db.exec_("INSERT INTO sgc_cit_WhatsApp_messages (conversation_id, direction, content) VALUES (999, 'inbound', 'x')"), /FOREIGN KEY/);
});

test("onboarding: registro válido crea tenant pendiente y avisa al admin", async (t) => {
  const { env, db } = createEnv();
  const mock = installFetchMock(t);
  const r = await call(env, "POST", "/api/onboarding/register", {
    body: { business_name: "Peluquería Ñandú", whatsapp_number: "+56 9 7777 8888", rubro: "salon_belleza", email: "a@b.cl" }
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.slug, "peluqueria-nandu");
  const tn = db.row("SELECT * FROM tenants WHERE slug = 'peluqueria-nandu'");
  assert.equal(tn.status, "pending_approval");
  assert.equal(tn.whatsapp_number, "56977778888");
  assert.equal(tn.rubro, "salon_belleza");
  assert.match(mock.sent()[0].text, /APROBAR peluqueria-nandu/);
  assert.equal(mock.sent()[0].number, ADMIN_PHONE);
});

test("onboarding: validaciones y slugs únicos", async (t) => {
  const { env } = createEnv();
  installFetchMock(t);
  assert.equal((await call(env, "POST", "/api/onboarding/register", { body: { business_name: "X" } })).status, 400);
  assert.equal((await call(env, "POST", "/api/onboarding/register", { body: { business_name: "X", whatsapp_number: "12" } })).status, 400);
  assert.equal((await call(env, "POST", "/api/onboarding/register", { body: { business_name: "X", whatsapp_number: "56911112222", email: "malo" } })).status, 400);
  const a = await call(env, "POST", "/api/onboarding/register", { body: { business_name: "SGC", whatsapp_number: "56900000001", rubro: "inventado" } });
  assert.equal(a.data.slug, "sgc-2", "sgc ya existe");
  const again = await call(env, "POST", "/api/onboarding/register", { body: { business_name: "SGC", whatsapp_number: "56900000001" } });
  assert.equal(again.data.slug, "sgc-2", "misma solicitud pendiente: no duplica");
});

test("chat web y tenant/public rechazan tenants no operativos", async (t) => {
  const { env } = createEnv();
  installFetchMock(t);
  assert.equal((await call(env, "POST", "/api/chat?t=pendiente", { body: { messages: [{ role: "user", content: "hola" }] } })).status, 403);
  assert.equal((await call(env, "GET", "/api/tenant/public?t=suspendido")).status, 403);
  const ok = await call(env, "GET", "/api/tenant/public?t=barberia");
  assert.equal(ok.status, 200);
  assert.match(ok.data.horario, /domingo 10:00-14:00/);
});

test("rutas desconocidas /api/* devuelven 404 JSON y el resto va a assets", async (t) => {
  const { env } = createEnv();
  installFetchMock(t);
  assert.equal((await call(env, "GET", "/api/no-existe")).status, 404);
  const asset = await call(env, "GET", "/index.html");
  assert.equal(asset.data, "asset");
});
