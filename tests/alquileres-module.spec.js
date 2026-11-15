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

  test('Bloque 1.B: mesMas(>0) dispara el snapshot con el mes que SE CIERRA', () => {
    // El hook corre con S.m/S.y del mes que se cierra y S.hist ya actualizado
    // (docsMes), pero ANTES de blanquear servicios y avanzar: la copia es
    // exactamente "la administración como estaba al cerrar X". Guardado por
    // el controlador (window.__ALQ_SNAPSHOT), best-effort y sin IIFE.
    expect(core).toMatch(/if\(d>0\)\{S\.hist=S\.hist\|\|\{\};S\.hist\[ym\(\)\]=docsMes\(\);FM=null;if\(window\.__ALQ_SNAPSHOT\)window\.__ALQ_SNAPSHOT\(S\.m,S\.y\)\}/);
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
    // el catch no crashea el boot: S=null y cae a la pantalla de reintento
    // (guard P0 anti-pisón de abajo) — jamás un render en blanco ni un vacío pisando la fila
    expect(app).toMatch(/catch \(e\) \{[\s\S]{0,300}S = null;/);
    // y el fallback de usuario nuevo arranca vacío con bhInitS
    expect(app).toMatch(/if \(!S\) \{[\s\S]{0,900}bhInitS\(S\);/);
  });

  test('P0 anti-pisón: carga fallida o ilegible NUNCA arranca vacío (pisaría la fila real)', () => {
    // 2026-11-14: si la lectura inicial falla (red/JWT) o el estado no se
    // puede interpretar, arrancar vacío + el auto-guardado (~1.2s) sobrescribía
    // la fila real con un estado vacío (RLS lo permite: es la fila propia).
    // Hoy: pantalla de reintento + syncNow bloqueado hasta cargar bien.
    expect(app).toMatch(/if \(!cargado && \(row \|\| err\)\) \{/);
    expect(app).toMatch(/loadFailed = true;[\s\S]{0,120}showRetry\(\);[\s\S]{0,40}return;/);
    expect(app).toMatch(/if \(!client \|\| !S \|\| !alqUser \|\| loadFailed\) return;/);
    // el estado vacío sólo se crea como usuario nuevo (lectura OK sin fila)
    // y ahí mismo se libera el bloqueo
    expect(app).toMatch(/if \(!S\) \{[\s\S]{0,900}bhInitS\(S\);[\s\S]{0,300}loadFailed = false;/);
    // reintento: botón manual + reconexión automática de red
    expect(app).toContain('function showRetry()');
    expect(app).toMatch(/addEventListener\('online'[\s\S]{0,80}if \(loadFailed && !S\) init\(\)/);
  });

  test('reintento permanente del guardado tras agotar los 5 backoffs', () => {
    // antes: superados los 5 reintentos, los edits posteriores probaban UNA vez
    // y "reintentando…" mentía (nunca más se reintentaba hasta recargar)
    expect(app).toMatch(/if \(\+\+attempts <= 5\) \{ saveTimer = setTimeout\(syncNow, 3000 \* attempts\); \}[\s\S]{0,80}else \{ saveTimer = setTimeout\(syncNow, 30000\); \}/);
  });

  test('flush al ocultar la pestaña (no se pierden cambios)', () => {
    expect(app).toMatch(/visibilitychange[\s\S]{0,300}syncNow\(\)/);
  });

  test('Bloque 1.H: el guardado frena si la fila remota es más nueva (conflicto)', () => {
    // Chequeo previo al upsert contra el stamp de la carga; la decisión es del
    // usuario (recargar / pisar conscientemente). Sin esto, la última pestaña
    // que guarda pisa en silencio lo guardado desde otro dispositivo.
    // ⚠️ Comparación por INSTANTE (Date.parse), no por string: PostgREST
    // re-formatea el timestamptz ('...+00:00' vs el '...Z' de toISOString) —
    // comparar strings daría un falso conflicto en cada guardado propio.
    expect(app).toMatch(/const remoteMs = remote && remote\.updated_at \? Date\.parse\(remote\.updated_at\) : NaN;/);
    expect(app).toMatch(/if \(!eRemote && remote && !Number\.isNaN\(remoteMs\) && !Number\.isNaN\(localMs\) && remoteMs !== localMs\) \{[\s\S]{0,140}conflictShow\(/);
    expect(app).not.toMatch(/remote\.updated_at !== rowStamp/); // el bug del string-compare no vuelve
    // nuestro propio guardado actualiza el stamp (no se auto-conflictea)
    expect(app).toMatch(/rowStamp = sentAt;/);
    // pisar conscientemente: el flag se consume en un solo save forzado
    expect(app).toMatch(/\} else \{\s*forceSave = false;\s*\}/);
    // overlay con las dos salidas + estado visible en est()
    expect(app).toMatch(/alqConflictReload[\s\S]{0,140}window\.location\.reload\(\)/);
    expect(app).toMatch(/alqConflictOverwrite[\s\S]{0,140}forceSave = true; syncNow\(\)/);
    expect(app).toMatch(/if \(conflictOpen\) \{ e\.textContent = '⚠ Modificada en otro dispositivo/);
    // chequeo liviano al volver a la pestaña visible (otro dispositivo pudo guardar)
    expect(app).toMatch(/visibilitychange[\s\S]{0,500}!== 'visible'[\s\S]{0,500}conflictShow\(/);
  });

  test('Bloque 1.B: snapshot al cierre + ventana de respaldos con restauración', () => {
    // copia PROFUNDA inmediata: S sigue mutando (avance de mes) mientras el insert viaja
    expect(app).toMatch(/const copy = JSON\.parse\(JSON\.stringify\(S\)\);[\s\S]{0,260}alquileres_snapshots'\)/);
    expect(app).toMatch(/label: 'Cierre ' \+ MES\[cm\] \+ ' ' \+ cy/);
    // best-effort: el snapshot jamás bloquea el cierre de mes
    expect(app).toMatch(/async function alqSnapshot\(cm, cy\) \{[\s\S]{0,500}catch \(e\) \{ console\.error\('\[alquileres\] snapshot:', e\); \}\s*\}/);
    // restauración: reemplaza S completo, fuerza el guardado y aterriza en resumen
    expect(app).toMatch(/S = s\.state;[\s\S]{0,80}bhInitS\(S\);[\s\S]{0,160}LAST = null;/);
    // listado acotado (30) y con escape de HTML
    expect(app).toMatch(/\.order\('created_at', \{ ascending: false \}\)[\s\S]{0,60}\.limit\(30\)/);
    expect(app).toMatch(/function alqEsc\(s\)/);
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

  test('Bloque 1: overlays de conflicto y respaldos + botón en el header', () => {
    // conflicto multi-dispositivo: overlay fijo con las dos salidas
    expect(html).toContain('id="alqConflict"');
    expect(html).toContain('id="alqConflictMsg"');
    expect(html).toContain('id="alqConflictReload"');
    expect(html).toContain('id="alqConflictOverwrite"');
    // respaldos: botón del header + ventana con lista
    expect(html).toContain('alqSnapsOpen()');
    expect(html).toContain('id="alqSnaps"');
    expect(html).toContain('id="alqSnapsList"');
    expect(html).toContain('id="alqSnapsClose"');
  });
});

test.describe('integración con el panel admin — iframe embebido', () => {
  test('navigateTo ya NO redirige: el módulo vive EN el panel (lazy-load)', () => {
    const app = read('assets/js/admin-app.js');
    // el redirect a página propia quedó reemplazado
    expect(app.includes("window.location.href = 'alquileres.html'")).toBe(false);
    const i = app.indexOf("function navigateTo(section, opts) {");
    expect(i, 'debe existir navigateTo').toBeGreaterThan(-1);
    const bloque = app.slice(i, i + 6000);
    // lazy-load: el src del iframe se setea desde data-src en el primer ingreso
    expect(bloque).toMatch(/section === 'tab-alquileres'[\s\S]{0,400}getElementById\('alqFrame'\)[\s\S]{0,200}dataset\.src/);
  });

  test('auto-height: postMessage con origen y fuente del mensaje validados', () => {
    const app = read('assets/js/admin-app.js');
    expect(app).toContain("'bh-alq-height'");
    // origen same-origin obligatorio (un postMessage de afuera no puede pisar la altura)
    expect(app).toMatch(/e\.origin !== location\.origin[\s\S]{0,400}'bh-alq-height'/);
    // sólo se acepta el mensaje del propio iframe
    expect(app).toMatch(/e\.source !== alqFrame\.contentWindow/);
    expect(app).toMatch(/Math\.max\(520/);
  });

  test('admin.html: nav-item + section tab-module + iframe embebido', () => {
    const html = read('admin.html');
    expect(html).toContain('data-tab="tab-alquileres"');
    // la section SÍ existe (tab normal — el contenido va en un iframe same-origin)
    expect(html).toMatch(/<section class="tab-module" id="tab-alquileres">/);
    expect(html).toMatch(/<iframe id="alqFrame" data-src="alquileres\.html"/);
  });

  test('los HTML del root referencian la versión bumped de admin-app.js', () => {
    const html = read('admin.html');
    expect(html).toMatch(/assets\/js\/admin-app\.js\?v=\d+/);
  });

  test('Bloque 1.F: badge real de Alquileres en el sidebar (desaparece en 0)', () => {
    const app = read('assets/js/admin-app.js');
    expect(app).toMatch(/sideBadgeAlquileres[\s\S]{0,200}alq_contracts_expiring/);
    // sin casos → display:none (un "0" fijo era ruido; criterio del chat)
    expect(app).toMatch(/sideBadgeAlquileres[\s\S]{0,700}style\.display = 'none'/);
    // con casos → contador + clase ámbar + tooltip
    expect(app).toMatch(/alqEl\.classList\.add\('nav-badge--warn'\)/);
    expect(app).toMatch(/contratos por vencer o vencidos/);
  });
});

test.describe('alquileres.html — retheme identidad del panel', () => {
  let html;
  test.beforeAll(() => { html = read('alquileres.html'); });

  test('fuentes del admin (Playfair Display + Plus Jakarta Sans) con CSP y links', () => {
    expect(html).toMatch(/fonts\.googleapis\.com\/css2\?family=Playfair\+Display[\s\S]*Plus\+Jakarta\+Sans/);
    expect(html).toMatch(/Content-Security-Policy[^>]*style-src[^>]*fonts\.googleapis\.com/);
    expect(html).toMatch(/Content-Security-Policy[^>]*font-src[^>]*fonts\.gstatic\.com/);
  });

  test('tokens del panel en el CSS del módulo (gana por cascada)', () => {
    expect(html).toMatch(/--acc:#1FC8C3/);
    expect(html).toMatch(/--ink:#F8FAFC/);
    expect(html).toContain("font-family:'Plus Jakarta Sans'");
    expect(html).toMatch(/'Playfair Display',Georgia,serif/);
    // el retheme vive al FINAL del style (después de las reglas originales)
    const iOriginal = html.indexOf(':root{--ink:#1b2a41');
    const iRetheme = html.indexOf('--acc:#1FC8C3');
    expect(iOriginal).toBeGreaterThan(-1);
    expect(iRetheme).toBeGreaterThan(iOriginal);
  });

  test('modo embebido: .embed oculta los accesos de vuelta + el controlador detecta el iframe', () => {
    expect(html).toMatch(/body\.embed \.btn-back-panel/);
    expect(html).toMatch(/body\.embed #gateBack/);
    expect(html).toContain('btn-back-panel');
    // canvas del iframe dark (transparente → Chrome pinta el canvas blanco)
    expect(html).toMatch(/html\{background:var\(--bg\)\}/);
    expect(html).toMatch(/body\.embed\{background:var\(--bg\)\}/);
    const app = read('assets/js/alquileres-app.js');
    expect(app).toMatch(/window\.self !== window\.top/);
    expect(app).toContain("'bh-alq-height'");
    expect(app).toContain("document.body.classList.add('embed')");
    // falla cerrada: si el acceso a window.top está bloqueado, asume embebido
    expect(app).toMatch(/catch \(_\) \{ EMBEDDED = true; \}/);
  });

  test('la impresión sigue en blanco (los PDFs no se rethemaron)', () => {
    // guard al final del retheme: en print fuerza blanco aunque el body sea dark
    expect(html).toMatch(/@media print\{html,body\{background:#fff!important\}\}/);
    // los documentos no usan vars: siguen hardcoded en blanco
    expect(html).toMatch(/\.pg\{[^}]*background:#fff/);
  });

  test('core sin colores hardcodeados del tema claro (retheme por vars)', () => {
    // Los boxes de pago (#fff pendiente, #ecfdf3 cobrado, #fffbeb parcial), los
    // boxes de OCR/WhatsApp (#f8fafc) y los textos ámbar/rojo oscuro iban inline
    // en el HTML que genera el core → sobre el tema dark quedaban manchas
    // blancas (reporte del dueño 2026-11-14). Hoy van por vars del retheme.
    const core = read('assets/js/alquileres-core.js');
    const claros = ['#fff', '#f8fafc', '#ecfdf3', '#fffbeb', '#51607a', '#b45309', '#b42318', '#16a34a', '#d97706'];
    const presentes = claros.filter(c => core.includes(c));
    expect(presentes, `colores claros hardcodeados: ${presentes.join(', ')}`).toEqual([]);
    // y el retheme define las vars que el core consume
    for (const v of ['--ok:', '--ok-bg:', '--warn-bg:', '--soft:']) expect(html).toContain(v);
  });

  test('el backdrop del preview de impresión es dark (antes #6b7280)', () => {
    expect(html).toMatch(/#print\.on\{background:#0A0D12\}/);
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

  test('Bloque 1.B: snapshots inmutables al cerrar mes (RLS propia, sin UPDATE/DELETE)', () => {
    const sql = read('supabase/migrations/20261114000004_alquileres_snapshots.sql');
    expect(sql).toMatch(/create table if not exists public\.alquileres_snapshots/);
    expect(sql).toMatch(/enable row level security/i);
    // cada usuario inserta/lee SOLO los suyos, optimizado con (select auth.uid())
    expect(sql).toMatch(/for select[\s\S]*?using \(user_id = \(select auth\.uid\(\)\)\)/i);
    expect(sql).toMatch(/for insert[\s\S]*?with check \(user_id = \(select auth\.uid\(\)\)\)/i);
    // inmutables desde el cliente: sin policies de UPDATE/DELETE para authenticated
    expect(sql).not.toMatch(/for update/i);
    expect(sql).not.toMatch(/for delete/i);
    expect(sql).toMatch(/revoke all on public\.alquileres_snapshots from anon/i);
    expect(sql).toMatch(/grant select, insert on public\.alquileres_snapshots to authenticated/i);
  });

  test('Bloque 1.F: badge RPC v3 — alq_contracts_expiring con ventana -3..2 meses', () => {
    const sql = read('supabase/migrations/20261114000005_badge_alquileres_v3.sql');
    expect(sql).toMatch(/create or replace function public\.get_sidebar_badge_counts/);
    expect(sql).toContain('alq_contracts_expiring');
    // SECURITY DEFINER → el usuario se resuelve explícito (definer no pasa por RLS)
    expect(sql).toMatch(/s\.user_id = coalesce\(p_user_id, auth\.uid\(\)\)/);
    // guard anti-crash: props debe ser array antes de jsonb_array_elements
    expect(sql).toMatch(/jsonb_typeof\(s\.state->'props'\) = 'array'/);
    // semántica de alertas() del core: fin = 'YYYY-MM', d = (fy*12+fm) - (cy*12+cm) - 1
    expect(sql).toMatch(/between -3 and 2/);
    // el resto del contrato de la función queda intacto
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/'visits_today', v_visits_today/);
    expect(sql).toMatch(/'alq_contracts_expiring', v_alq_contracts/);
  });
});

test.describe('Bloque 2 — KPIs en Dashboard, vencimientos y recordatorio de cierre', () => {
  test('2.E módulo: KPIs calculados con la lógica del core y persistidos en S.kpis', () => {
    const app = read('assets/js/alquileres-app.js');
    // cero duplicación de negocio: usa calc/sorted/pagoG/listaInq/own del core
    expect(app).toMatch(/function alqKpisCompute\(\) \{[\s\S]{0,200}for \(const p of sorted\(\)\) \{[\s\S]{0,120}const c = calc\(p\);/);
    expect(app).toMatch(/listaInq\('inq:' \+ p\.cod, ym\(\), c\.tot\)/);
    expect(app).toMatch(/pagoG\('prop:' \+ own\(p\), ym\(\)\)\.ok/);
    // viajan dentro del estado, ANTES del snapshot del save
    expect(app).toMatch(/S\.kpis = alqKpisCompute\(\);[\s\S]{0,80}const snap = JSON\.stringify\(S\);/);
    // vencimientos con la fórmula de alertas() acotada a [-3, +3] meses
    expect(app).toMatch(/\(fp\[0\] - S\.y\) \* 12 \+ \(fp\[1\] - 1 - S\.m\)/);
    expect(app).toMatch(/d <= 3 && d >= -3/);
  });

  test('2.E RPC: alquileres_dashboard_kpis() lee la fila no vacía más reciente', () => {
    const sql = read('supabase/migrations/20261115000001_alquileres_dashboard_kpis.sql');
    expect(sql).toMatch(/create or replace function public\.alquileres_dashboard_kpis\(\)/);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path to ''/i);
    // una fila vacía de otro usuario NO tapa al operador activo
    expect(sql).toMatch(/jsonb_array_length\(s\.state->'props'\) > 0/);
    expect(sql).toMatch(/order by s\.updated_at desc nulls last/i);
    // duración de accesos: authenticated + service_role, anon fuera
    expect(sql).toMatch(/grant execute on function public\.alquileres_dashboard_kpis\(\) to authenticated/i);
    expect(sql).toMatch(/revoke all on function public\.alquileres_dashboard_kpis\(\) from anon/i);
  });

  test('2.E+2.D Dashboard: tarjeta con KPIs y vencimientos + botón al módulo', () => {
    const html = read('admin.html');
    expect(html).toContain('id="alqDashPanel"');
    expect(html).toContain('id="alqDashBody"');
    expect(html).toContain('id="alqDashPeriodo"');
    expect(html).toContain('data-action="goToAlquileres"');
    const app = read('assets/js/admin-app.js');
    expect(app).toMatch(/async function renderDashAlquileres\(\)/);
    expect(app).toMatch(/\.rpc\('alquileres_dashboard_kpis'\)/);
    expect(app).toMatch(/renderDashAlquileres\(\); \/\* Bloque 2\.E \+ 2\.D/);
    // navegación al módulo desde la tarjeta
    expect(app).toMatch(/case 'goToAlquileres':\s*navigateTo\('tab-alquileres'\);/);
    // vencimientos en la tarjeta (2.D): vence este mes / vencido / vence en N
    expect(app).toMatch(/vence este mes/);
    expect(app).toMatch(/vencido \(/);
  });

  test('2.C edge function: secret, detección de mes sin cerrar, dedupe y email', () => {
    const fn = read('supabase/functions/alquileres-month-reminder/index.ts');
    // auth idéntica al digest (fix 20261015000004: zernio_config, no app.settings)
    expect(fn).toMatch(/x-sync-secret/);
    expect(fn).toMatch(/key = 'sync_secret'|"sync_secret"/);
    // detección: hist sin la clave 'YYYY-MM' del mes previo + props activas
    expect(fn).toMatch(/!Array\.isArray\(st\.props\) \|\| st\.props\.length === 0/);
    expect(fn).toMatch(/!hist\[prevYm\]/);
    // dedupe: un solo email por mes vía audit_log
    expect(fn).toMatch(/\.eq\("action", "alq_month_reminder"\)/);
    expect(fn).toMatch(/\.gte\("created_at", monthStart\)/);
    // envío por Brevo + traza de auditoría con el resultado
    expect(fn).toMatch(/api\.brevo\.com\/v3\/smtp\/email/);
    expect(fn).toMatch(/action: 'alq_month_reminder'/);
    // ART (UTC-3) para el mes de referencia
    expect(fn).toMatch(/3 \* 60 \* 60 \* 1000/);
  });

  test('2.C cron: días 2 y 3 a las 12:00 ART con x-sync-secret de zernio_config', () => {
    const sql = read('supabase/migrations/20261115000002_alquileres_month_reminder_cron.sql');
    expect(sql).toMatch(/cron\.schedule\(\s*'alquileres-month-reminder',\s*'0 15 2,3 \* \*'/);
    expect(sql).toMatch(/functions\/v1\/alquileres-month-reminder'/);
    expect(sql).toMatch(/value->>'secret' FROM public\.zernio_config WHERE key = 'sync_secret'/);
    expect(sql).not.toMatch(/current_setting\('app\.settings/); // el pisón de 2026-10-15 no vuelve
  });

  test('2.C la función cron está en NO_VERIFY del deploy (sin JWT)', () => {
    const yml = read('.github/workflows/deploy.yml');
    const m = yml.match(/NO_VERIFY=\(([^)]*)\)/); // el regex corta en el primer ')' — sin comentarios inline adentro
    expect(m, 'bloque NO_VERIFY presente').toBeTruthy();
    expect(m[1]).toContain('"alquileres-month-reminder"');
  });
});
