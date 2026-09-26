-- Agenda fase 4: bloqueos de agenda del broker (almuerzo, franco, etc.).
BEGIN;

CREATE TABLE IF NOT EXISTS public.broker_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL CHECK (end_time > start_time),
  label text NOT NULL DEFAULT 'No disponible',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.broker_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY broker_blocks_auth_read ON public.broker_blocks
  FOR SELECT TO authenticated USING (true);

CREATE POLICY broker_blocks_auth_write ON public.broker_blocks
  FOR ALL TO authenticated
  USING (public.is_super_admin(auth.uid()) OR EXISTS (
    SELECT 1 FROM public.agents a
    WHERE a.id = broker_blocks.agent_id AND a.profile_id = auth.uid()
  ))
  WITH CHECK (public.is_super_admin(auth.uid()) OR EXISTS (
    SELECT 1 FROM public.agents a
    WHERE a.id = broker_blocks.agent_id AND a.profile_id = auth.uid()
  ));

COMMIT;
