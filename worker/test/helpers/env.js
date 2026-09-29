// Entorno de pruebas: D1 con el esquema real, IA y Evolution simulados.
import { FakeD1 } from "./d1.js";
import worker from "../../src/index.js";
import { hoyChile, addDays, diaSemanaDe } from "../../src/lib/time.js";

export const SECRETS = {
  ADMIN_TOKEN: "admin-token-de-prueba-123",
  PANEL_SECRET: "panel-secret-de-prueba",
  WEBHOOK_SECRET: "webhook-secret-de-prueba"
};

export const ADMIN_PHONE = "584167775771";

export function seed(db) {
  db.exec_(`
    INSERT INTO tenants (id, slug, business_name, business_phone, whatsapp_number, rubro, status, evolution_instance, active_at) VALUES
      (1, 'sgc', 'SGC Taller', '56939026185', '56939026185', 'taller', 'active', 'make peueba', '2026-01-01'),
      (2, 'barberia', 'Barbería Don Juan', '56911111111', '56911111111', 'barberia', 'approved', 't_barberia', NULL),
      (3, 'pendiente', 'Negocio Pendiente', '56922222222', '56922222222', 'otro', 'pending_approval', NULL, NULL),
      (4, 'suspendido', 'Negocio Suspendido', '56933333333', '56933333333', 'otro', 'suspended', 't_suspendido', NULL);

    INSERT INTO sgc_cit_horarios (dia_semana, hora_apertura, hora_cierre, intervalo_minutos, activo, tenant_id) VALUES
      ('lunes','08:00','18:00',30,1,1),('martes','08:00','18:00',30,1,1),('miercoles','08:00','18:00',30,1,1),
      ('jueves','08:00','18:00',30,1,1),('viernes','08:00','18:00',30,1,1),('sabado','09:00','14:00',30,1,1),
      ('domingo','00:00','00:00',30,0,1),
      ('lunes','10:00','19:00',30,1,2),('martes','10:00','19:00',30,1,2),('miercoles','10:00','19:00',30,1,2),
      ('jueves','10:00','19:00',30,1,2),('viernes','10:00','19:00',30,1,2),('sabado','10:00','19:00',30,1,2),
      ('domingo','10:00','14:00',30,1,2);

    INSERT INTO sgc_cit_config (clave, valor, tenant_id) VALUES ('max_citas_por_dia','20',1);

    INSERT INTO sgc_cit_servicios_unificados (nombre, descripcion, precio, duracion_minutos, activo, orden, tenant_id) VALUES
      ('Cambio de Aceite','Aceite y filtro',15000,30,1,1,1),
      ('Frenos','Revisión de frenos',35000,90,1,2,1),
      ('Servicio Viejo','Inactivo',1000,30,0,3,1),
      ('Corte de Cabello','Corte clásico',8000,30,1,1,2),
      ('Barba','Perfilado',5000,20,1,2,2);
  `);
}

// Fecha futura (YYYY-MM-DD) que cae en el día pedido, al menos `minDays` días adelante
export function nextDay(dia, minDays = 1) {
  let f = addDays(hoyChile(), minDays);
  for (let i = 0; i < 8 && diaSemanaDe(f) !== dia; i++) f = addDays(f, 1);
  return f;
}

export function createEnv({ migrated = true, overrides = {} } = {}) {
  const db = new FakeD1();
  db.execFile("schema/schema.sql");
  if (migrated) db.applyMigrations();
  seed(db);

  const aiCalls = [];
  const aiQueue = [];
  const AI = {
    async run(model, opts) {
      aiCalls.push({ model, opts });
      if (opts.stream) {
        return new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"response":"Hola"}\n\ndata: [DONE]\n\n'));
            c.close();
          }
        });
      }
      const next = aiQueue.shift();
      if (typeof next === "function") return next(opts);
      return next || { response: "¡Hola! ¿En qué te ayudo?" };
    }
  };

  const env = {
    DB: db,
    TALLER_DB: db,
    AI,
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    BUSINESS_NAME: "SGC",
    BUSINESS_PHONE: "56939026185",
    SGCORDENES_URL: "https://ordenes.test",
    EVOLUTION_API_URL: "https://evolution.test",
    EVOLUTION_API_KEY: "evo-key",
    EVOLUTION_INSTANCE_NAME: "make peueba",
    ADMIN_PHONE,
    PUBLIC_WORKER_URL: "https://worker.test",
    PANEL_URL: "https://panel.test",
    __TEST_NO_WAIT: true,
    ...SECRETS,
    ...overrides
  };
  return { env, db, aiCalls, aiQueue };
}

// fetch global simulado (Evolution API y sgc-ordenes)
export function installFetchMock(t, handlers = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch (e) { body = init.body; }
    calls.push({ url, method: init.method || "GET", body, headers: init.headers || {} });
    for (const [pattern, fn] of Object.entries(handlers)) {
      if (url.includes(pattern)) return fn(url, init, body);
    }
    if (url.includes("/instance/connect/")) return Response.json({ base64: "data:image/png;base64,UVJDT0RF" });
    if (url.includes("/instance/create")) return Response.json({ instance: { instanceName: "x" } }, { status: 201 });
    if (url.includes("/crear-orden-express")) return Response.json({ success: true, numero_orden: 321 });
    return Response.json({ ok: true });
  };
  t.after(() => { globalThis.fetch = original; });
  return {
    calls,
    sent: () => calls.filter((c) => c.url.includes("/message/sendText/")).map((c) => ({
      instance: decodeURIComponent(c.url.split("/message/sendText/")[1]),
      number: c.body.number,
      text: c.body.text
    }))
  };
}

export async function call(env, method, path, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (token) h["Authorization"] = `Bearer ${token}`;
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const res = await worker.fetch(new Request(`https://worker.test${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body))
  }), env, ctx);
  await Promise.all(pending);
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch (e) { /* texto plano */ }
  return { status: res.status, data, headers: res.headers };
}

export function waMessage({ instance = "make peueba", from = "56987654321", text = "Hola", fromMe = false, pushName = "Cliente" } = {}) {
  return {
    event: "messages.upsert",
    instance,
    data: {
      key: { remoteJid: `${from}@s.whatsapp.net`, fromMe, id: "MSG" + Math.random() },
      pushName,
      message: { conversation: text }
    }
  };
}

export function webhookPath(slug) {
  return `/api/whatsapp/webhook?t=${slug}&k=${SECRETS.WEBHOOK_SECRET}`;
}
