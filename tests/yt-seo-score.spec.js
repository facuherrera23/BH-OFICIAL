// Motor de Score SEO para YouTube (vidIQ-style) — contratos:
// 1. La suma de los puntos de los checks ES el score (invariante fundamental).
// 2. Formulario vacío → 0. Ejemplo ideal → ≥85 ("Excelente").
// 3. Heurísticas anti-armadura: caps-spam, tags >480 chars, keyword derivada del título.
// 4. render() monta el panel: gauge, checklist, chips (click quita) y sugeridos (click agrega),
//    con el patrón real: onTagsChange → el caller actualiza el input → re-render.
// El motor se prueba como se consume: código cargado en la página vía script tag
// del mismo asset que sirve el http.server de los tests.
const { test, expect } = require('@playwright/test');

const ENGINE_URL = '/assets/js/yt-seo-score.js';

async function loadEngine(page, request) {
  const res = await request.get(ENGINE_URL);
  expect(res.ok()).toBeTruthy(); // el asset viaja al deploy (path correcto)
  const src = await res.text();
  expect(src).toContain('BH_YT_SEO');
  await page.setContent(
    '<div id="panel"></div><div id="panelEmpty"></div><div id="out" data-tags=""></div>',
  );
  await page.addScriptTag({ content: src });
  expect(await page.evaluate(() => typeof window.BH_YT_SEO.calc)).toBe('function');
  expect(await page.evaluate(() => typeof window.BH_YT_SEO.render)).toBe('function');
}

test('calc: invariante suma=score, vacío→0, ideal→≥85, heurísticas claves', async ({ page, request }) => {
  await loadEngine(page, request);
  const out = await page.evaluate(() => {
    const W = window.BH_YT_SEO;
    const sum = (r) => r.checks.reduce((a, c) => a + c.points, 0);
    const emptyR = W.calc({});
    // Desc ideal: keyword en primeras 150 chars, 170 palabras, link, hook y 3 hashtags
    const desc = 'Inmobiliaria Córdoba: recorrida de casas en Nueva Córdoba\n'
      + Array.from({ length: 170 }, (_, i) => 'palabra' + (i % 40)).join(' ')
      + '\n\nMás info: https://bienenhaus.com.ar\n#inmobiliariacordoba #casas #nuevacordoba';
    const tags = [
      'inmobiliaria córdoba', 'casas en venta', 'nueva córdoba', 'villa allende',
      'la calera', 'alquileres', 'deptos', 'lotes', 'inversión', 'tour 360',
      'bienenhaus', 'propiedades',
    ].join(', ');
    const idealR = W.calc({
      title: 'Inmobiliaria Córdoba: recorrida por casas en venta',
      description: desc, tags: tags, keyword: 'inmobiliaria córdoba',
    });
    const capsR = W.calc({
      title: 'MIRA ESTE DEPARTAMENTO INCREIBLE EN NUEVA CORDOBA',
      description: 'x', tags: 'a,b',
    });
    const derivedR = W.calc({ title: 'Tour virtual: casa 3 dormitorios' });
    const overR = W.calc({
      title: 'Título de prueba razonable para tags gigantes',
      description: 'desc',
      tags: Array(30).fill('etiqueta-larga-para-probar-el-limite-de-caracteres-de-tags-en-youtube').join(','),
    });
    const find = (r, id) => r.checks.find((c) => c.id === id);
    return {
      weights: Object.values(W.WEIGHTS).reduce((a, b) => a + b, 0),
      emptyScore: emptyR.score, emptyFlag: emptyR.empty, emptyInvariant: sum(emptyR) === 0,
      idealScore: idealR.score, idealLabel: idealR.label,
      idealInvariant: sum(idealR) === idealR.score, idealChecks: idealR.checks.length,
      capsPts: capsR.checks.find((c) => c.id === 'titleCaps').points,
      derivedKw: derivedR.keyword, derivedFlag: derivedR.keywordDerived,
      over480: find(overR, 'tags480').points, overDupes: find(overR, 'tagsDupes').points,
    };
  });
  expect(out.weights).toBe(100);
  expect(out.emptyScore).toBe(0);
  expect(out.emptyFlag).toBe(true);
  expect(out.emptyInvariant).toBe(true);
  expect(out.idealScore).toBeGreaterThanOrEqual(85);
  expect(out.idealScore).toBeLessThanOrEqual(100);
  expect(out.idealInvariant).toBe(true);
  expect(out.idealChecks).toBe(12);
  expect(out.capsPts).toBeLessThan(5);
  expect(out.derivedKw).toBe('tour virtual');
  expect(out.derivedFlag).toBe(true);
  expect(out.over480).toBeLessThan(5);
});

test('render: gauge, checklist y ciclo interactivo chips/sugeridos con re-render del caller', async ({ page, request }) => {
  await loadEngine(page, request);
  await page.evaluate(() => {
    window.__LAST = null;
    window.__renderPanel = (tagsVal) => {
      window.BH_YT_SEO.render(document.getElementById('panel'), {
        title: 'Inmobiliaria Córdoba: recorrida por casas en venta',
        description: 'Recorrida por las casas en venta de Nueva Córdoba con contactos y precio.',
        tags: tagsVal,
        keyword: 'inmobiliaria córdoba',
        channelName: 'Bienenhaus',
        onTagsChange: (t) => { window.__LAST = t; window.__renderPanel(t); }, // patrón real del panel
      });
    };
    window.__renderPanel('inmobiliaria córdoba, casas');
  });
  await expect(page.locator('#panel svg')).toHaveCount(1);
  await expect(page.locator('#panel .yts-check')).toHaveCount(12);
  await expect(page.locator('#panel .yts-chip')).toHaveCount(2);
  // quitar el primer chip (inmobiliaria córdoba) → queda 'casas' + re-render
  await page.click('#panel .yts-chip[data-yts-chip="0"]');
  expect(await page.evaluate(() => window.__LAST)).toBe('casas');
  await expect(page.locator('#panel .yts-chip')).toHaveCount(1);
  // sugerido del nicho → click agrega al input real (onTagsChange) con re-render
  const firstPreset = await page.locator('#panel .yts-preset').first().getAttribute('data-yts-preset');
  await page.click('#panel .yts-preset >> nth=0');
  expect(await page.evaluate(() => window.__LAST)).toBe('casas, ' + firstPreset);
  await expect(page.locator('#panel .yts-chip')).toHaveCount(2);
  // el preset recién agregado desaparece de la lista de sugeridos (sin repetidos)
  const presetTexts = await page.locator('#panel .yts-preset').allTextContents();
  expect(presetTexts.some((t) => t.toLowerCase().includes(String(firstPreset).toLowerCase()))).toBe(false);
});

test('render: estado vacío — gauge en 0, sin checklist y mensaje de onboarding', async ({ page, request }) => {
  await loadEngine(page, request);
  await page.evaluate(() => {
    window.BH_YT_SEO.render(document.getElementById('panelEmpty'), {});
  });
  await expect(page.locator('#panelEmpty svg')).toHaveCount(1);
  await expect(page.locator('#panelEmpty .yts-check')).toHaveCount(0);
  await expect(page.locator('#panelEmpty')).toContainText('Completá título, descripción y tags');
});
