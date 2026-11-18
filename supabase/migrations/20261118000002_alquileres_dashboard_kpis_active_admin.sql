-- Módulo "Administración de Alquileres" — auditoría 2026-11-18: la RPC de
-- KPIs del Dashboard deja de leer "la fila que guardó último" a secas.
--
-- HALLAZGO (P2): la función elegía la fila con updated_at más reciente entre
-- las que tenían props>0 y kpis. Con más de una fila en la base (una de
-- PRUEBA con 1 prop '001' y sin datos de la inmobiliaria) la tarjeta del
-- Dashboard podía mostrar los KPIs de una administración que NO es la del
-- operador — alternando según quién guardó por última vez.
--
-- FIX: se exige que la fila sea una administración REAL:
--   props es array no vacío  AND  kpis presentes
--   AND state->'corr'->'n' <> ''  (datos de la inmobiliaria cargados)
-- Además se desempata por s.user_id → selection determinista ante
-- updated_at empatado.
--
-- Mismo criterio que aplica ahora el recordatorio de cierre de mes
-- (alquileres-month-reminder): "administración activa" = props + corr.n.
-- La fila de PRUEBA y la fila vacía quedan fuera sin necesidad de borrar
-- datos (nada se borra sin OK explícito del dueño).
--
-- SECURITY DEFINER con search_path vacío (regla advisor). Sin acceso a anon:
-- los KPIs agregan montos de la administración; staff autenticado sí.
-- Idempotente (create or replace).

create or replace function public.alquileres_dashboard_kpis()
returns json
language plpgsql
security definer
set search_path to ''
as $func$
declare
  v_kpis jsonb;
  v_updated timestamptz;
begin
  select s.state->'kpis', s.updated_at
    into v_kpis, v_updated
    from public.alquileres_state s
   where s.state->'kpis' is not null
     and jsonb_typeof(s.state->'props') = 'array'
     and jsonb_array_length(s.state->'props') > 0
     and coalesce(btrim(s.state->'corr'->>'n'), '') <> ''
   order by s.updated_at desc nulls last, s.user_id
   limit 1;

  if v_kpis is null then
    return null;
  end if;

  return json_build_object('kpis', v_kpis, 'updated_at', v_updated);
end;
$func$;

revoke all on function public.alquileres_dashboard_kpis() from public;
revoke all on function public.alquileres_dashboard_kpis() from anon;
grant execute on function public.alquileres_dashboard_kpis() to authenticated;
grant execute on function public.alquileres_dashboard_kpis() to service_role;
