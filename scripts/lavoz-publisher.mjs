// ============================================================
// lavoz-publisher.mjs — MOTOR DE PUBLICACIÓN en Clasificados La Voz
// ============================================================
// POR QUÉ EXISTE: Clasificados La Voz NO tiene API ni carga masiva
// (verificado 2026-11-04: sin API en FAQ/Términos/sitemap/bundles, la única
// ruta JSON real del front es /api/auth/me; el portal está detrás de Cloudflare
// Turnstile). Publicar es, sí o sí, una operación en su panel → se automatiza
// con un navegador REAL (headed) + perfil persistente.
//
// QUÉ HACE (todo lo automatizable):
//   1. Reutiliza la sesión de La Voz del perfil persistente (login humano UNA
//      vez; después no se vuelve a pedir).
//   2. Lee la sesión del CRM del mismo perfil y llama a la edge function
//      `lavoz-proxy` (list / prepare / confirm) → la cola de avisos sale del
//      CRM, no de archivos sueltos.
//   3. Descubre el formulario real (wizard multi-paso), lo llena campo por
//      campo con los datos del aviso y sube las fotos (la PORTADA primero).
//   4. Publica (o deja el botón si se pide) y captura la URL del aviso.
//   5. Confirma en el CRM → la publicación queda con estado, plan y VENCIMIENTO
//      (10 o 30 días) sin que nadie tenga que pegar la URL a mano.
//
// MODO HUMANO: el login (La Voz y/o CRM) NO se automatiza — son credenciales
// del empleador y Turnstile bloquea headless. Con el perfil persistente, la
// segunda vez no hace falta intervenc.
// ============================================================
// USO
//   node scripts/lavoz-publisher.mjs --discover      # vuelca el formulario
//   node scripts/lavoz-publisher.mjs --run            # publica toda la cola
//   node scripts/lavoz-publisher.mjs --run --only DA-P0018
//   node scripts/lavoz-publisher.mjs --run --dry      # llena sin publicar
//   node scripts/lavoz-publisher.mjs --run --renew    # renueva vencidos
//   node scripts/lavoz-publisher.mjs --run --renew --force-new
//       # CONFIRMACIÓN EXPLÍCITA: crea un aviso nuevo si no se pudo renovar.
//       # Sin este flag el asistente NUNCA duplica un aviso que el CRM ya
//       # marca publicado/vencido con link real (incidente 2026-11-22).
//   node scripts/lavoz-publisher.mjs --run --json     # resumen JSON por stdout + archivo lavoz-shots/run-*.json
// ============================================================

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  CAMPOS,
  OPCIONES,
  RE_SIGUIENTE,
  RE_AVANZAR,
  RE_PUBLICAR,
  normalizar,
  textoDeControl,
  elegirControl,
  indiceOpcion,
  planLlenado,
  planDefaults,
  idControl,
  esTextoTerminos,
  tieneBloqueante,
  RE_BLOQUEANTE,
} from './lavoz-mapping.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE_DIR = path.join(os.homedir(), '.lavoz-publisher-profile');
const SCHEMA_FILE = path.join(__dirname, 'lavoz-form-schema.json');
const SHOTS_DIR = path.join(ROOT, 'lavoz-shots');
const PORTAL = 'https://clasificados.lavoz.com.ar';
const PUBLISH_URL = `${PORTAL}/publicar`;
const CRM_URL = 'https://bienenhaus.com.ar/admin.html';
const SUPABASE_FN = 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/lavoz-proxy';
const SUPABASE_AUTH = 'https://rnldqiwwzhjnurkguihu.supabase.co';
// Clave ANON pública (la misma que usa el panel: assets/js/config.js).
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJubGRxaXd3emhqbnVya2d1aWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5NDA4MzMsImV4cCI6MjEwMDUxNjgzM30.tzqe0Z1vS9R5GiCTxIe3m6uY4kkggF3kewPrRUY8BwE';
const SUPABASE_STORAGE_KEY = 'sb-rnldqiwwzhjnurkguihu-auth-token';

/* ---------------- Args ---------------- */

function parseArgs(argv) {
  const args = {
    mode: 'discover', submit: false, dry: false, renew: false, forceNew: false, json: false,
    url: PUBLISH_URL, payload: null, only: null, limit: 99,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--discover') args.mode = 'discover';
    else if (a === '--run') args.mode = 'run';
    else if (a === '--estado') args.mode = 'estado';
    else if (a === '--publish') { args.mode = 'run'; args.payload = argv[++i]; }
    else if (a === '--submit') args.submit = true;
    else if (a === '--dry') { args.dry = true; args.submit = false; }
    else if (a === '--no-submit') args.submit = false;
    else if (a === '--renew') args.renew = true;
    else if (a === '--force-new') args.forceNew = true;
    else if (a === '--json') args.json = true;
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]) || 99;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  // En modo cola, publicar es lo esperado (el humano pidió automatizar).
  if (args.mode === 'run' && !args.dry && argv.includes('--no-submit') === false && !argv.includes('--dry')) {
    args.submit = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Uso: node scripts/lavoz-publisher.mjs --discover | --run [--only CODE] [--limit N] [--dry] [--renew] [--force-new] [--json]');
  console.log('     --force-new: CONFIRMACIÓN EXPLÍCITA para crear un aviso nuevo cuando el CRM ya marca publicado/vencido.');
  console.log('     node scripts/lavoz-publisher.mjs --estado   # cola de avisos (solo lectura)');
  process.exit(0);
}

function log(...parts) { console.log('[lavoz]', ...parts); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Los campos y sus keywords viven en scripts/lavoz-mapping.mjs (puro, testeado
   en tests/unit/lavoz-mapping.test.mts). Acá sólo se usa el runtime del DOM. */

/* ---------------- Navegador ---------------- */

fs.mkdirSync(PROFILE_DIR, { recursive: true });
fs.mkdirSync(SHOTS_DIR, { recursive: true });

log('Perfil persistente:', PROFILE_DIR);

// El modo --estado es de SOLO LECTURA: no necesita la sesión de La Voz y
// puede ir headless (sólo lee la sesión del CRM del perfil).
const soloLectura = args.mode === 'estado';
if (!soloLectura) log('Abriendo el navegador…');

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: soloLectura,
  viewport: soloLectura ? { width: 1280, height: 900 } : null,
  args: ['--disable-blink-features=AutomationControlled'],
});

/* Si el proceso falla en cualquier punto posterior, cerrar el navegador SIEMPRE.
 * Sin esto, una corrida que muere deja ventanas Chromium huerfanas tomando el
 * perfil, y la corrida siguiente muere al instante con "Se cerró el navegador"
 * (la causa del 4/4 del 2026-11-09 al encadenar corridas). */
let cerrandoFatal = false;
const fatalExit = async (err) => {
  if (cerrandoFatal) return;
  cerrandoFatal = true;
  try { await ctx.close(); } catch {}
  console.error('[lavoz] FATAL:', (err && err.message) || err);
  process.exit(1);
};
process.on('uncaughtException', (e) => { fatalExit(e); });
process.on('unhandledRejection', (e) => { fatalExit(e); });

const page = ctx.pages()[0] || await ctx.newPage();

async function shot(nombre) {
  const file = path.join(SHOTS_DIR, `${nombre}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

/* ---------------- Sesión del CRM ---------------- */

/**
 * Token del CRM por API (sin navegador): las credenciales del panel van en
 * variables de entorno (BH_ADMIN_EMAIL / BH_ADMIN_PASSWORD — o las del
 * suite de tests, BH_TEST_ADMIN_EMAIL / BH_TEST_ADMIN_PASSWORD).
 * La clave anon es pública (assets/js/config.js).
 */
async function tokenCrmPorCredenciales() {
  const email = process.env.BH_ADMIN_EMAIL || process.env.BH_TEST_ADMIN_EMAIL;
  const password = process.env.BH_ADMIN_PASSWORD || process.env.BH_TEST_ADMIN_PASSWORD;
  if (!email || !password) return null;
  try {
    const res = await fetch(`${SUPABASE_AUTH}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      log('  ! login del CRM por API falló:', json.error_description || json.msg || `HTTP ${res.status}`);
      return null;
    }
    log('✓ Token del CRM por API (sin navegador)');
    return json.access_token;
  } catch (err) {
    log('  ! login del CRM por API falló:', err.message);
    return null;
  }
}

async function crmToken({ esperar = true } = {}) {
  // 1) Token por variable de entorno (uso desatendido / otro equipo).
  if (process.env.BH_ACCESS_TOKEN) {
    log('✓ Token del CRM por variable de entorno');
    return process.env.BH_ACCESS_TOKEN;
  }
  // 2) Login por API con email + contraseña (sin tocar el navegador).
  const porApi = await tokenCrmPorCredenciales();
  if (porApi) return porApi;
  // 3) La sesión del admin vive en localStorage del origen del panel; el perfil
  //    persistente la conserva entre corridas (el employer inicia sesión una vez).
  let tab = ctx.pages().find((p) => p.url().includes('bienenhaus.com.ar'));
  if (!tab) {
    tab = await ctx.newPage();
    await tab.goto(CRM_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  const leer = async () => await tab.evaluate((key) => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.access_token || parsed?.currentSession?.access_token || null;
    } catch { return null; }
  }, SUPABASE_STORAGE_KEY);

  let token = await leer();
  if (token) return token;

  if (!esperar) {
    throw new Error(
      'No hay sesión del CRM en este perfil. Iniciá sesión en https://bienenhaus.com.ar/admin.html '
      + 'con el navegador del asistente (o exportá BH_ACCESS_TOKEN).',
    );
  }

  log('Sin sesión del CRM en este perfil: iniciá sesión en el panel (pestaña del CRM).');
  log('(Una sola vez: el perfil persistente la guarda.)');
  let espera = 0;
  while (!token && espera < 30 * 60 * 1000) {
    await sleep(3000);
    espera += 3000;
    if (espera % 30000 === 0) log('  … esperando la sesión del CRM');
    token = await leer();
  }
  if (!token) throw new Error('No se pudo obtener la sesión del CRM');
  log('✓ Sesión del CRM lista');
  return token;
}

async function crmCall(token, action, body = {}) {
  const res = await fetch(SUPABASE_FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `lavoz-proxy ${res.status}`);
  return json;
}

/* ---------------- Sesión de La Voz ---------------- */

/**
 * `page.url()` es SINCRÓNO en Playwright (devuelve un string, no una
 * promesa). Escribirló como `await page.url().catch(...)` revienta con
 * "page.url(...).catch is not a function" — y sólo se rompe en el camino
 * del login humano (el único que no se había probado en seco).
 */
function urlActual(p) {
  try { return p.url() || ''; } catch { return ''; }
}

/**
 * Login automático de La Voz con las variables de entorno
 * LAVOZ_EMAIL y LAVOZ_PASSWORD (fuera del repo — nunca se commitean).
 * Si el portal exige Turnstile, el captcha queda para el humano: el script
 * espera a que la sesión quede lista.
 */
async function loginAutomaticoLaVoz() {
  const email = process.env.LAVOZ_EMAIL;
  const password = process.env.LAVOZ_PASSWORD;
  if (!email || !password) return false;

  const inEmail = page.locator('input[name="email"], input[type="email"], #email').first();
  const inPass = page.locator('input[name="password"], input[type="password"], #password').first();
  if (!(await inEmail.count()) || !(await inPass.count())) return false;

  log('· login automático con LAVOZ_EMAIL…');
  await inEmail.fill(email).catch(() => {});
  await inPass.fill(password).catch(() => {});
  await page.waitForTimeout(500);

  const btn = page.locator('button, a').filter({ hasText: /^(ingresar|entrar|sign in)$/i }).first();
  if (await btn.count()) {
    await btn.click({ timeout: 8000 }).catch(() => {});
  } else {
    await inPass.press('Enter').catch(() => {});
  }
  await page.waitForTimeout(4000);
  return !urlActual(page).includes('/usuario/login');
}

async function asegurarSesionLaVoz() {
  await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (!urlActual(page).includes('/usuario/login')) {
    log('✓ Sesión de La Voz lista');
    return;
  }

  // 1) Automático si hay credenciales en el entorno.
  if (await loginAutomaticoLaVoz()) {
    log('✓ Sesión de La Voz lista (login automático)');
    return;
  }

  log('La Voz pide iniciar sesión (o contrasenia).');
  log('Iniciá sesión en esta ventana — es la ÚNICA vez (el perfil lo recuerda).');
  let espera = 0;
  while (espera < 30 * 60 * 1000) {
    if (page.isClosed()) throw new Error('Se cerró el navegador (la ventana de La Voz).');
    const url = urlActual(page);
    if (!url.includes('/usuario/login')) break;
    await sleep(3000);
    espera += 3000;
    if (espera % 30000 === 0) log('  … esperando el login de La Voz');
  }
  const urlFinal = urlActual(page);
  if (urlFinal.includes('/usuario/login')) throw new Error('Login de La Voz no completado (url final: ' + urlFinal.slice(0, 120) + ')');
  if (!urlFinal.includes('/publicar')) {
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  log('✓ Sesión de La Voz lista');
}

/* ---------------- Wizard de La Voz ---------------- */

/**
 * Estructura REAL del formulario (verificada 2026-11-06 contra el portal):
 *   /publicar → elegir sección → /publicar/inmuebles → wizard de 6 pasos
 *   1 Tipo de inmueble · 2 Ubicación · 3 Contacto · 4 Precio
 *   5 Datos del aviso · 6 Multimedia
 * Los botones "PASO N" navegan entre pasos (no hay que avanzar a ciegas).
 */
export const PASOS_LAVOZ = [
  { n: 1, nombre: 'Tipo de inmueble' },
  { n: 2, nombre: 'Ubicación' },
  { n: 3, nombre: 'Contacto' },
  { n: 4, nombre: 'Precio' },
  { n: 5, nombre: 'Datos del aviso' },
  { n: 6, nombre: 'Multimedia' },
];

const INMUEBLES_URL = `${PORTAL}/publicar/inmuebles`;

/** Cierra el modal "Tenés borradores sin publicar" (tapa el formulario). */
async function cerrarModalBorradores(page) {
  const btn = page.locator('button', { hasText: /empezar un aviso nuevo/i }).first();
  if (!(await btn.count())) return false;
  if (!(await btn.isVisible().catch(() => false))) return false;
  await btn.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return true;
}

/** Va al paso N del wizard con su botón ("PASO 2Ubicación"). */
async function irAPaso(page, n) {
  const re = new RegExp(`PASO\\s*${n}\\b`, 'i');
  const btn = page.locator('button').filter({ hasText: re }).first();
  if (!(await btn.count())) return false;
  if (!(await btn.isVisible().catch(() => false))) return false;
  await btn.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1800);
  return true;
}

/* ---------------- Descubrimiento del formulario ---------------- */

async function descubrirFormulario() {
  const controls = await controlsVisibles(page);
  const extra = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const txt = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
    const botones = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .map((b) => ({
        text: txt(b).slice(0, 80),
        id: b.id || null,
        type: b.getAttribute('type') || null,
        visible: visible(b),
      }))
      .filter((b) => b.text);
    const pasos = [...document.querySelectorAll('button')]
      .map((b) => txt(b))
      .filter((t) => /^PASO\s*\d+/i.test(t))
      .slice(0, 12);
    return {
      url: location.href,
      title: document.title,
      heading: txt(document.querySelector('main h1, main h2, h1, h2')),
      botones,
      pasos,
      bodyStart: txt(document.body).slice(0, 400),
    };
  });
  return { ...extra, controls };
}

function resumirSchema(schema) {
  const L = [`URL: ${schema.url}`, `Título: ${schema.title}`, `Paso: ${schema.heading || '(sin heading)'}`];
  if (schema.pasos?.length) L.push(`Pasos: ${schema.pasos.join(' | ')}`);
  L.push('', 'CONTROLES:');
  for (const c of schema.controls) {
    const label = c.label || c.placeholder || c.ariaLabel || '';
    let extra = '';
    if (c.options?.length) extra = ' → ' + c.options.map((o) => o.text).slice(0, 14).join(' | ');
    L.push(`  ${c.tag}${c.type ? '[' + c.type + ']' : ''} ${c.visible ? '' : '(oculto) '}id=${c.id || '-'} name=${c.name || '-'} :: ${label}${extra}`);
  }
  L.push('', 'BOTONES:', ...schema.buttons?.map((b) => `  ${b.visible ? '' : '(oculto) '}${b.text}`) || []);
  return L.join('\n');
}

/* ---------------- Llenado ---------------- */

function locatorDe(page, c) {
  if (c.id) return page.locator(`#${cssEsc(c.id)}`);
  if (c.name) return page.locator(`[name="${c.name}"]`);
  return null;
}

function cssEsc(s) {
  return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
}

async function llenarCampo(page, campo, valor, control) {
  const c = control || elegirControl(await controlsVisibles(page), campo);
  if (!c) return { ok: false, motivo: 'sin control' };
  if (c.tag === 'combo') return elegirEnCombo(page, c, valor);
  const loc = locatorDe(page, c);
  if (!loc) return { ok: false, motivo: 'sin locator' };
  const n = await loc.count();
  if (!n) return { ok: false, motivo: 'control invisible' };
  const target = loc.first();
  if (c.tag === 'select') {
    const opciones = await target.locator('option').allTextContents();
    const idx = indiceOpcion(opciones, valor);
    if (idx < 0) return { ok: false, motivo: `sin opción "${valor}"` };
    await target.selectOption({ index: idx });
    return { ok: true, texto: `${c.label || c.id} = ${valor}` };
  }
  await target.fill(String(valor));
  return { ok: true, texto: `${c.label || c.id || c.name} = ${String(valor).slice(0, 30)}` };
}

async function controlsVisibles(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const txt = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
    const labelOf = (el) => {
      if (el.id) {
        const lb = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lb) return txt(lb);
      }
      const wrap = el.closest('label');
      if (wrap) return txt(wrap).slice(0, 80);
      const parent = el.parentElement;
      if (parent) {
        const t = parent.querySelector('label, .label, [class*="label"], [class*="Label"]');
        if (t) return txt(t).slice(0, 80);
      }
      return '';
    };
    /**
     * Candidatos de label: el propio del campo + los textos hermanos
     * previos (Base UI renderiza el label como texto, no como <label for>).
     */
    const labelsCandidatos = (el) => {
      const out = [];
      const l = labelOf(el);
      if (l) out.push(l);
      let n = el;
      for (let d = 0; d < 4 && n; d++) {
        const p = n.parentElement;
        if (!p) break;
        const kids = [...p.children];
        const idx = kids.indexOf(n);
        for (let i = idx - 1; i >= 0; i--) {
          const t = txt(kids[i]);
          if (t && t.length < 70 && !out.includes(t)) out.push(t);
        }
        n = p;
      }
      return out;
    };

    const campos = [...document.querySelectorAll('input, select, textarea')].map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: (el.type || '').toLowerCase(),
      id: el.id || null,
      name: el.name || null,
      placeholder: el.getAttribute('placeholder') || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      label: labelOf(el),
      labels: labelsCandidatos(el),
      required: !!el.required || el.getAttribute('aria-required') === 'true',
      multiple: !!el.multiple,
      accept: el.getAttribute('accept') || null,
      visible: visible(el),
      value: el.type === 'password' ? '***' : (el.value || ''),
      options: el.tagName.toLowerCase() === 'select'
        ? [...el.options].map((o) => ({ value: o.value, text: txt(o) }))
        : undefined,
    }));

    // Comboboxes de Base UI (no son <select>): el valor vive en un input
    // oculto y las opciones se abren en un popup con [role="option"].
    const combos = [...document.querySelectorAll('[role="combobox"]')].filter(visible).map((el) => {
      const labels = labelsCandidatos(el);
      return {
        tag: 'combo',
        type: 'combobox',
        id: el.id || null,
        name: el.getAttribute('name') || null,
        placeholder: null,
        ariaLabel: el.getAttribute('aria-label') || null,
        label: labels[0] || '',
        labels,
        required: el.getAttribute('aria-required') === 'true' || /\*/.test(labels.join(' ')),
        visible: true,
        value: txt(el).slice(0, 80),
      };
    });

    return [...campos, ...combos];
  });
}

/** Abre un combobox de Base UI y hace clic en la opción que coincide. */
async function elegirEnCombo(page, control, valor) {
  const loc = locatorDe(page, control);
  if (!loc) return { ok: false, motivo: 'sin locator' };
  const target = loc.first();
  if (!(await target.count())) return { ok: false, motivo: 'combobox invisible' };
  await target.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const ok = await page.evaluate((want) => {
    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    const w = norm(want);
    const opts = [...document.querySelectorAll('[role="option"]')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const hit = opts.find((o) => norm(o.textContent) === w)
      || opts.find((o) => norm(o.textContent).includes(w))
      || opts.find((o) => w.includes(norm(o.textContent)));
    if (hit) { hit.click(); return true; }
    return false;
  }, valor);
  await page.waitForTimeout(1200);
  return ok
    ? { ok: true, texto: `${control.label || control.id} = ${valor}` }
    : { ok: false, motivo: `sin opción "${valor}"` };
}


async function marcarRadio(page, palabra) {
  // Busca un radio/checkbox cuya etiqueta (o el texto cercano) coincida.
  // Soporta grupos reales de La Voz (ej. filters[price_currency], label "Moneda")
  // donde el texto visible puede estar en el label, en el hermano o en el grupo.
  const ok = await page.evaluate((want) => {
    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    const w = norm(want);
    if (!w) return false;
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const txt = (el) => norm((el?.textContent || '') + ' ' + (el?.getAttribute?.('aria-label') || '') + ' ' + (el?.getAttribute?.('value') || ''));
    const clickEl = (el, wrap, labelFor) => {
      const target = labelFor || wrap || el;
      try { target.click(); } catch {}
      if (!el.checked) {
        try { el.checked = true; } catch {}
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      return !!el.checked || el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-checked') !== null;
    };
    const cands = [...document.querySelectorAll('input[type=radio], input[type=checkbox], [role="radio"], [role="checkbox"]')].filter(visible);
    for (const el of cands) {
      const wrap = el.closest('label');
      const near = el.parentElement;
      const labelFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const local = [txt(wrap), txt(labelFor), txt(near), txt(el)].filter(Boolean).join(' ');
      // Evitar match por el grupo entero ("Moneda Dólar Peso") en todos los radios:
      // sólo aceptar si el texto local del input/label coincide.
      if (local && (local === w || local.includes(w) || w.includes(local))) {
        return clickEl(el, wrap, labelFor);
      }
      // Fallback: valor exacto del input (ej. USD/ARS/1/2).
      if (norm(el.value) && norm(el.value) === w) {
        return clickEl(el, wrap, labelFor);
      }
    }
    return false;
  }, palabra);
  return ok;
}

/**
 * Marca la casilla de "acepto los términos y condiciones" si existe y está
 * sin marcar. El Turnstile va en un iframe (no es un input nativo), así que
 * no se toca por accidente.
 */
async function aceptarTerminos(page) {
  return await page.evaluate(() => {
    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    const esTerminos = (txt) => {
      const t = norm(txt);
      if (!t) return false;
      if (/no soy un robot|captcha|turnstile/.test(t)) return false;
      return /acepto|terminos|condiciones|politica/.test(t);
    };
    const cands = [...document.querySelectorAll('input[type=checkbox]')];
    for (const el of cands) {
      if (el.checked || el.disabled) continue;
      const wrap = el.closest('label');
      const near = el.parentElement?.textContent || '';
      const txt = (wrap?.textContent || '') + ' ' + near + ' ' + (el.value || '');
      if (!esTerminos(txt)) continue;
      el.click();
      return true;
    }
    return false;
  });
}

/* ---------------- Fotos ---------------- */

async function bajarFotos(fotos, destDir) {
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

async function subirFotos(page, files) {
  const inputs = page.locator('input[type="file"]');
  const n = await inputs.count();
  if (!n) return { ok: false, motivo: 'no hay input de fotos en esta pantalla' };
  let ultimoError = null;
  for (let i = 0; i < n; i++) {
    const inp = inputs.nth(i);
    const visible = await inp.isVisible().catch(() => false);
    const multiple = (await inp.getAttribute('multiple').catch(() => null)) !== null;
    if (!visible && !multiple) continue;
    // Sin `multiple` sólo se puede subir UNA foto: la PORTADA (la 1ª).
    const lista = multiple ? files : files.slice(0, 1);
    try {
      await inp.setInputFiles(lista);
      return { ok: true, count: lista.length };
    } catch (err) {
      ultimoError = err;
    }
  }
  // Último recurso: el primer input (aunque esté oculto).
  const first = inputs.first();
  const multiple0 = (await first.getAttribute('multiple').catch(() => null)) !== null;
  const lista = multiple0 ? files : files.slice(0, 1);
  try {
    await first.setInputFiles(lista);
    return { ok: true, count: lista.length };
  } catch (err) {
    ultimoError = err;
    return { ok: false, motivo: ultimoError.message.slice(0, 120) };
  }
}

/* ---------------- Wizard: llenar, avanzar, publicar ---------------- */

/**
 * Busca un botón/anchor por texto.
 * `scope` acota la búsqueda al cuerpo del wizard: el HEADER tiene un
 * "Publicá" y el FOOTER un "Publicar" que NO son el botón del aviso —
 * sin acotar, el clic se iba al menú y se perdía el formulario.
 */
async function clickTexto(page, re, { soloVisibles = true, scope = 'main' } = {}) {
  let raiz = null;
  if (scope) {
    const cand = page.locator(scope).first();
    if (await cand.count()) raiz = cand;
  }
  const els = raiz ? raiz.locator('button, [role="button"], input[type="submit"], a.btn, a[class*="button"]')
    : page.locator('button, [role="button"], input[type="submit"], a.btn, a[class*="button"]');
  const total = await els.count();
  let ultimoError = null;
  for (let i = 0; i < total; i++) {
    const el = els.nth(i);
    const txt = ((await el.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (!txt || !re.test(txt)) continue;
    if (soloVisibles && !(await el.isVisible().catch(() => false))) continue;
    /* FAIL-CLOSED: antes el click fallaba (botón tapado, timeout, navigation)
       y de todos modos se devolvía clicked:true → `publicarAviso` reportaba
       publicado, el asistente confirmaba en el CRM y el aviso quedaba como
       "publicado" SIN haberse publicado (y la próxima corrida no lo reintenta).
       Un falso negativo se reintenta; un falso positivo miente y pierde el
       aviso. Por eso sólo se reporta éxito si el click NO lanzó error. */
    try {
      await el.click({ timeout: 8000 });
    } catch (err) {
      ultimoError = err;
      continue;   // probar otro candidato con el mismo texto
    }
    return { clicked: true, texto: txt };
  }
  return { clicked: false, ...(ultimoError ? { motivo: ultimoError.message } : {}) };
}

/** Avance del wizard: fuente única en lavoz-mapping.mjs (testeable). */

/** Errores de validación que muestra el wizard ("Este campo es obligatorio"). */
async function erroresDeValidacion(page) {
  return await page.evaluate(() => {
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
    const out = [];
    const re = /Este campo es obligatorio/gi;
    let m;
    while ((m = re.exec(txt))) {
      out.push(txt.slice(Math.max(0, m.index - 60), m.index + 40).trim());
      if (out.length >= 8) break;
    }
    return [...new Set(out)];
  });
}

async function publicarAviso(page, payload, files, { submit }) {
  const hechos = [];
  const faltantes = [];
  let fotosSubidas = false;
  let monedaNoConfirmada = null;

  // 1) El formulario real vive en /publicar/inmuebles (wizard de 6 pasos).
  if (!urlActual(page).includes('/publicar/inmuebles')) {
    await page.goto(INMUEBLES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  if (await cerrarModalBorradores(page)) {
    hechos.push('descartó el borrador previo (empezar aviso nuevo)');
    await page.waitForTimeout(1500);
  }

  for (let paso = 1; paso <= PASOS_LAVOZ.length; paso++) {
    const urlAntes = urlActual(page);
    const controls = await controlsVisibles(page);

    // 1) Fotos (el paso 6 —Multimedia— es el que tiene el input).
    if (!fotosSubidas && files.length) {
      const r = await subirFotos(page, files);
      if (r.ok) { fotosSubidas = true; hechos.push(`fotos subidas (${r.count})`); await page.waitForTimeout(3000); }
      else if (paso === PASOS_LAVOZ.length) faltantes.push(`fotos: ${r.motivo}`);
    }

    // 2) Campos de texto/select/combo.
    const plan = planLlenado(controls, payload);
    for (const { campo, control, valor } of plan) {
      const loc = locatorDe(page, control);
      if (loc) {
        const actual = await loc.first().inputValue().catch(() => '');
        const yaEsta = (actual && String(actual).trim() === String(valor).trim())
          || (control.tag === 'combo' && String(control.value || '').trim().toLowerCase() === String(valor).trim().toLowerCase());
        if (yaEsta) continue;
      }
      const r = await llenarCampo(page, campo, valor, control);
      if (r.ok) hechos.push(r.texto);
      else faltantes.push(`${campo.key}: ${r.motivo}`);
    }

    // 2b) Defaults que La Voz exige y nosotros no tenemos dato (provincia,
    //     tipo de barrio, tipo de vendedor, duración). No pisan un control
    //     que ya usó un campo del aviso.
    const defaults = planDefaults(controls, payload, plan.map((p) => idControl(p.control)));
    for (const { campo, control, valor } of defaults) {
      const loc = locatorDe(page, control);
      if (loc) {
        const actual = await loc.first().inputValue().catch(() => '');
        const yaEsta = (actual && String(actual).trim() === String(valor).trim())
          || (control.tag === 'combo' && String(control.value || '').trim().toLowerCase() === String(valor).trim().toLowerCase());
        if (yaEsta) continue;
      }
      const r = await llenarCampo(page, campo, valor, control);
      if (r.ok) hechos.push(`${r.texto} (default)`);
      else faltantes.push(`${campo.key}: ${r.motivo}`);
    }

    // 3) Radios/checkboxes (tipo de vendedor, operación, moneda, etc.).
    for (const op of OPCIONES) {
      const candidatos = typeof op.candidatos === 'function'
        ? op.candidatos(payload).filter(Boolean)
        : [op.valor(payload)].filter(Boolean);
      if (!candidatos.length) continue;
      let elegido = false;
      for (const valor of candidatos) {
        elegido = await marcarRadio(page, valor);
        if (elegido) { hechos.push(`opción "${valor}"`); break; }
      }
      if (!elegido && op.key === 'moneda') {
        monedaNoConfirmada = String(candidatos[0]);
        faltantes.push(`moneda no confirmada en wizard: ${candidatos[0]} (se dejó la opción actual)`);
        log(`  ! no pude confirmar la moneda "${candidatos[0]}" en el formulario (se deja la opción actual del wizard)`);
      }
    }

    // 3b) Botones que son opciones (La Voz usa botones, no radios, para
    //     "Operación": Venta / Alquileres / Alquileres Temporarios / ...).
    const op = await marcarBoton(page, payload.operacion_boton || payload.operacion_label || payload.operacion);
    if (op) hechos.push(`operación "${op}"`);

    // 3c) Casilla de "acepto los términos y condiciones" (si la hay).
    if (await aceptarTerminos(page)) hechos.push('términos aceptados');

    // 4) ¿Estamos en el último paso? (el botón final vive en el cuerpo)
    if (paso === PASOS_LAVOZ.length) {
      if (submit) {
        // Puede haber un paso extra (elegir plan de publicación) antes del
        // botón final: avanzamos mientras haya "Siguiente"/"Continuar".
        for (let intento = 0; intento < 4; intento++) {
          const pub = await clickTexto(page, RE_PUBLICAR, { scope: 'main' });
          if (pub.clicked) {
            hechos.push(`publicado ("${pub.texto}")`);
            await page.waitForTimeout(4000);
            return { hechos, faltantes, publicado: true, fotosSubidas, monedaNoConfirmada };
          }
          const cont = await clickTexto(page, RE_AVANZAR, { scope: 'main' });
          if (!cont.clicked) break;
          hechos.push(`avanzó ("${cont.texto}")`);
          await page.waitForTimeout(2500);
        }
      }
      break;
    }

    // 5) Avanzar al siguiente paso.
    const sig = await clickTexto(page, RE_AVANZAR, { scope: 'main' });
    if (sig.clicked) {
      hechos.push(`avanzó ("${sig.texto}")`);
      await page.waitForTimeout(2500);
      continue;
    }

    // Sin botón de avance: puede que el paso no haya cambiado (validación)
    // o que el wizard ya haya terminado.
    if (urlActual(page) !== urlAntes) { await page.waitForTimeout(2000); continue; }
    const errs = await erroresDeValidacion(page);
    if (errs.length) {
      for (const e of errs) faltantes.push(`validación: ${e}`);
      break;
    }
    break;
  }
  return { hechos, faltantes, publicado: false, fotosSubidas, monedaNoConfirmada };
}

/**
 * Marca un BOTÓN que actúa como opción (La Voz no usa <select> ni radios
 * para "Operación": son botones con el texto de la opción).
 */
async function marcarBoton(page, palabra) {
  if (!palabra) return null;
  return await page.evaluate((want) => {
    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const w = norm(want);
    const raiz = document.querySelector('main') || document.body;
    const botones = [...raiz.querySelectorAll('button')].filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const hit = botones.find((b) => norm(b.textContent) === w)
      || botones.find((b) => norm(b.textContent).includes(w));
    if (!hit) return null;
    const txt = (hit.textContent || '').replace(/\s+/g, ' ').trim();
    hit.click();
    return txt;
  }, palabra);
}

/* ---------------- URL del aviso publicado ---------------- */

/**
 * Un aviso REAL de La Voz tiene un id numérico en el path
 * (`/avisos/inmuebles/terreno/5680772/...`). El wizard `/publicar/inmuebles`
 * también es de lavoz.com.ar: aceptarlo guardaría la URL del formulario como
 * si fuera el aviso (y el CRM mostraría un link muerto como "publicado").
 */
function esUrlAvisoLaVoz(u) {
  try {
    const parsed = new URL(u);
    // `endsWith('.lavoz.com.ar')` con el PUNTO es clave: un regex de sufijo
    // como /lavoz\.com\.ar$/ también acepta dominios ajenos (notlavoz.com.ar,
    // evillavoz.com.ar) y guardaría un link que no es de La Voz como real.
    const host = parsed.hostname.toLowerCase();
    if (host !== 'lavoz.com.ar' && !host.endsWith('.lavoz.com.ar')) return false;
    if (/\/publicar(\/|$)/.test(parsed.pathname)) return false;
    return /\/\d{5,}(?:\/|$)/.test(parsed.pathname);
  } catch (_) { return false; }
}

async function capturarUrlAviso(page, payload) {
  await page.waitForTimeout(3000);
  const url = page.url();
  // Si la página es un listado, buscamos el link del aviso por el título.
  const link = await page.evaluate((titulo) => {
    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    const t = norm(titulo).slice(0, 28);
    const anchors = [...document.querySelectorAll('a[href]')];
    let best = null;
    for (const a of anchors) {
      const txt = norm(a.textContent);
      const href = a.getAttribute('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('javascript')) continue;
      if (t && txt.includes(t)) { best = a.href; break; }
      if (!best && /\/(avisos?|noticias?|inmuebles)\/[a-z0-9-]+/i.test(href)) best = a.href;
    }
    return best;
  }, payload.titulo || '');
  // Probamos el link encontrado PRIMERO y recién después la URL actual: si el
  // publish no navegó, la URL actual es el wizard y NO es un aviso.
  for (const candidato of [link, url]) {
    if (candidato && esUrlAvisoLaVoz(candidato)) return candidato;
  }
  return null;
}

const RE_RENOVAR = /renovar|reactivar|republicar|volver a publicar|ampliar|dar de alta de nuevo/i;

/* ---------------- Renovación (aviso vencido) ---------------- */

/**
 * Intenta RENOVAR un aviso ya publicado: abre la URL del aviso viejo y
 * busca el botón de renovación. Si no existe, devuelve false y el flujo
 * publica uno nuevo desde cero (mismo resultado para el lector).
 */
async function renovarAviso(page, adUrl) {
  if (!adUrl) return { ok: false, motivo: 'sin URL del aviso anterior' };
  await page.goto(adUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const btn = await clickTexto(page, RE_RENOVAR);
  if (!btn.clicked) return { ok: false, motivo: 'el aviso no tiene botón de renovación' };
  await page.waitForTimeout(3000);
  // Puede haber un paso de confirmación ("¿Renovar?"). No incluimos "renovar"
  // acá: el botón principal ya se clickeó y re-matchearlo puede duplicar la acción.
  const conf = await clickTexto(page, /confirmar|aceptar|\bs[ií]\b/i);
  if (conf.clicked) await page.waitForTimeout(2500);
  return { ok: true, texto: btn.texto };
}

/* ---------------- Modo estado (solo lectura) ---------------- */

/**
 * Muestra la cola de avisos de La Voz tal como está en el CRM.
 * No abre la sesión de La Voz ni publica nada: sirve para ver qué falta
 * antes de correr `npm run lavoz`.
 */
async function modoEstado() {
  const token = await crmToken({ esperar: false });
  const res = await crmCall(token, 'list');
  const listings = res.listings || [];
  if (!listings.length) {
    log('Todavía no hay avisos de La Voz. Usá "Preparar todas" en Portales (o corré npm run lavoz).');
    return;
  }
  const pad = (s, n) => String(s ?? '-').padEnd(n).slice(0, n);
  console.log('');
  console.log(pad('PROPIEDAD', 14) + pad('ESTADO', 12) + pad('PLAN', 14) + pad('PUBLICADO', 12) + pad('VENCE', 12) + 'URL');
  console.log('-'.repeat(96));
  for (const l of listings) {
    console.log(
      pad(l.properties?.property_code || (l.property_id || '').slice(0, 8), 14)
      + pad(l.status, 12)
      + pad(l.plan, 14)
      + pad(l.published_at ? l.published_at.slice(0, 10) : '-', 12)
      + pad(l.expires_at ? l.expires_at.slice(0, 10) : '-', 12)
      + (l.ad_url || '-'),
    );
    if (l.last_error) console.log(pad('', 14) + '⚠ ' + l.last_error);
  }
  const cuenta = (st) => listings.filter((l) => l.status === st).length;
  console.log('');
  console.log(`Total ${listings.length} · por publicar ${cuenta('ready') + cuenta('draft')} · publicados ${cuenta('published')} · vencidos ${cuenta('expired')} · con error ${cuenta('failed')}`);
  const pronto = listings.filter((l) => l.status === 'published' && l.expires_at && new Date(l.expires_at).getTime() - Date.now() < 7 * 86400000);
  if (pronto.length) {
    console.log(`⏰ Vencen en los próximos 7 días: ${pronto.map((l) => l.properties?.property_code).filter(Boolean).join(', ')} (npm run lavoz:renovar)`);
  }
}

/* ---------------- Modo discover ---------------- */

if (args.mode === 'estado') {
  try {
    await modoEstado();
  } catch (err) {
    log('✗', err.message);
    await ctx.close();
    process.exit(1);
  }
  await ctx.close();
  process.exit(0);
}

if (args.mode === 'discover') {
  await asegurarSesionLaVoz();
  await page.waitForTimeout(2000);
  const schema = await descubrirFormulario();
  fs.writeFileSync(SCHEMA_FILE, JSON.stringify(schema, null, 2), 'utf8');
  log(resumirSchema(schema));
  log('Schema guardado en', SCHEMA_FILE);
  await shot('discover');
  await ctx.close();
  process.exit(0);
}

/* ---------------- Modo run (cola) ---------------- */

// Las DOS sesiones se abren a la vez: la pestaña del CRM (para el token) y
// la de La Voz. Así el empleador ve los dos formularios de login y puede
// resolverlos en cualquier orden (una sola vez: el perfil los recuerda).
let tokenError = null;
const tokenPromise = crmToken().catch((err) => { tokenError = err; return null; });
await asegurarSesionLaVoz();
const token = await tokenPromise;
if (!token) throw tokenError || new Error('No se pudo obtener la sesión del CRM');

// La cola sale del CRM: avisos preparados (o vencidos, si --renew).
let cola = [];
if (args.payload) {
  // Modo archivo: payload local (compatibilidad).
  cola = [{ payload: JSON.parse(fs.readFileSync(path.resolve(args.payload), 'utf8')), property_id: null }];
} else {
  const res = await crmCall(token, 'list');
  let listings = res.listings || [];
  if (args.renew) {
    const limite = Date.now() + 7 * 86400000;
    listings = listings.filter((l) => l.status === 'expired' || (l.expires_at && new Date(l.expires_at).getTime() < limite));
  } else {
    // Candidatos: lo preparado + lo que quedó con datos incompletos (se
    // re-prepara y, si el dueño ya los completó, se publica).
    listings = listings.filter((l) => l.status === 'ready' || l.status === 'draft' || l.status === 'failed');
    // Cola vacía → se prepara todo desde acá (no hace falta tocar el panel).
    if (!listings.length) {
      log('No hay avisos preparados: los preparo ahora desde el CRM…');
      try {
        const prep = await crmCall(token, 'prepare_all');
        log(`  → ${prep.count || 0} aviso(s) preparados`);
        const res2 = await crmCall(token, 'list');
        listings = (res2.listings || []).filter((l) => l.status === 'ready' || l.status === 'draft' || l.status === 'failed');
      } catch (err) {
        log('  ! no pude preparar:', err.message);
      }
    }
  }
  if (args.only) listings = listings.filter((l) => l.properties?.property_code === args.only);
  cola = listings.slice(0, args.limit).map((l) => ({ row: l, property_id: l.property_id, payload: l.payload }));
  log(`Cola: ${cola.length} aviso(s)${args.renew ? ' (renovación)' : ''}`);
}

if (!cola.length) {
  log('No hay avisos en la cola. Preparalos desde el panel (Portales → La Voz → Preparar todas).');
  await ctx.close();
  process.exit(0);
}

let ok = 0;
let fallos = 0;
let omitidos = 0;
let simulados = 0;
const runResults = [];
const runStartedAt = new Date().toISOString();

const pushRunResult = (entry) => {
  runResults.push({
    ts: new Date().toISOString(),
    mode: args.renew ? 'renew' : 'publish',
    dry_run: !!args.dry,
    force_new: !!args.forceNew,
    ...entry,
  });
};

for (const item of cola) {
  const row = item.row;
  let payload = item.payload;
  const codeInicial = payload?.property_code || row?.properties?.property_code || '';

  // Payload fresco: lo arma la edge function (mapeos actualizados).
  // Devuelve el resultado COMPLETO (status/ad_url) para NO publicar un aviso
  // que el CRM ya marca publicado/vencido. El prepare viejo degradaba a
  // 'ready' y el asistente lo duplicaba con créditos reales (2026-11-22).
  const refrescarPayload = async () => {
    if (!item.property_id) return null;
    try {
      const r = await crmCall(token, 'prepare', { property_id: item.property_id });
      const res = (r.results || [])[0] || null;
      if (res?.payload) payload = res.payload;
      return res;
    } catch (err) {
      log('  ! no pude preparar:', err.message);
      return null;
    }
  };
  // En renovación NO se prepara antes: se intenta renovar el aviso viejo y
  // sólo se pide un payload nuevo si hay que crear uno desde cero.
  let refrescado = null;
  if (item.property_id && !args.renew) {
    refrescado = await refrescarPayload();
    if (refrescado && (refrescado.status === 'published' || refrescado.status === 'expired') && !args.forceNew) {
      omitidos++;
      log(`\n=== ${refrescado.property_code || codeInicial} — OMITIDO (CRM: ${refrescado.status}; link conservado)`);
      log('  · si querés duplicarlo a propósito: --force-new');
      pushRunResult({
        property_id: item.property_id || null,
        property_code: refrescado.property_code || codeInicial || null,
        status: 'skipped',
        reason: `crm_${refrescado.status}`,
        ad_url: refrescado.ad_url || row?.ad_url || null,
      });
      continue;
    }
  }
  if (!payload) {
    fallos++;
    pushRunResult({ property_id: item.property_id || null, property_code: codeInicial || null, status: 'failed', reason: 'sin_payload' });
    continue;
  }

  const code = payload.property_code || codeInicial;

  // Avisos con datos bloqueantes (sin operación/precio/subrubro): NO se
  // publican a ciegas. Quedan en 'failed' en el CRM con el motivo.
  if (tieneBloqueante(payload)) {
    const motivo = (payload.avisos || []).find((a) => RE_BLOQUEANTE.test(String(a)));
    omitidos++;
    log(`\n=== ${code} — OMITIDO (datos incompletos): ${motivo || 'faltan datos'}`);
    pushRunResult({
      property_id: item.property_id || null,
      property_code: code || null,
      status: 'skipped',
      reason: 'datos_incompletos',
      avisos: (payload.avisos || []).slice(0, 12),
    });
    continue;
  }

  log(`\n=== ${code} — ${payload.titulo}`);

  // Renovación: primero se intenta el botón "renovar" del aviso viejo.
  // En --dry NO se toca: renovar es una acción REAL en La Voz (reinicia el
  // aviso y quema créditos), igual que hacer clic en "Publicar". El preview
  // sólo llena el formulario y toma capturas.
  let publicado = false;
  if (args.renew && row?.ad_url && !args.dry) {
    const ren = await renovarAviso(page, row.ad_url);
    if (ren.ok) {
      log('  ✓ renovado en el panel:', ren.texto);
      publicado = true;
      if (item.property_id) {
        try {
          // `plan` vacío conserva el REAL del CRM: un plan_recomendado no es
          // un plan contratado y pisarlo mentiría sobre lo que se pagó.
          await crmCall(token, 'confirm', { property_id: item.property_id, ad_url: row.ad_url, plan: row.plan || undefined });
          log('  ✓ CRM actualizado (vencimiento renovado):', row.ad_url);
          ok++;
          pushRunResult({ property_id: item.property_id, property_code: code || codeInicial || null, status: 'renewed', ad_url: row.ad_url });
          continue;
        } catch (err) {
          /* La renovación YA ocurrió en La Voz (con el aviso viejo). Crear un
             aviso nuevo acá dejaría DOS avisos vivos y quemaría créditos.
             Se cuenta como OK y se deja la traza para que una persona
             concilie el CRM con "Marcar publicado". */
          log('  ! no pude confirmar en el CRM:', err.message);
          log('  · aviso YA renovado en La Voz; NO creo uno nuevo (evito duplicado).');
          log('  · actualizá el CRM a mano con: Portales → La Voz → "Marcar publicado" →', row.ad_url);
          ok++;
          pushRunResult({ property_id: item.property_id, property_code: code || codeInicial || null, status: 'renewed_crm_pending', ad_url: row.ad_url, reason: err.message });
          continue;
        }
      } else {
        ok++;
        pushRunResult({ property_id: item.property_id || null, property_code: code || codeInicial || null, status: 'renewed', ad_url: row.ad_url });
        continue;
      }
    } else {
      log('  · sin renovación en el panel:', ren.motivo);
      // Datos frescos: si el CRM dice 'published' el aviso sigue VIGENTE y
      // publicar uno nuevo quemaría créditos en un duplicado. Requiere
      // confirmación explícita (--force-new).
      refrescado = await refrescarPayload();
      if (refrescado?.status === 'published' && !args.forceNew) {
        omitidos++;
        log('  · el CRM lo marca PUBLICADO (sigue vigente): NO creo un aviso nuevo.');
        log('  · si querés duplicarlo a propósito: --renew --force-new');
        pushRunResult({ property_id: item.property_id || null, property_code: code || codeInicial || null, status: 'skipped', reason: 'published_still_active', ad_url: row?.ad_url || refrescado?.ad_url || null });
        continue;
      }
      log('  · publico uno nuevo (el anterior venció o no tiene link).');
    }
  }

  // Vuelvo al formulario LIMPIO navegando DIRECTO al wizard: el viejo goto a
  // /publicar obligaba a un segundo salto (/publicar → /publicar/inmuebles),
  // y en `--dry` (donde nunca se hace clic en Publicar) dejaba la página en
  // /publicar/inmuebles con el formulario del aviso ANTERIOR cargado — el
  // siguiente aviso heredaba datos ajenos. Un goto a INMUEBLES_URL resetea
  // ambos problemas: una sola navegación y formulario nuevo siempre.
  await page.goto(INMUEBLES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);

  const files = await bajarFotos(payload.fotos || [], path.join(os.tmpdir(), 'lavoz-publisher-fotos', code || 'prop'));
  const r = await publicarAviso(page, payload, files, { submit: args.submit && !args.dry });
  publicado = publicado || r.publicado;

  for (const h of r.hechos) log('  ✓', h);
  for (const f of r.faltantes) log('  !', f);
  const captura = await shot('aviso-' + (code || 'sin-codigo'));
  log('  → captura:', captura);

  if (publicado && item.property_id) {
    const url = await capturarUrlAviso(page, payload);
    /* El plan lo decide el `prepare` del servidor: para un aviso NUEVO es el
       recommendation por fotos, pero para un force-new sobre uno publicado
       es el plan REAL ya guardado (o null, que el confirm conserva). Usar
       `payload.plan_recomendado` acá le mentiría al CRM sobre lo contratado.
       Ojo: distingo "sin prepare" de "prepare con plan null" (?? no sirve). */
    const planConfirm = refrescado ? refrescado.plan : payload.plan_recomendado;
    try {
      // Si no se pudo capturar la URL, igual se confirma: dejarlo 'ready'
      // haría que la próxima corrida publicara el aviso OTRA VEZ (duplicado).
      await crmCall(token, 'confirm', { property_id: item.property_id, ad_url: url || undefined, plan: planConfirm });
      if (url) {
        log('  ✓ CRM actualizado:', url);
      } else {
        log('  ✓ CRM actualizado (vencimiento). No pude capturar la URL del aviso:');
        log('    revisá la captura y pegala en Portales → La Voz → "Marcar publicado".');
      }
      ok++;
      pushRunResult({ property_id: item.property_id, property_code: code || null, status: url ? 'published' : 'published_no_url', ad_url: url || null, plan: planConfirm || null, moneda_no_confirmada: r.monedaNoConfirmada || null, faltantes: r.faltantes || [], captura });
      continue;
    } catch (err) {
      log('  ! no pude confirmar en el CRM:', err.message);
      fallos++;
      pushRunResult({ property_id: item.property_id, property_code: code || null, status: 'published_crm_pending', ad_url: url || null, reason: err.message, moneda_no_confirmada: r.monedaNoConfirmada || null, faltantes: r.faltantes || [], captura });
      continue;
    }
  } else if (publicado) {
    ok++;
    pushRunResult({ property_id: item.property_id || null, property_code: code || null, status: 'published_local_only', ad_url: await capturarUrlAviso(page, payload), moneda_no_confirmada: r.monedaNoConfirmada || null, faltantes: r.faltantes || [], captura });
  } else if (args.dry) {
    /* --dry es un PREVIEW: nadie hizo clic en Publicar (ni en Renovar), así
       que no es un fallo. Antes se contaba como fallo y el script terminaba
       con exit 1 aunque el formulario se hubiera llenado perfecto. */
    simulados++;
    log('  ○ simulado (--dry): formulario lleno, NO se publicó ni se renovó');
    pushRunResult({ property_id: item.property_id || null, property_code: code || null, status: 'dry_run', moneda_no_confirmada: r.monedaNoConfirmada || null, faltantes: r.faltantes || [], captura, fotos_subidas: !!r.fotosSubidas });
  } else {
    fallos++;
    log('  ! no se publicó (faltó el botón o quedó un paso sin completar)');
    pushRunResult({ property_id: item.property_id || null, property_code: code || null, status: 'failed', reason: 'no_publicado', moneda_no_confirmada: r.monedaNoConfirmada || null, faltantes: r.faltantes || [], captura });
  }
}

const runSummary = {
  started_at: runStartedAt,
  finished_at: new Date().toISOString(),
  mode: args.renew ? 'renew' : 'publish',
  dry_run: !!args.dry,
  force_new: !!args.forceNew,
  only: args.only || null,
  limit: args.limit,
  totals: { ok, fallos, omitidos, simulados, total: runResults.length },
  results: runResults,
};

try {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const summaryPath = path.join(SHOTS_DIR, `run-${stamp}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(runSummary, null, 2), 'utf8');
  log('Resumen de corrida:', summaryPath);
  if (args.json) console.log(JSON.stringify(runSummary, null, 2));
} catch (err) {
  log('! no pude guardar el resumen de corrida:', err instanceof Error ? err.message : err);
  if (args.json) console.log(JSON.stringify(runSummary, null, 2));
}

log(`\nTerminado: ${ok} publicado(s), ${fallos} sin publicar, ${omitidos} omitido(s) (ya publicados/vigentes), ${simulados} simulado(s) (--dry).`);
await ctx.close();
process.exit(fallos ? 1 : 0);
