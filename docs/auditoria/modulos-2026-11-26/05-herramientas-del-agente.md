# Herramientas del agente — auditoría de las 8 features (2026-11-26 / 27)

> Cycle pedido: "8 features de CRM para el agente, una por una, cada una auditada
> antes de pasar a la siguiente". Este documento es el cierre: qué se implementó,
> **cómo se verificó en producción** y qué defectos encontró la auditoría.

Todo se verificó contra **producción real** (`rnldqiwwzhjnurkguihu`) sin dejar
datos: las RPC con `BEGIN … ROLLBACK` (probaron la escritura sin commitear) y los
permisos con `has_function_privilege` sobre la lista completa de funciones nuevas.

---

## 1. Mi bandeja — `mi_bandeja(p_user_id)`

- **Qué es**: "lo que hay que atender HOY" en un solo lugar — seguimientos
  vencidos, tareas vencidas, visitas próximas, leads sin agente y consultas sin
  tocar — con WhatsApp pre-cargado y 3 acciones de 1 clic (marcar contactado,
  completar, asignármelo).
- **RPC**: `mi_bandeja(uuid)` + `get_sidebar_badge_counts` v4 (clave `mi_bandeja`).
- **Verificado en vivo**: badge = 33 y `mi_bandeja` = 33 (el MISMO número — el
  guard `tests/mi-bandeja.spec.js` falla si se despegan); alcance por rol
  (super_admin/broker: todo el equipo; agente: lo suyo + lo sin dueño).
- **Auditoría**: el badge se calculaba con un filtro más laxo que la RPC (faltaban
  los leads vivos) → se ajustó con `20261126000005` y `...00006` hasta que ambos
  dan exactamente 33.

## 2. Recordatorio real de tareas de lead — `lead-tasks-reminder`

- **El bug**: `lead_tasks.remind_before_minutes` estaba cargado en 273 tareas y
  **ningún cron lo leía** (campo cosmético). Sólo `owner_tasks` tenía recordatorios.
- **Qué es**: edge function (cada 15 min) que avisa al agente cuando
  `now() >= due_at - remind_before_minutes` y marca `lead_tasks.reminder_sent_at`
  **inmediatamente por tarea** (no en batch) → si la función se corta, no se
  reenvía lo ya enviado.
- **Verificado en vivo**: cron `lead-tasks-reminder` activo (`*/15 * * * *`), todas
  las corridas `succeeded`; 30 tareas marcadas; las 17 pendientes sin marcar están
  **todas antes de su ventana** de aviso (dispara_ya = false) → correcto.
- **Decisión de diseño**: las tareas de leads eliminados/cerrados se marcan y se
  saltan (la bandeja es accionable, no un archivo de ruido).

## 3. Fusión de duplicados — `leads_duplicados()` + `fusionar_leads()`

- **El número**: 48 de 124 leads vivos (39%) estaban en 38 grupos con el mismo
  email o teléfono.
- **Qué es**: detecta, muestra y fusiona. Mueve timeline/tareas/propiedades/
  visitas vivas/encuestas y `ml_lead_id` al principal, **completa** campos vacíos
  (nunca pisa datos), recalcula el followup y manda el duplicado a la **papelera**
  (`lost_reason='duplicado'`) → reversible, nunca DELETE físico.
- **3 bugs reales encontrados verificando en vivo** (plpgsql valida el SQL recién
  al ejecutar: ninguno aparecía al crear la función):
  | Error | Causa | Migración de fix |
  |---|---|---|
  | 42803 | `ORDER BY` sobre un agregado | `20261126000010` |
  | 23505 | `uq_leads_ml_lead_id` parcial al mover `ml_lead_id` | `20261126000011` |
  | 22P02 | `text[] || literal` parsea como array literal | `20261126000012` |
- **Verificado**: con `ROLLBACK` se movieron 8 actividades y 3 tareas, el duplicado
  quedó en la papelera y el rollback dejó todo intacto.

## 4. Reparto automático de leads sin dueño — `repartir_leads_sin_agente()`

- **Qué es**: round-robin **por carga** (el agente activo con menos leads vivos),
  FIFO por `created_at`, con traza en el timeline. Sin agentes activos → alerta de
  supervisión (`leads_sin_agente`) en vez de silencio.
- **Verificado con rollback**: 9 asignados, 0 huérfanos después, 9 trazas, 1 audit;
  distribución Danilo 28 / Helmut 14. Cron `lead-reparto-daily` (09:05 ART) activo.

## 5. Recordatorio 2h de visita — `_shared/visits.ts`

- **El bug**: la ventana 2h existía **sólo** en una edge function huérfana
  (`visits-reminders`, 0 llamadores: el cron llama a `visits-process-reminders`)
  → `reminder_2h_sent_at` era 0 en las 8 visitas.
- **Qué es**: `processReminders()` maneja las dos ventanas. 2h → email al cliente;
  si **no dejó email** pero sí teléfono → email al **agente** con el WhatsApp
  pre-cargado (el puente para que la visita no se caiga).
- **Auditoría final (27/11/2026)** — con **harness runtime en Deno** sobre el
  archivo real del repo, con la base y Brevo simulados (sin tocar producción):
  `sent=4 · sent2h=3 · failed=0`. Salieron **2 defectos más**, corregidos:
  1. **Emails contradictorios**: una visita agendada para dentro de 2h recibía el
     email de 24h ("tu visita de mañana") **y** el de 2h. Ahora la ventana 24h
     excluye lo que ya entra en la 2h, el texto 24h ya no afirma "mañana" y el
     email 2h conserva el link de confirmar/cancelar (que antes sólo iba en el 24h).
  2. **`waDigitsAr` no era el espejo del CRM**: ignoraba el marcador móvil
     doméstico "15" (`15 3513-96-5289` → `wa.me/549153513965289`, número
     inexistente). Ahora replica `normalizeArPhone` del CRM (00/54/0/9, "15",
     áreas 11/221/341/351 y largo válido) → `wa.me/5493513965289` ✅.
  3. De paso, un **TS2345** en el runner (`RemindersResult` no es
     `Record<string, unknown>`): el CI sólo corría `node --check` de JS, así que
     los errores de tipos de las edge functions nunca se veían. `deno check` queda
     como verificación local de los `.ts` tocados.

## 6. Siguiente mejor acción — `siguientesAccionesDe()`

- **Qué es**: tarjeta al tope de la ficha del lead con hasta 3 acciones por
  prioridad (sin dueño → tarea vencida → ML sin responder → sin contacto → visita
  próxima → contacto viejo → sugerencias → tarea nueva). Cada botón **reutiliza un
  flujo que ya existía** (`openVisitModal`, `CrmTasks.showTaskForm`,
  `markLeadContacted`, asignación, WhatsApp) — no se duplica lógica.

## 7. WhatsApp deja rastro

- **El bug**: el botón `wa.me` de la ficha era el **único canal sin registro**
  (plantilla, campaña y encuesta sí registraban).
- **Qué es**: cada apertura inserta en `lead_activities` ("WhatsApp abierto desde
  la ficha") con la propiedad vinculada. Fire-and-forget: **el chat se abre igual**
  aunque falle el insert (`preventDefault` sólo si el insert devuelve error).

## 8. Conversión por origen — `conversion_por_origen(p_dias)`

- **El dato**: RELA 69% de supervivencia vs ML 21.7% vs GVAmax 6.1% (365 días) —
  la señal de dónde conviene buscar, que hasta ahora sólo aparecía en el digest
  del lunes.
- **Qué es**: RPC con ventana 7/30/90 + overlay en el CRM con barras y color por
  umbral (verde ≥50%, ámbar ≥20%, rojo <20%).
- **Auditoría de la clase de bug conocida**: el clamp de días va en el orden
  correcto (`GREATEST(LEAST(x,365),1)` — la inversa era el bug de
  `bh_web_metrics` que ignoraba el parámetro y devolvía siempre 90) y el `FROM`
  del agregado **no** filtra por `stage` (los contadores van con `FILTER`, como
  en el otro bug de `bh_web_metrics` donde los contadores daban siempre 0).
  Verificado en vivo: 30 días → 6 orígenes; 9999 → 365; 0 → 1.

---

## Verificaciones transversales

| Qué | Resultado |
|---|---|
| Suite completa | **902 passed · 3 skipped · 0 failed** |
| `node --check` de cada JS editado | ✅ |
| `deno check` de las edge functions tocadas | ✅ (2 TS2345 encontrados y corregidos) |
| Permisos de las 5 RPCs nuevas | anon ✗ · authenticated ✓ · service_role ✓ (las 5) |
| `search_path` de las 5 RPCs | fijada a `''` en las 5 |
| Migraciones aplicadas | 11 de 12 (faltaba `...00008` = el cron, aplicado **después** del deploy) |
| Crons activos | `lead-tasks-reminder` (*/15), `lead-reparto-daily` (09:05 ART) |
| Front en producción | `admin-crm.js?v=117` con los 3 botones y las 8 features |

## Pendiente de limpieza manual (no hay tool para borrar edge functions)

- `visits-reminders` sigue **deployada** en producción (v34) aunque su carpeta se
  borró del repo: el cron apunta a `visits-process-reminders` (v56), así que no
  tiene llamadores. Se borra desde Supabase Studio → Edge Functions.
