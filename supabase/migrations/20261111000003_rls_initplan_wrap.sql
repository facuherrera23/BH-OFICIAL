-- P1 del plan de performance RLS (H7 — auditoría AUDITORIA_CONTENIDO_2026-11-11).
-- Lint auth_rls_initplan: 89 policies re-evalúan auth.uid()/auth.role() POR FILA.
-- Fix canónico de Supabase: envolver la llamada en un initplan —
--   auth.uid()  ->  (select auth.uid())
--   auth.role() ->  (select auth.role())
-- Semántica IDENTICA (ambas funciones son STABLE y constantes durante el
-- statement); solo cambia el plan (constante evaluada 1 vez).
--
-- Alcance exacto (verificado contra producción 2026-11-11):
--   * 89 policies flaggeadas por el advisor, 51 tablas.
--   * 0 de ellas con alguna llamada ya envuelta → el replace es unívoco
--     (no hay doble-wrap posible).
--   * Solo 2 variantes: auth.uid() y auth.role().
--   * Distribución: SELECT 30, ALL 19, UPDATE 15, INSERT 15, DELETE 10.
--   * El filtro del loop usa coalesce() en AMBOS lados del concat: con
--     qual NULL (policies INSERT) un concat simple da NULL y la policy
--     se cae del set (bug del precount original: 74 vs 89).
--   * pg_policies.permissive es TEXT 'PERMISSIVE'/'RESTRICTIVE' (NO boolean):
--     `NOT r.permissive` explota con 42804 (primer apply fallido y
--     rollbackeado — cero cambios). Por eso el ::text = 'RESTRICTIVE'.
--   * Postgres decompila los quals con keywords en MAYUSCULAS: al volver a
--     contar policies sin envolver hay que usar ~* (case-insensitive), si no
--     el conteo da falso 89 post-fix.
--   * Ninguna policy tiene auth.* dentro de un string literal (los
--     literales que mencionan 'auth.' eran falsos positivos de la
--     heurística: 'super_admin'::user_role, 'activo'::agent_status).
--
-- Todo corre en UNA transacción: si un CREATE falla, el rollback restaura
-- TODAS las policies (drop+create por policy es la unidad, el bloque es
-- atómico). Verificación post-aplicación planificada:
--   1. Re-scan advisor → auth_rls_initplan 89 → 0.
--   2. Smoke comportamental: BEGIN; SET LOCAL role authenticated con
--      request.jwt.claims de un usuario real → SELECT en profiles/leads/
--      agents/owners (mismo acceso que antes); idem anon. ROLLBACK.
--   3. Suite completa npm test (555 tests, login real contra producción).

DO $$
DECLARE
  r RECORD;
  v_q text;
  v_c text;
  v_roles text;
BEGIN
  FOR r IN
    SELECT tablename, policyname, cmd, roles, permissive, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ 'auth\.(uid|role)\(\)'
      AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) !~ '\(\s*select\s+auth\.'
  LOOP
    v_q := r.qual;
    IF v_q IS NOT NULL THEN
      v_q := replace(replace(v_q, 'auth.uid()', '(select auth.uid())'), 'auth.role()', '(select auth.role())');
    END IF;
    v_c := r.with_check;
    IF v_c IS NOT NULL THEN
      v_c := replace(replace(v_c, 'auth.uid()', '(select auth.uid())'), 'auth.role()', '(select auth.role())');
    END IF;

    SELECT string_agg(quote_ident(rol), ', ') INTO v_roles FROM unnest(r.roles) AS rol;

    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I%s FOR %s TO %s%s%s',
      r.policyname,
      r.tablename,
      CASE WHEN (r.permissive::text = 'RESTRICTIVE') THEN ' AS RESTRICTIVE' ELSE '' END,
      r.cmd,
      v_roles,
      CASE WHEN v_q IS NOT NULL THEN ' USING (' || v_q || ')' ELSE '' END,
      CASE WHEN v_c IS NOT NULL THEN ' WITH CHECK (' || v_c || ')' ELSE '' END
    );
  END LOOP;
END $$;
