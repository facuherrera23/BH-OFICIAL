-- ============================================================
-- MIGRATION: Fixes de funciones rotas detectadas en auditoría 2026-08-31
-- Patrón común: SET search_path='' (o TO '') con referencias sin esquema.
-- Verificado: cada función fallaba al ejecutarse.
-- Extraviadas además por renombre 20260827_unify_agent_ids:
--   zernio_set_broker_id usaba leads.broker_id y properties.broker_id
--   (hoy son leads.assigned_to y properties.agent_id).
-- ============================================================

-- 1. Sidebar badges (RPC del panel)
CREATE OR REPLACE FUNCTION public.get_sidebar_badge_counts(p_user_id uuid DEFAULT auth.uid())
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_props integer; v_leads integer; v_visits integer; v_owners integer; v_tasaciones integer;
BEGIN
  SELECT count(*) INTO v_props FROM public.properties WHERE is_published = true;
  SELECT count(*) INTO v_leads FROM public.leads WHERE stage NOT IN ('cerrado', 'perdido');
  SELECT count(*) INTO v_visits FROM public.visits WHERE status = 'pendiente';
  SELECT count(*) INTO v_owners FROM public.owners WHERE deleted_at IS NULL;
  SELECT count(*) INTO v_tasaciones FROM public.tasaciones;

  RETURN json_build_object(
    'properties', v_props,
    'leads', v_leads,
    'visits', v_visits,
    'owners', v_owners,
    'tasaciones', v_tasaciones
  );
END;
$function$;

-- 2. Generador de código de propiedad (versión actual, usada por trigger)
CREATE OR REPLACE FUNCTION public.generate_property_code(p_created_by uuid, p_source_type text DEFAULT 'manual'::text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_prefix TEXT;
    v_seq INT;
    v_full_name TEXT;
BEGIN
    IF p_source_type = 'ml' THEN
        v_prefix := 'ML';
    ELSE
        SELECT full_name INTO v_full_name FROM public.profiles WHERE id = p_created_by;
        v_prefix := upper(
            regexp_replace(
                regexp_replace(COALESCE(v_full_name, ''), '\s+', ' ', 'g'),
                '(\w)\w*\s*', '\1', 'g'
            )
        );
        IF length(v_prefix) > 3 THEN
            v_prefix := left(v_prefix, 3);
        END IF;
        IF v_prefix = '' THEN
            v_prefix := 'PR';
        END IF;
    END IF;

    INSERT INTO public.property_sequences (prefix, last_number)
    VALUES (v_prefix, 1)
    ON CONFLICT (prefix) DO UPDATE SET
        last_number = public.property_sequences.last_number + 1,
        updated_at = NOW()
    RETURNING last_number INTO v_seq;

    RETURN v_prefix || '-P' || lpad(v_seq::TEXT, 4, '0');
END;
$function$;

-- 3. Overload viejo sin argumentos: la tabla ya no tiene year/current_number.
--    Nadie lo invoca (el trigger activo usa la versión con args), pero lo
--    dejamos delegando para que no pueda volver a romperse si alguien lo llama.
CREATE OR REPLACE FUNCTION public.generate_property_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    RETURN public.generate_property_code(NULL::uuid, 'manual');
END;
$function$;

-- 4. Broker auto-asignado en mensajes Zernio
CREATE OR REPLACE FUNCTION public.zernio_messages_set_broker_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.broker_id IS NULL AND NEW.conversation_id IS NOT NULL THEN
    SELECT c.broker_id INTO NEW.broker_id
    FROM public.zernio_conversations c
    WHERE c.id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$function$;

-- 5. Broker auto-asignado en conversaciones Zernio
--    (fix de columnas: leads.assigned_to / properties.agent_id)
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

  IF NEW.property_id IS NOT NULL THEN
    SELECT p.agent_id INTO NEW.broker_id
    FROM public.properties p
    WHERE p.id = NEW.property_id
      AND p.agent_id IS NOT NULL
    LIMIT 1;
  END IF;

  IF NEW.broker_id IS NULL AND NEW.lead_id IS NOT NULL THEN
    SELECT l.assigned_to INTO NEW.broker_id
    FROM public.leads l
    WHERE l.id = NEW.lead_id
      AND l.assigned_to IS NOT NULL
    LIMIT 1;
  END IF;

  IF NEW.broker_id IS NULL AND NEW.account_id IS NOT NULL THEN
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
