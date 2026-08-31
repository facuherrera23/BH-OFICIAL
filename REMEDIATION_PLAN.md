# REMEDIATION PLAN — Bienenhaus Propiedades (BH-OFICIAL)

> **Basado en**: `AUDIT_FINDINGS.md` (FASE 1, 2026-08-30) — hallazgos F-01…F-15 verificados con evidencia.
> **Objetivo**: llevar el sistema a `READY` para producción tras aplicar esta FASE 2 (remediación) + FASE 3 (testing/regresión) → `PRODUCTION_READINESS_REPORT.md`.
> **Restricciones de misión (no negociables)**:
> - NO inventar resultados / tests / métricas / marcar "pass" sin verificar. Cada fix se demuestra.
> - NO usar la carpeta `landing/` (drift de origen). Todo se despliega desde BH-OFICIAL.
> - CSP sin `unsafe-inline`/`unsafe-eval`.
> - CORS sin `*`.
> - Rate limiting **fail-safe** (ante error de DB NO "todo permitido").
> - Bugfixes mínimos: **no refactorizar mientras se corrige** un hallazgo específico, salvo que el plan lo indique.

---

## Orden de ejecución

| Fase | Alcance | Salida |
|---|---|---|
| **R-1** | P0 — acceso/seguridad DB (F-02, F-03, F-04) | Migración SQL `20260902_remediation_p0_rls_rpc.sql` aplicada y verificada |
| **R-2** | P0 — auth de Edge Functions (F-01) + drift ML (F-05) | `_shared/auth.ts` corregido; schema ML versionado; 14 funciones redeployadas desde el repo |
| **R-3** | P1 (F-06…F-12) | Migraciones + código + settings aplicados y verificados |
| **R-4** | P2 (F-13…F-15) | Revisión XSS sink-a-sink documentada; GUC confirmado; migraciones saneadas |
| **R-5** | Verificación final y regresión | Suite Playwright completa + `PRODUCTION_READINESS_REPORT.md` |

Cada ítem lista: **Acción** (qué se toca) → **Criterio de aceptación** (cómo se demuestra) → **Verificación** (comando/query/evidencia).

---

## R-1 — P0 de base de datos (acceso y RLS)

### R1.1 — F-02: Revocar EXECUTE público de las RPC SECURITY DEFINER de ML

**Acción** — Nueva migración:
```sql
REVOKE ALL ON FUNCTION public.ml_claim_jobs(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ml_enqueue(...) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ml_enqueue_batch(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_commission_on_property_closed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ... TO service_role;  -- (postgres implícito)
```
> Obtener firmas exactas con `pg_get_function_arguments` antes de redactar; copiar y verificar `proacl` antes/después.

**Criterio de aceptación**:
- `proacl` de las 4 funciones pasa a `{postgres=X, service_role=X}`.
- Ejecución con rol `anon`: `SET ROLE anon; SELECT ml_claim_jobs(1);` → error `permission denied for function`.
- **No romper** la cadena del trigger de comisión: verificar `trigger_commission_on_property_closed()` sigue disparándose en contexto de trigger (test con transacción `BEGIN...ROLLBACK` sobre una fila `properties` cerrada).

### R1.2 — F-03: Cerrar RLS del Portal Propietario

**Acción** — Reemplazar la policy `owner_portal_tokens_auth`:
```sql
DROP POLICY owner_portal_tokens_auth ON owner_portal_tokens;
CREATE POLICY owner_portal_tokens_super_admin ON owner_portal_tokens
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'::user_role))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'::user_role));
-- Lectura únicamente de tokens propios iniciada por el portal (sin token en JWT):
-- evaluar si el portal necesita leer vía service_role (edge function generateOwnerPortalLink)
```
> Verificar quién consume `owner_portal_tokens` en el código (`generateOwnerPortalLink` en admin-app.js y `portal-propietario.html`) para no romper el flujo de generación de link: si el frontend admin lo genera directo, debe seguir pasando por la policy; **si usa edge function con service_role, la policy solo protege el acceso ilegítimo** (deseable).

**Criterio de aceptación**:
- `pg_policies` ya no muestra `using_expr = true` en `owner_portal_tokens`.
- Con un usuario `authenticated` no-admin (crear temporalmente un `profiles` `broker`): `SELECT * FROM owner_portal_tokens` → 0 filas; `INSERT` → `new row violates row-level security policy`.
- El flujo admin de generar link sigue funcionando (Playwright gated con credenciales reales).

### R1.3 — F-04: Reemplazar policies anónimas de `visits` por acceso controlado

**Acción** — Eliminar `visits_anon_select_by_token` y `visits_anon_update_by_token`. Publicar un **RPC**:
```sql
CREATE OR REPLACE FUNCTION public.confirm_visit_by_token(p_token uuid, p_action text) RETURNS visits ...
SECURITY INVOKER  -- (o definer SIEMPRE con validación interna del token y de columnas)
```
- Valida el token contra `visits.confirmation_token`, devuelve solo las columnas públicas (client_name, fecha, estado) y aplica `status='confirmada'`/`cancelada` solo si el token es el de ESA fila.
- Revocar `SELECT`/`UPDATE` anónimos sobre `visits` directamente (`REVOKE SELECT, UPDATE ON visits FROM anon`).
- Ajustar `confirmar-visita.html` para llamar al RPC en lugar de `.from('visits')`.

**Criterio de aceptación**:
- Como `anon`: `SELECT * FROM visits` → 0 filas (sin policies anónimas).
- `confirm_visit_by_token(token_bogus,'confirmar')` → error/rechazo; con token correcto → estado cambia solo en esa fila.
- Playwright: smoke de `confirmar-visita.html` con URL real (token correcto e incorrecto).

---

## R-2 — P0 de Edge Functions y drift ML

### R2.1 — F-01: Corregir `_shared/auth.ts`

**Acción**: reescribir `requireAdmin`/`isAdmin` para verificar contra `profiles` (patrón verificado OK en `manage-users`/`cloudinary-sign`/`supervision-api`/`zernio-proxy`):
```ts
const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).maybeSingle();
if (!profile || !profile.is_active) return null;
const ADMIN_ROLES = ['super_admin', 'broker', 'agente'] as const;  // = enum user_role real
```

**Criterio de aceptación**:
- `admin_users` deja de aparecer en el código (grep → 0).
- Con un JWT de un `super_admin` real de prod: `requireAdmin` devuelve el perfil; con rol `agente` → rechaza según política de cada función (definir por función si `broker`/`agente` administran — respetar semántica actual de cada endpoint).
- Las funciones ML vuelven a responder ≠ 401.

### R2.2 — F-05: Versionar schema ML y re-desplegar desde el repo

**Acción**:
1. Escribir migración de creación/alineación del schema ML **contra prod real** (verificar nombres de columnas primero): `ml_connection` (credenciales encriptadas), `ml_sync_cooldown`, `ml_webhook_events` (o migrar código a las tablas existentes `ml_sync_history`/`ml_sync_dead_letter` si es lo correcto), y decidir `site_settings` (eliminar fallback legacy o crear si es usada por otro módulo).
2. Actualizar `_shared/ml.ts` para eliminar `getMlAppCredentialsLegacy` si queda huérfano.
3. **Redesplegar las 14 funciones `ml-*` desde BH-OFICIAL** con el workflow `deploy.yml` (NO desde `landing/`):
   ```
   supabase functions deploy ml-sync ml-oauth ml-callback ml-auth ml-api ml-config \
     ml-categories ml-listing-types ml-metrics ml-answer-question ml-bulk-enqueue \
     ml-revoke-tokens ml-import-listings ml-sync-import ml-webhook
   ```
   Con `--no-verify-jwt` SOLO donde ya estaba (webhook/cron/oauth-callback), `verify_jwt` ON en el resto (verificar listado actual primero).

**Criterio de aceptación**:
- `list_edge_functions` muestra `entrypoint_path` dentro de `BH-OFICIAL/` (CI o máquina local actual), **ninguno** apunta a `landing/`.
- `information_schema.tables` incluye las tablas que referencia el código (o el código fue corregido a tablas existentes).
- Test funcional manual: `ml-webhook` con webhook de prueba firmado → status `processed` (no 401/500); `ml-sync` con corrida manual → logs sin error de tabla.

> ⚠️ **Requiere decisión del usuario**: las credenciales ML en `ml_connection` NO se pueden inventar. Si no hay cuenta real de MercadoLibre conectada, el criterio funcional queda **pendiente de credenciales** (documentar como tal, no marcar pass).

---

## R-3 — P1

### R3.1 — F-06: Rate limiter fail-closed

**Acción** — `_shared/rate-limit.ts`: ante error de DB retornar `{ allowed: false, reason: 'rate_limit_unavailable' }`. Loggear el error. **Verificar consumidores**: las funciones que llaman `checkRateLimit` con `requireRateLimit` real ahora pueden denegar si DB cae — confirmar que el comportamiento resultante es el deseado (denegar = fail-safe).

**Criterio de aceptación**: test del wrapper — mock de cliente Supabase que devuelve error → `allowed === false`.

### R3.2 — F-07: CORS sin `*`

**Acción**: en `_shared/cors.ts`, `manage-users/index.ts` (líneas 34-38) y `cloudinary-sign/index.ts`: usar el allowlist + `Vary: Origin` de `_shared/http.ts` (`corsHeaders(origin)`). Dominios permitidos: `https://bienenhaus.com.ar`, `http://localhost:8788` (y origen del preview de Cloudflare si aplica).

**Criterio de aceptación**: `curl -H "Origin: https://evil.example"` → sin `Access-Control-Allow-Origin` o con un origen distinto del solicitado; con origin permitido → reflectado con `Vary: Origin`.

### R3.3 — F-08: Leaked Password Protection

**Acción**: toggle manual en Supabase Dashboard → Auth → Settings → *Leaked password protection*: ON. **Depende del usuario** (no es SQL).

**Criterio de aceptación**: captura de pantalla/confirmación del dashboard (no inventar).

### R3.4 — F-09: Unificar roles

**Acción**:
- `_shared/auth.ts`: `ADMIN_ROLES = { super_admin, broker, agente }` (FASE R2.1 ya lo hace).
- `README.md`: reemplazar menciones de `admin`/`viewer` por el enum real.
- Frontend `admin-app.js`: revisar guards UI que usen `'admin'`/`'viewer'` (grep) → mapear a roles reales.

**Criterio de aceptación**: grep de `'admin'`/`'viewer'` como rol en código y docs → solo donde sea legítimo (p. ej. comparaciones de string del navegador mapeadas al enum).

### R3.5 — F-10: Limitación de columnas en `profiles`/`agents`

**Acción**:
- Crear vistas `security_invoker` (patrón ya usado en las 8 vistas de auditoría) `staff_profiles_view` y `staff_agents_view` exponiendo solo lo necesario (sin rates de comisión ni emails privados) y dar permisos `SELECT` a `authenticated` sobre las vistas.
- Revocar `SELECT` directo amplio: `REVOKE SELECT ON profiles FROM authenticated` (verificar que nada core dependa de leer profiles completos desde el cliente) o limitar por columnas con `GRANT SELECT (id, full_name, role) ...`.
- `agents_select`: exponer a `authenticated` solo la vista (el público sigue viendo `status='activo'` en la tabla o vista pública).

**Criterio de aceptación**: con usuario `authenticated` no-admin: `SELECT` de columnas sensibles → `permission denied`; la UI del panel (que usa la vista) sigue funcionando (Playwright).

### R3.6 — F-11: Migración base del esquema

**Acción**: generar `supabase/migrations/00000000000000_init.sql` con el esquema real (tablas core, enums, FKs, policies base, triggers) extraído de prod de forma automatizada (`supabase db dump --schema public --data-only=false` o el método que el CLI ofrezca), **revisado humano** y sin datos. Consolidar el duplicado `20260824000013` (F-15) en un solo archivo numerado correctamente.

**Criterio de aceptación**: `supabase db reset` local → esquema idéntico al de prod (diff de tablas/enums/policies = 0) con la suite Playwright verde en local (sin credenciales reales: flujos públicos).

### R3.7 — F-12: Hardening de funciones

**Acción**: para TODAS las funciones con `SECURITY DEFINER` detectable (incluidas las que quedaron con EXECUTE `authenticated`): `ALTER FUNCTION <fn> SET search_path = pg_catalog, public` (o `=''` con refs calificadas). Re-verificar grants (que ninguna función innecesaria siga siendo ejecutable por `authenticated`).

**Criterio de aceptación**: advisor → 0 WARN de `security_definer_view` / search_path mutable; lista de funciones definer con search_path fijo documentada en README.

---

## R-4 — P2

### R4.1 — F-13: Revisión XSS sink-a-sink (NO PASS hasta demostrar)

**Acción**: recorrer los **221 sinks** de `admin-app.js` y **83** de `landing-app.js` (listado con `Select-String innerHTML|insertAdjacentHTML|outerHTML|document.write|eval`) verificando `esc()`/`escAttr`/`safeUrl` en cada interpolación de datos dinámicos (especialmente renders de chat, ML, agenda, fichas HTML, leads). Documentar el recorrido en `XSS_REVIEW.md` con línea + veredicto.

**Criterio de aceptación**: `XSS_REVIEW.md` con cada sink categorizado (esc-aprobado / cubierto-por-helper / **sin-esc → fix**) y 0 sinks dinámicos sin escapar. No basta el conteo 221 vs 264.

### R4.2 — F-14: Confirmar GUC de service role en comisión

**Acción**: verificar cómo se setea `app.settings.service_role_key` en el flujo `trigger_commission_on_property_closed` → si no hay `set_config` en la cadena, pasar el secret por parámetro de la función trigger (leer de una tabla solo-service o env de la edge function `trigger_commission_on_close`).

**Criterio de aceptación**: test funcional — cerrar una propiedad en transacción `BEGIN...ROLLBACK`, verificar que se inserta la comisión y que el `net.http_post` no falla (log).

### R4.3 — F-15: Sanear migraciones

**Acción**: consolidar `20260824000013` (3 archivos) en uno; renumerar si el orden real lo requiere. (Se ejecuta junto con R3.6.)

**Criterio de aceptación**: `ls supabase/migrations` sin duplicados de timestamp; `supabase migration list` consistente con prod.

---

## R-5 — Verificación final y regresión

1. **Suite Playwright** completa (`npm test`): flujos públicos + admin gated con credenciales reales. Requiere `BH_TEST_ADMIN_EMAIL`/`BH_TEST_ADMIN_PASSWORD` → **pedirlos al usuario**.
2. **Regresión RLS**: repetir las queries de `pg_policies`/`proacl` de FASE 1 y comparar contra el estado objetivo (F-02/F-03/F-04 cerrados, F-10 limitado).
3. **Re-auditar con advisor** (`supabase_get_advisors`): 0 security WARN nuevos.
4. **CI**: `node --check` + `npm test` verdes en GitHub Actions; `deploy.yml` redeploya SOLO desde BH-OFICIAL.
5. Escribir `PRODUCTION_READINESS_REPORT.md` con veredicto `READY` / `NOT READY` y el checklist.

---

## Dependencias externas (necesarias para cerrar, no bloquean el plan)

| Dependencia | Para qué | Quién |
|---|---|---|
| Acceso Dashboard Supabase (Leaked Password Protection) | F-08 | Usuario |
| Credenciales admin reales (`BH_TEST_ADMIN_*`) | R-5 (tests gated) | Usuario |
| Cuenta ML conectada o token OAuth de prueba | R2.2 (criterio funcional ML) | Usuario (opcional, se documenta pendiente) |
| Acceso a cuenta Cloudflare correcta | Deploy del estático (N-05) | Usuario |

---

## Definición de Done (FASE 2 completa)

- [ ] R-1…R-4 aplicados, cada item con su evidencia de aceptación adjunta (query, salida, screenshot).
- [ ] `git` con migraciones y código commiteados (cache busters actualizados).
- [ ] Cero P0 abiertos; P1 cerrados o con plan confirmado; P2 documentados.
- [ ] Nada marcado "pass" sin evidencia. Nada desplegado desde `landing/`.