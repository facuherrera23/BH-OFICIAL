-- ============================================
-- 20261128000012 — Encuesta post-visita: circuito cerrado
-- ============================================
-- Estado real (28/11/2026): 10 encuestas en toda la historia, 0 finalizadas
-- y 0 respondidas; quedaron tareas "Encuesta sin responder — …" vencidas
-- desde octubre que nadie cierra. El envío tampoco era automático: dependía
-- de que el agente aceptara un confirm en el check-out.
--
-- Esta migración cierra el ciclo en la BASE (el envío automático en el
-- check-out es el cambio JS del mismo lote):
--   · recordatorio 1 a las 48h (como hoy);
--   · recordatorio 2 a las 96h, sólo si sigue sin responder;
--   · a los 7 días sin respuesta: se marca `finalized=true`, se cierran las
--     tareas de recordatorio y se deja UNA nota en el timeline del lead.
--
-- Dedup: se cuentan las tareas del lead creadas DESDE que se generó la
-- encuesta (no por título global, que mezclaría visitas distintas). Las
-- tareas viejas sin marca cuentan igual → ninguna encuesta antigua recibe
-- dos recordatorios "1" por reposicionar el contador.
--
-- `p_dry_run=true` permite verificar en producción SIN escribir nada.
-- La firma vieja se DROPEA: CREATE OR REPLACE con otro número de argumentos
-- crearía una sobrecarga y el cron quedaría ambiguo.
-- ============================================

DROP FUNCTION IF EXISTS public.survey_pending_reminders();
CREATE OR REPLACE FUNCTION public.survey_pending_reminders(p_dry_run boolean DEFAULT false)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  r record;
  v_edad interval;
  v_nr integer;
  v_n integer := 0;
  v_token text;
  v_prop text;
BEGIN
  FOR r IN
    SELECT vs.id AS survey_id, vs.lead_id, vs.property_id, vs.token,
           vs.created_at,
           l.assigned_to, p.property_code
      FROM public.visit_surveys vs
      JOIN public.leads l ON l.id = vs.lead_id
      LEFT JOIN public.properties p ON p.id = vs.property_id
     WHERE vs.finalized = false
       AND vs.archived_at IS NULL
       AND vs.created_at < now() - interval '48 hours'
       AND l.deleted_at IS NULL
     ORDER BY vs.created_at ASC
  LOOP
    SELECT count(*) INTO v_nr
      FROM public.lead_tasks t
     WHERE t.lead_id = r.lead_id
       AND t.title LIKE 'Encuesta sin responder%'
       AND t.created_at >= r.created_at;

    v_edad := now() - r.created_at;
    v_token := r.token::text;
    v_prop := COALESCE(r.property_code, 'la propiedad');

    IF v_nr = 0 AND v_edad >= interval '48 hours' THEN
      IF NOT COALESCE(p_dry_run, false) THEN
        INSERT INTO public.lead_tasks (
          lead_id, type, contact_type, title, description, priority, status,
          due_at, assigned_to, remind_before_minutes, created_at, updated_at
        ) VALUES (
          r.lead_id, 'contact', 'whatsapp',
          'Encuesta sin responder — ' || v_prop,
          '[recordatorio:1] Reenviar el link: https://bienenhaus.com.ar/encuesta.html?token=' || v_token,
          'media', 'pendiente', now() + interval '24 hours', r.assigned_to, 1440, now(), now()
        );
      END IF;
      v_n := v_n + 1;

    ELSIF v_nr = 1 AND v_edad >= interval '96 hours' THEN
      IF NOT COALESCE(p_dry_run, false) THEN
        INSERT INTO public.lead_tasks (
          lead_id, type, contact_type, title, description, priority, status,
          due_at, assigned_to, remind_before_minutes, created_at, updated_at
        ) VALUES (
          r.lead_id, 'contact', 'whatsapp',
          'Encuesta sin responder (2° recordatorio) — ' || v_prop,
          '[recordatorio:2] Último reenvío del link: https://bienenhaus.com.ar/encuesta.html?token=' || v_token,
          'alta', 'pendiente', now() + interval '24 hours', r.assigned_to, 1440, now(), now()
        );
      END IF;
      v_n := v_n + 1;

    ELSIF v_nr >= 2 AND v_edad >= interval '7 days' THEN
      IF NOT COALESCE(p_dry_run, false) THEN
        UPDATE public.visit_surveys
           SET finalized = true, updated_at = now()
         WHERE id = r.survey_id;

        UPDATE public.lead_tasks
           SET status = 'completada', completed_at = now(), completed_note = 'Encuesta cerrada sin respuesta', updated_at = now()
         WHERE lead_id = r.lead_id
           AND title LIKE 'Encuesta sin responder%'
           AND status IN ('pendiente', 'en_progreso');

        IF NOT EXISTS (
          SELECT 1 FROM public.lead_activities la
           WHERE la.lead_id = r.lead_id
             AND la.title = 'Encuesta cerrada sin respuesta'
             AND la.created_at > r.created_at
        ) THEN
          INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
          VALUES (
            r.lead_id, 'note', 'Encuesta cerrada sin respuesta',
            'Se enviaron 2 recordatorios para ' || v_prop || ' sin respuesta. La encuesta se cerró automáticamente.'
          );
        END IF;
      END IF;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.survey_pending_reminders(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.survey_pending_reminders(boolean) TO service_role;

-- El cron llama SIN argumentos: el DEFAULT false mantiene el comportamiento
-- real (p_dry_run=true es sólo para verificación manual).
SELECT cron.unschedule('survey-reminders-daily')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'survey-reminders-daily');

SELECT cron.schedule(
  'survey-reminders-daily',
  '0 15 * * *',
  $$ SELECT public.survey_pending_reminders(); $$
);
