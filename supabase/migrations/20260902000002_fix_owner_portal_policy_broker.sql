-- =====================================================================
-- 20260902000002_fix_owner_portal_policy_broker
-- Corrección de alcance de R1.2 (20260902000001_remediation_p0_rls_rpc).
--
-- La policy owner_portal_tokens_super_admin_all inicialmente restringía
-- la gestión de tokens del portal a is_super_admin(auth.uid()). Verificación
-- de consumidores reveló que el flujo funcional del portal depende de los
-- brokers: portal-propietario.html ("enlace mágico enviado por su broker"),
-- generateOwnerPortalLink (admin-app.js L4371) sin gate de rol, y el patrón
-- existente de la app permite super_admin+broker para herramientas de
-- gestión (chat, L6409). Los agentes NO generan links del portal.
--
-- Reemplazo la policy por una que exige super_admin O broker (ambos con
-- perfil activo), manteniendo el cierre del hueco P0 [F-03] (ya no:
-- "ALL authenticated USING true", solo 2 roles de gestión).
-- =====================================================================

BEGIN;

DROP POLICY IF EXISTS owner_portal_tokens_super_admin_all ON public.owner_portal_tokens;
DROP POLICY IF EXISTS owner_portal_tokens_staff_all ON public.owner_portal_tokens;

CREATE POLICY owner_portal_tokens_staff_all ON public.owner_portal_tokens
  FOR ALL
  TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'broker'::public.user_role
        AND p.is_active IS DISTINCT FROM false
    )
  )
  WITH CHECK (
    public.is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'broker'::public.user_role
        AND p.is_active IS DISTINCT FROM false
    )
  );

COMMIT;