# Integración Open RELA Argentina (ZonaProp — Grupo QuintoAndar)

> Fuente oficial: https://open-classifieds.notion.site/arg/rela/
> Credenciales: se solicitan a **integracion@ar.quintoandar.com**.

## Hallazgos verificados en sandbox (2026-08-31)

- **Las credenciales "User/Password" que entrega QuintoAndar son el client_id/client_secret** de la API (`bienenhaus` / `…`). El login devuelve token con `expires_in` ≈ 10 años.
- **Los endpoints bajo `/v1/inmobiliarias/{codigo}/…` rechazan el header `Authorization: Bearer`** (`invalid_token`) y **requieren el query param `?access_token=`** (como en la doc vieja). El cliente envía ambos.
- Inmobiliaria de sandbox: `codigoInmobiliaria = 30662083` ("Bienenhaus Propiedades").
- **La inmobiliaria de sandbox no tiene créditos** (`disponibilidad` devuelve `{"disponibles":[]}`) → todo PUT de aviso responde `ERR-0501 "La empresa no tiene productos disponibles"` y queda OFFLINE. Pedir a soporte que asigne créditos de prueba.
- Catálogos AR reales: `CFT1` ambientes, `CFT2` dormitorios, `CFT3` baños, `CFT4` medio baño/toilette, `CFT5` antigüedad, `CFT6` expensas, `CFT7` cochera, `CFT100` superficie total, `CFT101` superficie cubierta. Tipos: casa=1, departamento=2, oficina=4, local=5, galpón=8, quinta vacacional=11, terreno=26.
- Con esos valores cargados, un PUT de aviso de prueba se procesó correctamente (warnings solamente).
- IDs de barrio (`V1-D-…`) también son aceptados como `idUbicacion` (verificado con Obrero).
- Callback → CRM verificado end-to-end: evento `CONTACTO_MENSAJE` con auth correcta crea `lead`
  (source `rela_zonaprop`, stage `nuevo`, vinculado a `properties.property_code` vía `referencia`);
  el replay del mismo `idEvento` responde `deduplicated:true` sin duplicar el lead.
- **Bugs pre-existentes encontrados y corregidos durante estas pruebas** (migraciones
  `20260902000004` y `20260902000005`): `audit_trigger_fn` rompía TODO insert en tablas
  auditadas (leads incluidos) por cast `name→text`, y `audit_log_integrity_fn` rompía todo
  insert en `audit_log` por `search_path=''` sin tablas calificadas.
- ~~Único bloqueo pendiente: el sandbox no tiene créditos (`ERR-0501`), pedido por email a QuintoAndar.~~ **RESUELTO 2026-11-19**: `GET /disponibilidad` devuelve 200 con `SIMPLE:11` + `DESTACADO:2` = 13 créditos (ver "Estado 2026-11-19" más abajo).
- Pruebas con usuario real (JWT de panel): `status`, `dry_run` sobre propiedad real, `publish`
  end-to-end (la API creó el aviso, lo procesó y devolvió `ERR-0501`; BH persistió listing
  con `status=ERROR`, `id_aviso_navplat` y warnings), `reconcile` (devolvió estado remoto
  `PROCESADO` — estado adicional no documentado; la UI lo muestra tal cual), `stock` y
  `catalogs_sync` (5 catálogos cacheados). RBAC verificado: rol `broker` recibe 403 al
  publicar; sólo `super_admin` escribe.
- Nota de estado remoto: RELA puede responder `estado: "PROCESADO"` al consultar un aviso
  creado pero sin créditos; se persiste crudo en `remote_status`.
- Planes existentes: `SIMPLE`, `HOME`, `DESTACADO`, `GRATIS`, `EXCLUSIVE`, `EXCLUSIVE_II`, `ALQUILER_SIMPLE` y variantes `DESARROLLOS_*`. Operaciones: `VENTA`, `ALQUILER`, `ALQUILER_TEMPORAL`. Monedas: `USD`, `ARS`.

## Estado 2026-11-22 — API caída, monitor propio y salida a producción preparada

- **API sandbox: HTTP 521 otra vez** (verificado con `net.http_get` a `/` y en
  `rela_config.last_error` a las 10:10 UTC). El host de **producción**
  (`https://api-zp-open.navent.com`) sí responde 200 en `/`, pero el token de
  sandbox da `invalid_token` ahí: los tokens son por ambiente. Token local
  vigente hasta 2036 → descartado como causa.
- **No se puede "levantar" la API desde BH**: el 521 es infraestructura de
  Navent/Cloudflare. La palanca es el ticket **SP-61526** (13 días sin respuesta
  del 9/11), ahora con un correo de seguimiento listo en
  [`RELA-EMAIL-QUINTOANDAR.md`](./RELA-EMAIL-QUINTOANDAR.md) que pide: fecha de
  vuelta del sandbox, permiso de callbacks, credenciales de producción y
  confirmación de pack/créditos.
- **✅ Monitor automático**: migración `20261122000001_rela_api_health_alert.sql`
  extendió `bh_check_captacion_health()` con la alarma **`rela_api_down`**. Se
  abre cuando `rela_config.last_error` está presente (el cron fail-soft la
  escribe en cada 521) y **se auto-resuelve** cuando `rela-sync` la limpia tras
  una corrida exitosa. Usa el cron existente `bh-captacion-health-hourly` (`:20`),
  sin nueva edge function ni nuevo cron. Verificado en producción: al invocar la
  función se abrió 1 alerta `high` con el 521 en la descripción; permisos
  anon ✗ / authenticated ✗ / service_role ✓. El **auto-cierre** se verificó con
  un probe en transacción (simuló `last_error=NULL` → `alerts_resolved=1`,
  hace rollback) sin tocar la alerta real, que sigue abierta.
- **Preparado el cambio a producción** (sin ejecutar: faltan credenciales): ver
  checklist abajo. `dry_run` sigue en `true` y `callbacks_enabled` en `false`.

### Checklist: pasar RELA a producción (preparado, NO ejecutado)

Requiere que QuintoAndar envíe `client_id`/`client_secret` de producción y
confirme el pack. Orden estricto:

1. Setear secrets de la edge function (uno por línea, **nunca commitearlos**):

   ```bash
   supabase secrets set \
     RELA_CLIENT_ID=<id_produccion> \
     RELA_CLIENT_SECRET=<secret_produccion> \
     RELA_BASE_URL=https://api-zp-open.navent.com \
     RELA_ROLE=zp --project-ref rnldqiwwzhjnurkguihu
   ```

2. Confirmar el login con esos secrets antes de tocar la config (un 401 acá
   significa que las credenciales no son de producción).
3. Apuntar la config: `update rela_config set base_url='https://api-zp-open.navent.com', role='zp' where id=true;`
   El token cacheado en `rela_tokens` es de sandbox: el cliente RELA re-hace el
   login ante `invalid_token` y lo reemplaza. **No borrar la fila a mano.**
4. Verificar con `rela_portal_status()` y el botón **Stock** del panel (debe
   mostrar créditos de producción, no los 13 del sandbox).
5. Recién entonces, con OK del dueño: correr `preview` de contactos, publicar
   **1 aviso de prueba** y verificarlo en ZonaProp. Sacar `dry_run` después.
6. Si la API de producción tampoco habilita callbacks, el polling `/mensajes`
   sigue siendo la vía de captación (no depende del ambiente).

## Arquitectura

RELA vive como integración desacoplada: no comparte código con Mercado Libre
(`ml-*`) ni Zernio. Capas:

| Capa | Dónde | Responsabilidad |
|---|---|---|
| Mapper puro | `supabase/functions/_shared/rela.mapper.ts` | property BH → payload RELA, validación, hash. Sin I/O: lo usan Deno y los tests de Node |
| Cliente API | `supabase/functions/_shared/rela.ts` | login/token cache, GET/PUT/DELETE con retry y re-login en 401 (versión de referencia; las funciones deployadas llevan la lógica inline porque el deploy MCP no empaqueta `_shared`) |
| Proxy admin | `supabase/functions/rela-proxy/index.ts` | Todas las acciones del panel (verify_jwt ON, escritura restringida a `super_admin`/`admin`) |
| Callbacks | `supabase/functions/rela-callbacks/index.ts` | Webhook RELA → CRM (verify_jwt OFF, auth por header, dedupe por `idEvento`) |
| Sync cron | `supabase/functions/rela-sync/index.ts` | Reconciliación + detección de cambios por hash |
| DB | migración `20260902000003_rela_integration` | `rela_config`, `rela_tokens`, `rela_listings`, `rela_catalog_cache`, `rela_webhook_events` + RPC `rela_portal_status()` |
| UI | `assets/js/admin-app.js` (sección 13C) + `admin.html` | Panel RELA en tab Portales, acciones por propiedad, modal de configuración |

## Ambientes y endpoints (documentados)

| Ambiente | URL base | Parámetro `role` |
|---|---|---|
| Sandbox AR/UY | `https://api-zp-sandbox-open.navent.com` | `zp` |
| Producción AR | pendiente: QuintoAndar la entrega con las credenciales de producción (**REQUIRES_CONFIRMATION**) | `zp` |

Endpoints usados (todos documentados en la sección API de la doc):

| Acción | Endpoint |
|---|---|
| Login (token) | `POST /v1/application/login?grant_type=client_credentials&client_id=…&client_secret=…` |
| Inmobiliarias | `GET /v1/inmobiliarias` |
| Stock/créditos | `GET /v1/inmobiliarias/{codigo}/disponibilidad` |
| Publicar/actualizar | `PUT /v1/inmobiliarias/{codigo}/avisos/{codigoAviso}` (upsert) |
| Consultar aviso | `GET /v1/inmobiliarias/{codigo}/avisos/{codigoAviso}` (la doc 2.5.2 lo tipea como "PUT"; tomado como GET — **REQUIRES_CONFIRMATION**) |
| Baja (offline) | `DELETE /v1/inmobiliarias/{codigo}/avisos/{codigoAviso}` |
| Asociar aviso al CRM | `PUT /v1/inmobiliarias/{codigo}/avisos/{codigoAviso}/asociar/{idAviso}` |
| Ubicaciones | `GET /v1/ubicaciones`, `GET /v1/ubicaciones/{id}` |
| Catálogos | `GET /v1/tipopropiedades`, `/{id}/subtipos`, `/{id}/caracteristicas`, `GET /v1/publicacion/planes`, `GET /v1/operaciones`, `GET /v1/monedas` |
| Config callbacks | `PUT /v1/configuracion/callbacks`, `GET /v1/configuracion/callbacks` |

**REQUIRES_CONFIRMATION** (presentes en el menú de la doc como capacidades, sin
endpoint explícito en las páginas renderizadas): resumen de avisos online de
clásicos (existe para desarrollos: `GET …/desarrollos/online/resumen`),
suscripción/baja de eventos de callback, calidad de aviso/inmobiliaria por API,
polling de contactos. Hasta confirmarlos, la reconciliación se hace por
`GET aviso` uno a uno y la calidad llega vía callback `AVISO_CALIDAD`.

## Autenticación

- `client_id`/`client_secret` → env vars de Edge Functions (nunca en DB ni frontend).
- El token se cachea en `rela_tokens` (solo service_role) con margen de 5 min
  antes de `expires_in`; ante 401 se re-obtiene una vez y se reintenta la call.
- `rela-callbacks` valida `Authorization: Bearer <RELA_CALLBACK_SECRET>` con
  comparación timing-safe; el mismo valor se registra en RELA vía
  `PUT /v1/configuracion/callbacks`.

## Variables de entorno (secrets de Supabase Edge Functions)

| Variable | Uso |
|---|---|
| `RELA_CLIENT_ID` | client_id de Open RELA |
| `RELA_CLIENT_SECRET` | client_secret de Open RELA |
| `RELA_CALLBACK_SECRET` | token que RELA enviará en los callbacks (lo elegimos nosotros) |
| `RELA_BASE_URL` | override opcional de base URL (por defecto sandbox AR) |
| `RELA_ROLE` | `zp` por defecto |

Cargarlas: `supabase secrets set RELA_CLIENT_ID=… RELA_CLIENT_SECRET=… RELA_CALLBACK_SECRET=… --project-ref rnldqiwwzhjnurkguihu`

## Errores (doc 2.6)

La API devuelve arrays `errors`/`warnings`/`informacion`. Reglas implementadas:

- `errors` no vacío o `error:true` → la publicación falla: listing → `ERROR`,
  mensaje `CODIGO: texto` guardado en `last_error` y mostrado en el panel.
- Warnings se guardan en `last_warnings` (no bloquean).
- Sin créditos: pre-check con `disponibilidad` (evita ERR-0502); si RELA igual
  responde ERR-0502 queda como ERROR sin retry.
- Retries con backoff (1s/3s/9s) solo para red/408/429/5xx. Jamás se reintenta
  400/401(post-refresh)/403/422.

## Validación pre-publicación (errores en español, accionables)

Título (≤80), descripción (≥50), tipo de propiedad mapeado, zona mapeada a
`idUbicacion`, estado venta/alquiler, precio > 0, moneda USD/ARS, superficie,
fotos con URL http(s). Todo esto corre también en **DRY_RUN**.

## DRY-RUN

`rela_config.dry_run = true` (default) → las acciones `publish/update/unpublish`
devuelven el payload completo y hash **sin tocar la API**. Se apaga desde
Portales → RELA → Configurar, solo cuando los mapeos estén completos.

## Callbacks → CRM

| Evento | Acción |
|---|---|
| `CONTACTO`, `CONTACTO_MENSAJE` | Inserta lead (`source='rela_zonaprop'`, `stage='nuevo'`, `property_id` resuelto por `referencia` = `codigo_aviso`) |
| `AVISO_ESTADO_PUBLICACION` | Actualiza `remote_status` del listing |
| `AVISO_ACTIVIDAD` | Marca `last_sync_at` (detalle vía reconcile) |
| `AVISO_CALIDAD` | Guarda % y estado en `last_warnings.calidad`; ERROR de calidad → `last_error` |
| `CREDITO` | Persistido (análisis manual) |

Idempotencia: `rela_webhook_events.event_id` UNIQUE → un duplicado responde
200 `{deduplicated:true}` sin re-procesar. RELA reintenta 72 hs solo si
respondemos 4xx/5xx; por eso errores internos de proceso responden 200 y quedan
`processed=false` para revisión.

**Auditoría schema completa (2026-11-08, antes de que llegue el primer evento)**:
comparadas TODAS las columnas de `.from()/insert/update` de
`rela-{callbacks,sync,proxy}` + `_shared/rela.ts` contra
`information_schema.columns` → **0 faltantes** (columnas y tablas). El bug real
que dio la auditoría: la exclusión de stages terminales de la consolidación de
leads usaba labels **inventados** del enum `lead_stage` (`cerrado_vendido`,
`vendido`, `descartado`) → el filtro explotaba con `22P02` en runtime, la query
devolvía vacía y el lead se duplicaba en silencio (mismo bug nacido en ML).
Labels reales: `nuevo, contactado, calificado, visita_agendada,
visita_realizada, negociacion, cerrado_ganado, cerrado_perdido`. Fix en
rela-callbacks + ml-webhook (`757f64f`) + guard `tests/stage-enum-contract.spec.js`.
El informe de los duplicados históricos que dejó el bug en producción:
`docs/leads-duplicados-2026-11-08.md` (solo lectura; fusión = decisión del dueño).

## Despliegue

```powershell
# desde la raíz del repo, con el CLI ya autenticado:
supabase functions deploy rela-proxy --project-ref rnldqiwwzhjnurkguihu
supabase functions deploy rela-callbacks --no-verify-jwt --project-ref rnldqiwwzhjnurkguihu
supabase functions deploy rela-sync --no-verify-jwt --project-ref rnldqiwwzhjnurkguihu
supabase secrets set RELA_CLIENT_ID=... RELA_CLIENT_SECRET=... RELA_CALLBACK_SECRET=... --project-ref rnldqiwwzhjnurkguihu
```

## Activación paso a paso (con credenciales)

1. Pedir credenciales a integracion@ar.quintoandar.com (ambiente sandbox primero).
2. `supabase secrets set` de las 3 variables.
3. Asociar la inmobiliaria con el botón “Login” de Open (doc sección 9) usando
   `integrador` + código interno; anotar el `codigoInmobiliaria` resultante.
4. En Portales → RELA → Configurar: cargar código inmobiliaria, plan, contacto,
   ambiente. Dejar DRY-RUN activo.
5. Botón **Catálogos**: sincroniza ubicaciones/tipos/planes/operaciones/monedas
   (quedan en `rela_catalog_cache`).
6. Completar los 3 mapeos JSON (características, tipos, ubicaciones) con los IDs
   reales del catálogo.
7. En una propiedad → DRY-run publicar: verificar payload.
8. Apagar DRY-RUN → publicación real de prueba en sandbox.
9. Configurar callbacks (acción `callbacks_config_set` desde backend o PUT
   manual con token) apuntando a `https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/rela-callbacks`.
10. Pase a producción: email a QuintoAndar → nuevas credenciales + base URL de
    producción (`RELA_BASE_URL` o `rela_config.base_url`) y `environment=production`.

## Troubleshooting

| Síntoma | Causa probable |
|---|---|
| 401 en todas las llamadas | token vencido o credenciales de otro ambiente; se re-obtiene solo, si persiste revisar `RELA_CLIENT_*` |
| ERR-0502 | sin créditos del plan; revisar Stock o contratar plan |
| ERR-0501 | el plan elegido no está contratado por la inmobiliaria |
| Listing `BLOCKED` | validación local: ver `last_error` (lista los faltantes) |
| Callbacks 503 | falta `RELA_CALLBACK_SECRET` |
| Aviso va a OFFLINE tras XML | si se habilita XML y el aviso no está en el archivo, RELA lo baja (doc XML); no mezclar XML parcial con API |

## Estado 2026-10-29 (diagnóstico post "API Premium" de Zonaprop)

- **Bloqueo único que impide publicar**: binding roto del lado de QuintoAndar —
  `GET /v1/inmobiliarias/30662083/disponibilidad` → `409 "La inmobiliaria [30662083]
  no pertenece a la integracion 20354"`, y `GET /v1/inmobiliarias` → `{"total":0}`
  (ninguna inmobiliaria vinculada a la integración). El 31/08 el binding existía
  (la API rechazaba por créditos, no por binding). Requiere acción de soporte:
  re-vincular inmobiliaria + confirmar si con el Premium viene entorno/base URL de
  producción. Los tokens/credenciales guardados SÍ sirven (catálogos 200).
- **Role param** (`?role=`) no influye en el binding: mismo 409 con `zp`, `zp2`,
  `rap`, `ri`, sin role. Catalogos OK con `role=zp`.
- `GET /v1/configuracion/callbacks` → `500 Access is denied`: falta permiso de
  administración de la integración (pedirlo a soporte junto con el binding).
- **Mapeo de ubicaciones ampliado 5 → 17 zonas** (rela_config.ubicacion_map),
  siempre con `idUbicacion` verificado en el árbol real de la API (provincia
  Córdoba `V1-B-7` → localidades `V1-C-*` → barrios `V1-D-*`). Corrección
  importante: `san vicente` apuntaba a la LOCALIDAD homónima de otro departamento
  (`V1-C-1002274`); ahora apunta al barrio de Córdoba ciudad (`V1-D-1177319`,
  "San Vicente,Córdoba,Córdoba"). El Cedrón (12 propiedades) quedó mapeado dentro
  de "Villa Ciudad Parque Los Reartes" (`V1-D-1202118`). Sin mapeo exacto (parajes
  que Zonaprop no cataloga): Loma del Tigre, La Alfonsina, San Javier del Lago —
  mapear a mano desde el panel si hace falta.
- **Barrido de validación del stock** (dry_run sobre las 45 propiedades activas):
  **27 pasan toda la validación** (aviso armado, hash listo, `would_be: create`),
  **18 BLOCKED** con motivo exacto en `rela_listings` (vendidas, sin precio, fotos o
  descripcion faltante o zona sin mapear). El barrido llena `rela_listings` con
  el estado real por propiedad — se ve en Portales → RELA.
- **Dedup de leads en `rela-callbacks` implementado (v41)**: patrón ML portado —
  `handleContact` busca lead consolidable por email/últimos-10-dígitos de teléfono
  (`source='rela_zonaprop'`, excluye etapas terminales). Si existe: rellena campos
  vacíos, vincula propiedad extra en `lead_properties`, traza el mensaje en notes
  con anti-duplicado por subcadena, actualiza `rela_webhook_events.lead_id`; NO
  crea lead duplicado. Sin identidad: fila anónima nueva (`Contacto RELA (anónimo)`),
  igual que la regla ML del dueño. Los leads nuevos entran asignados al `agent_id`
  de la propiedad (patrón ML 2026-10-19). Deployado vía MCP (compilación verificada,
  401 correcto sin credenciales); el CI lo re-deploya igual en el próximo push.
- `full_bathrooms` en `properties` está vacío en TODA la base: el aviso RELA sale
  sin baños cuando `bathrooms=0` (ej. DA-P0018). Es dato del CRM, no bug del mapper.
- Verificación rápida del binding cuando soporte responda: acción `stock` del
  panel (Portales → RELA) — 200 = listo para publicar; 409 = seguir esperando.

## Auditoría E2E 2026-10-29 (publish / update / unpublish, defectos corregidos)

Ruta completa verificada contra la DB: `rela-proxy` → `rela_listings` (enum
`rela_listing_status`: PENDING, SYNCING, PUBLISHED, UPDATE_PENDING, UPDATING,
UNPUBLISHED, ERROR, BLOCKED — todos los estados escritos por el código existen),
`rela_config`, `rela_tokens`, `rela_catalog_cache`, `rela_webhook_events`,
columnas de `properties` usadas por el mapper (todas reales), grants de
`rela_portal_status` / `insert_audit_log` (service_role ✓, authenticated ✓ en la
primera), RLS y policies. Panel: badges + botones publish/update/unpublish en la
tabla de propiedades (`#propertiesTableBody`, delegación en admin-tasaciones.js),
modal de config que escribe `rela_config` con policy super_admin,
`Sincronizar Todo` → reconcile manual.

- **CORREGIDO (bug de seguridad)**: `rela-sync` estaba en NO_VERIFY (verify_jwt
  OFF) y su gate era `if (secret && mismatch)` — con `CRON_SECRET` vacío quedaba
  un endpoint de reconciliación SIN auth (verificado: 200 anónimo). Ahora es
  fail-closed: sin secret → 503; secret erróneo → 401.
- **ALINEADO al patrón de los crons que funcionan (2026-11-08)**: `rela-sync`
  ya NO busca `CRON_SECRET` en env (el patrón que rompió 3 crons de este
  proyecto por secret inexistente / mal seteado). Ahora valida `x-sync-secret`
  contra `zernio_config(key='sync_secret')` — el mismo secret que ya usan
  backup-snapshot, zernio-sync y ml-vis-sweep (verificado en crons verdes).
  Verificado en producción: probe anónimo → **401 no autorizado** (antes 503).
  Para programar su cron en el go-live: `net.http_post` con URL hardcodeada de
  `${SUPABASE_URL}/functions/v1/rela-sync` + header `x-sync-secret` leído en
  runtime (patrón de `visits-reminders`/`backup-snapshot-daily` en `cron.job`),
  y RECORDAR `dry_run=false` de `rela_config` (mientras esté en true, la fn
  solo responde skipped — no toca la API).
- **CORREGIDO (feature muerta)**: `rela_webhook_events` no tenía policy → la
  lectura directa del panel (`loadSyncHistory`) caía siempre al `.catch`
  silencioso: los eventos RELA nunca se veían en la vista Sincronizaciones.
  Migración `20261029000001_rela_panel_read`: policy SELECT para staff
  (super_admin/broker), espejando `ml_webhook_events_staff_read`.
- **Mapper verificado sin drift**: el inline de `rela-proxy` y
  `_shared/rela.mapper.ts` computan el MISMO payload/hash para la config actual
  (los 7 tipos usan SOLO `idTipo`; el único drift potencial `idSubtipo` vs
  `idSubTipo` no aplica con estos datos). `rela-sync` usará el mismo hash que
  `rela-proxy` — sin UPDATE_PENDING fantasma.
- **Verificado**: dedupe exacto por `idEvento` (UNIQUE) + rate limit fail-closed
  en `rela-callbacks`; token vigente hasta 2036; gate de auth del proxy
  (401 gateway, verify_jwt ON); audit trail vía `insert_audit_log` en
  publish/update/unpublish/catálogos/asociar.
- **Ops conocido**: no hay automatismo que despublique de RELA cuando una
  propiedad pasa a vendida/pausada o se elimina (igual que en ML — decisión de
  producto). El operador usa el botón "Despublicar de RELA" de la tabla de
  propiedades; ninguna propiedad está publicada todavía.
- Pendiente del día 1 con binding (no verificable hoy — la sandbox estaba caída
  con 521 durante la auditoría, además del binding): forma real de la respuesta
  del PUT (`estado`/`idAviso`/`errors[]` ya parseada según la doc), el GET de
  aviso del reconcile (doc ambigua 2.5-2: marcado REQUIRES_CONFIRMATION),
  permisos del PUT `/configuracion/callbacks` y disponibilidad de créditos del
  plan SIMPLE.

## Re-auditoría 2026-10-29 (ronda 2 — contra producción ya deployada)

- **CI verificado**: "Deploy to Production" SUCCESS en el head `754ef68`
  (auditoría ronda 1) — producción sirve exactamente los archivos de este repo
  (`rela-callbacks` y `rela-sync` re-deployados por el CI, bytes idénticos a los
  deploys de MCP).
- **Gates re-sondeados en producción**: `rela-proxy` sin auth → 401 (gateway,
  verify_jwt ON) · `rela-callbacks` con secret erróneo → 401 (timing-safe) ·
  `rela-sync` sin secret → 503 (fail-closed).
- **CORRECCIÓN del informe de ronda 1**: la entrada `'rela-proxy': 60/min` en
  `RATE_LIMIT_CONFIG` existe pero **NO está cableada** en `rela-proxy/index.ts`
  (la función es self-contained sin imports). Endpoint solo-super_admin:
  residual aceptado, no bloqueante.
- **Drift repo ↔ producción detectado en `rela_config`**: producción tiene
  `rela_config_staff_read` (SELECT solo super_admin/broker) pero el repo
  declaraba `rela_config_read` USING(TRUE) — el endurecimiento se aplicó ad-hoc
  sin migración. Grabado en `20261029000002_rela_config_policy_parity.sql`
  (idempotente; requiere apply vía MCP cuando vuelva el tooling o matches el
  estado actual de producción).
- **Wiring del panel verificado al átomo**: los 12 ids del modal de config
  existen en admin.html (un id faltante pisaría `rela_config` con null),
  delegación de clicks null-safe, scripts `defer` (DOM listo antes de bind),
  `window.BH_CONFIG.SUPABASE_URL` existe, botones por fila correctos según
  existencia de listing en `rela_listings`, `#propertiesTableBody` estático.

## Estado 2026-11-07 — "Validar todos" + bloqueos reales + host de producción

### El panel ya no confunde "vendido" con "bloqueado"

El panel decía **18 bloqueados** cuando el problema real eran **5 avisos**.
De esas 18 filas, 13 eran de propiedades ya **vendidas**: no son un bloqueo
(nunca se van a publicar), son propiedades que quedan **fuera de la cola**.
Además, un dry-run sobre una propiedad vendida **pisaba a `BLOCKED` una fila que
podía estar `PUBLISHED`** → se perdía el estado real de un aviso vivo.

Corregido en tres capas (migración `20261107000001_rela_preflight_no_publicables.sql`,
aplicada en producción el 2026-11-07):

| Capa | Cambio |
|---|---|
| `rela_portal_status()` (RPC) | `blocked` cuenta sólo avisos de propiedades en venta/alquiler; nueva métrica `not_publishable` para las vendidas/pausadas. Permisos verificados: anon ✗ / authenticated ✓ / service_role ✓ |
| `rela-proxy` (edge) | `esPublicable()`: si la propiedad no es publicable **no se crea fila `BLOCKED`**; si el aviso ya está `PUBLISHED` **nunca se pisa a `BLOCKED`** (responde `published:true` con el motivo) |
| Mapper canónico | `esPublicable(p)` + `preflightRela(props, cfg)` en `_shared/rela.mapper.ts` (puro, testeado) |

### Botón "Validar todos" (action `preflight`)

Portales → RELA → **Validar todos**. Es **sólo lectura**: no llama a la API de
RELA, no publica nada, no escribe en `rela_listings`. Clasifica cada propiedad:

- **listos** → publicable y sin errores (el aviso se puede publicar).
- **bloqueados** → publicable pero le falta algo, con el **motivo exacto**.
- **fuera de cola** → vendidas/alquiladas/pausadas (no son un error).

Además agrupa las **zonas sin mapear** con los avisos que dependen de cada una
(para resolverlas de una sola vez).

### Números reales (verificados contra producción el 2026-11-07)

| Concepto | Cantidad |
|---|---|
| Propiedades activas en la base | 45 |
| Publicables (venta/alquiler) | 32 |
| **Listas para publicar** (datos completos + zona mapeada) | **27** |
| **Bloqueadas** | **5** |
| Fuera de cola (vendidas/pausadas) | 13 |

Las **5 bloqueadas** son todas por **3 zonas sin `idUbicacion` en RELA**
(los datos de la propiedad están completos; lo que falta es el código de zona):

| Zona (clave de `ubicacion_map`) | Avisos | Nombre visible en propiedades |
|---|---|---|
| `loma del tigre` | DA-P0001, DA-P0013 | Loma Del Tigre |
| `la alfonsina` | DA-P0015, DA-P0016 | La Alfonsina |
| `san javier del lago` | DA-P0026 | San Javier del Lago |

### La API: sandbox caída + host de producción descubierto

- **`https://api-zp-sandbox-open.navent.com` → HTTP 521** (caída global del
  servidor, no es un error de BH: responde 521 incluso en `/`). Verificado por
  `curl` y por `net.http_get` desde la base. **No se puede obtener el catálogo
  de ubicaciones hasta que vuelva.**
- **El host de PRODUCCIÓN existe**: `https://api-zp-open.navent.com`
  (responde 401 `invalid_token` sin token; con el token de sandbox también
  `invalid_token`, que es lo esperado: los tokens son por ambiente).
  → Hay que setear `RELA_BASE_URL=https://api-zp-open.navent.com` +
  `environment=production` + credenciales de producción.
- El token guardado (`rela_tokens.access_token`, en claro, vigente hasta
  2036-08-28) es **de sandbox** y sirve para consultar catálogos sin exponerlo
  (se lee desde la base, nunca sale a la red del cliente).

### Estado 2026-11-21 — captación YA operativa; publicación espera la API

- **✅ El cron capturó su primer lead real**: `rela-contacts-poll` (jobid 41)
  corre cada 10 min con `status='succeeded'` y creó el lead **Cata Diaz**
  (20/11 23:20 UTC, email + teléfono, `source='rela_zonaprop'`) — pasamos de
  11 a **12 leads**. La causes raíz ("no trae leads") quedó resuelta: ya no
  dependemos de los callbacks denegados.
- **✅ `contacto_telefono` cargado**: `+5493516379651` (decisión del dueño,
  el canónico del sitio/JSON-LD). Ya no bloquea la publicación.
- **⚠️ API sandbox caída de nuevo (HTTP 521)**: `api-zp-sandbox-open.navent.com`
  responde 521 "Web server is down" de Cloudflare (verificado 21/11 22:08 UTC
  por `net.http_get`, por `net.http_post` a `rela-sync` y en los logs de la
  edge function). Por eso **no se pudo correr el preview de los 16 contactos
  históricos ni publicar el aviso de prueba** (ambos autorizados por el dueño).
  No es un bug de BH: es la misma caída intermitente del 7/11 que se resolvió
  sola el 9/11. Reintentar cuando vuelva: `GET /` → 200.
- **Fix derivado** (commit `28fe5d8`): un 521 ya NO tumba `rela-sync` con 500
  en cada corrida del cron. Ahora envuelve el polling en `try/catch`, guarda
  `last_error` con el motivo y responde `degraded:true` + `contacts_error`.
  Antes el cron parecía "succeeded" (pg_net reporta el SELECT, no la respuesta
  HTTP) mientras la function moría en silencio cada 10 minutos.
- **Pendiente en cuanto vuelva la API**: (1) `preview` de 30 días → mostrar el
  split nuevos/consolidados/duplicados; (2) importar con OK explícito;
  (3) publicar **1 aviso de prueba** con el teléfono ya cargado y verificarlo
  en ZonaProp; (4) recién ahí sacar `dry_run`.

### Estado 2026-11-19 — vinculación REAL verificada + captación por polling

**Lo que el dueño vio como "no está vinculada" NO era un problema de
credenciales: la inmobiliaria SÍ está vinculada.** Sondeo real desde la DB con
el token de `rela_tokens` (2026-11-19):

- `GET /v1/inmobiliarias` → **200, `total: 1`** → "Bienenhaus Propiedades",
  `id=30662083`, `bloqueada:false` (antes daba `total:0` → el binding roto del
  9/11 ya se resolvió del lado de QuintoAndar).
- `GET /v1/inmobiliarias/30662083/disponibilidad` → **200** (antes 409) →
  `SIMPLE:11`, `DESTACADO:2`, `HOME:0` → **13 créditos disponibles**. Ya no
  aplica el bloqueo "sin pack" del ticket SP-61526.
- Swagger oficial bajado y parseado: **55 paths**. Confirmados los endpoints
  de captación (`GET /v1/inmobiliarias/{codigo}/mensajes`,
  `GET/POST /v1/inmobiliarias/{codigo}/contactos/{idContacto}`) y de callbacks.

**"No trae leads" (causa raíz)**: los callbacks NO se pueden registrar —
`PUT /v1/configuracion/callbacks` responde **500 `{"code":"error_inesperado",
"message":"Access is denied"}`** (permiso de administración de la integración
del lado de QuintoAndar; el botón de la API no basta). Como el webhook nunca se
registró, NUNCA llegó un evento. La vía viva es **`GET /mensajes`**, que sí
responde: rango `20261020..20261119` → **200, `total: 16`**.

Fix (commit `3ad7ebf`, deploy 19/11): un motor compartido
`_shared/rela-leads.ts` (dedupe, merge y preview) alimenta a
`rela-callbacks` (si algún día se habilitan), `rela-sync` (cron cada 10 min,
`rela-contacts-poll`) y `rela-contacts` (botón del panel). El botón **siempre**
corre `preview` primero y muestra cuántos contactos son nuevos / consolidables
/ duplicados; la importación exige confirmación explícita. `dry_run` sigue
bloqueando la PUBLICACIÓN (gasta créditos), NO la lectura gratuita de
contactos. `rela-contacts` exige JWT + rol `super_admin`/`broker`; `rela-sync`
es sin JWT con `x-sync-secret` (en `NO_VERIFY` del CI).

**"No puedo publicar" (causa raíz)**: en la DB hay **18 listings, 0 con
`id_aviso_navplat`, 0 PUBLICADAS, 0 eventos** — las 18 filas en `BLOCKED` son
**stale** del estado anterior del 7/11 (no hay Avísos reales creados). Antes de
publicar: (a) el dueño decide el `contacto_telefono` (hoy `null`, RELA lo
exige); (b) correr **Validar todos** con los 13 créditos disponibles; (c)
publicar **1 aviso de prueba** y verificarlo en ZonaProp; (d) recién entonces
sacar `dry_run`. **Credenciales de producción todavía no hace falta pedirlas
para las pruebas**: la sandbox volvió y es espejo de producción.

### Estado 2026-11-09 — mapeo de zonas COMPLETADO + causa raíz aclarada

- **✅ Mapeo terminado**: la sandbox volvió (HTTP 200) y se caminó el árbol desde
  la base con `net.http_get` (el token de `rela_tokens` nunca sale al cliente):
  province `V1-B-7` (Córdoba) → **ciudad `V1-C-1002226` (Villa Carlos Paz)** →
  sus 39 barrios NO contienen `loma del tigre` / `la alfonsina` /
  `san javier del lago` → **patrón `sin_equivalencia`**: los 3 quedaron mapeados
  a la ciudad (`V1-C-1002226`) y el barrio real va en la descripción del aviso.
  `ubicacion_map` = **20 zonas** (merge aditivo, las 17 previas intactas).
  ⚠️ pg_net: `timeout_milliseconds := 30000` es obligatorio en esta API (el
  default de 5 s explotó en el primer intento). El botón **Validar todos**
  refrescará la cola: esperado **32 listas / 0 bloqueadas / 13 fuera de cola**.
- **Causa raíz del bloqueo = PACK/créditos, no el binding**: en el hilo
  **SP-61526** (mensaje del 10/9) QuintoAndar aclaró que la cuenta **no tiene
  créditos en producción** y que **Sandbox es espejo de producción** (y la
  interfaz monoempresa les dificulta dar créditos de prueba). Cierre
  **"Resuelta — Esperando por el cliente"** = esperan que se contrate el pack.
  El email (enviado por **Facundo Herrera Orquera**) va como continuación de
  ese hilo con el pack de primer punto; los 4 pedidos de la plantilla vieja
  siguen, como pedidos 3 a 5. **✅ ENVIADO 2026-11-09**: correo nuevo a
  `jira@navent.atlassian.net`, asunto exacto `SP-61526 Fwd: Solicitud de
  información para integración con Zonaprop` (el hilo de Gmail era copia
  reenviada y no respondía a Jira). En espera de respuesta de Bryan Díaz en el
  ticket; si no llega en ~3 días hábiles, hacer seguimiento respondiendo de
  nuevo al ticket.
- Config BH pendiente: `contacto_telefono` (RELA lo exige; hoy `null`).

### Pendientes (en orden — actualizado 2026-11-19)

1. ~~**QuintoAndar destrabe el binding**~~ **✅ RESUELTO**: `GET /v1/inmobiliarias`
   → 200 `total:1`, `/disponibilidad` → 200 con 13 créditos (ver Estado
   2026-11-19). Verificación rápida: botón **Stock** del panel.
2. ~~**Pedir credenciales de producción**~~ **NO BLOQUEANTE**: la sandbox está
   viva y es espejo de producción; se necesitan sólo para publicar en el sitio
   real (decisión comercial del dueño).
3. **Pedir permiso de administración de la integración** para
   `GET/PUT /v1/configuracion/callbacks` (hoy responde 500 "Access is denied").
   **NO BLOQUEANTE para captar leads**: el polling `/mensajes` ya funciona y el
   botón "Traer contactos" corre cada 10 min vía cron.
4. ~~**Mapear las 3 zonas** que faltan (5 avisos = 5/32 = 16 % de la cola)~~
   **✅ HECHO 2026-11-09** (ver "Estado 2026-11-09" arriba): los 3 nombres no
   existen en el catálogo (39 barrios de VC Paz) y se aplicó `sin_equivalencia`
   → `V1-C-1002226`. La receta queda como histórico.
   1. Chequear que la API volvió: `curl --max-time 15 https://api-zp-sandbox-open.navent.com/v1/ubicaciones`
      → 200 (si sigue 521, nada que hacer).
   2. Desde la BASE (el token de `rela_tokens` nunca sale al cliente), pedir el
      nivel ciudad de Córdoba y leer el id de **Villa Carlos Paz**:
      `net.http_get`(url = `…/v1/ubicaciones/V1-B-7`, headers = Authorization
      con el access_token de `rela_tokens`) → leer `net._http_response`
      (pide/lee por polling, patrón ya usado en este proyecto) y matchear
      el nombre.
   3. Pedir sus hijos (`…/v1/ubicaciones/<V1-C de VC Paz>`) y matchear,
      normalizado (minúsculas, sin tildes, espacios simples — es el efecto de
      `normalizeZone` del mapper): `loma del tigre`, `la alfonsina`,
      `san javier del lago` → ids `V1-D-…` reales. Si un nombre no existe como
      zona de RELA, se mapea a la ciudad (id `V1-C` de VC Paz) y el nombre real
      queda en la descripción del aviso (patrón `sin_equivalencia`).
   4. Insertar — cambio ADITIVO, sin borrar lo existente:
      ```sql
      update rela_config set ubicacion_map = ubicacion_map ||
        '{"loma del tigre": "V1-D-…", "la alfonsina": "V1-D-…", "san javier del lago": "V1-D-…"}'::jsonb
      where id = true;
      ```
   5. Verificar: `select rela_portal_status();` → `blocked: 0`, `ready: 32`,
      `not_publishable: 13` (los 13 vendidos quedan fuera de la cola, no son
      bloqueados). Y probar con el botón **Validar todos** del panel.
   Alternativa sin API: pedirle a QuintoAndar los `idUbicacion` de las 3 zonas
   por email y saltar directo al paso 4.
5. **Completar `contacto_telefono`** en la config (hoy `null`) — RELA lo exige
   para publicar.
6. **Apagar DRY-RUN** recién con los 27 listos confirmados y 1 aviso de prueba
   publicado a mano.

### Gotchas del código nuevo

- **NUNCA anidar backticks dentro de `${}`** en un template literal de
  `admin-portales.js`: rompe el parseo (`SyntaxError: Missing } in template
  expression`) y `node --check` lo detecta. Para HTML con listas, armar los
  textos **fuera** del template y concatenar.
- La regla "publicable" está duplicada a propósito (`_shared/rela.mapper.ts` =
  canónico testeado; copia inline en `rela-proxy` porque el deploy no empaqueta
  `_shared`). `tests/rela-preflight.spec.js` falla si las dos se divergen.
- La RPC `rela_portal_status()` se recrea con `CREATE OR REPLACE`: si se
  cambia, **mantener `GRANT EXECUTE ... TO authenticated`** (verificado con
  `has_function_privilege` × anon/authenticated/service_role).

### Email listo para enviar a QuintoAndar

Texto completo (copiar y pegar): **[`RELA-EMAIL-QUINTOANDAR.md`](./RELA-EMAIL-QUINTOANDAR.md)**

- Responder en el hilo **SP-61526**: `jira@navent.atlassian.net`, copia
  `integracion@ar.quintoandar.com`.
- Asunto (exacto, no cambiar): **SP-61526 Fwd: Solicitud de información para integración con Zonaprop**
- Firma: **Facundo Herrera Orquera** (responsable de integración).

---

