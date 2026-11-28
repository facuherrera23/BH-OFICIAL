// Guards de firmas de funciones y llamadas de cron (mejora 6, 28/11/2026).
//
// POR QUÉ: `CREATE OR REPLACE FUNCTION` con un parámetro MÁS no reemplaza la
// función: crea una SOBRECARGA. El cron `bh-archive-retention-daily` seguía
// llamando `public.bh_archive_ml_sync_queue_success()` y Postgres respondía
// `function ... is not unique` → 8/8 corridas fallidas y ningún archivado.
// El fix (20261128000001) puso la firma explícita, pero nada impedía que
// volviera a pasar: este spec Detecta sobrecargas nuevas y llamadas ambiguas.
//
// Sólo lectura de archivos: no toca la BD ni la red.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'supabase', 'migrations');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

/* Sobrecargas HISTÓRICAS ya auditadas en producción (verificadas con pg_proc):
   · generate_property_code: la de 2 args es usada por triggers internos;
   · las 3 de archivado: la migración 20261117000002 creó la de 3 args sin
     borrar la de 2 (ambas con todos los parámetros DEFAULT).
   Cualquier sobrecarga FUERA de esta lista es un fallo. */
const ALLOWED_OVERLOADS = {
  generate_property_code: [0, 2],
  bh_archive_ml_sync_queue_success: [2, 3],
  bh_archive_audit_log: [2, 3],
  bh_archive_ml_webhook_events: [2, 3],
};
const RETENTION_FNS = [
  'bh_archive_ml_sync_queue_success',
  'bh_archive_audit_log',
  'bh_archive_ml_webhook_events',
];

/* Quita comentarios sin romper literales ni cuerpos $tag$ (un `--` dentro de
   una URL o de un texto SQL no debe truncar la lectura de firmas). */
function stripComments(sql) {
  let out = '';
  let i = 0;
  let state = 'code';
  let tag = '';
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (state === 'code') {
      if (c === '-' && n === '-') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'single'; out += c; i++; continue; }
      if (c === '$') {
        const m = /^\$(-?[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
        if (m) { tag = m[0]; state = 'dollar'; out += tag; i += tag.length; continue; }
      }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { out += c; state = 'code'; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c;
      i++; continue;
    }
    if (state === 'single') {
      out += c;
      if (c === "'" && n === "'") { out += n; i += 2; continue; }
      if (c === "'") state = 'code';
      i++; continue;
    }
    // dollar: copiar el cuerpo tal cual hasta la etiqueta de cierre
    if (sql.startsWith(tag, i)) { out += tag; i += tag.length; state = 'code'; continue; }
    out += c; i++;
  }
  return out;
}

function parseSig(s) {
  let depth = 0;
  let cur = '';
  const parts = [];
  for (const c of s) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  const list = parts.filter((p) => p.trim());
  const defaults = list.filter((p) => /\bDEFAULT\b/i.test(p)).length;
  return { arity: list.length, min: list.length - defaults, max: list.length };
}

const CREATE_RE = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_][\w]*)\s*\(([\s\S]*?)\)\s*RETURNS/gi;
const DROP_RE = /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-z_][\w]*)\s*\(([\s\S]*?)\)\s*;/gi;

/* Estado FINAL de las firmas después de aplicar TODAS las migraciones. */
const signatures = new Map();
const newOverloads = [];
const missingDrops = [];
for (const file of FILES) {
  const sql = stripComments(fs.readFileSync(path.join(DIR, file), 'utf8'));
  for (const m of sql.matchAll(DROP_RE)) {
    const name = m[1].toLowerCase();
    const sig = parseSig(m[2]);
    const entry = signatures.get(name);
    if (entry && entry.has(sig.arity)) entry.delete(sig.arity);
    else missingDrops.push({ file, name, arity: sig.arity });
  }
  for (const m of sql.matchAll(CREATE_RE)) {
    const name = m[1].toLowerCase();
    const sig = parseSig(m[2]);
    const entry = signatures.get(name) || new Map();
    // Sólo es sobrecarga si el nombre YA tenía otra firma: el primer CREATE
    // de cada función es su definición original, no un bug.
    if (entry.size > 0 && !entry.has(sig.arity)) {
      const allowed = ALLOWED_OVERLOADS[name] || [];
      if (!allowed.includes(sig.arity)) {
        newOverloads.push({ file, name, arity: sig.arity, known: [...entry.keys()] });
      }
    }
    entry.set(sig.arity, { ...sig, file });
    signatures.set(name, entry);
  }
}

/* Última llamada de cada función dentro de un cron (command de cron.job).
   Se toma la ÚLTIMA porque un job puede haber sido corregido después. */
const cronCalls = new Map();
for (const file of FILES) {
  const sql = stripComments(fs.readFileSync(path.join(DIR, file), 'utf8'));
  for (const m of sql.matchAll(/cron\.(?:schedule|alter_job)\s*\(/gi)) {
    const window = sql.slice(m.index, m.index + 2500);
    for (const call of window.matchAll(/public\.([a-z_][\w]*)\s*\(([^)]*)\)/gi)) {
      const name = call[1].toLowerCase();
      const args = call[2].trim();
      cronCalls.set(name, { argc: args === '' ? 0 : args.split(',').length, file });
    }
  }
}

function candidatesFor(name, argc) {
  const entry = signatures.get(name);
  if (!entry) return [];
  return [...entry.values()].filter((s) => s.min <= argc && argc <= s.max);
}

test.describe('firmas de funciones y crons — guard anti-sobrecarga', () => {
  test('no hay sobrecargas nuevas fuera de la lista histórica auditada', () => {
    expect(newOverloads, JSON.stringify(newOverloads)).toEqual([]);
  });

  test('las cuatro sobrecargas históricas siguen siendo las conocidas', () => {
    for (const [name, arities] of Object.entries(ALLOWED_OVERLOADS)) {
      const vivas = [...(signatures.get(name)?.keys() || [])].sort((a, b) => a - b);
      expect(vivas, `${name}: ${JSON.stringify(vivas)}`).toEqual(arities.slice().sort((a, b) => a - b));
    }
  });

  test('ninguna función tiene más de una firma viva sin estar en la lista', () => {
    for (const [name, entry] of signatures) {
      if (entry.size > 1) expect(ALLOWED_OVERLOADS[name], `${name} quedó sobrecargada`).toBeTruthy();
    }
  });

  test('todo DROP FUNCTION apunta a una firma que realmente existía', () => {
    expect(missingDrops, JSON.stringify(missingDrops)).toEqual([]);
  });

  test('los crons NO llaman a una función con firma ambigua', () => {
    const ambiguas = [];
    for (const [name, call] of cronCalls) {
      const n = candidatesFor(name, call.argc).length;
      if (n > 1) ambiguas.push({ name, ...call, candidatas: n });
    }
    expect(ambiguas, JSON.stringify(ambiguas)).toEqual([]);
  });

  test('el cron de retención llama con la firma explícita de 3 argumentos', () => {
    for (const fn of RETENTION_FNS) {
      expect(cronCalls.get(fn)?.argc, `${fn}: el cron no usa los 3 argumentos`).toBe(3);
    }
  });

  test('las migrations de las mejoras 3-5 no cambiaron ninguna firma', () => {
    const nuevas = FILES.filter((f) => /^2026112800001[456]_/.test(f));
    expect(nuevas).toHaveLength(3);
    for (const file of nuevas) {
      const sql = stripComments(fs.readFileSync(path.join(DIR, file), 'utf8'));
      expect(sql, `${file}: no debe haber DROP FUNCTION`).not.toMatch(/DROP\s+FUNCTION/i);
      for (const m of sql.matchAll(CREATE_RE)) {
        const name = m[1].toLowerCase();
        const sig = parseSig(m[2]);
        expect(signatures.get(name)?.has(sig.arity), `${file}: ${name}/${sig.arity}`).toBe(true);
      }
    }
  });
});
