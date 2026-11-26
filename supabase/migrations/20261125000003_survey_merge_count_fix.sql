-- CORRECTIVA de 20261125000002 (2026-11-25).
-- La migración 0002 usaba jsonb_object_length(), que NO existe en la versión de
-- Postgres de este proyecto (42883 al ejecutar el RPC). `CREATE OR REPLACE`
-- aceptó el cuerpo pero la función habría fallado en el primer autoguardado.
-- Esta migración redefine el MISMO RPC contando las claves con
-- `count(*) FROM jsonb_object_keys(...)`, disponible en todas las versiones.
-- Aditiva: sólo CREATE OR REPLACE FUNCTION, sin tocar datos ni permisos.

CREATE OR REPLACE FUNCTION public.survey_submit_by_token(p_token text, p_answers jsonb, p_finalize boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  rec      public.visit_surveys%ROWTYPE;
  p        public.properties%ROWTYPE;
  v_clean  jsonb := '{}'::jsonb;
  v_base   jsonb := '{}'::jsonb;
  v_merged jsonb := '{}'::jsonb;
  v_num    numeric;
  v_txt    text;
  k        text;
  v_desc   text;
  v_note   boolean := false;
  v_incoming integer := 0;
  v_count  integer := 0;
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

  -- Encuesta reiniciada: ni autoguardado ni envío pueden escribir en ella.
  IF rec.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'encuesta archivada');
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

  v_incoming := (SELECT count(*) FROM jsonb_object_keys(v_clean));

  -- Red de seguridad: si por datos viejos answers no fuera un objeto, se parte
  -- de vacío en vez de fallar con un error de jsonb.
  IF jsonb_typeof(rec.answers) = 'object' THEN
    v_base := rec.answers;
  END IF;
  v_merged := v_base || v_clean;
  v_count := (SELECT count(*) FROM jsonb_object_keys(v_merged));

  UPDATE public.visit_surveys
     SET answers = v_merged,
         finalized = p_finalize,
         submitted_at = CASE WHEN p_finalize THEN now() ELSE submitted_at END,
         updated_at = now()
   WHERE id = rec.id;

  SELECT * INTO p FROM public.properties WHERE id = rec.property_id;
  v_desc := 'General: ' || coalesce(v_merged->>'general', '—') || '/10'
    || ' · Compraría: ' || CASE v_merged->>'compraria'
         WHEN 'si' THEN 'Sí' WHEN 'no' THEN 'No' ELSE '—' END
    || CASE WHEN v_merged ? 'mas_gusto' THEN ' · Le gustó: ' || left(v_merged->>'mas_gusto', 300) ELSE '' END
    || CASE WHEN v_merged ? 'menos_gusto' THEN ' · No le gustó: ' || left(v_merged->>'menos_gusto', 300) ELSE '' END
    || CASE WHEN v_merged ? 'por_que' THEN ' · Por qué: ' || left(v_merged->>'por_que', 300) ELSE '' END;

  -- Parcial: avisa una sola vez por encuesta. El id del survey en la descripción
  -- evita confundir dos encuestas distintas del mismo lead/propiedad.
  IF NOT p_finalize AND v_incoming > 0 AND NOT EXISTS (
       SELECT 1 FROM public.lead_activities
        WHERE lead_id = rec.lead_id
          AND activity_type = 'note'
          AND title LIKE 'Encuesta de visita recibida (parcial)%'
          AND description LIKE '%' || rec.id::text || '%'
     ) THEN
    INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
    VALUES (rec.lead_id, 'note',
            'Encuesta de visita recibida (parcial)' || CASE WHEN p.property_code IS NOT NULL THEN ' — ' || p.property_code ELSE '' END,
            v_desc || ' · Autoguardado: el visitante todavía no apretó "Enviar". Encuesta ' || rec.id::text);
    v_note := true;
  END IF;

  IF p_finalize THEN
    INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
    VALUES (rec.lead_id, 'note',
            'Encuesta de visita recibida' || CASE WHEN p.property_code IS NOT NULL THEN ' — ' || p.property_code ELSE '' END,
            v_desc || ' · Encuesta ' || rec.id::text);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'finalized', p_finalize,
    'answer_count', v_count,
    'partial_note', v_note
  );
END;
$function$;
