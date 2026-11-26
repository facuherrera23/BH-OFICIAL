# Auditoría crítica de módulos — 01: Administración de Alquileres

**Fecha:** 2026-11-24
**Alcance:** módulo completo — core, controlador Supabase, `alquileres.html`/CSP, 11 migraciones, 2 edge functions, 2 crons, RPCs, Storage, datos reales de producción y el iframe del admin.
**Método:** lectura de código + consultas SQL **sólo lectura** a producción (`rnldqiwwzhjnurkguihu`) + revisión de los 80 guards del spec. **No se modificó código, datos, permisos ni se desplegó nada.** El informe es el paso 1 de la auditoría pedida; no se avanza al siguiente módulo sin instrucción explícita.

---

## 1. Resumen ejecutivo

El módulo es **sólido en su camino crítico de datos** (nunca arranca vacío sobre una fila real, el conflicto entre dispositivos se detecta, los cierres de mes generan respaldos antes de pisar el historial, y el porteo del core conservó la lógica financiera del standalone). La auditoría anterior del 18/11 ya corrigió 9 de 12 hallazgos y quedó documentada en `README.md`.

Esta pasada encontró **2 hallazgos que no estaban en esa lista** y que sí merecen atención antes de seguir:

| # | Severidad | Hallazgo | ¿Riesgo real? |
|---|-----------|----------|---------------|
| A | **P1** | `alquileres-month-reminder` acepta **cualquier** header `Authorization` como credencial (verify_jwt OFF): expone emails de usuarios en la respuesta y permite disparar correos por Brevo | Sí, explotable por anónimo |
| B | **P2** | `alquileres-portal-publish` envía el mail "tu liquidación ya está disponible" **incluso cuando el upsert falló** para ese propietario | Sí, aviso falso |
| C | **P2** | Doble `init()` concurrente en el login manual (handler + `SIGNED_IN`) | Carrera benigna, ruido/doble sync |
| D | **P2** | Respaldos "previos" y publicación al portal se disparan sin `await`: el INSERT puede terminar **después** del guardado del estado | Ventana pequeña de pérdida del respaldo |

El resto son observaciones P3 (crecimiento de `S.live`, firma no criptográfica, filas de prueba, import sin validar claves). **Ninguno de los hallazgos nuevos fue corregido en este informe**: el pedido fue auditar y detenerse.

---

## 2. Inventario verificado

### Código
- `assets/js/alquileres-core.js` — 198.809 bytes, 134 declaraciones top-level. Core original del standalone con 12 ediciones quirúrgicas (guardadas por `tests/alquileres-module.spec.js`). Sigue siendo la única fuente de la lógica de negocio (órdenes, liquidaciones, rendiciones, pagos, facturas OCR, Excel, WhatsApp, PDF).
- `assets/js/alquileres-app.js` — 39.382 bytes, 780 líneas. Controlador Supabase **top-level sin IIFE** (comparte ámbito léxico con el core); sólo re-declara `est()` y `guardarArchivo()`.
- `alquileres.html` — 20.247 bytes. CSP propia, gate de login, vendor Supabase → config → core → app, visor pdf.js/ExcelJS desde cdnjs.
- `tests/alquileres-module.spec.js` — 80 guards estáticos + 3 harnesses behavioral (`alquileres-nav-harness.html`, `alquileres-comps-harness.html`, `tests/helpers/fake-postgrest.js`).
- `README.md` — sección "🏘️ Administración de Alquileres" con el historial completo de incidentes y decisiones.

### Base de datos (11 migraciones del módulo)
`20261114000001` state · `...002` seed · `...003` policy SELECT · `...004` snapshots · `...005` badge v3 · `20261115000001` KPIs · `...002` cron recordatorio · `...003` liquidaciones al portal · `...004` Storage adjuntos · `20261118000001` hardening + retención de snapshots · `20261118000002` KPIs sólo administración activa.

### Edge functions y crons
- `supabase/functions/alquileres-month-reminder/index.ts` — verify_jwt **OFF** (en `NO_VERIFY` del CI), auth por `x-sync-secret`, cron `alquileres-month-reminder` jobid 34, `0 15 2,3 * *` (días 2 y 3, 12:00 ART).
- `supabase/functions/alquileres-portal-publish/index.ts` — verify_jwt **ON**, `requireAdmin` + rate limit, llamada con JWT del operador.
- Cron `bh-alquileres-snapshots-retention` jobid 39, `15 11 * * *` → `bh_archive_alquileres_snapshots(30, 180)`.

### Permisos (verificado en producción)
- `alquileres_state`: policy `own state` ALL para `authenticated`; anon sin acceso.
- `alquileres_snapshots`: policies `own snapshots read` (SELECT) e `insert` (INSERT) para `authenticated`; ACL real `authenticated=arDxtm` (sin UPDATE/DELETE) — el hardening del 18/11 está vivo.
- `alquileres_snapshots_archive`: RLS ON sin policies, club de service_role. **0 filas** hoy (la retención recién empieza en 180 días).
- `alquileres_portal_liquidaciones`: only service_role/definer, `portal_get_liquidaciones(p_token)` con EXECUTE a anon/authenticated/service_role, `search_path=''`.
- Storage bucket `alquileres-adj`: privado, 20 MB, 4 policies por carpeta `<uid>/` (select/insert/update/delete).
- `alquileres_dashboard_kpis()` y `bh_archive_alquileres_snapshots(integer,integer)`: `search_path=''`, sin EXECUTE a anon ni authenticated. `get_sidebar_badge_counts(uuid)`: `search_path=public` fijado (no mutable), EXECUTE a authenticated/service_role.

---

## 3. Estado real de los datos (sólo lectura)

| Usuario | Props | `corr.n` | Tamaño | kpis / live / sig / ownerMap | `updated_at` |
|---|---|---|---|---|---|
| danilo.arbo@gmail.com | 10 | DANILO ARBO PROPIEDADES | 150.813 B | sí / sí / sí / sí | 2026-11-19 22:15 UTC |
| hfacundo45@gmail.com | 1 (vacía) | **vacío** | 76.445 B | no / no / no / no | 2026-11-14 21:38 UTC |
| helmutscheibengraf@yahoo.com.ar | 0 | **vacío** | 320 B | sí / no / no / no | 2026-11-16 23:02 UTC |

- **16 snapshots** del usuario real, entre el 17/11 y el 18/11 (varios son "Antes de volver a…" y "Historial previo…" de los incidentes). El más reciente: "Cierre Octubre 2026" (149 KB). La retención con copia está operativa y no ha purgado nada todavía.
- **`alquileres_portal_liquidaciones`: 6 filas, 2 propietarios, períodos 2026-08 a 2026-10.** Las liquidaciones publicadas son reales; el mail del edge `alquileres-portal-publish` se usó en algún momento (no se verificó el `audit_log` de esas filas en esta pasada).
- Fila operativa en **Noviembre 2026** (`m=10`), con hist hasta Octubre. Hoy es 24/11: el cron de recordatorio del 2/3 ya evaluó Octubre y encontró el cierre presente → no envió.
- Las dos filas sin `corr.n` quedan **neutralizadas** por el criterio "administración activa" del 18/11 (KPIs y recordatorios). **No se borró nada**: hacerlo requiere OK explícito del dueño.

---

## 4. Hallazgos

### A. P1 — Autorización falsa en `alquileres-month-reminder`

**Evidencia** (`supabase/functions/alquileres-month-reminder/index.ts:113-117`):

```ts
const secretOk = !!syncSecret && req.headers.get("x-sync-secret") === syncSecret;
const authHeader = req.headers.get("Authorization");
if (!secretOk && !authHeader) {
  return jsonResponse(401, { error: 'Missing authorization' }, req);
}
```

La función está en `NO_VERIFY` de `.github/workflows/deploy.yml`, así que el gateway **no valida el JWT**. Basta mandar `Authorization: cualquier-cosa` para pasar. No hay `requireAdmin`, no se llama a `supabase.auth.getUser(token)`, no se comprara el header contra nada.

**Impacto:**
1. Cualquier persona que conozca la URL (`https://bienenhaus.com.ar/functions/v1/alquileres-month-reminder`) recibe en la respuesta `detalles[].email` con los emails de los usuarios con administración activa (`index.ts:213`, `216-222`).
2. Puede disparar el envío de correos por Brevo a esos usuarios, una vez por mes por usuario (el dedupe de `audit_log` lo limita, pero el atacante puede forzar el primer envío del mes).
3. La respuesta también revela `user_id`, cantidad de propiedades y si el mes está sin cerrar.

**Por qué no lo vio el guard:** `tests/alquileres-module.spec.js:567-588` comprueba que el string `x-sync-secret` existe, pero no que una petición sin secret sea rechazada. El comment del propio archivo dice "auth idéntica al digest (fix 20261015000004)" — el digest usa el mismo patrón de `Authorization` como *alternativa* para disparo manual, pero **el digest valida el JWT dentro**; acá no.

**Recomendación (no ejecutada):** si `authHeader` está presente, validarlo con `requireAdmin(req, supabase)` (o `supabase.auth.getUser(jwt)`) antes de continuar; si no, exigir `x-sync-secret`. Quitar `email` y `user_id` de la respuesta pública (dejar un resumen con contadores). Agregar un guard que falle si aparece `if (!secretOk && !authHeader)` sin validación posterior.

---

### B. P2 — Aviso de liquidación enviado aunque el upsert falló

**Evidencia** (`supabase/functions/alquileres-portal-publish/index.ts`):

- `validas` se arma en `73-81` (validación de forma).
- El upsert se hace en `87-99`; si falla, se apenda a `errores` y se hace `continue` — **pero el owner sigue en `validas`**.
- `if (notify && published > 0)` en `117`: alcanza con que **otro** owner se haya publicado para entrar.
- `const affected = [...new Set(validas.map(v => v.owner_id))]` en `119`: incluye al owner cuyo upsert falló.
- `periodos = validas.filter(v => v.owner_id === oid)` en `140`: también incluye el período fallido.

**Impacto:** el propietario recibe "Tu liquidación ya está disponible … Podés verla desde tu portal" con un link que abre un portal donde **esa liquidación no existe**. El `audit_log` (`101-113`) sí registra el upsert fallido sólo como `errores` en la respuesta; no hay traza de auditoría del fallo. Es el mismo patrón que el proyecto ya corrigió en RELA ("no decir N avisos consultados si todos vinieron con error").

**Recomendación:** mantener `publicadosPorOwner: Set<string>` alimentado desde el `upsert` exitoso, derivar `affected` y `periodos` de ahí, y auditar cada fallo con `status:'error'`. Extra: `o.full_name` se interpola sin escapar en el HTML del mail (`145`) — usar la misma función de escape del proyecto.

---

### C. P2 — Doble `init()` en el login manual

**Evidencia** (`assets/js/alquileres-app.js`):
- `699-709`: el submit hace `await init()`.
- `719-722`: `client.auth.onAuthStateChange(ev => { ... if (ev === 'SIGNED_IN' && !S) init(); })`.

`signInWithPassword` dispara `SIGNED_IN` **antes** de que el `await init()` del submit haya cargado `S` (la lectura a Supabase tarda), así que ambas rutas entran. El `README` ya documenta este comportamiento como gotcha de verificación de harness, pero no como bug: es una carrera real.

**Impacto:** dos `SELECT` a `alquileres_state`, dos `render()`, dos `alqAdjSync()` y dos `alqCheckStaleBuild()` por login. No hay pérdida de datos porque el P0 anti-pisón bloquea el guardado si la lectura falla, y `syncNow` compara `LAST`, pero carga redundante y riesgo de que un `conflictShow` aparezca por una de las dos lecturas con stamps distintos.

**Recomendación:** guard de promesa en `init()` (mismo patrón que `getAuthedClient()` del admin, documentado en `AGENTS.md`): si ya hay una inicialización en vuelo, devolver esa promesa. Alternativa mínima: un flag `inicializando` que el listener `SIGNED_IN` respete.

---

### D. P2 — Respaldos y publicación al portal no esperados antes del guardado

**Evidencia:**
- Core `mesMas(>0)` (`assets/js/alquileres-core.js:186-187`): `window.__ALQ_SNAPSHOT_PRE(...)`, `window.__ALQ_SNAPSHOT(...)`, `window.__ALQ_PUBLISH(...)` — los tres sin `await`.
- Controlador `146`, `171`, `342`: los hooks devuelven la promesa pero no fuerzan espera.
- Core `199`: `render(); LAST=null; guardarArchivo()` → `syncNow()` (`app.js:549`) arranca en paralelo.
- `alqSnapsRestore` (`app.js:509`): `alqSnapshotPre('Antes de restaurar …')` sin `await`, seguido de `S = s.state` y `syncNow()` en `518`.

**Impacto:** `alqSnapshotPre` toma la copia profunda **sincrónicamente** antes del primer `await`, así que el contenido del respaldo es correcto; lo que no está garantizado es que el `INSERT` en `alquileres_snapshots` termine antes del `upsert` en `alquileres_state`. Si el navegador se cierra o hay recarga inmediata, el estado nuevo puede persistir y el respaldo previo no. En `alqSnapsRestore`, además, el `created_at` del respaldo puede quedar posterior al del guardado, invirtiendo el orden cronológico en el panel "☁ Respaldos".

**Recomendación:** hacer `mesMas` async y `await` de los tres hooks antes de `guardarArchivo()`, o encolar las promesas en el controlador y esperarlas dentro de `syncNow()` antes del upsert. En `alqSnapsRestore`, `await alqSnapshotPre(...)`. Los tres son best-effort: un fallo no debe bloquear la acción, pero sí debe intentarse antes.

---

### Observaciones P3 (no bloqueantes)

1. **Conflicto no atómico.** `syncNow()` hace `SELECT updated_at` (`app.js:569`) y luego `upsert` (`585`) en dos viajes. Otra escritura entre ambos es pisada sin aviso. Para un usuario único es muy poco probable; la solución correcta sería un upsert condicional por `updated_at` vía RPC (El checkbox de "pisar conscientemente" ya existe).
2. **`S.live` sin poda.** Cada mes visitado guarda una copia completa de los props (~60-70 KB). La fila real ya pesa 150 KB; a 24 meses sería ~1,7 MB reenviados en cada guardado. Quedó abierto a propósito en la auditoría del 18/11 porque podarlo perdería las copias exactas que el dueño pidió conservar.
3. **Firma no criptográfica.** `firma()` (`core.js:175-176`) es djb2 de 32+32 bits. Colisión teórica → un re-cierre con cambios reales podría no actualizar el historial. Aceptado; alternativa sería SHA-256 vía `crypto.subtle` (async, complica el camino sincrónico).
4. **Filas de prueba en `alquileres_state`.** `hfacundo45` (1 prop, 76 KB) y `helmutscheibengraf` (0 props) siguen ahí. Neutralizadas para KPIs/recordatorios. **No borrar sin OK del dueño** (doctrina: nada se borra sin copia y aprobación).
5. **`importar()` de HTML con adjuntos base64** (`core.js:218-228`). Los `j.adj` se vuelcan a IndexedDB con claves del archivo sin validar formato ni prefijo, y los hooks `__ALQ_ADJ_UP` las suben a Storage con `upsert:true`. Un archivo manipulado podría sobrescribir comprobantes (`pg:…`, `f:…`) propios. Es riesgo auto-infligido (el operador elige el archivo), pero una validación de prefijos sería barata.
6. **`confirm()` nativo** en `alqSnapsRestore` (`app.js:507`) y en todo el core. No es un hallazgo nuevo: el puerto es fiel al standalone y el dueño pidió cero cambios de UI. La regla que prohíbe `confirm()` aplica al módulo Contenido, no a este.

---

## 5. Lo que se verificó y **no** es hallazgo

- **P0 anti-pisón** (`app.js:665-673`): si la lectura inicial falla o el estado es ilegible, `loadFailed=true` y `syncNow` está bloqueado; el estado vacío sólo se crea cuando la lectura respondió OK sin fila. Correcto.
- **Semántica de conflicto `remoteMs !== localMs`** (`app.js:574`, `739`): comparación por instante (`Date.parse`), no por string; `rowStamp` se actualiza en carga, guardado propio y ausencia de fila. No relajar a `>` (relojes atrasados).
- **Edición #9 (`FID`)**: `init()` fija `FID = user.id` y `mesMas` ya no lo cambia → la carpeta de Storage no se pierde al cerrar mes.
- **Edición #11/#12 + firma**: re-cerrar sin cambios no pisa el historial; re-cerrar con cambios avisa y respalda; retroceder guarda `S.live`. Verificado en el harness behavioral.
- **Bug del 19/11 (un solo comprobante subido)**: `onchange="subirComps([...this.files])"` + `Array.from(fs)` antes del `await`. El guard behavioral usa `DataTransfer` real y exige 3/3.
- **CSP**: `script-src` con `'unsafe-inline'` (necesario para los `onclick` del core), `connect-src` con Supabase/WSS/cdnjs, `worker-src blob:`, `frame-src blob: data:`, `img-src data: blob:`. Cubre pdf.js, ExcelJS y el visor de adjuntos.
- **RLS/ACL**: snapshots inmutables para `authenticated`, archive service-role-only, bucket por carpeta `<uid>/`, RPC del portal por token. Todo coincide con la intención documentada.
- **Retención con copia**: `bh_archive_alquileres_snapshots` copia a `*_archive` antes de borrar; firma `(integer, integer)` con grants correctos.
- **Iframe del admin**: lazy-load del `src` desde `data-src`; listener valida `e.origin === location.origin` y `e.source === alqFrame.contentWindow`, clamp `max(520, h)+12` (`admin-app.js:2142-2150`).
- **Detección de build viejo**: `alqCheckStaleBuild()` compara `?v=` del core contra el HTML servido y ofrece recargar.

---

## 6. Cierre y siguiente paso

Estado: **auditoría del módulo 01 completada; sin cambios aplicados**. Los hallazgos A y B son los únicos que considero merecen fix antes de dar por cerrado el módulo; C y D son mejoras de robustness. Quedo a la espera de tu instrucción para:

- (a) corregir alguno de estos hallazgos (con su guard de test correspondiente), o
- (b) pasar al módulo 02 y crear `02-<modulo>.md` en esta misma carpeta.

No se hizo push, deploy, migración, borrado ni cambio de permisos.
