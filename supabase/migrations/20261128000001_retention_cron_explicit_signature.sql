-- ---------------------------------------------------------------------------
-- Fix del cron de retención (2026-11-28)
--
-- SÍNTOMA: `bh-archive-retention-daily` falló 8/8 corridas desde el 27/11 con
--   ERROR: function public.bh_archive_ml_sync_queue_success() is not unique
--
-- CAUSA: la migración 20261117000002 creó las firmas con `p_batches` mediante
-- `CREATE OR REPLACE FUNCTION`, que en Postgres CREA UNA NUEVA SOBRECARGA y
-- deja la vieja (2 args) vigente. El cron seguía llamando sin argumentos →
-- ambigüedad de firma → ninguna de las 3 funciones de archivado corría.
-- Consecuencia: ~49.700 jobs `success` y cientos de filas de audit_log sin
-- archivar (el escenario que agotó el Disk IO Budget en noviembre).
--
-- FIX: llamar las 3 funciones con su firma EXPLÍCITA (los mismos defaults
-- vigentes). No se borra ninguna función ni ningún dato: se corrige sólo el
-- `command` del cron existente (cron.alter_job conserva jobid e historial).
-- ---------------------------------------------------------------------------
SELECT cron.alter_job(
  job_id => j.jobid,
  command => $cron$
  SELECT public.bh_archive_ml_sync_queue_success(7, 5000, 20);
  SELECT public.bh_archive_audit_log(60, 5000, 20);
  SELECT public.bh_archive_ml_webhook_events(180, 20000, 5);
  $cron$
)
FROM cron.job AS j
WHERE j.jobname = 'bh-archive-retention-daily';
