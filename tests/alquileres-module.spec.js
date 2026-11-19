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
    const bloque = core.slice(iMesMas, iMesMas + 2600); // mesMas creció con las ediciones #11/#12 + navegación sin pérdida (S.live)
    expect(bloque).toMatch(/if\(d<0\)\{[\s\S]*?prevMes\(\)[\s\S]*?restaurarMes\(pk\)/);
    // la restauración mapea docs del historial → props: orden (alquiler+servicios) y cuenta (saldo)
    const iRest = core.indexOf('function restaurarMes(key)');
    const rBloque = core.slice(iRest, iRest + 2000);
    expect(rBloque).toMatch(/d\.k=='o'/);
    expect(rBloque).toMatch(/d\.k=='c'/);
    expect(rBloque).toMatch(/p\.alq=/);
    expect(rBloque).toMatch(/p\.saldoAnt=/);
    // #10: restaura monto = línea × n (servicios compartidos), lecturas luz proporcional (ka/kc/kv o reconstrucción), extras
    expect(rBloque).toContain('function alqRestaurarSv');
    expect(rBloque).toMatch(/o\.monto=\(.*\)\*\(o\.n/);
    expect(rBloque).toMatch(/key=='luz'.*prop/);
    expect(rBloque).toMatch(/o\.ka=.*o\.kc=|o\.ka.*LK\.ka.*LK\.kc/);
    expect(rBloque).toMatch(/p\.ex=\[\]/);
    expect(rBloque).toMatch(/p\.ex\.push/);
    expect(rBloque).toMatch(/d\.k=='l'/);
  });

  test('boot final: render sólo si hay S cargado (sin blanco ni crash)', () => {
    expect(core).toContain('hh();if(S){render();tot();est();restaurarAdj()}');
  });

  test('Bloque 1.B: mesMas(>0) dispara el snapshot con el mes que SE CIERRA', () => {
    // El hook corre con S.m/S.y del mes que se cierra y S.hist ya actualizado
    // (docsMes), pero ANTES de blanquear servicios y avanzar: la copia es
    // exactamente "la administración como estaba al cerrar X". Guardado por
    // el controlador (window.__ALQ_SNAPSHOT), best-effort y sin IIFE.
    expect(core).toMatch(/S\.hist\[ym\(\)\]=docsMes\(\)\}\s*S\.sig\[ym\(\)\]=firma\(S\.props\);FM=null;if\(window\.__ALQ_SNAPSHOT\)window\.__ALQ_SNAPSHOT\(S\.m,S\.y\);?if\(window\.__ALQ_PUBLISH\)?/);
  });

  test('edición #11 (2026-11-17): re-cerrar un mes ya cerrado avisa y respalda el historial previo', () => {
    // Incidente real: Danilo retrocedió a Agosto y lo re-cerró → el historial
    // REAL de Agosto (importado del standalone) fue reemplazado sin aviso por
    // una reconstrucción más pobre (10.301 → 8.938 chars, docs de 'nueva'
    // desaparecidos). El confirm debe avisar el reemplazo y __ALQ_SNAPSHOT_PRE
    // debe correr ANTES de pisar S.hist[ym()] (best-effort, jamás bloquea).
    expect(core).toContain('ya estaba cerrado y lo modificaste: se actualiza su historial con los datos de ahora');
    // el historial anterior queda en Respaldos (la red de seguridad)
    expect(core).toContain('El historial anterior queda en Respaldos (☁), así que no se pierde nada');
    // el respaldo previo va ENTRE la inicialización del hist y el docsMes() que pisa
    expect(core).toMatch(/S\.hist=S\.hist\|\|\{\};if\(!yaHist\|\|cambio\)\{if\(yaHist&&window\.__ALQ_SNAPSHOT_PRE\)window\.__ALQ_SNAPSHOT_PRE\('Historial previo '[^;]+?\);S\.hist\[ym\(\)\]=docsMes\(\)\}/);
  });

  test('re-cierre SIN cambios NO pisa el historial archivado (2026-11-17, caso del empleador)', () => {
    // El empleador volvió de Octubre a Septiembre, cerró September de nuevo y
    //.acceptó el aviso: el historial de Septiembre (importado, 9.237 chars) fue
    // pisado por una reconstrucción (9.136) — se perdió la línea "NOTIFICACION:
    // DETALLE DE SERVICIOS..." de la orden 2-0. Los importes NO se Lost.
    // Ahora: si la firma del mes no cambió (navegar ≠ modificar), el historial
    // NO se reescribe y NO sale el aviso.
    expect(core).toMatch(/const yaHist=!!\(S\.hist&&S\.hist\[ym\(\)\]\),ref=S\.sig\[ym\(\)\],cambio=ref\?firma\(S\.props\)!==ref:true/);
    expect(core).toMatch(/if\(!yaHist\|\|cambio\)\{/);
    // la firma se registra al LLEGAR a un mes y se actualiza al cerrarlo
    expect(core).toContain("S.sig[ym()]=firma(S.props)");
    expect(core).toMatch(/const yk=ym\(\);if\(!S\.sig\[yk\]\)S\.sig\[yk\]=firma\(S\.props\)/);
    // bhInitS siembra S.sig con la firma del mes actual (arranque = sin cambios)
    expect(core).toContain('if(!s.sig)s.sig={}');
    expect(core).toMatch(/const sk=s\.y\+'-'\+String\(\(\+s\.m\|\|0\)\+1\)\.padStart\(2,'0'\);if\(!s\.sig\[sk\]\)s\.sig\[sk\]=firma\(s\.props\|\|\[\]\)/);
    // firma order-independent (jsonb reordena las claves al guardar)
    expect(core).toContain("const estable=v=>{if(Array.isArray(v))return '['+v.map(estable).join(',')+']'");
  });

  test('los mensajes aclaran que NO hay que cerrar el mes para guardar (2026-11-17)', () => {
    // El empleador preguntó: "Noviembre, como no le di cerrar se borra".
    // Los dos confirms (cerrar / volver) lo dicen explícito.
    expect(core).toContain('Podés volver a este mes cuando quieras: lo que cargues se guarda solo, no hace falta cerrar');
    expect(core).toContain('No hace falta cerrar el mes para que los datos queden guardados');
    // el botón y el hint del header lo aclaran también
    const html = read('alquileres.html');
    expect(html).toContain('Los datos se guardan solos al escribir: no hace falta cerrar el mes para que queden guardados');
    expect(html).toContain('title="Guarda el mes en el Historial (documentos PDF) y pasa al siguiente. No borra nada: podés volver atrás cuando quieras."');
  });

  test('navegación sin pérdida (2026-11-17): el retroceso guarda el mes que se deja y restaura el destino', () => {
    // Incidente real: Danilo retrocedió 3 meses y perdió lo cargado en Noviembre.
    // Ahora capturarMes() guarda SIEMPRE el mes que se deja en S.live[ym()] (copia
    // exacta de props) ANTES de restaurar el destino; el destino se restaura de
    // S.live primero (exacto, sin roundtrip por docs) y si no de S.hist.
    expect(core).toContain('queda guardado: volvé cuando quieras sin perder nada');
    expect(core).toMatch(/capturarMes\(\);[\s\S]{0,30}if\(d<0&&hs\)\{if\(hl\)S\.props=JSON\.parse\(JSON\.stringify\(S\.live\[pk\]\)\);else restaurarMes\(pk\)\}/);
    // y el respaldo en Respaldos sigue corriendo antes de restaurar (red extra)
    expect(core).toMatch(/if\(hs&&window\.__ALQ_SNAPSHOT_PRE\)window\.__ALQ_SNAPSHOT_PRE\('Antes de volver a '/);
  });

  test('navegación sin pérdida: helpers nextMes/capturarMes y llegada al mes con estado guardado', () => {
    // S.live = copia exacta de props por mes visitado. La llegada (adelante) restaura
    // la copia viva si existe; si no, deriva el mes nuevo como siempre (alquileres
    // repetidos, muni/rentas conservan, resto en 0). El guardado ya no es sólo al
    // cerrar: la navegación en ambas direcciones persiste.
    expect(core).toContain('function nextMes(){let m=S.m+1,y=S.y;if(m>11){m=0;y++}return y+');
    expect(core).toMatch(/function capturarMes\(\)\{if\(!S\)return;if\(!S\.live\)S\.live=\{\};S\.live\[ym\(\)\]=JSON\.parse\(JSON\.stringify\(S\.props\)\)\}/);
    expect(core).toMatch(/capturarMes\(\);/);
    expect(core).toMatch(/if\(S\.live&&S\.live\[nk\]\)S\.props=JSON\.parse\(JSON\.stringify\(S\.live\[nk\]\)\);else for\(const p of S\.props\)\{/);
    expect(core).toMatch(/render\(\);LAST=null;guardarArchivo\(\)\}/);
    // bhInitS semilla live={} (estados viejos del JSONB no lo tienen)
    expect(core).toContain('if(!s.live)s.live={}');
    // el confirm del avance avisa cuando el mes destino tiene datos guardados
    expect(core).toContain('tiene datos guardados: al llegar se restauran tal como los dejaste (no se repiten en blanco)');
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

  test('el hook __ALQ_SNAPSHOT_PRE existe en el controlador (best-effort, sin IIFE)', () => {
    expect(app).toContain('async function alqSnapshotPre(label)');
    // 2026-11-18: DEVUELVE la promesa (el core la espera con `await` antes de
    // reemplazar el estado al importar un archivo → el respaldo queda en la
    // nube ANTES del cambio). La forma anterior (sin return) no servía.
    expect(app).toContain('window.__ALQ_SNAPSHOT_PRE = (label) => alqSnapshotPre(label);');
    // inserta en alquileres_snapshots con copia profunda (el estado sigue mutando)
    expect(app).toMatch(/alquileres_snapshots'\)\.insert\(\{[\s\S]*?user_id: alqUser\.id,[\s\S]*?label: label,[\s\S]*?state: copy/);
  });

  test('restaurar snapshot respalda el estado vigente antes de reemplazarlo', () => {
    expect(app).toMatch(/alqSnapshotPre\('Antes de restaurar '[\s\S]*?S = s\.state;/);
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
    // 2026-11-18 (auditoría): "administración activa" = props + datos de la
    // inmobiliaria cargados (state->'corr'->'n'). Sin esto, la fila de PRUEBA
    // (1 prop '001', sin corr) recibía el recordatorio igual.
    expect(fn).toMatch(/const nombre = String\(\(st\.corr \|\| \{\}\)\.n \|\| ""\)\.trim\(\)/);
    expect(fn).toMatch(/if \(!nombre\) return false;/);
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

test.describe('Bloque 3 — Liquidaciones al Portal del Propietario', () => {
  test('3.A migración: tabla inmutable por diseño + RPC del portal por token', () => {
    const sql = read('supabase/migrations/20261115000003_alquileres_portal_liquidaciones.sql');
    expect(sql).toMatch(/create table if not exists public\.alquileres_portal_liquidaciones/);
    expect(sql).toMatch(/enable row level security/i);
    // club service-role/definer: sin policies para authenticated ni anon
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toMatch(/revoke all on public\.alquileres_portal_liquidaciones from anon/i);
    expect(sql).toMatch(/revoke all on public\.alquileres_portal_liquidaciones from authenticated/i);
    expect(sql).toMatch(/grant all on public\.alquileres_portal_liquidaciones to service_role/i);
    // re-publicar un mes REEMPLAZA (no duplica)
    expect(sql).toMatch(/create unique index if not exists alq_portal_liq_owner_period_uidx/);
    // RPC del portal: validación de token idéntica a portal_get_portal_data
    expect(sql).toMatch(/create or replace function public\.portal_get_liquidaciones\(p_token text\)/);
    expect(sql).toMatch(/t\.revoked_at is null/);
    expect(sql).toMatch(/t\.expires_at >= now\(\)/);
    // club de RPC por token: EXECUTE a anon (el propietario no está logueado)
    expect(sql).toMatch(/grant execute on function public\.portal_get_liquidaciones\(text\) to anon/i);
  });

  test('3.A módulo: mapeo ownerKey→CRM + publicación al cerrar mes', () => {
    const app = read('assets/js/alquileres-app.js');
    // mapeo por CLAVE de propietario del core (own(p)), persistido en S.ownerMap
    expect(app).toMatch(/S\.ownerMap = S\.ownerMap \|\| \{\};/);
    expect(app).toMatch(/const k = own\(p\);/);
    // hook del core (edición #6): el mes cerrado dispara snapshot Y publicación
    const core = read('assets/js/alquileres-core.js');
    expect(core).toMatch(/if\(window\.__ALQ_SNAPSHOT\)window\.__ALQ_SNAPSHOT\(S\.m,S\.y\);if\(window\.__ALQ_PUBLISH\)window\.__ALQ_PUBLISH\(S\.m,S\.y\)/);
    // publicación: solo docs k='l' del mes cerrado con propietario vinculado
    expect(app).toMatch(/const closedYm = cy \+ '-' \+ String\(cm \+ 1\)\.padStart\(2, '0'\);/);
    expect(app).toMatch(/if \(d\.k !== 'l'\) continue;/);
    // d.cod es el cod de la primera propiedad → misma clave que own()
    expect(app).toMatch(/String\(d\.cod\)\.split\(\/\[\^0-9a-zA-Z\]\+\/\)\[0\]/);
    // llamada a la edge function con JWT del operador
    expect(app).toMatch(/functions\/v1\/alquileres-portal-publish/);
    expect(app).toMatch(/'Authorization': 'Bearer ' \+ jwt/);
    // best-effort: jamás bloquea el cierre
    expect(app).toMatch(/async function alqPortalPublish\(cm, cy\) \{[\s\S]{0,2400}catch \(e\) \{/);
  });

  test('3.A edge function: validación de owner activo, upsert owner+periodo y emails', () => {
    const fn = read('supabase/functions/alquileres-portal-publish/index.ts');
    // verify_jwt ON: requireAdmin (JWT de operador activo del panel)
    expect(fn).toMatch(/requireAdmin\(req, supabase\)/);
    expect(fn).toMatch(/rateLimitMiddleware\('alquileres-portal-publish', req\)/);
    // el propietario debe existir, no estar eliminado y estar activo
    expect(fn).toMatch(/o\.deleted_at/);
    expect(fn).toMatch(/o\.status !== 'activo'/);
    // solo liquidaciones reales del core
    expect(fn).toMatch(/\(it\.data as any\)\.k !== 'l'/);
    // upsert con el conflicto owner+periodo (re-publicar reemplaza)
    expect(fn).toMatch(/onConflict: 'owner_id,period'/);
    // email por propietario afectado + link al portal si hay token vigente
    expect(fn).toMatch(/alquileres_portal_liquidaciones/);
    expect(fn).toMatch(/owner_portal_tokens/);
    expect(fn).toMatch(/api\.brevo\.com\/v3\/smtp\/email/);
    // auditoría de cada publicación
    expect(fn).toMatch(/action: 'alq_portal_publish'/);
    // NO va en NO_VERIFY (se llama CON JWT del operador)
    const yml = read('.github/workflows/deploy.yml');
    const m = yml.match(/NO_VERIFY=\(([^)]*)\)/);
    expect(m, 'bloque NO_VERIFY presente').toBeTruthy();
    expect(m[1]).not.toContain('"alquileres-portal-publish"');
  });

  test('3.A portal: sección Liquidaciones con detalle por mes', () => {
    const portal = read('assets/js/pages/portal-propietario-page.js');
    expect(portal).toMatch(/function renderLiquidaciones\(\)/);
    expect(portal).toMatch(/\.rpc\('portal_get_liquidaciones', \{ p_token: token \}\)/);
    expect(portal).toMatch(/renderLiquidaciones\(\); catch|try \{ renderLiquidaciones\(\); \} catch \(e\) \{ console\.error\('\[portal\] liquidaciones:', e\); \}/);
    // sin publicaciones la sección no aparece (no ensucia el portal)
    expect(portal).toMatch(/if \(!liqs\.length\) return;/);
    // detalle con conceptos, totales y nota
    expect(portal).toMatch(/Liquidaciones de alquiler \(/);
    expect(portal).toMatch(/TOTAL DEDUCCIONES|FMT_ARS\.format/);
  });

  test('3.A el botón Propietarios existe en el módulo', () => {
    const html = read('alquileres.html');
    expect(html).toContain('alqOwnersOpen()');
    expect(html).toContain('id="alqOwners"');
    expect(html).toContain('id="alqOwnersList"');
    expect(html).toContain('id="alqOwnersClose"');
  });
});

test.describe('Bloque 4 — Comprobantes en Storage', () => {
  test('4.G migración: bucket privado con límite y RLS por carpeta de usuario', () => {
    const sql = read('supabase/migrations/20261115000004_alquileres_adj_storage.sql');
    // bucket privado, 20 MB por archivo
    expect(sql).toMatch(/insert into storage\.buckets \(id, name, public, file_size_limit\)[\s\S]*'alquileres-adj'[\s\S]*false[\s\S]*20971520/);
    // las 4 policies con el primer segmento del path = auth.uid()
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      expect(sql).toMatch(new RegExp(`for ${cmd}[^;]*alquileres-adj`, 'i'));
    }
    expect(sql).toMatch(/\(storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/);
    // insert también valida en with check (no solo using)
    expect(sql).toMatch(/for insert[\s\S]{0,200}with check \([\s\S]*auth\.uid\(\)/i);
  });

  test('4.G core: un solo punto de enganche en idbDo (put→upload, del→remove)', () => {
    const core = read('assets/js/alquileres-core.js');
    // el hook vive en oncomplete — cubre las 4 familias de adjuntos con 1 edición
    expect(core).toMatch(/t\.oncomplete=\(\)=>\{ok\(q\.result\);if\(m=='put'&&window\.__ALQ_ADJ_UP\)try\{window\.__ALQ_ADJ_UP\(k,v\)\}catch\(e\)\{\}if\(m=='del'&&window\.__ALQ_ADJ_DEL\)try\{window\.__ALQ_ADJ_DEL\(k\)\}catch\(e\)\{\}\};t\.onerror/);
  });

  test('4.G controlador: convergencia bidireccional con pausa anti-eco', () => {
    const app = read('assets/js/alquileres-app.js');
    expect(app).toMatch(/const ADJ_BUCKET = 'alquileres-adj';/);
    expect(app).toMatch(/let adjSyncBusy = false;/);
    // el NOMBRE del objeto es la CLAVE CRUDA del core (con ':'): ida y vuelta
    // exacta — el metadata del estado guarda la clave cruda y verAdj la busca.
    expect(app).toMatch(/bucket\.upload\(FID \+ '\/' \+ k, v,|upload\(FID \+ '\/' \+ k, v,/);
    expect(app).toMatch(/\.remove\(\[FID \+ '\/' \+ k\]\)/);
    expect(app).toMatch(/const \{ data: blob, error: gErr \} = await bucket\.download\(FID \+ '\/' \+ o\.name\)/);
    // la clave local del archivo bajado = name crudo (coincide con el metadata)
    expect(app).toMatch(/await idbDo\('put', o\.name, blob\)/);
    // no re-subir la carpeta del propio listado (!o.id = carpeta)
    expect(app).toMatch(/if \(!o\.id \|\| !o\.name \|\| localByK\.has\(o\.name\)\) continue;/);
    // baja lo que falta Y sube lo que falta (migración de los archivos históricos)
    expect(app).toMatch(/remoto → local: baja lo que falte en este navegador \(con la clave cruda\)/);
    expect(app).toMatch(/local → remoto: archivos históricos\/agregados offline que faltan en la nube/);
    // anti-eco: durante el sync los hooks no suben lo recién bajado
    expect(app).toMatch(/if \(adjSyncBusy \|\| !client \|\| !FID \|\| FID === 'legacy'( \|\| !v)?\) return;\s*\n\s*client\.storage\.from\(ADJ_BUCKET\)/);
    // corre al abrir el módulo, al recuperar conexión y al volver a la pestaña
    expect(app).toMatch(/alqAdjSync\(\); \/\* Bloque 4\.G/);
    expect(app).toMatch(/addEventListener\('online'[\s\S]{0,60}alqAdjSync\(\)/);
    expect(app).toMatch(/visibilitychange[\s\S]{0,200}=== 'visible'[\s\S]{0,80}alqAdjSync\(\)/);
    // fallback completo: sin Storage el módulo funciona como antes (local-only)
    expect(app).toMatch(/sin bucket\/policies → queda local-only/);
    // la DB local de adjuntos es ÚNICA del navegador (adm_files), no por usuario
    expect(app).toMatch(/La DB local del adjuntos es ÚNICA del navegador \(adm_files/);
  });
});

test.describe('alquileres: auditoría 2026-11-16 (post revert del borrado por fila)', () => {
  const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  let core;
  test.beforeAll(() => { core = read('assets/js/alquileres-core.js'); });

  test('edición #9: el cierre de mes NO cambia la identidad FID (carpeta de Storage)', () => {
    // FID = user.id (init del controlador) y es la CARPETA del bucket
    // alquileres-adj/<uid>/. El FID=nid() original del standalone (un id por
    // archivo mensual) en el módulo corrompía la identidad tras cada cierre:
    // el guard FID==='legacy' del controlador pasaba y el sync de adjuntos
    // subía/listaba en una carpeta f<random> que la RLS rechaza (403) —
    // comprobantes nuevos quedaban solo locales hasta recargar la página.
    expect(core.includes('FID=nid()')).toBe(false);
    expect(core.includes('FID = nid()')).toBe(false);
    // el cierre de mes sigue forzando el guardado — y desde la navegación sin
    // pérdida (2026-11-17) TAMBIÉN el retroceso: LAST=null + guardarArchivo
    // son incondicionales al final de mesMas (el S.live del mes que se deja
    // tiene que llegar a la nube sí o sí)
    expect(core).toMatch(/render\(\);LAST=null;guardarArchivo\(\)\}/);
    expect(core).not.toMatch(/if\(d>0\)\{LAST=null;guardarArchivo\(\)\}/);
  });

  test('hardening XSS: cod/dir/inq/prop/nombre de archivo escapados en render/resumen/verFX', () => {
    // option + optgroup del selector de propiedades (render)
    expect(core).toMatch(/<optgroup label="Propietario \$\{esc\(go\)\}: \$\{esc\(p\.prop\|\|'sin nombre'\)\}">/);
    expect(core).toMatch(/<option value="\$\{esc\(p\.id\)\}">\$\{esc\(p\.cod\)\} · \$\{esc\(p\.dir\)\}\$\{p\.inq\?' — '\+esc\(p\.inq\):''\}<\/option>/);
    // filas del resumen mensual
    expect(core).toMatch(/<tr><td>\$\{esc\(p\.cod\)\} \$\{esc\(p\.dir\)\}<\/td><td>\$\{esc\(p\.inq\)\}/);
    // nombre del archivo de factura en la tabla de facturas leídas (verFX)
    expect(core).toMatch(/<tr><td>\$\{esc\(x\.f\)\}<\/td><td colspan="2"/);
    expect(core).toMatch(/· \$\{esc\(x\.f\)\}<br><small>Cuenta/);
  });

  test('Bloque 1.H: la semántica del conflicto es remoteMs !== localMs (cualquier cambio remoto)', () => {
    // Decisión de la auditoría: NO relajar a remoteMs > localMs. Tras un
    // guardado propio el remote y rowStamp son el MISMO instante (el upsert
    // manda updated_at y la tabla no tiene trigger que lo pise), así que !==
    // sólo dispara cuando la fila remota cambió de verdad desde nuestro
    // último stamp conocido — incluidas escrituras de otro dispositivo con
    // reloj atrasado, que con > se pisarían en silencio (sobreescritura sin
    // aviso). Cambiar a > reabriría esa ventana: el guard falla si vuelve.
    const app = read('assets/js/alquileres-app.js');
    expect(app).toMatch(/remoteMs !== localMs/);
    expect(app).not.toMatch(/remoteMs > localMs|remoteMs >= localMs/);
  });
});

test.describe('alquileres: auditoría 2026-11-18 (fixes de los 12 hallazgos)', () => {
  let core, app, snapSql;
  test.beforeAll(() => {
    core = read('assets/js/alquileres-core.js');
    app = read('assets/js/alquileres-app.js');
    snapSql = read('supabase/migrations/20261118000001_alquileres_snapshots_hardening_retention.sql');
  });

  test('P3 #6: el concepto de los ítems extra y "última actualización" van escapados', () => {
    // p.ex[].c se inyectaba en un atributo SIN esc() → un valor con " rompía
    // el atributo (misma clase que se endureció en 4 puntos el 16/11).
    expect(core).toMatch(/data-p="ex\.\$\{i\}\.c" value="\$\{esc\(e\.c\)\}"/);
    expect(core).not.toMatch(/data-p="ex\.\$\{i\}\.c" value="\$\{e\.c\}"/);
    // p.ult (concatenado en texto) también va escapado
    expect(core).toMatch(/Última actualización: '\+esc\(p\.ult\)/);
    expect(core).not.toMatch(/Última actualización: '\+p\.ult/);
  });

  test('P2 #3: importar() deja un RESPALDO previo antes de reemplazar el estado', () => {
    // Antes pisaba el estado sin red de seguridad (a diferencia de "Restaurar
    // respaldo", que sí llama __ALQ_SNAPSHOT_PRE).
    expect(core).toMatch(/if\(window\.__ALQ_SNAPSHOT_PRE\)try\{await window\.__ALQ_SNAPSHOT_PRE\('Antes de importar '\+f\.name\)\}catch\(e\)\{\}/);
    // en las DOS ramas: archivo .html embebido y archivo .json
    const ocurrencias = (core.match(/Antes de importar /g) || []).length;
    expect(ocurrencias, 'el respaldo previo debe estar en ambas ramas del import').toBeGreaterThanOrEqual(2);
    // el import normaliza el estado importado (bhInitS) como el resto del módulo
    expect(core).toMatch(/S\.props=S\.props\.map\(P\);bhInitS\(S\);mezclarHist\(\)/);
    // bhInitS debe ser tolerante: el JSON importado puede no traer `corr`
    // (si no, s.corr.dAgua reventaba al importar).
    expect(core).toMatch(/function bhInitS\(s\)\{s\.props=s\.props\.map\(P\);s\.corr=s\.corr\|\|\{\};/);
  });

  test('P3 #9: el espejo de localStorage es LIVIANO (no el estado completo)', () => {
    // Antes: 133 KB escritos de forma SÍNCRONA en cada edición (cuota 5-10 MB
    // por origen) y el try/catch lo silenciaba.
    expect(core).toMatch(/localStorage\.setItem\(dk\(\),JSON\.stringify\(\{saved:Date\.now\(\),kb:Math\.round\(j\.length\/1024\),props:/);
    expect(core).not.toMatch(/localStorage\.setItem\(dk\(\),JSON\.stringify\(\{saved:Date\.now\(\),j\}\)\)/);
    // el controlador escribe el mismo espejo liviano
    expect(app).toMatch(/localStorage\.setItem\(dk\(\), JSON\.stringify\(\{ saved: Date\.now\(\), kb: Math\.round\(snap\.length \/ 1024\), props:/);
    expect(app).not.toMatch(/localStorage\.setItem\(dk\(\), JSON\.stringify\(\{ saved: Date\.now\(\), j: snap \}\)\)/);
  });

  test('P3 #7: el módulo detecta un BUILD VIEJO cargado (banner + recarga)', () => {
    // El panel admin lo hace con checkStaleBuild(); el módulo no → una pestaña
    // vieja conservaba el core previo (el comportamiento que pisaba el
    // Historial antes del fix de la firma).
    expect(app).toMatch(/async function alqCheckStaleBuild\(\)/);
    expect(app).toMatch(/alquileres-core\\\.js/);
    expect(app).toMatch(/cache: 'no-store'/);
    expect(app).toMatch(/function alqStaleBanner\(curV, newV\)/);
    expect(app).toMatch(/Hay una versión nueva del módulo de alquileres/);
    expect(app).toMatch(/Recargar ahora/);
    expect(app).toMatch(/window\.location\.reload\(\)/);
    // se llama en el boot
    expect(app).toMatch(/alqCheckStaleBuild\(\);/);
    // sin IIFE (el guard anti-IIFE del módulo lo mataría)
    expect(app.includes('(() => {')).toBe(false);
  });

  test('P3 #4: UPDATE/DELETE de snapshots revocados a authenticated (inmutables)', () => {
    // El GRANT implícito de Supabase dejaba arwdDxtm; la intención de la
    // migración 20261114000004 era "sin UPDATE/DELETE" (no explotable: no hay
    // policies → la RLS bloquea toda fila, pero el ACL no coincidía).
    expect(snapSql).toMatch(/revoke update, delete on public\.alquileres_snapshots from authenticated;/i);
  });

  test('P3 #5: retención de snapshots — ARCHIVA antes de borrar (nada se borra sin copia)', () => {
    // tabla espejo de archivo, RLS ON sin policies (club service_role)
    expect(snapSql).toMatch(/create table if not exists public\.alquileres_snapshots_archive/);
    expect(snapSql).toMatch(/alter table public\.alquileres_snapshots_archive enable row level security/i);
    expect(snapSql).toMatch(/revoke all on public\.alquileres_snapshots_archive from anon/i);
    expect(snapSql).toMatch(/revoke all on public\.alquileres_snapshots_archive from authenticated/i);
    expect(snapSql).toMatch(/grant all on public\.alquileres_snapshots_archive to service_role/i);
    // función SECDEF con search_path vacío y sólo service_role
    expect(snapSql).toMatch(/create or replace function public\.bh_archive_alquileres_snapshots\(/);
    expect(snapSql).toMatch(/security definer/i);
    expect(snapSql).toMatch(/set search_path to ''/i);
    expect(snapSql).toMatch(/revoke all on function public\.bh_archive_alquileres_snapshots\(integer, integer\) from public/i);
    expect(snapSql).toMatch(/revoke all on function public\.bh_archive_alquileres_snapshots\(integer, integer\) from authenticated/i);
    expect(snapSql).toMatch(/grant execute on function public\.bh_archive_alquileres_snapshots\(integer, integer\) to service_role/i);
    // COPIA antes del DELETE (el orden importa: si se invierte, se pierde data)
    const ins = snapSql.indexOf('insert into public.alquileres_snapshots_archive');
    const del = snapSql.indexOf('delete from public.alquileres_snapshots');
    expect(ins, 'debe archivar antes de borrar').toBeGreaterThan(-1);
    expect(del, 'debe borrar de la tabla operativa').toBeGreaterThan(-1);
    expect(ins, 'el INSERT en el archivo tiene que ir ANTES del DELETE').toBeLessThan(del);
    // doble condición: antigüedad + fuera de los p_keep más recientes por usuario
    expect(snapSql).toMatch(/s\.created_at < now\(\) - make_interval\(days => greatest\(p_max_age_days, 0\)\)/);
    expect(snapSql).toMatch(/limit greatest\(p_keep, 0\)/);
    // cron diario junto con las demás retenciones
    expect(snapSql).toMatch(/cron\.schedule\(\s*'bh-alquileres-snapshots-retention',\s*'15 11 \* \* \*'/);
  });

  test('P2 #1 y #2: "administración activa" = props + datos de la inmobiliaria (corr.n)', () => {
    // Sin este criterio, la fila de PRUEBA (1 prop '001', sin corr) recibía
    // los recordatorios de cierre y podía tapar los KPIs del operador real.
    const fn = read('supabase/functions/alquileres-month-reminder/index.ts');
    expect(fn).toMatch(/\(st\.corr \|\| \{\}\)\.n/);
    // La RPC se corrige en una migración NUEVA (20261118000002): la 20261115000001
    // ya está aplicada en producción → editarla no llegaría a prod.
    const sql = read('supabase/migrations/20261118000002_alquileres_dashboard_kpis_active_admin.sql');
    expect(sql).toMatch(/create or replace function public\.alquileres_dashboard_kpis\(\)/);
    expect(sql).toMatch(/s\.state->'corr'->>'n'/);
    expect(sql).toMatch(/coalesce\(btrim\(s\.state->'corr'->>'n'\), ''\) <> ''/);
    // desempate determinista ante updated_at empatado
    expect(sql).toMatch(/order by s\.updated_at desc nulls last, s\.user_id/i);
    // los permisos no cambian (idem)
    expect(sql).toMatch(/revoke all on function public\.alquileres_dashboard_kpis\(\) from anon/i);
    expect(sql).toMatch(/grant execute on function public\.alquileres_dashboard_kpis\(\) to authenticated/i);
  });
});

test.describe('alquileres — navegación sin pérdida (harness behavioral)', () => {
  // Corre el core REAL con el SEED real (11 props) en un browser: adelante →
  // atrás → re-cierre, el flujo exacto del incidente del 17/11. No toca DB.
  test('adelante → atrás → adelante preserva TODO, mes por mes', async ({ page }) => {
    await page.goto('/tests/helpers/alquileres-nav-harness.html');
    const res = await page.evaluate(() => window.__RUN());
    expect(res.err, 'el harness no debe lanzar errores: ' + JSON.stringify(res)).toBeUndefined();
    expect(res.ok).toBe(true);
    // 1) cierre de Octubre → Noviembre derivado con la semántica de siempre
    expect(res.mTrasAdelante).toBe(10);
    expect(res.capturadoOct, 'el mes que se cierra queda copiado EXACTO en S.live').toBe(true);
    expect(res.histOct).toBe(true);
    expect(res.derivNovBlanca, 'servicios no-muni quedan en 0 en el mes derivado').toBe(true);
    expect(res.exLimpioNov, 'extras blanqueados en el mes derivado').toBe(true);
    expect(res.muniConserva, 'impuesto municipal conserva su valor').toBe(true);
    expect(res.luzKaKc, 'luz lleva ka=kc (lectura congelada)').toBe(true);
    // 2) retroceso: Noviembre queda guardado y Octubre vuelve EXACTO
    expect(res.mTrasAtras).toBe(9);
    expect(res.capturadoNov, 'lo cargado en Noviembre queda en S.live al salir').toBe(true);
    expect(res.octRestaurado, 'Octubre se restaura idéntico (copia viva, no roundtrip)').toBe(true);
    // 3) re-cierre: Noviembre vuelve con TODO lo cargado (el bug de Danilo, corregido)
    expect(res.mTrasReAdelante).toBe(10);
    expect(res.novRestaurado, 'Noviembre se restaura tal como se dejó').toBe(true);
    expect(res.histOctEstable, 're-cerrar no altera el historial capturado').toBe(true);
    // 4) avisos del confirm
    expect(res.sinAvisoSiNoCambio, 'un re-cierre SIN cambios no debe avisar ni pisar el historial').toBe(true);
    expect(res.avisoSiCambio, 'un re-cierre CON cambios reales debe avisar').toBe(true);
    expect(res.avisoDiceRespaldos).toBe(true);
    expect(res.avisoNoCierraParaGuardar, 'el confirm debe aclarar que no hace falta cerrar para guardar').toBe(true);
    expect(res.histNovReescrito, 'con cambios reales el historial sí se actualiza').toBe(true);
    expect(res.volverAviso).toBe(true);
    expect(res.mTrasCierreNov).toBe(11);
    // 5) cambio de año
    expect(res.yTrasAnioNuevo).toBe(2027);
    expect(res.liveAnioNuevo).toBe(true);
  });
});

test.describe('alquileres — comprobantes de pago (2026-11-17, pedido del dueño)', () => {
  const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  let core, app;
  test.beforeAll(() => {
    core = read('assets/js/alquileres-core.js');
    app = read('assets/js/alquileres-app.js');
  });

  test('familia pc:<pid>:<mes>:<uid> + metadata en el estado (p.comprobantes[mes])', () => {
    // La clave es cruda (con ':') — es la identidad del objeto en Storage
    // alquileres-adj/<uid>/ (ida y vuelta EXACTA, igual que pg:/f:).
    expect(core).toMatch(/'pc:'\+p\.id\+':'\+m\+':'\+uid\(\)/);
    // metadata mínima {k, arch, tipo} en una lista plana por mes
    expect(core).toMatch(/l\.push\(\{k:kk,arch:f\.name,tipo:f\.type\|\|''\}\)/);
    // el mes sale de fmv() (mismo selector FM que las facturas) y la lista
    // se crea lazy (los estados viejos del JSONB no tienen comprobantes)
    expect(core).toMatch(/subirComps\(fs\)\{if\(!fs\|\|!fs\.length\)return;const p=cur\(\),m=fmv\(\);p\.comprobantes=p\.comprobantes\|\|\{\};p\.comprobantes\[m\]=p\.comprobantes\[m\]\|\|\[\]/);
    // un archivo que falla en IndexedDB NO deja metadata huérfana (continue)
    expect(core).toMatch(/catch\(e\)\{errs\+\+;continue\}/);
  });

  test('REGRESIÓN 19/11: subida de VARIOS comprobantes en una operación (bug del empleador)', () => {
    /* El input#pc tiene `multiple`, pero el onchange limpiaba el input con
       value='' → eso VACÍA el FileList (es una lista VIVA) mientras el for..of
       estaba suspendido en el await de IndexedDB → el loop terminaba después
       del PRIMER archivo. El Update complained: "sólo se puede subir uno a
       la vez". Fix: copiar el listado a un array real ANTES de cualquier
       await (mismo criterio que cargarAgua, que recibe [...this.files]). */
    expect(core).toMatch(/const arr=Array\.from\(fs\);/);
    expect(core).toMatch(/for\(const f of arr\)/);
    // el onchange pasa un array real (igual que las facturas: cargarAgua([...this.files]))
    expect(core).toMatch(/onchange="subirComps\(\[\.\.\.this\.files\]\);this\.value=''"/);
    // los errores se avisan UNA vez (con N archivos, N alerts saturaban la pantalla)
    expect(core).toMatch(/if\(errs\)alert\(errs==1\?/);
    // NO debe quedar el alert por archivo (el que rompía la pantalla)
    expect(core).not.toMatch(/catch\(e\)\{alert\('No pude guardar el archivo en este navegador\.'\);continue\}/);
  });

  test('UI: card propia "Comprobantes de pago" al lado de Facturas cargadas', () => {
    // Layout pedido por el dueño: las dos cards van lado a lado (grid .duo),
    // "Comprobantes de pago" a la DERECHA de "Facturas cargadas".
    expect(core).toContain('<div class="duo"><div class="card"><h3>Facturas cargadas</h3>');
    expect(core).toContain('</div><div class="card"><h3>Comprobantes de pago</h3>');
    // la card de comprobantes tiene su propio selector de mes (mismo FM)
    expect(core).toMatch(/<h3>Comprobantes de pago<\/h3>\$\{\(\(\)=>\{const ms=mesesDoc\(p\),m=fmv\(\),cs=\(p\.comprobantes\|\|\{\}\)\[m\]\|\|\[\];return`<div style="max-width:260px;margin-bottom:8px"><label>Mes<\/label><select onchange="FM=this\.value;CV=null;render\(\)">/);
    // mismo input único id="pc" (accept PDF + imágenes, multiple)
    expect(core).toMatch(/<input id="pc" type="file" accept="\.pdf,image\/\*" multiple hidden onchange="subirComps\(\[\.\.\.this\.files\]\);this\.value=''">/);
    // el botón dice que se pueden elegir varios (el empleador lo pidió)
    expect(core).toContain('Subir comprobantes (PDF o imagen, varios a la vez)');
    // filas con esc() (hardening XSS — nombre de archivo de usuario)
    expect(core).toMatch(/<b>\$\{i\+1\}<\/b> · \$\{esc\(c\.arch\)\}<\/td><td><button class="s" onclick="verComp\(\$\{i\}\)">/);
    expect(core).toMatch(/onclick="quitarComp\(\$\{i\}\)">Quitar<\/button>/);
    // estado vacío explicativo
    expect(core).toContain('Sin comprobantes este mes. Podés subir PDFs o fotos');
    // el template de la card debe cerrar BIEN: un '})()}' sin cerrar se
    // imprimía literal en pantalla (bug encontrado por el screenshot).
    expect(core).not.toMatch(/<\/small>'\}\)\(\)\}/);
    expect(core).toMatch(/<\/small>'\}<p class="ac"/);
  });

  test('layout: grid .duo (2 columnas, responsive) en la CSS de alquileres.html', () => {
    const html = read('alquileres.html');
    expect(html).toMatch(/\.duo\{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start;margin-bottom:12px\}/);
    // en pantallas angostas se apila en una columna
    expect(html).toMatch(/@media\(max-width:900px\)\{\.duo\{grid-template-columns:1fr\}\}/);
    // las cards del grid no acumulan margin (el gap ya separa)
    expect(html).toMatch(/\.duo>\.card\{margin-bottom:0;min-width:0\}/);
    // el listado de meses es el MISMO en las dos cards (unión facturas+comprobantes)
    expect(core).toMatch(/function mesesDoc\(p\)\{return\[\.\.\.new Set\(\[ym\(\),\.\.\.Object\.keys\(p\.facturas\|\|\{\}\),\.\.\.Object\.keys\(p\.comprobantes\|\|\{\}\)\]\)\]\.sort\(\)\.reverse\(\)\}/);
    expect(core).toContain('const ms=mesesDoc(p),m=fmv(),fs=');
  });

  test('visor: imagen → <img>, resto → iframe; revoca el blob URL viejo antes de reemplazar', () => {
    // rama del visor sólo para claves pc: de la propiedad abierta
    expect(core).toMatch(/CV&&CV\.key\.startsWith\('pc:'\+p\.id\+':'\)\?\(CV\.img\?`<img src="\$\{CV\.url\}"/);
    expect(core).toMatch(/:`<iframe src="\$\{CV\.url\}" style="width:100%;height:640px[^`]*"><\/iframe>`\):''/);
    // detección de imagen por el tipo REAL del blob (no confía en la metadata)
    expect(core).toMatch(/img:\/\^image\\\/\/\.test\(b\.type\|\|''\)/);
    // verComp: revoca el CV previo (factura/contrato/otro comprobante) ANTES de reemplazar
    expect(core).toMatch(/verComp\(i\)\{[\s\S]{0,320}if\(CV\)URL\.revokeObjectURL\(CV\.url\);CV=\{id:p\.id,key:c\.k,url:URL\.createObjectURL\(b\),img:/);
    // toggle y quitar cierran el visor con revocación
    expect(core).toMatch(/if\(CV&&CV\.key==c\.k\)\{URL\.revokeObjectURL\(CV\.url\);CV=null\}/);
  });

  test('quitarComp: confirm + borrado real de IndexedDB/Storage + splice', () => {
    expect(core).toMatch(/quitarComp\(i\)\{if\(!confirm\('¿Quitar este comprobante\?'\)\)return;const p=cur\(\),m=fmv\(\),l=\(p\.comprobantes\|\|\{\}\)\[m\]\|\|\[\],c=l\[i\];if\(!c\)return;await idbDo\('del',c\.k\);/);
    expect(core).toMatch(/l\.splice\(i,1\);render\(\)\}/);
  });

  test('sin colisión de nombres y el hook de Storage NO filtra por prefijo', () => {
    // las 3 funciones nuevas se declaran UNA vez y el app no las redeclara
    for (const fn of ['subirComps', 'verComp', 'quitarComp']) {
      const mCore = core.match(new RegExp('^async function ' + fn + '\\(', 'm'));
      expect(mCore, fn + ' declarada en el core a columna 0').toBeTruthy();
      expect(app).not.toMatch(new RegExp('function ' + fn + '\\('));
    }
    // __ALQ_ADJ_UP sube CUALQUIER clave (sin startsWith) — si alguien agrega un
    // filtro de familias, los comprobantes pc: dejarían de viajar a Storage.
    const iUp = app.indexOf('window.__ALQ_ADJ_UP');
    expect(iUp).toBeGreaterThan(-1);
    const cuerpo = app.slice(iUp, app.indexOf('window.__ALQ_ADJ_DEL', iUp));
    expect(cuerpo).not.toMatch(/startsWith\(/);
  });

  test('behavioral (core real): subir PDF+imagen → read-back IndexedDB → visor → quitar', async ({ page }) => {
    await page.goto('/tests/helpers/alquileres-comps-harness.html');
    const res = await page.evaluate(() => window.__RUN());
    expect(res.err, 'el harness no debe lanzar errores: ' + JSON.stringify(res)).toBeUndefined();
    expect(res.ok).toBe(true);
    // 1) subir: 2 comprobantes con metadata y claves pc:<pid>:<mes>:<uid>
    expect(res.cantTrasSubir).toBe(2);
    expect(res.metadatos).toEqual([
      { arch: 'recibo.pdf', tipo: 'application/pdf' },
      { arch: 'foto.png', tipo: 'image/png' },
    ]);
    expect(res.clavesConPrefijo).toBe(true);
    // 2) read-back REAL: los blobs sobreviven a la ida y vuelta de IndexedDB
    expect(res.pdfType).toBe('application/pdf');
    expect(res.pdfSize).toBeGreaterThan(0);
    expect(res.imgType).toBe('image/png');
    // 3) visor: imagen → img, pdf → iframe (mismo CV compartido, uno a la vez)
    expect(res.cvImg).toEqual({ key: true, img: true, tieneUrl: true });
    expect(res.cvPdf).toEqual({ key: true, img: false });
    // 4) toggle off
    expect(res.cvCerrado).toBe(true);
    // 5) scoping por mes: el comprobante subido con FM=2026-09 va a septiembre
    expect(res.sep).toEqual(['recibo-septiembre.png']);
    // 6) quitar: confirm, splice y borrado real de IndexedDB
    expect(res.cantTrasQuitar).toBe(1);
    expect(res.confirmLlamado).toBe(true);
    expect(res.idbBorrado).toBe(true);
    expect(res.quedo).toBe('foto.png');
    // 7) render de la ficha: sin basura textual, input único, botón y 2 cards
    expect(res.sinBasura, 'la ficha no debe imprimir basura de template').toBe(true);
    expect(res.inputPc).toBe(1);
    expect(res.botonSubir).toBe(true);
    expect(res.duoCards).toBe(2);
    expect(res.tituloComps).toBe(true);
    // 8) REGRESIÓN: el flujo REAL del input (FileList vivo + value='')
    //    guarda TODOS los archivos elegidos en una sola operación.
    expect(res.inputMultiple, 'el input#pc debe seguir con multiple').toBe(true);
    expect(res.filesElegidos).toBe(3);
    expect(res.guardadosEnUnaOperacion, 'con 3 archivos elegidos se deben guardar 3 (bug: se guardaba 1)').toBe(3);
    expect(res.nombresEnUnaOperacion).toEqual(['lote-1.pdf', 'lote-2.pdf', 'lote-3.png']);
    expect(res.idaYVuelta, 'los 3 blobs tienen que estar en IndexedDB').toBe(true);
    // sin alerts inesperados (fallas silenciosas de idbDo)
    expect(res.alerts).toEqual([]);
  });
});
