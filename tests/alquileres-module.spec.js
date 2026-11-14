// Contrato del módulo "Administración de Alquileres" (2026-11-14).
// Guards ESTÁTICOS. No tocan la BD ni la red.
//
// POR QUÉ: el módulo es el HTML standalone del dueño portado al panel con
// backend Supabase. La clase de bug que rompió la PRIMERA integración fue
// sintáctica + estructural: un SyntaxError en assets/js/alquileres.js (el
// rewrite viejo) mataba el IIFE entero → al entrar al apartado no se veía
// NADA; un nav-item data-tab sin <section class="tab-module"> hacía que
// navigateTo desactivara TODAS las secciones (content-area en blanco).
// Estos guards matan esa clase de bug antes del deploy.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test.describe('módulo alquileres — archivos', () => {
  test('el rewrite roto assets/js/alquileres.js NO vuelve a existir', () => {
    // SyntaxError fatal (await en función no-async) que mataba todo el módulo.
    expect(fs.existsSync(path.join(ROOT, 'assets/js/alquileres.js'))).toBe(false);
  });

  test('core y controlador parsean (node --check)', () => {
    const { execFileSync } = require('child_process');
    for (const f of ['assets/js/alquileres-core.js', 'assets/js/alquileres-app.js']) {
      expect(() => execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }),
        `${f} debe ser JS sintácticamente válido`).not.toThrow();
    }
  });
});

test.describe('alquileres-core.js — core portado del standalone', () => {
  let core;
  test.beforeAll(() => { core = read('assets/js/alquileres-core.js'); });

  test('sin estado embebido: EMB=null y cero referencias a #datos', () => {
    expect(core).toContain('const EMB=null;');
    expect(core.includes("getElementById('datos')")).toBe(false);
    // El estado ya NO nace de localStorage legacy (adm/adm2): lo carga el controlador.
    expect(core.includes("localStorage.getItem('adm")).toBe(false);
  });

  test('expone bhInitS (el controlador normaliza el estado de la nube)', () => {
    expect(core).toContain('function bhInitS(s)');
    // normalizaciones mínimas: P() por prop + dAgua + hist/pagos presentes
    expect(core).toMatch(/function bhInitS\(s\)\{[\s\S]*?s\.props=s\.props\.map\(P\)/);
    expect(core).toMatch(/s\.corr\.dAgua=s\.corr\.dAgua\|\|10/);
    expect(core).toMatch(/if\(!s\.hist\)s\.hist=\{\}/);
    expect(core).toMatch(/if\(!s\.pagos\)s\.pagos=\{\}/);
  });

  test('save() dispara el hook de sincronización con la nube', () => {
    expect(core).toMatch(/DIRTY=j!==LAST;est\(\);if\(window\.__ALQ_SYNC\)window\.__ALQ_SYNC\(\)/);
    // guard anti-null: el boot puede correr sin S cargado todavía
    expect(core).toMatch(/const save=\(\)=>\{if\(!S\)return;/);
  });

  test('BUG FIX del dueño: retroceder mes restaura desde el historial', () => {
    // Antes: retroceso descartaba el mes cerrado (los datos desaparecían).
    expect(core).toContain('function prevMes()');
    expect(core).toContain('function restaurarMes(key)');
    // mesMas(d<0) debe consultar prevMes + restaurarMes
    const iMesMas = core.indexOf('function mesMas(d){');
    expect(iMesMas).toBeGreaterThan(-1);
    const bloque = core.slice(iMesMas, iMesMas + 1200);
    expect(bloque).toMatch(/if\(d<0\)\{[\s\S]*?prevMes\(\)[\s\S]*?restaurarMes\(pk\)/);
    // la restauración mapea docs del historial → props: orden (alquiler+servicios) y cuenta (saldo)
    const iRest = core.indexOf('function restaurarMes(key)');
    const rBloque = core.slice(iRest, iRest + 1600);
    expect(rBloque).toMatch(/d\.k=='o'/);
    expect(rBloque).toMatch(/d\.k=='c'/);
    expect(rBloque).toMatch(/p\.alq=/);
    expect(rBloque).toMatch(/p\.saldoAnt=/);
  });

  test('boot final: render sólo si hay S cargado (sin blanco ni crash)', () => {
    expect(core).toContain('hh();if(S){render();tot();est();restaurarAdj()}');
  });
});

test.describe('alquileres-app.js — controlador Supabase', () => {
  let app, core;
  test.beforeAll(() => {
    app = read('assets/js/alquileres-app.js');
    core = read('assets/js/alquileres-core.js');
  });

  test('TOP-LEVEL sin IIFE (comparte scope léxico con el core)', () => {
    expect(app.includes("(function ()")).toBe(false);
    expect(app.includes("(() => {")).toBe(false);
  });

  test('NO redeclara constantes/lets del core (SyntaxError en carga)', () => {
    // function declarations re-declarables a propósito (la última gana):
    const permitidas = new Set(['est', 'guardarArchivo']);
    // Top-level REAL del app = column 0 (lo local dentro de funciones va indentado).
    const re = /^(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/gm;
    const reCore = /(?:^|;|\n)\s*(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/g;
    const delCore = new Set();
    let m;
    while ((m = reCore.exec(core))) delCore.add(m[1]);
    const clash = [];
    while ((m = re.exec(app))) {
      if (delCore.has(m[1]) && !permitidas.has(m[1])) clash.push(m[1]);
    }
    expect(clash, `no redeclarar nombres del core (rompe la carga): ${clash.join(', ')}`).toEqual([]);
  });

  test('core + app compilan juntos sin conflicto de redeclaración (vm)', () => {
    // Prueba REAL del modo de fallo del navegador: dos classic scripts en el
    // mismo entorno global. El conflicto (GlobalDeclarationInstantiation) se
    // tira ANTES de ejecutar cualquier statement — los errores posteriores
    // (ReferenceError por stubs de DOM) son esperables y no cuentan.
    const vm = require('vm');
    const ctx = vm.createContext({
      window: {}, document: {}, localStorage: {}, console: { error() {}, log() {}, warn() {} }, navigator: {},
    });
    try { new vm.Script(core).runInContext(ctx); } catch (_) { /* stubs: esperable */ }
    let err = null;
    try { new vm.Script(app).runInContext(ctx); } catch (e) { err = e; }
    if (err) {
      expect(err.message, 'el controlador re-declara algo del core (rompe la carga real)').not.toMatch(/already been declared/);
    }
  });

  test('carga el estado del USUARIO autenticado (RLS user_id = auth.uid())', () => {
    expect(app).toMatch(/from\('alquileres_state'\)[\s\S]{0,120}maybeSingle\(\)/);
    expect(app).toMatch(/\.eq\('user_id',\s*user\.id\)/);
    // sin sesión → gate, nunca una vista vacía
    expect(app).toMatch(/if \(!user\) \{ gateShow\(\); return; \}/);
  });

  test('upsert persiste en la nube con skip si nada cambió', () => {
    expect(app).toMatch(/\.upsert\(\{ user_id: alqUser\.id, state:/);
    expect(app).toContain('onConflict: \'user_id\'');
    expect(app).toContain('if (snap === LAST && !saveError) { est(); return; }');
    expect(app).toContain('window.__ALQ_SYNC = () => scheduleSave(1200);');
  });

  test('guardarArchivo pisa la versión del core (el botón 💾 guarda en la nube)', () => {
    expect(app).toMatch(/function guardarArchivo\(\) \{[\s\S]*?syncNow\(\)/);
  });

  test('estado ilegible/corrupto en la DB NO deja la página en blanco', () => {
    expect(app).toMatch(/catch \(e\) \{[\s\S]{0,200}S = null;/);
    // y el fallback arranca vacío con bhInitS
    expect(app).toMatch(/if \(!S\) \{[\s\S]{0,900}bhInitS\(S\);/);
  });

  test('flush al ocultar la pestaña (no se pierden cambios)', () => {
    expect(app).toMatch(/visibilitychange[\s\S]{0,300}syncNow\(\)/);
  });
});

test.describe('alquileres.html — página standalone', () => {
  let html;
  test.beforeAll(() => { html = read('alquileres.html'); });

  test('sin el JSON de 12MB embebido ni el script inline de 187KB', () => {
    expect(html.includes('id="datos"')).toBe(false);
    expect(html.length, 'la página debe quedar liviana (< 60KB)').toBeLessThan(60000);
  });

  test('CSP propia con las excepciones que necesita el core', () => {
    expect(html).toMatch(/Content-Security-Policy[^>]*worker-src[^>]*blob:/);
    expect(html).toMatch(/frame-src[^>]*blob:/);
    expect(html).toMatch(/connect-src[^>]*https:\/\/\*\.supabase\.co/);
    // pdf.js y ExcelJS se inyectan dinámicamente desde cdnjs
    expect(html).toMatch(/script-src[^>]*https:\/\/cdnjs\.cloudflare\.com/);
  });

  test('orden de scripts: vendor → config → cliente → core → controlador', () => {
    const refs = ['assets/vendor/supabase-js.umd.js', 'assets/js/config.js', 'assets/js/supabase-client.js', 'assets/js/alquileres-core.js', 'assets/js/alquileres-app.js']
      .map((r) => html.indexOf(r));
    refs.forEach((i, k) => expect(i, `debe referenciar ${refs[k]}`).toBeGreaterThan(-1));
    const ordenado = [...refs].every((v, i) => i === 0 || v > refs[i - 1]);
    expect(ordenado, 'el orden de carga es una dependencia real (defer)').toBe(true);
  });

  test('gate de login y placeholder de conexión presentes', () => {
    expect(html).toContain('id="alqGate"');
    expect(html).toContain('id="alqGateForm"');
    expect(html).toContain('Conectando con la base de datos');
  });
});

test.describe('integración con el panel admin', () => {
  test('navigateTo intercepta tab-alquileres → página propia (sin blank)', () => {
    const app = read('assets/js/admin-app.js');
    const i = app.indexOf("function navigateTo(section, opts) {");
    expect(i, 'debe existir navigateTo').toBeGreaterThan(-1);
    const bloque = app.slice(i, i + 1200);
    expect(bloque).toMatch(/if \(section === 'tab-alquileres'\) \{ window\.location\.href = 'alquileres\.html'; return; \}/);
  });

  test('admin.html conserva el nav-item de Alquileres', () => {
    const html = read('admin.html');
    expect(html).toContain('data-tab="tab-alquileres"');
    // y NO existe una <section> fantasma para ese tab (por eso el interceptor)
    expect(html.includes('id="tab-alquileres"')).toBe(false);
  });

  test('los HTML del root referencian la versión bumped de admin-app.js', () => {
    const html = read('admin.html');
    expect(html).toMatch(/assets\/js\/admin-app\.js\?v=\d+/);
  });
});

test.describe('migraciones SQL', () => {
  test('esquema: RLS + policy acotada a authenticated + revoke a anon', () => {
    const sql = read('supabase/migrations/20261114000001_alquileres_state.sql');
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/to authenticated[\s\S]*?using \(user_id = auth\.uid\(\)\)/i);
    expect(sql).toMatch(/revoke all on public\.alquileres_state from anon/i);
  });

  test('policy optimizada: auth.uid() envuelto en (select …)', () => {
    // Fix advisor auth_rls_initplan — sin él, el advisor de performance no vuelve a baseline.
    const sql = read('supabase/migrations/20261114000003_alquileres_state_policy_select.sql');
    expect(sql).toMatch(/using \(user_id = \(select auth\.uid\(\)\)\)/i);
    expect(sql).toMatch(/with check \(user_id = \(select auth\.uid\(\)\)\)/i);
  });

  test('seed: lookup por email, idempotente y sin adjuntos', () => {
    const sql = read('supabase/migrations/20261114000002_alquileres_state_seed.sql');
    expect(sql).toMatch(/from auth\.users u\s*where u\.email = 'danilo\.arbo@gmail\.com'/i);
    expect(sql).toMatch(/on conflict \(user_id\) do nothing/i);
    // Los adjuntos (12MB) NO viajan en el estado: se restauran importando el archivo original.
    expect(sql.length, 'el seed sólo debe traer S (state), no los adjuntos').toBeLessThan(120000);
    expect(sql).not.toMatch(/\bdata:image\//);
  });
});
