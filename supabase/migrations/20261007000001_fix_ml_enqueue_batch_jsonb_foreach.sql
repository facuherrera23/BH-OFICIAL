-- ml_enqueue_batch jamás funcionó: FOREACH ... IN ARRAY exige un tipo array de
-- SQL y p_jobs es jsonb (ERROR 42804). Se itera con jsonb_array_elements y se
-- acumulan los ids con array_append (el RETURNING INTO directo al array también
-- era incorrecto). Mantiene SECURITY DEFINER + search_path fijo (convención repo).
CREATE OR REPLACE FUNCTION public.ml_enqueue_batch(p_jobs jsonb)
RETURNS bigint[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_job JSONB;
  v_queue_ids BIGINT[] := '{}';
  v_id BIGINT;
BEGIN
  FOR v_job IN SELECT jsonb_array_elements(p_jobs) LOOP
    INSERT INTO public.ml_sync_queue (property_id, operation, ml_item_id, max_attempts, payload)
    VALUES (
      (v_job->>'property_id')::UUID,
      (v_job->>'operation')::ml_sync_operation,
      NULLIF(v_job->>'ml_item_id', '')::TEXT,
      COALESCE((v_job->>'max_attempts')::INT, 5),
      v_job->'payload'
    )
    RETURNING id INTO v_id;
    v_queue_ids := array_append(v_queue_ids, v_id);
  END LOOP;
  RETURN v_queue_ids;
END;
$function$;
