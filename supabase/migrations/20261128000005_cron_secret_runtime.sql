-- ============================================
-- 20261128000005 — Sacar el x-sync-secret en claro de 2 crons
-- ============================================
-- MOTIVO (auditoría 28/11/2026): los jobs 25 (zernio-sync-every-2-min) y 26
-- (backup-snapshot-daily) tenían el secret pegado como literal en
-- cron.job.command. Si se rota, mueren con 401 SILENCIOSO: net.http_post
-- siempre devuelve "1 row" y pg_cron marca succeeded. Además cualquier lector
-- de cron.job ve el secret.
--
-- Fix: cron.alter_job (conserva jobid e historial) para que el header se lea
-- en runtime de public.zernio_config(key='sync_secret') — el mismo patrón de
-- lead-tasks-reminder / agent-daily-digest / owner-tasks-reminder. Se agrega
-- timeout_milliseconds := 30000: el default de 5 s de pg_net ya dio timeouts
-- de DNS en este proyecto.
--
-- ⚠️ jobid 1 (ml-sync-every-5-min) NO se toca: no tiene el secret en claro,
-- usa vault.decrypted_secrets(name='ml_sync_secret') y la edge function
-- ml-sync valida contra la env ML_SYNC_SECRET (un secret DISTINTO del
-- sync_secret de zernio). Funciona: 576 corridas succeeded en 48 h.
-- ⚠️ Las filas viejas de cron.job_run_details SÍ guardan el command anterior
-- con el literal. No se borra nada sin OK explícito del dueño (doctrina de
-- no borrar logs sin copia); con el tiempo las purga pg_cron.
-- ============================================

DO $mig$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'zernio-sync-every-2-min';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      job_id => v_jobid,
      command => $cmd$
  SELECT net.http_post(
    url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/zernio-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (SELECT value->>'secret' FROM public.zernio_config WHERE key = 'sync_secret' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) AS request_id;
  $cmd$
    );
  END IF;

  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'backup-snapshot-daily';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      job_id => v_jobid,
      command => $cmd$
  SELECT net.http_post(
    url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/backup-snapshot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (SELECT value->>'secret' FROM public.zernio_config WHERE key = 'sync_secret' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) AS request_id;
  $cmd$
    );
  END IF;
END
$mig$;
