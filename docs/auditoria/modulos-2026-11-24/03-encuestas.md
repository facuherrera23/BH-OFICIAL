# Auditoría crítica de módulos — 03: Encuestas de visita

**Fecha de auditoría:** 2026-11-24  
**Implementación de los puntos 1 a 4:** 2026-11-25  
**Alcance:** circuito completo de la encuesta posterior a la visita — generación del link, guardado automático del borrador, envío final, visualización en el CRM y en el historial de la propiedad, portal del propietario y recordatorios.  
**Método:** lectura de código + consultas SQL **sólo lectura** a producción (`rnldqiwwzhjnurkguihu`). Recién después del OK del dueño se aplicaron las migraciones de los puntos 2, 3 y 4 (incluida su correctiva) y se corrieron los tests. **No se borraron datos, no se enviaron correos, no se tocó ZonaProp y no se subió el código al repositorio remoto.**

---

## 1. Resumen en lenguaje simple

La encuesta de visita funciona, pero hasta hoy **las respuestas a medias eran invisibles para el agente**. Si el visitante cargaba algunas notas y se iba sin apretar “Enviar”, el CRM seguía mostrando sólo “Enviada” y el propietario no veía nada. Encima, un link viejo de una encuesta ya archivada seguía aceptando respuestas y un guardado corto podía borrar lo ya cargado.

Con los cambios de hoy:

- El agente ve **“Parcial (N)”** con la cantidad de respuestas guardadas y puede apretar el ojo para **ver lo cargado**.
- El historial de la propiedad también muestra el estado parcial y la fecha del último guardado.
- Un link archivado **ya no sirve** ni para consultar ni para responder la encuesta.
- Lo que el visitante cargó **ya no se borra**: si vuelve y guarda menos campos, el servidor junta lo nuevo con lo anterior.
- La primera respuesta parcial deja una nota en el historial del lead (**“Encuesta de visita recibida (parcial)”**), una sola vez por encuesta. El envío final sigue dejando la nota normal con todo lo cargado.

Quedan para la próxima etapa los recordatorios diferenciados y mostrar los parciales en el portal del propietario, según el orden acordado.

---

## 2. Estado real de los datos (sólo lectura)

Datos del día de la auditoría:

| Métrica | Valor |
|---|---:|
| Encuestas totales | 7 |
| Finalizadas (`finalized = true`) | 0 |
| Parciales reales (con respuestas guardadas) | 2 |
| Vacías (sin respuestas) | 5 |
| Archivadas (`archived_at`) | 0 |
| Tareas de recordatorio (`owner_tasks`/`lead_tasks` de encuesta) | 19 |
| Notas “Encuesta de visita recibida” en `lead_activities` | 0 |
| Opiniones visibles en el portal | 0 |

Verificación SQL posterior (25/11, después de aplicar las migraciones): **9 encuestas, 0 finalizadas, 0 archivadas, 2 parciales y 0 notas**. Las migraciones son `CREATE OR REPLACE FUNCTION` y no insertan filas; el cambio de 7 a 9 quedó registrado entre la auditoría y esta verificación. Las 2 parciales son las mismas de siempre y **no reciben nota retroactiva**: la nota se creará si el visitante vuelve a cargar algo.

Las dos respuestas parciales reales:

| Visitante | Propiedad | Respuestas guardadas | Fecha |
|---|---|---|---|
| Virginia Macarena Caselles | DA-P0018 | `{"ubicacion":5}` | 21/11/2026 |
| Mayra Romina Burgos | DA-P0009 | `{"general":6,"compraria":"si","ubicacion":5,"superficie":8,"conservacion":9,"distribucion":5}` | 15/10/2026 |

---

## 3. Hallazgos confirmados

| # | Severidad | Hallazgo | Estado |
|---|-----------|----------|--------|
| 1 | **P1** | `survey_submit_by_token` hace `answers = v_clean` (reemplaza **todo** el JSONB). Un guardado posterior con menos campos pisa respuestas anteriores. | **CORREGIDO** (puntos 3 y correctiva) |
| 2 | **P1** | Los RPC por token no chequeaban `archived_at`: un link viejo seguía sirviendo y podía escribir dentro de una encuesta archivada. | **CORREGIDO** (punto 2) |
| 3 | **P2** | Los parciales no tenían badge ni texto de “lo cargado”: el agente veía “Enviada” aunque hubiera 5 respuestas guardadas. | **CORREGIDO** (punto 1) |
| 4 | **P2** | `portal_get_surveys` filtra `finalized = true`, así que el propietario nunca ve un parcial. | PENDIENTE (punto 6) |
| 5 | **P2** | Los recordatorios deduplican por lead y usan `created_at`: no distinguen “vacía” de “parcial” y no re-avisan cuando el visitante sigue cargando. | PENDIENTE (punto 5) |
| 6 | **P3** | El guardado parcial no deja nota “Encuesta de visita recibida” en el historial del lead (por eso hay 0 notas con 7 encuestas). | **CORREGIDO** (punto 4, sin nota retroactiva) |

### Detalle del punto 1 — por qué era invisible

El frontend guarda el borrador en `localStorage.bh_survey_<token>` con debounce de 900 ms y lo envía con `sendBeacon` en `pagehide`/`visibilitychange`. Ese guardado automático **sí escribía** en `visit_surveys.answers`, pero el CRM sólo clasificaba la encuesta como `done` (finalizada) o `sent` (enviada). Como ninguna de las 7 está finalizada, todas se veían igual: “Enviada”.

### Detalle del punto 2 — por qué el link archivado era un riesgo

El botón “Archivar / nueva encuesta” pone `archived_at`, pero los RPC `survey_get_by_token` y `survey_submit_by_token` no lo miraban. Como además el submit reemplaza el `answers` completo, reutilizar un link archivado podía borrar lo que ya se había guardado. Hoy ambos RPC devuelven `available:false` / `error:'encuesta archivada'` antes de hacer cualquier `UPDATE`.

### Detalle de los puntos 3 y 4 — por qué se perdían respuestas y no avisaba

El autoguardado del visitante llama siempre al mismo RPC con sólo los campos que tocó en ese momento. Como el cuerpo viejo hacía `answers = v_clean`, un guardado con una sola nota borraba las seis anteriores. Además, nadie avisaba en el historial del lead hasta que apretaba “Enviar”: por eso había 0 notas con encuestas ya cargadas.

Ahora el RPC hace `answers = lo ya guardado || lo nuevo` (gana lo nuevo por clave) y la primera respuesta parcial inserta una nota en `lead_activities` con el `id` de la encuesta en la descripción. Ese id es el dedup: guardar 10 veces no crea 10 notas. Si después llega el envío final, se agrega la nota normal con el JSONB completo.

Hubo un detalle técnico durante la implementación: la primera versión de la migración usó `jsonb_object_length()`, que **no existe** en la versión de Postgres del proyecto. `CREATE OR REPLACE FUNCTION` aceptó el cuerpo, pero el RPC habría fallado en el primer guardado. Se aplicó una correctiva que cuenta las claves con `count(*) FROM jsonb_object_keys(...)`, verificada en producción.

---

## 4. Cambios aplicados

### Punto 1 — visibilidad en el CRM

- `assets/js/admin-crm.js`
  - `getLeadSurveys()` ahora trae también `created_at` y `updated_at`.
  - Nueva helper `surveyAnswerCount(s)` cuenta las claves de `answers`.
  - Badge `Parcial (N)` cuando la encuesta no está finalizada pero tiene respuestas.
  - Botón ojo disponible también para parciales, con título `Ver lo cargado (respuesta parcial)` y texto que avisa cuántas respuestas hay antes de listarlas.
  - El botón de WhatsApp dice “Reenviar” cuando ya hay encuesta enviada o parcial.
- `assets/js/admin-propiedades.js`
  - El historial de la propiedad usa `submitted_at || updated_at || created_at` para mostrar la fecha real del último guardado.
  - Muestra `Parcial (N)` en vez de “Enviada” cuando hay respuestas sin finalizar.
  - El `select` incluye `updated_at`.
- `assets/css/admin.css`
  - Estilo nuevo `.survey-status--partial` (mismo acento teal del panel).
- `admin.html`
  - Bump de caché: `admin.css` 545 → 546, `admin-crm.js` 107 → 108, `admin-propiedades.js` 29 → 30.

### Punto 2 — cierre del link archivado

- `supabase/migrations/20261125000001_survey_archived_link.sql`
  - `CREATE OR REPLACE FUNCTION survey_get_by_token(...)`: si `rec.archived_at IS NOT NULL`, devuelve `jsonb_build_object('available', false)`.
  - `CREATE OR REPLACE FUNCTION survey_submit_by_token(...)`: si `rec.archived_at IS NOT NULL`, devuelve `jsonb_build_object('ok', false, 'error', 'encuesta archivada')` **antes del `UPDATE`**.
  - Conserva `SECURITY DEFINER`, `search_path = ''` y los permisos: `anon`, `authenticated` y `service_role` con EXECUTE.
  - No contiene `DELETE`, `TRUNCATE`, `DROP` ni toca filas. La definición anterior sigue disponible en `supabase/migrations/20261009000001_visit_surveys_v2_encuesta.sql` si hiciera falta revertir.
  - **Aplicada en producción** el 2026-11-26 00:13 UTC con nombre `20261126001305` / `20261125000001_survey_archived_link`.
  - Verificado en producción: ambos RPC tienen el guard, siguen siendo `SECURITY DEFINER`, con `search_path=""` y los tres roles con EXECUTE. Los datos siguen iguales: 7 / 0 finalizadas / 0 archivadas.

### Punto 3 — merge anti-pisón y correctiva del conteo

- `supabase/migrations/20261125000002_survey_merge_partial_note.sql`
  - `survey_submit_by_token` ahora calcula `v_merged := v_base || v_clean` y hace `SET answers = v_merged`: lo ya guardado se conserva y lo nuevo gana por clave.
  - Conserva el `FOR UPDATE`, el guard de encuesta archivada **antes** del `UPDATE`, el bloqueo post-finalización y la sanitización de notas 1–10 enteras, `compraria` `si|no` y textos ≤1000.
  - Devuelve `answer_count` (cantidad total de respuestas) y `partial_note` (si se creó la nota de parcial).
- `supabase/migrations/20261125000003_survey_merge_count_fix.sql`
  - La 0002 usaba `jsonb_object_length()`, función que no existe en este Postgres (`42883` al ejecutar el RPC). La correctiva redefine el mismo cuerpo con `count(*) FROM jsonb_object_keys(...)`.
  - Aditiva: sólo `CREATE OR REPLACE FUNCTION`, sin tocar datos ni permisos.
  - **Aplicadas en producción** con OK explícito: 0002 como `20261126004320` y 0003 como `20261126004530`.
  - Verificado en producción: merge presente, `SET answers = v_merged` presente, conteo portable presente, `jsonb_object_length` ausente, `SECURITY DEFINER`, `search_path=""` y EXECUTE para `anon`, `authenticated` y `service_role`.

### Punto 4 — nota de parcial en el historial del lead

- La primera respuesta parcial inserta `Encuesta de visita recibida (parcial) — <property_code>` en `lead_activities` (tipo `note`), con el `id` del survey en la descripción.
- El dedup consulta exactamente ese id, así que hablar con la misma encuesta varias veces **no duplica** la nota. Dos visitas distintas del mismo lead tampoco se confunden.
- El envío final sigue insertando `Encuesta de visita recibida — <property_code>`, ahora con el detalle armado desde el merge completo.
- Las 2 parciales que ya existían no reciben nota retroactiva: aparecen en el CRM desde el punto 1 y la nota se creará recién si el visitante vuelve a cargar algo.

### Guards y pruebas

- `tests/survey-partial.spec.js` — 10 tests estáticos: los dos RPC se redefinen, el guard va antes del `UPDATE`, la migración es aditiva, se conservan permisos, el CRM trae `updated_at`, cuenta respuestas, muestra el badge y el botón de ver parcial, y el historial de propiedad muestra `Parcial (N)`.
- `tests/survey-merge.spec.js` — 10 tests estáticos: merge en vez de replace, `FOR UPDATE` y guard de archivada, sin sentencias destructivas, nota de parcial dedup, nota final con merge, respuesta del RPC, y la correctiva del conteo sin `jsonb_object_length`.
- `node --check` pasó en los tres JS editados.
- `npm run bump` actualizó los `?v=` en `admin.html`.
- `npx playwright test tests/survey-merge.spec.js tests/survey-partial.spec.js --reporter=list` → **20/20**.
- `npm test -- --reporter=list` → **832 passed, 3 skipped, 0 failed**.

---

## 5. Orden acordado y qué queda

| Orden | Ítem | Estado |
|---:|---|---|
| 1 | Visibilidad del parcial en el CRM | **HECHO** |
| 2 | Cerrar el link archivado | **HECHO** |
| 3 | Merge / anti-pisón de respuestas (`answers = answers || v_clean`) | **HECHO** (migraciones 0002 + 0003 aplicadas) |
| 4 | Nota “Encuesta de visita recibida (parcial)” en `lead_activities` | **HECHO** (sin nota retroactiva) |
| 5 | Recordatorios diferenciados (vacía vs parcial, sin dedup por lead) | Pausado |
| 6 | Mostrar parciales en el portal del propietario (`portal_get_surveys`) | Pausado |

**No se hicieron:** borrado de las 19 tareas existentes, cambios en los duplicados de ZonaProp ni envío de correos. Sí se aplicaron las migraciones 0001, 0002 y 0003 en producción con OK explícito. Para subir el código el dueño eligió **“Esperar”**: no hay commit, push ni deploy del front-end; los archivos quedan listos en el árbol de trabajo.

---

## 6. Cómo verificarlo en producción

Los pasos 1 y 2 requieren que se suba el front-end (todavía no se hizo). Los pasos 3 a 5 ya se pueden probar porque son RPC aplicados en producción.

1. Abrir un lead con propiedad vinculada que tenga respuestas parciales (por ejemplo Virginia Macarena Caselles / DA-P0018): debe aparecer `Parcial (1)` y el ojo debe mostrar `Encuesta parcial: el visitante cargó 1 respuesta(s) y no apretó "Enviar".`
2. Entrar a Propiedades → historial de esa propiedad: debe aparecer `Parcial (1)` y la fecha 21/11 con hora.
3. Tomar una encuesta archivada (cuando exista alguna) y abrir su link: debe decir que ya no está disponible; intentar enviar debe devolver `encuesta archivada` y no modificar la fila.
4. Abrir una encuesta parcial, cargar una sola respuesta nueva y volver a abrirla: deben seguir las respuestas anteriores **y** la nueva (merge). El RPC debe devolver `answer_count` con el total.
5. En el historial del lead debe existir una nota `Encuesta de visita recibida (parcial)` con el id de la encuesta; guardar otra vez no debe duplicarla. Al apretar “Enviar” debe aparecer la nota normal `Encuesta de visita recibida` con todo lo cargado.
