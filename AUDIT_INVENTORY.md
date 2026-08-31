# AUDIT_INVENTORY — BH-OFICIAL / Bienenhaus Propiedades

> **FASE 0 — INVENTARIO COMPLETO** · Fecha: 2026-08-30 · Método: verificación contra código real del repo (no solo documentación) · Modificaciones: **ninguna** (solo lectura)

---

## 1. Identidad y URLs

| Ítem | Valor |
|---|---|
| Nombre | Bienenhaus Propiedades — Landing pública + CRM inmobiliario |
| Sitio público | `https://bienenhaus.com.ar/` |
| Repo | `https://github.com/facuherrera23/BH-OFICIAL.git` (rama `main`) |
| Proyecto Supabase | `rnldqiwwzhjnurkguihu` (API: `https://rnldqiwwzhjnurkguihu.supabase.co`, región São Paulo) |
| Hosting estático | Cloudflare Pages (`CNAME` → `bienenhaus.com.ar`) |
| HEAD local | `fa3ba29` (sincronizado con `origin/main`) |

---

## 2. Tecnologías detectadas (verificadas en código)

| Capa | Tecnología | Evidencia |
|---|---|---|
| Frontend | Vanilla JS (scripts clásicos IIFE + `window.*` globals, **sin build step**, sin ES modules) | `assets/js/*.js`; `package.json` sin deps runtime |
| Validación frontend | Zod 3 UMD (`assets/js/zod.umd.js`, 4.055 líneas) — solo admin | `admin.html` script tag |
| CSS | Custom properties, Font Awesome 6.5.1 (CDN), Leaflet 1.9.4 + Chart.js 4.4.0 solo en `tasacion.html` | metas CSP por página |
| Backend | Supabase: PostgreSQL + Auth (GoTrue) + RLS + Realtime + Edge Functions (Deno TS) | `supabase/functions/*`, `supabase-client.js` |
| Edge Functions | Deno + `npm:@supabase/supabase-js@2` (imports `npm:`), 37 funciones + `_shared/` (2.085 líneas de helpers) | `supabase/functions/` |
| Imágenes | Cloudinary (uploads firmados server-side por `cloudinary-sign`) | `assets/js/cloudinary.js` |
| Portales | Mercado Libre (OAuth 2.0, sync cron, webhooks) | `ml-*` functions + tab portales |
| Email | Brevo SMTP (solo `supervision-digest`) | function digest |
| Chat | Zernio (WhatsApp/IG/FB/Web), recepción por webhook HMAC | `zernio-*` functions |
| Tests | Playwright 1.62 (@playwright/test devDep) | `playwright.config.js`, `tests/` |
| Deploy | GitHub Actions + Cloudflare Pages + Supabase CLI | `.github/workflows/deploy.yml`, `scripts/deploy.ps1` |
| Docker | **NO existe** (sin Dockerfile, sin compose) | verificado: ausencia |

**Infra NOT detectada en repo** (verificar en infra real, fase 6): Redis no existe como servicio propio — el "rate limiting" es sliding-window-log en tabla Supabase (`rate_limit_logs`), no Redis. No hay Gunicorn/Render/Python backend: el backend es 100% Supabase Edge Functions. Existe `scripts/deploy.ps1` (deploy local alternativo al CI).

---

## 3. Entrypoints / páginas (5 HTML)

| Archivo | Líneas | Función | Auth |
|---|---|---|---|
| `index.html` | 752 | Landing pública (catálogo, hero, contacto, CMS) | pública (anon RLS) |
| `admin.html` | 2.478 | Panel admin SPA (14 tabs, hash routing) | GoTrue email/password |
| `tasacion.html` | 1.396 | ACM (comparables, mapa Leaflet, Chart.js) — embebible iframe | token por `postMessage` desde admin (valida `event.origin`) |
| `portal-propietario.html` | 703 | Portal propietario | token UUID en URL (`owner_portal_tokens`) |
| `confirmar-visita.html` | 232 | Confirmar/cancelar visita | token UUID en URL (`visits.confirmation_token`) |

---

## 4. Frontend JS (assets/js)

| Archivo | Líneas | Rol |
|---|---|---|
| `config.js` | 7 | `window.BH_CONFIG` (Supabase URL + **anon key pública** — OK por diseño, RLS es la seguridad) |
| `supabase-client.js` | 25 | `window.supabaseClient` (fail-closed: sin config o sin CDN, no expone cliente) |
| `utils.js` | 77 | `window.BHUtils`: `esc`, `escAttr`, `safeUrl`, `safeImageUrl`, `safeCssUrl` (same-origin + http/https/mailto/tel; rechaza javascript:/data:/blob:) |
| `cloudinary.js` | 84 | `window.BH_Cloudinary.uploadImage(s)` (firma vía edge function) |
| `zod.umd.js` | 4.055 | Zod 3 (solo admin) |
| `landing-app.js` | 2.217 | Catálogo dinámico, filtros server-side, CMS (site_content), contacto → leads, WhatsApp |
| `admin-app.js` | 8.768 | SPA admin completo: auth, CRUD, dashboard, CRM, agenda, tasaciones, propietarios, CMS, portales/ML, agentes, chat, ficha HTML, usuarios, configuración, supervisión (+ RPC `get_sidebar_badge_counts`) |

---

## 5. CSS

| Archivo | Líneas | Uso |
|---|---|---|
| `landing.css` | 1.189 | Design system landing (Poppins/Anton, Luxury Dark) |
| `admin.css` | 3.838 | Panel admin + calendario |

---

## 6. Backend — Edge Functions (37 + `_shared`)

### 6.1 Helpers `_shared/` (2.085 líneas totales)

| Archivo | Líneas | Propósito |
|---|---|---|
| `auth.ts` | 42 | `requireAdmin`/`isAdmin`: valida Bearer JWT con `getUser()` + rol en `admin_users` (`super_admin`/`admin`/`staff`, `is_active`) — **fail-closed** (retorna null ante error) |
| `http.ts` | 38 | CORS allowlist con `Vary: Origin` (origins: bienenhaus.com.ar, www, localhost:5173-5175) — restrictivo |
| `cors.ts` | 7 | CORS `*` genérico (usado por cron functions) |
| `rate-limit.ts` | 148 | Sliding window log en `rate_limit_logs`, config por función. **⚠️ FAIL-OPEN ante error DB** (hallazgo P1) |
| `crypto.ts` | 57 | AES-256-GCM para tokens ML (PBKDF2 de `CRYPTO_SECRET`) |
| `audit.ts` | 518 | `auditEvent`, `auditSensitiveAction`, `trackToolUsage`, `auditError`, `getClientIp`, `getUserAgent` |
| `ml.ts` | 750 | Cliente API MercadoLibre (OAuth + items, credenciales encriptadas en DB) |
| `ml.schemas.ts` | 275 | Schemas Zod de respuestas ML (elimina `as unknown as`/`any`) |
| `auto_reply.ts` | 141 | Plantillas auto-reply ML por tipo de pregunta |
| `visits.ts` | 109 | Lógica compartida de visitas (recordatorios, estados) |

### 6.2 Funciones por categoría (37)

**Activas en CI (14)** — `.github/workflows/deploy.yml FUNCTIONS_TO_DEPLOY`:

| Función | Líneas | Verify JWT | Propósito |
|---|---|---|---|
| `cloudinary-sign` | 145 | ON + admin | Firma uploads Cloudinary (allowlist carpetas). **CORS `*` inline** ⚠️ |
| `cron_exclusivity_renewals` | 129 | cron | Renovaciones de exclusividad |
| `manage-users` | 524 | ON + super_admin | invite/create-direct/set-role/update-user/update-self. **CORS `*` inline** ⚠️ |
| `ml-sync` | 980 | cron | Sync ML bidireccional (batch 50) |
| `monthly_commission_liquidation` | 161 | cron | Liquidación mensual comisiones |
| `supervision-api` | 887 | ON | Consultas supervisión (rate limit 60/min) |
| `supervision-digest` | 587 | cron | Resumen diario (Brevo). **CORS `*` inline** ⚠️ |
| `supervision-ml-anomaly` | 460 | ON | Detección anomalías ML/estadística |
| `supervision-notifications` | 222 | ON | Push/email alertas críticas |
| `supervision-notify` | 394 | cron | Dispara notificaciones |
| `trigger_commission_on_close` | 164 | evento DB | Crea comisión al cerrar propiedad |
| `zernio-proxy` | 396 | ON | Proxy inbox Zernio (send/mark_read/accounts). **CORS allowlist** ✅ |
| `zernio-webhook` | 367 | OFF (HMAC) | Webhook receptor Zernio: HMAC + dedup + auditoría. **CORS allowlist** ✅ |
| `zernio-webhook-test` | 344 | OFF | Endpoint test webhook |

**En repo, NO desplegadas por CI (23)** — drift de deploy a resolver en FASE 1:

| Función | Líneas | Función | Líneas |
|---|---|---|---|
| `admin-user-invite` | 153 | `ml-callback` | 113 |
| `audit-log` | 110 | `ml-categories` | 35 |
| `chat-ai` | 309 | `ml-config` | 91 |
| `chat-upload` | 109 | `ml-import-listings` | 595 |
| `contact-submit` | 150 | `ml-listing-types` | 33 |
| `convert-image` | 46 | `ml-metrics` | 261 |
| `ml-answer-question` | 59 | `ml-oauth` | 303 |
| `ml-api` | 238 | `ml-revoke-tokens` | 82 |
| `ml-auth` | 62 | `ml-sync-import` | 449 |
| `ml-bulk-enqueue` | 49 | `ml-webhook` | 464 |
| `process-retention-policies` | 77 | `qr-checkin` | 74 |
| `visits-process-reminders` | 28 | | |

> **Decisión pendiente** (documentar en REMEDIATION_PLAN): el README (2026-08-30) dice que `contact-submit`, `qr-checkin`, `visits-process-reminders`, `admin-user-invite`, `audit-log`, `chat-ai`, `chat-upload`, `convert-image`, `process-retention-policies` fueron **eliminadas de producción** (huérfanas) pero su fuente sigue en repo; y que las 13 `ml-*` siguen desplegadas en prod (endpoints ML). Esto es un **estado de drift** que requiere decisión: re-deployar (si hay consumidores reales) o archivar.

### 6.3 Uso de helpers de seguridad por función (mapeo CORS/auth/rate)

- **CORS restrictivo (allowlist + Vary)**: `zernio-proxy`, `zernio-webhook`, `zernio-webhook-test`, `chat-ai`, `chat-upload`, `convert-image`, `ml-*` (vía `_shared/http.ts`), `supervision-api`, `supervision-ml-anomaly`, `supervision-notifications`, `process-retention-policies`.
- **CORS `*` inline**: `manage-users`, `cloudinary-sign`, `ml-api`, `ml-auth`, `ml-callback`, `ml-config`, `supervision-digest`, `supervision-notify` — ⚠️ revisar FASE 1 (Web-Check detectó `access-control-allow-origin: *`).
- **Sin CORS handler visible**: `cron_exclusivity_renewals`, `monthly_commission_liquidation`, `trigger_commission_on_close` (cron/evento → server-to-server, correcto).
- **Rate limiting**: solo las funciones ML + `supervision-api` usan `_shared/rate-limit.ts`. `manage-users`/`cloudinary-sign`/formularios públicos **no tienen rate limit** ⚠️.
- **Auth shared**: `chat-ai`, `chat-upload`, `ml-*` (auth ML propia), `process-retention-policies`. `manage-users` tiene su propia lógica super_admin (no usa `_shared/auth.ts`).

---

## 7. Base de datos — Migraciones (27 archivos SQL, ~6.100 líneas)

| Migración | Líneas | Contenido |
|---|---|---|
| `20260824000001_audit_system_foundation.sql` | 591 | audit_log, api_key_audit, user_sessions, alertas, reglas |
| `20260824000002_supervision_rules_defaults.sql` | 446 | Reglas de supervisión por defecto |
| `20260824000003_pg_cron_supervision_rules.sql` | 18 | Cron reglas |
| `20260824000004_risk_scoring_system.sql` | 302 | user_risk_scores |
| `20260824000005_audit_integrity_chain.sql` | 256 | Cadena integridad audit |
| `20260824000006_notification_preferences.sql` | 39 | Preferencias notificación |
| `20260824000007_ml_metrics_dashboard.sql` | 219 | ml_model_metrics, ml_predictions_log |
| `20260824000008_supervision_repair.sql` | 591 | Reparaciones supervisión |
| `20260824000009_supervision_alert_assignment.sql` | 89 | Asignación alertas |
| `20260824000010_supervision_notify_integration.sql` | 179 | Notificaciones |
| `20260824000011_purge_policy.sql` | 150 | Retención/purga |
| `20260824000012_supervision_digest.sql` | 115 | Digest diario |
| `20260824000013_supervision_anomaly_detection.sql` | 557 | Baselines + config anomalías |
| `20260824000013_supervision_anomaly_part1.sql` | 121 | ⚠️ **DUPLICADO de número 13** (part1) |
| `20260824000014_supervision_anomaly_part2.sql` | 312 | Anomalías part 2 |
| `20260824000016_api_key_audit_sessions.sql` | 183 | Auditoría API keys + sesiones |
| `20260826_propietarios_100pct.sql` | 174 | Owners, documentos, timeline, portal tokens, comisiones |
| `20260826000001_cms_complete_landing.sql` | 710 | site_content, portal_settings |
| `20260827_chat_broker_access.sql` | 135 | broker_id + triggers + RLS chat |
| `20260827_fix_visits_rls.sql` | 64 | RLS visitas (JOIN agents.profile_id) |
| `20260827_unify_agent_ids.sql` | 184 | Unificación agent_id/assigned_to → agents.id |
| `20260827_zernio_chat_completo.sql` | 144 | Schema Zernio completo |
| `20260828_fix_owners_rls.sql` | 79 | RLS owners |
| `20260830_fix_properties_public_read.sql` | 17 | properties public read (`TO public`) |
| `20260901000001_fix_p0_security_and_functional.sql` | 231 | **Hardening P0** (RLS tasaciones, REVOKEs, vistas security_invoker, leads anon INSERT, portal_settings, 27 FK indexes) |
| `20260901000002_ml_sync_queue_and_rpcs.sql` | 252 | ml_sync_queue/history/dead_letter, RPCs enqueue/claim |
| `20260901000003_cleanup_fks_and_duplicates.sql` | 21 | Drop FKs duplicadas |

**Esquema en prod (por README verificado 2026-08-28)**: 37 tablas en `public` con RLS, ~44 funciones públicas, 8 vistas. Datos reales aprox: 18 properties, 2 agents, 1 owner, 0 leads, 0 visits, 1 tasacion, 4 profiles, 278 audit_log, 1190 rate_limit_logs, 8720 baselines.

**Hallazgo estructural**: el número de migración `20260824000013_*` aparece **3 veces** (detection 557 líneas, part1 121, part2 312) — verificar orden de ejecución y que no haya conflicto en instalación limpia (FASE 1/§27).

---

## 8. Tests (Playwright, read-only)

| Spec | Tests | Verifica |
|---|---|---|
| `tests/landing.spec.js` | 4 | Catálogo renderiza, búsqueda, formulario contacto presente, CSP index |
| `tests/pages.spec.js` | 5 | Smoke 5 páginas (título + elemento + 0 errores consola) |
| `tests/security.spec.js` | 8 (4 dinámicos del loop `PAGES_NONCE`) | CSP por página, 0 handlers inline admin, delegación data-action, sin secretos en config.js |
| `tests/admin.spec.js` | 2 (**gated**: `BH_TEST_ADMIN_EMAIL`/`BH_TEST_ADMIN_PASSWORD`, sin credenciales → skip) | login + dashboard + tabs + persistencia sesión reload |
| **Total** | **19** (15 static + 4 loop; 2 gated) | |

- Config: `playwright.config.js` — baseURL `http://localhost:8788`, server `python -m http.server 8788`, chromium, workers 1, retries 2.
- Helper `tests/helpers/console.js`: `trackConsoleErrors` (pageerror + console.error con allowlist de 406 esperados).

---

## 9. Seguridad — Postura actual verificada

### 9.1 CSP por página (verificado en HTML actual)

| Página | Nonce | unsafe-inline scripts | Origenes externos script-src |
|---|---|---|---|
| `index.html` | ✅ `nonce-bienenhaus2024` | ❌ | jsdelivr, cdnjs, fonts.googleapis, *.supabase.co, r.ldngts.com |
| `admin.html` | ❌ | ✅ `'unsafe-inline'` | + static.cloudflareinsights |
| `tasacion.html` | ✅ | ❌ | + unpkg, chart.js, supabase-js |
| `portal-propietario.html` | ✅ | ❌ | igual index + CF insights |
| `confirmar-visita.html` | ✅ | ❌ | igual index + CF insights |

- `style-src` incluye `'unsafe-inline'` en **todas** (estilos inline) — evaluar en FASE 1 si es evitable.
- Evaluado nota: admin.html `script-src 'unsafe-inline'` sin nonce — documentado como intencional (handlers dinámicos de admin-app.js), tests lo fijan así.

### 9.2 Security Headers (del informe Web-Check externo, a verificar en infra)

**Ausentes en respuesta HTTP**: CSP*, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP, CORP, COEP. CSP existe como `<meta>` pero Web-Check no lo cuenta como header. `access-control-allow-origin: *` detectado (coincide con CORS inline hallado). *PENDING_EXTERNAL_VALIDATION*.

### 9.3 Rate limiting — ⚠️ FAIL-OPEN

`_shared/rate-limit.ts`: `if (error) { return { allowed: true ... } }` — ante error de DB, **todo permitido**. Contradice el requisito §15 (fail-safe). **P1 confirmado en código.** Además solo cubre funciones ML + supervision-api.

### 9.4 Secretos

- Scan de repo (ts/js/sql/html/yml/md/ps1, excluyendo node_modules/.git/artefactos): **no se encontraron secretos reales**. Solo:
  - `SERVICE_ROLE_KEY` / `service_role` como **nombres de env var** en edge functions (esperado).
  - `sk_live_abc123...` en `CONECTAR_ZERNIO_CHAT.md` como **formato de ejemplo** (no es un secreto real).
  - Anon key de Supabase en `config.js` (pública por diseño).
- Git history: 131 commits — pendiente scan completo de history (FASE 1 §16). Supabase `.temp/` fue `git rm --cached` (README), pero sigue en disco.

### 9.5 Auth/RBAC (README + código)

- `profiles.role`: `super_admin` / `admin` / `broker` / `viewer` (+ `staff` en `admin_users` para edge functions).
- Trigger `guard_profiles_self_update` impide auto-elevación.
- Policies RLS resuelven responsable con `JOIN agents.profile_id = auth.uid()`.
- Edge Functions: `verify_jwt` según función; `manage-users` = super_admin; `_shared/auth.ts` fail-closed.
- **Hallazgo potencial**: `admin_users` vs `profiles` — dos fuentes de verdad de rol (verificar en FASE 1).

---

## 10. Integraciones externas

| Integración | Evidencia en repo | Estado según README |
|---|---|---|
| Cloudinary | `cloudinary-sign` + `cloudinary.js` | Uploads firmados, folder allowlist |
| MercadoLibre | 13 funciones `ml-*` + `_shared/ml.ts` + admin `mlPublish*` etc. | OAuth + sync + webhooks + dead-letter; **13 funciones no desplegadas por CI** (drift) |
| ZonaProp/Argenprop | solo tab portales (config), **sin adapter en repo** | Sin evidencia de implementación |
| Zernio | `zernio-*` (3) + tab chat | Recepción validada prod (HMAC+dedup); **envío sin API key real** |
| Brevo | `supervision-digest` | Resumen diario |
| WhatsApp | enlaces desde `site_content.contact.whatsapp` (frontend) | — |
| Sentry | **no encontrado** | Sin integración de errores |

---

## 11. CI/CD

| Ítem | Estado |
|---|---|
| Workflow único | `.github/workflows/deploy.yml` — jobs: `lint-and-test`, `auto-version` (bump cache busters + push), `deploy-cloudflare`, `deploy-supabase` (14 fns), `notify` |
| Gate real | `node --check` 6 JS + `npm test` (Playwright chromium) + `html-validate` best-effort (`|| true`) |
| Secrets usados | `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` |
| Fixes recientes aplicados | path deploy Supabase (`cd` removido), `git pull --rebase` en auto-version, `$SUPABASE_PROJECT_REF` env var |
| ⚠️ Pendiente | **Cloudflare deploy falla 401** (token en cuenta equivocada) — documentado en `CLOUDFLARE_SETUP.md`, requiere acción del dueño |
| Deploy local alternativo | `scripts/deploy.ps1` (lint + bump + git commit + supabase deploy de **TODAS** las funciones con `--no-verify-jwt` + aviso wrangler). ⚠️ **diffiere del CI**: despliega todo sin allowlist y commitea sin pull-rebase |

---

## 12. Archivos raíz y documentación

| Archivo | Rol |
|---|---|
| `README.md` | Documentación completa (33 secciones) — **fecha 2026-08-30, contiene deudas conocidas** (admin-app.js sin commitear — YA commitado en commits recientes; `main ahead 1` — ya resuelto; `.temp` trackeado — ya `git rm --cached`): **varias secciones quedaron obsoletas** |
| `AUDITORIA_MODULOS.md` | Auditoría previa módulo a módulo |
| `CLOUDFLARE_SETUP.md` | Guía configuración cuenta Cloudflare correcta |
| `CONECTAR_ZERNIO_CHAT.md` | Guía activación chat Zernio |
| `robots.txt`, `sitemap.xml`, `CNAME`, `favicon.ico`, `.nojekyll` | SEO/DNS |
| `deno-stubs.d.ts` | ⚠️ **untracked** (stub temporal para `tsc --noEmit`, no commitear) |
| `.gitignore` | node_modules, .playwright-mcp, test-results, etc. |

---

## 13. Artefactos de tooling en disco (no versionar)

- `.playwright-mcp/` — ~250 archivos de logs/snapshots/conversaciones de sesiones Playwright previas (ruido, gitignore).
- `test-results/` — artefactos de tests (traces, network). En carpeta `tests/` el helper está en `tests/helpers/console.js`.
- `.omo/`, `.codegraph/`, `supabase/.temp/` — tooling local.

---

## 14. Deuda técnica / hallazgos preliminares (detallar en FASE 1)

| # | Hallazgo | Clase | Evidencia |
|---|---|---|---|
| I-01 | **Rate limiter fail-open** (error DB → allow) | P1 | `_shared/rate-limit.ts` línea `if (error) return { allowed: true }` |
| I-02 | CORS `*` en `manage-users`, `cloudinary-sign`, `ml-api`, `ml-auth`, `ml-callback`, `ml-config`, `supervision-digest`, `supervision-notify` | P1 | código inline |
| I-03 | Sin rate limit en login público (`manage-users`), formularios públicas | P1 | mapeo §6.3 |
| I-04 | Drift deploy: 23 funciones en repo no desplegadas por CI; 13 `ml-*` desplegadas en prod sin CI | P1 | deploy.yml vs disco |
| I-05 | `admin_users` vs `profiles.role` — doble fuente de rol | P1 | código auth.ts + README |
| I-06 | Migraciones `20260824000013_*` duplicadas (3 archivos, mismo prefijo) | P2 | listado §7 |
| I-07 | `scripts/deploy.ps1` diverge del CI (deploy all + `--no-verify-jwt` global + commit sin rebase) | P2 | §11 |
| I-08 | Security headers ausentes en HTTP (según Web-Check; CSP solo meta) | P1 | reporte externo + §9.2 |
| I-09 | Zernio envío sin API key; MIL 13 fns huérfanas sin decisión | P2 | README |
| I-10 | README con secciones obsoletas (deudas ya resueltas) | P3 | diffs recientes |
| I-11 | `deno-stubs.d.ts` untracked en raíz | P3 | git status |
| I-12 | Indexes FK faltantes (12 cols) y `zernio_webhook_events` sin policies RLS (auditoría previa) | P2 | AUDITORIA_MODULOS.md + checks previos |
| I-13 | `rate_limit_logs` crece sin purga (1190 filas, comentario de purge desactivado) | P3 | rate-limit.ts |

---

## 15. Mapa de arquitectura (resumen visual)

```
[ Cloudflare Pages ]  ←---  bienenhaus.com.ar (5 HTML + assets estáticos, CSP meta)
        ↓ anon key (RLS)
[ Supabase PostgreSQL ] ←--- 37 tablas + RLS + triggers + pg_cron + 44 funciones + 8 vistas
        ↑ service_role (solo Edge Functions)
[ Edge Functions Deno ]  ←--- 37 fns + _shared/ (auth, http, cors, crypto, audit, rate-limit, ml, visits)
        ↓↓↓
   Cloudinary | MercadoLibre | Zernio | Brevo
```

---

## 16. Verificación de claims del README (contradicciones encontradas)

| Claim README | Verificación real | Veredicto |
|---|---|---|
| "19 tests en 4 specs" | 4 specs confirmadas; 19 tests (15 + 4 loop) | ✅ |
| "admin-app.js modificado sin commitear" | repo limpio | ❌ obsoleto (ya commiteado) |
| "main ahead 1 de origin" | branch sincronizada | ❌ obsoleto |
| "supabase/.temp git rm --cached DONE" | en disco, no trackeado | ✅ |
| "9 edge functions huérfanas eliminadas de prod" | fuente en repo, sin CI | ⚠️ drift pendiente decisión |
| "Cloudinary suite OK" | CORS `*` en cloudinary-sign | ⚠️ revisar |
| "rate limiting" (README §Seguridad) | fail-open + cobertura parcial | ⚠️ NO tan robusto como sugiere |

---

## Estado de la FASE 0

**COMPLETA** — inventario verificado contra código real, sin modificaciones. Siguiente: **FASE 1 — Auditoría profunda** (`AUDIT_FINDINGS.md`) profundizando cada hallazgo (I-01…I-13) + todo el checklist del brief (§4–§40), con verificación de endpoints, XSS sink-by-sink, matemática ACM, integraciones y sanidad de migraciones.