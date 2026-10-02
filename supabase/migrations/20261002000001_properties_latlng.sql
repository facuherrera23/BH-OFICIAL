-- Ubicación exacta: coordenadas elegidas en el mapa del form admin (no destructivo)
alter table public.properties
  add column if not exists latitude numeric(9,6),
  add column if not exists longitude numeric(9,6);

comment on column public.properties.latitude  is 'Latitud decimal marcada en el mapa del form admin';
comment on column public.properties.longitude is 'Longitud decimal marcada en el mapa del form admin';
