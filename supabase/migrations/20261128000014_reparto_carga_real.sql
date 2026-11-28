-- ============================================
-- 20261128000014 — Reparto con carga real y vetos
-- ============================================
-- Hallazgo real (28/11/2026): los 5 leads huérfanos que quedaban estaban
-- cerrados (no se reparten), pero la RPC seguía aceptando cualquier lead
-- vivo sin dueño, incluso uno ya trabajado, y nivelaba contando SOLAMENTE
-- leads. Un agente con 2 leads pero 12 tareas abiertas seguía "menos cargado"
-- que otro con 3 leads y 0 tareas.
--
-- Cambios (misma firma, sin sobrecarga nueva):
--   · veto: sólo leads en stage 'nuevo' y SIN actividad en el timeline;
--   · carga real: leads vivos + tareas abiertas de lead + tareas de
--     propietario (las tareas pesan el doble, son trabajo concreto);
--   · el detalle y la traza explican el motivo del reparto.
--
-- p_dry_run=true calcula exactamente lo mismo y NO escribe: ni leads, ni
-- timeline, ni auditoría, ni alertas. El cron `lead-reparto-daily` sigue
-- llamando sin argumentos (default false). No se toca ningún dato existente.
-- ============================================

CREATE OR REPLACE FUNCTION public.repartir_leads_sin_agente(p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_orphan RECORD;
  v_agent RECORD;
  v_asignados integer := 0;
  v_detalle jsonb := '[]'::jsonb;
  v_es_preview boolean := COALESCE(p_dry_run, false);
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_uid;
    IF v_role NOT IN ('super_admin', 'broker') THEN
      RAISE EXCEPTION 'Solo super_admin o broker pueden repartir leads';
    END IF;
  END IF;

  /* Carga real por agente activo. Las tareas abiertas pesan el doble porque
     son trabajo en curso; los leads en espera NO cuentan (están colgados a
     propósito). Un agente inactivo o borrado queda fuera del reparto. */
  CREATE TEMP TABLE _reparto_carga ON COMMIT DROP AS
    SELECT a.id, a.full_name,
           (SELECT count(*) FROM public.leads l
             WHERE l.assigned_to = a.id AND l.deleted_at IS NULL
               AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')) AS leads_vivos,
           (SELECT count(DISTINCT t.id) FROM public.lead_tasks t
             LEFT JOIN public.leads l ON l.id = t.lead_id
             WHERE t.status IN ('pendiente', 'en_progreso')
               AND COALESCE(t.assigned_to, l.assigned_to) = a.id) AS tareas_abiertas,
           (SELECT count(*) FROM public.owner_tasks ot
             WHERE ot.assigned_to = a.id
               AND ot.status IN ('pendiente', 'en_progreso')) AS tareas_owner,
           (SELECT count(*) FROM public.leads l
             WHERE l.assigned_to = a.id AND l.deleted_at IS NULL
               AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera'))
           + 2 * (SELECT count(DISTINCT t.id) FROM public.lead_tasks t
             LEFT JOIN public.leads l ON l.id = t.lead_id
             WHERE t.status IN ('pendiente', 'en_progreso')
               AND COALESCE(t.assigned_to, l.assigned_to) = a.id)
           + (SELECT count(*) FROM public.owner_tasks ot
             WHERE ot.assigned_to = a.id
               AND ot.status IN ('pendiente', 'en_progreso')) AS carga
      FROM public.agents a
     WHERE a.status = 'activo' AND a.deleted_at IS NULL;

  IF NOT EXISTS (SELECT 1 FROM _reparto_carga) THEN
    IF NOT v_es_preview THEN
      INSERT INTO public.supervision_alerts
        (user_id, module, severity, alert_type, title, description, evidence, status)
      VALUES
        (v_uid, 'crm', 'high', 'leads_sin_agente',
         'Leads nuevos sin agente y sin agentes activos',
         'El reparto automático no encontró agentes activos: hay leads nuevos sin dueño que nadie va a atender.',
         jsonb_build_object('funcion', 'repartir_leads_sin_agente'),
         'open');
    END IF;
    RETURN jsonb_build_object('asignados', 0, 'alerta', true,
                              'motivo', 'sin agentes activos', 'dry_run', v_es_preview);
  END IF;

  /* Veto: ONLY leads nuevos y sin rastro en el timeline. Los cerrados, los
     colgados y los que alguien ya tocó NO se mueven: repartirlos rompería el
     contexto y es exactamente el ruido que había en la bandeja. */
  FOR v_orphan IN
    SELECT l.id, l.full_name, l.source, l.created_at
      FROM public.leads l
     WHERE l.deleted_at IS NULL
       AND l.assigned_to IS NULL
       AND l.stage::text = 'nuevo'
       AND NOT EXISTS (
         SELECT 1 FROM public.lead_activities la WHERE la.lead_id = l.id)
     ORDER BY l.created_at ASC
  LOOP
    SELECT c.id, c.full_name, c.carga, c.leads_vivos, c.tareas_abiertas
      INTO v_agent
      FROM _reparto_carga c
     ORDER BY c.carga ASC, c.id ASC
     LIMIT 1;

    IF v_es_preview THEN
      UPDATE _reparto_carga
         SET carga = carga + 1, leads_vivos = leads_vivos + 1
       WHERE id = v_agent.id;
      v_asignados := v_asignados + 1;
    ELSE
      UPDATE public.leads SET assigned_to = v_agent.id
       WHERE id = v_orphan.id AND assigned_to IS NULL;

      IF FOUND THEN
        UPDATE _reparto_carga
           SET carga = carga + 1, leads_vivos = leads_vivos + 1
         WHERE id = v_agent.id;
        INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
        VALUES (v_orphan.id, 'note',
                'Lead asignado a ' || v_agent.full_name,
                'Reparto automático de lead NUEVO sin agente (carga real: '
                || v_agent.tareas_abiertas || ' tareas abiertas y '
                || v_agent.leads_vivos || ' leads vivos).');
        v_asignados := v_asignados + 1;
      END IF;
    END IF;

    v_detalle := v_detalle || jsonb_build_object(
      'lead_id', v_orphan.id,
      'nombre', v_orphan.full_name,
      'agente', v_agent.full_name,
      'carga_prevista', v_agent.carga + 1);
  END LOOP;

  IF NOT v_es_preview THEN
    INSERT INTO public.audit_log (user_id, action, module, table_name, status, metadata)
    VALUES (v_uid, 'leads_repartidos', 'crm', 'leads', 'success',
            jsonb_build_object('asignados', v_asignados, 'detalle', v_detalle,
                               'criterio', 'nuevo, sin actividad, carga=tareas*2+leads'));
  END IF;

  RETURN jsonb_build_object(
    'asignados', v_asignados,
    'alerta', false,
    'detalle', v_detalle,
    'dry_run', v_es_preview,
    'criterio', 'solo leads nuevos sin actividad; tareas abiertas pesan el doble',
    'agentes', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'id', id, 'nombre', full_name, 'leads_vivos', leads_vivos,
                   'tareas_abiertas', tareas_abiertas, 'tareas_owner', tareas_owner,
                   'carga', carga) ORDER BY carga DESC), '[]'::jsonb)
                 FROM _reparto_carga)
  );
END;
$function$;

-- Permisos intactos (anon ✗ / authenticated ✓ / service_role ✓). La firma no
-- cambió: CREATE OR REPLACE reemplaza el cuerpo, no crea una sobrecarga.
