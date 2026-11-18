-- ============================================
-- 20261118000005 — Medición first-party del sitio (sin cookies)
-- ============================================
-- MOTIVO (auditoría 18/11/2026): el sitio NO tiene medición de tráfico.
--   • GA4 + Clarity solo cargan con consentimiento 'all' → la mayoría de las
--     visitas no se ven (y con la AAIP no se puede pedir 'all' por defecto).
--   • Cloudflare Web Analytics está permitido en la CSP pero nunca se activó.
--   • `bhTrack` (form_start/form_submit/wa_click/property_view) era un NO-OP
--     sin consentimiento → no se registraba ni una conversión.
--   • Todos los leads tenían utm_source/utm_campaign NULL → sin campañas ni
--     atribución corriendo.
-- Resultado: 1 lead del formulario en 12 semanas y NINGÚN dato para saber si
--   entra gente, de dónde ni qué hacen.
--
-- QUÉ HACE ESTA MIGRACIÓN:
--   1. page_events: eventos de navegación del sitio (agregados, sin PII).
--   2. bh_web_metrics(): RPC de lectura para el panel.
--
-- PRIVACIDAD (AAIP / Ley 25.326):
--   • NO se guarda IP, ni user agent, ni email, ni nombre, ni teléfono.
--   • session_id = UUID aleatorio en sessionStorage (se borra al cerrar la
--     pestaña); sirve para contar sesiones, NO para identificar personas.
--   • Sin cookies: el evento va por fetch/sendBeacon a nuestra propia función.
--   • Opt-out explícito: localStorage 'bh_track_optout' = '1' → no se manda
--     nada (botón "No medirme" en el pie del sitio).
--   • Retención: indefinida por ahora (el volumen es bajo y NO se borra nada
--     sin copia — si algún día se purga, va con archivo como el resto de los
--     logs del proyecto).
-- ============================================

-- ------------------------------------------------------------
-- 1. Eventos del sitio
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.page_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event         text NOT NULL,                 -- page_view | wa_click | form_start | form_submit | ...
  path          text NOT NULL DEFAULT '/',      -- ruta del sitio (sin query)
  page          text,                          -- landing | ficha | tasacion | canal
  property_code text,                          -- DA-P0002 (ficha/catálogo)
  origin        text,                          -- web | ficha | instagram | ...
  referrer      text,
  utm_source    text,
  utm_campaign  text,
  session_id    uuid,                          -- sesión del navegador (no persona)
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- RLS ON sin policies → solo service_role escribe (la edge function).
-- La lectura del panel va por la RPC bh_web_metrics() (SECURITY DEFINER).
ALTER TABLE public.page_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.page_events FROM anon, authenticated;
GRANT ALL ON public.page_events TO service_role;

CREATE INDEX IF NOT EXISTS idx_page_events_created ON public.page_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_events_event_created ON public.page_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_events_path_created ON public.page_events (path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_events_property ON public.page_events (property_code, created_at DESC)
  WHERE property_code IS NOT NULL;

COMMENT ON TABLE public.page_events IS
  'Eventos de navegación del sitio (first-party, sin cookies, sin PII). Solo service_role escribe; el panel lee por RPC.';

-- ------------------------------------------------------------
-- 2. Métricas web para el panel
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bh_web_metrics(p_dias integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_dias       integer := GREATEST(LEAST(COALESCE(p_dias, 7), 1), 90);
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

-- ------------------------------------------------------------
-- 3. Permisos
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.bh_web_metrics(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bh_web_metrics(integer) TO authenticated, service_role;
