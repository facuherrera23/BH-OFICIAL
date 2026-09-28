#!/usr/bin/env node
/**
 * Bump automatico de cache busters (?v=N) en los HTML del root.
 * Sube ?v=N de cada asset css/js local que tenga cambios sin commitear
 * (git diff --name-only HEAD, staged + unstaged). Ejecutar antes de commit:
 *   npm run bump
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
let changed = new Set();
try {
  const out = execSync('git diff --name-only HEAD', { cwd: root, encoding: 'utf8' });
  changed = new Set(out.split(/\r?\n/).filter(Boolean).map(p => p.replace(/\\/g, '/')));
} catch {
  console.error('bump-busters: no se pudo correr git diff (¿no es un repo?). No se modifica nada.');
  process.exit(1);
}

if (changed.size === 0) {
  console.log('bump-busters: sin cambios pendientes, nada que subir.');
  process.exit(0);
}

const htmlFiles = readdirSync(root).filter(f => f.endsWith('.html'));
const refRe = /((?:assets\/(?:js|css)\/[A-Za-z0-9._-]+\.(?:js|css)))(\?v=(\d+))?/g;
let bumped = [];

for (const html of htmlFiles) {
  const path = join(root, html);
  let text = readFileSync(path, 'utf8');
  let touched = false;
  text = text.replace(refRe, (m, asset, vGroup, vNum) => {
    if (!changed.has(asset)) return m;
    const next = String(parseInt(vNum || '0', 10) + 1);
    bumped.push(`${html}: ${asset} ${vNum || '(sin v)'} -> v=${next}`);
    touched = true;
    return `${asset}?v=${next}`;
  });
  if (touched) writeFileSync(path, text);
}

if (bumped.length === 0) {
  console.log('bump-busters: ningun asset referenciado en HTML tiene cambios pendientes.');
} else {
  console.log('bump-busters: cache busters actualizados:');
  for (const line of bumped) console.log('  ' + line);
  console.log('Recorda commitear los HTML junto con los assets.');
}
