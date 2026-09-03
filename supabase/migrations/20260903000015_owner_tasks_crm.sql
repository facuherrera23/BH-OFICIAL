-- ============================================================
-- OWNER TASKS CRM - Tareas de seguimiento para propietarios
-- ============================================================
-- CRM de tareas de seguimiento: el agente/broker registra qué debe
-- hacer con cada propietario (llamar, pedir certificado, enviar
-- liquidación), con fecha límite, prioridad, responsable y recordatorio
-- automático antes del vencimiento.
--
-- Idempotente (CREATE TABLE IF NOT EXISTS / DROP POLICY IF EXISTS /
-- CREATE INDEX IF NOT EXISTS / DROP TRIGGER IF EXISTS / ON CONFLICT),
-- seguro de aplicar en DB nueva o ya migrada.
--
-- DECISIÓN DE ARQUITECTURA (sincronización con Timeline):
-- Al completar una tarea, el INSERT en owner_timeline_entries lo hace el
-- FRONTEND (dentro del mismo mutate()), NO un trigger SQL AFTER UPDATE.
-- Motivo: un trigger SECURITY DEFINER no tiene forma confiable de saber
-- "qué usuario hizo el cambio" salvo que se le pase explícitamente, lo
-- que agrega complejidad innecesaria para un caso donde el frontend está
-- siempre presente. El Timeline sigue siendo el historial inmutable de lo
-- ya hecho; owner_tasks es la agenda de lo pendiente.
-- ============================================================

-- 1. TABLA owner_tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS owner_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'note', -- 'note' | 'alert' | 'commission' | 'document' | 'contact' (mismo set que owner_timeline_entries)
  description text NOT NULL,
  due_date timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pendiente', -- 'pendiente' | 'en_progreso' | 'completada' | 'cancelada'
  priority text NOT NULL DEFAULT 'media',   -- 'baja' | 'media' | 'alta'
  assigned_to uuid REFERENCES agents(id) ON DELETE SET NULL, -- responsable: agents.id (patrón unificado, ver 20260827000001_unify_agent_ids)
  result_notes text,                        -- notas/resultado al cerrar la tarea
  remind_before_minutes integer NOT NULL DEFAULT 1440, -- cuánto antes avisar (select fijo: 30, 60, 180, 1440, 2880, 4320)
  reminder_sent_at timestamptz,             -- control anti-duplicados del recordatorio
  created_by uuid,                          -- perfil (profiles.id) que creó la tarea
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_owner_tasks_owner ON owner_tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_owner_tasks_assigned_to ON owner_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_owner_tasks_due_date ON owner_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_owner_tasks_status ON owner_tasks(status);

-- Índice parcial para el badge de vencidas (status activo + vencida).
-- Misma condición que el badge del sidebar y el indicador de fila:
--   status IN ('pendiente','en_progreso') AND due_date < now()
CREATE INDEX IF NOT EXISTS idx_owner_tasks_overdue
  ON owner_tasks(due_date)
  WHERE status IN ('pendiente', 'en_progreso');

-- 2. RLS - Política única por tabla (patrón dominante del proyecto)
-- ============================================================
ALTER TABLE owner_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_tasks_auth" ON owner_tasks;
CREATE POLICY "owner_tasks_auth" ON owner_tasks
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3. BADGE DEL SIDEBAR - sumar contador de tareas vencidas
-- ============================================================
-- CREATE OR REPLACE de get_sidebar_badge_counts() copiando el cuerpo
-- actual real (20260902000007) + contador de tareas vencidas.
-- Definición de "vencida" (única en todo el flujo):
--   status IN ('pendiente','en_progreso') AND due_date < now()
CREATE OR REPLACE FUNCTION public.get_sidebar_badge_counts(p_user_id uuid DEFAULT auth.uid())
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_props integer; v_leads integer; v_visits integer; v_owners integer; v_tasaciones integer; v_tasks_overdue integer;
BEGIN
  SELECT count(*) INTO v_props FROM public.properties WHERE is_published = true;
  SELECT count(*) INTO v_leads FROM public.leads WHERE stage NOT IN ('cerrado', 'perdido');
  SELECT count(*) INTO v_visits FROM public.visits WHERE status = 'pendiente';
  SELECT count(*) INTO v_owners FROM public.owners WHERE deleted_at IS NULL;
  SELECT count(*) INTO v_tasaciones FROM public.tasaciones;
  SELECT count(*) INTO v_tasks_overdue FROM public.owner_tasks WHERE status IN ('pendiente', 'en_progreso') AND due_date < now();

  RETURN json_build_object(
    'properties', v_props,
    'leads', v_leads,
    'visits', v_visits,
    'owners', v_owners,
    'tasaciones', v_tasaciones,
    'owner_tasks_overdue', v_tasks_overdue
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_sidebar_badge_counts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sidebar_badge_counts(uuid) TO service_role;

-- 4. RECORDATORIO AUTOMÁTICO - pg_cron cada 15 minutos
-- ============================================================
-- La Edge Function `owner-tasks-reminder` (verify_jwt OFF, la invoca el
-- cron server-to-server) procesa las tareas cuyo momento de disparo llegó:
--   now() >= due_date - (remind_before_minutes || ' minutes')::interval
-- y envía el email al agente asignado (Brevo), respetando
-- notification_preferences. Aquí solo registramos el job.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Eliminar job existente si existe (re-ejecución segura)
SELECT cron.unschedule('owner-tasks-reminder') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'owner-tasks-reminder'
);

-- Programar recordatorio cada 15 minutos (invoca la Edge Function vía pg_net,
-- mismo patrón que supervision-digest). La Edge Function es --no-verify-jwt.
SELECT cron.schedule(
  'owner-tasks-reminder',
  '*/15 * * * *',
  'SELECT net.http_post(
      current_setting(''app.settings.supabase_url'', true) || ''/functions/v1/owner-tasks-reminder'',
      jsonb_build_object(
        ''Content-Type'', ''application/json'',
        ''Authorization'', ''Bearer '' || current_setting(''app.settings.service_role_key'', true)
      ),
      ''{}''::jsonb
  );'
);