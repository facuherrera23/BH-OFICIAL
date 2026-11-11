-- Hardening opcional del plan de performance (H7 — auditoría AUDITORIA_CONTENIDO_2026-11-11).
-- ml_sync_dead_letter apretada a staff-only (super_admin + broker activos).
-- Decisión del dueño: 2026-11-11 ("continua" tras presentar el hardening pendiente).
--
-- Historia: la migración 20260901000002 creó la tabla con "service_role full,
-- authenticated read" (policy ml_sync_dl_auth_read). Después se agregó
-- ml_sync_dead_letter_staff_read para apretar a staff, pero auth_read (qual
-- `true`) siguió sombreándola → en la práctica CUALQUIER authenticated leía la
-- dead-letter (3.327 filas con payloads de sincronización de ML). P2
-- (20261111000005) dropeó la staff_read sombreada y quedó auth_read=true.
-- Esta migración COMPLETA el apriete que jamás tuvo efecto:
--   * DROP ml_sync_dl_auth_read (qual true, TO authenticated).
--   * CREATE ml_sync_dead_letter_staff_read TO authenticated con el qual EXACTO
--     de la staff_read original (hash 6698f9bc... — mismo decompilado que
--     compartían site_settings_read / ml_auto_reply_templates_read).
--   * ml_sync_dl_svc_all (TO service_role, ALL) queda intacta.
--
-- Consumidores verificados en el repo (2026-11-11): NINGÚN admin-*.js ni test
-- lee la tabla; el único escritor es supabase/functions/ml-sync/index.ts
-- (service_role, no afectado). El panel de Portales (staff) corre como
-- super_admin/broker. No hay usuarios role='agente' activos en profiles.
--
-- GUARDS fail-closed:
--   * Entrada: md5 de ml_sync_dl_auth_read y ml_sync_dl_svc_all contra los
--     valores capturados el 2026-11-11 (post-P2). Si cambió, explota sin tocar.
--   * Salida: tras el CREATE, si el md5 de la nueva policy no da el hash
--     original 6698f9bc..., RAISE → rollback completo (auth_read vuelve sola).

DO $do$
BEGIN
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='ml_sync_dead_letter' AND policyname='ml_sync_dl_auth_read')
     IS DISTINCT FROM 'eb28d87532d6edd9b635727493ef89f7' THEN
    RAISE EXCEPTION 'guard RLS: ml_sync_dl_auth_read cambio desde 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='ml_sync_dead_letter' AND policyname='ml_sync_dl_svc_all')
     IS DISTINCT FROM 'fe2e7aa3a94b94b876d7713f1517686d' THEN
    RAISE EXCEPTION 'guard RLS: ml_sync_dl_svc_all cambio desde 2026-11-11';
  END IF;

  DROP POLICY "ml_sync_dl_auth_read" ON public.ml_sync_dead_letter;

  CREATE POLICY "ml_sync_dead_letter_staff_read" ON public.ml_sync_dead_letter
    FOR SELECT TO authenticated
    USING (
(EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role]))))));

  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='ml_sync_dead_letter' AND policyname='ml_sync_dead_letter_staff_read')
     IS DISTINCT FROM '6698f9bc4b17518c6cc19d70196cbae1' THEN
    RAISE EXCEPTION 'guard salida: el qual recreado no coincide con la staff_read original (6698f9bc) — rollback';
  END IF;
END
$do$;
