-- ---------------------------------------------------------------------------
-- MI BANDEJA — badge (2026-11-26): el contador del botón tiene que ser el
-- MISMO número que el "total" de la RPC mi_bandeja. Faltaba sumar los leads
-- vivos SIN AGENTE (9 hoy): el badge decía 24 y la bandeja 33.
-- Aditiva: CREATE OR REPLACE del badge. No toca filas.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_sidebar_badge_counts(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_props integer; v_leads integer; v_visits integer; v_owners integer; v_tasaciones integer;
  v_owner_tasks_overdue integer; v_lead_tasks_overdue integer;
  v_owner_tasks_soon integer; v_lead_tasks_soon integer;
  v_tasks_overdue_total integer;
  v_chat_unread_total integer; v_chat_unread_conversations integer;
  v_props_stale integer;
  v_ml_failed_24h integer; v_ml_last_event_at timestamptz;
  v_visits_today integer;
  v_leads_new_24h integer;
  v_alq_contracts integer;
  v_mi_bandeja integer; v_agent_id uuid; v_ver_todos boolean;
begin
  select count(*) into v_props from public.properties where is_published = true;
  select count(*) into v_leads from public.leads where deleted_at is null and stage not in ('cerrado_ganado', 'cerrado_perdido');
  select count(*) into v_visits from public.visits where status = 'pendiente';
  select count(*) into v_owners from public.owners where deleted_at is null and status = 'activo';
  select count(*) into v_tasaciones from public.tasaciones;
  select count(*) into v_owner_tasks_overdue
    from public.owner_tasks t
    join public.owners o on o.id = t.owner_id
   where t.status in ('pendiente', 'en_progreso') and t.due_date < now()
     and o.deleted_at is null and o.status = 'activo';
  select count(*) into v_owner_tasks_soon
    from public.owner_tasks t
    join public.owners o on o.id = t.owner_id
   where t.status in ('pendiente', 'en_progreso') and t.due_date >= now() and t.due_date <= now() + interval '24 hours'
     and o.deleted_at is null and o.status = 'activo';
  select count(*) into v_lead_tasks_overdue from public.lead_tasks where status in ('pendiente', 'en_progreso') and due_at < now();
  select count(*) into v_lead_tasks_soon from public.lead_tasks where status in ('pendiente', 'en_progreso') and due_at >= now() and due_at <= now() + interval '24 hours';
  v_tasks_overdue_total := coalesce(v_lead_tasks_overdue, 0) + coalesce(v_owner_tasks_overdue, 0);

  select count(*) into v_leads_new_24h from public.leads where deleted_at is null and created_at > now() - interval '24 hours';

  select coalesce(sum(unread_count), 0), count(*) filter (where unread_count > 0)
    into v_chat_unread_total, v_chat_unread_conversations
    from public.zernio_conversations;

  select count(*) into v_props_stale from public.properties p
    where p.is_published = true and p.deleted_at is null
      and coalesce(
        (select max(v.visit_date) from public.visits v where v.property_id = p.id),
        p.created_at
      ) < case
        when exists (select 1 from public.visits v2 where v2.property_id = p.id) then now() - interval '60 days'
        else now() - interval '30 days'
      end;

  select count(*) into v_ml_failed_24h from public.ml_webhook_events where status = 'failed' and received_at > now() - interval '24 hours';
  select max(received_at) into v_ml_last_event_at from public.ml_webhook_events;

  select count(*) into v_visits_today from public.visits
    where status = 'pendiente' and visit_date::date = (now() at time zone 'America/Argentina/Buenos_Aires')::date;

  select count(*) into v_alq_contracts
    from (
      select jsonb_array_elements(s.state->'props') prop
        from public.alquileres_state s
       where s.user_id = coalesce(p_user_id, auth.uid())
         and jsonb_typeof(s.state->'props') = 'array'
    ) x
    where substring(x.prop->>'fin' from 1 for 7) ~ '^[0-9]{4}-[0-9]{2}$'
      and ((substring(x.prop->>'fin' from 1 for 4)::int * 12 + substring(x.prop->>'fin' from 6 for 2)::int)
           - (date_part('year', now() at time zone 'America/Argentina/Buenos_Aires')::int * 12
              + date_part('month', now() at time zone 'America/Argentina/Buenos_Aires')::int)) between -3 and 2;

  -- mi bandeja (2026-11-26): lo que hay que atender HOY — seguimientos
  -- vencidos + tareas de lead vencidas (SÓLO leads vivos) + leads sin agente
  -- + consultas sin tocar. Mismo alcance y MISMA suma que mi_bandeja(p.id):
  -- el badge y el "total" de la bandeja no pueden decir números distintos.
  select a.id into v_agent_id
    from public.agents a
   where a.profile_id = coalesce(p_user_id, auth.uid())
     and a.status = 'activo' and a.deleted_at is null
   order by a.created_at limit 1;
  select coalesce(p.role in ('super_admin', 'broker'), false) into v_ver_todos
    from public.profiles p where p.id = coalesce(p_user_id, auth.uid());
  v_ver_todos := coalesce(v_ver_todos, false);
  select
      coalesce((select count(*) from public.leads l
                 where l.deleted_at is null
                   and l.stage not in ('cerrado_ganado', 'cerrado_perdido')
                   and l.next_followup_at is not null and l.next_followup_at < now()
                   and (v_ver_todos or l.assigned_to = v_agent_id)), 0)
    + coalesce((select count(*) from public.lead_tasks t
                  join public.leads l2 on l2.id = t.lead_id
                 where t.status in ('pendiente', 'en_progreso') and t.due_at < now()
                   and l2.deleted_at is null
                   and l2.stage not in ('cerrado_ganado', 'cerrado_perdido')
                   and (v_ver_todos or l2.assigned_to = v_agent_id)), 0)
    + coalesce((select count(*) from public.leads l4
                 where l4.deleted_at is null and l4.assigned_to is null
                   and l4.stage not in ('cerrado_ganado', 'cerrado_perdido')), 0)
    + coalesce((select count(*) from public.leads l3
                 where l3.deleted_at is null and l3.stage = 'nuevo'
                   and l3.last_contacted_at is null
                   and (v_ver_todos or l3.assigned_to = v_agent_id or l3.assigned_to is null)), 0)
    into v_mi_bandeja;

  return json_build_object(
    'properties', v_props,
    'leads', v_leads,
    'visits', v_visits,
    'owners', v_owners,
    'tasaciones', v_tasaciones,
    'owner_tasks_overdue', v_owner_tasks_overdue,
    'owner_tasks_soon', v_owner_tasks_soon,
    'lead_tasks_overdue', v_lead_tasks_overdue,
    'lead_tasks_soon', v_lead_tasks_soon,
    'tasks_overdue_total', v_tasks_overdue_total,
    'leads_new_24h', v_leads_new_24h,
    'chat_unread_total', v_chat_unread_total,
    'chat_unread_conversations', v_chat_unread_conversations,
    'properties_stale', v_props_stale,
    'ml_failed_24h', v_ml_failed_24h,
    'ml_last_event_at', v_ml_last_event_at,
    'visits_today', v_visits_today,
    'alq_contracts_expiring', v_alq_contracts,
    'mi_bandeja', coalesce(v_mi_bandeja, 0)
  );
end;
$function$;
