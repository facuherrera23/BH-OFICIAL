-- Módulo "Administración de Alquileres" — Bloque 4.G: comprobantes/contratos/
-- facturas en Storage. Bucket PRIVADO 'alquileres-adj' con un directorio por
-- usuario: alquileres-adj/<auth.uid()>/<adjunto>. El módulo (con el JWT del
-- usuario) sube/descarga directo por supabase-js; IndexedDB queda como caché
-- local (offline + rendimiento) y Storage como copia durable.
-- Idempotente.

insert into storage.buckets (id, name, public, file_size_limit)
values ('alquileres-adj', 'alquileres-adj', false, 20971520) -- 20 MB por archivo
on conflict (id) do update set public = false, file_size_limit = 20971520;

-- RLS por carpeta: el primer segmento del path tiene que ser el auth.uid().
-- (select auth.uid()) envuelto una vez por query — regla advisor.
drop policy if exists "alq adj read own folder" on storage.objects;
create policy "alq adj read own folder"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'alquileres-adj'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "alq adj insert own folder" on storage.objects;
create policy "alq adj insert own folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'alquileres-adj'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "alq adj update own folder" on storage.objects;
create policy "alq adj update own folder"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'alquileres-adj'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'alquileres-adj'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "alq adj delete own folder" on storage.objects;
create policy "alq adj delete own folder"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'alquileres-adj'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
