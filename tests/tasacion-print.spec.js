// Informe PDF paginado de Tasaciones (ACM) — contrato del dueño 2026-11-17:
// 3 comparables = 7 hojas (portada · cliente+inmueble+foto · descripción+servicios ·
// características+barrio+plano · 3 comparables · análisis+valuación+observaciones+marketing
// COMPLETO · contraportada). Guards ESTÁTICOS (sin BD ni red): el layout fino de
// impresión se verificó con Chromium print emulation (A4 = 794×1122.5px @96dpi).
// Clase de bug que mata esto: reglas print pisadas por orden de cascade
// (Compactación pisando el padding de paginación) y estilos inline pisando el CSS.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Normaliza CRLF→LF: los expects multi-línea no deben depender del line ending.
const html = fs.readFileSync(path.join(ROOT, 'tasacion.html'), 'utf8').replace(/\r\n/g, '\n');
const pageSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'pages', 'tasacion-page.js'), 'utf8').replace(/\r\n/g, '\n');

// Extrae el bloque @media print para aislar las reglas de impresión del resto.
// Balance de llaves (los comentarios /* */ no contienen llaves en este bloque).
const printStart = html.indexOf('@media print{');
if (printStart === -1) throw new Error('No se encontró @media print{ en tasacion.html');
let depth = 0, printEnd = -1, inComment = false;
for (let i = printStart + '@media print'.length; i < html.length; i++) {
  const ch = html[i];
  if (inComment) { if (ch === '*' && html[i + 1] === '/') { inComment = false; i++; } continue; }
  if (ch === '/' && html[i + 1] === '*') { inComment = true; i++; continue; }
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth === 0) { printEnd = i; break; } }
}
if (printEnd === -1) throw new Error('@media print sin cerrar en tasacion.html');
const PRINT = html.slice(printStart, printEnd + 1);

test.describe('tasación PDF paginado — estáticos', () => {
  test('@page margin 0 (sin leyendas de Chrome) y inset en main en mm', () => {
    expect(html).toContain('@page{ size: A4; margin: 0; }');
    // El padding de main es el ÚNICO inset del contenido (margin 0 de @page).
    expect(PRINT).toContain('main{max-width:100%; padding:10mm 13mm 8mm;}');
    // Bug A (2026-11-17): el bloque "Compactación" pisaba el padding con px.
    // Si reaparece un main{padding en el print CSS después de la paginación, vuelve el bug.
    expect(PRINT).not.toMatch(/main\{padding:\d+px/);
  });

  test('grupos de página: breaks y centrado (h2-h4, comparables, análisis)', () => {
    expect(PRINT).toContain('#printGroupCliente{break-before:page; page-break-before:always;}');
    expect(PRINT).toContain('#printGroupPropiedad{break-before:page; page-break-before:always; break-after:page; page-break-after:always;}');
    expect(PRINT).toContain('#printGroupBarrio{break-before:page; page-break-before:always;}');
    expect(PRINT).toMatch(/#sectionComparables,\s*#sectionAnalisisComparativo\{break-before:page; page-break-before:always;\}/);
    // Centrado vertical de las hojas de grupo (min-height A4 menos colchón)
    expect(PRINT).toMatch(/#printGroupCliente,\s*\n\s*#printGroupPropiedad,\s*\n\s*#printGroupBarrio\{min-height:289mm; display:flex; flex-direction:column; justify-content:center/);
    // Hoja 5: los 3 comparables repartidos a página completa
    expect(PRINT).toContain('#sectionComparables{min-height:289mm; display:flex; flex-direction:column;}');
    expect(PRINT).toContain('#comparablesContainer{display:flex; flex-direction:column; justify-content:space-evenly; flex:1; min-height:0;}');
    expect(PRINT).toContain('.comp-block.print-page-break{break-before:page; page-break-before:always;}');
  });

  test('h6 (.page-six): densidad acotada — las 4 cards llevan la clase', () => {
    // Las 4 cards de la hoja 6 están marcadas (el selector .page-six no toca las hojas 2-5)
    expect(html).toContain('<section class="card page-six" id="sectionAnalisisComparativo">');
    expect(html).toMatch(/<!-- =+ VALUACIÓN =+ -->\s*<section class="card page-six">/);
    expect(html).toContain('<section class="card page-six" id="sectionObservaciones">');
    expect(html).toMatch(/<!-- =+ PLAN DE MARKETING \(texto fijo\) =+ -->\s*<section class="card page-six">/);
    // Recortes que hacen entrar la cadena (medida real: 1103px < 1122.5px de hoja)
    expect(PRINT).toContain('.page-six{padding:10px 12px; margin-bottom:4px;}');
    expect(PRINT).toContain('.page-six .ac-chart-wrap{height:88px; padding:4px; margin-top:4px;}');
    expect(PRINT).toMatch(/\.page-six \.marketing-text\{font-size:10\.5px; line-height:1\.2; margin-bottom:1\.5px;\}/);
    // Observaciones/Marketing jamás partidos a mitad
    expect(PRINT).toMatch(/#sectionObservaciones,\s*\n\s*section\.card:has\(\.marketing-text\)\{break-inside:avoid; page-break-inside:avoid;\}/);
  });

  test('fotos más grandes: fachada hoja 2 y comparables hoja 5', () => {
    expect(PRINT).toContain('.photo-box{max-width:700px; margin-bottom:0; break-inside:avoid; page-break-inside:avoid;}');
    expect(PRINT).toContain('.photo-box img{max-height:520px; width:100%; object-fit:cover;}');
    expect(PRINT).toContain('.comp-block .photo-box{float:right; max-width:200px; aspect-ratio:16/7; margin:2px 0 4px 10px; min-height:0;}');
    expect(PRINT).toContain('.comp-block{padding:12px 14px; margin-bottom:8px;}');
  });

  test('portada: logo grande invertido, página completa', () => {
    expect(PRINT).toContain('min-height:290mm;');
    expect(PRINT).toMatch(/\.print-hero img\{[^}]*height:250px;/);
    // El logo es line-art blanco: invert lo vuelve trazo negro legible hasta
    // que el dueño aporte el logo definitivo (Drive sin acceso para el agente).
    expect(PRINT).toMatch(/\.print-hero img\{[^}]*filter:invert\(1\);/);
  });

  test('contraportada h7: logo centrado + legal al pie — SIN inline style en el img', () => {
    expect(PRINT).toMatch(/\.brand-footer\{break-before:page;[^}]*min-height:270mm; display:flex; align-items:center; justify-content:center/);
    expect(PRINT).toMatch(/\.brand-footer img\{height:150px;[^}]*filter:invert\(1\);\}/);
    // Bug B (2026-11-17): el img del footer tenía style="height:60px" inline que
    // ganaba a la regla print → logo enano. El HTML ya no lleva inline style.
    expect(html).toMatch(/<footer class="brand-footer">\s*<img src="assets\/img\/logo-bh\.png" alt="Bienenhaus">\s*<\/footer>/);
    expect(html).not.toMatch(/<img[^>]*logo-bh\.png[^>]*style=/);
    // El legal comparte la hoja 7 al pie
    expect(html).toContain('<footer class="legal-footer"');
    expect(PRINT).toMatch(/\.legal-footer\{margin:0 !important; padding:0 20mm 12mm !important; border-top:none !important;\}/);
  });

  test('gráfico imprime lleno (animation off en print) + título limpio durante la impresión', () => {
    expect(pageSrc).toContain('animation: _acForPrint ? false : undefined,');
    expect(pageSrc).toContain('let _printTitlePrev = null;');
    expect(pageSrc).toContain("document.title = 'Bienenhaus Propiedades — Análisis Comparativo de Mercado';");
    // Se restaura al salir (después de afterprint, antes de re-render)
    const after = pageSrc.indexOf("window.addEventListener('afterprint'");
    const restore = pageSrc.indexOf('if (_printTitlePrev !== null) document.title = _printTitlePrev;');
    const rerender = pageSrc.indexOf('renderAnalisisComparativo(false);', after);
    expect(after).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(after);
    expect(rerender).toBeGreaterThan(restore);
  });
});
