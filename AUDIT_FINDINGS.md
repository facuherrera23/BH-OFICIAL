# AUDIT FINDINGS — Bienenhaus Propiedades (BH-OFICIAL)

> **Proyecto**: `facuherrera23/BH-OFICIAL` — Landing + Panel admin (Vanilla JS) sobre Supabase (RLS + Edge Functions), Cloudinary, MercadoLibre, Zernio.
> **Proyecto Supabase**: `rnldqiwwzhjnurkguihu` (producción)
> **Fecha de auditoría**: 2026-08-30
> **FASE 1 del plan maestro** — Documento fuente de hallazgos para `REMEDIATION_PLAN.md` (FASE 2).
> **Método**: verificación contra evidencia real — queries SQL en vivo (`pg_policies`, `pg_proc`, `pg_enum`, `information_schema`), lectura del código fuente de Edge Functions y `_shared/` (2.085 líneas), inventario `list_edge_functions` de producción, y cross-check contra `AUDIT_INVENTORY.md` (FASE 0). **Nada se marcó como "pass" sin haber sido verificado**; los items sin demostrar quedan explícitamente como "pendiente".

---

## Resumen ejecutivo

| Severidad | Cantidad | Descripción corta |
|---|---|---|
| **P0** | 5 | Stack MercadoLibre 100% roto (tabla `admin_users` inexistente + schema ML ausente), RPC SECURITY DEFINER ejecutables por anónimos, RLS del portal propietario abierta a cualquier autenticado, policies `visits` anon que fugan PII de clientes |
| **P1** | 7 | Rate limiter fail-open, CORS `*`, Leaked Password Protection off, roles inconsistentes, sobreexposición SELECT de staff, esquema base sin migraciones, hardening de funciones incompleto |
| **P2** | 3 | Cobertura XSS `esc()` no demostrada sistemáticamente, GUC `app.settings.service_role_key` no confirmado, higiene de migraciones (duplicado + drift de deploy) |
| **P3 / Notas** | 5 | Tabla `site_settings` en fallback legacy, `.temp` ya destrackeado, favicons OK, extensiones e INFO de advisor intencionales, etc. |

**Veredicto FASE 1**: **NO listo para producción** — 5 bloques P0 deben resolverse antes de `REMEDIATION_PLAN` y release. Sin embargo, el **mal estado es parcial**: el layer de RLS de las tablas core del CRM (leads/visits/properties/agents con JOIN por `profile_id`) está bien diseñado y verificado, y 9 edge functions huérfanas fueron correctamente eliminadas en prod (verificado en `list_edge_functions`).

---

## P0 — Crítico (bloquea release)

### F-01 — `_shared/auth.ts` consulta la tabla `admin_users`, que NO existe en producción → 13 Edge Functions de MercadoLibre devuelven 401 para todos los usuarios

**Evidencia**:
- `supabase/functions/_shared/auth.ts`: `requireAdmin()` / `isAdminUser()` ejecutan `.from('admin_users')` (fail-closed: ante error devuelve `null` → `401`).
- `SELECT table_schema, table_name FROM information_schema.tables WHERE table_name='admin_users'` → **0 filas en ningún schema** (verificado vía API de Supabase).
- `grep "_shared/auth"` sobre `supabase/functions/*/index.ts` → **13 funciones la importan**:
  `ml-answer-question`, `ml-bulk-enqueue`, `ml-categories`, `ml-import-listings`, `ml-listing-types`, `ml-metrics`, `ml-oauth`, `ml-revoke-tokens`, `ml-sync`, `ml-sync-import`, `chat-ai`, `chat-upload`, `process-retention-policies` (las últimas 3 ya eliminadas de prod).
- En producción siguen desplegadas con `verify_jwt=false` o `true` localmente usan `requireAdmin` → **siempre 401**.

**Consecuencia funcional** (P0 de negocio): el módulo **Portales & APIs (ML)** — connect OAuth, publish, sync, import, auto-reply — está completamente caído. El panel `admin.html` (tab `Portales & APIs`) falla en toda operación ML.

**Consecuencia de seguridad**: es fail-closed (no es una apertura), pero crea presión para "arreglarlo" con un bypass (riesgo de futura mala corrección tipo `allow all`).

**Solución esperada**: migrar `_shared/auth.ts` al patrón ya correcto usado por `manage-users`, `cloudinary-sign`, `supervision-api`, `zernio-proxy` (verificar rol en `profiles.role` — `super_admin`/`broker`/`agente` — e `is_active`, no en una tabla fantasma).

---

### F-02 — RPC `ml_claim_jobs`, `ml_enqueue`, `ml_enqueue_batch`: SECURITY DEFINER con EXECUTE PÚBLICO (anon) y owner `postgres`

**Evidencia** (query `pg_proc` + `proacl`, heredada de advisor + verificación directa):

| Función | owner | SECURITY DEFINER | ACL |
|---|---|---|---|
| `ml_claim_jobs(integer)` | `postgres` | sí | `{=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}` → **`=X` = PUBLIC tiene EXECUTE** |
| `ml_enqueue(...)` | `postgres` | sí | idem |
| `ml_enqueue_batch(jsonb)` | `postgres` | sí | idem |
| `trigger_commission_on_property_closed()` | `postgres` | sí | idem (trigger function; direct call falla por falta de `NEW`, explotación limitada pero debe revocarse) |

**Impacto**:
- `ml_claim_jobs(p_batch_size DEFAULT 10)`: hace `UPDATE ml_sync_queue SET status='processing', locked_by=auth.uid(), attempts=attempts+1 ... RETURNING q.*` → un **anónimo** puede **robar trabajos de la cola** (marcarlos como suyos → DoS del sync) y **leer el payload completo** de las filas de la cola (property_ids, operaciones, datos de publicación ML).
- `ml_enqueue` / `ml_enqueue_batch`: un anónimo puede **insertar jobs arbitrarios** → flooding de la cola y disparo de operaciones arbitrarias contra `ml_listings` / propiedades.

**Solución esperada**: `REVOKE EXECUTE ... FROM public, anon, authenticated`; dejar solo `service_role` (+ `postgres`); verificar que la migración `20260901000001` no cubrió estas 4 funciones.

---

### F-03 — RLS `owner_portal_tokens_auth` = `FOR ALL TO authenticated USING (true) WITH CHECK (true)` → cualquier usuario autenticado del staff puede leer/crear/rotar/borrar tokens del Portal Propietario

**Evidencia** (query `pg_policies` en vivo):

```
tablename           policyname                 cmd  roles           using_expr  with_check
owner_portal_tokens owner_portal_tokens_auth   ALL  {authenticated}  true        true
```

**Impacto**:
- Robo de sesión del **Portal Propietario** (`portal-propietario.html?token=...`): con un token se accede a expediente completo (propiedades, documentos, comisiones/liquidaciones) de cualquier propietario.
- Un usuario con rol mínimo (`viewer`/`agente`, cualquiera que sepa loguearse) puede listar todos los tokens (`SELECT *`), rotarlos (intercepta el portal) o **borrarlos (DoS)**.
- 1 token existe en prod hoy → exposición real inmediata.

**Solución esperada**: policies que verifiquen `super_admin` (o `profiles.role` en general) para lectura/escritura; jamás `true` en `WITH CHECK`.

---

### F-04 — Policies `visits` anónimas por token: `USING (confirmation_token IS NOT NULL)` → un anónimo puede enumerar TODAS las visitas con token y modificar cualquier visita

**Evidencia** (query `pg_policies` en vivo):

```
visits_anon_select_by_token  SELECT {anon}  (confirmation_token IS NOT NULL)
visits_anon_update_by_token  UPDATE {anon}  (confirmation_token IS NOT NULL)  CHECK (confirmation_token IS NOT NULL)
```

**Impacto**:
- **Fuga de PII**: `GET /rest/v1/visits?select=*` con la anon key devuelve **todas** las filas de `visits` que tengan `confirmation_token` (client_name, propiedad, agente, fecha, estado → nombres/contactos de clientes del CRM).
- **Integridad**: un anónimo puede hacer `PATCH /visits...status=eq.X` sobre cualquier visita con token (marcarla confirmada/cancelada) **sin conocer su token** (el policy solo exige que *exista* el token en la fila, no que se provea el correcto).

**Solución esperada**: nunca exponer `visits` con policies basadas solo en "token no nulo". Alternativas correctas: un **RPC** `confirm_visit(token, action)` con validación intra-función, o una **vista `security_invoker`** con solo las columnas públicas + RLS que compare el token contra una variable de sesión; y limitar las columnas expuestas vía `GRANT SELECT (columnas)`.

---

### F-05 — Drift de schema y deploy del stack ML: el código del repo referencia tablas que NO existen en producción

**Evidencia**:
- `information_schema.tables` (filtro `ml_%`, schema public) → **existen**: `ml_listings`, `ml_model_metrics`, `ml_model_performance`, `ml_predictions_log`, `ml_sync_dead_letter`, `ml_sync_history`, `ml_sync_queue`.
- **NO existen**: `ml_connection`, `ml_sync_cooldown`, `ml_webhook_events` (referenciadas por el repo), ni `site_settings`.
- `_shared/ml.ts`: `.from('ml_connection')` (líneas 212, 250, 279), `.from('ml_sync_cooldown')` (310, 337), `.from('site_settings')` (71, fallback legacy `getMlAppCredentialsLegacy`).
- `ml-webhook/index.ts`: escribe `ml_webhook_events` (líneas 83–113) — inserción que falla en silencio si la tabla no existe; `verifySignature()` lee el secret desde `getMlCredentials()` (tabla inexistente → secret `undefined` → `false`) → **todos los webhooks de MercadoLibre rechazados**.
- `list_edge_functions` (prod): las 14 funciones `ml-*` desplegadas tienen `entrypoint_path` apuntando a `/Users/facuh/.../landing/supabase/functions/...` (**la carpeta `landing/`, no presente en este repo**) y `ml-sync` desde CI (`/home/runner/work/BH-OFICIAL/...`) → **el código que corre en prod NO es el código auditado del repo**.

**Impacto**: el módulo ML es **inoperable e irreproducible**. Peor aún: como no podemos leer el código desplegado, las garantías de seguridad de las funciones ML en prod son **desconocidas** (solo pendiente del drift, no verificable). Esto viola la restricción de misión "no usar la carpeta `landing/`" a nivel de *deploy* real.

**Solución esperada**: definir el schema ML completo como migraciones versionadas (`ml_connection`, `ml_sync_cooldown`, `ml_webhook_events` o reescribir a las tablas existentes), y **re-desplegar** las 14 funciones desde el repo (CI), nunca desde `landing/`.

---

## P1 — Alto (corregir dentro de la FASE 2)

### F-06 — Rate limiter **fail-open** (`_shared/rate-limit.ts`)
Ante un error de base de datos, `checkRateLimit` retorna `{ allowed: true }` → si el log de rate limiting falla, **se permite todo**. Viola la restricción de misión ("rate limiting fail-safe, ante error de DB NO 'todo permitido'"). Todas las funciones que usan `withRateLimit`/`checkRateLimit` quedan afectadas (13+ en repo).
**Fix esperado**: fail-closed (denegar ante error) o doble capa en memoria.

### F-07 — CORS `*` en `manage-users`, `cloudinary-sign` y `_shared/cors.ts`
- `manage-users/index.ts` (líneas 34–38) y `cloudinary-sign/index.ts` devuelven `Access-Control-Allow-Origin: *` (más `Credentials` no expuesto, pero `*` + métodos abiertos = cualquier origen puede invocar los endpoints).
- `_shared/cors.ts` aplica `*` para las funciones que lo usan.
- Mitigación parcial: ambas funciones validan el JWT internamente (rol en `profiles`) → el riesgo real es menor (no hay fuga sin token válido), pero **viola la restricción de misión** y el estándar.
**Fix esperado**: usar el allowlist + `Vary: Origin` de `_shared/http.ts` (ya existe).

### F-08 — Leaked Password Protection **DISABLED** (Supabase Auth)
Advisor de seguridad → WARN/error: la protección contra credenciales filtradas (Have I Been Pwned) está apagada. Es un toggle del Dashboard (no vía SQL) → dependerá del usuario. Mitiga credential stuffing en el login del panel.

### F-09 — Roles inconsistentes entre código, DB y documentación
- **Enum real en prod** (`pg_enum`): `user_role = {super_admin, broker, agente}`.
- `_shared/auth.ts`: `ADMIN_ROLES = ['super_admin','admin','staff']` (código muerto contra el enum).
- `README.md`: documenta `admin` y `viewer` como roles válidos (no existen en el enum).
- `manage-users`: `VALID_ROLES = super_admin|broker|agente` (correcto).
- Policies RLS: `'super_admin'::user_role` (correcto contra el enum).
**Impacto**: riesgo de que panel/edge functions autoricen o denieguen por un valor que no existe; la doc contradice la realidad. **Fix**: unificar a `{super_admin, broker, agente}` en `_shared/auth.ts`, README y guards de UI (el frontend también menciona `admin`/`viewer`).

### F-10 — Sobreexposición SELECT de staff: `profiles_select_auth` y `agents_select`
```
profiles_select_auth  SELECT {public}  (auth.uid() IS NOT NULL)        → todo autenticado lee TODOS los perfiles (emails, roles, is_active)
agents_select         SELECT {public}  ((status='activo') OR (auth.uid() IS NOT NULL))  → todo autenticado lee TODOS los agents (incl. inactivos, matrícula, rates de comisión)
```
El público solo ve lo activo en agents (correcto para la landing), pero **cualquier usuario autenticado** (hasta un `agente`/`viewer`) lee la lista completa de staff con datos de comisión (`commission_sale`/`commission_rent`). **Fix**: exponer a `authenticated` solo las columnas necesarias (vista `security_invoker` o `GRANT SELECT (columnas)`) y dejar `profiles` legible solo por `super_admin`/sí mismo.

### F-11 — Esquema base NO versionado en migraciones
El esquema (tablas core `profiles`, `properties`, `agents`, `leads`, `visits`, `owners`, enums `user_role`/`agent_status`, policies base, triggers) se creó/manipuló **fuera del repositorio**. En `supabase/migrations/` existen solo **27 migraciones delta** (paquete auditoría/RLS/CMS/Zernio/comisiones/ML) y **ninguna contiene `CREATE TABLE profiles`/`properties`/`agents`**. → El proyecto **no es reproducible desde cero** y el drift entre repo y prod es inevitable. Duplicado `20260824000013` (3 archivos) empeora la higiene. **Fix**: migración base `00000000000000_init.sql` que replique el esquema real (generada desde prod), y reordenación de duplicados.

### F-12 — Hardening de funciones incompleto (SECURITY DEFINER + search_path)
La migración `20260901000001` revocó EXECUTE a `public` en ~44 funciones, pero **quedan executable por `authenticated`** (y con `search_path` mutable, advisor WARN): `generate_property_code`, `set_property_code`, `get_sidebar_badge_counts`, `audit_log_integrity_fn`, `audit_trigger_fn`, `set_assigned_at_fn`, `update_notification_prefs_updated_at`, `zernio_set_broker_id`, `zernio_messages_set_broker_id`, `profiles_sensitive_audit_fn`, `is_super_admin`. No tienen `SET search_path` fijo → vector clásico de hijacking. **Fix**: `ALTER FUNCTION ... SET search_path = ''` (o schema explícito) en todas + doble-check de los grants del F-02.

---

## P2 — Medio (programar en FASE 2)

- **F-13 — XSS: cobertura `esc()` no demostrada de forma sistemática.** `admin-app.js`: 221 sinks `innerHTML|insertAdjacentHTML|outerHTML|document.write|eval` frente a 264 llamadas a `esc(`; `landing-app.js`: 83 sinks / 113 `esc(`. El muestreo en renders de dashboard/propiedades/leads muestra uso correcto de `esc()`/helpers de `utils.js`, **pero** los renders de chat/ML/agenda no se pudieron verificar sink a sink en esta fase (funciones con nombres distintos a los esperados). **Estado: NO PASS** — requiere recorrido line-by-line de los 221 sinks (especialmente chat, ML, leads, fichas HTML exportadas, listados) antes de release.
- **F-14 — GUC `app.settings.service_role_key` no confirmado en producción.** `trigger_commission_on_property_closed()` (y por extensión el flujo de comisión al cerrar propiedad) depende de `current_setting('app.settings.service_role_key', true)`; la consulta `pg_settings LIKE 'app.settings%'` **no retornó la variable** → el `net.http_post` a `trigger_commission_on_close` podría estar fallando en silencio. Necesita prueba funcional (cerrar una propiedad) o fix (pasar el secret por parámetro/env de la función).
- **F-15 — Migración duplicada `20260824000013`** (3 archivos: base + `part1` + `part2`) y falta de esquema base versionado (ver F-11). Riesgo de orden de aplicación ambiguo en un futuro `db reset`.

---

## P3 / Notas (registrar, no bloquean)

- **N-01** — `_shared/ml.ts` tiene fallback legacy `getMlAppCredentialsLegacy()` → `.from('site_settings')` (tabla inexistente); código muerto/inconsistente que debe eliminarse al versionar el schema ML (F-05).
- **N-02** — `supabase/.temp/*` estaba trackeado; `git rm --cached` ejecutado el 2026-08-30 (verificado en git). No re-commitear.
- **N-03** — Advisor INFO: `rls_enabled_no_policy` en `property_sequences` y `zernio_config` = **intencional** (acceso solo service_role). `zernio_webhook_events` RLS on sin policies = deny-default correcto. Extensión `pg_net` en public = requerida por edge functions (documentado).
- **N-04** — Admins/sesiones: `profiles` tiene 4 filas, `agents` 2, `auth.users` sin count verificado en esta fase (se confirmó que existe al menos 1 token de portal y 0 comisiones). Para pruebas gated se requieren credenciales reales (`BH_TEST_ADMIN_EMAIL`/`PASSWORD`) que aún no tenemos.
- **N-05** — Cloudflare Pages: deploy bloqueado por **401 (token de cuenta equivocada)**; el usuario no tiene acceso a la cuenta correcta → **dependencia externa** (no es hallazgo de código). Guía documentada en `CLOUDFLARE_SETUP.md`.

---

## Verificado como OK en esta fase (contra-evidencias)

Para que la FASE 2 no re-audite lo ya demostrado:

| Área | Evidencia |
|---|---|
| RLS `leads` | `leads_select`/`leads_update` restringidas a `super_admin` o agentes `assigned_to`/`created_by` (JOIN `agents.profile_id`) — verificado en `pg_policies`. |
| RLS `visits` autenticadas | `visits_select`/`visits_update`/`visits_delete`: `super_admin` o `created_by=auth.uid()` o `agent_id` propio (JOIN) — correcto. |
| RLS `properties` admin | `properties_admin_*`: `super_admin` o agente con `agent_id` propio — correcto. `properties_public_read` ahora `TO public` (fix 20260830) → landing funcional. |
| RLS `agents` admin | `agents_admin_*`: `super_admin` (INSERT/DELETE/UPDATE), self-update por `profile_id` — correcto. |
| RLS `app_settings` | solo `super_admin` para INSERT/UPDATE (check via profiles) — correcto. |
| RLS `audit_log` | `SELECT` solo `super_admin`; sin INSERT/UPDATE/DELETE para autenticados (service-role only) — correcto. |
| RLS `zernio_config` | `api_key` solo `super_admin`; webhook secret no expuesto por RLS → lo lee `zernio-webhook` con service role — correcto. |
| RLS `leads_anon_insert` | `source IN ('landing_page','newsletter')` — correcto (formulario público). |
| auth interna edge functions | `manage-users`, `cloudinary-sign`, `supervision-api`, `zernio-proxy` validan rol en `profiles` (patrón correcto) — verificado en el código fuente. |
| `zernio-webhook` | HMAC + `timingSafeEqual`, dedup por event id, límite 1 MB, CORS allowlist — correcto (usar como referencia para ML). |
| `supervision-api` | rate limit 60 req/min + `requireSuperAdmin` propio — correcto. |
| `cloudinary-sign` | JWT + rol activo + allowlist `ALLOWED_FOLDERS` + SHA-1 — correcto (salvo CORS `*`, F-07). |
| Huérfanas eliminadas | `list_edge_functions` — las 9 huérfanas (chat-ai, chat-upload, qr-checkin, admin-user-invite, audit-log, process-retention-policies, contact-submit, convert-image, visits-process-reminders) **NO están en prod** — verificado. |
| Secrets en repo | scan completo: sin secretos reales (solo nombres de env vars y ejemplos `sk_live_...`). npm audit `--omit=dev` = 0 vulns, sin Docker/compose/config.toml. |

---

## Pendientes de verificación funcional (no bloquean el documento)

1. Probar `trigger_commission_on_close` con una propiedad real en estado cerrada (F-14).
2. Ejecutar suite Playwright admin gated con credenciales reales una vez restaurado el módulo ML (F-01/F-05).
3. Reconfirmar el código desplegado en prod de las 14 funciones `ml-*` tras re-desplegar desde el repo (F-05).

---

*Documento generado en FASE 1 de la auditoría integral. Todas las afirmaciones con severidad P0/P1 tienen evidencia verificada (query SQL, lectura de código o inventario de producción) registrada en esta sesión.*