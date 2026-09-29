import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCitaFromHistory } from "../src/whatsapp/parser.js";
import { formatForWhatsApp } from "../src/whatsapp/format.js";
import { matchServicio } from "../src/whatsapp/tools.js";
import { hoyChile, addDays, isValidFecha, normalizeHora, formatDateSpanish, diaSemanaDe } from "../src/lib/time.js";
import { timingSafeEqual, tenantPanelKey } from "../src/lib/auth.js";
import { slugify } from "../src/onboarding.js";

const SERVICIOS = ["Cambio de Aceite", "Revisión General", "Frenos", "Corte + Barba"];
const hoy = hoyChile();

test("parser: fecha ISO, hora HH:MM y servicio exacto", () => {
  const r = parseCitaFromHistory([], "Quiero cambio de aceite el 2026-12-15 a las 10:30", SERVICIOS);
  assert.deepEqual({ fecha: r.fecha, hora: r.hora, servicio: r.servicio }, { fecha: "2026-12-15", hora: "10:30", servicio: "Cambio de Aceite" });
});

test("parser: 'pasado mañana' ya no se confunde con 'mañana'", () => {
  const r = parseCitaFromHistory([], "frenos pasado mañana a las 11:00", SERVICIOS);
  assert.equal(r.fecha, addDays(hoy, 2));
});

test("parser: '10 de la mañana' es hora, no la fecha de mañana", () => {
  const r = parseCitaFromHistory([], `frenos el ${addDays(hoy, 5)} a las 10 de la mañana`, SERVICIOS);
  assert.equal(r.fecha, addDays(hoy, 5));
  assert.equal(r.hora, "10:00");
});

test("parser: '3 de la tarde' y '4pm' → 24h", () => {
  assert.equal(parseCitaFromHistory([], "frenos mañana a las 3 de la tarde", SERVICIOS).hora, "15:00");
  assert.equal(parseCitaFromHistory([], "frenos mañana 4pm", SERVICIOS).hora, "16:00");
});

test("parser: precios como $15.000 no se leen como hora", () => {
  const r = parseCitaFromHistory([{ role: "assistant", content: "El cambio de aceite cuesta $15.000" }], "ok mañana", SERVICIOS);
  assert.equal(r, null, "sin hora no se agenda");
});

test("parser: usa el dato más reciente de la conversación", () => {
  const history = [
    { role: "user", content: "frenos el 2026-12-10 a las 09:00" },
    { role: "assistant", content: "Te agendo para el 2026-12-11 a las 12:00 para Frenos. ¿Confirmas?" }
  ];
  const r = parseCitaFromHistory(history, "sí", SERVICIOS);
  assert.equal(r.fecha, "2026-12-11");
  assert.equal(r.hora, "12:00");
});

test("parser: servicios del tenant (no la lista fija del taller) y coincidencia parcial", () => {
  assert.equal(parseCitaFromHistory([], "corte + barba mañana 10:00", SERVICIOS).servicio, "Corte + Barba");
  assert.equal(parseCitaFromHistory([], "el aceite mañana 10:00", SERVICIOS).servicio, "Cambio de Aceite");
  assert.equal(parseCitaFromHistory([], "manicure mañana 10:00", SERVICIOS), null);
});

test("parser: 'el lunes' → próximo lunes; dd/mm sin año", () => {
  const r = parseCitaFromHistory([], "frenos el lunes a las 10:00", SERVICIOS);
  assert.equal(diaSemanaDe(r.fecha), "lunes");
  assert.ok(r.fecha > hoy);
  const r2 = parseCitaFromHistory([], "frenos 25/12 10:00", SERVICIOS);
  assert.match(r2.fecha, /^\d{4}-12-25$/);
});

test("parser: patente chilena y marca", () => {
  const r = parseCitaFromHistory([], "frenos mañana 10:00, patente ABCD12, es un Toyota", SERVICIOS);
  assert.equal(r.patente, "ABCD12");
  assert.equal(r.marca, "Toyota");
});

test("time: validaciones y formato", () => {
  assert.equal(isValidFecha("2026-02-30"), false);
  assert.equal(isValidFecha("2026-02-28"), true);
  assert.equal(isValidFecha("martes"), false);
  assert.equal(normalizeHora("9:05"), "09:05");
  assert.equal(normalizeHora("9"), "09:00");
  assert.equal(normalizeHora("25:00"), null);
  assert.equal(formatDateSpanish("2026-10-05"), "lunes 5 de octubre");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("format: markdown → WhatsApp", () => {
  assert.equal(formatForWhatsApp("## Hola **Juan**\n\n\n\n[link](http://x)"), "Hola *Juan*\n\nlink");
});

test("matchServicio: tolera tildes, mayúsculas y nombres parciales", () => {
  const s = [{ nombre: "Revisión Técnica" }, { nombre: "Frenos" }];
  assert.equal(matchServicio(s, "revision tecnica").nombre, "Revisión Técnica");
  assert.equal(matchServicio(s, "FRENOS delanteros").nombre, "Frenos");
  assert.equal(matchServicio(s, "pintura"), null);
});

test("auth: comparación en tiempo constante y clave de panel determinística", async () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), false);
  const env = { PANEL_SECRET: "s" };
  const k1 = await tenantPanelKey(env, "a");
  assert.equal(k1, await tenantPanelKey(env, "a"));
  assert.notEqual(k1, await tenantPanelKey(env, "b"));
  assert.notEqual(k1, await tenantPanelKey({ PANEL_SECRET: "otro" }, "a"));
  assert.match(k1, /^[0-9a-f]{32}$/);
  assert.equal(await tenantPanelKey({}, "a"), null);
});

test("slugify: tildes, símbolos y largo", () => {
  assert.equal(slugify("Barbería Don Juan!!"), "barberia-don-juan");
  assert.equal(slugify("Taller  Juan -- Make "), "taller-juan-make");
  assert.ok(slugify("x".repeat(80)).length <= 30);
});
