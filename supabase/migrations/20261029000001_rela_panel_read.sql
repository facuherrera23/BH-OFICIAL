-- rela_webhook_events: lectura de staff para el panel (espejo de ml_webhook_events_staff_read).
-- Antes de esta policy la tabla era service_role-only y el read directo del panel
-- (admin-portales.js loadSyncHistory) quedaba en silencio (.catch(() => [])) — los
-- eventos de RELA nunca se veían en la vista Sincronizaciones a pesar de existir.
DROP POLICY IF EXISTS rela_webhook_events_staff_read ON public.rela_webhook_events;
CREATE POLICY rela_webhook_events_staff_read
  ON public.rela_webhook_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles pr
      WHERE pr.id = auth.uid()
        AND pr.is_active = true
        AND pr.role IN ('super_admin', 'broker')
    )
  );
