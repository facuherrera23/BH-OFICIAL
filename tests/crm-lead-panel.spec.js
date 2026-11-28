// Guard de regresión: el panel lateral del lead tiene que ABRIR.
//
// CONTEXTO (bug real en producción, 2026-11-27):
//   El usuario reportó "Error al cargar prospecto: suggestHtml is not
//   defined" al abrir cualquier lead. La causa: el commit a4065e9 (tarjeta
//   de "siguiente mejor acción") reemplazó `var suggestHtml = '';` por dos
//   líneas nuevas y OLVIDÓ la declaración. admin-crm.js corre dentro de una
//   IIFE con 'use strict', así que la asignación sin `var` a un
//   identificador no declarado (y su lectura posterior) es un
//   ReferenceError en runtime → el panel NUNCA abría.
//
//   Lo que este guard atrapa (y los guards de texto NO):
//   · node --check sólo valida sintaxis: el archivo estaba sintácticamente
//     perfecto.
//   · Los tests estáticos buscaban strings: `suggestHtml` seguía apareciendo
//     en el archivo, sólo que sin declarar.
//   · El bug se Manifesto SÓLO cuando renderSide() corría de verdad.
//
// Este spec es CONDUCTUAL: corre el admin-crm.js REAL en Chromium contra
// un cliente Supabase falso (tests/helpers/crm-lead-panel-harness.html).
// No toca la base real ni producción.
//
// Además incluye un guard ESTÁTtico con el análisis real de scopes (acorn,
// el parser de V8) para barrer TODOS los assets/js y detectar la misma
// clase de bug (asignación a un identificador no declarado) antes de que
// llegue a producción.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HARNESS = '/tests/helpers/crm-lead-panel-harness.html';
const CRM = path.join(ROOT, 'assets', 'js', 'admin-crm.js');
const crmSrc = fs.readFileSync(CRM, 'utf8');

test.describe('CRM — el panel del lead abre (guard de ReferenceError)', () => {
  async function boot(page) {
    const errores = [];
    page.on('pageerror', (e) => errores.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text()); });
    await page.goto(HARNESS);
    await page.waitForFunction(() => window.__HARNESS_READY === true);
    await page.evaluate(() => { window.initCrm(); });
    return errores;
  }

  test('abrir un lead SIN coincidencias de propiedades renderiza el panel', async ({ page }) => {
    const errores = await boot(page);
    await page.evaluate(() => {
      window.BH_CRM.open('11111111-1111-1111-1111-111111111111');
    });
    // El panel tiene que dejar el estado "Cargando..." y mostrar el lead.
    await page.waitForFunction(() => {
      const p = document.getElementById('crmSidePanel');
      return !!p && p.innerHTML.indexOf('Lead Sin Sugerencias') !== -1;
    }, { timeout: 10000 });

    const estado = await page.evaluate(() => {
      const p = document.getElementById('crmSidePanel');
      return {
        abierto: p.classList.contains('open'),
        len: p.innerHTML.length,
        texto: p.textContent,
        toast: document.getElementById('toastText') ? document.getElementById('toastText').textContent : ''
      };
    });
    expect(estado.abierto).toBe(true);
    expect(estado.len).toBeGreaterThan(500);
    expect(estado.texto).toContain('Lead Sin Sugerencias');
    // El error del bug real: el toast de "Error al cargar prospecto".
    expect(estado.toast).not.toContain('Error al cargar prospecto');
    expect(estado.toast).not.toContain('is not defined');
    // Y ningún error de JS en la consola.
    expect(errores).toEqual([]);
  });

  test('abrir un lead CON coincidencias de propiedades renderiza las sugerencias', async ({ page }) => {
    const errores = await boot(page);
    await page.evaluate(() => {
      window.BH_CRM.open('22222222-2222-2222-2222-222222222222');
    });
    await page.waitForFunction(() => {
      const p = document.getElementById('crmSidePanel');
      return !!p && p.innerHTML.indexOf('Lead Con Sugerencias') !== -1;
    }, { timeout: 10000 });

    const estado = await page.evaluate(() => {
      const p = document.getElementById('crmSidePanel');
      return {
        len: p.innerHTML.length,
        texto: p.textContent,
        toast: document.getElementById('toastText') ? document.getElementById('toastText').textContent : ''
      };
    });
    expect(estado.len).toBeGreaterThan(500);
    expect(estado.texto).toContain('Lead Con Sugerencias');
    // La rama de sugerencias tiene que haber corrido (si no, el `var` de
    // suggestHtml no se está usando y el bug vuelve).
    expect(estado.texto).toContain('Propiedades Sugeridas');
    expect(estado.toast).not.toContain('is not defined');
    expect(errores).toEqual([]);
  });

  test('guard estático: todo identificador asignado está declarado en su scope', async () => {
    // Análisis real de scopes con acorn (el parser de V8, incluido en Node).
    // Detecta la clase de bug del 2026-11-27 en TODOS los assets/js, no sólo
    // en admin-crm.js. Se salta si el Node no expone acorn (--expose-internals).
    const script = path.join(__dirname, 'helpers', 'audit-undeclared.cjs');
    let salida;
    let stderr = '';
    try {
      const res = execFileSync(process.execPath, ['--expose-internals', script, path.join(ROOT, 'assets', 'js')], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      salida = res;
    } catch (e) {
      stderr = String(e.stderr || '');
      salida = String(e.stdout || '');
      if (stderr.includes('NO_ACORN')) {
        test.skip(true, 'este Node no expone acorn internamente: se omite el barrido');
        return;
      }
      if (!salida.trim()) throw e;
    }
    // El auditor escribe sólo el JSON en stdout (los avisos van a stderr).
    const json = salida.trim().slice(salida.indexOf('['));
    const hallazgos = JSON.parse(json);
    // 0 hallazgos esperados: cada línea es "archivo:linea:col ident".
    expect(hallazgos, 'identificadores asignados sin declarar (ReferenceError en strict mode):\n' +
      hallazgos.map((h) => h.archivo + ':' + h.linea + ' → ' + h.ident).join('\n') + '\n' + stderr)
      .toEqual([]);
  });

  test('guard estático: renderSide declara suggestHtml antes de usarlo', async () => {
    // Red de seguridad explícita para el caso exacto del bug: si alguien
    // vuelve a tocar renderSide(), la declaración de suggestHtml tiene que
    // seguir ahí (es la línea que se perdió en a4065e9) y tiene que estar
    // ANTES de la primera asignación.
    const bloque = crmSrc.slice(crmSrc.indexOf('function renderSide('));
    const fin = bloque.indexOf('\nfunction ');
    const fn = fin > 0 ? bloque.slice(0, fin) : bloque;

    const decl = fn.search(/\b(?:var|let|const)\s+suggestHtml\s*=/);
    expect(decl, 'renderSide tiene que declarar suggestHtml (var/let/const)').toBeGreaterThan(-1);

    const uso = fn.search(/\bsuggestHtml\s*=(?!=)/);
    expect(uso, 'la asignación a suggestHtml tiene que existir').toBeGreaterThan(-1);
    expect(decl, 'la declaración de suggestHtml tiene que preceder a su uso').toBeLessThan(uso);
  });
});
