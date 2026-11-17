-- ============================================
-- 20261117000003 — Particionado de audit_log por mes (created_at)
-- ============================================
-- Motivo: audit_log es la tabla más pesada del proyecto (282 MB, 159.790
-- filas, +5.000/día) y grows sin límite. Con retención de 60 días se
-- estabiliza en ~300k filas ≈ 540 MB; particionada por mes, cada mes es
-- un segmento propio →:
--   • las consultas con rango de fecha (baselines, panel de supervisión,
--     digest) hacen PARTITION PRUNING: solo tocan las particiones del rango.
--   • el borrado de una partición vieja (DROP) es instantáneo y no deja
--     basura; acá NO se borra nada (la copia va a audit_log_archive).
--   • el tamaño físico deja de crecer como bloque único.
--
-- REGLAS DURAS:
--   • NADA SE BORRA: la tabla vieja queda como audit_log_pre_part (rollback
--     instantáneo). El dueño decide cuándo dropearla.
--   • La cadena de hashes (event_hash / previous_hash) se preserva EXACTA:
--     el trigger audit_log_integrity se crea DESPUÉS de la copia (si no, el
--     trigger recalcularía los hashes históricos al copiar).
--   • La PK pasa de (id) a (id, created_at): en una tabla particionada por
--     created_at, la PK tiene que incluir la clave de partición. Verificado
--     que NADA en el repo hace ON CONFLICT (id) sobre audit_log.
--   • La RLS: la tabla padre tiene las 4 policies (solo super_admin lee);
--     cada partición lleva RLS ACTIVADA sin policies + sin privilegios para
--     anon/authenticated → el acceso directo a una partición es "permission
--     denied" y por el padre manda la policy del padre. Verificado
--     empíricamente en producción (probe ACL + probe RLS).
--
-- EJECUCIÓN EN PRODUCCIÓN (2026-11-17) — en 4 fases, porque el proxy del
-- MCP corta las conexiones a los 120 s y la copia son 160k filas:
--   FASE 1: se crea audit_log_new + particiones + índices + RLS + grants.
--   FASE 2: se copian los datos mes por mes (2026-09, 2026-10, 2026-11).
--   FASE 3: swap en UNA transacción (lock + delta + renombres + trigger +
--            vista). La tabla vieja NO se dropea.
--   FASE 4: función bh_ensure_audit_log_partitions() + cron diario para
--            que las particiones nuevas se creen solas.
-- ============================================

-- ------------------------------------------------------------
-- FASE 1 — Tabla particionada + particiones + índices + RLS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_log_new (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id        uuid,
  role_snapshot  text,
  broker_id      uuid,
  action         text NOT NULL,
  module         text NOT NULL,
  table_name     text,
  record_id      uuid,
  entity_type    text,
  entity_id      uuid,
  entity_label   text,
  old_data       jsonb,
  new_data       jsonb,
  changed_fields text[],
  metadata       jsonb DEFAULT '{}'::jsonb,
  status         text DEFAULT 'success'::text,
  error_code     text,
  ip             inet,
  user_agent     text,
  session_id     uuid,
  request_id     uuid DEFAULT gen_random_uuid(),
  created_at     timestamptz DEFAULT now(),
  event_hash     text,
  previous_hash  text
) PARTITION BY RANGE (created_at);

-- Particiones mensuales. La DEFAULT es la red de seguridad: si un INSERT
-- cae fuera de los rangos (created_at muy viejo o muy nuevo), la fila se
-- guarda igual en vez de rebotar con un error.
CREATE TABLE IF NOT EXISTS public.audit_log_p202609
  PARTITION OF public.audit_log_new FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS public.audit_log_p202610
  PARTITION OF public.audit_log_new FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS public.audit_log_p202611
  PARTITION OF public.audit_log_new FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS public.audit_log_p202612
  PARTITION OF public.audit_log_new FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS public.audit_log_p202701
  PARTITION OF public.audit_log_new FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS public.audit_log_p202702
  PARTITION OF public.audit_log_new FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS public.audit_log_default
  PARTITION OF public.audit_log_new DEFAULT;

-- PK compuesta (id, created_at): obligatorio en una tabla particionada por
-- created_at. Los índices llevan sufijo _new porque los nombres canónicos
-- están tomados por la tabla vieja (se renombran en el swap).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.audit_log_new'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE public.audit_log_new
      ADD CONSTRAINT audit_log_new_pkey PRIMARY KEY (id, created_at);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_audit_log_new_broker_id
  ON public.audit_log_new (broker_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_user_created_hash
  ON public.audit_log_new (user_id, created_at, event_hash);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_entity
  ON public.audit_log_new (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_request
  ON public.audit_log_new (request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_session
  ON public.audit_log_new (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_created_cover
  ON public.audit_log_new (created_at DESC) INCLUDE (module, user_id, action, status);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_user_created
  ON public.audit_log_new (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_module_created
  ON public.audit_log_new (module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_action_created
  ON public.audit_log_new (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_status_created
  ON public.audit_log_new (status, created_at DESC);

-- FKs idénticas a las de la tabla vieja (ON DELETE SET NULL → nunca hay
-- huérfanos y el borrado de un usuario no rompe la auditoría).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.audit_log_new'::regclass AND conname = 'audit_log_new_broker_id_fkey'
  ) THEN
    ALTER TABLE public.audit_log_new
      ADD CONSTRAINT audit_log_new_broker_id_fkey
      FOREIGN KEY (broker_id) REFERENCES public.agents(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.audit_log_new'::regclass AND conname = 'audit_log_new_user_id_fkey'
  ) THEN
    ALTER TABLE public.audit_log_new
      ADD CONSTRAINT audit_log_new_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- RLS: mismas 4 policies que la tabla vieja (solo super_admin lee).
ALTER TABLE public.audit_log_new ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_log_no_insert ON public.audit_log_new
  FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY audit_log_no_update ON public.audit_log_new
  FOR UPDATE TO authenticated USING (false);
CREATE POLICY audit_log_no_delete ON public.audit_log_new
  FOR DELETE TO authenticated USING (false);
CREATE POLICY audit_log_super_admin_select ON public.audit_log_new
  FOR SELECT TO authenticated USING (is_super_admin((SELECT auth.uid())));

-- Cada partición: RLS activa sin policies + sin privilegios para
-- anon/authenticated → el acceso DIRECTO a una partición se deniega y por
-- el padre se aplica la policy del padre (verificado con probes).
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname LIKE 'audit_log_p2%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p.relname);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', p.relname);
  END LOOP;
  -- La partición DEFAULT también.
  IF to_regclass('public.audit_log_default') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.audit_log_default ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON public.audit_log_default FROM anon, authenticated';
  END IF;
END
$$;

-- Privilegios de la tabla padre (idénticos a los de la tabla vieja).
GRANT ALL ON public.audit_log_new TO anon, authenticated, postgres, service_role;

-- ------------------------------------------------------------
-- FASE 2 — Copia de los datos (mes por mes, por el timeout del proxy)
-- ------------------------------------------------------------
-- El trigger de integridad NO está en la tabla nueva todavía: la copia
-- tiene que preservar event_hash / previous_hash tal cual.
--
-- ESTRATEGIA DE COPIA (la que se usó en producción): la copia se hace SIN
-- los índices secundarios. Con 11 índices sobre 160k filas la escritura
-- tarda más de 120 s (el proxy del MCP corta y la transacción se pierde)
-- porque el disco del free tier va a ~6 MB/s. Con solo la PK (para el
-- ON CONFLICT) la misma copia baja a ~50 s. Los índices se recrean
-- después, sobre la tabla ya poblada.

DROP INDEX IF EXISTS public.idx_audit_log_new_broker_id;
DROP INDEX IF EXISTS public.idx_audit_log_new_user_created_hash;
DROP INDEX IF EXISTS public.idx_audit_log_new_entity;
DROP INDEX IF EXISTS public.idx_audit_log_new_request;
DROP INDEX IF EXISTS public.idx_audit_log_new_session;
DROP INDEX IF EXISTS public.idx_audit_log_new_created_cover;
DROP INDEX IF EXISTS public.idx_audit_log_new_user_created;
DROP INDEX IF EXISTS public.idx_audit_log_new_module_created;
DROP INDEX IF EXISTS public.idx_audit_log_new_action_created;
DROP INDEX IF EXISTS public.idx_audit_log_new_status_created;
-- Las FKs también se agregan al final: validar 160k filas contra
-- auth.users/agents cuesta ~90 s (y NOT VALID no existe en tablas
-- particionadas).

INSERT INTO public.audit_log_new
SELECT * FROM public.audit_log
WHERE created_at >= '2026-09-01' AND created_at < '2026-10-01'
ON CONFLICT (id, created_at) DO NOTHING;

INSERT INTO public.audit_log_new
SELECT * FROM public.audit_log
WHERE created_at >= '2026-10-01' AND created_at < '2026-11-01'
ON CONFLICT (id, created_at) DO NOTHING;

INSERT INTO public.audit_log_new
SELECT * FROM public.audit_log
WHERE created_at >= '2026-11-01' AND created_at < '2026-12-01'
ON CONFLICT (id, created_at) DO NOTHING;

-- Cualquier fila fuera de los rangos anteriores (created_at muy viejo o
-- futuro) va a la partición DEFAULT.
INSERT INTO public.audit_log_new
SELECT * FROM public.audit_log
WHERE created_at < '2026-09-01' OR created_at >= '2026-12-01'
ON CONFLICT (id, created_at) DO NOTHING;

-- Índices secundarios (los mismos que tenía la tabla vieja).
CREATE INDEX IF NOT EXISTS idx_audit_log_new_broker_id
  ON public.audit_log_new (broker_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_user_created_hash
  ON public.audit_log_new (user_id, created_at, event_hash);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_entity
  ON public.audit_log_new (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_request
  ON public.audit_log_new (request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_session
  ON public.audit_log_new (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_created_cover
  ON public.audit_log_new (created_at DESC) INCLUDE (module, user_id, action, status);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_user_created
  ON public.audit_log_new (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_module_created
  ON public.audit_log_new (module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_action_created
  ON public.audit_log_new (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_new_status_created
  ON public.audit_log_new (status, created_at DESC);

-- FKs idénticas a las de la tabla vieja (ON DELETE SET NULL → nunca hay
-- huérfanos y el borrado de un usuario no rompe la auditoría).
ALTER TABLE public.audit_log_new
  ADD CONSTRAINT audit_log_new_broker_id_fkey
  FOREIGN KEY (broker_id) REFERENCES public.agents(id) ON DELETE SET NULL;
ALTER TABLE public.audit_log_new
  ADD CONSTRAINT audit_log_new_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ANALYZE public.audit_log_new;

-- ------------------------------------------------------------
-- FASE 3 — SWAP (una sola transacción)
-- ------------------------------------------------------------
-- 1) La tabla vieja libera los nombres canónicos de índices/constraints.
-- 2) La tabla vieja se renombra (NO se dropea) → audit_log_pre_part.
-- 3) La tabla nueva pasa a llamarse audit_log.
-- 4) Se crea el trigger de integridad (a partir de ahora recalcula los
--    hashes de los inserts nuevos).
-- 5) Se recrea la vista purge_audit_log (apuntaba al OID viejo).
BEGIN;

LOCK TABLE public.audit_log IN ACCESS EXCLUSIVE MODE;

-- Delta: lo que se escribió DESPUÉS de la copia por meses (marca de agua).
-- Acotado por fecha para no recorrer las 160k filas dentro del lock: el
-- control de integridad posterior (anti-join audit_log_pre_part vs
-- audit_log) confirma que no quedó ninguna fila afuera.
INSERT INTO public.audit_log_new
SELECT * FROM public.audit_log
WHERE created_at >= '2026-11-17 03:00:00+00'
ON CONFLICT (id, created_at) DO NOTHING;

-- Liberar los nombres de la tabla vieja (índices + constraints).
ALTER TABLE public.audit_log RENAME CONSTRAINT audit_log_pkey TO audit_log_pre_part_pkey;
ALTER INDEX public.idx_audit_log_broker_id RENAME TO idx_audit_log_pre_part_broker_id;
ALTER INDEX public.idx_audit_log_user_created_hash RENAME TO idx_audit_log_pre_part_user_created_hash;
ALTER INDEX public.idx_audit_log_entity RENAME TO idx_audit_log_pre_part_entity;
ALTER INDEX public.idx_audit_log_request RENAME TO idx_audit_log_pre_part_request;
ALTER INDEX public.idx_audit_log_session RENAME TO idx_audit_log_pre_part_session;
ALTER INDEX public.idx_audit_log_created_cover RENAME TO idx_audit_log_pre_part_created_cover;
ALTER INDEX public.idx_audit_log_user_created RENAME TO idx_audit_log_pre_part_user_created;
ALTER INDEX public.idx_audit_log_module_created RENAME TO idx_audit_log_pre_part_module_created;
ALTER INDEX public.idx_audit_log_action_created RENAME TO idx_audit_log_pre_part_action_created;
ALTER INDEX public.idx_audit_log_status_created RENAME TO idx_audit_log_pre_part_status_created;
ALTER TABLE public.audit_log RENAME CONSTRAINT audit_log_broker_id_fkey TO audit_log_pre_part_broker_id_fkey;
ALTER TABLE public.audit_log RENAME CONSTRAINT audit_log_user_id_fkey TO audit_log_pre_part_user_id_fkey;

-- El swap de nombres.
ALTER TABLE public.audit_log RENAME TO audit_log_pre_part;
ALTER TABLE public.audit_log_new RENAME TO audit_log;

-- Los índices de la tabla nueva toman los nombres canónicos.
ALTER TABLE public.audit_log RENAME CONSTRAINT audit_log_new_pkey TO audit_log_pkey;
ALTER TABLE public.audit_log RENAME CONSTRAINT audit_log_new_broker_id_fkey TO audit_log_broker_id_fkey;
ALTER TABLE public.audit_log RENAME CONSTRAINT audit_log_new_user_id_fkey TO audit_log_user_id_fkey;
ALTER INDEX public.idx_audit_log_new_broker_id RENAME TO idx_audit_log_broker_id;
ALTER INDEX public.idx_audit_log_new_user_created_hash RENAME TO idx_audit_log_user_created_hash;
ALTER INDEX public.idx_audit_log_new_entity RENAME TO idx_audit_log_entity;
ALTER INDEX public.idx_audit_log_new_request RENAME TO idx_audit_log_request;
ALTER INDEX public.idx_audit_log_new_session RENAME TO idx_audit_log_session;
ALTER INDEX public.idx_audit_log_new_created_cover RENAME TO idx_audit_log_created_cover;
ALTER INDEX public.idx_audit_log_new_user_created RENAME TO idx_audit_log_user_created;
ALTER INDEX public.idx_audit_log_new_module_created RENAME TO idx_audit_log_module_created;
ALTER INDEX public.idx_audit_log_new_action_created RENAME TO idx_audit_log_action_created;
ALTER INDEX public.idx_audit_log_new_status_created RENAME TO idx_audit_log_status_created;

-- Trigger de integridad (ahora sí: recalcula los hashes de los inserts
-- NUEVOS; las filas copiadas conservan los suyos).
CREATE TRIGGER audit_log_integrity
  BEFORE INSERT ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_integrity_fn();

-- La vista purge_audit_log apuntaba al OID de la tabla vieja.
-- OJO: WITH (security_invoker = true) es OBLIGATORIO. Sin esto la vista
-- corre con los permisos del creador (postgres) → saltea la RLS de
-- audit_log y el advisor marca "Security Definer View" (ERROR). Las otras
-- 4 vistas del proyecto ya lo tienen.
DROP VIEW IF EXISTS public.purge_audit_log;
CREATE VIEW public.purge_audit_log
WITH (security_invoker = true)
AS
  SELECT created_at,
         action,
         status,
         metadata ->> 'deleted_count'   AS deleted_count,
         metadata ->> 'retention_days'   AS retention_days,
         metadata ->> 'cutoff_date'      AS cutoff_date
  FROM audit_log
  WHERE action = ANY (ARRAY['purge_audit_log', 'purge_supervision_alerts'])
  ORDER BY created_at DESC
  LIMIT 100;

COMMIT;

-- ------------------------------------------------------------
-- Trigger de integridad: preservar el hash si ya viene calculado
-- ------------------------------------------------------------
-- Necesario para dos casos:
--   1) el copiado de filas de la partición DEFAULT a una mensual (el
--      trigger clonado se dispararía y recalcularía el hash histórico);
--   2) cualquier re-copia manual de respaldo.
-- Con event_hash NULL (insert normal) el comportamiento es el de siempre.
CREATE OR REPLACE FUNCTION public.audit_log_integrity_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_previous_hash text;
  v_event_hash    text;
BEGIN
  -- Si el evento ya trae hash (copia/migración), se preserva: recalcularlo
  -- rompería la cadena histórica.
  IF NEW.event_hash IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT event_hash INTO v_previous_hash
  FROM public.audit_log
  WHERE user_id = NEW.user_id
    AND created_at < NEW.created_at
  ORDER BY created_at DESC
  LIMIT 1;

  v_event_hash := public.calculate_event_hash(
    NEW.id,
    NEW.user_id,
    NEW.action,
    NEW.module,
    NEW.entity_type,
    NEW.entity_id,
    NEW.old_data,
    NEW.new_data,
    v_previous_hash
  );

  NEW.event_hash    := v_event_hash;
  NEW.previous_hash := v_previous_hash;

  RETURN NEW;
END
$fn$;

-- ------------------------------------------------------------
-- FASE 4 — Particiones futuras automáticas
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bh_ensure_audit_log_partitions(
  p_months_ahead integer DEFAULT 3
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_month   date := date_trunc('month', now())::date;
  v_i       integer;
  v_start   date;
  v_end     date;
  v_part    text;
  v_created integer := 0;
BEGIN
  -- Guarda: si la tabla padre no es particionada, no se toca nada.
  IF NOT EXISTS (
    SELECT 1 FROM pg_partitioned_table WHERE partrelid = 'public.audit_log'::regclass
  ) THEN
    RETURN -1;
  END IF;

  FOR v_i IN 0..GREATEST(p_months_ahead, 0) LOOP
    v_start := (v_month + make_interval(months => v_i))::date;
    v_end   := (v_start + interval '1 month')::date;
    v_part  := format('audit_log_p%s', to_char(v_start, 'YYYYMM'));

    IF to_regclass(format('public.%I', v_part)) IS NULL THEN
      IF to_regclass('public.audit_log_default') IS NOT NULL THEN
        -- Las filas del mes que todavía están en DEFAULT → se mudan.
        EXECUTE 'LOCK TABLE public.audit_log_default IN ACCESS EXCLUSIVE MODE';
        EXECUTE format(
          'CREATE TABLE public.%I PARTITION OF public.audit_log FOR VALUES FROM (%L) TO (%L)',
          v_part, v_start, v_end
        );
        EXECUTE format(
          'INSERT INTO public.%I SELECT * FROM public.audit_log_default WHERE created_at >= %L AND created_at < %L',
          v_part, v_start, v_end
        );
        EXECUTE format(
          'DELETE FROM public.audit_log_default WHERE created_at >= %L AND created_at < %L',
          v_start, v_end
        );
      ELSE
        EXECUTE format(
          'CREATE TABLE public.%I PARTITION OF public.audit_log FOR VALUES FROM (%L) TO (%L)',
          v_part, v_start, v_end
        );
      END IF;

      -- Misma protección que las particiones iniciales: sin acceso directo.
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_part);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', v_part);
      v_created := v_created + 1;
    END IF;
  END LOOP;

  RETURN v_created;
END
$fn$;

REVOKE ALL ON FUNCTION public.bh_ensure_audit_log_partitions(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bh_ensure_audit_log_partitions(integer) TO service_role;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'bh-audit-log-partitions-daily';

SELECT cron.schedule(
  'bh-audit-log-partitions-daily',
  '10 5 * * *',
  $cron$
  SELECT public.bh_ensure_audit_log_partitions();
  $cron$
);
