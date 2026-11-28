/* Auditor de "identificadores no declarados" — análisis REAL de scopes.
 *
 * ══ Por qué existe ══════════════════════════════════════════════════════
 * El 2026-11-27 el usuario reportó en producción:
 *     "Error al cargar prospecto: suggestHtml is not defined"
 * al abrir CUALQUIER lead del CRM.
 *
 * La causa: el commit a4065e9 (tarjeta de "siguiente mejor acción")
 * reemplazó `var suggestHtml = '';` por dos líneas nuevas y OLVIDÓ la
 * declaración. admin-crm.js corre dentro de una IIFE con 'use strict', así
 * que la asignación sin `var` a un identificador no declarado (y su lectura
 * posterior) es un ReferenceError en RUNTIME → el panel nunca abría.
 *
 * Por qué los guards anteriores NO lo atraparon:
 *   · `node --check` sólo valida sintaxis (el archivo estaba perfecto).
 *   · Los tests estáticos buscaban strings: `suggestHtml` seguía
 *     apareciendo en el archivo, sólo que sin declarar.
 *   · El bug sólo se manifiesta cuando renderSide() corre de verdad.
 *
 * ══ Qué detecta ════════════════════════════════════════════════════════
 * Toda asignación `x = ...` (o `x++`, o `for (x of ...)`) donde `x` NO
 * está bound en ningún scope visible (bloque/función) y NO es un global.
 * En strict mode eso es un ReferenceError garantizado.
 *
 * ══ Cómo ═══════════════════════════════════════════════════════════════
 * Parseo con acorn (el parser real de V8, incluido en Node) y construyo
 * los scopes como los define ECMAScript. Sin heurísticas y sin falsos
 * positivos: si el detector marca algo, V8 lo lanza.
 *
 * Lo que cuenta como EXISTENTE:
 *   · bindings de cualquier scope (var/let/const/class, params, catch,
 *     function, destructuring)
 *   · propiedades del global object expuestas por el repo
 *     (`window.X =`, `Object.defineProperty(window,'X')`, `__bhAccessor('X')`):
 *     en strict mode `X = ...` a secas RESUELVE contra la propiedad global.
 *   · intrínsecos del browser.
 *
 * ══ Uso ════════════════════════════════════════════════════════════════
 *   node --expose-internals tests/helpers/audit-undeclared.cjs assets/js
 *
 * Imprime (stdout) un JSON array con los hallazgos:
 *   [{"archivo":"admin-crm.js","linea":2507,"col":4,"ident":"suggestHtml"}]
 * Si acorn no está disponible imprime NO_ACORN (el test se omite).
 */
'use strict';
const fs = require('fs');
const path = require('path');

let acorn;
try {
  /* acorn viene dentro de Node; hace falta --expose-internals para
     alcanzarlo. El spec lo invoca así. */
  acorn = require('internal/deps/acorn/acorn/dist/acorn');
} catch (e) {
  process.stdout.write('NO_ACORN\n');
  process.exit(2);
}

/* Globales del browser que se pueden usar sin declarar. */
const GLOBALS_BROWSER = new Set([
  'window','document','globalThis','console','Math','JSON','Object','Array','String','Number',
  'Boolean','Date','Promise','Set','Map','WeakMap','WeakSet','RegExp','Error','TypeError','RangeError',
  'SyntaxError','ReferenceError','parseInt','parseFloat','isNaN','isFinite','setTimeout','setInterval',
  'clearTimeout','clearInterval','requestAnimationFrame','cancelAnimationFrame','fetch','alert',
  'confirm','prompt','history','location','navigator','localStorage','sessionStorage','customElements',
  'HTMLElement','Element','Node','NodeList','URL','URLSearchParams','AbortController','Event',
  'CustomEvent','FormData','Blob','File','FileReader','Image','Notification','performance','crypto',
  'TextEncoder','TextDecoder','structuredClone','queueMicrotask','Proxy','Reflect','Symbol','BigInt',
  'Intl','WeakRef','atob','btoa','supabase','request','response','arguments','this','undefined','NaN',
  'Infinity','name','status','origin','length','top','parent','self','frames','closed','opener',
  'scrollX','scrollY','innerWidth','innerHeight','outerWidth','outerHeight','screen','visualViewport',
  'CSS','CSSStyleSheet','MutationObserver','IntersectionObserver','ResizeObserver','AbortSignal',
  'DOMParser','XMLHttpRequest','Headers','Request','Response','DataTransfer','DragEvent','ClipboardItem',
  'Audio','ImageData','Path2D','TextMetrics','CanvasRenderingContext2D',
]);

function* children(node) {
  for (const key of Object.keys(node)) {
    if (['type','start','end','loc','range','raw','sourceType'].includes(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') yield c;
    } else if (v && typeof v.type === 'string') {
      yield v;
    }
  }
}

/* Nombres declarados por un patrón (destructuring incluido). */
function collectPattern(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': out.add(node.name); break;
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') collectPattern(p.argument, out);
        else collectPattern(p.value, out);
      }
      break;
    case 'ArrayPattern': for (const e of node.elements) collectPattern(e, out); break;
    case 'AssignmentPattern': collectPattern(node.left, out); break;
    case 'RestElement': collectPattern(node.argument, out); break;
    default: break;
  }
}

/* Globales declarados por el repo (window.X / defineProperty / accessors). */
function globalsDelRepo(dir) {
  const g = new Set();
  const recorrer = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (['node_modules', '.git', 'fichas', 'test-results', '.codegraph'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { recorrer(p); continue; }
      if (!/\.(js|html|mjs)$/.test(e.name)) continue;
      let raw;
      try { raw = fs.readFileSync(p, 'utf8'); } catch (err) { continue; }
      for (const m of raw.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) g.add(m[1]);
      for (const m of raw.matchAll(/\bglobalThis\.([A-Za-z_$][\w$]*)\s*=/g)) g.add(m[1]);
      for (const m of raw.matchAll(/defineProperty\(\s*window\s*,\s*'([A-Za-z_$][\w$]*)'/g)) g.add(m[1]);
      for (const m of raw.matchAll(/__bhAccessor\(\s*'([A-Za-z_$][\w$]*)'/g)) g.add(m[1]);
    }
  };
  recorrer(dir);
  return g;
}

/* Un archivo "aislado" está envuelto en una IIFE → su scope es propio y no
 * comparte nada con los demás scripts. Un archivo "top-level" comparte el
 * scope global de la página con los otros scripts top-level (patrón del
 * módulo ALQUILERES: core + app sin IIFE, a propósito). */
function archivoEsAislado(src) {
  try {
    const prog = acorn.parse(src, {
      ecmaVersion: 'latest', sourceType: 'script', locations: false,
      allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
      allowHashBang: true, allowSuperOutsideMethod: true,
    });
    if (prog.body.length !== 1) return false;
    const st = prog.body[0];
    if (st.type !== 'ExpressionStatement') return false;
    const e = st.expression;
    if (e.type !== 'CallExpression') return false;
    const callee = e.callee;
    if (callee.type === 'FunctionExpression' || callee.type === 'ArrowFunctionExpression') return true;
    /* `(function(){...})()` */
    if (callee.type === 'SequenceExpression') {
      const last = callee.expressions[callee.expressions.length - 1];
      return last && (last.type === 'FunctionExpression' || last.type === 'ArrowFunctionExpression');
    }
    return false;
  } catch (e) {
    return true; /* si no parsea, no lo exponemos como global compartido */
  }
}

/* Declaraciones a NIVEL DE SCRIPT (compartidas con los otros scripts
 * top-level de la misma página). */
function declaracionesScriptLevel(src) {
  const out = new Set();
  let prog;
  try {
    prog = acorn.parse(src, {
      ecmaVersion: 'latest', sourceType: 'script', locations: false,
      allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
      allowHashBang: true, allowSuperOutsideMethod: true,
    });
  } catch (e) { return out; }
  for (const st of prog.body) {
    if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) collectPattern(d.id, out);
    } else if (st.type === 'FunctionDeclaration' && st.id) {
      out.add(st.id.name);
    } else if (st.type === 'ClassDeclaration' && st.id) {
      out.add(st.id.name);
    }
  }
  return out;
}

/* Globales compartidos entre scripts top-level de la misma página. */
function globalsCompartidos(dir) {
  const g = new Set();
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')); } catch (e) { return g; }
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { continue; }
    if (archivoEsAislado(src)) continue;
    for (const n of declaracionesScriptLevel(src)) g.add(n);
  }
  return g;
}

function nuevoScope(vars, isFunction, parent) {
  return { vars: vars || new Set(), isFunction: !!isFunction, parent: parent || null };
}

/* Análisis de un archivo → array de hallazgos. */
function analisarArchivo(nombre, src, globalsRepo) {
  const programa = acorn.parse(src, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    locations: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowHashBang: true,
    allowSuperOutsideMethod: true,
    allowImportExportEverywhere: true,
  });

  const pendientes = [];
  const reportar = (ident, loc, scope) => { if (loc) pendientes.push({ ident, loc, scope }); };

  const esVisible = (scope, ident) => {
    let s = scope;
    while (s) { if (s.vars.has(ident)) return true; s = s.parent; }
    return false;
  };
  const scopeFuncion = (scope) => {
    let s = scope;
    while (s) { if (s.isFunction) return s; s = s.parent; }
    return s;
  };

  const visitar = (node, scope, opts) => {
    if (!node) return;
    opts = opts || {};
    const esFuncion = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
                      node.type === 'ArrowFunctionExpression';

    if (esFuncion) {
      /* El nombre de una FunctionDeclaration se declara en el scope EXTERIOR
         (hoisted); el de una FunctionExpression, en su propio scope. */
      if (node.type === 'FunctionDeclaration' && node.id) scope.vars.add(node.id.name);
      const vars = new Set();
      for (const p of node.params) collectPattern(p, vars);
      if (node.type === 'FunctionExpression' && node.id) vars.add(node.id.name);
      const fnScope = nuevoScope(vars, true, scope);
      /* el BlockStatement de la función ES su scope (no uno extra) */
      for (const c of children(node)) {
        if (c.type === 'BlockStatement') visitar(c, fnScope, { esBodyDeFuncion: true });
        else visitar(c, fnScope, {});
      }
      return;
    }

    if (node.type === 'BlockStatement' && !opts.esBodyDeFuncion) {
      const blockScope = nuevoScope(new Set(), false, scope);
      for (const c of children(node)) visitar(c, blockScope, {});
      return;
    }

    if (node.type === 'CatchClause') {
      const cs = nuevoScope(new Set(), false, scope);
      collectPattern(node.param, cs.vars);
      for (const c of children(node)) visitar(c, cs, {});
      return;
    }

    if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      const loopScope = nuevoScope(new Set(), false, scope);
      for (const c of children(node)) visitar(c, loopScope, {});
      return;
    }

    if (node.type === 'VariableDeclaration') {
      const target = node.kind === 'var' ? scopeFuncion(scope) : scope;
      for (const d of node.declarations) collectPattern(d.id, target.vars);
      for (const c of children(node)) visitar(c, scope, {});
      return;
    }

    if (node.type === 'ClassDeclaration' && node.id) scope.vars.add(node.id.name);

    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      const left = node.left;
      if (left.type === 'Identifier') {
        reportar(left.name, left.loc, scope);
      } else if (left.type === 'ObjectPattern' || left.type === 'ArrayPattern') {
        const targets = new Set();
        collectPattern(left, targets);
        for (const t of targets) reportar(t, left.loc, scope);
      }
    }

    if (node.type === 'UpdateExpression' && node.argument && node.argument.type === 'Identifier') {
      reportar(node.argument.name, node.argument.loc, scope);
    }

    if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') &&
        node.left && node.left.type === 'Identifier') {
      reportar(node.left.name, node.left.loc, scope);
    }

    for (const c of children(node)) visitar(c, scope, {});
  };

  const root = nuevoScope(new Set(), true, null);
  visitar(programa, root, {});

  /* La visibilidad se resuelve DESPUÉS del recorrido: un `let` declarado más
     abajo en el mismo scope es legal (hoisting de bloque) y su binding ya
     existe cuando se ejecuta la asignación de arriba. */
  const hallazgos = [];
  for (const p of pendientes) {
    if (esVisible(p.scope, p.ident)) continue;
    if (GLOBALS_BROWSER.has(p.ident)) continue;
    if (globalsRepo.has(p.ident)) continue;
    hallazgos.push({
      archivo: nombre,
      linea: p.loc.start.line,
      col: p.loc.start.column,
      ident: p.ident,
    });
  }
  return hallazgos;
}

module.exports = { analisarArchivo, globalsDelRepo, globalsCompartidos, GLOBALS_BROWSER };

if (require.main === module) {
  const dir = process.argv[2] || path.join(__dirname, '..', '..', 'assets', 'js');
  const globals = globalsDelRepo(dir);
  /* Los scripts top-level (no envueltos en IIFE) comparten el scope global
     de la página: sus declaraciones de nivel de script son visibles para
     los demás (patrón del módulo ALQUILERES: core + app sin IIFE). */
  const compartidos = globalsCompartidos(dir);
  for (const n of compartidos) globals.add(n);
  const archivos = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const todos = [];
  for (const f of archivos) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    let h;
    try {
      h = analisarArchivo(f, src, globals);
    } catch (e) {
      /* Un archivo que no parsea (o un módulo ES con otro dialecto) no es un
         hallazgo de ESTA clase: se reporta aparte pero no rompe el barrido. */
      process.stderr.write('parse-error ' + f + ': ' + e.message + '\n');
      continue;
    }
    for (const x of h) todos.push(x);
  }
  process.stdout.write(JSON.stringify(todos, null, 2) + '\n');
}
