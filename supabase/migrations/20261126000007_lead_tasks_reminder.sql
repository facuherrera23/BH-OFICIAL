-- ---------------------------------------------------------------------------
-- RECORDATORIO REAL DE TAREAS DE LEAD (2026-11-26).
--
-- El problema medido: el campo "Recordatorio (antes de vencer)" del form de
-- tarea de lead (lead_tasks.remind_before_minutes) estaba cargado en las 273
-- tareas y NINGÚN cron lo leía — era cosmético. La única familia con
-- recordatorios operativos era la de propietarios (owner-tasks-reminder,
-- cada 15 min). Medido: 46 tareas pendientes, 21 vencidas (13 de un solo
-- agente) y nadie recibió un aviso.
--
-- Esta migración agrega la columna de control de envío (mismo patrón que
-- owner_tasks.reminder_sent_at): la edge function lead-tasks-reminder la
-- marca INMEDIATAMENTE después de confirmar el email de cada tarea para no
-- reenviar en la próxima corrida (cada 15 min). Aditiva: no toca filas.
-- ---------------------------------------------------------------------------

ALTER TABLE public.lead_tasks ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;

COMMENT ON COLUMN public.lead_tasks.reminder_sent_at IS
  'Cuándo se envió el recordatorio por email al agente (lead-tasks-reminder). NULL = todavía no se avisó.';
