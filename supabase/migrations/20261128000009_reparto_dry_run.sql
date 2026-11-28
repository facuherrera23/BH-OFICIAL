-- ============================================
-- 20261128000009 — repartir_leads_sin_agente: vista previa (dry_run)
-- ============================================
-- Hallazgo real (28/11/2026): el botón "Repartir" de Mi bandeja pedía una
-- confirmación genérica ("¿Repartir los leads sin agente?") y sólo después
-- se enteraba uno de cuántos leads se movían y a quién. Con datos reales no
-- es inocuo: el reparto escribe leads, timeline y auditoría.
--
-- Fix: parámetro nuevo p_dry_run boolean DEFAULT false. Con false (default)
-- la función es EXACTAMENTE la vigente (el cron `lead-reparto-daily` sigue
-- llamando `SELECT public.repartir_leads_sin_agente()` sin argumentos).
-- Con true calcula el mismo round-robin por carga, pero NO escribe nada:
-- ni leads, ni lead_activities, ni audit_log, ni alertas. Devuelve el mismo
-- detalle para que el panel pueda mostrar la confirmación con datos reales.
--
-- Se Dropea la firma vieja y se crea la nueva: CREATE OR REPLACE con otro
-- número de argumentos crea una SOBRECARGA, no reemplaza. No se toca ningún
-- dato: es una función, no una tabla.
--
-- Permisos: se preservan los reales (anon ✗ / authenticated ✓ / service_role ✓).
-- Supabase da EXECUTE a anon/authenticated por defecto al crear → hay que
-- revocarlos explícitamente. SECURITY DEFINER + search_path fijo se mantienen.
-- ============================================

DROP FUNCTION IF EXISTS public.repartir_leads_sin_agente();

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

  /* Carga actual por agente activo: el reparto es round-robin POR CARGA, así
     Danilo (28 vivos) no acumula más mientras Helmut (5) queda vacío.
     P1-6: los leads en espera NO cuentan carga (no se está trabajando). */
  CREATE TEMP TABLE _reparto_carga ON COMMIT DROP AS
    SELECT a.id, a.full_name,
           (SELECT count(*) FROM public.leads l
             WHERE l.assigned_to = a.id AND l.deleted_at IS NULL
               AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')) AS carga
      FROM public.agents a
     WHERE a.status = 'activo' AND a.deleted_at IS NULL;

  IF NOT EXISTS (SELECT 1 FROM _reparto_carga) THEN
    /* Sin agentes activos no hay a quién asignar: alerta en vez de silencio.
       En vista previa NO se abre la alerta (es sólo lectura). */
    IF NOT v_es_preview THEN
      INSERT INTO public.supervision_alerts
        (user_id, module, severity, alert_type, title, description, evidence, status)
      VALUES
        (v_uid, 'crm', 'high', 'leads_sin_agente',
         'Leads vivos sin agente y sin agentes activos',
         'El reparto automático no encontró agentes activos: hay leads vivos sin dueño que nadie va a atender.',
         jsonb_build_object('funcion', 'repartir_leads_sin_agente'),
         'open');
    END IF;
    RETURN jsonb_build_object('asignados', 0, 'alerta', true,
                              'motivo', 'sin agentes activos', 'dry_run', v_es_preview);
  END IF;

  /* El más viejo primero (FIFO) y cada asignación recalcula el destino menos
     cargado. P1-6: los leads en espera no entran al reparto. */
  FOR v_orphan IN
    SELECT l.id, l.full_name, l.source
      FROM public.leads l
     WHERE l.deleted_at IS NULL
       AND l.assigned_to IS NULL
       AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     ORDER BY l.created_at ASC
  LOOP
    SELECT c.id, c.full_name, c.carga
      INTO v_agent
      FROM _reparto_carga c
     ORDER BY c.carga ASC, c.id ASC
     LIMIT 1;

    IF v_es_preview THEN
      /* Misma simulación de carga, CERO escrituras persistentes. */
      UPDATE _reparto_carga SET carga = carga + 1 WHERE id = v_agent.id;
      v_asignados := v_asignados + 1;
      v_detalle := v_detalle || jsonb_build_object(
        'lead_id', v_orphan.id, 'nombre', v_orphan.full_name, 'agente', v_agent.full_name);
    ELSE
      UPDATE public.leads SET assigned_to = v_agent.id
       WHERE id = v_orphan.id AND assigned_to IS NULL;

      IF FOUND THEN
        UPDATE _reparto_carga SET carga = carga + 1 WHERE id = v_agent.id;
        INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
        VALUES (v_orphan.id, 'note',
                'Lead asignado a ' || v_agent.full_name,
                'Reparto automático de leads sin agente (por carga de trabajo).');
        v_asignados := v_asignados + 1;
        v_detalle := v_detalle || jsonb_build_object(
          'lead_id', v_orphan.id, 'nombre', v_orphan.full_name, 'agente', v_agent.full_name);
      END IF;
    END IF;
  END LOOP;

  IF NOT v_es_preview THEN
    INSERT INTO public.audit_log (user_id, action, module, table_name, status, metadata)
    VALUES (v_uid, 'leads_repartidos', 'crm', 'leads', 'success',
            jsonb_build_object('asignados', v_asignados, 'detalle', v_detalle));
  END IF;

  RETURN jsonb_build_object(
    'asignados', v_asignados,
    'alerta', false,
    'detalle', v_detalle,
    'dry_run', v_es_preview,
    'agentes', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'id', id, 'nombre', full_name, 'leads_vivos', carga) ORDER BY carga DESC), '[]'::jsonb)
                  FROM _reparto_carga)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.repartir_leads_sin_agente(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repartir_leads_sin_agente(boolean) TO authenticated, service_role;
