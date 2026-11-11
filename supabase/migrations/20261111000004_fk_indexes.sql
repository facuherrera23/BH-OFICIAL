-- P3 del plan de performance (H7 — auditoría AUDITORIA_CONTENIDO_2026-11-11).
-- Lint unindexed_foreign_keys: 32 FKs sin índice en la tabla hija.
-- Cuando el padre recibe DELETE/UPDATE, Postgres escanea la hija para
-- verificar referencias: sin índice es un SEQ SCAN por cada borrado del padre.
--
-- Alcance exacto (verificado contra producción 2026-11-11):
--   * 103 FKs en public, 32 sin índice con columna líder (scan propio sobre
--     pg_constraint × pg_index — coincide 1:1 con el advisor).
--   * Los tamaños reales: supervision_baselines 215.769 filas,
--     ml_sync_queue 69.287, supervision_anomalies 9.097 — los que más
--     benefician; el resto son tablas chicas o nuevas (social_*).
--   * El índice necesita la FK como COLUMNA LÍDER (indkey[0] = conkey[1]).
--
-- Notas:
--   * Plain CREATE INDEX, SIN CONCURRENTLY (las migraciones corren en
--     transacción; el build más pesado —215k filas— tarda ~1-2s y el lock
--     contra writes es despreciable frente al cron de supervision cada 5 min).
--   * CREATE INDEX IF NOT EXISTS: idempotente (el nombre es nuevo, no
--     colisiona — el scan propio confirmó que ningún índice ya cubre la col).
--   * Costo de escritura agregado: índices de 1 columna en tablas chicas,
--     despreciable frente al beneficio de los RI checks.

CREATE INDEX IF NOT EXISTS lead_activities_created_by_idx   ON public.lead_activities (created_by);
CREATE INDEX IF NOT EXISTS lead_offers_created_by_idx       ON public.lead_offers (created_by);
CREATE INDEX IF NOT EXISTS lead_properties_property_id_idx  ON public.lead_properties (property_id);
CREATE INDEX IF NOT EXISTS lead_tasks_assigned_to_idx       ON public.lead_tasks (assigned_to);
CREATE INDEX IF NOT EXISTS lead_tasks_created_by_idx        ON public.lead_tasks (created_by);
CREATE INDEX IF NOT EXISTS broker_blocks_agent_id_idx       ON public.broker_blocks (agent_id);
CREATE INDEX IF NOT EXISTS owner_notifications_agent_id_idx ON public.owner_notifications (agent_id);
CREATE INDEX IF NOT EXISTS tasaciones_created_by_idx        ON public.tasaciones (created_by);
CREATE INDEX IF NOT EXISTS visit_surveys_property_id_idx    ON public.visit_surveys (property_id);
CREATE INDEX IF NOT EXISTS qr_checkins_visit_id_idx         ON public.qr_checkins (visit_id);

CREATE INDEX IF NOT EXISTS supervision_baselines_user_id_idx ON public.supervision_baselines (user_id);
CREATE INDEX IF NOT EXISTS supervision_anomalies_user_id_idx ON public.supervision_anomalies (user_id);
CREATE INDEX IF NOT EXISTS supervision_anomalies_acknowledged_by_idx ON public.supervision_anomalies (acknowledged_by);
CREATE INDEX IF NOT EXISTS supervision_anomalies_dismissed_by_idx    ON public.supervision_anomalies (dismissed_by);
CREATE INDEX IF NOT EXISTS supervision_anomalies_resolved_by_idx     ON public.supervision_anomalies (resolved_by);
CREATE INDEX IF NOT EXISTS supervision_alerts_acknowledged_by_idx ON public.supervision_alerts (acknowledged_by);
CREATE INDEX IF NOT EXISTS supervision_alerts_assigned_by_idx     ON public.supervision_alerts (assigned_by);
CREATE INDEX IF NOT EXISTS supervision_alerts_dismissed_by_idx    ON public.supervision_alerts (dismissed_by);
CREATE INDEX IF NOT EXISTS supervision_alerts_resolved_by_idx     ON public.supervision_alerts (resolved_by);
CREATE INDEX IF NOT EXISTS supervision_anomaly_config_created_by_idx ON public.supervision_anomaly_config (created_by);
CREATE INDEX IF NOT EXISTS supervision_anomaly_config_user_id_idx    ON public.supervision_anomaly_config (user_id);
CREATE INDEX IF NOT EXISTS supervision_rules_created_by_idx ON public.supervision_rules (created_by);

CREATE INDEX IF NOT EXISTS ml_sync_queue_locked_by_idx       ON public.ml_sync_queue (locked_by);
CREATE INDEX IF NOT EXISTS ml_sync_cooldown_connection_id_idx ON public.ml_sync_cooldown (connection_id);
CREATE INDEX IF NOT EXISTS ml_oauth_states_admin_user_id_idx ON public.ml_oauth_states (admin_user_id);
CREATE INDEX IF NOT EXISTS ml_auto_reply_log_template_id_idx ON public.ml_auto_reply_log (template_id);

CREATE INDEX IF NOT EXISTS social_posts_created_by_idx      ON public.social_posts (created_by);
CREATE INDEX IF NOT EXISTS social_posts_property_id_idx     ON public.social_posts (property_id);
CREATE INDEX IF NOT EXISTS social_comments_account_id_idx   ON public.social_comments (account_id);
CREATE INDEX IF NOT EXISTS social_comments_lead_id_idx      ON public.social_comments (lead_id);
CREATE INDEX IF NOT EXISTS social_comments_social_post_id_idx ON public.social_comments (social_post_id);

CREATE INDEX IF NOT EXISTS site_settings_updated_by_idx     ON public.site_settings (updated_by);
