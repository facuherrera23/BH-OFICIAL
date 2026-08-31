-- profiles_sensitive_audit_fn: SET search_path='' con tablas sin esquema y
-- `text[] || 'role'` con literal sin tipo ("malformed array literal").
-- Rompía cualquier UPDATE sobre profiles (cambios de rol, is_active, email),
-- incluida la asignación de roles desde el panel de Usuarios.
CREATE OR REPLACE FUNCTION public.profiles_sensitive_audit_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_user_id uuid := auth.uid();
    v_role text;
    v_broker_id uuid;
    v_changed text[] := ARRAY[]::text[];
BEGIN
    IF OLD.role IS DISTINCT FROM NEW.role THEN v_changed := array_append(v_changed, 'role'); END IF;
    IF OLD.is_active IS DISTINCT FROM NEW.is_active THEN v_changed := array_append(v_changed, 'is_active'); END IF;
    IF OLD.email IS DISTINCT FROM NEW.email THEN v_changed := array_append(v_changed, 'email'); END IF;

    IF array_length(v_changed, 1) IS NULL THEN
        RETURN NEW;
    END IF;

    IF v_user_id IS NOT NULL THEN
        SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_user_id;
        SELECT a.id INTO v_broker_id FROM public.agents a WHERE a.profile_id = v_user_id;
    END IF;

    PERFORM public.insert_audit_log(
        p_user_id := v_user_id,
        p_role_snapshot := v_role,
        p_broker_id := v_broker_id,
        p_action := 'update_sensitive',
        p_module := 'users',
        p_table_name := 'profiles',
        p_record_id := NEW.id,
        p_entity_type := 'user',
        p_entity_id := NEW.id,
        p_entity_label := COALESCE(NULLIF(NEW.full_name, ''), NULLIF(NEW.email, ''), NEW.id::text),
        p_old_data := to_jsonb(OLD),
        p_new_data := to_jsonb(NEW),
        p_changed_fields := v_changed,
        p_metadata := jsonb_build_object(
            'sensitive_fields_changed', to_jsonb(v_changed),
            'privilege_escalation', (NEW.role = 'super_admin' AND OLD.role IS DISTINCT FROM NEW.role)
        )
    );

    RETURN NEW;
END;
$function$;
