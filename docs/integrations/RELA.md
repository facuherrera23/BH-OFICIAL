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
- Único bloqueo pendiente: el sandbox no tiene créditos (`ERR-0501`), pedido por email a QuintoAndar.
- Pruebas con usuario real (JWT de panel): `status`, `dry_run` sobre propiedad real, `publish`
  end-to-end (la API creó el aviso, lo procesó y devolvió `ERR-0501`; BH persistió listing
  con `status=ERROR`, `id_aviso_navplat` y warnings), `reconcile` (devolvió estado remoto
  `PROCESADO` — estado adicional no documentado; la UI lo muestra tal cual), `stock` y
  `catalogs_sync` (5 catálogos cacheados). RBAC verificado: rol `broker` recibe 403 al
  publicar; sólo `super_admin` escribe.
- Nota de estado remoto: RELA puede responder `estado: "PROCESADO"` al consultar un aviso
  creado pero sin créditos; se persiste crudo en `remote_status`.
- Planes existentes: `SIMPLE`, `HOME`, `DESTACADO`, `GRATIS`, `EXCLUSIVE`, `EXCLUSIVE_II`, `ALQUILER_SIMPLE` y variantes `DESARROLLOS_*`. Operaciones: `VENTA`, `ALQUILER`, `ALQUILER_TEMPORAL`. Monedas: `USD`, `ARS`.

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
