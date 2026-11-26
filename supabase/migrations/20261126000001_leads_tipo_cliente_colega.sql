-- CRM: admite 'colega' (corredor) como tipo de cliente en leads.
--
-- POR QUÉ (pedido del empleador, 2026-11-26): hay colegas/corredores que
-- nos ingresan un lead porque están BUSCANDO una propiedad para un cliente
-- propio. Hoy ese lead se mezclaba con los compradores/inquilinos y no se
-- podía distinguir.
--
-- 'colega' NO deriva operación (a diferencia de propietario/comprador/
-- inversor/inquilino): un colega puede buscar en venta o en alquiler, así
-- que la operación queda vacía hasta que el agente la cargue.
--
-- Cambio ADITIVO sobre el CHECK: no borra ni reescribe filas existentes
-- (los 4 valores anteriores siguen aceptados tal cual).

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_tipo_cliente_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_tipo_cliente_check
  CHECK (tipo_cliente IS NULL OR tipo_cliente IN ('propietario','comprador','inversor','inquilino','colega'));

COMMENT ON COLUMN public.leads.tipo_cliente IS
  'Tipo de cliente: propietario | comprador | inversor | inquilino | colega (corredor que consulta para un cliente propio). Solo los primeros cuatro derivan operation_type.';
