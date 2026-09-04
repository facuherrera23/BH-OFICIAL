# Mapa de migraciones — local vs producción (auditoría 2026-09-04)

**IMPORTANTE: NO renombrar NI reaplicar migraciones.** La historia real de producción
(`supabase_migrations.schema_migrations`) difiere de los nombres de archivo locales porque
muchas migraciones se aplicaron a mano (SQL editor / MCP / CLI suelto) con timestamps generados
en el momento. Todo el contenido de las migraciones locales **ya está aplicado en producción**
(verificado por existencia de tablas, funciones, triggers y grants — no por nombre de migración).

## Migraciones locales aplicadas en remoto con OTRO timestamp

| Archivo local | Versión aplicada en producción |
|---|---|
| 20260902000004_fix_audit_trigger_fn_name_cast.sql | 20260831161923 |
| 20260902000005_fix_audit_log_integrity_fn_search_path.sql | 20260831162724 |
| 20260902000006_fix_profiles_sensitive_audit_fn.sql | 20260831164428 |
| 20260902000007_fix_scoped_functions_and_zernio_broker_cols.sql | 20260831175910 |
| 20260903000006_add_properties_locality.sql | 20260902010447 |
| 20260903000007_finish_portal_propietario.sql | 20260902065144 |
| 20260903000007_add_properties_status_flags.sql | 20260902154148 |
| 20260903000008_portal_estadisticas.sql | 20260902073747 |
| 20260903000008_add_properties_is_vendida_reservada.sql | 20260902081630 |
| 20260903000009_portal_propiedades_detalle.sql | 20260902081852 |
| 20260903000010_portal_propiedades_ml_timeline.sql | 20260902084748 |
| 20260903000011_portal_inicio_mejoras.sql | 20260902155831 |
| 20260903000012_portal_exclusividad_stats.sql | 20260902171251 |
| 20260903000013_portal_excl_comparativa.sql | 20260903023342 |
| 20260903000014_portal_prop_description.sql | 20260903024741 |

## Migraciones locales SIN registro en producción, pero cuyo efecto YA EXISTE (aplicadas a mano)

Verificado el 2026-09-04 contra la base real:

- `20260903000004_fix_zernio_broker_trigger.sql` → existen `trg_zernio_conversations_broker`, `trg_zernio_messages_broker`, `zernio_set_broker_id`, `zernio_messages_set_broker_id`
- `20260903000005_zernio_increment_unread.sql` → existe función `zernio_increment_unread`
- `20260903000015_owner_tasks_crm.sql` → existe tabla `public.owner_tasks`
- `20260904000001_hardening_grants.sql` → `insert_audit_log` y `evaluate_supervision_rules` tienen EXECUTE solo para `postgres`/`service_role`
- `20260904000002_drop_orphan_views.sql` → vistas huérfanas eliminadas (verifica `supabase list-tables` / commit c5f1930)

## Versiones en producción SIN archivo local (aplicadas a mano, contenido no versionado)

- `20260831165459_fix_rela_portal_status_search_path`
- `20260901223057_ml_integration_complete_schema`
- `20260901234945_20260901000006_ml_auto_reply_templates_seed`

⚠️ Riesgo: si alguna vez se monta una réplica limpia desde migraciones, estas tres faltarían.
Acción pendiente (baja prioridad): extraer su contenido desde producción y materializarlas como
archivos locales con el mismo nombre de versión.

## Reglas a partir de ahora

1. Toda migración nueva se aplica con `supabase migration up` / `db push` (nunca a mano por el editor).
2. Los timestamps locales duplicados (`...07`×2, `...08`×2) se DEJAN como están: renombrarlos
   desincroniza con la historia remota y puede provocar re-aplicaciones.
3. Antes de cualquier `db push`, correr `supabase migration list` y confirmar divergencias.
