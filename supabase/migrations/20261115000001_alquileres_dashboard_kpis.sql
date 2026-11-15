-- Módulo "Administración de Alquileres" — Bloque 2.E: KPIs para el Dashboard.
-- El módulo calcula sus KPIs con la lógica propia del core y los persiste
-- dentro del estado (state->'kpis'); esta RPC los expone al Dashboard.
--
-- ¿Qué fila se lee? La de updated_at más reciente ENTRE las filas que tienen
-- propiedades y kpis calculados. Rationale: hoy el módulo es por-usuario y
-- el "operador activo" es quien guarda por último; una fila vacía de otro
-- usuario (props: []) NO puede tapar los datos reales del operador. Cuando
-- se decida compartir el set a nivel inmobiliaria, acá es el único lugar a
-- cambiar.
--
-- SECURITY DEFINER con search_path vacío (regla advisor) y sin acceso a anon:
-- los KPIs agregan montos de la administración; staff autenticado sí (mismo
-- modelo que el resto del CRM: el staff ve los datos del negocio).
-- Idempotente.

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
   order by s.updated_at desc nulls last
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
