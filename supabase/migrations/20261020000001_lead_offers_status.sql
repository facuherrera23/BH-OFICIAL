-- Deal room: schema completo de lead_offers.
-- Bug latente encontrado en la auditoría 2026-10-20: el código usaba
-- offer_type para el estado (accepted/rejected), destruyendo el tipo real.
-- Con status, offer_type mantiene su propósito. counterparty y updated_at
-- existían en el código pero no en la tabla. Aplicada vía MCP en 2 partes:
-- lead_offers_add_status + lead_offers_add_counterparty_updated.

ALTER TABLE public.lead_offers
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';

ALTER TABLE public.lead_offers
  ADD COLUMN IF NOT EXISTS counterparty text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

COMMENT ON COLUMN public.lead_offers.status IS 'Estado: pending | accepted | rejected. offer_type sigue siendo el TIPO.';
COMMENT ON COLUMN public.lead_offers.counterparty IS 'Nombre de la contraparte en la negociación.';
COMMENT ON COLUMN public.lead_offers.updated_at IS 'Última modificación.';
COMMENT ON COLUMN public.lead_offers.offer_type IS 'Tipo de la oferta. NO usar para estado — para eso está status.';

CREATE OR REPLACE FUNCTION public.update_lead_offers_timestamp()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lead_offers_updated_at ON public.lead_offers;
CREATE TRIGGER lead_offers_updated_at
  BEFORE UPDATE ON public.lead_offers
  FOR EACH ROW EXECUTE FUNCTION public.update_lead_offers_timestamp();

-- Hardening (patrón del proyecto): lead_offers es authenticated-only en RLS,
-- el trigger solo lo dispara authenticated. EXECUTE explícito + search_path fijado.
REVOKE EXECUTE ON FUNCTION public.update_lead_offers_timestamp() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_lead_offers_timestamp() TO authenticated, service_role;
ALTER FUNCTION public.update_lead_offers_timestamp() SET search_path = public, pg_temp;
