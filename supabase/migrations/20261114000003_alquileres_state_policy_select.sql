-- Fix perf advisor (auth_rls_initplan): la policy "own state" evaluaba
-- auth.uid() por fila; envuelta en (select ...) se evalúa UNA vez por query.
drop policy if exists "own state" on public.alquileres_state;
create policy "own state"
  on public.alquileres_state
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
