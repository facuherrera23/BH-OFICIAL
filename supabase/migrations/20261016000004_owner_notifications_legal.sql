-- Notificaciones legales al propietario (seguridad jurídica)
--
-- Problema: si una exclusividad vence sin que el propietario fuera
-- avisado, puede reclamar daños por oportunidad perdida ("mi propiedad
-- dejó de estar en el mercado N días y nadie me lo dijo").
--
-- Esta tabla es el TRAIL LEGAL: cada notificación enviada queda
-- registrada con fecha, destinatario y contenido. Si hay demanda,
-- el sistema prueba que el propietario fue avisado.

CREATE TABLE IF NOT EXISTS public.owner_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.owners(id) ON DELETE CASCADE,
  notification_type text NOT NULL CHECK (notification_type IN (
    'exclusive_expiry_15d',
    'exclusive_expiry_7d',
    'exclusive_expiry_1d',
    'exclusive_expired'
  )),
  sent_at timestamptz NOT NULL DEFAULT now(),
  sent_to_email text,
  sent_to_phone text,
  agent_id uuid REFERENCES public.agents(id),
  email_message_id text,
  details jsonb
);

CREATE INDEX IF NOT EXISTS idx_owner_notifications_owner ON public.owner_notifications (owner_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_notifications_type ON public.owner_notifications (notification_type);

ALTER TABLE public.owner_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_notifications_select ON public.owner_notifications
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY owner_notifications_insert ON public.owner_notifications
  FOR INSERT TO authenticated
  WITH CHECK (true);

COMMENT ON TABLE public.owner_notifications IS 'Trail legal de notificaciones enviadas a propietarios (exclusividades por vencer, etc). Cada registro es evidencia de que el dueño fue avisado.';
