-- Deal room: workflow de ofertas y contraofertas para leads
-- (mejora crítica #2 de la auditoría de negocio)
--
-- Problema: las etapas visita_realizada → negociacion → cerrado_ganado
-- existen pero nadie las usa (0 leads) porque no hay herramienta para
-- sostener la negociación. Sin esto, la negociación vive en WhatsApp o
-- en la cabeza del agente.
--
-- La tabla lead_offers registra cada movimiento de la negociación:
--   - client: el cliente hizo una oferta
--   - counter: el dueño contraofertó
--   - accepted: se aceptó (acuerdo)
--   - rejected: se rechazó
--
-- Al aceptar una oferta, el frontend actualiza leads.estimated_value
-- y mueve el stage a negociacion/cerrado_ganado. La comisión se dispara
-- automáticamente cuando la PROPIEDAD se marca como vendida/alquilada
-- (trigger_commission_on_property_closed en properties).

CREATE TABLE IF NOT EXISTS public.lead_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  offer_type text NOT NULL CHECK (offer_type IN ('client', 'counter', 'accepted', 'rejected')),
  amount numeric NOT NULL CHECK (amount >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'ARS')),
  conditions text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_lead_offers_lead ON public.lead_offers (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_offers_property ON public.lead_offers (property_id);

-- RLS
ALTER TABLE public.lead_offers ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_offers_select ON public.lead_offers
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY lead_offers_insert ON public.lead_offers
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.leads l
      WHERE l.id = lead_offers.lead_id
      AND (
        EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
        OR EXISTS (SELECT 1 FROM public.agents a WHERE a.profile_id = auth.uid() AND a.id IN (l.assigned_to, l.created_by))
      )
    )
  );

CREATE POLICY lead_offers_delete ON public.lead_offers
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
  );

COMMENT ON TABLE public.lead_offers IS 'Deal room: ofertas y contraofertas de leads sobre propiedades. offer_type: client|counter|accepted|rejected';
