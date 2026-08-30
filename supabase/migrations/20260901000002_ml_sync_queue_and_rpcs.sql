-- ============================================================
-- MIGRATION: ML Sync Queue Tables + RPCs
-- ============================================================
-- Creates the queue infrastructure needed by ml-sync Edge Function
-- Fixes: ml-sync calls ml_enqueue, ml_enqueue_batch, ml_claim_jobs (missing RPCs)
-- ============================================================

-- ------------------------------------------------------------
-- 1. ENUMS
-- ------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE ml_sync_operation AS ENUM ('publish', 'update', 'delete');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ml_sync_status AS ENUM ('pending', 'processing', 'success', 'failed', 'dead_letter', 'rate_limited');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 2. QUEUE TABLE
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ml_sync_queue (
  id BIGSERIAL PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  operation ml_sync_operation NOT NULL,
  ml_item_id TEXT,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  status ml_sync_status NOT NULL DEFAULT 'pending',
  locked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  locked_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para performance de claim y polling
CREATE INDEX IF NOT EXISTS idx_ml_sync_queue_status_next ON public.ml_sync_queue (status, next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ml_sync_queue_property ON public.ml_sync_queue (property_id);

-- Trigger updated_at
CREATE TRIGGER trg_ml_sync_queue_updated_at
  BEFORE UPDATE ON public.ml_sync_queue
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ------------------------------------------------------------
-- 3. HISTORY TABLE
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ml_sync_history (
  id BIGSERIAL PRIMARY KEY,
  queue_id BIGINT NOT NULL REFERENCES public.ml_sync_queue(id) ON DELETE CASCADE,
  operation ml_sync_operation NOT NULL,
  status ml_sync_status NOT NULL,
  attempt INT NOT NULL,
  response JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_sync_history_queue ON public.ml_sync_history (queue_id);

-- ------------------------------------------------------------
-- 4. DEAD LETTER TABLE
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ml_sync_dead_letter (
  id BIGSERIAL PRIMARY KEY,
  original_queue_id BIGINT NOT NULL,
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  operation ml_sync_operation NOT NULL,
  attempts INT NOT NULL,
  max_attempts INT NOT NULL,
  last_error TEXT NOT NULL,
  payload JSONB,
  ml_item_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_sync_dead_letter_property ON public.ml_sync_dead_letter (property_id);

-- ------------------------------------------------------------
-- 5. PROPERTY ML META (upsert target for ml-sync)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.property_ml_meta (
  property_id UUID PRIMARY KEY REFERENCES public.properties(id) ON DELETE CASCADE,
  ml_item_id TEXT,
  status TEXT,
  permalink TEXT,
  price NUMERIC,
  last_sync_at TIMESTAMPTZ,
  last_sync_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_property_ml_meta_updated_at
  BEFORE UPDATE ON public.property_ml_meta
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ------------------------------------------------------------
-- 6. RPC: ml_enqueue (single job)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ml_enqueue(
  p_property_id UUID,
  p_operation ml_sync_operation,
  p_ml_item_id TEXT DEFAULT NULL,
  p_max_attempts INT DEFAULT 5,
  p_payload JSONB DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_queue_id BIGINT;
BEGIN
  INSERT INTO public.ml_sync_queue (property_id, operation, ml_item_id, max_attempts, payload)
  VALUES (p_property_id, p_operation, p_ml_item_id, p_max_attempts, p_payload)
  RETURNING id INTO v_queue_id;
  RETURN v_queue_id;
END;
$$;

-- ------------------------------------------------------------
-- 7. RPC: ml_enqueue_batch (multiple jobs)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ml_enqueue_batch(
  p_jobs JSONB  -- array of {property_id, operation, ml_item_id?, max_attempts?, payload?}
) RETURNS BIGINT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job JSONB;
  v_queue_ids BIGINT[] := '{}';
BEGIN
  FOREACH v_job IN ARRAY p_jobs LOOP
    INSERT INTO public.ml_sync_queue (property_id, operation, ml_item_id, max_attempts, payload)
    VALUES (
      (v_job->>'property_id')::UUID,
      (v_job->>'operation')::ml_sync_operation,
      NULLIF(v_job->>'ml_item_id', '')::TEXT,
      COALESCE((v_job->>'max_attempts')::INT, 5),
      v_job->'payload'
    )
    RETURNING id INTO v_queue_ids;
  END LOOP;
  RETURN v_queue_ids;
END;
$$;

-- ------------------------------------------------------------
-- 8. RPC: ml_claim_jobs (atomic claim with FOR UPDATE SKIP LOCKED)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ml_claim_jobs(
  p_batch_size INT DEFAULT 10
) RETURNS SETOF public.ml_sync_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.ml_sync_queue;
BEGIN
  FOR v_job IN
    UPDATE public.ml_sync_queue q
    SET
      status = 'processing',
      locked_by = auth.uid(),
      locked_at = now(),
      attempts = q.attempts + 1
    FROM (
      SELECT id
      FROM public.ml_sync_queue
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    ) sub
    WHERE q.id = sub.id
    RETURNING q.*
  LOOP
    RETURN NEXT v_job;
  END LOOP;
  RETURN;
END;
$$;

-- ------------------------------------------------------------
-- 9. RLS POLICIES
-- ------------------------------------------------------------
ALTER TABLE public.ml_sync_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_sync_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_sync_dead_letter ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_ml_meta ENABLE ROW LEVEL SECURITY;

-- ml_sync_queue: service_role full access, authenticated read
DROP POLICY IF EXISTS ml_sync_queue_svc_all ON public.ml_sync_queue;
CREATE POLICY ml_sync_queue_svc_all ON public.ml_sync_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ml_sync_queue_auth_read ON public.ml_sync_queue;
CREATE POLICY ml_sync_queue_auth_read ON public.ml_sync_queue
  FOR SELECT TO authenticated USING (true);

-- ml_sync_history: service_role full, authenticated read
DROP POLICY IF EXISTS ml_sync_history_svc_all ON public.ml_sync_history;
CREATE POLICY ml_sync_history_svc_all ON public.ml_sync_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ml_sync_history_auth_read ON public.ml_sync_history;
CREATE POLICY ml_sync_history_auth_read ON public.ml_sync_history
  FOR SELECT TO authenticated USING (true);

-- ml_sync_dead_letter: service_role full, authenticated read
DROP POLICY IF EXISTS ml_sync_dl_svc_all ON public.ml_sync_dead_letter;
CREATE POLICY ml_sync_dl_svc_all ON public.ml_sync_dead_letter
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ml_sync_dl_auth_read ON public.ml_sync_dead_letter;
CREATE POLICY ml_sync_dl_auth_read ON public.ml_sync_dead_letter
  FOR SELECT TO authenticated USING (true);

-- property_ml_meta: service_role full, authenticated read, super_admin/broker write
DROP POLICY IF EXISTS property_ml_meta_svc_all ON public.property_ml_meta;
CREATE POLICY property_ml_meta_svc_all ON public.property_ml_meta
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS property_ml_meta_auth_read ON public.property_ml_meta;
CREATE POLICY property_ml_meta_auth_read ON public.property_ml_meta
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS property_ml_meta_admin_insert ON public.property_ml_meta;
CREATE POLICY property_ml_meta_admin_insert ON public.property_ml_meta
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role])
    )
  );

DROP POLICY IF EXISTS property_ml_meta_admin_update ON public.property_ml_meta;
CREATE POLICY property_ml_meta_admin_update ON public.property_ml_meta
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role'])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role])
    )
  );

-- ------------------------------------------------------------
-- 10. GRANTS
-- ------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON public.ml_sync_queue TO service_role;
GRANT SELECT ON public.ml_sync_queue TO authenticated;

GRANT SELECT, INSERT ON public.ml_sync_history TO service_role;
GRANT SELECT ON public.ml_sync_history TO authenticated;

GRANT SELECT, INSERT ON public.ml_sync_dead_letter TO service_role;
GRANT SELECT ON public.ml_sync_dead_letter TO authenticated;

GRANT SELECT, INSERT, UPDATE ON public.property_ml_meta TO service_role;
GRANT SELECT ON public.property_ml_meta TO authenticated;

GRANT EXECUTE ON FUNCTION public.ml_enqueue(UUID, ml_sync_operation, TEXT, INT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.ml_enqueue_batch(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.ml_claim_jobs(INT) TO service_role;

-- ------------------------------------------------------------
-- END OF MIGRATION
-- ------------------------------------------------------------