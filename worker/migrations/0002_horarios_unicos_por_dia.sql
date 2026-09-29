-- Elimina horarios duplicados (el tenant 3 quedó con cada día dos veces al
-- re-ejecutarse la carga por defecto) y evita que se repita.
DELETE FROM sgc_cit_horarios
WHERE id NOT IN (SELECT MIN(id) FROM sgc_cit_horarios GROUP BY tenant_id, dia_semana);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sgc_cit_horarios_tenant_dia ON sgc_cit_horarios(tenant_id, dia_semana);
