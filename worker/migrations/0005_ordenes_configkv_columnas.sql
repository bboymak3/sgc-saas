-- sgc-ordenes lee y escribe sgc_ord_ConfigKV con columnas (clave, valor,
-- fecha_actualizacion), pero en producción la tabla tenía (key, value,
-- updated_at): la configuración de cobro a domicilio y de UltraMsg fallaba
-- siempre. Estaba vacía al 2026-09-29; igual se copian las filas existentes.
CREATE TABLE sgc_ord_ConfigKV_new (
  clave TEXT PRIMARY KEY,
  valor TEXT,
  fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP,
  tenant_id INTEGER DEFAULT 1
);
INSERT INTO sgc_ord_ConfigKV_new (clave, valor, fecha_actualizacion, tenant_id)
SELECT key, value, updated_at, COALESCE(tenant_id, 1) FROM sgc_ord_ConfigKV;
DROP TABLE sgc_ord_ConfigKV;
ALTER TABLE sgc_ord_ConfigKV_new RENAME TO sgc_ord_ConfigKV;
CREATE INDEX IF NOT EXISTS idx_sgc_ord_ConfigKV_tenant ON sgc_ord_ConfigKV(tenant_id);
