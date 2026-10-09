-- Encuesta de visita ("HOJA DE VISITA" digital) — v2, pedido del dueño 2026-10-09.
-- Aplicada en producción como versión 20261009002903 (supabase migration list).
-- Link por WhatsApp al visitante (desde el panel del lead), opiniones sobre la propiedad,
-- resultados anónimos en el portal del propietario. 1 encuesta por (lead, propiedad):
-- el token queda registrado y se reusa al reenviar; se cierra al finalizar.
-- La primera versión (20261008) se revirtió completa: esta va con página propia.

CREATE TABLE IF NOT EXISTS public.visit_surveys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  finalized boolean NOT NULL DEFAULT false,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.visit_surveys IS 'Encuesta de visita (HOJA DE VISITA). 1 por (lead, propiedad). El visitante escribe solo vía survey_submit_by_token (token); el equipo lee vía RLS; el portal del propietario ve resultados anónimos vía portal_get_surveys.';

CREATE UNIQUE INDEX IF NOT EXISTS visit_surveys_lead_property_uq
  ON public.visit_surveys (lead_id, property_id);

ALTER TABLE public.visit_surveys ENABLE ROW LEVEL SECURITY;

-- Lectura del equipo: consistente con leads/lead_activities (SELECT abierto a authenticated).
CREATE POLICY visit_surveys_select ON public.visit_surveys
  FOR SELECT TO authenticated
  USING (true);

-- Creación del link: solo el agente asignado/creador del lead o super_admin
-- (mismo criterio que lead_activities_insert).
CREATE POLICY visit_surveys_insert ON public.visit_surveys
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p
             WHERE p.id = auth.uid() AND p.role = 'super_admin'::user_role)
    OR EXISTS (SELECT 1 FROM public.leads l
                JOIN public.agents a ON a.profile_id = auth.uid()
               WHERE l.id = visit_surveys.lead_id
                 AND (l.assigned_to = a.id OR l.created_by = a.id))
  );

-- Sin policies de UPDATE/DELETE: nadie escribe filas directo desde el cliente;
-- el visitante pasa por survey_submit_by_token, que es SECURITY DEFINER.

-- ── Lectura pública por token (página encuesta.html) ──
CREATE OR REPLACE FUNCTION public.survey_get_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $func$
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
$func$;

-- ── Escritura pública por token: autoguardado continuo + Enviar final ──
-- Sanitiza todo: notas 1-10 enteras, compraria si/no/quizas, textos de máx 1000 chars.
-- Si ya finalizó, no se edita más. Al finalizar deja resumen en el historial del lead.
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
    SELECT * INTO rec FROM public.visit_surveys WHERE token::text = p_token LIMIT 1;
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

-- ── Portal del propietario: encuestas finalizadas de sus propiedades (anónimas) ──
-- Nunca expone datos del visitante: solo propiedad + respuestas.
CREATE OR REPLACE FUNCTION public.portal_get_surveys(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $func$
DECLARE
  tok public.owner_portal_tokens%ROWTYPE;
BEGIN
  SELECT * INTO tok FROM public.owner_portal_tokens WHERE token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF tok.revoked_at IS NOT NULL THEN RETURN NULL; END IF;
  IF tok.expires_at IS NOT NULL AND tok.expires_at < now() THEN RETURN NULL; END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'property_id', p.id,
             'property_code', p.property_code,
             'property_title', p.title,
             'zone', p.zone,
             'submitted_at', s.submitted_at,
             'answers', s.answers
           ) ORDER BY s.submitted_at DESC)
      FROM public.visit_surveys s
      JOIN public.properties p ON p.id = s.property_id
      JOIN public.leads l ON l.id = s.lead_id
     WHERE p.owner_id = tok.owner_id
       AND p.deleted_at IS NULL
       AND l.deleted_at IS NULL
       AND s.finalized = true
  ), '[]'::jsonb);
END;
$func$;

-- Hardening estándar del proyecto (mismo patrón que get_visit_by_token):
REVOKE ALL ON FUNCTION public.survey_get_by_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.survey_submit_by_token(text, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portal_get_surveys(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.survey_get_by_token(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.survey_submit_by_token(text, jsonb, boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.portal_get_surveys(text) TO anon, authenticated, service_role;
