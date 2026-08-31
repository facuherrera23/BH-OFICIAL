-- =====================================================================
-- 20260903000002_ml_schema_versioning
-- R-2.2 [F-05] Versionar schema ML completo contra prod real
-- Tablas faltantes referenciadas por _shared/ml.ts y ml-webhook:
--   ml_connection, ml_sync_cooldown, ml_webhook_events
-- También: migrar fallback legacy site_settings → app_settings
-- =====================================================================

BEGIN;

-- ----------------------------------------------------------------------
-- ml_connection: credenciales ML encriptadas (1 fila activa)
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ml_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'mercadolibre',
  nickname text,                          -- alias interno (ej: "prod", "sandbox")
  email text,                             -- email de la cuenta ML
  user_id text,                           -- user_id de ML (numérico como string)
  access_token_encrypted text NOT NULL,
  access_token_iv text NOT NULL,
  refresh_token_encrypted text NOT NULL,
  refresh_token_iv text NOT NULL,
  token_expires_at timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_connection_active ON public.ml_connection (is_active) WHERE is_active;

-- ----------------------------------------------------------------------
-- ml_sync_cooldown: circuit breaker para rate limit 429 de ML
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ml_sync_cooldown (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  connection_id uuid NOT NULL REFERENCES public.ml_connection(id) ON DELETE CASCADE,
  reason text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- ----------------------------------------------------------------------
-- ml_webhook_events: dedup de eventos webhook (ya existe en prod según AUDIT_FINDINGS)
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ml_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,                  -- ML user_id (string numérico)
  resource text NOT NULL,
  topic text NOT NULL,
  application_id text,
  attempts int NOT NULL DEFAULT 1,
  sent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,                   -- 'received' | 'processed' | 'failed' | 'deduplicated'
  error text,
  payload jsonb NOT NULL,
  processed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_webhook_events_dedup
  ON public.ml_webhook_events (user_id, resource, topic, sent_at);

CREATE INDEX IF NOT EXISTS idx_ml_webhook_events_unprocessed
  ON public.ml_webhook_events (received_at) WHERE status = 'received';

-- ----------------------------------------------------------------------
-- RLS para nuevas tablas ML
-- ----------------------------------------------------------------------
ALTER TABLE public.ml_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_sync_cooldown ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_webhook_events ENABLE ROW LEVEL SECURITY;

-- ml_connection: solo super_admin (credenciales sensibles)
DROP POLICY IF EXISTS ml_connection_all ON public.ml_connection;
CREATE POLICY ml_connection_super_admin ON public.ml_connection
  FOR ALL TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

-- ml_sync_cooldown: solo service_role (edge functions)
-- Sin policies = deny-default para authenticated/anon

-- ml_webhook_events: solo service_role (webhook receiver)
-- Sin policies = deny-default

-- ----------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_ml_connection_updated_at ON public.ml_connection;
CREATE TRIGGER trg_ml_connection_updated_at
  BEFORE UPDATE ON public.ml_connection
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ----------------------------------------------------------------------
-- Migración de datos legacy: portal_settings.ml_* → app_settings.integrations
-- (ejecutar una vez, luego eliminar columnas legacy si existen)
-- ----------------------------------------------------------------------
-- NOTE: Esto es informativo; la migración real de datos debe hacerse manual
-- si hay datos en portal_settings.settings.ml_*.
-- Las edge functions ya leen de app_settings.integrations (fallback a env vars).

COMMIT;