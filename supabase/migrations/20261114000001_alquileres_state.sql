-- Módulo "Administración de Alquileres": estado por usuario.
-- Una fila por auth.uid() con TODO el estado del módulo (config de la
-- inmobiliaria, mes en curso, props con servicios/extras, historial de
-- meses cerrados y pagos registrados).
-- La tabla ya existe en producción (creada por dashboard): esta migración la
-- reproduce para proyectos frescos, acota la policy a `authenticated` y
-- revoca los grants de `anon`. Idempotente.

create table if not exists public.alquileres_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz
);

alter table public.alquileres_state enable row level security;

-- Policy por fila: cada usuario ve/escribe ÚNICAMENTE su estado.
-- (Re-creada acotada a `authenticated`: sin `to`, la policy aplica a PUBLIC.)
drop policy if exists "own state" on public.alquileres_state;
create policy "own state"
  on public.alquileres_state
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- El módulo no tiene superficie anónima: el acceso es siempre con sesión.
revoke all on public.alquileres_state from anon;
