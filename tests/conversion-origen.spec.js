// CONVERSIÓN POR ORIGEN (2026-11-26): el tablero que antes vivía sólo en el
// digest semanal. RPC conversion_por_origen(p_dias) + overlay en el CRM.
//
// Verificado en vivo (26/11/2026): 30 días → 6 orígenes; clamp de días
// CORRECTO (9999 → 365, 0 → 1 — la inversa era el bug de bh_web_metrics que
// ignoraba el parámetro); tasas reales: RELA 69% vs ML 21.7% vs GVAmax 6.1%.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const mig = read('supabase/migrations/20261126000014_conversion_por_origen.sql');
const crmSrc = read('assets/js/admin-crm.js');
const htmlSrc = read('admin.html');

test.describe('Tablero de conversión por origen', () => {
  test('RPC: clamp de días en el ORDEN correcto y contadores con FILTER', () => {
    expect(mig).toContain('CREATE OR REPLACE FUNCTION public.conversion_por_origen(p_dias integer DEFAULT 90)');
    expect(mig).toContain("SET search_path = ''");
    // El clamp: mínimo 1, máximo 365 (GREATEST envuelto por fuera).
    expect(mig).toContain('GREATEST(LEAST(COALESCE(p_dias, 90), 365), 1)');
    // El FROM del agregado NO filtra por stage (los contadores van con FILTER):
    // la regla derivada del bug de bh_web_metrics v1 (contadores siempre 0).
    expect(mig).toContain("count(*) FILTER (WHERE stage NOT IN ('cerrado_ganado', 'cerrado_perdido')) AS vivos");
    expect(mig).toContain("count(*) FILTER (WHERE stage = 'cerrado_perdido') AS perdidos");
    expect(mig).toContain("count(*) FILTER (WHERE stage = 'cerrado_ganado') AS ganados");
    // La tasa se calcula en SQL (supervivencia dentro de la ventana).
    expect(mig).toContain('round(100.0 * s.vivos / s.n, 1)');
    // Aditiva.
    expect(mig).not.toMatch(/DELETE\s+FROM/i);
    expect(mig).not.toMatch(/UPDATE\s+public\./i);
    expect(mig).toContain('REVOKE ALL ON FUNCTION public.conversion_por_origen(integer) FROM PUBLIC, anon;');
    expect(mig).toContain('GRANT EXECUTE ON FUNCTION public.conversion_por_origen(integer) TO authenticated, service_role;');
  });

  test('el CRM tiene el botón Conversión con toggle 7/30/90', () => {
    expect(htmlSrc).toContain('id="crmConversionBtn"');
    expect(crmSrc).toContain('async function openConversion(dias) {');
    expect(crmSrc).toContain("db().rpc('conversion_por_origen', { p_dias: _convDias })");
    // El toggle se genera con [7, 30, 90] (los tres rangos, en el HTML real).
    expect(crmSrc).toContain('[7, 30, 90].map(function (d) {');
    expect(crmSrc).toContain(`data-conv-dias="' + d + '"`);
    // Sin onclick inline (CSP) y con re-apertura al cambiar el rango.
    expect(crmSrc).toContain("convBtn.addEventListener('click', function () { openConversion(); });");
    expect(crmSrc).toContain('openConversion: openConversion');
    expect(crmSrc).toMatch(/var d = e\.target\.closest\('\[data-conv-dias\]'\);\s*\n\s*if \(d\) openConversion\(d\.getAttribute\('data-conv-dias'\)\);/);
  });

  test('behavioral: el render pinta la tasa con el color por umbral', () => {
    const from = crmSrc.indexOf('var filasHtml = filas.map(function (f) {');
    const to = crmSrc.indexOf("}).join('');", from) + "}).join('');".length;
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const sandbox = {
      esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      ORIGIN_LABELS: { ml: 'Mercado Libre', rela_zonaprop: 'ZonaProp (RELA)', sin_origen: 'sin origen' },
      fmtDate: (d) => 'fecha ' + String(d),
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext('var filasHtml = function (rows) { var filas = rows || []; ' + crmSrc.slice(from, to) + ' return filasHtml; };', sandbox);
    const html = sandbox.filasHtml([
      { source: 'rela_zonaprop', total: 29, vivos: 20, perdidos: 8, ganados: 0, tasa: 69, primero: '2026-11-04', ultimo: '2026-11-25' },
      { source: 'ml', total: 46, vivos: 10, perdidos: 36, ganados: 0, tasa: 21.7, primero: '2026-09-01', ultimo: '2026-11-26' },
      { source: 'gvamax', total: 33, vivos: 2, perdidos: 31, ganados: 0, tasa: 6.1, primero: '2026-08-24', ultimo: '2026-09-24' },
    ]);
    // Etiquetas legibles de origen (no la clave cruda).
    expect(html).toContain('ZonaProp (RELA)');
    expect(html).toContain('Mercado Libre');
    // Verde ≥50, ámbar ≥20, rojo <20.
    expect(html).toContain('#4ade80');
    expect(html).toContain('#FFB800');
    expect(html).toContain('#f87171');
    // Escapado: un origen inventado con HTML no inyecta.
    const malo = sandbox.filasHtml([{ source: '<script>x</script>', total: 1, vivos: 1, perdidos: 0, ganados: 0, tasa: 100, primero: 'a', ultimo: 'b' }]);
    expect(malo).not.toContain('<script>');
  });
});
