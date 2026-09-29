-- Columnas que sgc-ordenes usa y que no existían en producción:
--  - notas: /api/tecnico/ordenes daba 500 siempre (lista de órdenes del técnico)
--  - tecnico_lat/lng: tracking público fallaba hasta el primer envío de GPS
--  - token_firma_tecnico: generar-token-firma y /aprobar-tecnico fallaban
--  - pagado: exportar-datos fallaba
--  - sgc_ord_AdelantosTecnico.notas: adelantos, liquidación y exportación
ALTER TABLE sgc_ord_OrdenesTrabajo ADD COLUMN notas TEXT;
ALTER TABLE sgc_ord_OrdenesTrabajo ADD COLUMN pagado INTEGER DEFAULT 0;
ALTER TABLE sgc_ord_OrdenesTrabajo ADD COLUMN tecnico_lat REAL DEFAULT 0;
ALTER TABLE sgc_ord_OrdenesTrabajo ADD COLUMN tecnico_lng REAL DEFAULT 0;
ALTER TABLE sgc_ord_OrdenesTrabajo ADD COLUMN token_firma_tecnico TEXT;
ALTER TABLE sgc_ord_AdelantosTecnico ADD COLUMN notas TEXT;
