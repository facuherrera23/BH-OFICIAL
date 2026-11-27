-- ---------------------------------------------------------------------------
-- TRAZA DE ENVÍOS DEL CRM (2026-11-27) — P0-4.
--
-- Diagnóstico del 27/11: `notify-new-lead` abre la alerta `crm_email_broken`
-- cuando el envío falla, pero NO deja ninguna traza de los envíos que SÍ
-- funcionan. Resultado: 14 alertas `crm_email_broken` abiertas del 24/9 al
-- 10/10 (ruido viejo) y CERO evidencia para saber si hoy el CRM avisa.
-- La alerta tampoco se auto-resolvía nunca (nada la cerraba al repaired).
--
-- Qué agrega:
--   · `crm_envios`: una fila por CADA envío (OK o error) con su contexto
--     (origen, canal, destinatario, lead/agente/visita/tarea relacionados).
--     Es el "log de correo" que hoy no existe — el `audit_log` sólo registra
--     cambios de datos, no envíos.
--   · Un trigger que mantiene la higiene de la alerta:
--       - estado='enviado' → auto-resuelve las `crm_email_broken` abiertas
--         (el aviso "están caídas" se cae solo cuando vuelve a funcionar).
--       - estado='error'   → abre UNA alerta `crm_email_broken` por día.
--     Así la alerta significa "ahora está roto", no "una vez se rompió".
--   · Lectura para el equipo autenticado (la RLS de `leads` ya deja ver todo
--     el CRM); escritura sólo con service_role (las edge functions).
--     La tabla NO entra al "club" de RLS-sin-policies porque sí tiene consumo
--     desde el panel.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.crm_envios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'notify_new_lead' | 'lead_task_reminder' | 'visit_reminder' | 'commission'
  origen        text NOT NULL,
  -- 'email' | 'whatsapp'
  canal         text NOT NULL DEFAULT 'email',
  -- 'enviado' | 'error' | 'omitido'
  estado        text NOT NULL DEFAULT 'enviado',
  destinatario  text,
  asunto        text,
  proveedor     text,
  lead_id       uuid REFERENCES public.leads(id)      ON DELETE SET NULL,
  agente_id     uuid REFERENCES public.agents(id)     ON DELETE SET NULL,
  visita_id     uuid REFERENCES public.visits(id)     ON DELETE SET NULL,
  tarea_id      uuid REFERENCES public.lead_tasks(id) ON DELETE SET NULL,
  error         text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_envios_estado_chk CHECK (estado IN ('enviado', 'error', 'omitido')),
  CONSTRAINT crm_envios_canal_chk  CHECK (canal  IN ('email', 'whatsapp'))
);

CREATE INDEX IF NOT EXISTS idx_crm_envios_created_at ON public.crm_envios (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_envios_estado      ON public.crm_envios (estado);
CREATE INDEX IF NOT EXISTS idx_crm_envios_origen      ON public.crm_envios (origen);
CREATE INDEX IF NOT EXISTS idx_crm_envios_lead        ON public.crm_envios (lead_id);

ALTER TABLE public.crm_envios ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.crm_envios FROM PUBLIC, anon;
GRANT SELECT ON public.crm_envios TO authenticated;
-- La escritura es EXCLUSIVA de service_role (las edge functions). Supabase
-- otorga ALL por default sobre las tablas de public → hay que revocar
-- explícitamente el INSERT/UPDATE/DELETE a authenticated (la RLS igual lo
-- frenaría, pero el ACL tiene que coincidir con la intención).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.crm_envios FROM authenticated, anon, PUBLIC;

DROP POLICY IF EXISTS crm_envios_select ON public.crm_envios;
CREATE POLICY crm_envios_select ON public.crm_envios
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.crm_envios IS
  'Traza de envíos del CRM (email/WhatsApp): una fila por envío con su resultado. Base de la higiene de la alerta crm_email_broken.';

-- ---------------------------------------------------------------------------
-- Trigger de higiene: la alerta crm_email_broken refleja el estado ACTUAL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_envios_sync_alert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.estado = 'enviado' THEN
    -- Volvió a funcionar: la alerta se cae sola (con la traza del motivo).
    UPDATE public.supervision_alerts s
       SET status       = 'resolved',
           resolved_at  = now(),
           notes        = COALESCE(s.notes, '') ||
                         ' Auto-resuelta ' || to_char(now() AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI') ||
                         ': envío OK (' || NEW.origen || ' → ' || COALESCE(NEW.destinatario, '—') || ').'
     WHERE s.alert_type = 'crm_email_broken'
       AND s.status IN ('open', 'assigned', 'investigating');
  ELSIF NEW.estado = 'error' THEN
    -- Se rompió AHORA: una sola alerta por día (no 14 iguales).
    IF NOT EXISTS (
      SELECT 1
        FROM public.supervision_alerts s
       WHERE s.alert_type = 'crm_email_broken'
         AND s.status IN ('open', 'assigned', 'investigating')
         AND s.created_at >= now() - interval '24 hours'
    ) THEN
      INSERT INTO public.supervision_alerts
        (module, severity, alert_type, title, description, evidence, status)
      VALUES
        ('crm', 'high', 'crm_email_broken',
         'Notificaciones de email del CRM están caídas',
         'Falló un envío del CRM: ' || NEW.origen || ' → ' || COALESCE(NEW.destinatario, '—') ||
         '. ' || COALESCE(NEW.error, ''),
         jsonb_build_object('origen', NEW.origen, 'destinatario', NEW.destinatario,
                            'error', NEW.error, 'canal', NEW.canal),
         'open');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_envios_sync_alert() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_envios_sync_alert() TO service_role;

DROP TRIGGER IF EXISTS trg_crm_envios_sync_alert ON public.crm_envios;
CREATE TRIGGER trg_crm_envios_sync_alert
  AFTER INSERT ON public.crm_envios
  FOR EACH ROW EXECUTE FUNCTION public.crm_envios_sync_alert();

COMMENT ON FUNCTION public.crm_envios_sync_alert() IS
  'Mantiene la alerta crm_email_broken coherente con la realidad: se abre con un error de envío y se auto-resuelve con el primer envío OK.';
