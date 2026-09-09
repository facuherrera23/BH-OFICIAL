-- =====================================================================
-- 20260907000004_ml_connection_add_site_id
-- ml_connection no tiene la columna site_id, pero ml-oauth la inserta
-- (línea 288: site_id: user.site_id ?? 'MLA') y ml-metrics /
-- ml-portal-status / _shared/ml.ts la leen. Sin la columna, el INSERT
-- del callback OAuth falla con "column site_id does not exist" ->
-- "No se pudo guardar la conexión en la base de datos".
-- =====================================================================

BEGIN;

ALTER TABLE public.ml_connection
  ADD COLUMN IF NOT EXISTS site_id text;

COMMIT;