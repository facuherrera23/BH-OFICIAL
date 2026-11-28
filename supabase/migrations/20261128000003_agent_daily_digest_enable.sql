-- ---------------------------------------------------------------------------
-- Habilitación del resumen diario de "Mi día" (28/11/2026, con OK del dueño).
--
-- La migración 20261128000002 creó el cron en `dry_run:true` para verificarlo
-- contra producción sin enviar correos. Esta migración cambia SOLO el body a
-- '{}' (envío real) usando `cron.alter_job`: conserva el jobid y el historial
-- de corridas, a diferencia de unschedule+schedule.
--
-- Se agrega `timeout_milliseconds := 30000` porque el default de pg_net
-- (5.000 ms) ya provocó timeouts de DNS en otros crons de este proyecto: con
-- 5 s una corrida muere antes de llegar a la edge function, en silencio.
-- ---------------------------------------------------------------------------

DO $mig$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'agent-daily-digest';
  IF v_jobid IS NULL THEN
    RAISE EXCEPTION 'cron agent-daily-digest no existe: aplicar primero 20261128000002';
  END IF;

  PERFORM cron.alter_job(
    job_id => v_jobid,
    schedule => '0 11 * * *',
    command => $cmd$
      SELECT net.http_post(
        url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/agent-daily-digest',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-sync-secret', (SELECT value->>'secret' FROM public.zernio_config WHERE key = 'sync_secret' LIMIT 1)
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
    $cmd$,
    active => true
  );
END $mig$;
