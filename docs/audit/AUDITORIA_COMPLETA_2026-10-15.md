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
- ✅ **P1 — RESUELTO mismo día (2026-10-15, migración `20261015000001_hardening_anon_execute_p1`)**: 12 funciones internas `SECURITY DEFINER` eran ejecutables por `anon` (la investigación final encontró una 12ª, `notify_new_lead`, que no estaba en las 11 originales). La clasificación por invocador real (triggers/cron/edge functions) reveló que **2 de ellas NO se pueden revocar**: `compute_lead_score()` y `notify_new_lead()` son triggers sobre `leads`, tabla **anon-writable** (el formulario de contacto del landing inserta con rol anon) — sin EXECUTE para anon se rompería el alta pública de leads. Las otras 10 quedaron restringidas: triggers de tablas authenticated-only conservan `authenticated` (lección del incidente 2026-09-28); crons y RPC de edge functions quedaron solo `service_role` + `postgres`. Verificado con `has_function_privilege` de la lista completa × 4 roles; advisor `anon_security_definer_function_executable`: **25 → 15** (los 15 restantes = 13 RPC públicas por token + las 2 excepciones justificadas y documentadas).
- ✅ **P1 — RESUELTO (2026-10-15, migración `20261015000002_realtime_publication_crm`)**: la publicación realtime de `lead_properties`/`lead_tasks`/`lead_activities`/`owner_tasks` quedó versionada con un DO block idempotente (no-op en producción, agrega las tablas en un rebuild).
- 🟡 `tmp-gen-jwt` y `cta-test` siguen desplegadas como stubs 410 (neutralizadas, borrado manual pendiente).
- 🟡 Leaked Password Protection del dashboard aún sin activar (mitigado por HIBP check; el advisor `auth_leaked_password_protection` lo sigue marcando).
- 🟡 Botón "Imprimir cartel" de `qr-visita.html:36` bloqueado por su propia CSP (`onclick` inline sin `unsafe-inline`) — bug funcional, no vulnerabilidad.
- ℹ️ Advisors INFO intencionales: 4 tablas RLS sin policies (`*_webhook_events`, `rela_tokens`, `ml_oauth_states` — solo service_role); `pg_net`/`pg_trgm` en `public`.
- ℹ️ Advisor `authenticated_security_definer_function_executable` (31): esperado — incluye las RPC públicas, los triggers de cadenas autenticadas y las excepciones documentadas; NO revocar en masa (lección 2026-09-28).

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
- ✅ **P1 — drift DB↔repo RESUELTO (2026-10-15)**: la publicación realtime de `lead_properties`/`lead_tasks`/`lead_activities`/`owner_tasks` (aplicada directo vía MCP el 2026-10-14) quedó versionada en `20261015000002_realtime_publication_crm.sql` con DO block idempotente.
- Free tier sin backups gestionados (mitigado con lo propio).
- Limpiezas manuales pendientes: bucket `fichas` (29 stale), funciones debug del dashboard, publicaciones huérfanas ML.

---

## Roadmap recomendado (por prioridad)

1. ~~**P1** — Migración de privilegios: REVOKE EXECUTE a anon/authenticated en las 11 funciones internas~~ → **RESUELTO 2026-10-15** (migración `20261015000001`; con la excepción documentada de `compute_lead_score`/`notify_new_lead` por el INSERT anónimo del landing, y una 12ª función, `notify_new_lead`, descubierta en la investigación). Advisor 25 → 15.
2. ~~**P1** — Crear la migración faltante de la publicación realtime (4 tablas)~~ → **RESUELTO 2026-10-15** (migración `20261015000002`, idempotente).
3. ~~**P2** — Fix de KPIs del digest~~ → **RESUELTO 2026-10-15** (migración `20261015000003_supervision_digest_stats` + rewrite de `fetchDigestData`). Eran **3 bugs**: cap de 1000 filas de PostgREST (17.842 acciones reales vs 1.000 mostradas), filtro por `severity` — columna que `audit_log` no tiene (usa `status`: success|error + `error_code`) → Exitosas/Fallidas siempre 0, y sample oldest-first → uniqueUsers 0. RPC de agregación exacta server-side, verificada en producción (actionsTotal 17.842, uniqueUsers 3, successCount 17.841).
4. **P2** — Borrado manual: `tmp-gen-jwt`, `cta-test`, bucket `fichas`. **Permanece manual**: no existe tool MCP para borrar Edge Functions ni gestionar Storage — lo hace el dueño desde Supabase Studio (stubs neutralizados, sin riesgo).
5. ~~**P2** — Botón print de `qr-visita.html`~~ → **RESUELTO 2026-10-15**: el hallazgo era mayor que el botón — la CSP bloqueaba TODO el script inline (la página del QR quedaba en "Cargando…" sin QR ni título). Migrado a `assets/js/pages/qr-visita-page.js` externo + botón por listener. Verificado en browser.
6. **P3** — RLS initplan optimization en policies calientes.
7. **P3** — Mojibake cosmético (admin.css) con script node.
8. **Estratégico** — Cobertura de flujos de escritura: un Playwright con credenciales de staging (o el set de admin ya existente) que ejecute altas/ediciones de punta a punta.

---

## Números del sistema (actualizado 2026-10-16)

| Métrica | Valor |
|---|---|
| Commits | ~780 |
| Archivos versionados | ~300 |
| JS propio (sin vendor) | ~24k líneas (root + pages) |
| Edge Functions | 48 en repo / 49 desplegadas (2 stubs debug solo-dashboard) |
| Migraciones | 105 |
| Tablas / RLS / Policies | 66 / 66 (100 %) / ~120 |
| Crons activos | 17 |
| Tablas en realtime | 16 |
| Tests E2E | 65 (62 activos + 3 con credenciales) |
| Páginas públicas | 11 HTML + fichas generadas |

---

## Adenda de cierre (2026-10-16): 8 de 12 mejoras de negocio implementadas

Las 8 mejoras CRÍTICO + ALTO + MEDIO de la auditoría de negocio se implementaron en una sola sesión de trabajo (2026-10-16):

| # | Mejora | Qué resolvió | Cómo se implementó |
|---|---|---|---|
| 1 | **Motor de match lead↔propiedad** | El agente tenía que buscar manualmente entre 45 propiedades | Al abrir un lead → pestaña Propiedades: sugerencias automáticas con score (zona 30 + presupuesto 30 + tipo 20 + ambientes 20), botón vincular |
| 2 | **Deal room (ofertas/negociación)** | Las etapas visita→negociación→cierre existían pero nadie las usaba | Tabla `lead_offers`, botón 🤖 en cada propiedad vinculada, historial con aceptar (→GANADO) y rechazar |
| 3 | **Razón de pérdida obligatoria** | 36 leads perdidos sin UN registro de por qué | Modal premium con 6 opciones (presupuesto, ubicación, encontró otra, no responde, financiamiento, otro) + widget dashboard |
| 4 | **Alerta de estancamiento** | 28 de 29 propiedades sin visitas en 60+ días, nadie lo veía | Widget dashboard: 30d para nunca visitadas, 60d para sin visitas recientes, badges color-codificados |
| 6 | **Funnel de conversión** | El dueño no podía ver dónde se caían los leads | Sección full-width: embudo 7 etapas, Lead→Visita %, conversión por fuente, rendimiento por agente |
| 9 | **Campaña WhatsApp masiva** | El agente compartía propiedades una por una | Botón 📢 en propiedades: matching reverso propiedad→leads, wa.me personalizados, registro en historial |
| 10 | **Alertas de exclusividad** | Las exclusividades por vencer estaban en filtros, no en la cara del usuario | Sección en recomendaciones con countdown color-codificado por propietario |
| 11 | **Historial de precios** | Sin registro de cuándo bajó el precio y desde cuánto | Tabla `property_price_history` + trigger automático, badge "↓N%" en propiedades estancadas |

### El antes y el después

**Antes (2026-10-15)**:
```
70 leads → 0 con visita → 0 en negociación → 0 ganados
0 calientes · 36 perdidos sin motivo · 28 propiedades sin visitas · 0 comisiones
```

**Después (2026-10-16)**:
- El agente abre un lead → ve propiedades sugeridas con score → vincula → oferta → acepta → GANADO
- Al marcar perdido → DEBE elegir la razón → el dueño ve las causas agrupadas en el dashboard
- 28 propiedades estancadas visibles con badges → el dueño sabe cuáles necesitan acción
- Funnel completo visible → el dueño ve la conversión por fuente y agente
- Campaña WhatsApp: una propiedad a todos los leads que encajan en segundos

**Pendiente**: Item 12 (Mobile/PWA) — queda como proyecto dedicado para una futura sesión.

---

## Adenda de la ejecución del fix P2 (2026-10-15, mismo día)

La **verificación end-to-end del fix de KPIs** (disparar el digest una vez) destapó un hallazgo mayor que el P2 mismo: **3 crons de entrega estaban rotos por el patrón `current_setting('app.settings.*')` → NULL** (el mismo bug del incidente 2026-10-08, extendido):

| Cron | Estado verificado | Impacto real |
|---|---|---|
| `supervision-digest-weekly` | 401 silencioso en cada corrida (Authorization armado con `current_setting('app.settings.service_role_key')` → NULL) | **El digest nunca llegó por cron** — el envío exitoso del 2026-10-12 fue manual. El cron "succeed" porque el SQL solo encola el HTTP request |
| `owner-tasks-reminder` | **3.999 corridas `failed` consecutivas** (URL armada con `current_setting('app.settings.supabase_url')` → NULL → "null value in column url") | Nunca envió recordatorios de tareas desde ~septiembre |
| `monthly-commission-liquidation` | No-op silencioso (guard `WHERE EXISTS (vault 'service_role_key')` con un secret que nunca existió) | **Las liquidaciones de septiembre nunca se generaron** — el owner debe decidir la corrida manual (funciona con `period_start`/`period_end`/`force_regenerate` + `x-sync-secret`) |

**Fix aplicado** (migración `20261015000004`): las 3 funciones validan `x-sync-secret` contra `zernio_config(key='sync_secret')` (patrón ya probado de backup-snapshot/zernio-sync) y los crons leen el secret de la tabla en runtime (corren como owner: RLS no aplica). Verificado end-to-end: **digest 401 sin secret / 200 con secret + email real con KPIs correctos** (17.996 acciones, 3 usuarios, 17.995 exitosas); **owner-tasks-reminder 200** (9 tareas evaluadas, dedup nativo por `reminder_sent_at`); monthly-commission NO se disparó manualmente (crea registros financieros).

> Leva para el score: este hallazgo refuerza lo dicho en **Testing/QA** — los crons "verdes" en `cron.job` no prueban que la entrega funcione; solo un disparo real con respuesta HTTP revela el 401/no-op. El monitoreo de las respuestas de `net._http_response` sería el próximo paso natural.
