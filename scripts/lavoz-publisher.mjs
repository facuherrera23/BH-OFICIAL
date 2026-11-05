// ============================================================
// lavoz-publisher.mjs — asistente local de publicación en La Voz
// ============================================================
// POR QUÉ EXISTE: Clasificados La Voz NO tiene API ni carga masiva
// (verificado 2026-11-04: sin API en FAQ/Términos/sitemap/bundles, la única
// ruta JSON del front es /api/auth/me; el portal está detrás de Cloudflare
// Turnstile). Publicar es, sí o sí, una operación humana en su panel.
//
// QUÉ HACE: abre el navegador VISIBLE ( headed ) con un perfil persistente,
// espera a que el(login) quede hecho a mano y después:
//   --discover   vuelca el formulario real (ids, labels, opciones) a
//                scripts/lavoz-form-schema.json → sirve para mapear el
//                formulario y automatizar el llenado.
//   --publish    llena el formulario con un aviso ya armado por el CRM
//                (JSON del edge function lavoz-proxy) y sube las fotos
//                (la PORTADA primero). NO publica: deja el botón de
//                publicación para que el Humans lo apriete.
//
// POR QUÉ HEADED Y CON PERFIL PERSISTENTE: el Turnstile de Cloudflare
// bloquea los navegadores headless; con ventana visible + sesión guardada
// el flujo funciona como el de una persona.
//
// USO:
//   node scripts/lavoz-publisher.mjs --discover
//   node scripts/lavoz-publisher.mjs --publish avisos/DA-P0018.json
//   node scripts/lavoz-publisher.mjs --publish avisos/DA-P0018.json --submit
//
// El aviso JSON sale del CRM: tab Portales → Clasificados La Voz →
// "Preparar" → "Descargar fotos"/copiar la ficha. También se puede pedir
// directo a la edge function (ver assets/js/admin-portales.js).
// ============================================================

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE_DIR = path.join(os.homedir(), '.lavoz-publisher-profile');
const SCHEMA_FILE = path.join(__dirname, 'lavoz-form-schema.json');
const PORTAL = 'https://clasificados.lavoz.com.ar';
const PUBLISH_URL = `${PORTAL}/publicar`;

function parseArgs(argv) {
  const args = { mode: 'discover', submit: false, url: PUBLISH_URL, payload: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--discover') args.mode = 'discover';
    else if (a === '--publish') { args.mode = 'publish'; args.payload = argv[++i]; }
    else if (a === '--submit') args.submit = true;
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function log(...parts) { console.log('[lavoz]', ...parts); }

/** Escapa un valor para usarlo como selector CSS (CSS.escape no existe en Node). */
function cssEsc(s) {
  return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
}

/* ---------------- Schema del formulario ---------------- */

/** Vuelca todos los controles del formulario: sirve para mapearlo. */
async function discoverForm(page) {
  return await page.evaluate(() => {
    const labelOf = (el) => {
      if (el.id) {
        const lb = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lb) return lb.textContent.trim();
      }
      const wrap = el.closest('label');
      if (wrap) return wrap.textContent.trim();
      const parent = el.parentElement;
      if (parent) {
        const t = parent.querySelector('label, .label, [class*="label"]');
        if (t) return t.textContent.trim();
      }
      return '';
    };
    const controls = [...document.querySelectorAll('input, select, textarea')].map((el) => {
      const base = {
        tag: el.tagName.toLowerCase(),
        type: (el.type || '').toLowerCase(),
        id: el.id || null,
        name: el.name || null,
        placeholder: el.getAttribute('placeholder') || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        label: labelOf(el),
        required: !!el.required,
        multiple: !!el.multiple,
        accept: el.getAttribute('accept') || null,
        maxLength: el.getAttribute('maxlength') || null,
      };
      if (el.tagName.toLowerCase() === 'select') {
        base.options = [...el.options].map((o) => ({ value: o.value, text: o.textContent.trim() }));
      }
      if (el.type === 'radio' || el.type === 'checkbox') base.value = el.value;
      return base;
    });
    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .map((b) => ({ text: (b.textContent || b.value || '').trim().slice(0, 80), id: b.id || null, class: b.className || null }))
      .filter((b) => b.text);
    return { url: location.href, title: document.title, controls, buttons };
  });
}

function summarizeSchema(schema) {
  const lines = [`URL: ${schema.url}`, `Título: ${schema.title}`, '', 'CONTROLES:'];
  for (const c of schema.controls) {
    const label = c.label || c.placeholder || c.ariaLabel || '';
    let extra = '';
    if (c.options && c.options.length) {
      extra = ' → ' + c.options.slice(0, 12).map((o) => `${o.value}`).join(' | ') + (c.options.length > 12 ? ' …' : '');
    }
    lines.push(`  ${c.tag}${c.type ? '[' + c.type + ']' : ''} id=${c.id || '-'} name=${c.name || '-'} ${c.required ? '(req)' : ''} :: ${label}${extra}`);
  }
  lines.push('', 'BOTONES:', ...schema.buttons.map((b) => `  ${b.text}`));
  return lines.join('\n');
}

/* ---------------- Llenado ---------------- */

/** Busca el control que mejor matchea una lista de palabras clave. */
function pickControl(controls, keywords, tagFilter) {
  const list = controls.filter((c) => (tagFilter ? c.tag === tagFilter : true));
  for (const kw of keywords) {
    const hit = list.find((c) => {
      const hay = `${c.label} ${c.placeholder || ''} ${c.ariaLabel || ''} ${c.name || ''} ${c.id || ''}`.toLowerCase();
      return hay.includes(kw);
    });
    if (hit) return hit;
  }
  return null;
}

async function setSelect(page, control, value) {
  const sel = control.id
    ? page.locator(`#${cssEsc(control.id)}`)
    : page.locator(`[name="${control.name}"]`);
  const wanted = String(value).toLowerCase();
  const options = await sel.locator('option').allTextContents();
  const exact = options.findIndex((t) => t.trim().toLowerCase() === wanted);
  if (exact >= 0) { await sel.selectOption({ index: exact }); return true; }
  const partial = options.findIndex((t) => {
    const lt = t.trim().toLowerCase();
    return lt.includes(wanted) || wanted.includes(lt);
  });
  if (partial >= 0) { await sel.selectOption({ index: partial }); return true; }
  return false;
}

async function fillForm(page, payload, schema) {
  const controls = schema.controls;
  const done = [];
  const missed = [];

  const fillText = async (keywords, value, tag = 'input') => {
    if (value === null || value === undefined || value === '') return;
    const c = pickControl(controls, keywords, tag);
    if (!c) { missed.push(keywords[0]); return; }
    const loc = c.id ? page.locator(`#${cssEsc(c.id)}`) : page.locator(`[name="${c.name}"]`);
    await loc.first().fill(String(value));
    done.push(`${c.label || c.id || c.name} = ${String(value).slice(0, 40)}`);
  };

  const fillSelect = async (keywords, value) => {
    if (value === null || value === undefined || value === '') return;
    const c = pickControl(controls, keywords, 'select');
    if (!c) { missed.push(keywords[0]); return; }
    const ok = await setSelect(page, c, value);
    if (ok) done.push(`${c.label || c.id || c.name} = ${value}`);
    else missed.push(`${c.label || c.id} (sin opción "${value}")`);
  };

  await fillText(['titulo', 'título', 'titulo del aviso', 'encabezado'], payload.titulo);
  await fillText(['descripcion', 'descripción', 'detalle', 'texto del aviso'], payload.descripcion, 'textarea');
  await fillSelect(['tipo de inmueble', 'subrubro', 'tipo'], payload.subrubro_label || payload.subrubro);
  await fillSelect(['operacion', 'operación', 'venta o alquiler', 'modalidad'], payload.operacion_label || payload.operacion);
  await fillSelect(['ciudad'], payload.ciudad_label || payload.ciudad);
  await fillSelect(['barrio', 'zona'], payload.barrio_label);
  await fillText(['precio'], payload.precio);
  await fillText(['superficie total', 'superficie', 'metros', 'm2', 'm²'], payload.superficie_total);
  await fillText(['dormitorio', 'dormitorios'], payload.bedrooms);
  await fillText(['baño', 'baños', 'banos'], payload.bathrooms);
  await fillText(['cochera', 'garaje'], payload.cocheras);
  await fillText(['antiguedad', 'antigüedad', 'años'], payload.antiguedad);
  await fillText(['expensa'], payload.expensas);

  return { done, missed };
}

/* ---------------- Fotos ---------------- */

async function downloadFotos(fotos, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const out = [];
  for (let i = 0; i < fotos.length; i++) {
    const url = fotos[i];
    const name = `${String(i + 1).padStart(2, '0')}${i === 0 ? '-portada' : '-foto'}.jpg`;
    const file = path.join(destDir, name);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      out.push(file);
    } catch (err) {
      console.warn(`[lavoz] no se pudo bajar ${url}: ${err.message}`);
    }
  }
  return out;
}

/* ---------------- Main ---------------- */

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  log('Uso: node scripts/lavoz-publisher.mjs --discover | --publish <aviso.json> [--submit]');
  process.exit(0);
}

fs.mkdirSync(PROFILE_DIR, { recursive: true });
log('Perfil persistente:', PROFILE_DIR);
log('Abriendo el navegador… (hacé login en La Voz si hace falta)');

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: null,
  args: ['--disable-blink-features=AutomationControlled'],
});

const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(args.url, { waitUntil: 'domcontentloaded' }).catch(() => {});

log('Si ves el login, iniciá sesión ahora. Después volvé a esta ventana.');
log('Esperando el formulario de publicación…');

/* Espera activa: hasta que aparezca un control de texto/select del formulario
   de aviso (o hasta que el usuario lo indique con Enter). */
const appeared = await page.waitForFunction(() => {
  const c = document.querySelectorAll('input[type="text"], input:not([type]), textarea, select');
  return c.length >= 3;
}, null, { timeout: 0 }).then(() => true).catch(() => false);

if (!appeared) {
  log('No se detectó el formulario. Abortando.');
  await ctx.close();
  process.exit(1);
}

log('Formulario detectado.');

if (args.mode === 'discover') {
  const schema = await discoverForm(page);
  fs.writeFileSync(SCHEMA_FILE, JSON.stringify(schema, null, 2), 'utf8');
  log(summarizeSchema(schema));
  log('Schema guardado en', SCHEMA_FILE);
  log('Revisalo, ajustá el mapeo y después usá --publish.');
  await ctx.close();
  process.exit(0);
}

/* ---------------- publish ---------------- */
if (!args.payload) {
  log('Falta el archivo JSON del aviso (--publish <archivo.json>).');
  await ctx.close();
  process.exit(1);
}
const payload = JSON.parse(fs.readFileSync(path.resolve(args.payload), 'utf8'));

let schema;
if (fs.existsSync(SCHEMA_FILE)) {
  schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  log('Schema:', SCHEMA_FILE);
} else {
  log('No hay schema guardado: se descubre el formulario ahora.');
  schema = await discoverForm(page);
  fs.writeFileSync(SCHEMA_FILE, JSON.stringify(schema, null, 2), 'utf8');
}

const { done, missed } = await fillForm(page, payload, schema);
for (const d of done) log('  ✓', d);
for (const m of missed) log('  ! sin match:', m);

// Fotos: la PORTADA primero (el payload ya viene en ese orden).
const fotos = Array.isArray(payload.fotos) ? payload.fotos : [];
if (fotos.length) {
  const tmp = path.join(os.tmpdir(), 'lavoz-publisher-fotos');
  const files = await downloadFotos(fotos, tmp);
  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.count()) {
    await fileInput.setInputFiles(files);
    log(`  ✓ ${files.length} foto(s) subidas (la 1ª es la PORTADA)`);
  } else {
    log('  ! no encontré el input de fotos: subilas a mano desde', tmp);
  }
}

await page.screenshot({ path: path.join(ROOT, 'lavoz-publisher-preview.png'), fullPage: true }).catch(() => {});
log('Captura: lavoz-publisher-preview.png');

if (args.submit) {
  log('PUBLICANDO…');
  const btn = page.getByRole('button', { name: /publicar|guardar|continuar/i }).first();
  await btn.click().catch((err) => log('  ! no pude clickear el botón:', err.message));
} else {
  log('Listo. Revisá la pantalla y apretá "Publicar" vos mismo.');
}

log('Cerrando en 15 segundos (Ctrl+C para salir antes)…');
await new Promise((r) => setTimeout(r, 15000));
await ctx.close();
