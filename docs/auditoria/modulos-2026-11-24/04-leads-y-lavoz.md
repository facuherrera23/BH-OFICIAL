# 04 — Leads (tipo de cliente) + La Voz (estado visual y vencimiento)

**Fecha:** 26/11/2026 · **Origen:** 3 pedidos del empleador en un día + 1 filtro pedido
por separado. Todo lo que sigue se implementó y verificó; la migración ya está aplicada
en producción y el front/edge function viajan con el push.

---

## 1. Tipo de cliente "Colega / Corredor"

### Qué pidió el empleador

> "estoy viendo que tenemos colegas que nos ingresan como lead, y en realidad son colegas
> que buscan para un cliente, te parece que agreguemos Colega/corredor en tipo de Cliente
> como para poder distinguir"

### Qué había

`leads.tipo_cliente` es `text` con un **CHECK en la DB**:

```sql
CHECK (tipo_cliente IS NULL OR tipo_cliente IN ('propietario','comprador','inversor','inquilino'))
```

El valor se elegía en **un solo lugar** (el alta) y la **operación se derivaba** de él
(`TIPO_CLIENTE_OPERATION`, mismo mapa en `admin-app.js`, `admin-crm.js` y
`admin-propiedades.js`):

| tipo | deriva |
|---|---|
| propietario | venta |
| comprador / inversor | compra |
| inquilino | alquiler |

### Qué se hizo

1. **DB** — `supabase/migrations/20261126000001_leads_tipo_cliente_colega.sql`:
   se agrega `'colega'` al CHECK. Es **aditivo**: no borra ni reescribe filas (las
   existentes siguen igual). Aplicada en producción; verificado el CHECK nuevo y que los
   datos sigan intactos (54 comprador · 30 inquilino · 1 inversor · 39 sin tipo).
2. **Alta** (`admin.html` + Zod `LeadSchema` en `admin-app.js`): opción
   **"Colega / Corredor"** y el helpText aclara que la operación queda sin definir.
3. **Panel lateral del CRM** (`admin-crm.js`): la opción existe con su etiqueta y el
   chip de la lista muestra **"Colega / Corredor"** (color propio, rosa).
4. **La operación NO se inventa ni se pisa**: `colega` **no está** en
   `TIPO_CLIENTE_OPERATION`, así que `operationFromTipoCliente('colega')` devuelve `null`.
   - En el alta: `operation_type: operationFromTipoCliente(tipo) || (validated.operation_type ?? null)`
   - En el panel: `operation_type: (tipo ? operationFromTipoCliente(tipo) : null) || ((lead && lead.operation_type) || null)`
   - Antes, un `||` faltaba: al cambiar el tipo a `colega` se guardaba `operation_type = null`
     y se perdía la operación que tuviera el lead.
5. **Sugerencias de propiedades**: `computePropertyMatches` sólo aplica el filtro duro de
   operación cuando la operación es `compra`/`alquiler`; con un lead `colega` el match es
   por zona, presupuesto, tipo y ambientes (que es justo lo que necesita un colega que
   busca para su cliente).

---

## 2. Filtro por tipo de cliente en el CRM

> "aca deberia aparecer un filtro de comprador/inquilino/corredor"

La barra de filtros del CRM tenía **Estado / Origen / Operación / Agente**. La
**Operación** no servía para esto: un colega no tiene operación definida (y los
compradores/inquilinos operation_type NULL se mezclan con los de otra operación).

Se agregó `#crmTipoClienteFilter` (`eq('tipo_cliente')`) con las 5 opciones + "Tipo de
cliente: todos". Se aplicó en:

- `applyBaseFilters` (la lista del CRM),
- el **export CSV** (`exportLeadsCSV`): si no, el CSV no coincidía con lo que se ve en pantalla,
- la lista de filtros que se ocultan en el modo Propietarios (`leadOnly`).

### Corrección posterior (auditoría del mismo día)

El filtro de operación (`operationFilter`) **excluía a todos los colegas**: como `colega`
no deriva operación y la UI no permite cargarla (el `#leadOperationType` es un input
oculto que ningún JS escribe), todo lead colega queda con `operation_type IS NULL` → no
matcheaba `operation_type.eq.<op>` ni los grupos `and(operation_type.is.null, tipo_cliente.eq.<…>)`.

Consecuencia: **"Tipo: Colega" + "Operación: Compra" devolvía 0 filas** (filtros
contradictorios), y era inconsistente con el motor de sugerencias, que para un colega ya
no filtra por operación.

**Fix:** `operationFilter(op)` suma el grupo `and(operation_type.is.null,tipo_cliente.eq.colega)`
a las tres operaciones, en `admin-crm.js` **y** `admin-app.js` (idéntico a propósito: el CSV
tiene que filtrar igual que la pantalla; hay un guard que lo verifica).

> **Matiz documentado (decisión del dueño: la operación NO se pisa)**: si a un lead que ya
> tenía `operation_type` el empleador lo reclasifica a `colega` desde el panel lateral, la
> operación **se conserva** → ese lead aparece sólo en el filtro de su operación y sus
> sugerencias de propiedades sí se filtran por ella. Los colegas **nuevos** (alta) nacen con
> `operation_type` vacía → aparecen en los tres filtros y sin filtro de operación en las
> sugerencias. No es un bug: es la consecuencia de no pisar datos del lead.

**Verificación empírica:** la sintaxis del `or(...and(...))` se mandó contra el PostgREST de
producción (HTTP 200, sin `PGRST100`) y se comprobó que **varios `or=` se combinan con AND**
(`or=A` + `or=B` → intersección, sin importar el orden) → el filtro de texto + el de
operación + el de tipo se aplican juntos sin pisarse.

---

## 3. La Voz: el ícono de la fila de Propiedades

> "el icono rojo se deberia cambiar de color cuando esta el link y le di marcar publicado"
> / "el boton rojo de la voz debe cambiar a verde cuando ya fue publicado"

### Qué había

El ícono de La Voz en la fila era **rojo fijo** (`style="color:#E4002B;"`), sin importar
nada. El estado real de cada aviso vive en **`lavoz_listings`** (`status`, `ad_url`,
`published_at`, `expires_at`) — una tabla que la fila de Propiedades **nunca leía**.

### Qué se hizo

`admin-propiedades.js` ahora lee `lavoz_listings` (junto a `ml_listings` y `rela_listings`)
y calcula el color con `lavozEstadoDe()`:

| Color | Estado | Tooltip |
|---|---|---|
| 🔴 `#E4002B` | sin publicar | "Preparar aviso…", "Aviso preparado: falta marcarlo publicado" o "datos faltantes" |
| 🟢 `#4ade80` | **publicado** | "Publicado en La Voz · vence el dd/mm/aaaa" |
| 🟡 `#FFB800` | publicado, vence en ≤7 días | "vence en N días (fecha)" |
| ⚪ `#94a3b8` | **vencido** | "VENCIDO el dd/mm/aaaa: hay que renovarlo" |

Reglas importantes:

- **"Publicado" = `status='published'` O (link + fecha de publicación)**. Un `prepare` viejo
  degradaba el estado a `ready`/`failed` pero conservaba el link: es la misma regla que ya
  usa el server (`lavoz-proxy`), y es lo que evita mostrar en rojo un aviso que sí está vivo.
- Si `lavoz_listings` no se puede leer, **la lista de propiedades no se rompe** (el ícono
  queda rojo = "sin publicar").
- Al confirmar o despublicar desde Portales, el ícono se refresca solo
  (`window.adminApp.refreshLavozIcons` → `loadProperties()`).

### Corrección posterior (auditoría del mismo día)

El **panel de Portales** mostraba el `status` crudo: un aviso degradado a `ready`/`failed`
que igual tenía link + fecha de publicación aparecía como **"Listo para subir"** mientras
el ícono de Propiedades ya estaba **verde** — los dos paneles se contradecían (en
producción: DA-P0002 y DA-P0013).

**Fix:** `lavozStatusEfectivo(row)` calcula el estado real (misma regla que el server y que
`lavozEstadoDe`) y se usa en el chip, en el motivo/avisos, en el badge "Sin URL" y en el
botón "Marcar despublicado" (que antes no aparecía para esos avisos). El estado guardado
en la DB no se toca: lo repara el próximo `prepare` del server.

### Revisión crítica posterior (mismo día)

Se volvió a auditar el feature con los ojos frescos y contra los **datos reales** de
producción (8 avisos). Lo que se encontró y se corrigió:

1. **Las dos reglas no eran idénticas** (el panel decía "Publicado" y el ícono "Vencido"):
   - el front no miraba `status='expired'` → el ícono lo pintaba **verde** si su
     `expires_at` estaba en el futuro (posible por la action `expire` del server);
   - el front tampoco aplicaba la **regla de vencimiento por fecha** del server
     (`expireVencidos`): un aviso con link y fecha ya pasada quedaba "publicado" en
     Portales y gris en el ícono.
   - **Fix:** `lavozStatusEfectivo` (Portales) y `lavozEstadoDe` (ícono) ahora aplican
     **exactamente** la regla del server: `expired` (o fecha pasada sobre un aviso
     publicado/con link) → vencido; `ready`/`failed` con link + fecha de publicación →
     publicado; si no, el estado guardado.
2. **El chip "Vencido" de Portales era ÁMBAR** y el ícono lo pintaba **GRIS**: el mismo
   color significaba "vencido" en un panel y "vence en ≤7 días" en el otro. **Fix:** el
   chip "Vencido" pasó a **gris** (`#94a3b8`), como el ícono; el ámbar queda reservado
   para "publicado pero por vencer".
3. Se verificó que **el filtro de operación no rompe la búsqueda**: PostgREST combina
   varios `or=` con **AND** (probado contra producción: `or=A` + `or=B` → intersección,
   sin importar el orden) → el filtro de texto + el de operación se aplican juntos.
4. Se verificó que el **asistente de La Voz no duplica avisos**: hace `prepare` primero
   (el server repara el estado degradado → `published`) y saltea los que ya están
   publicados salvo `--force-new`.

Guardas: `tests/lavoz-estado-visual.spec.js` grewó con un **test de coherencia
entre paneles** (corre `lavozStatusEfectivo` y `lavozEstadoDe` sobre las mismas 11 filas y
falla si el ícono dice gris/rojo y el panel dice otra cosa) + el behavioral del filtro del
CRM en `tests/tipo-cliente-colega.spec.js` (`applyBaseFilters` REAL con un query recorder:
aplica operación **y** tipo a la vez).

### Tercera ronda (26/11/2026): los que contaban o mostraban el estado CRUDO

Después de arreglar el ícono y la tabla, quedaban **otros dos lectores del estado crudo**
que seguían contradiciendo al panel:

5. **Los CONTADORES del panel** (RPC `lavoz_portal_status`) contaban por `status` crudo:
   el panel decía **"3 publicados"** mientras la tabla mostraba **5 filas "Publicado"**
   (los 2 avisos degradados: DA-P0002 y DA-P0013). El panel se contradecía solo.
   - **Fix:** migración `20261126000002_lavoz_portal_status_efectivo.sql` → la RPC arma un
     `eff_status` con la MISMA fórmula que el front y el server y cuenta sobre él.
     Aditiva: no toca filas. Verificado en producción: `published=5, ready=3, expired=0,
     failed=0, draft=0, total=8` — idéntico a las 8 filas de la tabla.
   - El contador "Vencen en 7 días" usaba `< now() + 7 días` mientras el ícono (y el
     README) usan "≤ 7 días": un aviso que vencía exactamente a los 7 días no se contaba.
     **Fix:** `20261126000003_lavoz_expiring_soon_inclusive.sql` (`<=`).
6. **La CLI del asistente** (`npm run lavoz:estado`) mostraba el `status` crudo: decía
   "3 publicados · 5 por publicar" con los mismos avisos que el panel mostraba como
   "5 publicados · 3 listos".
   - **Fix:** `estadoEfectivo()` en `scripts/lavoz-publisher.mjs` (misma regla) + la cola de
     publicación ya no encola un aviso que en realidad está publicado.
7. **El captador público** (`contact-submit`) mantiene su lista de 4 tipos: un visitante del
   sitio no es un corredor; el tipo lo clasifica el equipo en el CRM. Si un lead público
   termina siendo de un colega, se reclasifica desde el panel lateral y **la operación se
   conserva** (no se pisa). Hay un guard para que nadie "arregle" esa lista.

**Verificación empírica de los filtros (SQL sobre los 124 leads vivos)**: Compra 57 ·
Alquiler 29 · Venta **0** (no hay ningún lead clasificado como venta todavía) · 38 leads sin
tipo ni operación (no aparecen en ningún filtro de operación: comportamiento pre-existente).
No hay falsos positivos: el filtro de operación, el de tipo y el de búsqueda se combinan
(AND) y no se pisan.

Guardas nuevas: `tests/lavoz-estado-visual.spec.js` (16) y `tests/tipo-cliente-colega.spec.js`
(10).

---

## 4. La Voz: la fecha REAL de vencimiento

> "aca yo le podria para poder ponerle fecha con dia mes año para poder coordinarlo con las
> publicaciones de lavoz, asi lo puede coordinar y cuando se vence el plazo cambia de color el
> icono" (captura del portal: *Creado 06/11/2026 · Publicado 06/11/2026 · Finaliza 06/12/2026*)

### Qué había

El server calculaba el vencimiento **siempre** como `published_at + 10/30 días`. La única
forma de cambiarlo era "elegir 10 o 30". Si el aviso de La Voz terminaba en otra fecha
(renovación, pack, ajuste manual), el CRM mentía: marcaba vigente (o vencido) un aviso que
en el portal era distinto.

### Qué se hizo

- **UI** (`admin-portales.js`): nuevo campo **"Vence el (fecha real en La Voz)"**
  (`input type=date`), prellenado con el vencimiento vigente o con `hoy + duración`.
  - Si el empleador escribe la fecha → **manda** sobre la duración (y cambiar la duración
    después ya no la pisa: `_lavozFechaManual`).
  - Si se deja vacío → se usa la duración (10/30 días), como antes.
  - Validación en el panel: formato `YYYY-MM-DD` y **no puede ser anterior a hoy**.
- **Server** (`supabase/functions/lavoz-proxy`): `validarVencimiento()` — acepta
  `YYYY-MM-DD` (se toma **hasta el final de ese día**) o un ISO completo; rechaza fechas
  pasadas y fechas a más de 400 días. Si viene fecha, **manda sobre** `published_at + días`.
- La fecha se manda en el `confirm` (`expires_at`) y queda en el `audit_log`.
- `lavozFecha()` ahora muestra el año con 4 dígitos (`06/12/2026`), igual que el portal.

### Correcciones posteriores (auditoría del mismo día)

1. **El día se tomaba en UTC**: `YYYY-MM-DD` se guardaba como `23:59:59Z` = **20:59 hora
   Argentina** → el ícono pintaba "vencido" 3 h antes de que terminara el día local.
   **Fix:** `new Date(s + 'T23:59:59-03:00')` (Argentina no tiene horario de verano desde
   2009) → el aviso vence a la medianoche del día escrito.
2. **El panel no validaba el tope de 400 días**: si el empleador escribía una fecha lejana
   el server respondía 400 sin contexto. **Fix:** `min` = hoy, `max` = hoy + 400 días en
   el `<input type="date">` + el mismo chequeo en el confirm (mensaje claro antes de mandar).

> Nota de despliegue: `lavoz-proxy` **no** se puede deployar por MCP (el bundle no incluye
> `_shared/`); lo deploya el CI en el push a `main`.

---

## 5. Verificación

| Qué | Cómo | Resultado |
|---|---|---|
| La DB acepta `colega` | `supabase_apply_migration` + `pg_get_constraintdef` | CHECK con los 5 valores; datos intactos |
| El alta ofrece la opción | test del modal (HTML real) | "Colega / Corredor" presente |
| `colega` no inventa operación | behavioral (`vm` con el código real del CRM) | `operationFromTipoCliente('colega') === null` |
| El filtro filtra de verdad | **behavioral de `applyBaseFilters`** (el código real con un query recorder) + guard + export CSV | operación **y** tipo aplicados a la vez; `eq('tipo_cliente')` en lista y CSV |
| Colores del ícono | behavioral de `lavozEstadoDe` (rojo/verde/ámbar/gris + caso degradado) | 7/7 |
| **Los dos paneles no se contradicen** | behavioral cruzado: `lavozStatusEfectivo` vs `lavozEstadoDe` sobre 11 filas | gris ⟺ "Vencido"; rojo ⟺ ni publicado ni vencido |
| Fecha real → server | behavioral del modal (harness con fetch falso) + guard del server | `expires_at` enviado y validado |
| Suite completa | `npm test` | ver commit |

Guardas nuevas: `tests/tipo-cliente-colega.spec.js` (9) y `tests/lavoz-estado-visual.spec.js` (13).
Guardas actualizados: `tests/lavoz-module.spec.js`, `tests/lavoz-confirm.spec.js`,
`tests/lead-cliente-operacion.spec.js`.
