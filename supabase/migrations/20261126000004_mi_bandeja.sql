-- ---------------------------------------------------------------------------
-- MI BANDEJA (2026-11-26): "lo que hay que atender HOY" en un solo lugar.
--
-- El problema medido en producción: la información existe pero está repartida
-- en 5 lugares y nadie la ve — 21 tareas de lead vencidas (13 de un solo
-- agente), 6 seguimientos con fecha vencida, 9 leads vivos sin agente y 10
-- consultas de ZonaProp nunca contactadas.
--
-- 1) RPC mi_bandeja(p_user_id): devuelve en UNA llamada las 5 secciones
--    accionables, con alcance por rol:
--      · super_admin / broker → ven TODO el equipo.
--      · agente activo        → lo suyo + lo sin dueño (que puede reclamar).
--    Secciones:
--      seguimientos → leads vivos con next_followup_at vencido.
--      tareas       → lead_tasks pendientes con due_at vencido.
--      visitas      → visitas pendientes/confirmadas de los próximos 7 días.
--      sin_agente   → leads vivos sin assigned_to.
--      sin_tocar    → leads en stage='nuevo' sin ningún contacto.
--    Cada fila trae 'mios' (si el caller puede escribir el lead según RLS)
--    y 'telefono' listo para el link de WhatsApp.
--
-- 2) get_sidebar_badge_counts v4: suma la clave 'mi_bandeja' (seguimientos +
--    tareas + sin tocar, MISMO alcance por rol) para que el botón del panel
--    muestre el contador sin una RPC extra. Aditivo: las claves anteriores
--    quedan idénticas.
--
-- Aditiva: no toca filas. Ambas funciones son SECURITY DEFINER con EXECUTE
-- para authenticated (nunca anon) — el club de funciones internas del CRM.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mi_bandeja(p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := COALESCE(p_user_id, auth.uid());
  v_role text;
  v_agent uuid;
  v_ver_todos boolean;
  v_seg jsonb; v_tar jsonb; v_vis jsonb; v_sin jsonb; v_sto jsonb;
  v_seg_total integer; v_tar_total integer; v_vis_total integer;
  v_sin_total integer; v_sto_total integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'sin sesion');
  END IF;

  SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_uid;
  SELECT a.id INTO v_agent
    FROM public.agents a
   WHERE a.profile_id = v_uid AND a.status = 'activo' AND a.deleted_at IS NULL
   ORDER BY a.created_at
   LIMIT 1;
  v_ver_todos := (v_role IN ('super_admin', 'broker'));

  -- 1) Seguimientos vencidos (leads vivos con next_followup_at ya pasado).
  WITH seg AS (
    SELECT l.id AS lead_id, l.full_name AS nombre, l.stage, l.source,
           l.next_followup_at AS vence,
           COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono,
           l.lead_score AS score, a.full_name AS agente,
           (l.assigned_to IS NOT DISTINCT FROM v_agent) AS mios
      FROM public.leads l
      LEFT JOIN public.agents a ON a.id = l.assigned_to
     WHERE l.deleted_at IS NULL
       AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido')
       AND l.next_followup_at IS NOT NULL AND l.next_followup_at < now()
       AND (v_ver_todos OR l.assigned_to = v_agent)
     ORDER BY l.next_followup_at ASC
     LIMIT 20
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'lead_id', lead_id, 'nombre', nombre, 'stage', stage, 'source', source,
           'vence', vence, 'telefono', telefono, 'score', score,
           'agente', agente, 'mios', mios) ORDER BY vence NULLS LAST), '[]'::jsonb)
    INTO v_seg
    FROM seg;

  SELECT count(*) INTO v_seg_total
    FROM public.leads l
   WHERE l.deleted_at IS NULL
     AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido')
     AND l.next_followup_at IS NOT NULL AND l.next_followup_at < now()
     AND (v_ver_todos OR l.assigned_to = v_agent);

  -- 2) Tareas de lead vencidas (pendientes con due_at ya pasado).
  WITH tar AS (
    SELECT t.id AS tarea_id, t.lead_id, t.title, t.due_at,
           COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono,
           l.full_name AS nombre, l.stage, a.full_name AS agente,
           (l.assigned_to IS NOT DISTINCT FROM v_agent) AS mios
      FROM public.lead_tasks t
      JOIN public.leads l ON l.id = t.lead_id
      LEFT JOIN public.agents a ON a.id = l.assigned_to
     WHERE t.status IN ('pendiente', 'en_progreso')
       AND t.due_at < now()
       AND l.deleted_at IS NULL
       AND (v_ver_todos OR l.assigned_to = v_agent)
     ORDER BY t.due_at ASC
     LIMIT 20
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'tarea_id', tarea_id, 'lead_id', lead_id, 'title', title, 'due_at', due_at,
           'telefono', telefono, 'nombre', nombre, 'stage', stage,
           'agente', agente, 'mios', mios) ORDER BY due_at NULLS LAST), '[]'::jsonb)
    INTO v_tar
    FROM tar;

  SELECT count(*) INTO v_tar_total
    FROM public.lead_tasks t
    JOIN public.leads l ON l.id = t.lead_id
   WHERE t.status IN ('pendiente', 'en_progreso')
     AND t.due_at < now()
     AND l.deleted_at IS NULL
     AND (v_ver_todos OR l.assigned_to = v_agent);

  -- 3) Visitas próximas (pendientes/confirmadas de los próximos 7 días).
  WITH vis AS (
    SELECT v.id AS visita_id, v.lead_id, v.client_name, v.client_phone,
           v.visit_date, v.status,
           p.property_code, p.title AS propiedad,
           (v.agent_id IS NOT DISTINCT FROM v_agent) AS mios
      FROM public.visits v
      LEFT JOIN public.properties p ON p.id = v.property_id
     WHERE v.deleted_at IS NULL
       AND v.status IN ('pendiente', 'confirmada')
       AND v.visit_date >= now()
       AND v.visit_date <= now() + interval '7 days'
       AND (v_ver_todos OR v.agent_id = v_agent)
     ORDER BY v.visit_date ASC
     LIMIT 10
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'visita_id', visita_id, 'lead_id', lead_id, 'client_name', client_name,
           'telefono', client_phone, 'visit_date', visit_date, 'status', status,
           'property_code', property_code, 'propiedad', propiedad, 'mios', mios)
           ORDER BY visit_date NULLS LAST), '[]'::jsonb)
    INTO v_vis
    FROM vis;

  SELECT count(*) INTO v_vis_total
    FROM public.visits v
   WHERE v.deleted_at IS NULL
     AND v.status IN ('pendiente', 'confirmada')
     AND v.visit_date >= now()
     AND v.visit_date <= now() + interval '7 days'
     AND (v_ver_todos OR v.agent_id = v_agent);

  -- 4) Leads vivos sin agente (nadie es dueño — cualquiera puede reclamarlos).
  WITH sin AS (
    SELECT l.id AS lead_id, l.full_name AS nombre, l.stage, l.source, l.created_at,
           COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono, l.lead_score AS score
      FROM public.leads l
     WHERE l.deleted_at IS NULL
       AND l.assigned_to IS NULL
       AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido')
     ORDER BY l.created_at DESC
     LIMIT 20
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'lead_id', lead_id, 'nombre', nombre, 'stage', stage, 'source', source,
           'created_at', created_at, 'telefono', telefono, 'score', score, 'mios', false)
           ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_sin
    FROM sin;

  SELECT count(*) INTO v_sin_total
    FROM public.leads l
   WHERE l.deleted_at IS NULL
     AND l.assigned_to IS NULL
     AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido');

  -- 5) Consultas sin tocar (stage='nuevo' sin ningún contacto registrado).
  WITH sto AS (
    SELECT l.id AS lead_id, l.full_name AS nombre, l.stage, l.source, l.created_at,
           COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono, l.lead_score AS score,
           a.full_name AS agente,
           (l.assigned_to IS NOT DISTINCT FROM v_agent) AS mios
      FROM public.leads l
      LEFT JOIN public.agents a ON a.id = l.assigned_to
     WHERE l.deleted_at IS NULL
       AND l.stage = 'nuevo'
       AND l.last_contacted_at IS NULL
       AND (v_ver_todos OR l.assigned_to = v_agent OR l.assigned_to IS NULL)
     ORDER BY l.created_at ASC
     LIMIT 20
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'lead_id', lead_id, 'nombre', nombre, 'stage', stage, 'source', source,
           'created_at', created_at, 'telefono', telefono, 'score', score,
           'agente', agente, 'mios', mios) ORDER BY created_at ASC), '[]'::jsonb)
    INTO v_sto
    FROM sto;

  SELECT count(*) INTO v_sto_total
    FROM public.leads l
   WHERE l.deleted_at IS NULL
     AND l.stage = 'nuevo'
     AND l.last_contacted_at IS NULL
     AND (v_ver_todos OR l.assigned_to = v_agent OR l.assigned_to IS NULL);

  RETURN jsonb_build_object(
    'generado', now(),
    'ver_todos', v_ver_todos,
    'agente_id', v_agent,
    'seguimientos', v_seg,   'seguimientos_total', COALESCE(v_seg_total, 0),
    'tareas', v_tar,         'tareas_total', COALESCE(v_tar_total, 0),
    'visitas', v_vis,        'visitas_total', COALESCE(v_vis_total, 0),
    'sin_agente', v_sin,     'sin_agente_total', COALESCE(v_sin_total, 0),
    'sin_tocar', v_sto,      'sin_tocar_total', COALESCE(v_sto_total, 0),
    'total', COALESCE(v_seg_total, 0) + COALESCE(v_tar_total, 0)
           + COALESCE(v_sin_total, 0) + COALESCE(v_sto_total, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mi_bandeja(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mi_bandeja(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.mi_bandeja(uuid) IS
  'Mi bandeja: lo que hay que atender HOY (seguimientos vencidos, tareas vencidas, visitas próximas, leads sin agente, consultas sin tocar) — alcance por rol.';

-- ---------------------------------------------------------------------------
-- get_sidebar_badge_counts v4: agrega 'mi_bandeja' (MISMO alcance por rol que
-- la RPC de arriba) para pintar el contador del botón sin una RPC extra.
-- El resto del cuerpo queda byte a byte igual que la v3.
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
  -- vencidos + tareas de lead vencidas + consultas sin tocar. Alcance:
  -- super_admin/broker ven todo; un agente, lo suyo y lo sin dueño.
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
                   and (v_ver_todos or l2.assigned_to = v_agent_id)), 0)
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
