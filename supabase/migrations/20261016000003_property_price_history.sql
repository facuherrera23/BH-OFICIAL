-- Historial de cambios de precio de propiedades (mejora #11)
--
-- Problema: las propiedades tienen is_retasada pero no hay registro de
-- cuándo bajó el precio, desde cuánto, ni cuántas veces. Esto es ORO
-- para convencer a un dueño que su precio está alto: "bajaste de $150k
-- a $140k hace 2 semanas y sigue sin haber visitas".
--
-- La tabla se llena automáticamente por trigger en cada UPDATE de
-- properties donde price_usd cambie. El panel la muestra en el
-- dashboard y en el detalle de la propiedad.

CREATE TABLE IF NOT EXISTS public.property_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  old_price_usd numeric,
  new_price_usd numeric,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_history_property ON public.property_price_history (property_id, changed_at DESC);

ALTER TABLE public.property_price_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY price_history_select ON public.property_price_history
  FOR SELECT TO authenticated
  USING (true);

-- Trigger: log automático en cada cambio de price_usd
CREATE OR REPLACE FUNCTION public.log_property_price_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.price_usd IS DISTINCT FROM NEW.price_usd THEN
    INSERT INTO public.property_price_history (property_id, old_price_usd, new_price_usd)
    VALUES (NEW.id, OLD.price_usd, NEW.price_usd);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_property_price_history ON public.properties;
CREATE TRIGGER trg_property_price_history
  AFTER UPDATE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.log_property_price_change();

COMMENT ON TABLE public.property_price_history IS 'Historial de cambios de price_usd en properties. Se llena automáticamente por trigger trg_property_price_history.';
