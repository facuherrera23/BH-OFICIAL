-- Módulo "Administración de Alquileres" — auditoría 2026-11-18 (2 fixes de
-- infraestructura):
--
--   1) HARDENING de grants: la migración 20261114000004 decía "sin
--      UPDATE/DELETE para authenticated" (inmutables por diseño), pero el
--      GRANT implícito de Supabase (ALTER DEFAULT PRIVILEGES) dejaba
--      UPDATE/DELETE a `authenticated` en la tabla: el ACL real era
--      `authenticated=arwdDxtm`. NO era explotable (no hay policies de
--      UPDATE/DELETE → la RLS bloquea toda fila), pero el ACL no coincide
--      con la intención. Se revoca explícitamente.
--
--   2) RETENCIÓN de snapshots: la tabla no tenía purga y crecía ~100 KB por
--      cierre de mes. Se ARchivan primero (COPIA en una tabla espejo) y
--      recién después se borran de la tabla operativa — misma doctrina del
--      proyecto para las tablas de log ("nada se borra sin copia"). Doble
--      condición: más de 180 días Y fuera de los 30 respaldos más recientes
--      de cada usuario (así nunca se tocan los respaldos recientes).
--
-- Idempotente.

-- ─────────────────────────────────────────────────────────────
-- 1) HARDENING: UPDATE/DELETE sólo para service_role
-- ─────────────────────────────────────────────────────────────
revoke update, delete on public.alquileres_snapshots from authenticated;

-- ─────────────────────────────────────────────────────────────
-- 2) Tabla de archivo (espejo, cold storage)
--    RLS ON sin policies → sólo service_role (mismo club intencional que
--    ml_sync_queue_success_archive / audit_log_archive / etc.)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.alquileres_snapshots_archive (
  id uuid primary key,
  user_id uuid not null,
  label text not null,
  period text not null,
  state jsonb not null,
  created_at timestamptz not null,
  archived_at timestamptz not null default now()
);

create index if not exists alq_snaps_archive_user_idx
  on public.alquileres_snapshots_archive (user_id, created_at desc);

alter table public.alquileres_snapshots_archive enable row level security;

revoke all on public.alquileres_snapshots_archive from anon;
revoke all on public.alquileres_snapshots_archive from authenticated;
grant all on public.alquileres_snapshots_archive to service_role;

-- ─────────────────────────────────────────────────────────────
-- 3) Función de archivado + purga
--    SECURITY DEFINER + search_path vacío + EXECUTE sólo service_role.
--    COPIA primero, borra después. Devuelve cuántos respaldos se purgaron.
-- ─────────────────────────────────────────────────────────────
create or replace function public.bh_archive_alquileres_snapshots(
  p_keep int default 30,
  p_max_age_days int default 180
)
returns integer
language plpgsql
security definer
set search_path to ''
as $func$
declare
  v_ids uuid[];
  v_count integer := 0;
begin
  -- candidatos: viejos + fuera de los p_keep más recientes de su usuario
  select array_agg(s.id)
    into v_ids
    from public.alquileres_snapshots s
   where s.created_at < now() - make_interval(days => greatest(p_max_age_days, 0))
     and s.id not in (
       select s2.id
         from public.alquileres_snapshots s2
        where s2.user_id = s.user_id
        order by s2.created_at desc
        limit greatest(p_keep, 0)
     );

  if v_ids is null or array_length(v_ids, 1) is null then
    return 0;
  end if;

  -- COPIA primero (nada se borra sin copia)
  insert into public.alquileres_snapshots_archive
    (id, user_id, label, period, state, created_at)
  select s.id, s.user_id, s.label, s.period, s.state, s.created_at
    from public.alquileres_snapshots s
   where s.id = any(v_ids)
  on conflict (id) do nothing;

  -- recién ahora se borra de la tabla operativa
  delete from public.alquileres_snapshots s
   where s.id = any(v_ids);
  get diagnostics v_count = row_count;

  return v_count;
end;
$func$;

-- ⚠️ La firma real es (integer, integer): con CREATE OR REPLACE y argumentos
-- por defecto, Postgres NO crea la firma corta (integer) — los defaults se
-- aplican en la llamada, no como overload. Por eso los revoke/grant van
-- contra la firma completa.
revoke all on function public.bh_archive_alquileres_snapshots(integer, integer) from public;
revoke all on function public.bh_archive_alquileres_snapshots(integer, integer) from anon;
revoke all on function public.bh_archive_alquileres_snapshots(integer, integer) from authenticated;
grant execute on function public.bh_archive_alquileres_snapshots(integer, integer) to service_role;

-- ─────────────────────────────────────────────────────────────
-- 4) Cron diario (11:15 UTC = 08:15 ART, junto con las demás retenciones)
-- ─────────────────────────────────────────────────────────────
select cron.unschedule('bh-alquileres-snapshots-retention')
where exists (select 1 from cron.job where jobname = 'bh-alquileres-snapshots-retention');

select cron.schedule(
  'bh-alquileres-snapshots-retention',
  '15 11 * * *',
  $$ select public.bh_archive_alquileres_snapshots(30, 180); $$
);
