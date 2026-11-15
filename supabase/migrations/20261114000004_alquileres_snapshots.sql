-- Módulo "Administración de Alquileres" — Bloque 1.B: snapshots inmutables
-- al cerrar mes. Cuando el usuario cierra un mes (mesMas), el controlador
-- inserta una copia profunda del estado acá: "la administración como estaba
-- cuando cerramos X". RLS: cada usuario inserta/lee SOLO los suyos; sin
-- policies de UPDATE/DELETE para authenticated (inmutable por diseño — el
-- valor es que nadie pueda borrar el respaldo por error desde el cliente).
-- Idempotente.

create table if not exists public.alquileres_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,           -- "Cierre Octubre 2026"
  period text not null,          -- YYYY-MM del mes cerrado
  state jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists alquileres_snapshots_user_idx
  on public.alquileres_snapshots (user_id, created_at desc);

alter table public.alquileres_snapshots enable row level security;

drop policy if exists "own snapshots read" on public.alquileres_snapshots;
create policy "own snapshots read"
  on public.alquileres_snapshots
  for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "own snapshots insert" on public.alquileres_snapshots;
create policy "own snapshots insert"
  on public.alquileres_snapshots
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

-- Sin UPDATE/DELETE para authenticated: los snapshots son inmutables desde
-- el cliente (service_role conserva acceso total para mantenimiento).

-- Superficie de API = authenticated con sesión (el módulo siempre opera
-- logueado); sin acceso anónimo.
revoke all on public.alquileres_snapshots from anon;
grant select, insert on public.alquileres_snapshots to authenticated;
grant all on public.alquileres_snapshots to service_role;
