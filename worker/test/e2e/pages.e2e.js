// Pruebas end-to-end en Chromium de las páginas de sgc-saas/pages contra el
// worker real (en proceso) con D1 simulada. Requiere: npm i -D playwright
// Ejecutar: npm run test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import worker from "../../src/index.js";
import { createEnv, nextDay } from "../helpers/env.js";
import { tenantPanelKey } from "../../src/lib/auth.js";

const PAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "pages");
const PANEL = "https://panel.test";
const WORKER = "https://sgc-saas.activo.workers.dev";

let browser;
before(async () => {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser.close(); });

async function setup(t, { stream } = {}) {
  const ctx = createEnv();
  const sent = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/message/sendText/")) sent.push(JSON.parse(init.body));
    if (url.includes("/instance/connect/")) return Response.json({ base64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" });
    return Response.json({ ok: true });
  };
  t.after(() => { globalThis.fetch = origFetch; });
  if (stream) {
    const run = ctx.env.AI.run;
    ctx.env.AI.run = async (model, opts) => opts.stream
      ? new Response(`data: ${JSON.stringify({ response: stream })}\n\ndata: [DONE]\n\n`).body
      : run(model, opts);
  }

  const context = await browser.newContext();
  t.after(() => context.close());
  // Páginas estáticas de /pages (Cloudflare Pages sirve /admin → admin.html)
  await context.route(`${PANEL}/**`, async (route) => {
    const u = new URL(route.request().url());
    let file = u.pathname.replace(/^\//, "") || "index.html";
    if (!file.includes(".")) file += ".html";
    try {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: readFileSync(join(PAGES, file)) });
    } catch (e) {
      await route.fulfill({ status: 404, body: "not found" });
    }
  });
  // API del worker
  await context.route(`${WORKER}/**`, async (route) => {
    const r = route.request();
    const pending = [];
    const res = await worker.fetch(new Request(r.url(), {
      method: r.method(),
      headers: r.headers(),
      body: ["GET", "HEAD"].includes(r.method()) ? undefined : r.postData()
    }), ctx.env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
  // CDNs externos (fuentes, íconos): no son necesarios para la prueba
  await context.route(/^https:\/\/(?!panel\.test|sgc-saas\.activo)/, (route) => route.fulfill({ status: 200, body: "" }));
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], "sin errores JS en la página"));
  return { ...ctx, page, sent };
}

test("panel: sin clave muestra el acceso; clave incorrecta se rechaza", async (t) => {
  const { page } = await setup(t);
  await page.goto(`${PANEL}/admin?t=barberia`);
  await page.waitForSelector("#loginState", { state: "visible" });
  await page.fill("#loginKey", "0123456789abcdef0123456789abcdef");
  await page.click("#loginForm button[type=submit]");
  await page.waitForFunction(() => /no es válida/.test(document.getElementById("loginMsg").textContent));
});

test("panel: con #k= carga, oculta la clave de la URL, aprueba citas y edita horarios", async (t) => {
  const { page, env, db, sent } = await setup(t);
  db.exec_(`INSERT INTO sgc_cit_Citas (id, fecha_cita, hora_cita, servicio, nombre_cliente, telefono, tenant_id) VALUES (5, '2026-12-01', '11:00', 'Barba', 'Luis <b>XSS</b>', '56900000001', 2)`);
  const key = await tenantPanelKey(env, "barberia");
  await page.goto(`${PANEL}/admin?t=barberia#k=${key}`);
  await page.waitForSelector("#mainContent", { state: "visible" });
  assert.equal(await page.textContent("#tenantName"), "Barbería Don Juan");
  assert.ok(!page.url().includes(key), "la clave se quita de la barra de direcciones");
  await page.waitForSelector("button.approve");
  assert.equal(await page.locator("#citasBody b").count(), 0, "nombres de clientes escapados (sin HTML inyectado)");

  await page.click("button.approve");
  await page.waitForFunction(() => document.querySelectorAll("button.approve").length === 0);
  assert.equal(db.row("SELECT estado_aprobacion FROM sgc_cit_Citas WHERE id = 5").estado_aprobacion, "aprobada");
  assert.equal(sent.length, 1);

  await page.click('.tab[data-tab="config"]');
  await page.waitForSelector('#horariosBody input[data-f="hora_apertura"]');
  await page.fill('#horariosBody input[data-i="0"][data-f="hora_apertura"]', "11:30");
  await page.fill("#cfgSimultaneas", "3");
  await page.click("#saveHorariosBtn");
  await page.waitForFunction(() => document.getElementById("toastContainer").textContent.includes("Horario guardado"));
  assert.equal(db.row("SELECT hora_apertura FROM sgc_cit_horarios WHERE tenant_id = 2 AND dia_semana = 'lunes'").hora_apertura, "11:30");
  assert.equal(db.row("SELECT valor FROM sgc_cit_config WHERE tenant_id = 2 AND clave = 'citas_simultaneas'").valor, "3");

  // Recargar sin #k= usa la clave guardada
  await page.goto(`${PANEL}/admin?t=barberia`);
  await page.waitForSelector("#mainContent", { state: "visible" });
});

test("status: con clave muestra el QR obtenido vía worker; sin clave pide el enlace", async (t) => {
  const { page, env } = await setup(t);
  await page.goto(`${PANEL}/status?slug=barberia`);
  await page.waitForSelector("text=Enviarme el enlace por WhatsApp");
  const key = await tenantPanelKey(env, "barberia");
  await page.goto("about:blank");
  await page.goto(`${PANEL}/status?slug=barberia#k=${key}`);
  await page.waitForFunction(() => {
    const img = document.getElementById("qrImg");
    return img && img.src.startsWith("data:image/png;base64,") && img.style.display === "block";
  });
});

test("chat web: el bloque CITA_JSON muestra confirmación y agenda con /api/agendar", async (t) => {
  const fecha = nextDay("martes");
  const cita = { nombre: "Ana", telefono: "+56911112222", servicio: "Barba", fecha, hora: "12:00" };
  const { page, db } = await setup(t, { stream: `¡Perfecto! [CITA_JSON]${JSON.stringify(cita)}[/CITA_JSON]` });
  await page.goto(`${PANEL}/chat?t=barberia`);
  await page.waitForFunction(() => !document.getElementById("messageInput").disabled);
  await page.fill("#messageInput", "sí, confirmo");
  await page.click("#sendBtn");
  await page.waitForSelector("button.cita-ok");
  const botText = await page.locator(".message.bot").allTextContents();
  assert.ok(!botText.join(" ").includes("[CITA_JSON]"), "el JSON crudo no se muestra");
  await page.click("button.cita-ok");
  await page.waitForSelector("text=Tu cita quedó registrada");
  const row = db.row("SELECT * FROM sgc_cit_Citas WHERE tenant_id = 2");
  assert.equal(row.fecha_cita, fecha);
  assert.equal(row.canal, "web");
});
