-- ----------------------------------------------------------------------
-- leads.ml_lead_id: id del lead de inmuebles (VIS) de Mercado Libre.
-- Dedup atómico de contactos de inmuebles: el webhook re-notifica cambios de
-- estado de un mismo lead (reservas/agendas) y el backfill re-inyecta leads ya
-- procesados — sin índice único se duplicarían los leads del CRM.
-- Bug real 2026-10-07: las notificaciones vis_leads se rechazaban con 400
-- 'Invalid JSON' (tópico ausente del enum del schema) y las consultas de ML
-- nunca llegaban al CRM; esta columna es parte del fix + backfill.
-- ----------------------------------------------------------------------

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS ml_lead_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_ml_lead_id
ON public.leads (ml_lead_id) WHERE ml_lead_id IS NOT NULL;
