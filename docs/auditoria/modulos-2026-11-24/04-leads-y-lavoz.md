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

> Nota de despliegue: `lavoz-proxy` **no** se puede deployar por MCP (el bundle no incluye
> `_shared/`); lo deploya el CI en el push a `main`.

---

## 5. Verificación

| Qué | Cómo | Resultado |
|---|---|---|
| La DB acepta `colega` | `supabase_apply_migration` + `pg_get_constraintdef` | CHECK con los 5 valores; datos intactos |
| El alta ofrece la opción | test del modal (HTML real) | "Colega / Corredor" presente |
| `colega` no inventa operación | behavioral (`vm` con el código real del CRM) | `operationFromTipoCliente('colega') === null` |
| El filtro filtra de verdad | guard + export CSV | `eq('tipo_cliente')` en ambos |
| Colores del ícono | behavioral de `lavozEstadoDe` (rojo/verde/ámbar/gris + caso degradado) | 7/7 |
| Fecha real → server | behavioral del modal (harness con fetch falso) + guard del server | `expires_at` enviado y validado |
| Suite completa | `npm test` | ver commit |

Guardas nuevas: `tests/tipo-cliente-colega.spec.js` (7) y `tests/lavoz-estado-visual.spec.js` (7).
Guardas actualizados: `tests/lavoz-module.spec.js`, `tests/lavoz-confirm.spec.js`,
`tests/lead-cliente-operacion.spec.js`.
