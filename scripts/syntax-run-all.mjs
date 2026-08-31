// Importa cada index.ts del sandbox prepado (import dinámico serial) y reporta
// solo errores de SINTAXIS. Errores de runtime (stub vacío, Deno ausente) se ignoran.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'os';

const root = join(os.tmpdir(), 'bh-syntax', 'functions');
const files = [];
for (const d of readdirSync(root, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const p = join(root, d.name, 'index.ts');
  try { readdirSync(join(root, d.name)); files.push(p); } catch {}
}

let failed = 0;
for (const f of files) {
  try {
    await import(pathToFileURL(f).href);
    console.log('OK  ', f.split(/\\functions\\|\\functions\//)[1]?.split(/[\\/]/)[0]);
  } catch (e) {
    if (e instanceof SyntaxError) {
      failed++;
      console.log('SYNTAX FAIL', f, e.message);
    } else {
      console.log('OK  (runtime err esperado)', f.split(/[\\/]/).slice(-2)[0], '-', e.message.split('\n')[0].slice(0, 60));
    }
  }
}
console.log(failed ? `SYNTAX FAILURES: ${failed}` : 'ALL SYNTAX OK');
