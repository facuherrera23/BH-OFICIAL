-- ============================================
-- 20261128000004 — Guardián de crons → alerta en Supervisión
-- ============================================
-- MOTIVO (auditoría 28/11/2026): el cron de retención (jobid 36,
-- bh-archive-retention-daily) falló 27 veces entre el 23 y el 28/11 con
-- "function ... is not unique" y NADIE lo vio. cron.job_run_details guarda el
-- estado, pero no alimenta Supervisión: `return_message: "1 row"` de pg_cron
-- no distingue un HTTP 200 de un 401 silencioso ni de un error SQL.
--
-- QUÉ HACE: bh_check_cron_health() lee cron.job_run_details en una ventana
-- (30 min por defecto), abre UNA alerta `cron_failed` por jobname con el
-- mensaje real del fallo en `evidence` (NO `metadata`, que no existe) y la
-- auto-resuelve cuando el job vuelve a `succeeded`. Mismo patrón probado de
-- bh_check_io_budget / bh_check_captacion_health.
--
-- REGLA DURA: solo lectura de cron.job; la única escritura es la alerta.
-- SECURITY DEFINER con search_path='' y objetos calificados. La función es
-- NUEVA: Supabase da EXECUTE a PUBLIC/authenticated por default privileges →
-- se revocan explícitamente; solo service_role (y postgres por ser owner) la
-- ejecuta. El cron corre como postgres.
-- ============================================

CREATE OR REPLACE FUNCTION public.bh_check_cron_health(p_ventana_minutos integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_ventana      integer := LEAST(GREATEST(COALESCE(p_ventana_minutos, 30), 5), 1440);
  v_job          record;
  v_abierta      record;
  v_abiertas     integer := 0;
  v_jobid        bigint;
  v_ultimo       text;
  v_n            integer := 0;
  v_creadas      integer := 0;
  v_resueltas    integer := 0;
  v_detectados   jsonb := '[]'::jsonb;
BEGIN
  -- Dos corridas simultáneas no deben abrir la misma alerta dos veces.
  PERFORM pg_advisory_xact_lock(hashtext('bh_check_cron_health'));

  -- ---------- 1) Fallos recientes → abrir/actualizar alerta por job ----------
  FOR v_job IN
    SELECT j.jobid,
           j.jobname,
           count(*) FILTER (WHERE r.status = 'failed')::integer AS fallos,
           max(r.start_time) FILTER (WHERE r.status = 'failed') AS ultimo_fallo,
           (array_agg(r.return_message ORDER BY r.start_time DESC)
              FILTER (WHERE r.status = 'failed'))[1] AS mensaje
      FROM cron.job j
      JOIN cron.job_run_details r ON r.jobid = j.jobid
     WHERE j.active
       AND r.start_time >= now() - (v_ventana || ' minutes')::interval
     GROUP BY j.jobid, j.jobname
    HAVING count(*) FILTER (WHERE r.status = 'failed') > 0
  LOOP
    SELECT count(*) INTO v_abiertas
      FROM public.supervision_alerts
     WHERE alert_type = 'cron_failed'
       AND status IN ('open', 'assigned', 'investigating', 'acknowledged')
       AND evidence ->> 'jobname' = v_job.jobname;

    IF v_abiertas = 0 THEN
      INSERT INTO public.supervision_alerts
        (module, severity, alert_type, title, description, evidence, status)
      VALUES (
        'supervision',
        'high',
        'cron_failed',
        format('Cron fallando: %s', v_job.jobname),
        format('El job %s falló %s vez/veces en los últimos %s min. Último error: %s. Revisá cron.job_run_details y no asumas que "1 row" de pg_cron significa que funcionó.',
               v_job.jobname, v_job.fallos, v_ventana,
               left(COALESCE(v_job.mensaje, 'sin mensaje'), 300)),
        jsonb_build_object(
          'jobid', v_job.jobid,
          'jobname', v_job.jobname,
          'fallos_ventana', v_job.fallos,
          'ultimo_fallo', v_job.ultimo_fallo,
          'mensaje', left(COALESCE(v_job.mensaje, ''), 500),
          'ventana_minutos', v_ventana
        ),
        'open'
      );
      v_creadas := v_creadas + 1;
    ELSE
      -- Misma alerta, dato fresco (no se abre una nueva por cada fallo).
      UPDATE public.supervision_alerts
         SET evidence = COALESCE(evidence, '{}'::jsonb) || jsonb_build_object(
               'fallos_ventana', v_job.fallos,
               'ultimo_fallo', v_job.ultimo_fallo,
               'mensaje', left(COALESCE(v_job.mensaje, ''), 500),
               'actualizado_at', now()
             ),
             description = format('El job %s sigue fallando: %s vez/veces en los últimos %s min. Último error: %s.',
               v_job.jobname, v_job.fallos, v_ventana,
               left(COALESCE(v_job.mensaje, 'sin mensaje'), 300))
       WHERE alert_type = 'cron_failed'
         AND status IN ('open', 'assigned', 'investigating', 'acknowledged')
         AND evidence ->> 'jobname' = v_job.jobname;
    END IF;

    v_detectados := v_detectados || jsonb_build_array(
      jsonb_build_object('jobname', v_job.jobname, 'fallos', v_job.fallos)
    );
  END LOOP;

  -- ---------- 2) Job que volvió a OK → cerrar su alerta ----------
  FOR v_abierta IN
    SELECT id, evidence ->> 'jobname' AS jobname
      FROM public.supervision_alerts
     WHERE alert_type = 'cron_failed'
       AND status IN ('open', 'assigned', 'investigating', 'acknowledged')
  LOOP
    SELECT j.jobid INTO v_jobid
      FROM cron.job j
     WHERE j.jobname = v_abierta.jobname
       AND j.active
     LIMIT 1;

    IF v_jobid IS NOT NULL THEN
      SELECT r.status INTO v_ultimo
        FROM cron.job_run_details r
       WHERE r.jobid = v_jobid
       ORDER BY r.start_time DESC
       LIMIT 1;

      IF v_ultimo = 'succeeded' THEN
        UPDATE public.supervision_alerts
           SET status = 'resolved',
               resolved_at = now(),
               notes = COALESCE(notes || ' | ', '') || 'Auto-resuelto: el cron volvió a succeeded.'
         WHERE id = v_abierta.id
           AND status IN ('open', 'assigned', 'investigating', 'acknowledged');
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_resueltas := v_resueltas + v_n;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ventana_minutos', v_ventana,
    'jobs_con_fallos', jsonb_array_length(v_detectados),
    'alertas_creadas', v_creadas,
    'alertas_resueltas', v_resueltas,
    'detalle', v_detectados
  );
END
$fn$;

-- ------------------------------------------------------------
-- Permisos (función nueva: default privileges dan EXECUTE a todos)
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.bh_check_cron_health(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bh_check_cron_health(integer) TO service_role;

-- ------------------------------------------------------------
-- Cron cada 15 min (idempotente: no duplica job)
-- ------------------------------------------------------------
DO $cron_mig$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'bh-cron-health-15min';
  IF v_jobid IS NULL THEN
    PERFORM cron.schedule(
      'bh-cron-health-15min',
      '*/15 * * * *',
      $cron_cmd$SELECT public.bh_check_cron_health();$cron_cmd$
    );
  ELSE
    -- Re-aplicar la migración NO cambia el jobid (historial intacto).
    PERFORM cron.alter_job(
      job_id => v_jobid,
      schedule => '*/15 * * * *',
      command => $cron_cmd$SELECT public.bh_check_cron_health();$cron_cmd$
    );
  END IF;
END
$cron_mig$;
