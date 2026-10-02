-- RPC aditiva para el portal del propietario (ronda 4 de mejoras).
-- NO modifica portal_get_portal_data; agrega portal_get_extra_data con:
--   * próximas visitas (todas, no solo la siguiente)
--   * historial de visitas pasadas con resultado
--   * leads por semana (últimas 12 semanas) para sparkline
--   * visitas por semana (últimas 12 semanas)
-- Misma seguridad que la original: SECURITY DEFINER, token validado, solo lectura.

CREATE OR REPLACE FUNCTION public.portal_get_extra_data(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_token         public.owner_portal_tokens%ROWTYPE;
  v_owner_id      uuid;
  v_upcoming      jsonb := '[]'::jsonb;
  v_history       jsonb := '[]'::jsonb;
  v_weekly_leads  jsonb := '[]'::jsonb;
  v_weekly_visits jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_token FROM public.owner_portal_tokens t WHERE t.token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_token.revoked_at IS NOT NULL THEN RETURN NULL; END IF;
  IF v_token.expires_at IS NOT NULL AND v_token.expires_at < now() THEN RETURN NULL; END IF;
  v_owner_id := v_token.owner_id;

  SELECT COALESCE(jsonb_agg(v.js ORDER BY (v.js->>'visit_date') ASC), '[]'::jsonb)
    INTO v_upcoming
    FROM (
      SELECT jsonb_build_object(
        'visit_date', vs.visit_date,
        'client_name', vs.client_name,
        'status', vs.status,
        'confirmed', vs.confirmed_at IS NOT NULL,
        'property_code', p.property_code,
        'property_title', p.title,
        'property_id', p.id
      ) AS js
        FROM public.visits vs
        JOIN public.properties p ON p.id = vs.property_id
       WHERE p.owner_id = v_owner_id
         AND p.deleted_at IS NULL
         AND vs.deleted_at IS NULL
         AND vs.visit_date >= now()
         AND vs.status IN ('pendiente', 'confirmada')
       ORDER BY vs.visit_date ASC
       LIMIT 10
    ) v;

  SELECT COALESCE(jsonb_agg(v.js ORDER BY (v.js->>'visit_date') DESC), '[]'::jsonb)
    INTO v_history
    FROM (
      SELECT jsonb_build_object(
        'visit_date', vs.visit_date,
        'client_name', vs.client_name,
        'status', vs.status,
        'notes', vs.notes,
        'cancel_reason', vs.cancel_reason,
        'duration_minutes', vs.duration_minutes,
        'property_code', p.property_code,
        'property_title', p.title,
        'property_id', p.id
      ) AS js
        FROM public.visits vs
        JOIN public.properties p ON p.id = vs.property_id
       WHERE p.owner_id = v_owner_id
         AND p.deleted_at IS NULL
         AND vs.deleted_at IS NULL
         AND vs.visit_date < now()
       ORDER BY vs.visit_date DESC
       LIMIT 15
    ) v;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('week', s.week_start, 'count', s.cnt) ORDER BY s.week_start), '[]'::jsonb)
    INTO v_weekly_leads
    FROM (
      SELECT date_trunc('week', l.created_at)::date AS week_start, COUNT(DISTINCT l.id) AS cnt
        FROM public.leads l
        JOIN public.properties p
          ON p.owner_id = v_owner_id
         AND p.deleted_at IS NULL
         AND (l.property_id = p.id
              OR EXISTS (SELECT 1 FROM public.lead_properties lp WHERE lp.lead_id = l.id AND lp.property_id = p.id))
       WHERE l.created_at >= now() - interval '12 weeks'
       GROUP BY 1
    ) s;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('week', s.week_start, 'count', s.cnt) ORDER BY s.week_start), '[]'::jsonb)
    INTO v_weekly_visits
    FROM (
      SELECT date_trunc('week', vs.visit_date)::date AS week_start, COUNT(*) AS cnt
        FROM public.visits vs
        JOIN public.properties p ON p.id = vs.property_id
       WHERE p.owner_id = v_owner_id
         AND p.deleted_at IS NULL
         AND vs.deleted_at IS NULL
         AND vs.visit_date >= now() - interval '12 weeks'
       GROUP BY 1
    ) s;

  RETURN jsonb_build_object(
    'upcoming_visits', v_upcoming,
    'visit_history', v_history,
    'weekly_leads', v_weekly_leads,
    'weekly_visits', v_weekly_visits
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.portal_get_extra_data(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_get_extra_data(text) TO anon, authenticated;
