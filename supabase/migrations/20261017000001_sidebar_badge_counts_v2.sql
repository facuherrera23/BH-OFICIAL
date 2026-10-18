-- Sidebar F1 (#50): RPC extendida para alimentar TODOS los badges desde
-- una sola llamada. Agrega: leads nuevos 24h, tareas vencidas (leads/owners/total),
-- chat sin leer, propiedades estancadas (misma lógica que el dashboard: 30d sin
-- visita / 60d desde la última), estado ML (fallidos 24h + último evento) y
-- visitas de hoy (ART). SECURITY DEFINER: cruza tablas con RLS (zernio,
-- ml_webhook_events) pero solo expone agregados.
-- Aplicada en producción vía MCP el 2026-10-17 (sidebar_badge_counts_v2).

CREATE OR REPLACE FUNCTION public.get_sidebar_badge_counts(p_user_id uuid DEFAULT NULL::uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
declare
  v_props integer; v_leads integer; v_visits integer; v_owners integer; v_tasaciones integer;
  v_owner_tasks_overdue integer;
  v_leads_new_24h integer;
  v_lead_tasks_overdue integer;
  v_tasks_overdue_total integer;
  v_chat_unread_total integer;
  v_chat_unread_conversations integer;
  v_props_stale integer;
  v_ml_failed_24h integer;
  v_ml_last_event_at timestamptz;
  v_visits_today integer;
begin
  select count(*) into v_props from public.properties where is_published = true;
  select count(*) into v_leads from public.leads where deleted_at is null and stage not in ('cerrado_ganado', 'cerrado_perdido');
  select count(*) into v_visits from public.visits where status = 'pendiente';
  select count(*) into v_owners from public.owners where deleted_at is null;
  select count(*) into v_tasaciones from public.tasaciones;
  select count(*) into v_owner_tasks_overdue from public.owner_tasks where status in ('pendiente', 'en_progreso') and due_date < now();

  select count(*) into v_leads_new_24h from public.leads where deleted_at is null and created_at > now() - interval '24 hours';
  select count(*) into v_lead_tasks_overdue from public.lead_tasks where status in ('pendiente', 'en_progreso') and due_at < now();
  v_tasks_overdue_total := coalesce(v_lead_tasks_overdue, 0) + coalesce(v_owner_tasks_overdue, 0);

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
    'leads_new_24h', v_leads_new_24h,
    'lead_tasks_overdue', v_lead_tasks_overdue,
    'tasks_overdue_total', v_tasks_overdue_total,
    'chat_unread_total', v_chat_unread_total,
    'chat_unread_conversations', v_chat_unread_conversations,
    'properties_stale', v_props_stale,
    'ml_failed_24h', v_ml_failed_24h,
    'ml_last_event_at', v_ml_last_event_at,
    'visits_today', v_visits_today
  );
end;
$function$;

-- Nota: CREATE OR REPLACE conserva los grants existentes. Estado verificado
-- post-migración: authenticated ✓ EXECUTE / anon ✗ (P1 hardening) / service_role ✓.
