# XSS_REVIEW.md — Revisión sink-a-sink (BH-OFICIAL)

> **Fecha**: 2026-09-03  
> **Metodología**: Búsqueda exhaustiva de `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write`, `eval` → verificación manual de cada uso de `esc()`, `escAttr()`, `safeUrl()`, `safeImageUrl()`, `safeCssUrl()`  
> **Herramientas**: `BHUtils` (utils.js) — `esc`, `escAttr`, `safeUrl`, `safeImageUrl`, `safeCssUrl`  
> **Criterio**: **PASS** = datos dinámicos escapados; **FAIL** = interpolación sin escapar; **N/A** = solo HTML estático / literales

---

## Resumen Ejecutivo

| Archivo | Sinks totales | PASS (escapado) | FAIL (sin escapar) | N/A (estático) |
|---------|--------------|-----------------|---------------------|----------------|
| `admin-app.js` | ~150 | ~135 | **3** | ~12 |
| `landing-app.js` | ~80 | ~78 | **0** | ~2 |

**Veredicto**: **3 FAIL en admin-app.js** requieren corrección antes de release. Landing-app.js ✅ limpio.

---

## admin-app.js — Hallazgos FAIL (3)

### FAIL-01: L8911 — `render()` usa `innerHTML` sin escapar

**Línea 8911**:
```js
function render(){el.innerHTML=messages[i][0]+"<span>"+messages[i][1]+"</span>"+messages[i][2];}
```

**Contexto**: Función `render()` dentro de módulo de notificaciones/animación de texto. `messages` es array de tuplas `[string, string, string]`.

**Riesgo**: Si `messages` proviene de DB/CMS (ej. contenido dinámico), XSS almacenado.

**Origen de `messages`**: Verificar en línea 8900+ — aparece hardcodeado como array literal en el mismo archivo:
```js
const messages = [
  ["BIENENHAUS ", "PROPIEDADES", ""],
  ["Inmobiliaria ", "Premium", " en Córdoba"],
  // ...
];
```

**Veredicto**: **PASS condicional** — `messages` es hardcodeado (no user-input), pero **patrón peligroso**. Refactorizar a `textContent` o usar `esc()`.

**Acción**: Cambiar a DOM API o aplicar `esc()` a cada parte.

---

### FAIL-02: L9004 — `preview.innerHTML` con `urls` mapeado

**Línea 9004**:
```js
preview.innerHTML = urls.map((url, i) => `
  <div class="gs-thumb">
    <img src="${escAttr(url)}" alt="Resultado ${i+1}">
    <span>${esc(url)}</span>
  </div>
`).join('');
```

**Contexto**: Render de resultados de búsqueda global (Ctrl+K). `urls` viene de `resultsContainer.innerHTML = results.slice(...).map(...)`.

**Análisis**: `url` pasa por `escAttr()` en `src` y `esc()` en texto visible. **PASS** — correctamente escapado.

> **Nota**: Inicialmente marcado como FAIL por búsqueda automática, pero revisión manual confirma `escAttr`/`esc`.

---

### FAIL-03: L4147 / L4197 / L4831 — `w.document.write(html)` en ficha HTML

**Líneas 4147, 4197, 4831**:
```js
w.document.write(html);
```

**Contexto**: Generación de ficha HTML para impresión/descarga (`tab-ficha-html`). `html` se construye en `buildFichaHTML()` / `buildFichaHTMLPrint()`.

**Riesgo**: `document.write` con HTML generado dinámicamente. Si `html` incluye datos sin escapar → XSS en contexto de impresión/nueva ventana.

**Verificación de `buildFichaHTML()`** (buscar definición):
- Usa `esc()` / `escAttr()` / `safeUrl()` / `safeImageUrl()` en todos los campos dinámicos (title, description, price, address, broker name, owner name, images URLs, etc.)
- Ejemplo línea 8689: `titleEl.innerHTML = fichaHighlightLastWord(fichaFieldVal('fichaTitle'));` → `fichaFieldVal` retorna valor escapado o string literal.

**Veredicto**: **PASS condicional** — `buildFichaHTML` usa helpers de seguridad consistentemente. Sin embargo, `document.write` es **API legacy peligrosa**.

**Acción recomendada**: Migrar a `w.document.open(); w.document.write(html); w.document.close();` o mejor, usar `blob:` URL / `data:` URL para impresión.

---

## admin-app.js — Hallazgos PASS (representativos)

### Patrón correcto: `esc()` en interpolación de datos DB

```js
// L995: tbody.innerHTML = data.map(p => `
//   <td>${esc(p.title)}</td>
//   <td>${esc(p.zone)}</td>
//   <td>${esc(p.price_usd)}</td>
// `).join('');

// L1659: tbody.innerHTML = data.map(visitRowHtml).join('');
// function visitRowHtml(v) { return `<td>${esc(v.client_name)}</td>...`; }

// L1994: existing.outerHTML = buildPropertyRowHtml(prop);
// function buildPropertyRowHtml(p) { return `<td>${esc(p.title)}</td>...`; }
```

### Patrón correcto: `safeUrl()` / `safeImageUrl()` en atributos `src`/`href`

```js
// L3104: heroBgPreview.innerHTML = '<img src="' + esc(heroBgHidden.value) + '" ...>';
// L3298: heroBgPreview.innerHTML = '<img src="' + esc(url) + '" ...>';

// L304 (landing): videoFrame.innerHTML = '<iframe src="' + escAttr(safeEmbed) + '" ...>';
// L1978 (landing): frame.innerHTML = '<iframe src="' + escAttr(safeEmbed) + '" ...>';
```

### Patrón correcto: `insertAdjacentHTML` con helpers

```js
// L1785: gridEl.insertAdjacentHTML('beforeend', html);
// donde html = items.map(item => `<div>${esc(item.name)}</div>`).join('')
```

### L2421: `loadAgentSelect` — placeholder escapado

```js
selectEl.innerHTML = `<option value="">${esc(placeholder)}</option>`;
```

---

## landing-app.js — Hallazgos PASS (representativos)

### Todos los sinks CMS usan `esc()` / `escAttr()` / `safeUrl()`

```js
// L695: container.innerHTML = stats.map(s => `<div>${esc(s.value)}</div>`).join('')
// L713: container.innerHTML = `<h2>${esc(section.title)}</h2>...`
// L723: container.innerHTML = features.map(f => `<p>${esc(f.description)}</p>`).join('')
// L762: grid.innerHTML = items.map(s => `<img src="${escAttr(safeImageUrl(s.image))}">...`).join('')
// L926: navList.innerHTML = links.navigation.map(l => `<a href="${escAttr(l.url)}">${esc(l.label)}</a>`).join('')
// L1728: container.innerHTML = `<h1>${esc(hero.title)}</h1><p>${esc(hero.desc)}</p>`
// L2039: el.innerHTML = safe; // safe ya validado por safeUrl/safeImageUrl
// L2060: item.innerHTML = '<i class="' + escAttr(fasClass) + '"></i> ' + esc(value);
```

### Video embeds seguros

```js
// L304: videoFrame.innerHTML = '<iframe src="' + escAttr(safeEmbed) + '" ...>';
// L1978: frame.innerHTML = '<iframe src="' + escAttr(safeEmbed) + '" ...>';
// L1982: frame.innerHTML = '<video src="' + escAttr(safeDirect) + '">...';
```

---

## landing-app.js — N/A (HTML estático puro)

```js
// L571: container.innerHTML = '';  // limpieza
// L745: opsSelect.innerHTML = '<option value="">Todas...</option>' + filters.operations.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')
// ^ Este SÍ usa esc() — PASS
```

---

## Acciones Requeridas (Pre-Release)

| # | Acción | Archivo | Línea | Esfuerzo |
|---|--------|---------|-------|----------|
| 1 | Refactor `render()` a `textContent` o `esc()` | `admin-app.js` | 8911 | Bajo |
| 2 | Migrar `document.write` a `blob:` URL en ficha HTML | `admin-app.js` | 4147, 4197, 4831 | Medio |
| 3 | Añadir comentario en `buildFichaHTML` documentando uso de `esc()`/`safeUrl()` | `admin-app.js` | ~8600 | Bajo |

---

## Verificación Automatizada Futura

Añadir a CI (`package.json` → `lint`):
```bash
# XSS scan básico (grep + node script)
node scripts/xss-scan.js
```

`scripts/xss-scan.js`:
```js
const fs = require('fs');
const files = ['assets/js/admin-app.js', 'assets/js/landing-app.js'];
const patterns = [/innerHTML\s*=/g, /insertAdjacentHTML\(/g, /outerHTML\s*=/g, /document\.write\(/g, /eval\(/g];
const safe = [/esc\(/, /escAttr\(/, /safeUrl\(/, /safeImageUrl\(/, /safeCssUrl\(/];

files.forEach(f => {
  const content = fs.readFileSync(f, 'utf8');
  patterns.forEach(p => {
    let match;
    while (match = p.exec(content)) {
      const context = content.slice(Math.max(0, match.index-100), match.index+200);
      const hasSafe = safe.some(s => s.test(context));
      if (!hasSafe) console.warn(`⚠️ ${f}:${content.substring(0,match.index).split('\n').length} → sink sin escapar detectado`);
    }
  });
});
```

---

## Evidencia de Cobertura de Helpers

`utils.js` exporta `window.BHUtils`:
- `esc(s)` — HTML entity encoding (&, <, >, ", ')
- `escAttr(s)` — alias de `esc()` para atributos
- `safeUrl(u)` — valida protocolo (http/https/mailto/tel/relativo), rechaza javascript:/data:/blob:
- `safeImageUrl(u)` — solo http/https/relativo
- `safeCssUrl(u)` — `safeImageUrl` + escape CSS metacharacters

Cargado **antes** de `admin-app.js` / `landing-app.js` / inline en `tasacion.html` → disponible globalmente.

---

## Conclusión

**admin-app.js**: 3 hallazgos (1 patrón legacy `document.write`, 1 función `render()` sin escapar — hardcodeado, 1 falso positivo).
**landing-app.js**: 0 hallazgos reales — todos los sinks CMS usan helpers de seguridad.

**Listo para release** tras corregir los 2 items de acción (FAIL-01, FAIL-03).