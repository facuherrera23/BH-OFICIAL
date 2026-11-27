// ACCIONES EN LOTE (P1-7 — 2026-11-27).
//
// Problema medido: con 124 leads vivos, cualquier tarea masiva ("reasignar
// los leads de Mercado Libre", "colgar los que no contestan", "exportar la
// cartera") obligaba a abrir lead por lead → en la práctica no se hacía.
//
// Lo que hay: 4 acciones sobre la selección (reasignar agente, cambiar etapa,
// colgar en espera, exportar CSV).
//
// Reglas duras que este guard congela:
//   · Las escrituras van de a UNA fila: la policy `leads_update` evalúa el
//     WITH CHECK por fila y un solo fallo abortaría TODO el lote.
//   · Los errores se INFORMAN (nunca se tragan).
//   · La exportación no deja datos sueltos: BOM (Excel + acentos) y
//     neutralización de la inyección de fórmulas.
//   · La papelera no tiene selección (un lead eliminado no se reasigna).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const crmSrc = read('assets/js/admin-crm.js');
const htmlSrc = read('admin.html');
const cssSrc = read('assets/css/admin.css');

test.describe('P1-7 — acciones en lote sobre la lista de leads', () => {
  test('el contenedor de la barra existe en el HTML', () => {
    expect(htmlSrc).toContain('id="crmBatchBar"');
    expect(htmlSrc).toContain('class="crm-batch-bar"');
  });

  test('la lista tiene checkbox por fila y "seleccionar todos"', () => {
    expect(crmSrc).toContain('class="crm-row-check"');
    expect(crmSrc).toContain('data-crm-batch-all');
    // La selección es un Set (no duplica ids).
    expect(crmSrc).toContain('var _batchSel = new Set();');
    expect(crmSrc).toContain('function batchSelectedIds() { return Array.from(_batchSel); }');
    // Al tildar el checkbox NO se abre la ficha del lead.
    expect(crmSrc).toMatch(/crm-row-check[\s\S]{0,220}e\.stopPropagation\(\);/);
    // El "todos" queda indeterminado si sólo se ticked una parte.
    expect(crmSrc).toContain('all.indeterminate = sel > 0 && sel < boxes.length;');
  });

  test('la barra ofrece las 4 acciones y se oculta sin selección', () => {
    expect(crmSrc).toContain('function renderBatchBar() {');
    expect(crmSrc).toContain('id="crmBatchAgent"');
    expect(crmSrc).toContain('id="crmBatchStage"');
    expect(crmSrc).toContain('data-crm-batch-espera');
    expect(crmSrc).toContain('data-crm-batch-csv');
    expect(crmSrc).toContain('data-crm-batch-clear');
    // Sin selección la barra se oculta (no queda flotando vacía).
    expect(crmSrc).toMatch(/if \(!n\) \{ bar\.style\.display = 'none'; bar\.innerHTML = ''; return; \}/);
    // En la papelera no hay barra (un lead borrado no se reasigna).
    expect(crmSrc).toContain("if (_showTrash) { _batchSel.clear(); bar.style.display = 'none'; bar.innerHTML = ''; return; }");
  });

  test('las escrituras son POR FILA (un fallo no aborta el lote)', () => {
    // El update de agente va con `.eq('id', id)`, NO con un `.in()` masivo.
    expect(crmSrc).toMatch(/update\(\{ assigned_to: nuevo \}\)\.eq\('id', id\)/);
    expect(crmSrc).toMatch(/update\(patch\)\.eq\('id', id\)/);
    // El helper aísla los errores y cuenta éxitos/fallos.
    expect(crmSrc).toContain('async function batchEach(ids, fn) {');
    expect(crmSrc).toContain('.catch(function (e) { return { ok: false, msg: (e && e.message) || String(e) }; });');
    expect(crmSrc).toContain('return { ok: ok, fail: fail, errores: errores };');
    // Y el reporte los muestra (nada de errores tragados).
    expect(crmSrc).toContain('function batchReport(titulo, res) {');
    expect(crmSrc).toContain("toast(msg, 'error');");
  });

  test('cambiar etapa en lote pide la razón de pérdida (igual que el panel)', () => {
    expect(crmSrc).toMatch(/if \(stage === 'cerrado_perdido'\) \{\s*lost = await showLostReasonModal\(\);/);
    // Si cancela el modal, no se toca nada.
    expect(crmSrc).toContain("if (!lost) return; /* canceló */");
    // Quien sale de "cerrado_perdido" pierde su razón (igual que el alta manual).
    expect(crmSrc).toContain("else if (stageById[id] === 'cerrado_perdido') patch.lost_reason = null;");
  });

  test('colgar en lote usa la RPC que suspende las tareas', () => {
    expect(crmSrc).toContain("db().rpc('lead_pasar_a_espera', { p_lead_id: id, p_hasta: hasta })");
    // Si la RPC devuelve error, el lote lo cuenta como fallo.
    expect(crmSrc).toContain('if (d.error) throw new Error(d.error);');
  });

  test('el CSV sale con BOM y sin inyección de fórmulas', () => {
    expect(crmSrc).toContain("var csv = '\\ufeff' + lines.join('\\r\\n');");
    expect(crmSrc).toContain("if (/^[=+\\-@\\t\\r]/.test(s)) s = \"'\" + s;");
    expect(crmSrc).toContain('a.download = \'leads-bienhaus-\'');
  });

  test('behavioral: csvSafe escapa y neutraliza fórmulas', () => {
    const from = crmSrc.indexOf('function csvSafe(v) {');
    const to = crmSrc.indexOf('async function batchExportCsv()');
    expect(from).toBeGreaterThan(-1);
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext(crmSrc.slice(from, to), sandbox);
    // Comillas dobles duplicadas (CSV estándar).
    expect(sandbox.csvSafe('Ana "Pérez"')).toBe('"Ana ""Pérez"""');
    // Coma y salto de línea van entre comillas.
    expect(sandbox.csvSafe('a,b')).toBe('"a,b"');
    // Fórmulas neutralizadas con apostilla.
    expect(sandbox.csvSafe('=1+1')).toBe('"\'=1+1"');
    expect(sandbox.csvSafe('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    // Un teléfono que empieza con "-" NO se toca (no es una fórmula).
    expect(sandbox.csvSafe('-3511234567')).toBe('"\'-3511234567"');
    // Vacíos y null.
    expect(sandbox.csvSafe(null)).toBe('""');
  });

  test('behavioral: batchEach aísla el fallo de un ítem', async () => {
    const from = crmSrc.indexOf('var BATCH_CHUNK = 5;');
    const to = crmSrc.indexOf('function batchSelectedIds()');
    expect(from).toBeGreaterThan(-1);
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext(crmSrc.slice(from, to), sandbox);
    const r = await sandbox.batchEach(['a', 'b', 'c'], async (id) => {
      if (id === 'b') throw new Error('sin permiso');
      return id;
    });
    expect(r.ok).toBe(2);
    expect(r.fail).toBe(1);
    expect(r.errores[0]).toContain('sin permiso');
  });

  test('CSS: la barra y los checkboxes tienen estilo', () => {
    expect(cssSrc).toContain('.crm-batch-bar');
    expect(cssSrc).toContain('.crm-batch-inner');
    expect(cssSrc).toContain('.crm-batch-btn');
    expect(cssSrc).toContain('.crm-row-check');
    expect(cssSrc).toContain('.crm-td-check');
  });
});
