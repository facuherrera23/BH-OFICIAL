-- ---------------------------------------------------------------------------
-- P1-6 (2026-11-27): ETAPA "EN ESPERA" — hygiene de followup y de alertas.
--
-- Lo que encontró la verificación en vivo (transacción + ROLLBACK):
--
-- BUG 4 — la alerta de supervisión reclamaba al lead colgado.
--   `crm_queue_followup_alerts` seleccionaba todo lead con
--   `next_followup_at < now()` y etapa no terminal. Con la etapa nueva, un
--   lead colgado dispara la misma alerta que un follow-up olvidado: el
--   agente recibe el aviso de un lead que él mismo colgó a propósito.
--   Fix: la alerta excluye `en_espera` (el lead colgado vuelve a la BANDEJA,
--   que es el canal de trabajo diario) y las alertas viejas de un lead que
--   se acaba de colgar se auto-resuelven (mismo patrón de las alertas de
--   visitas, ya saneado en 20261127000002).
--
-- BUG 5 — un contacto posterior vaciaba la fecha de regreso.
--   `leads_followup_on_contact` (AFTER INSERT sobre lead_activities con tipo
--   'call'/'note') pone `next_followup_at = NULL`: si el agente registraba
--   una nota o una llamada sobre un lead colgado, el lead perdía su fecha de
--   vuelta y NUNCA MÁS volvía a la bandeja (quedaba colgado para siempre).
--   Fix (2 capas):
--     a) el trigger respeta la fecha de regreso de un lead colgado;
--     b) trigger BEFORE UPDATE en `leads`: si alguien intenta vaciar el
--        followup de un lead en espera, se restaura el valor anterior.
--        (Protege TODOS los caminos: front, edge functions y SQL.)
--
-- BUG 6 — colgar un lead se contaba como "contacto con el cliente".
--   La actividad "Lead en espera" se insertaba como 'note' → el trigger
--   `leads_followup_on_contact` movía `last_contacted_at` → el lead
--   aparentaba haber sido contactado recién (y el embudo mentía: "días sin
--   contacto" = 0). Colgar NO es un contacto: la actividad va como
--   'status_change' (igual que la de reactivar).
--
-- Aditiva: CREATE OR REPLACE de funciones + un trigger. No borra filas.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- BUG 5a: un lead colgado conserva su fecha de regreso.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.leads_followup_on_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if NEW.activity_type in ('call', 'note') then
    update public.leads
       set next_followup_at = case
             /* P1-6: un lead colgado conserva su fecha de regreso (si no,
                un contacto posterior lo dejaba sin vuelta para siempre). */
             when stage::text = 'en_espera' then next_followup_at
             else null
           end,
           last_contacted_at = greatest(NEW.created_at, coalesce(last_contacted_at, NEW.created_at))
     where id = NEW.lead_id;
  end if;
  return NEW;
end;
$function$;

-- ---------------------------------------------------------------------------
-- BUG 5b: red de seguridad a nivel de columna (protege cualquier vía).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_leads_espera_keep_followup()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  /* Un lead en espera NUNCA puede quedarse sin fecha de regreso: si un
     update externo la vacía (front, edge function o SQL), se restaura la
     anterior. La RPC `lead_pasar_a_espera` siempre manda una fecha nueva
     (no nula) → no le afecta. Al reactivar, la etapa cambia → tampoco. */
  IF NEW.stage::text = 'en_espera'
     AND NEW.next_followup_at IS NULL
     AND OLD.next_followup_at IS NOT NULL THEN
    NEW.next_followup_at := OLD.next_followup_at;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_leads_espera_keep_followup ON public.leads;
CREATE TRIGGER trg_leads_espera_keep_followup
  BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.trg_leads_espera_keep_followup();

-- ---------------------------------------------------------------------------
-- BUG 4: la alerta de follow-up vencido ignora a los leads colgados.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_queue_followup_alerts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  inserted int := 0;
  r record;
  v_fallback uuid;
begin
  select id into v_fallback from public.profiles
   where role = 'super_admin' and is_active
   order by created_at limit 1;

  for r in
    select l.id, l.full_name, l.next_followup_at, l.assigned_to,
           a.profile_id as agent_profile_id
    from leads l
    left join agents a on a.id = l.assigned_to
    where l.deleted_at is null
      and l.next_followup_at is not null
      and l.next_followup_at < now()
      /* P1-6: un lead colgado NO es un follow-up olvidado — vuelve a la
         bandeja, que es el canal de trabajo diario. La alerta lo reclamaría
         dos veces por lo mismo. */
      and l.stage not in ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
  loop
    if not exists (
      select 1 from supervision_alerts s
      where s.alert_type = 'lead_followup_overdue'
        and s.evidence->>'lead_id' = r.id::text
        and s.status in ('open', 'assigned', 'investigating')
    ) then
      insert into supervision_alerts
        (user_id, module, severity, alert_type, title, description, evidence, status)
      values
        (coalesce(r.agent_profile_id, v_fallback), 'crm', 'medium', 'lead_followup_overdue',
         'Follow-up vencido: ' || coalesce(r.full_name, 'Lead'),
         'El seguimiento de ' || coalesce(r.full_name, 'este lead') || ' venció el ' ||
           to_char(r.next_followup_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI'),
         jsonb_build_object('lead_id', r.id, 'due_at', r.next_followup_at, 'assigned_to', r.assigned_to),
         'open');
      inserted := inserted + 1;
    end if;
  end loop;

  update supervision_alerts s
     set status = 'resolved', resolved_at = now()
   where s.alert_type = 'lead_followup_overdue'
     and s.status in ('open', 'assigned', 'investigating')
     and exists (
       select 1 from leads l
       where l.id::text = s.evidence->>'lead_id'
         and (l.deleted_at is not null
              or l.stage in ('cerrado_ganado', 'cerrado_perdido')
              /* P1-6: si el lead se colgó, su alerta vieja se cierra (ya no
                 corresponde: el lead vuelve a la bandeja). */
              or l.stage = 'en_espera'
              or l.next_followup_at is null
              or l.next_followup_at > now())
     );
  return inserted;
end;
$function$;

-- ---------------------------------------------------------------------------
-- BUG 6: colgar un lead NO es un contacto con el cliente.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lead_pasar_a_espera(
  p_lead_id uuid,
  p_hasta timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_lead public.leads%rowtype;
  v_hasta timestamptz;
  v_stage_previo text;
  v_tareas integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'sin sesion');
  END IF;

  SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_uid;

  SELECT l.* INTO v_lead FROM public.leads l WHERE l.id = p_lead_id;
  IF NOT FOUND OR v_lead.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'el lead no existe');
  END IF;

  IF NOT (
       v_role = 'super_admin'
    OR EXISTS (SELECT 1 FROM public.agents a WHERE a.id = v_lead.assigned_to AND a.profile_id = v_uid)
    OR EXISTS (SELECT 1 FROM public.agents a WHERE a.id = v_lead.created_by AND a.profile_id = v_uid)
  ) THEN
    RAISE EXCEPTION 'No tenés permiso sobre este lead' USING ERRCODE = '42501';
  END IF;

  IF v_lead.stage::text IN ('cerrado_ganado', 'cerrado_perdido') THEN
    RETURN jsonb_build_object('error', 'el lead ya está cerrado');
  END IF;

  v_hasta := COALESCE(p_hasta, now() + interval '7 days');
  IF v_hasta <= now() THEN
    v_hasta := now() + interval '1 day';
  END IF;

  v_stage_previo := CASE
    WHEN v_lead.stage::text = 'en_espera' THEN v_lead.stage_previo
    ELSE v_lead.stage::text
  END;

  /* ORDEN IMPORTANTE (P1-6):
     1) las tareas se suspenden (su trigger recalcula el followup del lead),
     2) la actividad se escribe (activity_type 'status_change': colgar NO es
        un contacto con el cliente → no debe mover last_contacted_at),
     3) el lead se actualiza AL FINAL con la fecha de regreso. */

  UPDATE public.lead_tasks
     SET status = 'en_espera', updated_at = now()
   WHERE lead_id = p_lead_id AND status IN ('pendiente', 'en_progreso');
  GET DIAGNOSTICS v_tareas = ROW_COUNT;

  INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
  VALUES (
    p_lead_id, 'status_change', 'Lead en espera',
    'El lead quedó en espera hasta el '
      || to_char(v_hasta at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI')
      || '. Vuelve solo a la bandeja cuando llegue esa fecha; se reactivan '
      || v_tareas || ' tarea(s) en el momento.'
  );

  UPDATE public.leads
     SET stage = 'en_espera',
         stage_previo = v_stage_previo,
         next_followup_at = v_hasta,
         updated_at = now()
   WHERE id = p_lead_id;

  PERFORM public.insert_audit_log(
    p_user_id := v_uid,
    p_role_snapshot := v_role,
    p_action := 'lead_en_espera',
    p_module := 'crm',
    p_table_name := 'leads',
    p_record_id := p_lead_id,
    p_entity_type := 'leads',
    p_entity_id := p_lead_id,
    p_entity_label := v_lead.full_name,
    p_metadata := jsonb_build_object('hasta', v_hasta, 'stage_previo', v_stage_previo, 'tareas_suspendidas', v_tareas)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'lead_id', p_lead_id,
    'hasta', v_hasta,
    'stage_previo', v_stage_previo,
    'tareas_suspendidas', v_tareas
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.lead_pasar_a_espera(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_pasar_a_espera(uuid, timestamptz) TO authenticated, service_role;
