-- Agenda fase 5: token personal para feed ICS por broker
-- (suscripcion de calendario desde Google/Apple/Outlook).
BEGIN;

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS ics_token uuid NOT NULL DEFAULT gen_random_uuid();

COMMIT;
