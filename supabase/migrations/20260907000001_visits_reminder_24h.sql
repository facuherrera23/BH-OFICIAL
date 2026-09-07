-- ============================================================
-- 20260907000001_visits_reminder_24h
-- Recordatorio 24h real por email: columna de control en visits.
-- La edge function visits-process-reminders marca esta columna tras
-- enviar el recordatorio vía Brevo (antes era un stub sin envío real).
-- ============================================================

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS reminder_24h_sent_at timestamptz;

COMMENT ON COLUMN public.visits.reminder_24h_sent_at IS
  'Timestamp del último recordatorio 24h enviado al cliente (visits-process-reminders).';
