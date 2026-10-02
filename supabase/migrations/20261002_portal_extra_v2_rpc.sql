-- Ronda 5: extiende portal_get_extra_data con documentos, finanzas, tasaciones,
-- zona promedio, tasks, timeline, historial de precios, log de accesos.

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
  v_documents     jsonb := '[]'::jsonb;
  v_requirements  jsonb := '[]'::jsonb;
  v_commissions   jsonb := '[]'::jsonb;
  v_liquidations  jsonb := '[]'::jsonb;
  v_payments      jsonb := '[]'::jsonb;
  v_tasaciones    jsonb := '[]'::jsonb;
  v_zone_avg      jsonb := '{}'::jsonb;
  v_tasks         jsonb := '[]'::jsonb;
  v_timeline      jsonb := '[]'::jsonb;
  v_price_hist    jsonb := '[]'::jsonb;
  v_access_log    jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_token FROM public.owner_portal_tokens t WHERE t.token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_token.revoked_at IS NOT NULL THEN RETURN NULL; END IF;
  IF v_token.expires_at IS NOT NULL AND v_token.expires_at < now() THEN RETURN NULL; END IF;
  v_owner_id := v_token.owner_id;

  SELECT COALESCE(jsonb_agg(v.js ORDER BY (v.js->>'visit_date') ASC), '[]'::jsonb) INTO v_upcoming
    FROM (
      SELECT jsonb_build_object(
        'visit_date', vs.visit_date, 'client_name', vs.client_name, 'status', vs.status,
        'confirmed', vs.confirmed_at IS NOT NULL,
        'property_code', p.property_code, 'property_title', p.title, 'property_id', p.id
      ) AS js FROM public.visits vs JOIN public.properties p ON p.id = vs.property_id
       WHERE p.owner_id = v_owner_id AND p.deleted_at IS NULL AND vs.deleted_at IS NULL
         AND vs.visit_date >= now() AND vs.status IN ('pendiente', 'confirmada')
       ORDER BY vs.visit_date ASC LIMIT 10
    ) v;

  SELECT COALESCE(jsonb_agg(v.js ORDER BY (v.js->>'visit_date') DESC), '[]'::jsonb) INTO v_history
    FROM (
      SELECT jsonb_build_object(
        'visit_date', vs.visit_date, 'client_name', vs.client_name, 'status', vs.status,
        'notes', vs.notes, 'cancel_reason', vs.cancel_reason, 'duration_minutes', vs.duration_minutes,
        'property_code', p.property_code, 'property_title', p.title, 'property_id', p.id
      ) AS js FROM public.visits vs JOIN public.properties p ON p.id = vs.property_id
       WHERE p.owner_id = v_owner_id AND p.deleted_at IS NULL AND vs.deleted_at IS NULL AND vs.visit_date < now()
       ORDER BY vs.visit_date DESC LIMIT 15
    ) v;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('week', s.week_start, 'count', s.cnt) ORDER BY s.week_start), '[]'::jsonb)
    INTO v_weekly_leads
    FROM (
      SELECT date_trunc('week', l.created_at)::date AS week_start, COUNT(DISTINCT l.id) AS cnt
        FROM public.leads l JOIN public.properties p ON p.owner_id = v_owner_id AND p.deleted_at IS NULL
           AND (l.property_id = p.id OR EXISTS (SELECT 1 FROM public.lead_properties lp WHERE lp.lead_id = l.id AND lp.property_id = p.id))
       WHERE l.created_at >= now() - interval '12 weeks' GROUP BY 1
    ) s;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('week', s.week_start, 'count', s.cnt) ORDER BY s.week_start), '[]'::jsonb)
    INTO v_weekly_visits
    FROM (
      SELECT date_trunc('week', vs.visit_date)::date AS week_start, COUNT(*) AS cnt
        FROM public.visits vs JOIN public.properties p ON p.id = vs.property_id
       WHERE p.owner_id = v_owner_id AND p.deleted_at IS NULL AND vs.deleted_at IS NULL
         AND vs.visit_date >= now() - interval '12 weeks' GROUP BY 1
    ) s;

  SELECT COALESCE(jsonb_agg(d.js ORDER BY (d.js->>'prop_code')), '[]'::jsonb) INTO v_documents
    FROM (
      SELECT jsonb_build_object(
        'prop_code', p.property_code, 'prop_id', p.id, 'prop_title', p.title,
        'documents', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', pd.name, 'type', pd.type, 'storage_path', pd.storage_path, 'uploaded_at', pd.uploaded_at, 'document_key', pd.document_key) ORDER BY pd.uploaded_at DESC) FROM public.property_documents pd WHERE pd.property_id = p.id), '[]'::jsonb)
      ) AS js FROM public.properties p WHERE p.owner_id = v_owner_id AND p.deleted_at IS NULL ORDER BY p.created_at
    ) d;

  SELECT COALESCE(jsonb_agg(r.js ORDER BY (r.js->>'sort_order')), '[]'::jsonb) INTO v_requirements
    FROM (
      SELECT jsonb_build_object('operation_type', dr.operation_type, 'document_key', dr.document_key, 'label', dr.label, 'description', dr.description, 'is_mandatory', dr.is_mandatory, 'sort_order', dr.sort_order) AS js
        FROM public.document_requirements dr ORDER BY dr.operation_type, dr.sort_order
    ) r;

  SELECT COALESCE(jsonb_agg(c.js ORDER BY (c.js->>'created_at') DESC), '[]'::jsonb) INTO v_commissions
    FROM (
      SELECT jsonb_build_object('id', cm.id, 'property_code', p.property_code, 'property_title', p.title, 'operation_type', cm.operation_type, 'commission_amount_usd', cm.commission_amount_usd, 'commission_amount_ars', cm.commission_amount_ars, 'iibb_amount_ars', cm.iibb_amount_ars, 'ganancias_amount_ars', cm.ganancias_amount_ars, 'net_amount_ars', cm.net_amount_ars, 'status', cm.status, 'due_date', cm.due_date, 'paid_date', cm.paid_date, 'liquidation_id', cm.liquidation_id, 'created_at', cm.created_at) AS js
        FROM public.commissions cm JOIN public.properties p ON p.id = cm.property_id WHERE cm.owner_id = v_owner_id
    ) c;

  SELECT COALESCE(jsonb_agg(l.js ORDER BY (l.js->>'period_start') DESC), '[]'::jsonb) INTO v_liquidations
    FROM (
      SELECT jsonb_build_object('id', cl.id, 'period_start', cl.period_start, 'period_end', cl.period_end, 'gross_commission_usd', cl.gross_commission_usd, 'gross_amount_ars', cl.gross_amount_ars, 'iibb_retention_ars', cl.iibb_retention_ars, 'ganancias_retention_ars', cl.ganancias_retention_ars, 'net_amount_ars', cl.net_amount_ars, 'status', cl.status, 'created_at', cl.created_at) AS js
        FROM public.commission_liquidations cl WHERE cl.owner_id = v_owner_id
    ) l;

  SELECT COALESCE(jsonb_agg(p.js ORDER BY (p.js->>'payment_date') DESC), '[]'::jsonb) INTO v_payments
    FROM (
      SELECT jsonb_build_object('id', cp.id, 'commission_id', cp.commission_id, 'liquidation_id', cp.liquidation_id, 'amount_ars', cp.amount_ars, 'payment_method', cp.payment_method, 'reference', cp.reference, 'payment_date', cp.payment_date) AS js
        FROM public.commission_payments cp WHERE cp.owner_id = v_owner_id
    ) p;

  SELECT COALESCE(jsonb_agg(t.js ORDER BY (t.js->>'created_at') DESC), '[]'::jsonb) INTO v_tasaciones
    FROM (
      SELECT jsonb_build_object('id', ta.id, 'title', ta.title, 'valuation_usd', ta.valuation_usd, 'valuation_ars', ta.valuation_ars, 'report_url', ta.report_url, 'status', ta.status, 'created_at', ta.created_at, 'delivered_at', ta.delivered_at, 'property_code', (SELECT p.property_code FROM public.properties p WHERE p.id = ta.property_id)) AS js
        FROM public.tasaciones ta WHERE ta.owner_id = v_owner_id
    ) t;

  SELECT jsonb_object_agg(z.zone, z.avg_m2) INTO v_zone_avg
    FROM (
      SELECT zone, ROUND(AVG(price_usd / NULLIF(COALESCE(surface_total, area_m2, 1), 0))) AS avg_m2
        FROM public.properties WHERE deleted_at IS NULL AND is_published = true AND zone IS NOT NULL AND zone != '' AND COALESCE(surface_total, area_m2, 0) > 0 AND price_usd > 0 GROUP BY zone
    ) z;

  SELECT COALESCE(jsonb_agg(t.js ORDER BY (t.js->>'due_date') ASC NULLS LAST), '[]'::jsonb) INTO v_tasks
    FROM (
      SELECT jsonb_build_object('id', ot.id, 'description', ot.description, 'due_date', ot.due_date, 'status', ot.status, 'priority', ot.priority, 'result_notes', ot.result_notes, 'type', ot.type) AS js
        FROM public.owner_tasks ot WHERE ot.owner_id = v_owner_id
    ) t;

  SELECT COALESCE(jsonb_agg(te.js ORDER BY (te.js->>'created_at') DESC), '[]'::jsonb) INTO v_timeline
    FROM (
      SELECT jsonb_build_object('id', ote.id, 'type', ote.type, 'text', ote.text, 'created_at', ote.created_at) AS js
        FROM public.owner_timeline_entries ote WHERE ote.owner_id = v_owner_id
    ) te;

  SELECT COALESCE(jsonb_agg(ph.js), '[]'::jsonb) INTO v_price_hist
    FROM (
      SELECT jsonb_build_object('prop_code', p.property_code, 'history', COALESCE((SELECT jsonb_agg(jsonb_build_object('price', sh.response->>'price', 'at', sh.created_at) ORDER BY sh.created_at DESC) FROM public.ml_sync_history sh WHERE sh.operation = 'sync_listing' AND sh.response->>'property_id' = p.id::text), '[]'::jsonb)) AS js
        FROM public.properties p WHERE p.owner_id = v_owner_id AND p.deleted_at IS NULL
    ) ph;

  SELECT COALESCE(jsonb_agg(al.js ORDER BY (al.js->>'created_at') DESC), '[]'::jsonb) INTO v_access_log
    FROM (
      SELECT jsonb_build_object('created_at', ll.created_at, 'event', ll.event_type, 'status', ll.status) AS js
        FROM public.rate_limit_logs ll WHERE ll.metadata->>'token' = p_token
    ) al;

  RETURN jsonb_build_object(
    'upcoming_visits', v_upcoming, 'visit_history', v_history,
    'weekly_leads', v_weekly_leads, 'weekly_visits', v_weekly_visits,
    'documents', v_documents, 'requirements', v_requirements,
    'commissions', v_commissions, 'liquidations', v_liquidations, 'payments', v_payments,
    'tasaciones', v_tasaciones, 'zone_avg', v_zone_avg, 'tasks', v_tasks,
    'timeline', v_timeline, 'price_history', v_price_hist, 'access_log', v_access_log
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.portal_get_extra_data(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_get_extra_data(text) TO anon, authenticated;
