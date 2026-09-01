-- ============================================================
-- 20260903000004_fix_zernio_broker_trigger.sql
-- ============================================================
-- Fix: zernio_set_broker_id() referenced NEW.property_id and NEW.lead_id
-- columns that do not exist on zernio_conversations, causing ALL inserts
-- to fail with "record 'new' has no field 'property_id'".
--
-- Rewrite the function to only check columns that actually exist on the
-- table (account_id, broker_id), preserving the auto-assign-by-account
-- behavior.
-- ============================================================

CREATE OR REPLACE FUNCTION public.zernio_set_broker_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.broker_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Solo intentamos autocompletar si hay account_id (account_id es la única FK útil para esto)
  IF NEW.account_id IS NOT NULL THEN
    SELECT a.id INTO NEW.broker_id
    FROM public.agents a
    JOIN public.properties p ON p.agent_id = a.id
    WHERE a.status = 'activo'
    ORDER BY p.created_at DESC
    LIMIT 1;
  END IF;

  RETURN NEW;
END;
$function$;
