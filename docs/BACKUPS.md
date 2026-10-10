# Estrategia de backups — BIENENHAUS

> **Contexto crítico:** el proyecto corre en el plan **free de Supabase, que NO incluye backups automáticos**. La base tiene datos reales de clientes (leads con teléfonos, propiedades, conversaciones). Este documento es la red de seguridad.

---

## Reglas

1. **Frecuencia:** semanal + **siempre antes** de cualquier operación riesgosa (migraciones con DROP/ALTER, cambios de RLS, deletes).
2. **Los backups NUNCA se commitean** — `backups/` está en `.gitignore` porque contiene datos reales de clientes.
3. **Copia externa:** el archivo de backup debe quedar también fuera de la máquina (OneDrive/Drive del dueño).
4. **Verificar antes de confiar:** todo backup se valida al crearlo (el script lo hace con `pg_restore --list`).

---

## Herramienta 1 — Backup completo (estructural, el que manda)

```powershell
# Connection string: Supabase Dashboard → Settings → Database → URI (Session pool)
.\scripts\backup-database.ps1
# o: .\scripts\backup-database.ps1 -Conn "postgresql://..."
```

- Produce `backups/backup-<fecha>.dump` (formato custom de `pg_dump`).
- **Restauración** en una DB destino:
  ```powershell
  pg_restore --clean --if-exists --no-owner -d "<connection-string-destino>" "backups\backup-<fecha>.dump"
  ```
- Requiere `pg_dump` instalado (PostgreSQL client).

## Herramienta 2 — Snapshot lógico de emergencia (sin pg_dump)

Export JSON de las tablas de negocio, ejecutable desde SQL directo:

```sql
-- Ver backup-logico-2026-10-10.json como ejemplo del formato.
-- Selecciona jsonb_build_object('exported_at', now(), 'properties',
-- (select jsonb_agg(to_jsonb(p)) from public.properties p), ... )::text as backup;
```

Ideal si no hay pg_dump a mano: guarda los DATOS (no la estructura) de las tablas críticas. El archivo `backups/backup-logico-2026-10-10.json` (569 KB, 74 leads, 44 propiedades, 25 propietarios, 267 actividades, tokens de portal, chat, encuestas) fue el primero y sirve como línea base verificada.

## Qué contiene cada capa

| Herramienta | Estructura (DDL) | Datos | Notas |
|---|---|---|---|
| pg_dump (`.dump`) | ✅ completa | ✅ completa | Restaurable a un proyecto Supabase nuevo |
| Snapshot lógico (`.json`) | ❌ | ✅ tablas de negocio | Excluye a propósito: `zernio_config`, `ml_connection`, `rela_config/tokens` (secretos — re-credentialar manual) y la columna pesada `tasaciones.data` (fotos base64) |

## Si pasa lo peor (borrado accidental de datos)

1. **No hacer nada más** en la base (cada write pisa más).
2. Restaurar el `.dump` más reciente en un proyecto Supabase **nuevo/free** (para revisar sin tocar producción).
3. Extraer las filas necesarias y re-insertarlas con INSERT explícitos (nunca DROP/TRUNCATE en producción sin aprobación del dueño — regla de AGENTS.md).
4. Para perder lo mínimo: combinar con el snapshot JSON más reciente.

---

*La existencia de este documento responde al hallazgo de la evaluación crítica de octubre 2026: "sin estrategia de backups documentada para una DB con datos reales".*
