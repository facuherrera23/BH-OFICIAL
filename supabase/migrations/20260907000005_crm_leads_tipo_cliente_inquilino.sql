-- CRM: admite 'inquilino' como tipo de cliente en leads.
-- El frontend ya permite seleccionarlo (TIPO_CLIENTE_OPTS, zod, <option>);
-- el CHECK previo solo admitía propietario/comprador/inversor.

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_tipo_cliente_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_tipo_cliente_check
  CHECK (tipo_cliente IS NULL OR tipo_cliente IN ('propietario','comprador','inversor','inquilino'));