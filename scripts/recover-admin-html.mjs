// Recuperación de admin.html: reconstruye el archivo desde la última base LIMPIA
// (c3467e2) + los cambios legítimos hechos después, TODO con encoding UTF-8 seguro.
// La corrupción entró por resoluciones de rebase con Get-Content/Set-Content de
// PowerShell 5.1 (UTF-8 leído como CP1252 y re-escrito como UTF-8 = doble encoding).
// Este script reemplaza ese flujo: git show → string UTF-8 → fs.writeFileSync UTF-8.
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const BASE_SHA = 'c3467e2';
let html = execSync(`git show ${BASE_SHA}:admin.html`, { encoding: 'utf8', maxBuffer: 20971520 });

const assert = (cond, msg) => { if (!cond) { console.error('FALLO: ' + msg); process.exit(1); } };

// 1) La base debe estar limpia y contener los anclas esperados
const mojiBase = (html.match(/\u00c3[\u00b3\u00a9\u00ad\u00b1\u00ba]/g) || []).length;
assert(mojiBase === 0, 'la base c3467e2 contiene mojibake (' + mojiBase + ')');
assert(html.includes('<!-- TOAST NOTIFICATION -->'), 'falta el marcador de toast en la base');
assert(html.includes('id="inputPromptModal"'), 'falta inputPromptModal en la base');
assert(html.includes('Generar Link Portal'), 'falta el botón de portal en la base');

// 2) Bumps de versión legítimos: alinear TODAS las versiones contra el estado
//    actual (corrupto en texto pero correcto en números ASCII) y mis bumps nuevos
const current = readFileSync('admin.html', 'utf8');
const currentVers = new Map();
for (const m of current.matchAll(/([\w.-]+\.(?:js|css))\?v=(\d+)/g)) currentVers.set(m[1], m[2]);
assert(currentVers.size > 10, 'el archivo actual no produjo versiones legibles');

for (const [asset, v] of currentVers) {
  const re = new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\?v=\\d+');
  if (re.test(html)) html = html.replace(re, `${asset}?v=${v}`);
}
// Mis bumps que el archivo corrupto ya tiene aplicados (vienen de currentVers);
// sólo faltan los que Yo introduje y el CI no toca:
html = html.split('assets/js/admin-crm.js?v=49').join('assets/js/admin-crm.js?v=50');
html = html.split('assets/js/admin-propietarios.js?v=14').join('assets/js/admin-propietarios.js?v=15');
html = html.split('assets/css/admin.css?v=220').join('assets/css/admin.css?v=221');

// 3) Renombre del botón del modal de propietario (mismo estilo, fa-key)
const btnOld = /<i class="fas fa-link">\s*<\/i>\s*Generar Link Portal<\/button>/;
assert(btnOld.test(html), 'no se encontró el botón viejo con el patrón esperado');
html = html.replace(btnOld, '<i class="fas fa-key">\n</i> Acceso Portal</button>');

// 4) Insertar el modal de acceso al portal antes del marcador de toast
const modal = `<!-- MODAL ACCESO PORTAL PROPIETARIO (reutiliza el token vigente; regenerar pide confirmación) -->
<div class="admin-modal" id="portalLinkModal">
  <div class="modal-box confirm-box" role="dialog" aria-modal="true" aria-labelledby="portalLinkTitle">
    <div class="confirm-icon"><i class="fas fa-key" style="color:var(--accent);"></i></div>
    <h3 class="confirm-title" id="portalLinkTitle">Acceso al Portal</h3>
    <p class="confirm-msg" id="portalLinkMsg"></p>
    <div id="portalTokenActive" style="display:none;">
      <div class="portal-token-card">
        <div class="portal-token-code" id="portalTokenCode">—</div>
        <div class="portal-token-expiry" id="portalTokenExpiry">—</div>
        <div class="portal-token-link" id="portalTokenLink">—</div>
      </div>
      <div class="portal-token-actions">
        <button type="button" class="btn-luxury-action btn-sm" id="portalCopyLinkBtn"><i class="fas fa-link"></i> Copiar link</button>
        <button type="button" class="btn-ghost" id="portalCopyMsgBtn"><i class="fab fa-whatsapp"></i> Copiar mensaje</button>
        <button type="button" class="btn-ghost" id="portalRegenerateBtn"><i class="fas fa-rotate"></i> Generar nuevo</button>
      </div>
    </div>
    <div id="portalTokenNew" style="display:none;">
      <div class="form-field" style="text-align:left;">
        <label>Días de validez del acceso</label>
        <input type="number" id="portalDaysInput" min="1" max="365" value="90">
      </div>
      <div class="portal-days-chips">
        <button type="button" class="status-pill" data-portal-days="30">30 días</button>
        <button type="button" class="status-pill" data-portal-days="90">90 días</button>
        <button type="button" class="status-pill" data-portal-days="180">180 días</button>
        <button type="button" class="status-pill" data-portal-days="365">1 año</button>
      </div>
      <p class="portal-expiry-preview" id="portalExpiryPreview"></p>
      <div class="confirm-actions">
        <button type="button" class="btn-luxury-action" id="portalGenerateBtn"><i class="fas fa-key"></i> Generar acceso</button>
      </div>
    </div>
    <div class="confirm-actions" style="margin-top:10px;">
      <button type="button" class="btn-ghost" id="portalLinkClose">Cerrar</button>
    </div>
  </div>
</div>
`;
html = html.replace('<!-- TOAST NOTIFICATION -->', modal + '<!-- TOAST NOTIFICATION -->');

// 5) Verificación final del archivo reconstruido
const mojiFinal = (html.match(/\u00c3[\u00b3\u00a9\u00ad\u00b1\u00ba]/g) || []).length;
assert(mojiFinal === 0, 'el resultado contiene mojibake (' + mojiFinal + ')');
const checks = {
  'portalLinkModal': (html.match(/id="portalLinkModal"/g) || []).length,
  'Acceso Portal (botón)': (html.match(/Acceso Portal<\/button>/g) || []).length,
  'Días de validez': html.includes('Días de validez'),
  'admin-crm.js?v=50': html.includes('admin-crm.js?v=50'),
  'admin-propietarios.js?v=15': html.includes('admin-propietarios.js?v=15'),
  'admin.css?v=221': html.includes('admin.css?v=221'),
  'admin-app.js?v=425': html.includes('admin-app.js?v=425'),
  'inputPromptModal intacto': html.includes('id="inputPromptModal"'),
};
console.log('Verificación:');
for (const [k, v] of Object.entries(checks)) console.log('  ' + k + ': ' + v);
for (const k of ['portalLinkModal', 'Acceso Portal (botón)', 'Días de validez', 'admin-crm.js?v=50', 'admin-propietarios.js?v=15', 'admin.css?v=221', 'admin-app.js?v=425', 'inputPromptModal intacto']) {
  if (!checks[k] || (typeof checks[k] === 'number' && checks[k] < 1)) { console.error('FALLO en: ' + k); process.exit(1); }
}

writeFileSync('admin.html', html, 'utf8');
console.log('\nadmin.html reconstruido y escrito: ' + html.length + ' chars, mojibake=' + mojiFinal);
