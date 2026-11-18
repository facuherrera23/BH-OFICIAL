-- ============================================
-- 20261118000006 — Fix del clamp de días en bh_web_metrics
-- ============================================
-- BUG (mismo día de la creación, detectado al verificar en producción):
--   la migración 20261118000005 escribió la línea del clamp al revés:
--     v_dias := GREATEST(LEAST(COALESCE(p_dias, 7), 1), 90);
--   GREATEST(LEAST(x, 1), 90) SIEMPRE da 90 → la ventana de "top páginas"
--   y "por evento" era de 90 días, ignorando el parámetro (la primera
--   verificación en producción devolvió dias=90 al pedir 7).
--
-- El clamp correcto es: acotar a [1, 90] con el 7 como default:
--     v_dias := GREATEST(LEAST(COALESCE(p_dias, 7), 90), 1);
--
-- REGLA del proyecto: una migración ya aplicada NO se edita → el fix va acá.
-- (En una base nueva se aplican 005 y 006 en orden y queda igual.)
--
-- Además: la función gana un default explícito para que el panel pueda
-- llamarla sin argumentos (bh_web_metrics()).
-- ============================================

CREATE OR REPLACE FUNCTION public.bh_web_metrics(p_dias integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_dias       integer := GREATEST(LEAST(COALESCE(p_dias, 7), 90), 1);
  v_vistas_7d  integer := 0;
  v_vistas_30d integer := 0;
  v_wa_7d      integer := 0;
  v_wa_30d     integer := 0;
  v_form_start_7d integer := 0;
  v_form_submit_7d integer := 0;
  v_leads_web_7d   integer := 0;
  v_leads_web_30d  integer := 0;
  v_top_paginas    jsonb;
  v_por_evento     jsonb;
BEGIN
  SELECT
    count(*) FILTER (WHERE created_at > now() - interval '7 days'),
    count(*) FILTER (WHERE created_at > now() - interval '30 days'),
    count(*) FILTER (WHERE event = 'wa_click' AND created_at > now() - interval '7 days'),
    count(*) FILTER (WHERE event = 'wa_click' AND created_at > now() - interval '30 days'),
    count(*) FILTER (WHERE event = 'form_start' AND created_at > now() - interval '7 days'),
    count(*) FILTER (WHERE event = 'form_submit' AND created_at > now() - interval '7 days')
  INTO v_vistas_7d, v_vistas_30d, v_wa_7d, v_wa_30d, v_form_start_7d, v_form_submit_7d
  FROM public.page_events WHERE event = 'page_view';

  SELECT
    count(*) FILTER (WHERE created_at > now() - interval '7 days'),
    count(*) FILTER (WHERE created_at > now() - interval '30 days')
  INTO v_leads_web_7d, v_leads_web_30d
  FROM public.leads
  WHERE source IN ('landing_page', 'landing', 'web', 'contacto', 'whatsapp')
    AND deleted_at IS NULL;

  -- Páginas más vistas en la ventana.
  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO v_top_paginas FROM (
    SELECT path, count(*) AS vistas
    FROM public.page_events
    WHERE event = 'page_view' AND created_at > now() - make_interval(days => v_dias)
    GROUP BY path
    ORDER BY count(*) DESC, path
    LIMIT 8
  ) x;

  -- Conteo por tipo de evento (ventana).
  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO v_por_evento FROM (
    SELECT event, count(*) AS n
    FROM public.page_events
    WHERE created_at > now() - make_interval(days => v_dias)
    GROUP BY event
    ORDER BY count(*) DESC
  ) x;

  RETURN jsonb_build_object(
    'generado_at', now(),
    'dias', v_dias,
    'vistas_7d', v_vistas_7d,
    'vistas_30d', v_vistas_30d,
    'wa_clicks_7d', v_wa_7d,
    'wa_clicks_30d', v_wa_30d,
    'form_starts_7d', v_form_start_7d,
    'form_submits_7d', v_form_submit_7d,
    'leads_web_7d', v_leads_web_7d,
    'leads_web_30d', v_leads_web_30d,
    'tasa_form_7d', CASE WHEN v_vistas_7d > 0
                         THEN round((v_form_submit_7d::numeric / v_vistas_7d::numeric) * 100, 2)
                         ELSE 0 END,
    'top_paginas', v_top_paginas,
    'por_evento', v_por_evento
  );
END
$fn$;

-- Los permisos se re-afirman (Supabase tiene ALTER DEFAULT PRIVILEGES que
-- re-otorga EXECUTE a authenticated al crear funciones).
REVOKE ALL ON FUNCTION public.bh_web_metrics(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bh_web_metrics(integer) TO authenticated, service_role;
