-- Vincular preguntas de ML con el lead que crea el webhook.
ALTER TABLE public.ml_questions
ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ml_questions_lead_id ON public.ml_questions (lead_id);
