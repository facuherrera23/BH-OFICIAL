-- Portal Propietario: Mercado Libre + badges oportunidad/retasada + timeline
-- Agrega ml_item_id/ml_status/ml_last_sync (último listing por last_sync DESC)
-- e is_oportunidad/is_retasada a la RPC portal_get_portal_data.

CREATE OR REPLACE FUNCTION public.portal_get_portal_data(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_token        public.owner_portal_tokens%ROWTYPE;
  v_owner        jsonb;
  v_properties   jsonb := '[]'::jsonb;
  v_leads_src    jsonb := '[]'::jsonb;
  v_lead_total   integer := 0;
  v_lead_30d     integer := 0;
  v_visits       jsonb;
  v_usd_rate     numeric;
BEGIN
  SELECT * INTO v_token FROM public.owner_portal_tokens t WHERE t.token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_token.revoked_at IS NOT NULL THEN RETURN NULL; END IF;
  IF v_token.expires_at IS NOT NULL AND v_token.expires_at < now() THEN RETURN NULL; END IF;

  SELECT jsonb_build_object(
           'id', o.id, 'full_name', o.full_name, 'email', o.email, 'phone', o.phone,
           'dni_cuit', o.dni_cuit, 'preferred_contact', o.preferred_contact,
           'exclusive', o.exclusive, 'exclusive_start', o.exclusive_start, 'exclusive_end', o.exclusive_end,
           'commission_sale', o.commission_sale, 'commission_rent', o.commission_rent,
           'commission_split', o.commission_split, 'contract_notes', o.contract_notes
         ) INTO v_owner FROM public.owners o WHERE o.id = v_token.owner_id;
  IF v_owner IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(jsonb_agg(t.js), '[]'::jsonb) INTO v_properties
    FROM (
      SELECT jsonb_build_object(
               'id', p.id, 'property_code', p.property_code, 'title', p.title, 'zone', p.zone, 'address', p.address,
               'property_type', p.property_type::text, 'status', p.status::text, 'price_usd', p.price_usd, 'price_currency', p.price_currency,
               'is_published', p.is_published, 'featured', p.featured, 'is_oportunidad', p.is_oportunidad, 'is_retasada', p.is_retasada,
               'area_total', p.surface_total, 'area_covered', p.surface_covered, 'area_m2', p.area_m2,
               'rooms', p.rooms, 'bedrooms', p.bedrooms, 'bathrooms', p.bathrooms, 'garage_spaces', p.garage_spaces,
               'image_urls', COALESCE(to_jsonb(p.image_urls), '[]'::jsonb), 'video_url', p.video_url,
               'created_at', p.created_at, 'updated_at', p.updated_at,
               'ml_item_id', ml.ml_item_id, 'ml_status', ml.ml_status, 'ml_last_sync', ml.last_sync,
               'leads_total', COALESCE(st.leads_total, 0), 'leads_30d', COALESCE(st.leads_30d, 0),
               'visits_total', COALESCE(st.visits_total, 0), 'visits_done', COALESCE(st.visits_done, 0), 'visits_next', COALESCE(st.visits_next, 0),
               'last_lead_at', st.last_lead_at, 'last_visit_at', st.last_visit_at
             ) AS js
        FROM public.properties p
        LEFT JOIN LATERAL (
          SELECT
            (SELECT COUNT(*) FROM public.leads l WHERE l.property_id = p.id) AS leads_total,
            (SELECT COUNT(*) FROM public.leads l WHERE l.property_id = p.id AND l.created_at >= now() - interval '30 days') AS leads_30d,
            (SELECT COUNT(*) FROM public.visits v WHERE v.property_id = p.id) AS visits_total,
            (SELECT COUNT(*) FROM public.visits v WHERE v.property_id = p.id AND v.status = 'completada') AS visits_done,
            (SELECT COUNT(*) FROM public.visits v WHERE v.property_id = p.id AND v.visit_date >= now() AND v.status IN ('pendiente','confirmada')) AS visits_next,
            (SELECT MAX(l.created_at) FROM public.leads l WHERE l.property_id = p.id) AS last_lead_at,
            (SELECT MAX(v.visit_date) FROM public.visits v WHERE v.property_id = p.id AND v.status = 'completada') AS last_visit_at
        ) st ON TRUE
        LEFT JOIN LATERAL (
          SELECT m.ml_item_id, m.ml_status, m.last_sync FROM public.ml_listings m
          WHERE m.property_id = p.id ORDER BY m.last_sync DESC NULLS LAST LIMIT 1
        ) ml ON TRUE
       WHERE p.owner_id = v_token.owner_id AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC
    ) t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('source', s.source, 'count', s.cnt) ORDER BY s.cnt DESC), '[]'::jsonb) INTO v_leads_src
    FROM (SELECT lower(COALESCE(l.source, 'otro')) AS source, COUNT(*) AS cnt
          FROM public.leads l JOIN public.properties p ON p.id = l.property_id
          WHERE p.owner_id = v_token.owner_id GROUP BY 1) s;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE l.created_at >= now() - interval '30 days') INTO v_lead_total, v_lead_30d
    FROM public.leads l JOIN public.properties p ON p.id = l.property_id WHERE p.owner_id = v_token.owner_id;

  SELECT jsonb_build_object(
           'total', COUNT(*),
           'pendientes', COUNT(*) FILTER (WHERE v.status = 'pendiente'),
           'confirmadas', COUNT(*) FILTER (WHERE v.status = 'confirmada'),
           'completadas', COUNT(*) FILTER (WHERE v.status = 'completada'),
           'canceladas', COUNT(*) FILTER (WHERE v.status = 'cancelada'),
           'proximas', COUNT(*) FILTER (WHERE v.visit_date >= now() AND v.status IN ('pendiente','confirmada'))
         ) INTO v_visits
    FROM public.visits v JOIN public.properties p ON p.id = v.property_id WHERE p.owner_id = v_token.owner_id;

  SELECT NULLIF(s.value->>'usd_rate', '')::numeric INTO v_usd_rate FROM public.app_settings s WHERE s.key = 'preferences' LIMIT 1;

  RETURN jsonb_build_object(
    'owner', v_owner, 'properties', v_properties,
    'leads_by_source', v_leads_src, 'lead_total', v_lead_total, 'lead_last30', v_lead_30d,
    'visits', COALESCE(v_visits, '{}'::jsonb), 'usd_rate', COALESCE(v_usd_rate, 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.portal_get_portal_data(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_get_portal_data(text) TO anon, authenticated;
