-- Backfill next_followup_at (2026-10-20): unificar definición con el chip del CRM
-- (recommendedNextAction: TODAS las tareas pendientes, no solo type='contact').
-- Necesario para el nuevo orden default "próx. tarea — nuevos arriba": el sort usa
-- esta columna; 2 leads tenían tareas pendientes pero columna NULL (creadas por
-- flows que no llamaban syncLeadFollowup). El sync en admin-crm.js también se
-- corrigió para considerar todas las tareas.
-- Idempotente y 100% derivable: NULL si no hay tareas pendientes (limpia fechas viejas).
UPDATE leads SET next_followup_at = (
  SELECT min(due_at)
  FROM lead_tasks
  WHERE lead_tasks.lead_id = leads.id
    AND status IN ('pendiente','en_progreso')
    AND due_at IS NOT NULL
);
