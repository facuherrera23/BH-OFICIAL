-- Recordatorio de encuestas sin responder: 48h después del envío, si el
-- visitante no respondió ni cerró, se crea una tarea al agente del lead
-- para que reenvíe el link. Dedup por lead+propiedad: una sola tarea
-- mientras la encuesta siga pendiente. Cron diario 12:00 ART (15:00 UTC).
-- Aplicada a producción como survey_reminder_cron.

CREATE OR REPLACE FUNCTION public.survey_pending_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $func$
DECLARE
  v_insertados integer := 0;
BEGIN
  WITH pendientes AS (
    SELECT vs.id, vs.lead_id, vs.property_id, vs.token,
           l.assigned_to,
           p.property_code
      FROM public.visit_surveys vs
      JOIN public.leads l ON l.id = vs.lead_id
      LEFT JOIN public.properties p ON p.id = vs.property_id
     WHERE vs.finalized = false
       AND vs.archived_at IS NULL
       AND vs.created_at < now() - interval '48 hours'
       AND l.deleted_at IS NULL
  ),
  con_tarea AS (
    SELECT DISTINCT t.lead_id
      FROM public.lead_tasks t
     WHERE t.title LIKE 'Encuesta sin responder%'
       AND t.status IN ('pendiente','en_progreso')
  )
  INSERT INTO public.lead_tasks (
    lead_id, type, contact_type, title, description, priority, status,
    due_at, assigned_to, remind_before_minutes, created_at, updated_at
  )
  SELECT
    pe.lead_id,
    'contact',
    'whatsapp',
    'Encuesta sin responder — ' || coalesce(pe.property_code, 'propiedad'),
    'El visitante no respondió la encuesta enviada hace más de 48h. Reenviar el link: https://bienenhaus.com.ar/encuesta.html?token=' || pe.token::text,
    'media',
    'pendiente',
    now() + interval '24 hours',
    pe.assigned_to,
    1440,
    now(),
    now()
  FROM pendientes pe
  WHERE NOT EXISTS (SELECT 1 FROM con_tarea ct WHERE ct.lead_id = pe.lead_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.lead_tasks t2
       WHERE t2.lead_id = pe.lead_id
         AND t2.title LIKE 'Encuesta sin responder — ' || coalesce(pe.property_code, '')
         AND t2.status IN ('pendiente','en_progreso')
    );
  GET DIAGNOSTICS v_insertados = ROW_COUNT;
  RETURN v_insertados;
END;
$func$;

REVOKE ALL ON FUNCTION public.survey_pending_reminders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.survey_pending_reminders() TO service_role;

SELECT cron.unschedule('survey-reminders-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'survey-reminders-daily');

SELECT cron.schedule(
  'survey-reminders-daily',
  '0 15 * * *',
  $$ SELECT public.survey_pending_reminders(); $$
);
