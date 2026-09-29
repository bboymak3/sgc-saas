// ============================================================
// Parser de respaldo: si el cliente confirma pero la IA no llamó a
// agendar_cita, se intentan extraer fecha/hora/servicio del historial.
// Se revisan los mensajes del más reciente al más antiguo para quedarse
// con el último dato mencionado.
// ============================================================

import { hoyChile, addDays, isValidFecha, DIAS } from "../lib/time.js";
import { normalizeText } from "./format.js";

const MARCAS = ["Toyota", "Hyundai", "Kia", "Suzuki", "Chevrolet", "Ford", "Nissan", "Mazda", "Honda", "Volkswagen", "BMW", "Mercedes", "Audi", "Mitsubishi", "Subaru", "Renault", "Peugeot", "Citroen", "Fiat", "Chery", "MG", "JAC", "Great Wall"];

function findFecha(text, now) {
  const t = normalizeText(text);
  const hoy = hoyChile(now);
  let m = t.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const f = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    if (isValidFecha(f)) return f;
  }
  m = t.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}))?\b/);
  if (m) {
    const anio = m[3] || hoy.slice(0, 4);
    let f = `${anio}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    // Sin año y fecha ya pasada → el próximo año
    if (!m[3] && isValidFecha(f) && f < hoy) f = `${Number(anio) + 1}${f.slice(4)}`;
    if (isValidFecha(f)) return f;
  }
  if (/\bpasado\s+manana\b/.test(t)) return addDays(hoy, 2);
  // "mañana" como día, no "de/en/por la mañana"
  if (/(^|[^a-z])manana\b/.test(t.replace(/\b(de|en|por|a)\s+la\s+manana\b/g, ""))) return addDays(hoy, 1);
  if (/\bhoy\b/.test(t)) return hoy;
  for (let i = 0; i < DIAS.length; i++) {
    if (new RegExp(`\\b(el|este|proximo)\\s+${DIAS[i]}\\b`).test(t)) {
      const [y, mo, d] = hoy.split("-").map(Number);
      const hoyIdx = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      const delta = ((i - hoyIdx + 7) % 7) || 7;
      return addDays(hoy, delta);
    }
  }
  return null;
}

function findHora(text) {
  const t = normalizeText(text);
  let m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(am|pm|hrs?|horas)?\b/);
  let h, min = "00", periodo = "";
  if (m) {
    h = parseInt(m[1], 10); min = m[2]; periodo = m[3] || "";
    // "7:30 de la tarde"
    const after = t.slice(t.indexOf(m[0]) + m[0].length, t.indexOf(m[0]) + m[0].length + 20);
    if (/de la (tarde|noche)/.test(after)) periodo = "pm";
  } else {
    m = t.match(/\b(?:a\s+las?\s+)?([01]?\d|2[0-3])\s*(am|pm|hrs?\b|horas\b|de\s+la\s+manana|de\s+la\s+tarde|de\s+la\s+noche)/)
      || t.match(/\ba\s+las?\s+([01]?\d|2[0-3])\b/);
    if (!m) return null;
    h = parseInt(m[1], 10); periodo = m[2] || "";
  }
  if ((periodo === "pm" || /tarde|noche/.test(periodo)) && h < 12) h += 12;
  if ((periodo === "am" || /manana/.test(periodo)) && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

function findServicio(text, servicios) {
  const t = normalizeText(text);
  // 1. Nombre completo
  for (const s of servicios) {
    if (t.includes(normalizeText(s))) return s;
  }
  // 2. Palabra significativa del nombre ("aceite" → "Cambio de Aceite")
  for (const s of servicios) {
    const words = normalizeText(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 5);
    if (words.some((w) => new RegExp(`\\b${w}`).test(t))) return s;
  }
  return null;
}

function findPatente(text) {
  const m = String(text).match(/\b([A-Z]{4}\d{2}|[A-Z]{2}\d{4}|[A-Z]{3}\d{3}|[A-Z]{2}\d{3}[A-Z])\b/i)
    || String(text).match(/patente[:\s]+([A-Z0-9]{5,8})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function findMarca(text) {
  for (const marca of MARCAS) {
    if (new RegExp(`\\b${marca}\\b`, "i").test(text)) return marca;
  }
  return null;
}

// history: [{role, content}], servicios: nombres de servicios del tenant
export function parseCitaFromHistory(history, currentText, servicios = [], now = new Date()) {
  const textos = [...(history || []).map((h) => h.content || ""), currentText || ""].reverse();
  const pick = (fn) => {
    for (const t of textos) {
      const v = fn(t);
      if (v) return v;
    }
    return null;
  };
  const fecha = pick((t) => findFecha(t, now));
  const hora = pick(findHora);
  const servicio = pick((t) => findServicio(t, servicios));
  if (!fecha || !hora || !servicio) return null;
  return { fecha, hora, servicio, patente: pick(findPatente), marca: pick(findMarca) };
}
