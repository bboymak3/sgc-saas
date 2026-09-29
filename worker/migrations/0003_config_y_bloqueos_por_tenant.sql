-- sgc_cit_config tenía PRIMARY KEY (clave) y sgc_cit_bloqueos UNIQUE (fecha)
-- globales: un negocio no podía tener su propia configuración ni bloquear
-- una fecha que otro negocio ya había bloqueado.

CREATE TABLE sgc_cit_config_new (
  clave TEXT NOT NULL,
  valor TEXT NOT NULL,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, clave)
);
INSERT INTO sgc_cit_config_new (clave, valor, tenant_id)
SELECT clave, valor, COALESCE(tenant_id, 1) FROM sgc_cit_config;
DROP TABLE sgc_cit_config;
ALTER TABLE sgc_cit_config_new RENAME TO sgc_cit_config;

CREATE TABLE sgc_cit_bloqueos_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  motivo TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  tenant_id INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, fecha)
);
INSERT INTO sgc_cit_bloqueos_new (id, fecha, motivo, created_at, tenant_id)
SELECT id, fecha, motivo, created_at, COALESCE(tenant_id, 1) FROM sgc_cit_bloqueos;
DROP TABLE sgc_cit_bloqueos;
ALTER TABLE sgc_cit_bloqueos_new RENAME TO sgc_cit_bloqueos;
CREATE INDEX IF NOT EXISTS idx_sgc_cit_bloqueos_tenant ON sgc_cit_bloqueos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sgc_cit_config_tenant ON sgc_cit_config(tenant_id);
