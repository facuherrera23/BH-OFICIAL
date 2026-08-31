-- El trigger de auditoría rompía TODOS los INSERT/UPDATE/DELETE sobre tablas
-- auditadas (leads, properties, ...): TG_TABLE_NAME es tipo `name` y el RPC
-- insert_audit_log espera text; la resolución por nombre no aplica cast.
-- Detectado vía callback RELA de prueba (lead no se creaba).
CREATE OR REPLACE FUNCTION public.audit_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_user_id uuid := auth.uid();
    v_role text;
    v_broker_id uuid;
    v_row jsonb;
    v_old_row jsonb;
    v_record_id uuid;
    v_entity_label text;
    v_module text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_row := to_jsonb(OLD);
        v_old_row := v_row;
    ELSE
        v_row := to_jsonb(NEW);
        v_old_row := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
    END IF;

    BEGIN
        v_record_id := NULLIF(v_row->>'id', '')::uuid;
    EXCEPTION WHEN others THEN
        v_record_id := NULL;
    END;

    IF v_user_id IS NOT NULL THEN
        SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_user_id;
        SELECT a.id INTO v_broker_id FROM public.agents a WHERE a.profile_id = v_user_id;
    END IF;

    v_module := CASE TG_TABLE_NAME
        WHEN 'properties' THEN 'properties'
        WHEN 'leads' THEN 'crm'
        WHEN 'visits' THEN 'agenda'
        WHEN 'agents' THEN 'brokers'
        WHEN 'owners' THEN 'owners'
        WHEN 'tasaciones' THEN 'tasaciones'
        WHEN 'ml_listings' THEN 'portales'
        WHEN 'site_content' THEN 'cms'
        WHEN 'app_settings' THEN 'config'
        ELSE TG_TABLE_NAME::text
    END;

    v_entity_label := COALESCE(
        v_row->>'property_code',
        v_row->>'title',
        v_row->>'full_name',
        v_row->>'client_name',
        v_row->>'key',
        v_row->>'id'
    );

    PERFORM public.insert_audit_log(
        p_user_id := v_user_id,
        p_role_snapshot := v_role,
        p_broker_id := v_broker_id,
        p_action := lower(TG_OP),
        p_module := v_module,
        p_table_name := TG_TABLE_NAME::text,
        p_record_id := v_record_id,
        p_entity_type := TG_TABLE_NAME::text,
        p_entity_id := v_record_id,
        p_entity_label := v_entity_label,
        p_old_data := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE v_old_row END,
        p_new_data := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE v_row END,
        p_changed_fields := NULL::text[],
        p_metadata := jsonb_build_object('trigger', TG_TABLE_NAME::text, 'op', TG_OP)
    );

    RETURN COALESCE(NEW, OLD);
END;
$function$;
