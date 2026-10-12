-- ============================================================
-- Encuesta de visita: nuevas preguntas (2026-10-12, pedido del dueño)
-- ============================================================
-- Sliders: Ubicación, Superficie, Distribución, Estado Conservación,
-- Valoración general (se quitan Tamaño, Calidad, Precio; la key sigue
-- siendo `conservacion` — solo cambia el label en la UI).
-- `compraria`: solo Sí/No (se quita Quizás del enum de entrada).
-- Los displays (portal y CRM) mantienen los labels viejos para que las
-- encuestas respondidas con el set anterior se sigan viendo completas.
-- Se preservan los atributos: SECURITY DEFINER, search_path='', FOR UPDATE,
-- DEFAULT del parámetro, grants a anon + authenticated + service_role.
-- Aplicada vía MCP el 2026-10-12 (registro manual en el repo).

CREATE OR REPLACE FUNCTION public.survey_submit_by_token(p_token text, p_answers jsonb, p_finalize boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

  FOREACH k IN ARRAY ARRAY['ubicacion','superficie','distribucion','conservacion','general']
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

  IF p_answers ->> 'compraria' IN ('si','no') THEN
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
           WHEN 'si' THEN 'Sí' WHEN 'no' THEN 'No' ELSE '—' END
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
