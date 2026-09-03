# PROMPT PARA ASISTENTE IA — CRM de Tareas en el Módulo de Propietarios (BH-OFICIAL)

---

## ROL

Actuá como **Ingeniero de Software Full-Stack Senior especializado en Supabase (Postgres + RLS + Edge Functions/Deno) y JavaScript Vanilla sin build step**, con experiencia comprobada manteniendo aplicaciones legacy en producción sin romper funcionalidad existente.

Tu prioridad #1, por encima de la elegancia del código o de tus preferencias personales de arquitectura, es: **no romper nada de lo que ya funciona**. Este es un sistema real en producción (inmobiliaria BIENENHAUS PROPIEDADES) con datos de propietarios, comisiones y documentos legales. Cada cambio debe ser aditivo, retrocompatible, idempotente, y debe seguir al pie de la letra las convenciones ya existentes en el repo — aunque no sean las que elegirías en un proyecto desde cero.

No propongas frameworks, bundlers, ni ES Modules. No refactorices código que no esté relacionado con esta tarea, aunque lo veas mejorable.

---

## ANTES DE ESCRIBIR UNA SOLA LÍNEA DE CÓDIGO — LEÉ ESTO PRIMERO

No asumas nada de lo que se describe en este documento como "actual" (números de línea, nombres de funciones, versión de cache buster) sin verificarlo vos mismo en el código real, porque el archivo puede haber cambiado desde que se escribió este prompt. Hacé esto en orden, antes de tocar nada:

1. Abrí `assets/js/admin-app.js` completo y ubicá con búsqueda de texto (no por número de línea) las funciones: `editOwner`, `loadOwnerTimeline`, `loadOwnerDocuments`, `loadOwnerChecklist`, `loadAgentSelect`, `setupCoreRealtime`, `mutate`. Leé cada una completa antes de escribir código nuevo que las use o las imite.
2. Abrí `admin.html` y ubicá el bloque `<div class="admin-modal" id="ownerModal">` completo, con sus 7 tabs actuales (`data`, `docs`, `checklist`, `props`, `tasaciones`, `timeline`, `contract`). Entendé cómo se togglean con `owner-tab-btn` / `owner-tab-content` antes de agregar el tab nuevo.
3. Listá `supabase/migrations/` ordenado por nombre y confirmá cuál es la migración más reciente — tu archivo nuevo debe tener timestamp posterior a esa, sin excepción, o Supabase puede aplicar el orden incorrecto.
4. Abrí las migraciones `20260826_propietarios_100pct.sql`, `20260824000003_pg_cron_supervision_rules.sql` y `20260824000004_risk_scoring_system.sql` — son las plantillas literales que tenés que imitar en estilo, no reinventar.
5. Abrí `supabase/functions/supervision-notify/index.ts` y `supabase/functions/supervision-notifications/index.ts` completos — son la plantilla de tu Edge Function nueva.
6. Fijate el número de cache buster (`?v=N`) actual de `admin-app.js` y `admin.css` en `admin.html` — vas a tener que subirlo en 1 al terminar, con el número real que encuentres, no el que se mencione como ejemplo en este documento.
7. Si algo de lo que describe este prompt no coincide con lo que encontrás en el código real, **priorizá siempre lo que ves en el código real** y avisá del desvío en tu respuesta final, no lo resuelvas en silencio.

---

## CONTEXTO DEL PROYECTO

Repo: `BH-OFICIAL` — Landing pública + Panel administrativo (CRM) para inmobiliaria.

**Stack (NO NEGOCIABLE):**
- Frontend: Vanilla JS con scripts clásicos IIFE + globals (`window.*`), **sin ES Modules ni bundler**
- Backend: Supabase (PostgreSQL + Auth + RLS + Realtime + Edge Functions en Deno)
- El panel admin es una SPA en `admin.html` con hash-routing por tabs, y toda la lógica vive en `assets/js/admin-app.js` (~10.000+ líneas)
- Deploy: Cloudflare Pages (sin build) — el JS se invalida con cache busters `?v=N` en los `<script>`/`<link>` de los HTML

**Archivos que vas a tocar (y solo estos):**
- `assets/js/admin-app.js` — lógica del módulo Propietarios
- `admin.html` — modal `#ownerModal`
- `assets/css/admin.css` — estilos nuevos + cache buster
- Nueva migración SQL en `supabase/migrations/`
- Nueva Edge Function en `supabase/functions/owner-tasks-reminder/`
- `README.md` — documentación (el proyecto mantiene un README vivo, seguí su estilo exacto)

**Archivos que NO tenés que tocar salvo lo mínimo indicado más abajo:** cualquier otro módulo (Leads, Comisiones, Chat Zernio, Portales ML, Supervisión, etc.), `index.html`, `tasacion.html`, `portal-propietario.html`, `confirmar-visita.html`.

---

## ESTADO ACTUAL DEL MÓDULO DE PROPIETARIOS (YA EXISTE — NO ROMPER)

- Tabla `owners` (datos del propietario, exclusividad, comisiones, documentos JSONB)
- Tabla `owner_timeline_entries` (`id, owner_id, type ['note'|'alert'|'commission'|'document'|'contact'], text, created_by, created_at`) — es un **log histórico de comunicaciones ya realizadas**, entrada libre de texto, sin estado ni asignación. Se renderiza en el tab "Timeline" del modal `#ownerModal` vía `loadOwnerTimeline(ownerId)`.
- Tabla `owner_portal_tokens`, `document_requirements` (checklist documental)
- El modal de propietario (`#ownerModal` en `admin.html`) tiene 7 tabs manejados por `data-owner-tab` + `.owner-tab-content` con show/hide en JS
- Patrón de escritura: usar `mutate(table, fn)` en vez de `.insert()/.update()/.delete()` directos (invalida `_searchCache` y emite evento para Realtime cross-tab)
- Sanitización: **siempre** `esc()` / `escAttr()` de `window.BHUtils` antes de cualquier `innerHTML`
- Roles: `profiles.role` ∈ `super_admin | broker | agente` (enum `user_role`)
- RLS: patrón dominante en el proyecto es `FOR ALL TO authenticated USING (true) WITH CHECK (true)` en tablas operativas — NO inventes reglas de permisos más restrictivas
- Realtime: las tablas core están suscriptas en `setupCoreRealtime()`
- Badge de sidebar: función RPC `get_sidebar_badge_counts()` (`SECURITY DEFINER`, `SET search_path TO ''`) devuelve JSON con contadores por módulo

---

## TAREA A IMPLEMENTAR

Agregar un **CRM de tareas de seguimiento** para propietarios: permitir registrar y controlar las tareas que un agente/broker debe hacer con cada propietario (ej. "llamar para renovar exclusividad", "pedir certificado de dominio actualizado", "enviar liquidación de comisión"), con fecha límite, estado y recordatorio automático antes del vencimiento.

### Requisitos funcionales

1. **Vista**: tabla/lista simple **dentro del tab del propietario** (nuevo tab "Tareas" en `#ownerModal`, mismo patrón visual que "Timeline"/"Documentos"). NO es un Kanban global ni un tab nuevo en el sidebar — se navega siempre desde el expediente del propietario (`editOwner(id)`).

2. **Campos de cada tarea**:
   - `type`: motivo/tipo de contacto. Reutilizar el mismo set de valores que ya usa `owner_timeline_entries` (`note, alert, commission, document, contact`) para que el mapeo al completar la tarea sea directo — no inventes una taxonomía paralela.
   - `description`: descripción/motivo en texto libre.
   - `due_date timestamptz NOT NULL`: fecha límite (con hora).
   - `status`: `pendiente | en_progreso | completada | cancelada`.
   - `priority`: `baja | media | alta`.
   - `assigned_to uuid REFERENCES agents(id)`: agente responsable. **Usar `agents.id`, nunca `profiles.id` ni `auth.uid()` directo** — es el mismo patrón ya unificado en `properties.agent_id` y `leads.assigned_to` (migración `20260827_unify_agent_ids`).
   - `result_notes`: notas/resultado del contacto, se completa al cerrar la tarea.
   - `remind_before_minutes integer NOT NULL DEFAULT 1440`: recordatorio configurable por el usuario al crear la tarea (ver detalle abajo). **No exponer un campo de texto libre para esto.**
   - `reminder_sent_at timestamptz`: control anti-duplicados del recordatorio.
   - `created_by`, `created_at`, `updated_at`.

3. **Permisos**: cualquier rol autenticado (`super_admin`, `broker`, `agente`) puede crear tareas y asignárselas a sí mismo o a otro agente — sin restricción adicional de RLS más allá del patrón estándar `FOR ALL TO authenticated`.

4. **Selector de agente asignado (UI)**: reutilizar **exactamente** la función `loadAgentSelect(selectElement, selectedId?)` ya existente en `admin-app.js`, usada hoy para poblar `#propAgentSelect` (modal Propiedades) y `#visitBrokerSelect` (modal Visitas, incluyendo el caso de precarga con un valor ya asignado). El nuevo `<select name="assigned_to" id="ownerTaskAgentSelect">` debe poblarse llamando a esa misma función. **No crees un fetch de agentes nuevo ni un componente de selección distinto.**

5. **Integración con el Timeline existente (DECISIÓN YA TOMADA, no la reabras)**: al marcar una tarea como `completada`, la función `window.adminApp.completeOwnerTask(id)` debe, en la **misma operación de frontend** (dentro de `mutate()`):
   a) hacer `UPDATE` de `owner_tasks` (`status='completada'`, `result_notes`, `updated_at`), y
   b) hacer `INSERT` en `owner_timeline_entries` (mismo `owner_id`, `type` heredado de la tarea, `text` autogenerado con el resumen de la tarea + `result_notes`, `created_by` = usuario actual).
   **No implementar esto como trigger SQL `AFTER UPDATE`.** Motivo: un trigger con `SECURITY DEFINER` no tiene forma confiable de saber "qué usuario hizo el cambio" salvo que se le pase explícitamente, lo que agrega complejidad innecesaria para un caso donde el frontend siempre está presente. El Timeline sigue siendo el historial inmutable de lo ya hecho; `owner_tasks` es la agenda de lo pendiente. **No migres ni reemplaces el Timeline actual.**

6. **Recordatorio automático**:
   - **Tipo de dato**: `due_date timestamptz` + `remind_before_minutes integer`. El usuario elige en un `<select>` con opciones fijas (30 min, 1 hora, 3 horas, 1 día, 2 días, 3 días). El momento de disparo se calcula como `due_date - (remind_before_minutes || ' minutes')::interval`.
   - **Timezone**: todas las comparaciones de fecha/hora se hacen en UTC vía `timestamptz` (estándar del proyecto), pero cualquier fecha/hora mostrada en la UI o en el texto del email debe convertirse a `America/Argentina/Buenos_Aires` con `AT TIME ZONE`, igual que hace `20260824000004_risk_scoring_system.sql`. No asumas que `now()` del servidor ya está en hora argentina.
   - **Definición de "vencida"**: `status IN ('pendiente','en_progreso') AND due_date < now()`. Usar esta misma condición en el badge del sidebar y en el indicador visual de la fila del propietario — no dos definiciones distintas.
   - **Arquitectura**: Edge Function + `pg_cron`, reutilizando infraestructura existente:
     - Destinatario del email: resolver `owner_tasks.assigned_to → agents.id → agents.profile_id → auth.users`/`profiles` para obtener el email, y cruzar contra `notification_preferences` (respetar `email=false` si el agente lo desactivó).
     - Envío por Brevo siguiendo el estilo de `supervision-notify` / `supervision-notifications` (leer `app_settings.integrations` / `Deno.env` igual que esas funciones).
     - El cron se registra con `cron.schedule(...)` **dentro de la propia migración SQL**, con la sintaxis exacta ya usada en `20260824000003_pg_cron_supervision_rules.sql` / `20260824000012_supervision_digest.sql`. Frecuencia: cada 15 minutos.
     - Anti-duplicados: la Edge Function selecciona tareas donde `reminder_sent_at IS NULL AND status IN ('pendiente','en_progreso') AND now() >= due_date - (remind_before_minutes || ' minutes')::interval`. Marcar `reminder_sent_at = now()` **inmediatamente después de confirmar el envío de cada tarea individual** (no en batch al final), para no reenviar si la función se corta a mitad de camino.

7. **Badges/UI**: sumar el contador de tareas vencidas (según la definición del punto 6) a `get_sidebar_badge_counts()`, y mostrar un indicador visual (ej. punto rojo) en la fila del propietario en la tabla principal si tiene alguna tarea vencida.

8. **Realtime**: suscribir `owner_tasks` en `setupCoreRealtime()`, siguiendo el mismo patrón que las demás tablas core.

---

## ENTREGABLES ESPERADOS

1. **Migración SQL** en `supabase/migrations/`, nombrada `YYYYMMDDHHMMSS_owner_tasks_crm.sql` con timestamp posterior a la última migración real del repo (verificado en el paso 3 de "antes de escribir código"). Debe incluir:
   - `CREATE TABLE IF NOT EXISTS owner_tasks (...)` con todos los campos de la sección anterior.
   - Índices en `owner_id`, `assigned_to`, `due_date`, `status`.
   - `ALTER TABLE owner_tasks ENABLE ROW LEVEL SECURITY;` + `DROP POLICY IF EXISTS` seguido de `CREATE POLICY "owner_tasks_auth" ON owner_tasks FOR ALL TO authenticated USING (true) WITH CHECK (true);` (mismo patrón que el resto del módulo propietarios, ver `20260826_propietarios_100pct.sql`).
   - `CREATE OR REPLACE FUNCTION public.get_sidebar_badge_counts(...)` **redefiniendo la función completa** (copiando su cuerpo actual real del repo y sumando el nuevo contador) — no un `ALTER FUNCTION` parcial, y no edites el archivo de migración viejo donde se definió por última vez.
   - Registro del `cron.schedule(...)` para el recordatorio.
   - Todo idempotente (`IF NOT EXISTS`, `DROP ... IF EXISTS` antes de crear, `ON CONFLICT DO NOTHING` donde aplique).
   - Comentario al final del archivo explicando en 2-3 líneas la decisión de resolver la sincronización con el Timeline en el frontend y no con trigger SQL (para que quede documentado igual que las demás decisiones de arquitectura del README).

2. **Edge Function** `supabase/functions/owner-tasks-reminder/index.ts` (Deno):
   - Reutiliza `_shared/http.ts` (CORS/responses) y, si aplica, `_shared/audit.ts` (`auditEvent`/`auditError`) para logging consistente con el resto del proyecto.
   - Sin `verify_jwt` (se ejecuta por cron, igual que `supervision-notify`), documentar esto en el comentario superior del archivo.
   - Manejo de errores explícito: si falla el envío de una tarea individual, debe continuar con las demás (no abortar el batch completo) y loguear el error.

3. **Frontend (`admin.html`)**: nuevo tab `data-owner-tab="tasks"` en `#ownerModal` (ubicado entre "Checklist" y "Propiedades") + su `<div id="ownerTab-tasks" class="owner-tab-content" style="display:none;">` con formulario de alta (motivo/tipo, descripción, fecha límite, prioridad, agente asignado vía `loadAgentSelect`, recordatorio) y lista de tareas existentes con acciones (completar, cancelar, eliminar). Debe integrarse al mecanismo existente de tab-switching sin modificar cómo funcionan los otros 7 tabs.

4. **Frontend (`assets/js/admin-app.js`)**: funciones nuevas siguiendo el estilo exacto de `loadOwnerTimeline`/`loadOwnerDocuments` (mismas convenciones de nombres, manejo de errores con `try/catch`, `showToast`, uso de `esc()`):
   - `loadOwnerTasks(ownerId)` — fetch + render.
   - `window.adminApp.createOwnerTask(...)`.
   - `window.adminApp.completeOwnerTask(id)` — implementa la lógica del punto 5 (update + insert en timeline, ambos vía `mutate()`).
   - `window.adminApp.cancelOwnerTask(id)`, `window.adminApp.deleteOwnerTask(id)`.
   - Hookear `loadOwnerTasks(id)` en el bloque de `editOwner` donde ya se cargan `loadOwnerDocuments`, `loadOwnerProperties`, etc. en background.
   - Sumar `owner_tasks` a `setupCoreRealtime()`.

5. **CSS** en `assets/css/admin.css`: estilos para la tabla de tareas y el indicador de vencidas, reutilizando las variables ya definidas (`--accent`, `--text-dim`, `--border-subtle`, `--danger`) — no declarar colores nuevos sueltos.

6. **Cache busters**: subir en 1 el número real encontrado (paso 6 de "antes de escribir código") de `admin-app.js` y `admin.css` en `admin.html`, y en cualquier otro HTML que efectivamente los cargue (verificarlo, no asumirlo).

7. **`README.md`**: agregar `owner_tasks` a "Base de datos" (con descripción y filas aprox=0), la nueva Edge Function a "Edge Functions", la migración a "Migraciones", el tab nuevo en "Panel administrativo" → Propietarios, y una entrada en "Changelog" con la fecha del día — siguiendo el formato exacto de las entradas ya existentes.

8. **QA obligatorio antes de dar la tarea por terminada**:
   - Correr `node --check assets/js/admin-app.js` y confirmar que no rompe.
   - Releer el `#ownerModal` completo en `admin.html` después de tu cambio y confirmar que los 7 tabs originales siguen intactos y funcionando (no solo el nuevo).
   - Confirmar que ninguna tabla, función ni policy existente fue modificada salvo `get_sidebar_badge_counts()` (única excepción permitida, y solo vía `CREATE OR REPLACE` en una migración nueva).
   - Si existe suite Playwright en `tests/`, correrla o al menos revisar si algún test smoke de `admin.html` podría verse afectado por el nuevo tab.

---

## RESTRICCIONES DURAS — SI DUDÁS, NO LO HAGAS

- NO uses ES Modules, NO agregues bundler, NO cambies el patrón IIFE/`window.*`.
- NO toques ningún archivo ni módulo fuera de la lista de "Archivos que vas a tocar".
- NO modifiques ni "limpies" código existente que no esté directamente relacionado con esta tarea, aunque te parezca mejorable.
- NO relajes ni endurezcas RLS de tablas ya existentes. La única tabla nueva con RLS es `owner_tasks`; ninguna policy existente se toca.
- NO edites migraciones SQL ya aplicadas en el repo — toda modificación de una función existente (`get_sidebar_badge_counts`) se hace con `CREATE OR REPLACE` en una migración **nueva**.
- NO uses `profile_id` ni `auth.uid()` como responsable de la tarea: usá `agents.id`.
- NO implementes la sincronización con el Timeline como trigger SQL (ver punto 5) — ya está decidido que va en el frontend.
- NO hardcodees secretos (API keys) en el frontend ni en la Edge Function — todo vía `Deno.env.get()` o `app_settings.integrations`.
- NO olvides subir el cache buster real — es la causa más común de bugs "no se actualizó" en este proyecto.
- Si en algún punto no podés verificar algo del código real (por ejemplo, no encontrás `loadAgentSelect`), **parate y preguntá antes de inventar una alternativa**.
- Todo el código, comentarios y textos de UI en **español rioplatense**, consistente con el resto del proyecto.

---

## FORMATO DE ENTREGA

1. Primero, un resumen breve (2-3 párrafos) de lo que encontraste al inspeccionar el código real (confirmando o corrigiendo los supuestos de este prompt) y del diseño final que vas a implementar.
2. Después, el código completo y listo para pegar, archivo por archivo, en este orden: migración SQL → Edge Function → cambios en `admin.html` → cambios en `admin-app.js` → cambios en `admin.css` → diff del `README.md`.
3. Al final, una checklist de pasos manuales que el usuario debe hacer fuera del código (aplicar migración con `supabase db push` o el método que use el proyecto, deployar la Edge Function con `supabase functions deploy owner-tasks-reminder --no-verify-jwt`, confirmar que `pg_cron` quedó registrado, verificar cache busters, y un checklist corto de prueba manual en el navegador: crear tarea → verla en la lista → completarla → confirmar que aparece en el Timeline → confirmar que el badge del sidebar refleja tareas vencidas).
