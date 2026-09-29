// Límite de frecuencia "best effort" con la Cache API (por colo de Cloudflare).
// Devuelve true si la acción está permitida y la marca por `seconds`.
export async function allowOnce(bucket, id, seconds) {
  if (typeof caches === "undefined" || !caches.default) return true;
  const key = new Request(`https://ratelimit.internal/${encodeURIComponent(bucket)}/${encodeURIComponent(id)}`);
  const hit = await caches.default.match(key);
  if (hit) return false;
  await caches.default.put(key, new Response("1", { headers: { "Cache-Control": `max-age=${seconds}` } }));
  return true;
}

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
}
