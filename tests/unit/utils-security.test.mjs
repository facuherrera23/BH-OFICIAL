// Tests de seguridad para assets/js/utils.js (esc, safeUrl, safeImageUrl, safeCssUrl, sanitizeRichText).
// Cubre los vectores XSS que el CMS de la landing podria recibir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BHUtils = require('../../assets/js/utils.js');

test('esc: escapa los 5 caracteres de riesgo', () => {
  assert.equal(BHUtils.esc(`<script>alert("x'")</script>`),
    '&lt;script&gt;alert(&quot;x&#39;&quot;)&lt;/script&gt;');
  assert.equal(BHUtils.esc(null), '');
  assert.equal(BHUtils.esc(0), '0');
});

test('safeUrl: permite http/https/mailto/tel y relativas; rechaza javascript:/data:/vbscript:', () => {
  assert.equal(BHUtils.safeUrl('https://bienenhaus.com.ar/x'), 'https://bienenhaus.com.ar/x');
  assert.equal(BHUtils.safeUrl('mailto:a@b.com'), 'mailto:a@b.com');
  assert.equal(BHUtils.safeUrl('tel:+5491100000000'), 'tel:+5491100000000');
  assert.equal(BHUtils.safeUrl('/propiedades'), '/propiedades');
  assert.equal(BHUtils.safeUrl('#contacto'), '#contacto');
  assert.equal(BHUtils.safeUrl('javascript:alert(1)'), '');
  assert.equal(BHUtils.safeUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(BHUtils.safeUrl('vbscript:msgbox(1)'), '');
  assert.equal(BHUtils.safeUrl('  java\tscript:alert(1)  '), '');
  assert.equal(BHUtils.safeUrl(''), '');
  assert.equal(BHUtils.safeUrl(null), '');
});

test('safeImageUrl: solo http/https/relativo', () => {
  assert.equal(BHUtils.safeImageUrl('https://res.cloudinary.com/x/y.webp'), 'https://res.cloudinary.com/x/y.webp');
  assert.equal(BHUtils.safeImageUrl('mailto:a@b.com'), '');
  assert.equal(BHUtils.safeImageUrl('javascript:alert(1)'), '');
});

test('safeCssUrl: neutraliza comillas y parentesis para url("...")', () => {
  const tricky1 = BHUtils.safeCssUrl('https://x.com/a(1)"),evil"),url');
  assert.ok(tricky1 === '' || !/["()\\]/.test(tricky1), 'ningun caracter peligroso debe quedar sin escapar');
  assert.equal(BHUtils.safeCssUrl('https://x.com/a(1).png'), 'https://x.com/a%281%29.png');
  const tricky2 = BHUtils.safeCssUrl('https://x.com/");alert(1);//');
  assert.ok(tricky2 === '' || !/["()\\]/.test(tricky2), 'las comillas que rompen el contexto CSS deben ir codificadas');
  assert.equal(BHUtils.safeCssUrl('javascript:alert(1)'), '');
});

test('sanitizeRichText: permite exactamente span.highlight, /span y br', () => {
  assert.equal(
    BHUtils.sanitizeRichText('Hablemos de tu <span class="highlight">próximo hogar</span>'),
    'Hablemos de tu <span class="highlight">próximo hogar</span>',
  );
  assert.equal(BHUtils.sanitizeRichText('linea 1<br>linea 2'), 'linea 1<br>linea 2');
  assert.equal(BHUtils.sanitizeRichText('linea 1<br/>linea 2'), 'linea 1<br>linea 2');
});

test('sanitizeRichText: XSS queda inerte', () => {
  assert.equal(
    BHUtils.sanitizeRichText('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;',
  );
  assert.equal(
    BHUtils.sanitizeRichText('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;',
  );
  // variante casi-valida con atributo extra: NO debe re-habilitarse
  const almost = BHUtils.sanitizeRichText('<span class="highlight" onclick="steal()">x</span>');
  assert.ok(!almost.includes('<span'), 'no debe formarse un span real (el atributo extra rompe la forma exacta)');
  // comillas simples en el atributo: tampoco
  const singleQ = BHUtils.sanitizeRichText("<span class='highlight'>x</span>");
  assert.ok(!singleQ.includes('<span'), 'la variante con comillas simples no esta permitida');
});

test('sanitizeRichText: entidades pre-escapadas NO se re-habilitan (trampa de doble escape)', () => {
  const out = BHUtils.sanitizeRichText('&lt;span class="highlight"&gt;<script>x</script>');
  assert.ok(out.includes('&amp;lt;'), 'la entidad del usuario queda escapada como texto');
  assert.ok(!out.includes('<script'), 'no se forma ningun script');
});

test('sanitizeRichText: & suelta se escapa correctamente', () => {
  assert.equal(BHUtils.sanitizeRichText('R&D < inmobiliaria'), 'R&amp;D &lt; inmobiliaria');
});

test('sanitizeRichText: null/vacios', () => {
  assert.equal(BHUtils.sanitizeRichText(null), '');
  assert.equal(BHUtils.sanitizeRichText(undefined), '');
  assert.equal(BHUtils.sanitizeRichText(''), '');
});
