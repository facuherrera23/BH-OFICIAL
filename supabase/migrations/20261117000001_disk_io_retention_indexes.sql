-- ============================================
-- 20261117000001 — Disk IO Budget: índices + retención CON ARCHIVO
-- ============================================
-- Contexto: Supabase Free tier agotó el "Disk IO Budget" (baseline 6 MB/s).
-- Diagnóstico (pg_stat_user_tables + pg_stat_statements):
--   • ml_webhook_events: 137k filas, max(received_at) en seq scan por cada
--     llamada a get_sidebar_badge_counts() → 81 GB leídos (10,1M bloques).
--   • ml_sync_queue: 85k filas (67k successAccumulated) + sin índice por status.
--   • audit_log: 161k filas, panel de supervisión hacía seq scan + sort (11,5 s).
--   • calculate_supervision_baselines(): 19,5 s por corrida (cron horario).
--
-- REGLA DURA DEL PROYECTO: NADA SE BORRA SIN COPIA.
-- Las 3 funciones de retención COPIAN primero a una tabla *_archive y recién
-- después borran de la tabla operativa. Nada se pierde.
--
-- NOTA DE APLICACIÓN: en producción estos índices se crearon con
-- CREATE INDEX CONCURRENTLY (vía execute_sql del MCP, fuera de transaction,
-- cero downtime). Acá van sin CONCURRENTLY porque apply_migration corre
-- dentro de un transaction block (25001) y porque IF NOT EXISTS los deja
-- no-op en producción. En una base nueva no hay downtime que preservar.
-- ============================================

-- ------------------------------------------------------------
-- 1. TABLAS DE ARCHIVO (RLS ON, solo service_role)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ml_sync_queue_success_archive
  (LIKE public.ml_sync_queue INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING STORAGE);

CREATE TABLE IF NOT EXISTS public.ml_sync_history_success_archive
  (LIKE public.ml_sync_history INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING STORAGE);

CREATE TABLE IF NOT EXISTS public.ml_webhook_events_archive
  (LIKE public.ml_webhook_events INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING STORAGE);

CREATE TABLE IF NOT EXISTS public.audit_log_archive
  (LIKE public.audit_log INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING STORAGE);

ALTER TABLE public.ml_sync_queue_success_archive  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_sync_history_success_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_webhook_events_archive      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log_archive              ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ml_sync_queue_success_archive  FROM anon, authenticated;
REVOKE ALL ON public.ml_sync_history_success_archive FROM anon, authenticated;
REVOKE ALL ON public.ml_webhook_events_archive      FROM anon, authenticated;
REVOKE ALL ON public.audit_log_archive              FROM anon, authenticated;

GRANT ALL ON public.ml_sync_queue_success_archive  TO service_role;
GRANT ALL ON public.ml_sync_history_success_archive TO service_role;
GRANT ALL ON public.ml_webhook_events_archive      TO service_role;
GRANT ALL ON public.audit_log_archive              TO service_role;

-- Idempotencia del archivado + advisor limpio (no_primary_key): la PK unique
-- en id sirve además para el ON CONFLICT (id) DO NOTHING de las funciones.
DO $$
DECLARE
  t text;
  pk text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ml_sync_queue_success_archive',
    'ml_sync_history_success_archive',
    'ml_webhook_events_archive',
    'audit_log_archive'
  ] LOOP
    pk := t || '_pkey';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = t::regclass AND contype = 'p'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I PRIMARY KEY (id)', t, pk);
    END IF;
  END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS idx_audit_log_archive_created
  ON public.audit_log_archive (created_at DESC);

-- ------------------------------------------------------------
-- 2. ÍNDICES QUE ELIMINAN LOS SEQ SCANS
-- ------------------------------------------------------------
-- Landing público: catálogo de publicadas ordenadas por fecha.
CREATE INDEX IF NOT EXISTS idx_properties_published_created
  ON public.properties (is_published, deleted_at, created_at DESC)
  WHERE is_published = true AND deleted_at IS NULL;

-- Dashboard admin: KPIs de propiedades activas.
CREATE INDEX IF NOT EXISTS idx_properties_active_dashboard
  ON public.properties (is_published, status, deleted_at, price_usd, agent_id)
  WHERE is_published = true AND deleted_at IS NULL AND status IN ('venta', 'alquiler');

-- Propiedades por agente (filtro del panel).
CREATE INDEX IF NOT EXISTS idx_properties_agent_id
  ON public.properties (agent_id, is_published, deleted_at, status)
  WHERE is_published = true AND deleted_at IS NULL;

-- CRM: leads activos por etapa y fecha.
CREATE INDEX IF NOT EXISTS idx_leads_active_stage_created
  ON public.leads (deleted_at, stage, created_at DESC)
  WHERE deleted_at IS NULL AND stage NOT IN ('cerrado_ganado', 'cerrado_perdido');

-- Agenda: visitas (NOW() no es IMMUTABLE → predicado solo sobre deleted_at).
CREATE INDEX IF NOT EXISTS idx_visits_upcoming
  ON public.visits (deleted_at, visit_date, status)
  WHERE deleted_at IS NULL;

-- Dashboard: agentes activos.
CREATE INDEX IF NOT EXISTS idx_agents_active
  ON public.agents (status, deleted_at, full_name)
  WHERE status = 'activo' AND deleted_at IS NULL;

-- Supervisión: feed de auditoría por módulo.
CREATE INDEX IF NOT EXISTS idx_audit_log_module_created
  ON public.audit_log (module, created_at DESC);

-- Supervisión: baselines/anomalías por rango de fecha (CUBRIENTE).
-- INCLUDE evita el heap fetch de las 160k filas: el cron horario
-- calculate_supervision_baselines() pasa de 19,5 s a ~3 s de CPU con
-- Index Only Scan.
CREATE INDEX IF NOT EXISTS idx_audit_log_created_cover
  ON public.audit_log (created_at DESC) INCLUDE (module, user_id, action, status);

-- Owner tasks: vencimientos por propietario.
CREATE INDEX IF NOT EXISTS idx_owner_tasks_owner_due_status
  ON public.owner_tasks (owner_id, due_date, status)
  WHERE status IN ('pendiente', 'en_progreso');

-- Zernio: conversaciones abiertas.
CREATE INDEX IF NOT EXISTS idx_zernio_conv_open
  ON public.zernio_conversations (status, last_message_at DESC NULLS LAST)
  WHERE status = 'open';

-- CRM: links lead↔propiedad.
CREATE INDEX IF NOT EXISTS idx_lead_properties_lead_id
  ON public.lead_properties (lead_id, property_id);

-- ML: badge de eventos fallidos (antes: seq scan de 137k filas).
CREATE INDEX IF NOT EXISTS idx_ml_webhook_events_status_received
  ON public.ml_webhook_events (status, received_at DESC);

-- ML: max(received_at) del badge → Index Only Scan (81 GB → 5 bloques).
CREATE INDEX IF NOT EXISTS idx_ml_webhook_events_received_at
  ON public.ml_webhook_events (received_at DESC);

-- ML: cola por status (panel Portales + conteos).
CREATE INDEX IF NOT EXISTS idx_ml_sync_queue_status_created
  ON public.ml_sync_queue (status, created_at DESC);

-- ML: historial ordenado por fecha (panel Portales).
CREATE INDEX IF NOT EXISTS idx_ml_sync_history_created_at
  ON public.ml_sync_history (created_at DESC);

-- ------------------------------------------------------------
-- 3. RETENCIÓN CON ARCHIVO (copia SIEMPRE antes de borrar)
-- ------------------------------------------------------------
-- ml_sync_queue: los jobs 'success' se acumulan (~2.200/día). El historial
-- tiene DELETE CASCADE hacia ml_sync_queue.id → hay que copiar AMBOS antes
-- de borrar la cola.

CREATE OR REPLACE FUNCTION public.bh_archive_ml_sync_queue_success(
  p_days  integer DEFAULT 7,
  p_batch integer DEFAULT 5000
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
BEGIN
  SELECT array_agg(id) INTO v_ids
  FROM (
    SELECT id
    FROM public.ml_sync_queue
    WHERE status = 'success' AND created_at < v_cutoff
    ORDER BY created_at
    LIMIT GREATEST(p_batch, 1)
  ) s;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  -- 1) Historial primero: el DELETE de la cola lo arrastra por CASCADE.
  INSERT INTO public.ml_sync_history_success_archive
    (id, queue_id, operation, status, attempt, response, error, created_at)
  SELECT h.id, h.queue_id, h.operation, h.status, h.attempt, h.response, h.error, h.created_at
  FROM public.ml_sync_history h
  WHERE h.queue_id = ANY(v_ids)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_h = ROW_COUNT;

  -- 2) Jobs de la cola.
  INSERT INTO public.ml_sync_queue_success_archive
    (id, property_id, operation, ml_item_id, attempts, max_attempts, status,
     locked_by, locked_at, next_attempt_at, last_error, payload, created_at, updated_at)
  SELECT q.id, q.property_id, q.operation, q.ml_item_id, q.attempts, q.max_attempts, q.status,
         q.locked_by, q.locked_at, q.next_attempt_at, q.last_error, q.payload, q.created_at, q.updated_at
  FROM public.ml_sync_queue q
  WHERE q.id = ANY(v_ids)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_q = ROW_COUNT;

  -- 3) Recién ahora se borra de la tabla operativa (ya está todo archivado).
  DELETE FROM public.ml_sync_queue WHERE id = ANY(v_ids);

  RETURN QUERY SELECT v_q, v_h;
END
$fn$;

-- audit_log: crece ~5.000 filas/día. Los baselines usan 30 días y el digest 7.
-- A los 60 días la fila sale de la tabla operativa pero queda en el archivo.
CREATE OR REPLACE FUNCTION public.bh_archive_audit_log(
  p_days  integer DEFAULT 60,
  p_batch integer DEFAULT 5000
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
BEGIN
  SELECT array_agg(id) INTO v_ids
  FROM (
    SELECT id
    FROM public.audit_log
    WHERE created_at < v_cutoff
    ORDER BY created_at
    LIMIT GREATEST(p_batch, 1)
  ) s;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RETURN 0;
  END IF;

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
  RETURN v_n;
END
$fn$;

-- ml_webhook_events: la política del owner es 180 días (las consultas
-- vis_leads/questions se conservan por trazabilidad). Esta función
-- archiva antes de borrar y es la que usa el cron diario.
CREATE OR REPLACE FUNCTION public.bh_archive_ml_webhook_events(
  p_days  integer DEFAULT 180,
  p_batch integer DEFAULT 20000
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
BEGIN
  SELECT array_agg(id) INTO v_ids
  FROM (
    SELECT id
    FROM public.ml_webhook_events
    WHERE received_at < v_cutoff
    ORDER BY received_at
    LIMIT GREATEST(p_batch, 1)
  ) s;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RETURN 0;
  END IF;

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
  RETURN v_n;
END
$fn$;

-- El purge histórico (21 días para el ruido 'processed') ahora ARCHIVA
-- antes de borrar: antes tiraba la fila sin copia.
CREATE OR REPLACE FUNCTION public.purge_ml_webhook_events(p_max_rows integer DEFAULT 50000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_noise integer := 0;
  v_old   integer := 0;
  v_ids   uuid[];
BEGIN
  SELECT array_agg(id) INTO v_ids
  FROM (
    SELECT id FROM public.ml_webhook_events
    WHERE status = 'processed'
      AND topic NOT IN ('vis_leads', 'questions')
      AND received_at < now() - interval '21 days'
    ORDER BY received_at
    LIMIT GREATEST(p_max_rows, 1)
  ) s;

  IF v_ids IS NOT NULL AND cardinality(v_ids) > 0 THEN
    INSERT INTO public.ml_webhook_events_archive
      (id, user_id, resource, topic, application_id, attempts, sent_at, received_at,
       status, error, payload, processed_at)
    SELECT e.id, e.user_id, e.resource, e.topic, e.application_id, e.attempts, e.sent_at, e.received_at,
           e.status, e.error, e.payload, e.processed_at
    FROM public.ml_webhook_events e
    WHERE e.id = ANY(v_ids)
    ON CONFLICT (id) DO NOTHING;

    DELETE FROM public.ml_webhook_events WHERE id = ANY(v_ids);
    GET DIAGNOSTICS v_noise = ROW_COUNT;
  END IF;

  SELECT array_agg(id) INTO v_ids
  FROM (
    SELECT id FROM public.ml_webhook_events
    WHERE received_at < now() - interval '180 days'
    ORDER BY received_at
    LIMIT GREATEST(p_max_rows, 1)
  ) s;

  IF v_ids IS NOT NULL AND cardinality(v_ids) > 0 THEN
    INSERT INTO public.ml_webhook_events_archive
      (id, user_id, resource, topic, application_id, attempts, sent_at, received_at,
       status, error, payload, processed_at)
    SELECT e.id, e.user_id, e.resource, e.topic, e.application_id, e.attempts, e.sent_at, e.received_at,
           e.status, e.error, e.payload, e.processed_at
    FROM public.ml_webhook_events e
    WHERE e.id = ANY(v_ids)
    ON CONFLICT (id) DO NOTHING;

    DELETE FROM public.ml_webhook_events WHERE id = ANY(v_ids);
    GET DIAGNOSTICS v_old = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('noise_deleted', v_noise, 'old_deleted', v_old);
END
$fn$;

-- ------------------------------------------------------------
-- 4. PERMISOS (toda función nueva: search_path fijo + revoke PUBLIC/anon)
-- ------------------------------------------------------------
-- OJO: Supabase tiene `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE TO
-- anon, authenticated, service_role` → al CREAR la función, authenticated
-- queda con EXECUTE aunque se revoke PUBLIC después. Hay que revocar
-- explícitamente el rol authenticated (este repo no expone estas funciones
-- al panel: solo las usa el cron y service_role).
REVOKE ALL ON FUNCTION public.bh_archive_ml_sync_queue_success(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bh_archive_audit_log(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bh_archive_ml_webhook_events(integer, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.bh_archive_ml_sync_queue_success(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.bh_archive_audit_log(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.bh_archive_ml_webhook_events(integer, integer) TO service_role;

-- ------------------------------------------------------------
-- 5. CRON DIARIO DE RETENCIÓN (11:15 UTC = 08:15 ART)
--    Corre después del purge de ML (07:45 UTC) y antes del backup.
-- ------------------------------------------------------------
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'bh-archive-retention-daily';

SELECT cron.schedule(
  'bh-archive-retention-daily',
  '15 11 * * *',
  $cron$
  SELECT public.bh_archive_ml_sync_queue_success();
  SELECT public.bh_archive_audit_log();
  SELECT public.bh_archive_ml_webhook_events();
  $cron$
);
