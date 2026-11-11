-- P2 del plan de performance (H7 — auditoría AUDITORIA_CONTENIDO_2026-11-11).
-- Lint multiple_permissive_policies: 38 findings. Raíz real (descompuesta):
--   * ml_listings: 2 policies ALL TO public solapadas (24 findings = ruido de
--     6 roles internos × 4 cmds; los roles internos heredan de anon/authenticated
--     y se arreglan solos al consolidar las reales).
--   * notification_preferences: ALL + SELECT ambas TO public con qual idéntico.
--   * 8 tablas con patrón "ALL write-gated + SELECT read-gated" para
--     authenticated: la ALL cubre SELECT también → 2 permissive por SELECT.
--
-- REGLA DEL FIX (semántica idéntica en TODOS los casos): una sola policy por
-- (cmd, grupo de roles), con OR de los quals que hoy aplican a ese (cmd, grupo).
--   * ALL → se parte en INSERT (WC) / UPDATE (USING+WC) / DELETE (USING),
--     conservando el USING y el WITH CHECK originales (si la ALL no tenía WC,
--     Postgres usaba el USING como WC — se reproduce igual).
--   * SELECT → se consolida en una sola policy con USING = OR de los quals
--     de lectura que hoy aplican (solo cuando hay más de una read policy o
--     la ALL aportaba lectura no contenida en la read existente).
--   * Los grupos de roles (TO public vs TO authenticated) se conservan; la
--     read consolidada va al grupo más amplio que hoy aplica (ml_listings y
--     property_images requieren TO public porque service_role/anon leen hoy).
--   * Los quals se copian LITERALMENTE de pg_policies — ya vienen wrapped en
--     initplan por la migración 20261111000003 → initplan sigue en 0.
--
-- Semántica preservada caso por caso (verificado contra los quals completos):
--   notification_preferences : quals ALL/SELECT idénticos → drop de la SELECT.
--   ml_sync_dead_letter      : auth_read (true) sombra a staff_read → drop.
--   broker_blocks            : read `true` sombra todo → read intacta, ALL→3 writes.
--   ml_auto_reply_templates  : Q_all (super_admin+is_active) ⊆ Q_read (staff 2
--                              roles+is_active) → read intacta, ALL→3 writes.
--   site_settings            : idéntico al anterior.
--   ml_connection            : is_super_admin permite is_active NULL, la read
--                              exige =true → SELECT consolidada (OR), ALL→3 writes.
--   portal_settings          : la ALL NO exige is_active, la read SÍ → OR.
--   user_sessions            : super_admin (ve todo) OR dueño (ve lo propio) → OR.
--   property_images          : staff (ve todo) OR propiedad publicada (anon) → OR,
--                              read TO public (anon ve fichas publicadas hoy).
--   ml_listings              : writes TO public = admin OR service_role;
--                              read TO public = admin OR service OR staff
--                              (service_role lee hoy vía TO public → la read
--                              consolidada DEBE ser TO public).
--
-- GUARDS fail-closed: antes de tocar nada se verifica el md5 de
-- (qual|with_check) de CADA policy implicada contra el valor capturado el
-- 2026-11-11. Si producción cambió desde entonces, la migración explota
-- ANTES del primer DROP (nada queda a mitad de camino).

DO $$
BEGIN
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='notification_preferences' AND policyname='notification_prefs_user_modify')
     IS DISTINCT FROM 'a1fc7aa105a1b503f03297d4c928519f' THEN
    RAISE EXCEPTION 'guard RLS: notification_prefs_user_modify cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='notification_preferences' AND policyname='notification_prefs_user_select')
     IS DISTINCT FROM 'a1fc7aa105a1b503f03297d4c928519f' THEN
    RAISE EXCEPTION 'guard RLS: notification_prefs_user_select cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='ml_sync_dead_letter' AND policyname='ml_sync_dead_letter_staff_read')
     IS DISTINCT FROM '6698f9bc4b17518c6cc19d70196cbae1' THEN
    RAISE EXCEPTION 'guard RLS: ml_sync_dead_letter_staff_read cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='ml_sync_dead_letter' AND policyname='ml_sync_dl_auth_read')
     IS DISTINCT FROM 'eb28d87532d6edd9b635727493ef89f7' THEN
    RAISE EXCEPTION 'guard RLS: ml_sync_dl_auth_read cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='ml_listings' AND policyname='ml_listings_admin_all')
     IS DISTINCT FROM '48e5ca5b95028fd9179cc7d15272f6ec' THEN
    RAISE EXCEPTION 'guard RLS: ml_listings_admin_all cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='ml_listings' AND policyname='ml_listings_service_all')
     IS DISTINCT FROM '85baaa0f001520f97aca31a36eab6b12' THEN
    RAISE EXCEPTION 'guard RLS: ml_listings_service_all cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='ml_listings' AND policyname='ml_listings_staff_read')
     IS DISTINCT FROM '64ae322f601f5b246711fd9e4848d708' THEN
    RAISE EXCEPTION 'guard RLS: ml_listings_staff_read cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='broker_blocks' AND policyname='broker_blocks_auth_write')
     IS DISTINCT FROM 'fe7b04ac3962b5c0c6a505c9373e3f0b' THEN
    RAISE EXCEPTION 'guard RLS: broker_blocks_auth_write cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='broker_blocks' AND policyname='broker_blocks_auth_read')
     IS DISTINCT FROM 'eb28d87532d6edd9b635727493ef89f7' THEN
    RAISE EXCEPTION 'guard RLS: broker_blocks_auth_read cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='ml_auto_reply_templates' AND policyname='ml_auto_reply_templates_super_admin')
     IS DISTINCT FROM 'ff88f07bd4a0a7576d4b01745cae7a49' THEN
    RAISE EXCEPTION 'guard RLS: ml_auto_reply_templates_super_admin cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='ml_auto_reply_templates' AND policyname='ml_auto_reply_templates_read')
     IS DISTINCT FROM '6698f9bc4b17518c6cc19d70196cbae1' THEN
    RAISE EXCEPTION 'guard RLS: ml_auto_reply_templates_read cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='ml_connection' AND policyname='ml_connection_super_admin')
     IS DISTINCT FROM '32cad9a653a44f7d9f44d20a01af857c' THEN
    RAISE EXCEPTION 'guard RLS: ml_connection_super_admin cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='ml_connection' AND policyname='ml_connection_staff_read')
     IS DISTINCT FROM '6698f9bc4b17518c6cc19d70196cbae1' THEN
    RAISE EXCEPTION 'guard RLS: ml_connection_staff_read cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='portal_settings' AND policyname='portal_settings_admin_all')
     IS DISTINCT FROM 'e5eedd3d54b3607a16d8c6da9f929943' THEN
    RAISE EXCEPTION 'guard RLS: portal_settings_admin_all cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='portal_settings' AND policyname='portal_settings_staff_read')
     IS DISTINCT FROM '9627185acbe8303a2707eb881789a87b' THEN
    RAISE EXCEPTION 'guard RLS: portal_settings_staff_read cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='property_images' AND policyname='property_images_admin_write')
     IS DISTINCT FROM 'a16ac14eb9bc68aeeff44a98f888d72d' THEN
    RAISE EXCEPTION 'guard RLS: property_images_admin_write cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='property_images' AND policyname='property_images_public_read')
     IS DISTINCT FROM 'b110a1ac95a4397c7cdc5bdab85e67ac' THEN
    RAISE EXCEPTION 'guard RLS: property_images_public_read cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='site_settings' AND policyname='site_settings_super_admin_write')
     IS DISTINCT FROM 'ff88f07bd4a0a7576d4b01745cae7a49' THEN
    RAISE EXCEPTION 'guard RLS: site_settings_super_admin_write cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='site_settings' AND policyname='site_settings_read')
     IS DISTINCT FROM '6698f9bc4b17518c6cc19d70196cbae1' THEN
    RAISE EXCEPTION 'guard RLS: site_settings_read cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='user_sessions' AND policyname='user_sessions_super_admin')
     IS DISTINCT FROM '5e2dc6fdaf51e3f69dd1ad63eee2e685' THEN
    RAISE EXCEPTION 'guard RLS: user_sessions_super_admin cambió desde la auditoría 2026-11-11';
  END IF;
  IF (SELECT md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) FROM pg_policies
      WHERE schemaname='public' AND tablename='user_sessions' AND policyname='user_sessions_own')
     IS DISTINCT FROM 'a7d7eb18352aa8797d6f9c34aa194875' THEN
    RAISE EXCEPTION 'guard RLS: user_sessions_own cambió desde la auditoría 2026-11-11';
  END IF;
END $$;

-- ============================================================
-- 1) notification_preferences — drop de la SELECT sombreada
-- ============================================================
DROP POLICY "notification_prefs_user_select" ON public.notification_preferences;

-- ============================================================
-- 2) ml_sync_dead_letter — drop de staff_read (sombreada por auth_read=true)
-- ============================================================
DROP POLICY "ml_sync_dead_letter_staff_read" ON public.ml_sync_dead_letter;

-- ============================================================
-- 3) ml_listings — 2 ALL TO public → 3 writes TO public (OR) + read TO public
-- ============================================================
DROP POLICY "ml_listings_admin_all" ON public.ml_listings;
DROP POLICY "ml_listings_service_all" ON public.ml_listings;
DROP POLICY "ml_listings_staff_read" ON public.ml_listings;

CREATE POLICY "ml_listings_write_insert" ON public.ml_listings
  FOR INSERT TO public WITH CHECK (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role])))))
    OR (( SELECT auth.role() AS role) = 'service_role'::text));

CREATE POLICY "ml_listings_write_update" ON public.ml_listings
  FOR UPDATE TO public
  USING (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role])))))
    OR (( SELECT auth.role() AS role) = 'service_role'::text))
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role])))))
    OR (( SELECT auth.role() AS role) = 'service_role'::text));

CREATE POLICY "ml_listings_write_delete" ON public.ml_listings
  FOR DELETE TO public
  USING (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role])))))
    OR (( SELECT auth.role() AS role) = 'service_role'::text));

-- Read consolidada TO public (service_role y anon deben conservar su acceso
-- actual: service_role leía vía la ALL TO public; anon ve todo false → denied).
CREATE POLICY "ml_listings_read" ON public.ml_listings
  FOR SELECT TO public
  USING (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role])))))
    OR (( SELECT auth.role() AS role) = 'service_role'::text)
    OR (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role, 'agente'::user_role]))))));

-- ============================================================
-- 4) broker_blocks — ALL → 3 writes; read `true` queda intacta
-- ============================================================
DROP POLICY "broker_blocks_auth_write" ON public.broker_blocks;

CREATE POLICY "broker_blocks_write_insert" ON public.broker_blocks
  FOR INSERT TO authenticated WITH CHECK (
    (is_super_admin(( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM agents a
  WHERE ((a.id = broker_blocks.agent_id) AND (a.profile_id = ( SELECT auth.uid() AS uid)))))));

CREATE POLICY "broker_blocks_write_update" ON public.broker_blocks
  FOR UPDATE TO authenticated
  USING (
    (is_super_admin(( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM agents a
  WHERE ((a.id = broker_blocks.agent_id) AND (a.profile_id = ( SELECT auth.uid() AS uid)))))))
  WITH CHECK (
    (is_super_admin(( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM agents a
  WHERE ((a.id = broker_blocks.agent_id) AND (a.profile_id = ( SELECT auth.uid() AS uid)))))));

CREATE POLICY "broker_blocks_write_delete" ON public.broker_blocks
  FOR DELETE TO authenticated
  USING (
    (is_super_admin(( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM agents a
  WHERE ((a.id = broker_blocks.agent_id) AND (a.profile_id = ( SELECT auth.uid() AS uid)))))));

-- ============================================================
-- 5) ml_auto_reply_templates — ALL → 3 writes; read queda intacta
--    (Q_all ⊆ Q_read: super_admin+is_active ⊆ staff 2 roles+is_active)
-- ============================================================
DROP POLICY "ml_auto_reply_templates_super_admin" ON public.ml_auto_reply_templates;

CREATE POLICY "ml_auto_reply_templates_write_insert" ON public.ml_auto_reply_templates
  FOR INSERT TO authenticated WITH CHECK (
    (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = 'super_admin'::user_role)))));

CREATE POLICY "ml_auto_reply_templates_write_update" ON public.ml_auto_reply_templates
  FOR UPDATE TO authenticated
  USING (
    (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = 'super_admin'::user_role)))))
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = 'super_admin'::user_role)))));

CREATE POLICY "ml_auto_reply_templates_write_delete" ON public.ml_auto_reply_templates
  FOR DELETE TO authenticated
  USING (
    (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = 'super_admin'::user_role)))));

-- ============================================================
-- 6) ml_connection — ALL → 3 writes; read queda intacta
--    (is_super_admin permite is_active NULL y la read no → la SELECT se
--    consolida con OR en la sección 6b)
-- ============================================================
DROP POLICY "ml_connection_super_admin" ON public.ml_connection;

CREATE POLICY "ml_connection_write_insert" ON public.ml_connection
  FOR INSERT TO authenticated WITH CHECK (is_super_admin(( SELECT auth.uid() AS uid)));

CREATE POLICY "ml_connection_write_update" ON public.ml_connection
  FOR UPDATE TO authenticated
  USING (is_super_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (is_super_admin(( SELECT auth.uid() AS uid)));

CREATE POLICY "ml_connection_write_delete" ON public.ml_connection
  FOR DELETE TO authenticated
  USING (is_super_admin(( SELECT auth.uid() AS uid)));

-- 6b) SELECT consolidada: hoy un super_admin con is_active NULL lee vía la
-- ALL (is_super_admin) aunque la staff_read no lo cubra. El OR preserva exacto.
DROP POLICY "ml_connection_staff_read" ON public.ml_connection;

CREATE POLICY "ml_connection_read" ON public.ml_connection
  FOR SELECT TO authenticated
  USING (
    is_super_admin(( SELECT auth.uid() AS uid))
    OR (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role]))))));

-- ============================================================
-- 7) portal_settings — ALL TO public → 3 writes TO public; read consolidada
--    (la ALL no exige is_active, la read SÍ → el OR preserva exacto)
-- ============================================================
DROP POLICY "portal_settings_admin_all" ON public.portal_settings;
DROP POLICY "portal_settings_staff_read" ON public.portal_settings;

CREATE POLICY "portal_settings_write_insert" ON public.portal_settings
  FOR INSERT TO public WITH CHECK (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role]))))));

CREATE POLICY "portal_settings_write_update" ON public.portal_settings
  FOR UPDATE TO public
  USING (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role]))))))
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role]))))));

CREATE POLICY "portal_settings_write_delete" ON public.portal_settings
  FOR DELETE TO public
  USING (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role]))))));

CREATE POLICY "portal_settings_read" ON public.portal_settings
  FOR SELECT TO authenticated
  USING (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role])))))
    OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role])) AND (profiles.is_active IS DISTINCT FROM false)))));

-- ============================================================
-- 8) property_images — ALL → 3 writes TO authenticated; read consolidada
--    TO public (staff ve todo OR propiedad publicada — anon leía solo eso)
-- ============================================================
DROP POLICY "property_images_admin_write" ON public.property_images;
DROP POLICY "property_images_public_read" ON public.property_images;

CREATE POLICY "property_images_write_insert" ON public.property_images
  FOR INSERT TO authenticated WITH CHECK (
    (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role, 'agente'::user_role]))))));

CREATE POLICY "property_images_write_update" ON public.property_images
  FOR UPDATE TO authenticated
  USING (
    (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role, 'agente'::user_role]))))))
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role, 'agente'::user_role']))))));

CREATE POLICY "property_images_write_delete" ON public.property_images
  FOR DELETE TO authenticated
  USING (
    (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role, 'agente'::user_role]))))));

CREATE POLICY "property_images_read" ON public.property_images
  FOR SELECT TO public
  USING (
    (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = ANY (ARRAY['super_admin'::user_role, 'broker'::user_role, 'agente'::user_role])))))
    OR (EXISTS ( SELECT 1
   FROM properties p
  WHERE ((p.id = property_images.property_id) AND (p.is_published = true) AND (p.deleted_at IS NULL)))));

-- ============================================================
-- 9) site_settings — ALL → 3 writes; read queda intacta (Q_all ⊆ Q_read)
-- ============================================================
DROP POLICY "site_settings_super_admin_write" ON public.site_settings;

CREATE POLICY "site_settings_write_insert" ON public.site_settings
  FOR INSERT TO authenticated WITH CHECK (
    (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = 'super_admin'::user_role)))));

CREATE POLICY "site_settings_write_update" ON public.site_settings
  FOR UPDATE TO authenticated
  USING (
    (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = 'super_admin'::user_role)))))
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = 'super_admin'::user_role)))));

CREATE POLICY "site_settings_write_delete" ON public.site_settings
  FOR DELETE TO authenticated
  USING (
    (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.is_active = true) AND (pr.role = 'super_admin'::user_role)))));

-- ============================================================
-- 10) user_sessions — ALL → 3 writes; SELECT consolidada (super_admin OR dueño)
-- ============================================================
DROP POLICY "user_sessions_super_admin" ON public.user_sessions;
DROP POLICY "user_sessions_own" ON public.user_sessions;

CREATE POLICY "user_sessions_write_insert" ON public.user_sessions
  FOR INSERT TO authenticated WITH CHECK (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'super_admin'::user_role)))));

CREATE POLICY "user_sessions_write_update" ON public.user_sessions
  FOR UPDATE TO authenticated
  USING (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'super_admin'::user_role)))))
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'super_admin'::user_role)))));

CREATE POLICY "user_sessions_write_delete" ON public.user_sessions
  FOR DELETE TO authenticated
  USING (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'super_admin'::user_role)))));

CREATE POLICY "user_sessions_read" ON public.user_sessions
  FOR SELECT TO authenticated
  USING (
    (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'super_admin'::user_role))))
    OR (user_id = ( SELECT auth.uid() AS uid)));
