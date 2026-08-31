-- ============================================================
-- MIGRATION: Open RELA Argentina - Integración de portal inmobiliario
-- Fuente de verdad de endpoints/campos:
--   https://open-classifieds.notion.site/arg/rela/ (Grupo QuintoAndar)
-- Esquema pensado para adapter desacoplado: nada de esto toca ml_* ni zernio_*.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ESTADOS DE PUBLICACION (estados locales de la integración.
--    El estado REMOTO real de RELA es ONLINE/OFFLINE/PROCESADO y
--    se persiste tal cual en rela_listings.remote_status)
-- ------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE rela_listing_status AS ENUM (
    'PENDING',          -- creado localmente, nunca enviado
    'SYNCING',          -- hay una operación en curso
    'PUBLISHED',        -- RELA confirmó ONLINE
    'UPDATE_PENDING',   -- la propiedad cambió en BH (hash difiere) y hay que re-enviar
    'UPDATING',         -- actualización en curso en RELA
    'UNPUBLISHED',      -- RELA confirmó OFFLINE (baja)
    'ERROR',            -- última operación falló (ver last_error)
    'BLOCKED'           -- validación local no superada; no se envía a RELA
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 2. CONFIGURACION (datos NO secretos; client_id/secret van en
--    env vars de Edge Functions: RELA_CLIENT_ID / RELA_CLIENT_SECRET)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rela_config (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),  -- singleton
  environment TEXT NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production')),
  base_url TEXT NOT NULL DEFAULT 'https://api-zp-sandbox-open.navent.com',
  role TEXT NOT NULL DEFAULT 'zp' CHECK (role IN ('zp', 'br', 'rela')),
  codigo_inmobiliaria TEXT,              -- lo entrega QuintoAndar / sale de GET /v1/inmobiliarias
  integrador TEXT,                       -- parámetro INTEGRADOR del botón de asociación
  plan_default TEXT NOT NULL DEFAULT 'SIMPLE',
  contacto_nombre TEXT,
  contacto_email TEXT,
  contacto_telefono TEXT,
  callbacks_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Mapeos internos hacia catálogos RELA. Se cargan desde el panel con los IDs
  -- reales devueltos por GET /v1/tipopropiedades y sus características
  -- (NO hardcodear IDs sin verificación contra la API).
  catalog_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,    -- {SUPERFICIE_TOTAL:"CFT100", SUPERFICIE_CUBIERTA:"CFT101", AMBIENTES:"CFT1", DORMITORIOS:"CFT2", BANOS:"CFT3", MEDIO_BANO:"CFT4", GARAGE:"CFT7", ...}
  tipo_propiedad_map JSONB NOT NULL DEFAULT '{}'::jsonb, -- {departamento:{idTipo:"2",idSubTipo:"38"}, casa:{idTipo:"1"}, ...}
  ubicacion_map JSONB NOT NULL DEFAULT '{}'::jsonb,      -- {zona_normalizada: idUbicacion RELA}
  dry_run BOOLEAN NOT NULL DEFAULT TRUE, -- TRUE hasta que el admin lo apague explícitamente
  last_auth_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.rela_config (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- 3. TOKEN CACHE (nunca visible fuera de service_role)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rela_tokens (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  access_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  obtained_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 4. PUBLICACIONES RELA (1 a 1 con properties)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rela_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL UNIQUE REFERENCES public.properties(id) ON DELETE CASCADE,
  codigo_aviso TEXT NOT NULL UNIQUE,           -- identificador único que BH asigna al aviso
  id_aviso_navplat BIGINT,                     -- idAviso devuelto por RELA
  status rela_listing_status NOT NULL DEFAULT 'PENDING',
  remote_status TEXT,                          -- ONLINE / OFFLINE / PROCESADO (visceral de RELA)
  plan TEXT,                                   -- tipoDePublicacion usado
  payload_hash TEXT,                           -- hash del payload normalizado (detección de cambios)
  remote_updated_at TIMESTAMPTZ,               -- fechaModificacion del resumen online
  published_at TIMESTAMPTZ,
  unpublished_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  last_warnings JSONB,                         -- warnings no fatales de la última operación
  remote_snapshot JSONB,                       -- última respuesta de GET aviso (debug)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rela_listings_property ON public.rela_listings (property_id);
CREATE INDEX IF NOT EXISTS idx_rela_listings_status ON public.rela_listings (status);

-- ------------------------------------------------------------
-- 5. CACHE DE CATALOGOS (ubicaciones, tipos, planes, operaciones…)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rela_catalog_cache (
  catalog TEXT NOT NULL,        -- 'ubicaciones_root' | 'ubicaciones:<id>' | 'tipopropiedades' | ...
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (catalog)
);

-- ------------------------------------------------------------
-- 6. EVENTOS DE CALLBACK (dedupe / idempotencia)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rela_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,         -- idEvento del callback (dedupe exacto)
  tipo_evento TEXT NOT NULL,             -- CONTACTO / CONTACTO_MENSAJE / AVISO_* / CREDITO
  codigo_inmobiliaria TEXT,
  referencia TEXT,                       -- codigoAviso asociado (si RELA lo envía)
  id_aviso_navplat BIGINT,
  payload JSONB NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  process_error TEXT,
  lead_id UUID,                          -- si generó un lead en CRM
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rela_webhook_events_tipo ON public.rela_webhook_events (tipo_evento);
CREATE INDEX IF NOT EXISTS idx_rela_webhook_events_unprocessed
  ON public.rela_webhook_events (received_at) WHERE NOT processed;

-- ------------------------------------------------------------
-- 7. RLS
-- ------------------------------------------------------------
ALTER TABLE public.rela_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rela_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rela_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rela_catalog_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rela_webhook_events ENABLE ROW LEVEL SECURITY;

-- config: lectura autenticados; escritura sólo super_admin
DROP POLICY IF EXISTS rela_config_read ON public.rela_config;
CREATE POLICY rela_config_read ON public.rela_config
  FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS rela_config_write ON public.rela_config;
CREATE POLICY rela_config_write ON public.rela_config
  FOR UPDATE TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

-- listings: lectura autenticados; escrituras SOLO vía service_role (edge functions)
DROP POLICY IF EXISTS rela_listings_read ON public.rela_listings;
CREATE POLICY rela_listings_read ON public.rela_listings
  FOR SELECT TO authenticated USING (TRUE);

-- catalog_cache: lectura autenticados; escritura service_role
DROP POLICY IF EXISTS rela_catalog_read ON public.rela_catalog_cache;
CREATE POLICY rela_catalog_read ON public.rela_catalog_cache
  FOR SELECT TO authenticated USING (TRUE);

-- rela_tokens y rela_webhook_events: SIN políticas; únicamente service_role.

-- ------------------------------------------------------------
-- 8. updated_at triggers (reusa helper existente)
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_rela_config_updated_at ON public.rela_config;
CREATE TRIGGER trg_rela_config_updated_at
  BEFORE UPDATE ON public.rela_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_rela_listings_updated_at ON public.rela_listings;
CREATE TRIGGER trg_rela_listings_updated_at
  BEFORE UPDATE ON public.rela_listings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ------------------------------------------------------------
-- 9. RPC: estado agregado del portal (para el tab Portales)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rela_portal_status()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_config public.rela_config%ROWTYPE;
  v_counts RECORD;
BEGIN
  SELECT * INTO v_config FROM public.rela_config WHERE id = TRUE;

  SELECT
    COUNT(*) FILTER (WHERE status = 'PUBLISHED') AS published,
    COUNT(*) FILTER (WHERE status IN ('PENDING', 'UPDATE_PENDING')) AS pending,
    COUNT(*) FILTER (WHERE status = 'ERROR') AS errors,
    COUNT(*) FILTER (WHERE status = 'BLOCKED') AS blocked,
    COUNT(*) FILTER (WHERE status = 'UNPUBLISHED') AS unpublished,
    COUNT(*) AS total
  INTO v_counts
  FROM public.rela_listings;

  RETURN jsonb_build_object(
    'environment', v_config.environment,
    'base_url', v_config.base_url,
    'codigo_inmobiliaria', v_config.codigo_inmobiliaria,
    'dry_run', v_config.dry_run,
    'callbacks_enabled', v_config.callbacks_enabled,
    'last_auth_at', v_config.last_auth_at,
    'last_sync_at', v_config.last_sync_at,
    'last_error', v_config.last_error,
    'listings', jsonb_build_object(
      'published', COALESCE(v_counts.published, 0),
      'pending', COALESCE(v_counts.pending, 0),
      'errors', COALESCE(v_counts.errors, 0),
      'blocked', COALESCE(v_counts.blocked, 0),
      'unpublished', COALESCE(v_counts.unpublished, 0),
      'total', COALESCE(v_counts.total, 0)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rela_portal_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rela_portal_status() TO authenticated;
