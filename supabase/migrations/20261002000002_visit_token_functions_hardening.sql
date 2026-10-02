-- Hardening funciones públicas de visita: un token malformado (no-uuid) hacía
-- explotar el cast implícito uuid = text y PostgREST devolvía HTTP 500.
-- Ahora se trata igual que un token válido inexistente (null / ok:false).

create or replace function public.get_visit_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v record;
begin
  begin
    select v.id, v.client_name, v.client_phone, v.visit_date, v.duration_minutes,
           v.notes, v.status::text as status, a.full_name as agent_name, a.phone as agent_phone,
           p.title as property_title, p.property_code, p.address as property_address, p.zone as property_zone
      into v
    from public.visits v
    left join public.agents a on a.id = v.agent_id
    left join public.properties p on p.id = v.property_id
    where v.confirmation_token = p_token
    limit 1;
  exception when invalid_text_representation then
    return null;
  end;

  if not found then return null; end if;

  return jsonb_build_object(
    'id', v.id,
    'client_name', v.client_name,
    'client_phone', v.client_phone,
    'visit_date', v.visit_date,
    'duration_minutes', v.duration_minutes,
    'notes', v.notes,
    'status', v.status,
    'agents', jsonb_build_object('full_name', v.agent_name, 'phone', v.agent_phone),
    'property', jsonb_build_object('title', v.property_title, 'property_code', v.property_code, 'address', v.property_address, 'zone', v.property_zone)
  );
end;
$function$;

create or replace function public.update_visit_status_by_token(p_token text, p_action text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
DECLARE
  v_new_status public.visit_status;
  v_updated integer := 0;
BEGIN
  IF lower(p_action) = 'confirmar' THEN
    v_new_status := 'confirmada'::public.visit_status;
  ELSIF lower(p_action) = 'cancelar' THEN
    v_new_status := 'cancelada'::public.visit_status;
  ELSIF lower(p_action) = 'checkin' THEN
    BEGIN
      UPDATE public.visits v
         SET check_in = COALESCE(v.check_in, now()),
             status = CASE
                        WHEN v.status IN ('pendiente','confirmada') THEN 'en_curso'::public.visit_status
                        ELSE v.status
                      END,
             updated_at = now()
       WHERE v.confirmation_token = p_token
         AND v.status IN ('pendiente','confirmada','en_curso');
      GET DIAGNOSTICS v_updated = ROW_COUNT;
    EXCEPTION WHEN invalid_text_representation THEN
      v_updated := 0;
    END;
    IF v_updated = 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'visita no encontrada o ya cerrada');
    END IF;
    RETURN jsonb_build_object('ok', true, 'status', 'en_curso');
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'accion no valida');
  END IF;

  BEGIN
    UPDATE public.visits v
       SET status = v_new_status,
           updated_at = now(),
           confirmed_at = CASE WHEN lower(p_action) = 'confirmar' THEN now() ELSE v.confirmed_at END,
           cancel_reason = CASE WHEN lower(p_action) = 'cancelar' THEN COALESCE(p_reason, 'Cancelado por el cliente') ELSE v.cancel_reason END
     WHERE v.confirmation_token = p_token
       AND v.status = 'pendiente'::public.visit_status;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  EXCEPTION WHEN invalid_text_representation THEN
    v_updated := 0;
  END;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'visita no encontrada o no pendiente');
  END IF;

  RETURN jsonb_build_object('ok', true, 'status', v_new_status);
END;
$function$;
