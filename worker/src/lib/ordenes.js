// ============================================================
// Integración con sgc-ordenes (órdenes de trabajo del taller SGC)
//
// Solo el tenant dueño del sistema de órdenes (ORDENES_TENANT_ID, por defecto 1)
// consulta vehículos y genera órdenes: una barbería no debe crear órdenes
// de trabajo automotriz en el sistema del taller.
// ============================================================

export function ordenesTenantId(env) {
  const n = parseInt(env.ORDENES_TENANT_ID || "1", 10);
  return Number.isFinite(n) ? n : 1;
}

export function tenantUsesOrdenes(env, tenant) {
  return !!tenant && tenant.id === ordenesTenantId(env);
}

export async function consultarVehiculo(env, patente) {
  try {
    const pat = String(patente || "").toUpperCase().trim();
    if (!pat) return { success: false, error: "Patente requerida" };
    const tid = ordenesTenantId(env);
    const vehiculo = await env.DB.prepare(
      "SELECT v.*, c.nombre AS cliente_nombre, c.telefono AS cliente_telefono, c.rut AS cliente_rut " +
      "FROM sgc_ord_Vehiculos v LEFT JOIN sgc_ord_Clientes c ON v.cliente_id = c.id " +
      "WHERE UPPER(v.patente_placa) = ? AND v.tenant_id = ? LIMIT 1"
    ).bind(pat, tid).first();
    if (!vehiculo) return { success: false, error: "Vehículo no encontrado en nuestra base de datos" };
    const [ultimaOrden, totalOrd] = await Promise.all([
      env.DB.prepare(
        "SELECT numero_orden, fecha_ingreso, servicios_seleccionados, estado, monto_total FROM sgc_ord_OrdenesTrabajo WHERE UPPER(patente_placa) = ? AND tenant_id = ? ORDER BY id DESC LIMIT 1"
      ).bind(pat, tid).first(),
      env.DB.prepare(
        "SELECT COUNT(*) AS cnt FROM sgc_ord_OrdenesTrabajo WHERE UPPER(patente_placa) = ? AND tenant_id = ?"
      ).bind(pat, tid).first()
    ]);
    return {
      success: true,
      vehiculo: {
        id: vehiculo.id,
        patente_placa: vehiculo.patente_placa,
        marca: vehiculo.marca,
        modelo: vehiculo.modelo,
        anio: vehiculo.anio,
        cilindrada: vehiculo.cilindrada,
        combustible: vehiculo.combustible,
        kilometraje: vehiculo.kilometraje,
        color: vehiculo.color,
        cliente_id: vehiculo.cliente_id,
        fecha_registro: vehiculo.fecha_registro,
        cliente_nombre: vehiculo.cliente_nombre,
        cliente_telefono: vehiculo.cliente_telefono,
        cliente_rut: vehiculo.cliente_rut,
        total_ordenes: (totalOrd && totalOrd.cnt) || 0,
        ultima_orden: ultimaOrden ? {
          numero_orden: ultimaOrden.numero_orden,
          fecha_ingreso: ultimaOrden.fecha_ingreso,
          servicios_seleccionados: ultimaOrden.servicios_seleccionados,
          estado: ultimaOrden.estado,
          monto_total: ultimaOrden.monto_total || 0
        } : undefined
      }
    };
  } catch (error) {
    console.error("Error consultando vehículo:", error);
    return { success: false, error: "Error al consultar el vehículo" };
  }
}

// Crea una orden express en sgc-ordenes (POST /api/public/crear-orden-express)
export async function crearOrdenExpress(env, cita, vehiculo) {
  const base = env.SGCORDENES_URL;
  if (!base) return { success: false, error: "SGCORDENES_URL no configurada" };
  try {
    const headers = { "Content-Type": "application/json" };
    if (env.ORDENES_API_KEY) headers["X-Api-Key"] = env.ORDENES_API_KEY;
    const response = await fetch(`${base}/api/public/crear-orden-express`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        patente: cita.patente,
        marca: (vehiculo && vehiculo.marca) || cita.marca || "",
        modelo: (vehiculo && vehiculo.modelo) || cita.modelo || "",
        cliente: cita.nombre_cliente,
        telefono: cita.telefono,
        direccion: cita.direccion || "",
        referencia_direccion: cita.referencia_direccion || "",
        notas_diagnostico: `Cita agendada via Chat IA | Servicio: ${cita.servicio} | Fecha: ${cita.fecha_cita} ${cita.hora_cita} | ${cita.observaciones || ""}`.trim(),
        express: true,
        fecha_ingreso: cita.fecha_cita || new Date().toISOString().split("T")[0],
        origen: "chat_ia"
      })
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { success: false, error: "Respuesta inválida de sgc-ordenes: " + text.substring(0, 200) };
    }
    if (data.success && data.numero_orden) return { success: true, numero_orden: data.numero_orden };
    return { success: false, error: data.error || "Error al crear orden en sgc-ordenes" };
  } catch (error) {
    console.error("Error enviando orden a sgc-ordenes:", error);
    return { success: false, error: "Error de conexión con sgc-ordenes: " + error.message };
  }
}

// Si la cita es del tenant de órdenes y no tiene OT, la crea y guarda el número.
export async function asegurarOrdenParaCita(env, cita) {
  if (!cita || cita.tenant_id !== ordenesTenantId(env) || cita.numero_orden_sgc || !cita.patente) {
    return { creada: false, numero: cita && cita.numero_orden_sgc };
  }
  const veh = await consultarVehiculo(env, cita.patente);
  const r = await crearOrdenExpress(env, cita, veh.vehiculo);
  if (!r.success) {
    console.error("No se pudo crear OT para cita", cita.id, r.error);
    return { creada: false, error: r.error };
  }
  const numero = String(r.numero_orden);
  await env.DB.prepare(
    "UPDATE sgc_cit_Citas SET orden_enviada = 1, numero_orden_sgc = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(numero, cita.id).run();
  return { creada: true, numero };
}
