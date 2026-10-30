-- Paridad repo ↔ producción para las policies de rela_config (re-auditoría
-- 2026-10-29). Estado real en producción (verificado con pg_policies): la
-- policy de LECTURA es relation-level STAFF (super_admin/broker), no
-- "authenticated cualquiera" como declaraba 20260902000003; ese endurecimiento
-- se aplicó ad-hoc y nunca quedó grabado en el repo. Esta migración graba el
-- estado de producción como fuente de verdad.
DROP POLICY IF EXISTS rela_config_read ON public.rela_config;
DROP POLICY IF EXISTS rela_config_staff_read ON public.rela_config;
CREATE POLICY rela_config_staff_read
  ON public.rela_config
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_active IS DISTINCT FROM false
        AND profiles.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role])
    )
  );

-- La de escritura coincide con el estado declarado en 20260902000003
-- (re-create idempotente para que el repo sea determinista en rebuilds).
DROP POLICY IF EXISTS rela_config_write ON public.rela_config;
CREATE POLICY rela_config_write
  ON public.rela_config
  FOR UPDATE
  TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));
