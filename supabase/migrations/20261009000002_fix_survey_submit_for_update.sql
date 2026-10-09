-- Fix de carrera en survey_submit_by_token (pedido de auditoría 2026-10-09):
-- SELECT ... FOR UPDATE para que dos submits concurrentes (doble-tap + retry de red)
-- no inserten dos notas "Encuesta de visita recibida" en el historial del lead.
-- El segundo llamado espera el lock, relee el estado committeado (READ COMMITTED)
-- y recibe 'ya respondida'. Aplicada a producción como fix_survey_submit_for_update.

CREATE OR REPLACE FUNCTION public.survey_submit_by_token(p_token text, p_answers jsonb, p_finalize boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $func$
DECLARE
  rec      public.visit_surveys%ROWTYPE;
  p        public.properties%ROWTYPE;
  v_clean  jsonb := '{}'::jsonb;
  v_num    numeric;
  v_txt    text;
  k        text;
  v_desc   text;
BEGIN
  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'respuestas inválidas');
  END IF;

  BEGIN
    SELECT * INTO rec FROM public.visit_surveys WHERE token::text = p_token LIMIT 1 FOR UPDATE;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'token inválido');
  END;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'token inválido');
  END IF;

  IF EXISTS (SELECT 1 FROM public.leads WHERE id = rec.lead_id AND deleted_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.properties WHERE id = rec.property_id AND deleted_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'encuesta no disponible');
  END IF;

  IF rec.finalized THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ya respondida', 'finalized', true);
  END IF;

  FOREACH k IN ARRAY ARRAY['ubicacion','tamano','distribucion','calidad','precio','conservacion','general']
  LOOP
    IF p_answers ? k THEN
      BEGIN
        v_num := (p_answers ->> k)::numeric;
      EXCEPTION WHEN others THEN
        v_num := NULL;
      END;
      IF v_num BETWEEN 1 AND 10 AND v_num = floor(v_num) THEN
        v_clean := v_clean || jsonb_build_object(k, v_num::int);
      END IF;
    END IF;
  END LOOP;

  IF p_answers ->> 'compraria' IN ('si','no','quizas') THEN
    v_clean := v_clean || jsonb_build_object('compraria', p_answers ->> 'compraria');
  END IF;

  FOREACH k IN ARRAY ARRAY['mas_gusto','menos_gusto','por_que']
  LOOP
    IF p_answers ? k AND p_answers ->> k IS NOT NULL THEN
      v_txt := left(btrim(coalesce(p_answers ->> k, '')), 1000);
      v_clean := v_clean || jsonb_build_object(k, v_txt);
    END IF;
  END LOOP;

  UPDATE public.visit_surveys
     SET answers = v_clean,
         finalized = p_finalize,
         submitted_at = CASE WHEN p_finalize THEN now() ELSE submitted_at END,
         updated_at = now()
   WHERE id = rec.id;

  IF p_finalize THEN
    SELECT * INTO p FROM public.properties WHERE id = rec.property_id;
    v_desc := 'General: ' || coalesce(v_clean->>'general', '—') || '/10'
      || ' · Compraría: ' || CASE v_clean->>'compraria'
           WHEN 'si' THEN 'Sí' WHEN 'no' THEN 'No' WHEN 'quizas' THEN 'Quizás' ELSE '—' END
      || CASE WHEN v_clean ? 'mas_gusto' THEN ' · Le gustó: ' || left(v_clean->>'mas_gusto', 300) ELSE '' END
      || CASE WHEN v_clean ? 'menos_gusto' THEN ' · No le gustó: ' || left(v_clean->>'menos_gusto', 300) ELSE '' END
      || CASE WHEN v_clean ? 'por_que' THEN ' · Por qué: ' || left(v_clean->>'por_que', 300) ELSE '' END;
    INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
    VALUES (rec.lead_id, 'note',
            'Encuesta de visita recibida' || CASE WHEN p.property_code IS NOT NULL THEN ' — ' || p.property_code ELSE '' END,
            v_desc);
  END IF;

  RETURN jsonb_build_object('ok', true, 'finalized', p_finalize);
END;
$func$;

REVOKE ALL ON FUNCTION public.survey_submit_by_token(text, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.survey_submit_by_token(text, jsonb, boolean) TO anon, authenticated, service_role;
