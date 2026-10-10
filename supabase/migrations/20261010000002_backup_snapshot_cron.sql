-- backup-snapshot: snapshot lógico diario automático → bucket privado `backups`.
-- La RPC agrupa las tablas de negocio en un JSON (mismo formato que el snapshot
-- manual de docs/BACKUPS.md). El plan free de Supabase no incluye backups; esto
-- es la red diaria de DATOS (el pg_dump del runbook sigue siendo el estructural).
-- Aplicada a producción como backup_snapshot_cron.

CREATE OR REPLACE FUNCTION public.backup_build_snapshot()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $func$
SELECT jsonb_build_object(
  'exported_at', now(),
  'properties', (select jsonb_agg(to_jsonb(p)) from public.properties p),
  'leads', (select jsonb_agg(to_jsonb(l)) from public.leads l),
  'owners', (select jsonb_agg(to_jsonb(o)) from public.owners o),
  'visits', (select jsonb_agg(to_jsonb(v)) from public.visits v),
  'visit_surveys', (select jsonb_agg(to_jsonb(s)) from public.visit_surveys s),
  'lead_activities', (select jsonb_agg(to_jsonb(a)) from public.lead_activities a),
  'lead_tasks', (select jsonb_agg(to_jsonb(t)) from public.lead_tasks t),
  'lead_properties', (select jsonb_agg(to_jsonb(lp)) from public.lead_properties lp),
  'agents', (select jsonb_agg(to_jsonb(a)) from public.agents a),
  'profiles_seguras', (select jsonb_agg(jsonb_build_object('id', p.id, 'role', p.role, 'is_active', p.is_active)) from public.profiles p),
  'owner_portal_tokens', (select jsonb_agg(to_jsonb(t)) from public.owner_portal_tokens t),
  'owner_tasks', (select jsonb_agg(to_jsonb(t)) from public.owner_tasks t),
  'owner_timeline_entries', (select jsonb_agg(to_jsonb(e)) from public.owner_timeline_entries e),
  'ml_listings', (select jsonb_agg(to_jsonb(m)) from public.ml_listings m),
  'tasaciones_sin_data_pesada', (select jsonb_agg(to_jsonb(t) - 'data') from public.tasaciones t),
  'zernio_accounts', (select jsonb_agg(to_jsonb(a)) from public.zernio_accounts a),
  'zernio_conversations', (select jsonb_agg(to_jsonb(c)) from public.zernio_conversations c),
  'zernio_messages', (select jsonb_agg(to_jsonb(m)) from public.zernio_messages m),
  'commissions', (select jsonb_agg(to_jsonb(c)) from public.commissions c),
  'commission_liquidations', (select jsonb_agg(to_jsonb(l)) from public.commission_liquidations l),
  'commission_payments', (select jsonb_agg(to_jsonb(p)) from public.commission_payments p)
);
$func$;

REVOKE ALL ON FUNCTION public.backup_build_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.backup_build_snapshot() TO service_role;

-- Cron: diario a las 04:00 ART (07:00 UTC) — ventana de baja actividad.
-- URL hardcodeada (gotcha del proyecto).
SELECT cron.unschedule('backup-snapshot-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'backup-snapshot-daily');

SELECT cron.schedule(
  'backup-snapshot-daily',
  '0 7 * * *',
  $$
  SELECT net.http_post(
    url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/backup-snapshot',
    headers := '{"Content-Type": "application/json", "x-sync-secret": "caddb570b4ac4dc8f78fd5d43f2be24c8d1a29b57db59df75d1f4f2e6f564db37f7"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
