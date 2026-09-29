// ============================================================
// Horarios y disponibilidad POR TENANT
//
// Fuente de verdad: sgc_cit_horarios (dia_semana, hora_apertura, hora_cierre,
// intervalo_minutos, activo, tenant_id) + sgc_cit_bloqueos + sgc_cit_config.
// El bot de WhatsApp, el chat web, /api/agendar y el panel usan estas funciones.
// ============================================================

import { hoyChile, horaChile, diaSemanaDe, isValidFecha, normalizeHora, horaToMinutes, addDays } from "./time.js";

const CONFIG_DEFAULTS = {
  max_citas_por_dia: 20,
  citas_simultaneas: 1,
  limite_horas_antes: 0,
  anticipacion_dias: 60
};

const DIAS_ORDEN = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"];

export async function getConfig(env, tenantId) {
  const res = await env.DB.prepare(
    "SELECT clave, valor FROM sgc_cit_config WHERE tenant_id = ?"
  ).bind(tenantId).all();
  const cfg = { ...CONFIG_DEFAULTS };
  for (const row of res.results || []) {
    if (!(row.clave in CONFIG_DEFAULTS)) continue;
    const n = parseInt(row.valor, 10);
    if (Number.isFinite(n) && n >= 0) cfg[row.clave] = n;
  }
  return cfg;
}

export async function getHorarios(env, tenantId) {
  const res = await env.DB.prepare(
    "SELECT dia_semana, hora_apertura, hora_cierre, intervalo_minutos, activo FROM sgc_cit_horarios WHERE tenant_id = ? ORDER BY id ASC"
  ).bind(tenantId).all();
  // Si hay filas duplicadas para un día, gana la primera
  const byDay = {};
  for (const h of res.results || []) {
    if (!byDay[h.dia_semana]) byDay[h.dia_semana] = h;
  }
  return byDay;
}

// Texto para el prompt de la IA: "lunes 09:00-18:00, ..., domingo cerrado"
export async function describeHorario(env, tenantId) {
  const horarios = await getHorarios(env, tenantId);
  if (!Object.keys(horarios).length) return "consultar horario directamente con el negocio";
  return DIAS_ORDEN.map((d) => {
    const h = horarios[d];
    return h && h.activo ? `${d} ${h.hora_apertura}-${h.hora_cierre}` : `${d} cerrado`;
  }).join(", ");
}

// Carga en 4 consultas todo lo necesario para evaluar slots de una fecha
async function loadDay(env, tenantId, fecha) {
  const [horarios, config, bloqueo, citas] = await Promise.all([
    getHorarios(env, tenantId),
    getConfig(env, tenantId),
    env.DB.prepare("SELECT motivo FROM sgc_cit_bloqueos WHERE tenant_id = ? AND fecha = ?").bind(tenantId, fecha).first(),
    env.DB.prepare(
      "SELECT hora_cita, duracion_minutos FROM sgc_cit_Citas WHERE tenant_id = ? AND fecha_cita = ? AND estado NOT IN ('cancelada', 'no_asistio')"
    ).bind(tenantId, fecha).all()
  ]);
  return {
    fecha,
    horario: horarios[diaSemanaDe(fecha)] || null,
    config,
    bloqueo,
    citas: (citas.results || [])
      .map((c) => ({ ini: normalizeHora(c.hora_cita), dur: c.duracion_minutos || 60 }))
      .filter((c) => c.ini)
      .map((c) => ({ ini: horaToMinutes(c.ini), dur: c.dur }))
  };
}

function overlaps(startA, durA, startB, durB) {
  return startA < startB + durB && startB < startA + durA;
}

// Evalúa un slot contra el contexto del día (sin consultas)
function checkSlot(day, hora, duracion, now) {
  const { fecha, horario, config, bloqueo, citas } = day;
  const hoy = hoyChile(now);
  if (fecha < hoy) return { ok: false, error: "Esa fecha ya pasó" };
  if (fecha === hoy && horaToMinutes(hora) < horaToMinutes(horaChile(now)) + config.limite_horas_antes * 60) {
    return {
      ok: false,
      error: config.limite_horas_antes > 0
        ? `Debes agendar con al menos ${config.limite_horas_antes} horas de anticipación`
        : "Esa hora ya pasó"
    };
  }
  if (fecha > addDays(hoy, config.anticipacion_dias)) {
    return { ok: false, error: `Solo se puede agendar hasta ${config.anticipacion_dias} días hacia adelante` };
  }
  if (!horario || !horario.activo) return { ok: false, error: `Ese día (${diaSemanaDe(fecha)}) estamos cerrados` };
  const ini = horaToMinutes(hora);
  if (ini < horaToMinutes(horario.hora_apertura) || ini >= horaToMinutes(horario.hora_cierre)) {
    return { ok: false, error: `El ${diaSemanaDe(fecha)} atendemos de ${horario.hora_apertura} a ${horario.hora_cierre}` };
  }
  if (bloqueo) return { ok: false, error: `Ese día no hay atención${bloqueo.motivo ? " (" + bloqueo.motivo + ")" : ""}` };
  if (citas.length >= config.max_citas_por_dia) return { ok: false, error: "No quedan cupos para ese día" };
  const ocupadas = citas.filter((c) => overlaps(ini, duracion, c.ini, c.dur)).length;
  if (ocupadas >= config.citas_simultaneas) return { ok: false, error: "Ese horario ya está reservado" };
  return { ok: true, fecha, hora, disponibles: config.citas_simultaneas - ocupadas, maximo: config.citas_simultaneas };
}

// Valida que (fecha, hora) sea agendable para el tenant.
// Devuelve { ok: true, fecha, hora } o { ok: false, error }
export async function validarSlot(env, tenantId, fechaIn, horaIn, opts = {}) {
  const fecha = typeof fechaIn === "string" ? fechaIn.trim() : "";
  const hora = normalizeHora(horaIn);
  if (!isValidFecha(fecha)) return { ok: false, error: "Fecha inválida (usa formato YYYY-MM-DD)" };
  if (!hora) return { ok: false, error: "Hora inválida (usa formato HH:MM)" };
  const day = await loadDay(env, tenantId, fecha);
  return checkSlot(day, hora, opts.duracion || 60, opts.now || new Date());
}

// Horas disponibles para una fecha (usado por /api/disponibilidad)
export async function getDisponibilidad(env, tenantId, fecha, opts = {}) {
  if (!isValidFecha(fecha)) return { slots: [], cerrado: true, error: "Fecha inválida (usa formato YYYY-MM-DD)" };
  const day = await loadDay(env, tenantId, fecha);
  if (!day.horario || !day.horario.activo || day.bloqueo) return { slots: [], cerrado: true };
  const now = opts.now || new Date();
  const duracion = opts.duracion || 60;
  const intervalo = day.horario.intervalo_minutos || 30;
  const slots = [];
  const fin = horaToMinutes(day.horario.hora_cierre);
  for (let t = horaToMinutes(day.horario.hora_apertura); t < fin; t += intervalo) {
    const hora = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    const r = checkSlot(day, hora, duracion, now);
    if (r.ok) slots.push({ hora, disponibles: r.disponibles, maximo: r.maximo });
  }
  return { slots, cerrado: false };
}
