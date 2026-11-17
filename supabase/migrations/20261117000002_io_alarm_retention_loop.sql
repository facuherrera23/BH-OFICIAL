-- ============================================
-- 20261117000002 — Alarma de Disk IO + retención en loop
-- ============================================
-- Mitigación A: alarma propia de IO (antes solo te enterabas por el email de
--   Supabase, cuando el budget ya estaba crítico). Ahora un cron horario
--   mide el ritmo de lectura de disco y abre/cierra una alerta en
--   supervision_alerts → aparece en el panel de Supervisión.
-- Mitigación B: la retención pasa a correr cada 6 h y procesa varios lotes
--   por corrida (antes 1 lote de 5.000 al mediodía: un pico de 30k jobs
--   dejaba backlog para el día siguiente).
--
-- REGLA DURA: nada se borra sin copia (las tablas *_archive siguen siendo el
-- respaldo; las funciones archivan ANTES de borrar).
-- ============================================

-- ------------------------------------------------------------
-- 1. Muestras de IO (histórico ligero para el cálculo 24 h)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bh_io_samples (
  ts        timestamptz PRIMARY KEY DEFAULT now(),
  blks_read bigint NOT NULL,
  blks_hit  bigint NOT NULL DEFAULT 0
);

ALTER TABLE public.bh_io_samples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bh_io_samples FROM anon, authenticated;
GRANT ALL ON public.bh_io_samples TO service_role;

CREATE INDEX IF NOT EXISTS idx_bh_io_samples_ts ON public.bh_io_samples (ts DESC);

-- ------------------------------------------------------------
-- 2. Función de alarma: bh_check_io_budget()
-- ------------------------------------------------------------
-- Umbrales por defecto:
--   • 100 bloques/s ≈ 800 KB/s ≈ 13 % del baseline de 6 MB/s del free tier.
--     Antes del fix el solo badge sostenía ~110 bloques/s.
--   • 150 GB leídos en 24 h (el budget diario del baseline es ~500 GB).
-- Debajo de cualquiera de los dos, la alerta se auto-resuelve.
CREATE OR REPLACE FUNCTION public.bh_check_io_budget(
  p_rate_threshold_blocks_per_sec double precision DEFAULT 100,
  p_daily_threshold_gb            double precision DEFAULT 150
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_now        bigint;
  v_hit        bigint;
  v_prev_read  bigint;
  v_prev_ts    timestamptz;
  v_day_read   bigint;
  v_day_ts     timestamptz;
  v_rate       double precision := 0;
  v_day_gb     double precision := 0;
  v_over_rate  boolean := false;
  v_over_day   boolean := false;
  v_open_alert integer := 0;
  v_created    integer := 0;
  v_resolved   integer := 0;
  v_hour       timestamptz := date_trunc('hour', now());
BEGIN
  SELECT blks_read, blks_hit INTO v_now, v_hit
  FROM pg_stat_database WHERE datname = current_database();

  IF v_now IS NULL THEN
    RETURN jsonb_build_object('error', 'no pg_stat_database row');
  END IF;

  -- Muestra horaria (idempotente por hora).
  INSERT INTO public.bh_io_samples (ts, blks_read, blks_hit)
  VALUES (v_hour, v_now, v_hit)
  ON CONFLICT (ts) DO UPDATE SET blks_read = EXCLUDED.blks_read, blks_hit = EXCLUDED.blks_hit;

  -- Muestra anterior → ritmo (bloques/s).
  SELECT blks_read, ts INTO v_prev_read, v_prev_ts
  FROM public.bh_io_samples
  WHERE ts < v_hour
  ORDER BY ts DESC LIMIT 1;

  IF v_prev_read IS NOT NULL AND v_now >= v_prev_read THEN
    v_rate := (v_now - v_prev_read)::double precision
              / GREATEST(EXTRACT(EPOCH FROM (v_hour - v_prev_ts)), 1);
  END IF;

  -- Muestra de hace ~24 h → volumen diario.
  SELECT blks_read, ts INTO v_day_read, v_day_ts
  FROM public.bh_io_samples
  WHERE ts <= v_hour - interval '24 hours'
  ORDER BY ts DESC LIMIT 1;

  IF v_day_read IS NOT NULL AND v_now >= v_day_read THEN
    v_day_gb := ((v_now - v_day_read)::double precision * 8192.0) / 1073741824.0;
  END IF;

  v_over_rate := v_rate > p_rate_threshold_blocks_per_sec;
  v_over_day  := v_day_gb > p_daily_threshold_gb;

  SELECT count(*) INTO v_open_alert
  FROM public.supervision_alerts
  WHERE alert_type = 'disk_io_budget' AND status IN ('open', 'assigned', 'investigating', 'acknowledged');

  IF v_over_rate OR v_over_day THEN
    IF v_open_alert = 0 THEN
      INSERT INTO public.supervision_alerts
        (module, severity, alert_type, title, description, evidence, status)
      VALUES (
        'supervision',
        CASE WHEN v_over_day THEN 'critical' ELSE 'high' END,
        'disk_io_budget',
        'Disk IO por encima del baseline',
        format('La lectura de disco del proyecto (%s bloques/s, %s GB en 24 h) supera el umbral (rate %s bloques/s, %s GB/24 h). Si el Disk IO Budget se agota, el throughput vuelve al baseline de 6 MB/s y las queries se vuelven lentas.',
               round(v_rate::numeric, 1), round(v_day_gb::numeric, 1),
               p_rate_threshold_blocks_per_sec, p_daily_threshold_gb),
        jsonb_build_object(
          'blocks_per_sec', round(v_rate::numeric, 2),
          'gb_24h', round(v_day_gb::numeric, 2),
          'rate_threshold_blocks_per_sec', p_rate_threshold_blocks_per_sec,
          'daily_threshold_gb', p_daily_threshold_gb,
          'blks_read_total', v_now,
          'over_rate', v_over_rate,
          'over_daily', v_over_day
        ),
        'open'
      );
      v_created := 1;
    END IF;
  ELSIF v_open_alert > 0 THEN
    -- Volvió a la normalidad → se cierra sola (queda en el histórico).
    UPDATE public.supervision_alerts
    SET status = 'resolved',
        resolved_at = now(),
        notes = COALESCE(notes || ' | ', '') || 'Auto-resuelto: IO de vuelta a baseline.'
    WHERE alert_type = 'disk_io_budget' AND status IN ('open', 'assigned', 'investigating', 'acknowledged');
    GET DIAGNOSTICS v_resolved = ROW_COUNT;
  END IF;

  -- Higiene: 8 días de muestras alcanza para el cálculo de 24 h.
  DELETE FROM public.bh_io_samples WHERE ts < now() - interval '8 days';

  RETURN jsonb_build_object(
    'blocks_per_sec', round(v_rate::numeric, 3),
    'gb_24h', round(v_day_gb::numeric, 3),
    'over_rate', v_over_rate,
    'over_daily', v_over_day,
    'alert_created', v_created,
    'alerts_resolved', v_resolved
  );
END
$fn$;

-- ------------------------------------------------------------
-- 3. Retención en LOTES (mitigación B)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bh_archive_ml_sync_queue_success(
  p_days    integer DEFAULT 7,
  p_batch   integer DEFAULT 5000,
  p_batches integer DEFAULT 20
)
RETURNS TABLE(queue_archived integer, history_archived integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_cutoff timestamptz := now() - make_interval(days => p_days);
  v_ids    bigint[];
  v_q      integer := 0;
  v_h      integer := 0;
  v_total_q integer := 0;
  v_total_h integer := 0;
  v_i      integer;
BEGIN
  FOR v_i IN 1..GREATEST(p_batches, 1) LOOP
    SELECT array_agg(id) INTO v_ids
    FROM (
      SELECT id FROM public.ml_sync_queue
      WHERE status = 'success' AND created_at < v_cutoff
      ORDER BY created_at LIMIT GREATEST(p_batch, 1)
    ) s;

    EXIT WHEN v_ids IS NULL OR cardinality(v_ids) = 0;

    -- El historial va primero: el DELETE de la cola lo arrastra por CASCADE.
    INSERT INTO public.ml_sync_history_success_archive
      (id, queue_id, operation, status, attempt, response, error, created_at)
    SELECT h.id, h.queue_id, h.operation, h.status, h.attempt, h.response, h.error, h.created_at
    FROM public.ml_sync_history h
    WHERE h.queue_id = ANY(v_ids)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_h = ROW_COUNT;

    INSERT INTO public.ml_sync_queue_success_archive
      (id, property_id, operation, ml_item_id, attempts, max_attempts, status,
       locked_by, locked_at, next_attempt_at, last_error, payload, created_at, updated_at)
    SELECT q.id, q.property_id, q.operation, q.ml_item_id, q.attempts, q.max_attempts, q.status,
           q.locked_by, q.locked_at, q.next_attempt_at, q.last_error, q.payload, q.created_at, q.updated_at
    FROM public.ml_sync_queue q
    WHERE q.id = ANY(v_ids)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_q = ROW_COUNT;

    DELETE FROM public.ml_sync_queue WHERE id = ANY(v_ids);

    v_total_q := v_total_q + v_q;
    v_total_h := v_total_h + v_h;
  END LOOP;

  RETURN QUERY SELECT v_total_q, v_total_h;
END
$fn$;

CREATE OR REPLACE FUNCTION public.bh_archive_audit_log(
  p_days    integer DEFAULT 60,
  p_batch   integer DEFAULT 5000,
  p_batches integer DEFAULT 20
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_cutoff timestamptz := now() - make_interval(days => p_days);
  v_ids    uuid[];
  v_n      integer := 0;
  v_total  integer := 0;
  v_i      integer;
BEGIN
  FOR v_i IN 1..GREATEST(p_batches, 1) LOOP
    SELECT array_agg(id) INTO v_ids
    FROM (
      SELECT id FROM public.audit_log
      WHERE created_at < v_cutoff
      ORDER BY created_at LIMIT GREATEST(p_batch, 1)
    ) s;

    EXIT WHEN v_ids IS NULL OR cardinality(v_ids) = 0;

    INSERT INTO public.audit_log_archive
      (id, user_id, role_snapshot, broker_id, action, module, table_name, record_id,
       entity_type, entity_id, entity_label, old_data, new_data, changed_fields, metadata,
       status, error_code, ip, user_agent, session_id, request_id, created_at,
       event_hash, previous_hash)
    SELECT a.id, a.user_id, a.role_snapshot, a.broker_id, a.action, a.module, a.table_name, a.record_id,
           a.entity_type, a.entity_id, a.entity_label, a.old_data, a.new_data, a.changed_fields, a.metadata,
           a.status, a.error_code, a.ip, a.user_agent, a.session_id, a.request_id, a.created_at,
           a.event_hash, a.previous_hash
    FROM public.audit_log a
    WHERE a.id = ANY(v_ids)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    DELETE FROM public.audit_log WHERE id = ANY(v_ids);
    v_total := v_total + v_n;
  END LOOP;

  RETURN v_total;
END
$fn$;

CREATE OR REPLACE FUNCTION public.bh_archive_ml_webhook_events(
  p_days    integer DEFAULT 180,
  p_batch   integer DEFAULT 20000,
  p_batches integer DEFAULT 5
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_cutoff timestamptz := now() - make_interval(days => p_days);
  v_ids    uuid[];
  v_n      integer := 0;
  v_total  integer := 0;
  v_i      integer;
BEGIN
  FOR v_i IN 1..GREATEST(p_batches, 1) LOOP
    SELECT array_agg(id) INTO v_ids
    FROM (
      SELECT id FROM public.ml_webhook_events
      WHERE received_at < v_cutoff
      ORDER BY received_at LIMIT GREATEST(p_batch, 1)
    ) s;

    EXIT WHEN v_ids IS NULL OR cardinality(v_ids) = 0;

    INSERT INTO public.ml_webhook_events_archive
      (id, user_id, resource, topic, application_id, attempts, sent_at, received_at,
       status, error, payload, processed_at)
    SELECT e.id, e.user_id, e.resource, e.topic, e.application_id, e.attempts, e.sent_at, e.received_at,
           e.status, e.error, e.payload, e.processed_at
    FROM public.ml_webhook_events e
    WHERE e.id = ANY(v_ids)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    DELETE FROM public.ml_webhook_events WHERE id = ANY(v_ids);
    v_total := v_total + v_n;
  END LOOP;

  RETURN v_total;
END
$fn$;

-- ------------------------------------------------------------
-- 4. Permisos de las funciones nuevas
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.bh_check_io_budget(double precision, double precision) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bh_archive_ml_sync_queue_success(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bh_archive_audit_log(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bh_archive_ml_webhook_events(integer, integer, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.bh_check_io_budget(double precision, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.bh_archive_ml_sync_queue_success(integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.bh_archive_audit_log(integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.bh_archive_ml_webhook_events(integer, integer, integer) TO service_role;

-- Las firmas viejas (2 args) quedan con la misma política.
REVOKE ALL ON FUNCTION public.bh_archive_ml_sync_queue_success(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bh_archive_audit_log(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bh_archive_ml_webhook_events(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bh_archive_ml_sync_queue_success(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.bh_archive_audit_log(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.bh_archive_ml_webhook_events(integer, integer) TO service_role;

-- ------------------------------------------------------------
-- 5. Crons: retención cada 6 h + alarma de IO cada hora
-- ------------------------------------------------------------
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'bh-archive-retention-daily';
SELECT cron.schedule(
  'bh-archive-retention-daily',
  '15 */6 * * *',
  $cron$
  SELECT public.bh_archive_ml_sync_queue_success();
  SELECT public.bh_archive_audit_log();
  SELECT public.bh_archive_ml_webhook_events();
  $cron$
);

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'bh-io-budget-check-hourly';
SELECT cron.schedule(
  'bh-io-budget-check-hourly',
  '30 * * * *',
  $cron$
  SELECT public.bh_check_io_budget();
  $cron$
);
