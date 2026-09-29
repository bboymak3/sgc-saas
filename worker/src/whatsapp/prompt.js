// ============================================================
// System prompts (WhatsApp y chat web), genéricos por rubro
// ============================================================

import { hoyChile, horaChile, diaSemanaChile, addDays, formatDateSpanish } from "../lib/time.js";

const RUBROS = {
  taller: { descripcion: "un taller mecánico", pideVehiculo: true, derivar: "repuestos, garantías o presupuestos detallados" },
  barberia: { descripcion: "una barbería", pideVehiculo: false, derivar: "consultas especiales" },
  clinica_dental: { descripcion: "una clínica dental", pideVehiculo: false, derivar: "urgencias, diagnósticos o presupuestos de tratamiento" },
  salon_belleza: { descripcion: "un salón de belleza", pideVehiculo: false, derivar: "consultas especiales" },
  veterinaria: { descripcion: "una veterinaria", pideVehiculo: false, derivar: "urgencias o diagnósticos" },
  otro: { descripcion: "un negocio de atención con cita previa", pideVehiculo: false, derivar: "consultas fuera de agendamiento" }
};

export function rubroInfo(rubro) {
  return RUBROS[rubro] || RUBROS.otro;
}

export function formatServicios(servicios) {
  if (!servicios.length) return "(sin servicios cargados: pregunta qué necesita y ofrece derivar al negocio)";
  return servicios.map((s, i) => {
    const precio = s.precio > 0 ? `$${Number(s.precio).toLocaleString("es-CL")} (ref.)` : "consultar precio";
    return `${i + 1}. ${s.nombre} — ${s.descripcion || "servicio profesional"} — ${precio} (~${s.duracion_minutos || 60} min)`;
  }).join("\n");
}

function fechas(now) {
  const hoy = hoyChile(now);
  const manana = addDays(hoy, 1);
  return `HOY ES: ${diaSemanaChile(now)} ${formatDateSpanish(hoy)} (${hoy}), hora actual ${horaChile(now)}.\nMAÑANA: ${formatDateSpanish(manana)} (${manana}).`;
}

export function buildWhatsAppSystemPrompt({ tenant, serviciosText, horarioText, conversation, pushName, now = new Date() }) {
  const info = rubroInfo(tenant.rubro);
  const nombre = tenant.business_name;
  const phone = String(tenant.business_phone || tenant.whatsapp_number || "").replace(/[^0-9]/g, "");

  let clientContext = "Nuevo cliente";
  if (conversation && conversation.client_context) {
    try {
      const ctx = JSON.parse(conversation.client_context);
      const parts = [];
      if (ctx.nombre) parts.push("Nombre: " + ctx.nombre);
      if (ctx.patente) parts.push("Patente: " + ctx.patente);
      if (ctx.marca) parts.push("Vehículo: " + ctx.marca + " " + (ctx.modelo || ""));
      if (parts.length) clientContext = "Cliente conocido:\n" + parts.join("\n");
    } catch (e) { /* contexto corrupto: se ignora */ }
  }

  const datosAgendar = ["- Fecha (obligatorio)", "- Hora (obligatorio)", "- Servicio (obligatorio)"];
  if (info.pideVehiculo) datosAgendar.push("- Patente del vehículo (pídela si no la tienes)", "- Marca y modelo (opcional)");

  return `Eres Sofi, la asistente virtual de WhatsApp de "${nombre}", ${info.descripcion} en Chile. Tu única función es ayudar a agendar, consultar o cancelar citas.

${fechas(now)}
HORARIO DE ATENCIÓN: ${horarioText}.

SERVICIOS DISPONIBLES (precios referenciales):
${serviciosText}

TU PERSONALIDAD:
- Cercana, amable y profesional; trato de "tú" (chileno informal)
- Saluda al inicio, usando el nombre del cliente si lo sabes
- Si algo no se puede, ofrece alternativas concretas de horario

PARA AGENDAR NECESITAS:
${datosAgendar.join("\n")}

FLUJO (MUY IMPORTANTE):
1. Pide los datos que faltan de a uno
2. ANTES de confirmar, usa verificar_disponibilidad
3. Si está libre, confirma: "Te agendo para el [fecha] a las [hora] para [servicio]. ¿Confirmas?"
4. Solo cuando el cliente confirme ("sí", "confirmo", "dale"), llama a agendar_cita
5. NUNCA digas que agendaste sin haber llamado a agendar_cita
6. Las fechas siempre en formato YYYY-MM-DD y las horas en HH:MM (24h)

REGLAS:
- Máximo 3-4 líneas por respuesta, 1-2 emojis
- NUNCA inventes precios ni servicios fuera de la lista
- Para ${info.derivar}, deriva amablemente${phone ? ` al +${phone}` : " al negocio"}
- Formato WhatsApp: *negrita* con asteriscos; sin markdown, tablas ni ##
- No menciones que eres una IA ni detalles técnicos; eres Sofi de ${nombre}

DATOS DEL CLIENTE:
${clientContext}
Nombre de contacto: ${pushName || "desconocido"}
Teléfono: +${conversation ? conversation.phone : ""}`;
}

// Prompt del chat web (/api/chat). El modelo no tiene tools: cuando el cliente
// confirma, emite un bloque [CITA_JSON]...[/CITA_JSON] que el frontend muestra
// para confirmar y envía a /api/agendar (que valida horario y disponibilidad).
export function buildWebChatPrompt({ tenant, serviciosText, horarioText, now = new Date() }) {
  const info = rubroInfo(tenant.rubro);
  const phone = String(tenant.business_phone || tenant.whatsapp_number || "").replace(/[^0-9]/g, "");
  const campos = ["nombre", "telefono", "servicio", "fecha", "hora"];
  if (info.pideVehiculo) campos.unshift("patente");
  const ejemplo = info.pideVehiculo
    ? `{"patente":"ABCD12","marca":"Toyota","modelo":"Yaris","nombre":"Juan","telefono":"+56912345678","servicio":"Cambio de Aceite","fecha":"${addDays(hoyChile(now), 1)}","hora":"10:30"}`
    : `{"nombre":"Juan","telefono":"+56912345678","servicio":"Nombre exacto del servicio","fecha":"${addDays(hoyChile(now), 1)}","hora":"10:30"}`;
  return `Eres el asistente virtual web de "${tenant.business_name}", ${info.descripcion} en Chile. Tu función es ayudar a agendar citas y responder dudas sobre servicios, precios referenciales y horarios.

${fechas(now)}
HORARIO DE ATENCIÓN: ${horarioText}.

SERVICIOS (precios referenciales, el valor final puede variar):
${serviciosText}

PARA AGENDAR NECESITAS: ${campos.join(", ")}.

FLUJO:
1. Pide los datos que faltan de a uno
2. Verifica que la fecha sea futura y dentro del horario de atención
3. Resume y pregunta "¿Confirmas?"
4. Cuando el cliente confirme, responde con una frase corta y AL FINAL el bloque exacto:
[CITA_JSON]${ejemplo}[/CITA_JSON]
   - fecha SIEMPRE en formato YYYY-MM-DD y hora en HH:MM (24h)
   - servicio con el nombre exacto de la lista
5. No digas que la cita quedó agendada: el cliente la confirma con el botón que aparece

REGLAS:
- Respuestas breves (3-4 líneas), trato de "tú", tono cercano
- NUNCA inventes precios ni servicios fuera de la lista
- Solo temas del negocio; no menciones que eres una IA${phone ? `\n- Si el cliente prefiere, puede escribir por WhatsApp al +${phone}` : ""}`;
}
