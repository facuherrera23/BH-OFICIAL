-- Módulo "Administración de Alquileres" — Bloque 3.A: liquidaciones publicadas
-- al Portal del Propietario. El módulo (alquileres-app.js) arma la liquidación
-- de cada propietario al cerrar el mes (doc k='l' del core) y la publica vía
-- la edge function alquileres-portal-publish (JWT del operador; service role
-- escribe). El portal la lee con la RPC portal_get_liquidaciones (por token).
--
-- Inmutable-para-el-cliente: RLS SIN policies para authenticated/anon
-- (mismo club intencional que ml_oauth_states / rela_tokens: solo service_role
-- escribe y las RPC SECURITY DEFINER leen). El advisor la lista como INFO.
-- UNIQUE(owner_id, period): re-publicar un mes REEMPLAZA la versión anterior.
-- Idempotente.

create table if not exists public.alquileres_portal_liquidaciones (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  period text not null,
  label text not null,
  data jsonb not null,
  published_by uuid not null references auth.users(id),
  published_at timestamptz not null default now()
);

create unique index if not exists alq_portal_liq_owner_period_uidx
  on public.alquileres_portal_liquidaciones (owner_id, period);

create index if not exists alq_portal_liq_owner_idx
  on public.alquileres_portal_liquidaciones (owner_id, period desc);

alter table public.alquileres_portal_liquidaciones enable row level security;

revoke all on public.alquileres_portal_liquidaciones from anon;
revoke all on public.alquileres_portal_liquidaciones from authenticated;
grant all on public.alquileres_portal_liquidaciones to service_role;

-- RPC del portal: misma validación de token que portal_get_portal_data
-- (existe + no revocado + no expirado) y devuelve las liquidaciones del
-- propietario (últimas 24, más nueva primero). EXECUTE a anon: el portal del
-- propietario NO está logueado — club de RPC por token (justificadas).
create or replace function public.portal_get_liquidaciones(p_token text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $func$
declare
  v_owner_id uuid;
begin
  select t.owner_id into v_owner_id
    from public.owner_portal_tokens t
   where t.token = p_token
     and t.revoked_at is null
     and (t.expires_at is null or t.expires_at >= now())
   limit 1;

  if v_owner_id is null then
    return null;
  end if;

  return coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'period', l.period, 'label', l.label,
           'data', l.data, 'published_at', l.published_at
         ) order by l.period desc), '[]'::jsonb)
    from public.alquileres_portal_liquidaciones l
   where l.owner_id = v_owner_id;
end;
$func$;

revoke all on function public.portal_get_liquidaciones(text) from public;
grant execute on function public.portal_get_liquidaciones(text) to anon;
grant execute on function public.portal_get_liquidaciones(text) to authenticated;
grant execute on function public.portal_get_liquidaciones(text) to service_role;
