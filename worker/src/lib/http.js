// ============================================================
// Helpers HTTP: CORS + respuestas JSON
// ============================================================

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Webhook-Secret"
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extraHeaders }
  });
}

export function jsonError(error, status = 400, extra = {}) {
  return json({ success: false, error, ...extra }, status);
}

export function handleCors() {
  return new Response(null, { headers: CORS_HEADERS });
}

// Lee el body JSON sin lanzar excepción si viene vacío o malformado
export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch (e) {
    return {};
  }
}

// Respuesta "OK" plana para webhooks (Evolution reintenta si no recibe 200)
export function ok() {
  return new Response("OK", { status: 200 });
}
