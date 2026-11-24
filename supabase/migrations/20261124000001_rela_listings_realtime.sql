-- RELA / ZonaProp: publicar rela_listings en el canal realtime del admin.
-- Sin esto, el handler `case 'rela_listings'` de setupCoreRealtime() nunca
-- recibe eventos y el panel/badges quedan desactualizados hasta recargar.
-- Aditiva e idempotente: no toma datos ni permisos (RLS de SELECT ya existe).

do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'rela_listings'
  ) then
    alter publication supabase_realtime add table public.rela_listings;
  end if;
end $$;
