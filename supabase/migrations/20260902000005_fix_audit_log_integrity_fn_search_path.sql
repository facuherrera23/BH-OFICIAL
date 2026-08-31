-- audit_log_integrity_fn tenía SET search_path '' pero referenciaba audit_log
-- y calculate_event_hash sin esquema → todo INSERT en audit_log fallaba con
-- "relation audit_log does not exist" (rompía auditoría y cualquier insert
-- disparado por el trigger de tablas auditadas).
CREATE OR REPLACE FUNCTION public.audit_log_integrity_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_previous_hash text;
    v_event_hash text;
BEGIN
    SELECT event_hash INTO v_previous_hash
    FROM public.audit_log
    WHERE user_id = NEW.user_id
      AND created_at < NEW.created_at
    ORDER BY created_at DESC
    LIMIT 1;

    v_event_hash := public.calculate_event_hash(
        NEW.id,
        NEW.user_id,
        NEW.action,
        NEW.module,
        NEW.entity_type,
        NEW.entity_id,
        NEW.old_data,
        NEW.new_data,
        v_previous_hash
    );

    NEW.event_hash := v_event_hash;
    NEW.previous_hash := v_previous_hash;

    RETURN NEW;
END;
$function$;
