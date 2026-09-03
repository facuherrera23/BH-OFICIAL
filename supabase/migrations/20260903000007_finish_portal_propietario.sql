-- Portal Propietario: revocación de tokens
-- Agrega revoked_at a owner_portal_tokens para poder revocar links del portal.

ALTER TABLE public.owner_portal_tokens
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

COMMENT ON COLUMN public.owner_portal_tokens.revoked_at IS 'Fecha de revocación del token; NULL = vigente';
