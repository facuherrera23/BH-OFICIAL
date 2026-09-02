-- Add 3 new boolean flags to properties:
--   is_shared    = Compartido (compartida con otros brokers, compatible con Publicada)
--   is_vendida   = Vendida (incompatible con Publicada, fuerza is_published=false)
--   is_reservada = Reservada (incompatible con Publicada, fuerza is_published=false)
ALTER TABLE properties
    ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_vendida boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_reservada boolean NOT NULL DEFAULT false;
