-- Fix get_visit_by_token: la variable record "v" colisionaba con el alias de
-- tabla "v" -> PL/pgSQL resolvia v.id como campo del record sin asignar ->
-- error 55000 en CADA llamada (tokens validos incluidos) -> HTTP 500 en
-- confirmar-visita.html. Renombrado a rec/vis para eliminar la ambigüedad.

create or replace function public.get_visit_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  rec record;
begin
  begin
    select vis.id, vis.client_name, vis.client_phone, vis.visit_date, vis.duration_minutes,
           vis.notes, vis.status::text as status, a.full_name as agent_name, a.phone as agent_phone,
           p.title as property_title, p.property_code, p.address as property_address, p.zone as property_zone
      into rec
    from public.visits vis
    left join public.agents a on a.id = vis.agent_id
    left join public.properties p on p.id = vis.property_id
    where vis.confirmation_token = p_token
    limit 1;
  exception when invalid_text_representation then
    return null;
  end;

  if not found then return null; end if;

  return jsonb_build_object(
    'id', rec.id,
    'client_name', rec.client_name,
    'client_phone', rec.client_phone,
    'visit_date', rec.visit_date,
    'duration_minutes', rec.duration_minutes,
    'notes', rec.notes,
    'status', rec.status,
    'agents', jsonb_build_object('full_name', rec.agent_name, 'phone', rec.agent_phone),
    'property', jsonb_build_object('title', rec.property_title, 'property_code', rec.property_code, 'address', rec.property_address, 'zone', rec.property_zone)
  );
end;
$function$;
