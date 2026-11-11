// Orígenes de lead — guard de las 4 listas del admin (2026-11-06).
//
// POR QUÉ ESTE GUARD: `leads.source` es TEXT libre (sin enum ni CHECK), así
// que agregar un origen NO requiere migración. Pero el admin tiene 4 listas
// de orígenes en 3 archivos y si NO coinciden el alta de lead falla con
// "Origen inválido" (el Zod de LeadSchema es el que manda):
//
//   1) assets/js/admin-crm.js  → ORIGINS + ORIGIN_LABELS (panel lateral + filtro)
//   2) admin.html               → <select name="source"> (alta de lead)
//   3) assets/js/admin-app.js   → z.enum de LeadSchema (valida el alta)
//   4) assets/js/admin-app.js   → SOURCE_LBL (dashboard "conversión por fuente")
//
// ORIGEN DE ESTE GUARD: el empleador preguntó por qué en el dropdown "Origen"
// no aparecían "Clasificados La Voz" ni "ZonaProp" (y si eso sería Walk-In).
// La respuesta: había que agregarlos + cada portal lleva su propio origen.
// Walk-In NO es un portal: es "Visita en persona".
//
// Guard estático: lee el repo, NO toca la BD ni la red.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const crmSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-crm.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

/* ── extractores ─────────────────────────────────────────────────────── */

function quotedList(src, re) {
  const m = src.match(re);
  if (!m) throw new Error(`No se encontró el patrón ${re}`);
  return (m[1].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''));
}

function labelMap(src, re) {
  const m = src.match(re);
  if (!m) throw new Error(`No se encontró el patrón ${re}`);
  const map = {};
  const rePair = /([A-Za-z0-9_]+)\s*:\s*'([^']*)'/g;
  let p;
  while ((p = rePair.exec(m[1])) !== null) map[p[1]] = p[2];
  return map;
}

/* 1) admin-crm.js */
const ORIGINS = quotedList(crmSrc, /var ORIGINS = \[([^\]]+)\]/);
const ORIGIN_LABELS = labelMap(crmSrc, /var ORIGIN_LABELS = \{([^}]+)\}/);

/* 2) admin.html — select del alta */
const selectBlock = (htmlSrc.match(/<select name="source">([\s\S]*?)<\/select>/) || [])[1] || '';
const HTML_OPTS = (selectBlock.match(/<option value="([^"]+)">([^<]*)<\/option>/g) || []).map(o => {
  const m = o.match(/value="([^"]+)">([^<]*)</);
  return { value: m[1], label: m[2] };
});
const HTML_VALUES = HTML_OPTS.map(o => o.value);
const HTML_LABELS = Object.fromEntries(HTML_OPTS.map(o => [o.value, o.label]));

/* 3+4) admin-app.js */
const ZOD_VALUES = quotedList(appSrc, /source:\s*z\.enum\(\[([^\]]+)\]\)/);
const SOURCE_LBL = labelMap(appSrc, /const SOURCE_LBL = \{([^}]+)\}/);

const sorted = a => [...a].sort();
const setsEqual = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

test.describe('Orígenes de lead — listas sincronizadas', () => {
  test('las 4 listas tienen EXACTAMENTE los mismos orígenes', () => {
    expect(ORIGINS.length).toBeGreaterThan(0);
    expect(setsEqual(ORIGINS, HTML_VALUES)).toBe(true);
    expect(setsEqual(ORIGINS, ZOD_VALUES)).toBe(true);
    expect(setsEqual(ORIGINS, Object.keys(ORIGIN_LABELS))).toBe(true);
    expect(setsEqual(ORIGINS, Object.keys(SOURCE_LBL))).toBe(true);
    // Sin repetidos en ORIGINS (si se repite, el select duplica la opción).
    expect(ORIGINS.length).toBe(new Set(ORIGINS).size);
  });

  test('ZonaProp y La Voz están como orígenes propios (no "Walk-In")', () => {
    expect(ORIGINS).toContain('rela_zonaprop');
    expect(ORIGINS).toContain('lavoz');
    expect(ORIGIN_LABELS.rela_zonaprop).toMatch(/ZonaProp/i);
    expect(ORIGIN_LABELS.lavoz).toMatch(/La Voz/i);
    // Walk-In es "visita en persona", NO un portal.
    expect(ORIGIN_LABELS.walkin).toMatch(/visita en persona/i);
  });

  test('etiquetas: iguales en los 3 mapas y sin duplicados', () => {
    for (const o of ORIGINS) {
      expect(ORIGIN_LABELS[o], `sin etiqueta en ORIGIN_LABELS: ${o}`).toBeTruthy();
      expect(HTML_LABELS[o], `sin etiqueta en el select de admin.html: ${o}`).toBeTruthy();
      expect(SOURCE_LBL[o], `sin etiqueta en SOURCE_LBL: ${o}`).toBeTruthy();
      expect(HTML_LABELS[o]).toBe(ORIGIN_LABELS[o]);
      expect(SOURCE_LBL[o]).toBe(ORIGIN_LABELS[o]);
    }
    // Una etiqueta repetida = dropdown ambiguo (bug: landing y landing_page
    // ambos "Landing" confundían al usuario).
    const labels = ORIGINS.map(o => ORIGIN_LABELS[o]);
    expect(labels.length).toBe(new Set(labels).size);
  });

  test('los orígenes que el panel lateral ofrece también están en el alta', () => {
    // El panel lateral (admin-crm.js) guarda SIN Zod; el alta (admin.html)
    // valida CON Zod. Si un origen sólo estuviera en el CRM, el alta lo
    // rechazaría → los 4 conjuntos tienen que ser el mismo (test anterior).
    const soloCrm = sorted(ORIGINS).filter(o => !ZOD_VALUES.includes(o));
    expect(soloCrm).toEqual([]);
  });

  test('los 4 canales de redes tienen su propio origen (2026-11-11)', () => {
    // Captación de leads desde redes: cada canal lleva su origen para
    // poder medir su performance (misma lógica que ml/lavoz/rela).
    const esperados = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };
    for (const [o, label] of Object.entries(esperados)) {
      expect(ORIGINS).toContain(o);
      expect(ORIGIN_LABELS[o]).toBe(label);
    }
    // gvamax existe en producción (1 lead) — sin label mostraba la clave cruda.
    expect(ORIGINS).toContain('gvamax');
    // El lead de YouTube se crea con source 'youtube' (no 'youtube_comment').
    const ytComments = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'social-youtube-comments', 'index.ts'), 'utf8');
    expect(ytComments).not.toMatch(/source:\s*'youtube_comment'/);
    expect(ytComments).toMatch(/source:\s*'youtube'/);
  });
});
