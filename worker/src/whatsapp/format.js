// Convierte markdown genérico al formato que WhatsApp soporta
export function formatForWhatsApp(text) {
  let t = String(text || "");
  t = t.replace(/\*\*(.+?)\*\*/g, "*$1*");
  t = t.replace(/__(.+?)__/g, "*$1*");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "").trim());
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

export function normalizeText(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
