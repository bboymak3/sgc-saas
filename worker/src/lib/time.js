// ============================================================
// Fechas en zona horaria de Chile (America/Santiago)
// ============================================================

export const TZ = "America/Santiago";

const fmtDate = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const fmtTime = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const fmtWeekday = new Intl.DateTimeFormat("es-CL", { timeZone: TZ, weekday: "long" });

export const DIAS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
export const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// "YYYY-MM-DD" de hoy en Chile
export function hoyChile(now = new Date()) {
  return fmtDate.format(now);
}

// "HH:MM" actual en Chile
export function horaChile(now = new Date()) {
  return fmtTime.format(now);
}

export function diaSemanaChile(now = new Date()) {
  return fmtWeekday.format(now);
}

// Suma días a una fecha "YYYY-MM-DD" (aritmética de calendario pura, sin TZ)
export function addDays(fecha, days) {
  const [y, m, d] = fecha.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// Nombre del día ("lunes", "miercoles"...) de una fecha "YYYY-MM-DD"
export function diaSemanaDe(fecha) {
  const [y, m, d] = fecha.split("-").map(Number);
  return DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function isValidFecha(fecha) {
  if (typeof fecha !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const [y, m, d] = fecha.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Normaliza "9:5" / "09:05" / "9" → "09:05"; null si no es válida
export function normalizeHora(hora) {
  if (typeof hora !== "string" && typeof hora !== "number") return null;
  const m = String(hora).trim().match(/^([01]?\d|2[0-3])(?::([0-5]\d))?$/);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2] || "00"}`;
}

export function horaToMinutes(hora) {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + (m || 0);
}

// "lunes 5 de octubre"
export function formatDateSpanish(fechaStr) {
  if (!isValidFecha(fechaStr)) return fechaStr;
  const [, m, d] = fechaStr.split("-").map(Number);
  return `${diaSemanaDe(fechaStr)} ${d} de ${MESES[m - 1]}`;
}
