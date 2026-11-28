-- ============================================
-- 20261128000015 — Escalado visible para el agente y el dueño
-- ============================================
-- Estado real (28/11/2026): el cron `crm-operacion-proactiva` ya creaba una
-- alerta de supervisión por tarea vencida >7d, pero el agente no veía el
-- Centro de Supervisión (gate super_admin) y el lead no dejaba rastro: para
-- él la tarea seguía siendo "una más". El chip ESCALADA de Mi día ya existe;
-- ahora se completa la traza y el aviso al dueño del agente.
--
-- Misma firma `(integer, boolean)`: no crea sobrecarga. Sin dry_run escribe
-- exactamente una alerta + una nota por tarea, y la alerta queda asignada al
-- super_admin activo (dueño) en vez de al agente. `p_dry_run=true` cuenta sin
-- escribir nada. No se tocan tareas ni alertas históricas.
-- ============================================

CREATE OR REPLACE FUNCTION public.crm_escalar_tareas_vencidas(
  p_dias integer DEFAULT 7,
  p_dry_run boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  r record;
  v_n integer := 0;
  v_dias integer := GREATEST(COALESCE(p_dias, 7), 1);
  v_owner uuid;
  v_owner_nombre text := 'sin super_admin activo';
  v_agente_nombre text;
  v_vencimiento text;
BEGIN
  SELECT p.id, p.full_name INTO v_owner, v_owner_nombre
    FROM public.profiles p
   WHERE p.role::text = 'super_admin' AND p.is_active = true
   ORDER BY p.created_at ASC
   LIMIT 1;

  FOR r IN
    SELECT t.id AS task_id, t.lead_id, t.title, t.due_at,
           t.assigned_to AS task_agent, l.assigned_to AS lead_agent,
           l.full_name, pr.full_name AS agente_nombre
      FROM public.lead_tasks t
      JOIN public.leads l ON l.id = t.lead_id
      LEFT JOIN public.profiles pr ON pr.id = COALESCE(t.assigned_to, l.assigned_to)
     WHERE t.status IN ('pendiente', 'en_progreso')
       AND t.due_at < now() - (v_dias || ' days')::interval
       AND l.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.supervision_alerts a
          WHERE a.alert_type = 'task_overdue_escalated'
            AND a.evidence ->> 'task_id' = t.id::text)
     ORDER BY t.due_at ASC
  LOOP
    IF NOT COALESCE(p_dry_run, false) THEN
      v_agente_nombre := COALESCE(r.agente_nombre, 'sin agente');
      v_vencimiento := to_char(r.due_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY');

      INSERT INTO public.supervision_alerts (
        module, severity, alert_type, title, description, evidence, status,
        assigned_to, notes
      ) VALUES (
        'crm', 'high', 'task_overdue_escalated',
        'Tarea vencida hace más de ' || v_dias || ' días: ' || left(COALESCE(r.title, 'sin título'), 120),
        COALESCE(r.full_name, 'Lead') || ' · venció el ' || v_vencimiento
          || '. La tarea sigue abierta y nadie la escaló. Agente: ' || v_agente_nombre,
        jsonb_build_object(
          'task_id', r.task_id::text, 'lead_id', r.lead_id::text,
          'assigned_to', COALESCE(r.task_agent, r.lead_agent)::text,
          'agente', v_agente_nombre,
          'owner_notified', (v_owner IS NOT NULL)::text,
          'due_at', r.due_at, 'dias', v_dias),
        'open',
        COALESCE(v_owner, r.task_agent, r.lead_agent),
        'Aviso al dueño del agente: ' || v_agente_nombre
          || ' tiene una tarea vencida hace más de ' || v_dias
          || ' días (' || COALESCE(r.full_name, 'Lead') || '). Revisá Mi día → tareas vencidas.'
      );

      /* Traza en el timeline: el agente ve el escalado aunque no entre al
         Centro de Supervisión. La alerta ya es el dedup por tarea; el NOT
         EXISTS extra cubre una corrida simultánea. */
      IF NOT EXISTS (
        SELECT 1 FROM public.lead_activities la
         WHERE la.lead_id = r.lead_id
           AND la.activity_type = 'note'
           AND la.title = 'Tarea escalada automáticamente'
           AND la.description LIKE '%' || r.task_id::text || '%') THEN
        INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
        VALUES (r.lead_id, 'note', 'Tarea escalada automáticamente',
                'La tarea "' || left(COALESCE(r.title, 'sin título'), 160)
                || '" venció el ' || v_vencimiento || ' (> ' || v_dias
                || ' días). Agente: ' || v_agente_nombre
                || '. Aviso al dueño: ' || v_owner_nombre || '. Tarea ' || r.task_id::text);
      END IF;
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$function$;

-- Permisos intactos (sólo service_role; el cron corre como postgres).
