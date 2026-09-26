-- lead_tasks.assigned_to apuntaba a profiles(id) de antes de la unificacion de
-- IDs de responsable (ADR-003). Como leads.assigned_to y visits.agent_id ya son
-- agents.id, la FK se repunta a agents(id).
BEGIN;

ALTER TABLE public.lead_tasks
  DROP CONSTRAINT IF EXISTS lead_tasks_assigned_to_fkey;

ALTER TABLE public.lead_tasks
  ADD CONSTRAINT lead_tasks_assigned_to_fkey
  FOREIGN KEY (assigned_to) REFERENCES public.agents(id) ON DELETE SET NULL;

COMMIT;
