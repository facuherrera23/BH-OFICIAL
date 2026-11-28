-- ============================================
-- 20261128000016 — Score de encuesta en el lead
-- ============================================
-- Hallazgo real (28/11/2026): de 10 encuestas, 0 finalizadas y 0 respondidas.
-- Ya existen la nota de parcial (20261125000003) y la nota de cierre a los 7
-- días (20261128000012), pero ninguna deja el SCORE: el agente abre el lead y
-- ve el texto, pero no tiene un número para priorizar el feedback.
--
-- Fix: el mismo promedio de los 5 sliders que muestra la encuesta se escribe
-- en `lead_activities.description` (no en una columna nueva) al finalizar, al
-- autoguardar y al cerrar sin respuesta. NO se tocan las keys de `answers` —
-- `survey_submit_by_token` valida un full-set y esto quebraría si inventáramos
-- una key `score`. Firmas idénticas: no crea sobrecargas.
-- ============================================

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
  v_score  integer;
  v_score_txt text;
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

  /* Score = promedio de los 5 sliders, exactamente las mismas keys que el
     front guarda. Se lee de `v_merged`, NUNCA se escribe en `answers`. */
  SELECT round(avg((v_merged ->> s.k)::numeric))::int INTO v_score
    FROM unnest(ARRAY['ubicacion','superficie','distribucion','conservacion','general']) AS s(k)
   WHERE v_merged ? s.k AND (v_merged ->> s.k) ~ '^[0-9]+$';
  v_score_txt := CASE WHEN v_score IS NULL THEN 'Score: sin datos'
    ELSE 'Score: ' || v_score || '/10 (Ubicación ' || coalesce(v_merged->>'ubicacion', '—')
      || ', Superficie ' || coalesce(v_merged->>'superficie', '—')
      || ', Distribución ' || coalesce(v_merged->>'distribucion', '—')
      || ', Conservación ' || coalesce(v_merged->>'conservacion', '—')
      || ', General ' || coalesce(v_merged->>'general', '—') || ')' END;

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
            v_desc || ' · ' || v_score_txt
              || ' · Autoguardado: el visitante todavía no apretó "Enviar". Encuesta ' || rec.id::text);
    v_note := true;
  END IF;

  IF p_finalize THEN
    INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
    VALUES (rec.lead_id, 'note',
            'Encuesta de visita recibida' || CASE WHEN p.property_code IS NOT NULL THEN ' — ' || p.property_code ELSE '' END,
            v_desc || ' · ' || v_score_txt || ' · Encuesta ' || rec.id::text);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'finalized', p_finalize,
    'answer_count', v_count,
    'partial_note', v_note,
    'score', v_score
  );
END;
$function$;

-- El cierre automático a los 7 días también deja el score (o "sin respuesta"
-- si el visitante no cargó ningún slider). Sin escribir en `answers`.
CREATE OR REPLACE FUNCTION public.survey_pending_reminders(p_dry_run boolean DEFAULT false)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  r record;
  v_edad interval;
  v_nr integer;
  v_n integer := 0;
  v_token text;
  v_prop text;
  v_score integer;
  v_score_txt text;
BEGIN
  FOR r IN
    SELECT vs.id AS survey_id, vs.lead_id, vs.property_id, vs.token,
           vs.created_at, vs.answers,
           l.assigned_to, p.property_code
      FROM public.visit_surveys vs
      JOIN public.leads l ON l.id = vs.lead_id
      LEFT JOIN public.properties p ON p.id = vs.property_id
     WHERE vs.finalized = false
       AND vs.archived_at IS NULL
       AND vs.created_at < now() - interval '48 hours'
       AND l.deleted_at IS NULL
     ORDER BY vs.created_at ASC
  LOOP
    SELECT count(*) INTO v_nr
      FROM public.lead_tasks t
     WHERE t.lead_id = r.lead_id
       AND t.title LIKE 'Encuesta sin responder%'
       AND t.created_at >= r.created_at;

    v_edad := now() - r.created_at;
    v_token := r.token::text;
    v_prop := COALESCE(r.property_code, 'la propiedad');

    IF v_nr = 0 AND v_edad >= interval '48 hours' THEN
      IF NOT COALESCE(p_dry_run, false) THEN
        INSERT INTO public.lead_tasks (
          lead_id, type, contact_type, title, description, priority, status,
          due_at, assigned_to, remind_before_minutes, created_at, updated_at
        ) VALUES (
          r.lead_id, 'contact', 'whatsapp',
          'Encuesta sin responder — ' || v_prop,
          '[recordatorio:1] Reenviar el link: https://bienenhaus.com.ar/encuesta.html?token=' || v_token,
          'media', 'pendiente', now() + interval '24 hours', r.assigned_to, 1440, now(), now()
        );
      END IF;
      v_n := v_n + 1;

    ELSIF v_nr = 1 AND v_edad >= interval '96 hours' THEN
      IF NOT COALESCE(p_dry_run, false) THEN
        INSERT INTO public.lead_tasks (
          lead_id, type, contact_type, title, description, priority, status,
          due_at, assigned_to, remind_before_minutes, created_at, updated_at
        ) VALUES (
          r.lead_id, 'contact', 'whatsapp',
          'Encuesta sin responder (2° recordatorio) — ' || v_prop,
          '[recordatorio:2] Último reenvío del link: https://bienenhaus.com.ar/encuesta.html?token=' || v_token,
          'alta', 'pendiente', now() + interval '24 hours', r.assigned_to, 1440, now(), now()
        );
      END IF;
      v_n := v_n + 1;

    ELSIF v_nr >= 2 AND v_edad >= interval '7 days' THEN
      IF NOT COALESCE(p_dry_run, false) THEN
        UPDATE public.visit_surveys
           SET finalized = true, updated_at = now()
         WHERE id = r.survey_id;

        UPDATE public.lead_tasks
           SET status = 'completada', completed_at = now(), completed_note = 'Encuesta cerrada sin respuesta', updated_at = now()
         WHERE lead_id = r.lead_id
           AND title LIKE 'Encuesta sin responder%'
           AND status IN ('pendiente', 'en_progreso');

        SELECT round(avg((r.answers ->> s.k)::numeric))::int INTO v_score
          FROM unnest(ARRAY['ubicacion','superficie','distribucion','conservacion','general']) AS s(k)
         WHERE jsonb_typeof(r.answers) = 'object'
           AND r.answers ? s.k
           AND (r.answers ->> s.k) ~ '^[0-9]+$';
        v_score_txt := CASE WHEN v_score IS NULL THEN 'sin respuesta'
          ELSE v_score::text || '/10 (parcial)' END;

        IF NOT EXISTS (
          SELECT 1 FROM public.lead_activities la
           WHERE la.lead_id = r.lead_id
             AND la.title = 'Encuesta cerrada sin respuesta'
             AND la.created_at > r.created_at
        ) THEN
          INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
          VALUES (
            r.lead_id, 'note', 'Encuesta cerrada sin respuesta',
            'Se enviaron 2 recordatorios para ' || v_prop
              || ' sin respuesta. La encuesta se cerró automáticamente. Score: ' || v_score_txt
          );
        END IF;
      END IF;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$function$;

-- Permisos intactos: survey_submit_by_token (anon/authenticated/service_role)
-- y survey_pending_reminders (sólo service_role). Firmas sin cambios.
