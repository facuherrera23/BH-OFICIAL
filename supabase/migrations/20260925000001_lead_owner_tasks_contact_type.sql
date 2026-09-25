-- lead_tasks: paridad con owner_tasks (tipo de tarea, tipo de contacto, recordatorio)
ALTER TABLE public.lead_tasks
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'contact',
  ADD COLUMN IF NOT EXISTS contact_type text NULL,
  ADD COLUMN IF NOT EXISTS remind_before_minutes integer NOT NULL DEFAULT 1440;

ALTER TABLE public.lead_tasks
  DROP CONSTRAINT IF EXISTS lead_tasks_contact_type_check;
ALTER TABLE public.lead_tasks
  ADD CONSTRAINT lead_tasks_contact_type_check
  CHECK (contact_type IS NULL OR contact_type IN ('telefono','whatsapp','email'));

-- owner_tasks: tipo de contacto (solo aplica a tareas de tipo 'contact')
ALTER TABLE public.owner_tasks
  ADD COLUMN IF NOT EXISTS contact_type text NULL;

ALTER TABLE public.owner_tasks
  DROP CONSTRAINT IF EXISTS owner_tasks_contact_type_check;
ALTER TABLE public.owner_tasks
  ADD CONSTRAINT owner_tasks_contact_type_check
  CHECK (contact_type IS NULL OR contact_type IN ('telefono','whatsapp','email'));
