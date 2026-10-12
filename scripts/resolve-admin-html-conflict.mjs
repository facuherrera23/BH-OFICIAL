// Resolución de conflicto de rebase para admin.html — encoding-safe (NUNCA PowerShell).
// Estrategia: mi lado (limpio) + las versiones del lado HEAD cuando son MÁS ALTAS.
import { readFileSync, writeFileSync } from 'node:fs';

let c = readFileSync('admin.html', 'utf8');
const assert = (cond, msg) => { if (!cond) { console.error('FALLO: ' + msg); process.exit(1); } };

const conflictRe = /<<<<<<< HEAD\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> [^\r\n]*/g;
let count = 0;
const versOf = (s) => { const o = new Map(); for (const x of s.matchAll(/([\w.-]+\.(?:js|css))\?v=(\d+)/g)) o.set(x[1], Number(x[2])); return o; };

c = c.replace(conflictRe, (_full, ours, theirs) => {
  count++;
  const headVers = versOf(ours);
  const myVers = versOf(theirs);
  let merged = theirs;
  for (const [asset, headV] of headVers) {
    const myV = myVers.get(asset);
    if (myV === undefined) continue;
    const best = Math.max(headV, myV);
    const re = new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\?v=\\d+');
    merged = merged.replace(re, `${asset}?v=${best}`);
  }
  return merged;
});
assert(count > 0, 'no se encontró ningún bloque de conflicto');
console.log('Conflictos resueltos: ' + count);

// Verificación total del archivo resuelto
const moji = (c.match(/\u00c3[\u00b3\u00a9\u00ad\u00b1\u00ba]/g) || []).length;
assert(moji === 0, 'el archivo resuelto contiene mojibake (' + moji + ')');
assert(!c.includes('<<<<<<<') && !c.includes('>>>>>>>'), 'quedan marcadores de conflicto');
const mustHave = [
  'id="portalLinkModal"', 'Acceso Portal</button>', 'Días de validez',
  'id="inputPromptModal"', 'Centro de Supervisión',
  'assets/js/admin-crm.js?v=50', 'assets/js/admin-propietarios.js?v=15',
  'assets/js/utils.js?v=141', 'assets/js/config.js?v=142',
  'assets/js/supabase-client.js?v=141', 'assets/js/cloudinary.js?v=143',
];
for (const s of mustHave) assert(c.includes(s), 'falta: ' + s);
const lines = c.split('\n').length;
console.log('Resuelto: ' + lines + ' líneas, mojibake=' + moji + ', correctos=' + (c.match(/[\u00f3\u00e1\u00e9\u00ed\u00f1\u00fa]/g) || []).length);

writeFileSync('admin.html', c, 'utf8');
console.log('admin.html resuelto y escrito con node (encoding UTF-8 seguro)');
