# 🔍 Auditoría completa del proyecto — 2026-10-15

> **Alcance:** revisión integral read-only del repositorio + verificación directa contra producción (Postgres, Edge Functions, advisors, crons, publicación realtime). No se modificó código ni datos.
> **Resultado global: 79 / 100** — sistema production-grade sólido, con seguridad por encima del estándar de su categoría, frenado por deuda de testing de escrituras, hardening incompleto en funciones nuevas y algunos ítems operativos pendientes.

---

## Metodología

| Fuente | Qué se verificó |
|---|---|
| Repositorio (723 commits, 298 archivos versionados) | Los 24 JS propios (~22.8k líneas), 48 Edge Functions (~11k líneas TS), 98 migraciones, 2 workflows CI, 11 specs E2E, 17 docs |
| Producción vía MCP | 63 tablas y su RLS, 117 policies, 49 Edge Functions desplegadas (slugs + verify_jwt), 17 crons activos, 16 tablas en `supabase_realtime` |
| Advisors de Supabase | Security + performance (hallazgos crudos listados abajo) |
| Byte-scan de encoding | 272 archivos de texto versionados escaneados buscando U+FFFD / doble-encoding |
| Última corrida CI | lint + E2E: 62 passed, 3 skipped (requieren credenciales admin) |

---

## Puntuación por dimensión

| # | Dimensión | Peso | Nota | Ponderado |
|---|---|---|---|---|
| 1 | Arquitectura y estructura | 15 % | 8.5 | 1.275 |
| 2 | Calidad de código | 15 % | 8.0 | 1.200 |
| 3 | Seguridad | 20 % | 8.0 | 1.600 |
| 4 | Performance | 10 % | 7.0 | 0.700 |
| 5 | Testing / QA | 10 % | 7.0 | 0.700 |
| 6 | CI/CD y deploy | 10 % | 8.0 | 0.800 |
| 7 | Documentación | 10 % | 8.0 | 0.800 |
| 8 | Integridad de datos / operación | 10 % | 8.0 | 0.800 |
| | **TOTAL** | | | **7.875 → 79/100** |

### 1. Arquitectura — 8.5/10

**Fortalezas**
- Modularización reciente y bien pensada: `admin-app.js` (core ~3.5k líneas) publica `window.adminApp`/`window.__BH` **antes** de que los 14 módulos de dominio se carguen; contrato documentado en el propio código.
- 48 Edge Functions con helpers compartidos (`_shared/`: auth, cors, crypto, ml, rate-limit, audit).
- 98 migraciones versionadas; 17 ADRs en el README con el porqué de cada decisión.
- Contrato de helpers claro (`mutate()`, `setupCoreRealtime`, delegación `data-action` con whitelist).

**Debilidades**
- `admin.html`: ~181 KB con los 20 modales inline.
- `admin-crm.js` (2.4k) y `pages/portal-propietario-page.js` (2.4k) son los módulos más grandes.

### 2. Calidad de código — 8/10

**Fortalezas**
- **1 solo TODO real** en ~22.8k líneas propias; 4 `console.log`; 0 `eval`; flags `DEBUG=false` en producción.
- Comentarios que documentan el PORQUÉ con fecha de incidente real (p. ej. `utils.js`, `ml-webhook/index.ts` sobre firma de notificaciones ML).
- `utils.js` es ejemplar: deny-by-default en protocolos, `sanitizeRichText` con allowlist de 3 formas exactas, export CommonJS para tests.

**Debilidades**
- Sin typecheck/linter real en frontend (`node --check` solo valida sintaxis).
- Mojibake cosmético: `admin.css` (57 chars, todos en comentarios) y `AGENTS.md` (1).
- Contadas concatenaciones `innerHTML` sin `esc()` con datos de DB autenticada (p. ej. `admin-crm.js:974` con `full_name` de agente) — riesgo bajo, pero desvían de la regla "SIEMPRE esc()".

### 3. Seguridad — 8/10

**Fortalezas (verificadas en producción)**
- **RLS 63/63 tablas (100 % de cobertura)**, 117 policies.
- CSP estricta en las 5 páginas públicas (sin `unsafe-inline` ni nonce), **testeada por regresión** (`tests/security.spec.js`), admin con `'unsafe-inline'` documentado como trade-off.
- Tokens ML cifrados AES-256-GCM; HMAC timing-safe; rate limiting; audit log con cadena de integridad; HIBP en el alta (fail-open documentado).
- Webhook ML: binding + re-fetch como barrera real (documentado que ML no firma tópicos), parseo tolerante + dead-letter visible.

**Hallazgos**
- 🔶 **P1 — 11 funciones internas `SECURITY DEFINER` ejecutables por `anon`** (creadas después del hardening 2026-09-28): `backup_build_snapshot`, `compute_lead_score`, `crm_flag_overdue_visits`, `crm_flag_stale_leads`, `crm_queue_followup_alerts`, `leads_followup_on_contact`, `leads_recalc_followup_on_task`, `purge_rate_limit_logs`, `revoke_owner_tokens_on_delete`, `survey_pending_reminders`, `zernio_increment_unread`. Ninguna devuelve datos sensibles, pero cualquiera puede dispararlas vía RPC (la peor: `backup_build_snapshot` = vector de DoS en free tier). Fix: REVOKE a anon/authenticated + GRANT a `service_role`, verificando con `has_function_privilege` la lista completa — con cuidado de no repetir el incidente 2026-09-28 (revocar EXECUTE de funciones usadas por triggers rompió el alta de propiedades).
- 🟡 `tmp-gen-jwt` y `cta-test` siguen desplegadas como stubs 410 (neutralizadas, borrado manual pendiente).
- 🟡 Leaked Password Protection del dashboard aún sin activar (mitigado por HIBP check).
- 🟡 Botón "Imprimir cartel" de `qr-visita.html:36` bloqueado por su propia CSP (`onclick` inline sin `unsafe-inline`) — bug funcional, no vulnerabilidad.
- ℹ️ Advisors INFO intencionales: 4 tablas RLS sin policies (`*_webhook_events`, `rela_tokens`, `ml_oauth_states` — solo service_role); `pg_net`/`pg_trgm` en `public`.

### 4. Performance — 7/10

**Fortalezas**
- Cloudinary `f_auto,q_auto`; compresión client-side en tasaciones; virtual scroller; paginación server-side; realtime con debounce 500 ms.

**Debilidades**
- **83 policies RLS con `auth.uid()` directo** (advisor `auth_rls_initplan`): re-evaluación por fila. Hoy imperceptible (volumen chico); es EL asunto a atacar si el equipo crece.
- KPIs del digest con fetch sin paginación (cap 1000 de PostgREST) → `actionsTotal: 1000`, `uniqueUsers: 0`.
- Realtime full-refresh por cambio (documentado como trade-off).
- 48 índices sin uso / 25 FKs sin índice (advisor INFO).

### 5. Testing / QA — 7/10

**Fortalezas**
- 65 tests E2E en 11 specs, corriendo en CI con retries; **guards de regresión de seguridad** (CSP, delegación, sin secretos) — una práctica que casi ningún proyecto de este tamaño tiene.
- Read-only contra producción: la suite no puede romper datos reales.

**Debilidades**
- La suite es read-only → **los flujos de escritura no tienen cobertura** (CRUD, estados de modales, realtime). Los últimos 3 bugs (z-index del confirm, shorthand `expires_at`, realtime CRM) estaban todos en esa zona ciega y se detectaron a mano.
- `npm run test:unit` existe pero no corre en CI.

### 6. CI/CD y deploy — 8/10

**Fortalezas**
- Pipeline completo: lint + E2E + deploy per-function con mapa `verify_jwt` explícito + auto-bump de cache busters + notificación.
- `ficha-generate.yml` separado con guards serios (anti-wipe, reconciliación de huérfanas, `[skip ci-pages]`).
- Todo el backend deploya desde el repo (drift cero salvo 2 stubs debug documentados).

**Debilidades**
- El job `auto-version` bumpea una lista fija de assets a mano (frágil al agregar assets) y genera conflictos de rebase frecuentes (necesitó script de resolución encoding-safe).
- Deploy de Edge Functions en cada push (hotfix manual via MCP como excepción documentada).

### 7. Documentación — 8/10 (antes de esta actualización)

**Fortalezas**
- README de 1162 líneas con diagramas mermaid, ER, ADRs, flujos end-to-end, changelog.
- `AGENTS.md` con gotchas operativos reales (práctica rara y valiosa: encoding, ML, crons con URL hardcodeada, scope de helpers).
- `docs/` completo: runbook de backups, integraciones, guías de uso, auditorías históricas.

**Debilidades (corregidas en esta misma actualización)**
- Bits desactualizados: "67 tablas" (real: 63), "121 policies" (real: 117), "59 tests" (real: 62+3), "93 migraciones" (real: 98), "admin-app.js ~14k líneas" (hoy 3.5k + 14 módulos), "digest diario" (hoy semanal), tabla de funciones sin stubs 410, **link roto a `XSS_REVIEW.md`** (archivo inexistente), tabla de páginas sin `qr-visita.html`/legales, deudas viejas (Brevo ya resuelto), faltaba el estado real del deploy (49 funciones, mapa verify_jwt).
- `AGENTS.md` decía "37 tablas" (muy viejo) → corregido a 63.

### 8. Integridad de datos / operación — 8/10

**Fortalezas**
- Backup diario automático **verificado activo** (cron `backup-snapshot-daily` 07:00 UTC) + retención 30 días + runbook `pg_dump` en `docs/BACKUPS.md`.
- 17 crons activos verificados; soft deletes; idempotencia en webhooks (dedup + claims atómicos + `FOR UPDATE`).
- Disciplina de producción documentada y respetada (no DELETE/TRUNCATE sin backup/approbación).

**Debilidades**
- 🔶 **P1 — drift DB↔repo**: la publicación realtime de `lead_properties`/`lead_tasks`/`lead_activities`/`owner_tasks` se aplicó directo vía MCP **sin migración versionada** (el commit `7ecc2aa` dice "(migration)" pero solo tocó `admin-app.js`). Un rebuild desde cero quedaría incompleto.
- Free tier sin backups gestionados (mitigado con lo propio).
- Limpiezas manuales pendientes: bucket `fichas` (29 stale), funciones debug del dashboard, publicaciones huérfanas ML.

---

## Roadmap recomendado (por prioridad)

1. **P1** — Migración de privilegios: REVOKE EXECUTE a anon/authenticated en las 11 funciones internas + GRANT a `service_role` (verificar con `has_function_privilege` lista completa × los 3 roles, respetando cadenas de trigger).
2. **P1** — Crear la migración faltante de la publicación realtime (4 tablas).
3. **P2** — Fix de KPIs del digest (paginación/count exacto en `fetchDigestData`).
4. **P2** — Borrado manual: `tmp-gen-jwt`, `cta-test`, bucket `fichas`.
5. **P2** — Botón print de `qr-visita.html` → data-* + listener.
6. **P3** — RLS initplan optimization en policies calientes.
7. **P3** — Mojibake cosmético (admin.css) con script node.
8. **Estratégico** — Cobertura de flujos de escritura: un Playwright con credenciales de staging (o el set de admin ya existente) que ejecute altas/ediciones de punta a punta.

---

## Números del sistema (2026-10-15)

| Métrica | Valor |
|---|---|
| Commits | 723 |
| Archivos versionados | 298 |
| JS propio (sin vendor) | ~22.8k líneas (root + pages) |
| Edge Functions | 48 en repo / 49 desplegadas (2 stubs debug solo-dashboard) |
| Migraciones | 98 |
| Tablas / RLS / Policies | 63 / 63 (100 %) / 117 |
| Crons activos | 17 |
| Tablas en realtime | 16 |
| Tests E2E | 65 (62 activos + 3 con credenciales) |
| Páginas públicas | 11 HTML + fichas generadas |
