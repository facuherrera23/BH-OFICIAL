-- Encuesta de visita: un link archivado deja de abrir y de grabar (2026-11-25).
-- Aditiva: sólo CREATE OR REPLACE FUNCTION, sin UPDATE/DELETE en visit_surveys.
--
-- Antes: el botón "Reiniciar" archivaba la encuesta y generaba un token nuevo,
-- pero survey_get_by_token y survey_submit_by_token NO miraban archived_at.
-- El link viejo (el que ya se envió por WhatsApp) seguía abriendo el formulario
-- y escribiendo en la fila archivada. Ahora devuelve "no disponible".
--
-- No cambia permisos: ambas funciones ya existen, siguen siendo SECURITY
-- DEFINER con search_path fijo y EXECUTE a anon (las llama la página pública).

CREATE OR REPLACE FUNCTION public.survey_get_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  rec public.visit_surveys%ROWTYPE;
  l   public.leads%ROWTYPE;
  p   public.properties%ROWTYPE;
BEGIN
  BEGIN
    SELECT * INTO rec FROM public.visit_surveys WHERE token::text = p_token LIMIT 1;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('available', false);
  END;
  IF NOT FOUND THEN RETURN jsonb_build_object('available', false); END IF;

  -- Encuesta reiniciada: el link anterior se trata como inválido/expirado.
  IF rec.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('available', false);
  END IF;

  SELECT * INTO l FROM public.leads WHERE id = rec.lead_id;
  SELECT * INTO p FROM public.properties WHERE id = rec.property_id;

  IF (l.id IS NULL) OR (p.id IS NULL) OR l.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('available', false);
  END IF;

  RETURN jsonb_build_object(
    'available', true,
    'property', jsonb_build_object(
      'title', p.title,
      'zone', p.zone,
      'address', p.address,
      'property_code', p.property_code
    ),
    'client_first_name', split_part(coalesce(l.full_name, ''), ' ', 1),
    'survey', jsonb_build_object(
      'answers', rec.answers,
      'finalized', rec.finalized,
      'submitted_at', rec.submitted_at
    )
  );
END;
$function$;

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
      || Case When v_clean ? 'por_que' THEN ' · Por qué: ' || left(v_clean->>'por_que', 300) ELSE '' END;
    INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
    VALUES (rec.lead_id, 'note',
            'Encuesta de visita recibida' || CASE WHEN p.property_code IS NOT NULL THEN ' — ' || p.property_code ELSE '' END,
            v_desc);
  END IF;

  RETURN jsonb_build_object('ok', true, 'finalized', p_finalize);
END;
$function$;
