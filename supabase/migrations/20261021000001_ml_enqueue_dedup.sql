-- FIX 2026-10-21: dedup en la cola de sync ML.
-- Incidente: el eco sync→ML→webhook(items)→enqueue disparó 42.676 jobs
-- duplicados para UNA propiedad (12-16/10) + decenas de miles más para otras;
-- a 120 jobs/hora la cola quedó ahogada por días y los updates nunca llegaban.
-- El dedup no pierde nada: los jobs no llevan payload (apuntan a la propiedad)
-- y el update procesa con data FRESCA de la DB — 1 job pendiente por
-- propiedad+operación produce el mismo efecto que 42.000.
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
  IF EXISTS (
    SELECT 1 FROM public.ml_sync_queue
    WHERE property_id = p_property_id
      AND operation = p_operation
      AND status IN ('pending', 'processing')
  ) THEN
    RETURN NULL; -- ya hay un job en camino: el update procesa con data fresca
  END IF;
  INSERT INTO public.ml_sync_queue (property_id, operation, ml_item_id, max_attempts, payload)
  VALUES (p_property_id, p_operation, p_ml_item_id, p_max_attempts, p_payload)
  RETURNING id INTO v_queue_id;
  RETURN v_queue_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ml_enqueue_batch(
  p_jobs JSONB
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
    IF EXISTS (
      SELECT 1 FROM public.ml_sync_queue
      WHERE property_id = (v_job->>'property_id')::UUID
        AND operation = (v_job->>'operation')::ml_sync_operation
        AND status IN ('pending', 'processing')
    ) THEN
      CONTINUE; -- dedup: ya hay un job pendiente para esta propiedad+operación
    END IF;
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
