-- Sidebar v3: conteo de tareas por vencer en 24h (leads y propietarios).
-- Complementa v2: vencidas = rojo (urgente), por vencer 24h = ámbar (próximo).
-- Aplicada en producción vía MCP el 2026-10-18 (sidebar_badge_counts_v3_tasks_soon).

CREATE OR REPLACE FUNCTION public.get_sidebar_badge_counts(p_user_id uuid DEFAULT NULL::uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
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
begin
  select count(*) into v_props from public.properties where is_published = true;
  select count(*) into v_leads from public.leads where deleted_at is null and stage not in ('cerrado_ganado', 'cerrado_perdido');
  select count(*) into v_visits from public.visits where status = 'pendiente';
  select count(*) into v_owners from public.owners where deleted_at is null;
  select count(*) into v_tasaciones from public.tasaciones;
  select count(*) into v_owner_tasks_overdue from public.owner_tasks where status in ('pendiente', 'en_progreso') and due_date < now();
  select count(*) into v_owner_tasks_soon from public.owner_tasks where status in ('pendiente', 'en_progreso') and due_date >= now() and due_date <= now() + interval '24 hours';
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
    'visits_today', v_visits_today
  );
end;
$function$;

-- Nota: CREATE OR REPLACE conserva grants. Estado verificado post-migración:
-- authenticated ✓ / anon ✗ (P1 hardening intacto).
