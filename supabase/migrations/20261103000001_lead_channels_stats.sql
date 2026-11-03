-- ============================================================
-- Leads por canal de captación — KPI del digest semanal (2026-11-03)
--
-- Los canales nuevos (cartel QR de tasación 2026-11-02, post de Google
-- Business) dejan su rastro en leads.utm_source/utm_campaign que el
-- formulario persiste. Sin este KPI esa cantidad invisible: el dueño
-- no puede saber si el cartel de ML-1234 o el post GBP dieron fruto
-- sin abrir el CRM a filtrar a mano.
--
-- Devuelve, para la semana pedida y la semana anterior (delta):
--   · bySource      → leads agrupados por leads.source
--   · byUtm         → leads con utm declarado, por utm_source+utm_campaign
--
-- SECURITY DEFINER + search_path vacío + EXECUTE solo service_role
-- (mismo hardening que supervision_digest_stats / contact_sla de la
-- migración 20261102000001).
-- ============================================================

CREATE OR REPLACE FUNCTION public.supervision_digest_lead_channels(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_span interval;
  v_by_source jsonb;
  v_by_utm jsonb;
  v_prev_by_source jsonb;
  v_prev_by_utm jsonb;
  v_total integer;
  v_prev_total integer;
BEGIN
  /* Semana azuleja: prev = [p_from - span, p_from), incluido el mismo span. */
  v_span := p_to - p_from;

  SELECT count(*) INTO v_total
  FROM public.leads
  WHERE deleted_at IS NULL AND created_at >= p_from AND created_at < p_to;

  SELECT count(*) INTO v_prev_total
  FROM public.leads
  WHERE deleted_at IS NULL AND created_at >= p_from - v_span AND created_at < p_from;

  SELECT jsonb_agg(jsonb_build_object('source', src, 'n', n) ORDER BY n DESC)
  INTO v_by_source
  FROM (
    SELECT source AS src, count(*) AS n
    FROM public.leads
    WHERE deleted_at IS NULL AND created_at >= p_from AND created_at < p_to
    GROUP BY source
  ) t;

  SELECT jsonb_agg(jsonb_build_object('utm_source', us, 'utm_campaign', uc, 'n', n) ORDER BY n DESC)
  INTO v_by_utm
  FROM (
    SELECT btrim(coalesce(utm_source, '')) AS us, btrim(coalesce(utm_campaign, '')) AS uc, count(*) AS n
    FROM public.leads
    WHERE deleted_at IS NULL AND created_at >= p_from AND created_at < p_to
      AND btrim(coalesce(utm_source, '')) <> ''
    GROUP BY 1, 2
  ) t;

  SELECT jsonb_agg(jsonb_build_object('source', src, 'n', n) ORDER BY n DESC)
  INTO v_prev_by_source
  FROM (
    SELECT source AS src, count(*) AS n
    FROM public.leads
    WHERE deleted_at IS NULL AND created_at >= p_from - v_span AND created_at < p_from
    GROUP BY source
  ) t;

  SELECT jsonb_agg(jsonb_build_object('utm_source', us, 'utm_campaign', uc, 'n', n) ORDER BY n DESC)
  INTO v_prev_by_utm
  FROM (
    SELECT btrim(coalesce(utm_source, '')) AS us, btrim(coalesce(utm_campaign, '')) AS uc, count(*) AS n
    FROM public.leads
    WHERE deleted_at IS NULL AND created_at >= p_from - v_span AND created_at < p_from
      AND btrim(coalesce(utm_source, '')) <> ''
    GROUP BY 1, 2
  ) t;

  RETURN jsonb_build_object(
    'total', v_total,
    'prevTotal', v_prev_total,
    'bySource', coalesce(v_by_source, '[]'::jsonb),
    'byUtm', coalesce(v_by_utm, '[]'::jsonb),
    'prevBySource', coalesce(v_prev_by_source, '[]'::jsonb),
    'prevByUtm', coalesce(v_prev_by_utm, '[]'::jsonb)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.supervision_digest_lead_channels(timestamptz, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.supervision_digest_lead_channels(timestamptz, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION public.supervision_digest_lead_channels(timestamptz, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.supervision_digest_lead_channels(timestamptz, timestamptz) TO service_role;
