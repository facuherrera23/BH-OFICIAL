-- ============================================================
-- 2026-11-04 · Clasificados La Voz — publicación asistida
-- ============================================================
-- POR QUÉ ASISTIDA Y NO API (verificado 2026-11-04 contra el portal):
--   · Clasificados La Voz NO tiene API pública ni carga masiva. No aparece
--     en FAQ, Términos y Condiciones, sitemap ni en los 22 bundles JS del
--     front; la única ruta JSON real es /api/auth/me (todo otro path
--     devuelve el shell SPA). No hay Excel, FTP, feed ni webhook de avisos.
--   · robots.txt bloquea AI crawlers (Anthropic, AI Search, Ahrefs…) y
--     Cloudflare Turnstile protege el portal (bloquea browsers headless).
--   · Los avisos se publican 10 o 30 días → hay que trackear el VENCIMIENTO.
--   · La cuenta se registra como Particular/Comercio; el tipo "Inmobiliaria"
--     (y el logo CPI del convenio) lo habilita La Voz a pedido.
-- Por eso el modelo es: el CRM arma el aviso completo (texto + fotos con la
-- PORTADA primero) y trackea el estado; la carga en el panel la hace una
-- persona (o el asistente local scripts/lavoz-publisher.mjs).
--
-- ADITIVO: no modifica properties, no borra nada.

-- ------------------------------------------------------------
-- 1) Configuración del portal (mapeos editables sin deploy)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lavoz_config (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  -- Duración del aviso en La Voz: 10 o 30 días (Términos §4).
  dias_publicacion INTEGER NOT NULL DEFAULT 30 CHECK (dias_publicacion IN (10, 30)),
  -- property_type nuestro -> subrubro La Voz (slugs verificados en /inmuebles).
  tipo_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- barrio/ciudad nuestro -> {ciudad, barrio, label} de La Voz.
  ubicacion_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Datos de contacto que se ofrecen para el aviso (vacío = no se pegan).
  contacto JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mapeos reales, medidos contra el portal el 2026-11-04.
-- Las claves se comparan NORMALIZADAS (minúsculas, sin tildes, espacios
-- colapsados) — el código lo normaliza antes de buscar.
INSERT INTO public.lavoz_config (id, dias_publicacion, tipo_map, ubicacion_map, contacto)
VALUES (
  TRUE,
  30,
  '{"casa":{"subrubro":"casas","label":"Casas"},
    "departamento":{"subrubro":"departamentos","label":"Departamentos"},
    "terreno":{"subrubro":"terrenos-y-lotes","label":"Terrenos y Lotes"},
    "local":{"subrubro":"locales","label":"Locales"},
    "galpon":{"subrubro":"galpones-y-depositos","label":"Galpones y depósitos"},
    "oficina":{"subrubro":"oficinas","label":"Oficinas"},
    "cochera":{"subrubro":"cocheras","label":"Cocheras"}}'::jsonb,
  '{"nueva cordoba":{"ciudad":"cordoba","ciudad_label":"Córdoba","barrio":"nueva-cordoba","label":"Nueva Córdoba"},
    "centro":{"ciudad":"cordoba","ciudad_label":"Córdoba","barrio":"centro","label":"Centro"},
    "alberdi":{"ciudad":"cordoba","ciudad_label":"Córdoba","barrio":"alberdi","label":"Alberdi"},
    "alta cordoba":{"ciudad":"cordoba","ciudad_label":"Córdoba","barrio":"alta-cordoba","label":"Alta Córdoba"},
    "san vicente":{"ciudad":"cordoba","ciudad_label":"Córdoba","barrio":"san-vicente","label":"San Vicente"},
    "poeta lugones":{"ciudad":"cordoba","ciudad_label":"Córdoba","barrio":"poeta-lugones","label":"Poeta Lugones"},
    "urca":{"ciudad":"cordoba","ciudad_label":"Córdoba","barrio":"urca","label":"Urca"},
    "obrero":{"ciudad":"cordoba","ciudad_label":"Córdoba","barrio":"obrero","label":"Obrero"},
    "villa allende parque":{"ciudad":"cordoba","ciudad_label":"Córdoba","barrio":"villa-allende-parque","label":"Villa Allende Parque"},
    "la reserva":{"ciudad":"cordoba","ciudad_label":"Córdoba","barrio":"la-reserva","label":"La Reserva"},
    "villa carlos paz":{"ciudad":"villa-carlos-paz","ciudad_label":"Villa Carlos Paz","barrio":null,"label":"Villa Carlos Paz"},
    "la calera":{"ciudad":"la-calera","ciudad_label":"La Calera","barrio":null,"label":"La Calera"},
    "villa berna":{"ciudad":"villa-berna","ciudad_label":"Villa Berna","barrio":null,"label":"Villa Berna"},
    "san ignacio":{"ciudad":"san-ignacio","ciudad_label":"San Ignacio","barrio":null,"label":"San Ignacio"},
    "potrero de garay":{"ciudad":"potrero-de-garay","ciudad_label":"Potrero de Garay","barrio":null,"label":"Potrero de Garay"}}'::jsonb,
  '{"email":"bienenhaus.propiedades@gmail.com","telefono":"","whatsapp":"","mostrar_whatsapp":false}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- 2) Estado de cada aviso publicado en La Voz
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lavoz_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',
  ad_url TEXT,                       -- URL del aviso en La Voz
  remote_id TEXT,                    -- id/código que asigna La Voz
  plan TEXT,                         -- 'basico' | 'premium' | 'super_premium'
  payload JSONB,                     -- aviso armado (texto + fotos + campos)
  fotos_count INTEGER NOT NULL DEFAULT 0,
  published_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,            -- published_at + dias_publicacion
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lavoz_listings_property_key UNIQUE (property_id),
  CONSTRAINT lavoz_listings_status_check
    CHECK (status IN ('draft','ready','published','expired','failed'))
);

CREATE INDEX IF NOT EXISTS idx_lavoz_listings_status ON public.lavoz_listings (status);
CREATE INDEX IF NOT EXISTS idx_lavoz_listings_expires ON public.lavoz_listings (expires_at)
  WHERE status = 'published';

-- ------------------------------------------------------------
-- 3) RLS
-- ------------------------------------------------------------
ALTER TABLE public.lavoz_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lavoz_listings ENABLE ROW LEVEL SECURITY;

-- config: lectura autenticados; escritura sólo super_admin
DROP POLICY IF EXISTS lavoz_config_read ON public.lavoz_config;
CREATE POLICY lavoz_config_read ON public.lavoz_config
  FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS lavoz_config_write ON public.lavoz_config;
CREATE POLICY lavoz_config_write ON public.lavoz_config
  FOR UPDATE TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

-- listings: lectura autenticados; escrituras SOLO vía service_role (edge function)
DROP POLICY IF EXISTS lavoz_listings_read ON public.lavoz_listings;
CREATE POLICY lavoz_listings_read ON public.lavoz_listings
  FOR SELECT TO authenticated USING (TRUE);

-- ------------------------------------------------------------
-- 4) updated_at trigger (reusa helper existente)
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_lavoz_config_updated_at ON public.lavoz_config;
CREATE TRIGGER trg_lavoz_config_updated_at
  BEFORE UPDATE ON public.lavoz_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_lavoz_listings_updated_at ON public.lavoz_listings;
CREATE TRIGGER trg_lavoz_listings_updated_at
  BEFORE UPDATE ON public.lavoz_listings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ------------------------------------------------------------
-- 5) RPC: estado agregado para el tab Portales
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lavoz_portal_status()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_config public.lavoz_config%ROWTYPE;
  v_counts RECORD;
BEGIN
  SELECT * INTO v_config FROM public.lavoz_config WHERE id = TRUE;

  SELECT
    COUNT(*) FILTER (WHERE status = 'published') AS published,
    COUNT(*) FILTER (WHERE status = 'ready')     AS ready,
    COUNT(*) FILTER (WHERE status = 'expired')   AS expired,
    COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
    COUNT(*) FILTER (WHERE status = 'draft')     AS draft,
    COUNT(*) FILTER (
      WHERE status = 'published'
        AND expires_at IS NOT NULL
        AND expires_at < now() + interval '7 days'
    ) AS expiring_soon,
    COUNT(*) AS total
  INTO v_counts
  FROM public.lavoz_listings;

  RETURN jsonb_build_object(
    'dias_publicacion', v_config.dias_publicacion,
    'contacto', v_config.contacto,
    'listings', jsonb_build_object(
      'published', COALESCE(v_counts.published, 0),
      'ready', COALESCE(v_counts.ready, 0),
      'expired', COALESCE(v_counts.expired, 0),
      'failed', COALESCE(v_counts.failed, 0),
      'draft', COALESCE(v_counts.draft, 0),
      'expiring_soon', COALESCE(v_counts.expiring_soon, 0),
      'total', COALESCE(v_counts.total, 0)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lavoz_portal_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lavoz_portal_status() TO authenticated;
