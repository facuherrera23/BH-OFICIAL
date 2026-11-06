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
//   node scripts/lavoz-publisher.mjs --run --renew    # re-publica vencidos
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
const SUPABASE_STORAGE_KEY = 'sb-rnldqiwwzhjnurkguihu-auth-token';

/* ---------------- Args ---------------- */

function parseArgs(argv) {
  const args = {
    mode: 'discover', submit: false, dry: false, renew: false, url: PUBLISH_URL,
    payload: null, only: null, limit: 99,
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
  console.log('Uso: node scripts/lavoz-publisher.mjs --discover | --run [--only CODE] [--limit N] [--dry] [--renew]');
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

const page = ctx.pages()[0] || await ctx.newPage();

async function shot(nombre) {
  const file = path.join(SHOTS_DIR, `${nombre}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

/* ---------------- Sesión del CRM ---------------- */

async function crmToken({ esperar = true } = {}) {
  // 1) Token por variable de entorno (uso desatendido / otro equipo).
  if (process.env.BH_ACCESS_TOKEN) {
    log('✓ Token del CRM por variable de entorno');
    return process.env.BH_ACCESS_TOKEN;
  }
  // 2) La sesión del admin vive en localStorage del origen del panel; el perfil
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

async function asegurarSesionLaVoz() {
  await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (!urlActual(page).includes('/usuario/login')) {
    log('✓ Sesión de La Voz lista');
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
  if (urlFinal.includes('/usuario/login')) throw new Error('Login de La Voz no completado');
  if (!urlFinal.includes('/publicar')) {
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  log('✓ Sesión de La Voz lista');
}

/* ---------------- Descubrimiento del formulario ---------------- */

async function descubrirFormulario() {
  return await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const labelOf = (el) => {
      if (el.id) {
        const lb = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lb) return lb.textContent.trim();
      }
      const wrap = el.closest('label');
      if (wrap) return wrap.textContent.trim();
      const parent = el.parentElement;
      if (parent) {
        const t = parent.querySelector('label, .label, [class*="label"], [class*="Label"]');
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
        maxLength: el.getAttribute('maxlength') ? Number(el.getAttribute('maxlength')) : null,
        visible: visible(el),
      };
      if (el.tagName.toLowerCase() === 'select') {
        base.options = [...el.options].map((o) => ({ value: o.value, text: o.textContent.trim() }));
      }
      if (el.type === 'radio' || el.type === 'checkbox') base.value = el.value;
      return base;
    });
    const botones = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .map((b) => ({
        text: (b.textContent || b.value || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        id: b.id || null,
        type: b.getAttribute('type') || null,
        visible: visible(b),
      }))
      .filter((b) => b.text);
    const pasos = [...document.querySelectorAll('[class*="step"], nav li, [role="tab"]')]
      .map((s) => (s.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 12);
    return {
      url: location.href,
      title: document.title,
      heading: (document.querySelector('h1, h2')?.textContent || '').trim(),
      controls,
      botones,
      pasos,
      bodyStart: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
    };
  });
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
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const labelOf = (el) => {
      if (el.id) {
        const lb = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lb) return lb.textContent.trim();
      }
      const wrap = el.closest('label');
      if (wrap) return wrap.textContent.trim();
      const parent = el.parentElement;
      if (parent) {
        const t = parent.querySelector('label, .label, [class*="label"], [class*="Label"]');
        if (t) return t.textContent.trim();
      }
      return '';
    };
    return [...document.querySelectorAll('input, select, textarea')].map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: (el.type || '').toLowerCase(),
      id: el.id || null,
      name: el.name || null,
      placeholder: el.getAttribute('placeholder') || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      label: labelOf(el),
      visible: visible(el),
      options: el.tagName.toLowerCase() === 'select'
        ? [...el.options].map((o) => ({ value: o.value, text: o.textContent.trim() }))
        : undefined,
    }));
  });
}

async function marcarRadio(page, palabra) {
  // Busca un radio/checkbox cuya etiqueta (o el texto cercano) coincida.
  const ok = await page.evaluate((want) => {
    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const w = norm(want);
    const cands = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')];
    for (const el of cands) {
      const wrap = el.closest('label');
      const near = el.parentElement?.textContent || '';
      const txt = norm((wrap?.textContent || '') + ' ' + near + ' ' + (el.value || ''));
      if (txt.includes(w) || w.includes(txt.slice(0, 40))) {
        el.click();
        return true;
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

async function clickTexto(page, re, soloVisibles = true) {
  const els = page.locator('button, [role="button"], input[type="submit"], a.btn, a[class*="button"]');
  const total = await els.count();
  for (let i = 0; i < total; i++) {
    const el = els.nth(i);
    const txt = ((await el.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (!txt || !re.test(txt)) continue;
    if (soloVisibles && !(await el.isVisible().catch(() => false))) continue;
    await el.click({ timeout: 8000 }).catch(() => {});
    return { clicked: true, texto: txt };
  }
  return { clicked: false };
}

async function publicarAviso(page, payload, files, { submit }) {
  const hechos = [];
  const faltantes = [];
  let fotosSubidas = false;

  for (let paso = 1; paso <= 10; paso++) {
    const urlAntes = page.url();
    const controls = await controlsVisibles(page);

    // 1) Fotos (si este paso las tiene).
    if (!fotosSubidas && files.length) {
      const r = await subirFotos(page, files);
      if (r.ok) { fotosSubidas = true; hechos.push(`fotos subidas (${r.count})`); await page.waitForTimeout(2500); }
      else faltantes.push(`fotos: ${r.motivo}`);
    }

    // 2) Campos de texto/select.
    const plan = planLlenado(controls, payload);
    for (const { campo, control, valor } of plan) {
      // No pisar un campo ya lleno (el wizard reutiliza los mismos ids).
      const loc = locatorDe(page, control);
      if (loc) {
        const actual = await loc.first().inputValue().catch(() => '');
        if (actual && String(actual).trim() === String(valor).trim()) continue;
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
        if (actual && String(actual).trim() === String(valor).trim()) continue;
      }
      const r = await llenarCampo(page, campo, valor, control);
      if (r.ok) hechos.push(`${r.texto} (default)`);
      else faltantes.push(`${campo.key}: ${r.motivo}`);
    }

    // 3) Radios/checkboxes (tipo de vendedor, operación, etc.).
    for (const op of OPCIONES) {
      const valor = op.valor(payload);
      if (!valor) continue;
      const elegido = await marcarRadio(page, valor);
      if (elegido) hechos.push(`opción "${valor}"`);
    }

    // 3b) Casilla de "acepto los términos y condiciones" (si la hay).
    if (await aceptarTerminos(page)) hechos.push('términos aceptados');

    // 4) ¿Estamos en el último paso?
    if (submit) {
      const pub = await clickTexto(page, RE_PUBLICAR);
      if (pub.clicked) {
        hechos.push(`publicado ("${pub.texto}")`);
        await page.waitForTimeout(4000);
        return { hechos, faltantes, publicado: true, fotosSubidas };
      }
    }

    // 5) Si no, avanzar.
    const sig = await clickTexto(page, RE_SIGUIENTE);
    if (sig.clicked) {
      hechos.push(`avanzó ("${sig.texto}")`);
      await page.waitForTimeout(2500);
      continue;
    }

    if (page.url() !== urlAntes) { await page.waitForTimeout(2000); continue; }
    // Sin botón y sin cambio: puede que ya esté todo (o que falte algo).
    break;
  }
  return { hechos, faltantes, publicado: false, fotosSubidas };
}

/* ---------------- URL del aviso publicado ---------------- */

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
  const final = link || url;
  // Sólo aceptamos URLs de La Voz.
  if (!/lavoz\.com\.ar/.test(final)) return null;
  return final;
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
  // Puede haber un paso de confirmación ("¿Renovar?").
  const conf = await clickTexto(page, /confirmar|aceptar|s[ií]|renovar/i);
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

for (const item of cola) {
  const row = item.row;
  let payload = item.payload;

  // Payload fresco: lo arma la edge function (mapeos actualizados).
  const refrescarPayload = async () => {
    if (!item.property_id) return;
    try {
      const r = await crmCall(token, 'prepare', { property_id: item.property_id });
      const res = (r.results || [])[0];
      if (res) payload = res.payload;
    } catch (err) {
      log('  ! no pude preparar:', err.message);
    }
  };
  // En renovación NO se prepara antes: `prepare` resetea el estado a 'ready'
  // y el aviso viejo todavía está publicado (vencido). Se refresca sólo si al
  // final hay que republicar uno nuevo.
  if (item.property_id && !args.renew) await refrescarPayload();
  if (!payload) { fallos++; continue; }

  const code = payload.property_code || (row?.properties?.property_code ?? '');

  // Avisos con datos bloqueantes (sin operación/precio/subrubro): NO se
  // publican a ciegas. Quedan en 'failed' en el CRM con el motivo.
  if (tieneBloqueante(payload)) {
    const motivo = (payload.avisos || []).find((a) => /Falta la operación|Falta el precio|no tiene subrubro/i.test(String(a)));
    log(`\n=== ${code} — OMITIDO (datos incompletos): ${motivo || 'faltan datos'}`);
    continue;
  }

  log(`\n=== ${code} — ${payload.titulo}`);

  // Renovación: primero se intenta el botón "renovar" del aviso viejo.
  let publicado = false;
  if (args.renew && row?.ad_url) {
    const ren = await renovarAviso(page, row.ad_url);
    if (ren.ok) {
      log('  ✓ renovado en el panel:', ren.texto);
      publicado = true;
      if (item.property_id) {
        try {
          await crmCall(token, 'confirm', { property_id: item.property_id, ad_url: row.ad_url, plan: row.plan || payload.plan_recomendado });
          log('  ✓ CRM actualizado (vencimiento renovado):', row.ad_url);
          ok++;
          continue;
        } catch (err) { log('  ! no pude confirmar en el CRM:', err.message); }
      } else { ok++; continue; }
    } else {
      log('  · sin renovación en el panel:', ren.motivo, '→ publico uno nuevo');
      // Datos frescos para el aviso nuevo.
      await refrescarPayload();
    }
  }

  // Vuelvo al formulario limpio.
  await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);

  const files = await bajarFotos(payload.fotos || [], path.join(os.tmpdir(), 'lavoz-publisher-fotos', code || 'prop'));
  const r = await publicarAviso(page, payload, files, { submit: args.submit && !args.dry });
  publicado = publicado || r.publicado;

  for (const h of r.hechos) log('  ✓', h);
  for (const f of r.faltantes) log('  !', f);
  log('  → captura:', await shot('aviso-' + (code || 'sin-codigo')));

  if (publicado && item.property_id) {
    const url = await capturarUrlAviso(page, payload);
    try {
      // Si no se pudo capturar la URL, igual se confirma: dejarlo 'ready'
      // haría que la próxima corrida publicara el aviso OTRA VEZ (duplicado).
      await crmCall(token, 'confirm', { property_id: item.property_id, ad_url: url || undefined, plan: payload.plan_recomendado });
      if (url) {
        log('  ✓ CRM actualizado:', url);
      } else {
        log('  ✓ CRM actualizado (vencimiento). No pude capturar la URL del aviso:');
        log('    revisá la captura y pegala en Portales → La Voz → "Marcar publicado".');
      }
      ok++;
      continue;
    } catch (err) { log('  ! no pude confirmar en el CRM:', err.message); }
  } else if (publicado) {
    ok++;
  } else {
    fallos++;
    log('  ! no se publicó (faltó el botón o quedó un paso sin completar)');
  }
}

log(`\nTerminado: ${ok} publicado(s), ${fallos} sin publicar.`);
await ctx.close();
process.exit(fallos ? 1 : 0);
