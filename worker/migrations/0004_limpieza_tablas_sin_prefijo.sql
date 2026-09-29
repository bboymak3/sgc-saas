-- Tablas creadas por error sin prefijo por sgc-ordenes (CREATE TABLE IF NOT
-- EXISTS con el nombre viejo). Estaban vacías al 2026-09-29; el código ya usa
-- los nombres sgc_ord_*. "Clientes" se conserva porque sgc_cit_Citas tiene una
-- FOREIGN KEY hacia ella.
DROP TABLE IF EXISTS AdminUsers;
DROP TABLE IF EXISTS SesionesAdmin;
DROP TABLE IF EXISTS AgendaTecnicos;
DROP TABLE IF EXISTS CostosAdicionales;
DROP TABLE IF EXISTS FotosTrabajo;
DROP TABLE IF EXISTS GastosNegocio;
DROP TABLE IF EXISTS LiquidacionOrden;
DROP TABLE IF EXISTS ModelosVehiculo;
DROP TABLE IF EXISTS NotasTrabajo;
DROP TABLE IF EXISTS NotificacionesWhatsApp;
DROP TABLE IF EXISTS Pagos;
DROP TABLE IF EXISTS ServiciosCatalogo;
DROP INDEX IF EXISTS idx_servicios_cat_activo;
DROP INDEX IF EXISTS idx_servicios_cat_categoria;

-- Tracking GPS de técnicos: el código consulta sgc_ord_TrackingTecnico, que no existía
CREATE TABLE IF NOT EXISTS sgc_ord_TrackingTecnico (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orden_id INTEGER NOT NULL,
  tecnico_id INTEGER NOT NULL,
  latitud REAL NOT NULL,
  longitud REAL NOT NULL,
  velocidad REAL DEFAULT 0,
  fecha_registro TEXT DEFAULT (datetime('now', '-3 hours')),
  tenant_id INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_sgc_ord_TrackingTecnico_orden ON sgc_ord_TrackingTecnico(orden_id, id);
