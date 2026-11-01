// ============================================================
// Propiedades: red de tests del CRUD (Lote 0)
// ------------------------------------------------------------
// El modulo de Propiedades (assets/js/admin-propiedades.js) no tenia
// NINGUNA cobertura: la suite no detectaba una regresion al guardar,
// editar, mandar a la papelera o publicar en lote.
//
// Este spec monta el modulo REAL contra:
//   - el markup REAL del tab y del modal (extraido de admin.html);
//   - el codigo REAL de validacion (PropertySchema / validateForm,
//     extraido de assets/js/admin-app.js);
//   - un cliente Supabase FALSO (tests/helpers/fake-postgrest.js) que
//     loguea el payload EXACTO de cada escritura.
//
// NO toca la base real ni produccion.
// ============================================================
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HTML = path.join(ROOT, 'admin.html');
const APP_SRC = path.join(ROOT, 'assets', 'js', 'admin-app.js');
const PROP_SRC = path.join(ROOT, 'assets', 'js', 'admin-propiedades.js');
const TAS_SRC = path.join(ROOT, 'assets', 'js', 'admin-tasaciones.js');

const adminHtml = fs.readFileSync(ADMIN_HTML, 'utf8');
const appSrc = fs.readFileSync(APP_SRC, 'utf8');
const propSrc = fs.readFileSync(PROP_SRC, 'utf8');
const tasSrc = fs.readFileSync(TAS_SRC, 'utf8');

/* ------------------------------------------------------------
   Extractores: el codigo bajo prueba se COPIA del fuente real,
   nunca se reescribe en el test.
   ------------------------------------------------------------ */

/* Devuelve el indice de la llave que cierra el bloque abierto en openIdx.
   Ignora strings, templates y comentarios (suficiente para el codigo que
   copiamos: no hay regex literales con llaves ni templates anidados). */
function matchingBrace(src, openIdx) {
  let depth = 0;
  let quote = null;
  let inLine = false;
  let inBlock = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    const nx = src[i + 1];
    if (inLine) { if (ch === '\n') inLine = false; continue; }
    if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; i++; } continue; }
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && nx === '/') { inLine = true; i++; continue; }
    if (ch === '/' && nx === '*') { inBlock = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('No se pudo balancear el bloque desde ' + openIdx);
}

/* function nombre(...) { ... } */
function extractFunction(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('No se encontró la función ' + name);
  const openIdx = src.indexOf('{', m.index);
  const end = matchingBrace(src, openIdx);
  return src.slice(m.index, end + 1);
}

/* const nombre = ...;  (una sola sentencia) */
function extractConst(src, name) {
  const idx = src.indexOf('const ' + name + ' =');
  if (idx < 0) throw new Error('No se encontró la constante ' + name);
  const semi = src.indexOf(';', idx);
  return src.slice(idx, semi + 1);
}

/* const nombre = z.object({ ... }); */
function extractConstObject(src, name) {
  const idx = src.indexOf('const ' + name + ' =');
  if (idx < 0) throw new Error('No se encontró la constante ' + name);
  const openIdx = src.indexOf('{', idx);
  const end = matchingBrace(src, openIdx);
  const semi = src.indexOf(';', end);
  return src.slice(idx, semi + 1);
}

/* window.algo = async function () { ... } */
function extractAssignedFunction(src, marker) {
  const idx = src.indexOf(marker);
  if (idx < 0) throw new Error('No se encontró: ' + marker);
  const openIdx = src.indexOf('{', idx);
  const end = matchingBrace(src, openIdx);
  return src.slice(idx, end + 1);
}

/* Bloque de HTML entre dos marcas */
function extractBetween(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error('No se encontró: ' + startMarker);
  const b = src.indexOf(endMarker, a + startMarker.length);
  if (b < 0) throw new Error('No se encontró: ' + endMarker);
  return src.slice(a, b);
}

const TAB_HTML = extractBetween(adminHtml, '<section class="tab-module" id="tab-propiedades">', '<!-- 3. CRM LEADS -->');
const MODAL_HTML = extractBetween(adminHtml, '<div class="admin-modal" id="propertyModal">', '<!-- MODAL LEAD -->');

const VALIDATION_CODE = [
  extractConst(appSrc, 'z'),
  extractConstObject(appSrc, 'PropertySchema'),
  extractFunction(appSrc, 'zodBaseType'),
  extractFunction(appSrc, 'validateForm'),
].join('\n\n');

const REALTIME_CODE = extractFunction(appSrc, 'setupCoreRealtime');

/* ------------------------------------------------------------
   Fixtures
   ------------------------------------------------------------ */
const OWNER_ACTIVO = 'aaaaaaaa-1111-1111-1111-111111111111';
const OWNER_INACTIVO = 'aaaaaaaa-2222-2222-1111-111111111111';
const OWNER_BORRADO = 'aaaaaaaa-3333-1111-1111-111111111111';
const USER_ID = '11111111-1111-1111-1111-111111111111';

const PROP_NORMAL = 'bbbbbbbb-1111-1111-1111-111111111111';
const PROP_VENDIDA = 'bbbbbbbb-2222-2222-1111-111111111111';
const PROP_RESERVADA = 'bbbbbbbb-3333-3333-1111-111111111111';
const PROP_PAPELERA = 'bbbbbbbb-4444-4444-1111-111111111111';

function baseProperty(over) {
  return Object.assign({
    id: PROP_NORMAL,
    title: 'Casa en Palermo',
    description: 'Descripcion original de la propiedad',
    property_code: 'FH-P0001',
    property_type: 'casa',
    status: 'venta',
    zone: 'Palermo',
    locality: 'CABA',
    address: 'Av. Siempreviva 742',
    price_usd: 100000,
    price_currency: 'USD',
    area_m2: 80,
    surface_covered: 80,
    surface_total: 200,
    garage_spaces: 2,
    rooms: 3,
    bedrooms: 2,
    bathrooms: 1,
    year_built: 2010,
    maintenance_fee: 25000,
    inscription_number: '12-345678-9',
    owner_id: OWNER_ACTIVO,
    agent_id: null,
    video_url: 'https://youtu.be/abc123',
    facebook_url: 'https://facebook.com/example',
    tiktok_url: 'https://tiktok.com/@example',
    is_published: true,
    featured: false,
    is_retasada: false,
    is_oportunidad: false,
    is_shared: false,
    is_vendida: false,
    is_reservada: false,
    pets_allowed: false,
    furnished: false,
    full_bathrooms: null,
    has_storage: false,
    image_urls: [],
    latitude: null,
    longitude: null,
    created_by: USER_ID,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
  }, over || {});
}

function fixture() {
  return {
    properties: [
      baseProperty(),
      baseProperty({ id: PROP_VENDIDA, title: 'Depto vendida', property_code: 'FH-P0002', is_vendida: true, is_published: false }),
      baseProperty({ id: PROP_RESERVADA, title: 'Depto reservada', property_code: 'FH-P0003', is_reservada: true, is_published: false }),
      baseProperty({ id: PROP_PAPELERA, title: 'Depto en papelera', property_code: 'FH-P0004', deleted_at: '2026-02-01T00:00:00Z', is_published: false }),
    ],
    owners: [
      { id: OWNER_ACTIVO, full_name: 'Propietario Activo', status: 'activo', deleted_at: null },
      { id: OWNER_INACTIVO, full_name: 'Propietario Retirado', status: 'inactivo', deleted_at: null },
      { id: OWNER_BORRADO, full_name: 'Propietario Borrado', status: 'activo', deleted_at: '2026-01-01T00:00:00Z' },
    ],
    agents: [],
    rela_listings: [],
    social_posts: [],
    ml_listings: [{ property_id: PROP_NORMAL, ml_item_id: 'MLA999999999', ml_status: 'active' }],
    property_documents: [],
    visit_surveys: [],
  };
}

/* ------------------------------------------------------------
   Arranque del harness
   ------------------------------------------------------------ */
async function boot(page, dbOpts) {
  await page.goto('/tests/helpers/propiedades-crud-harness.html');

  await page.evaluate(({ tabHtml, modalHtml }) => {
    document.getElementById('bh-injected').innerHTML = tabHtml + '\n' + modalHtml;
  }, { tabHtml: TAB_HTML, modalHtml: MODAL_HTML });

  /* Codigo REAL de validacion (PropertySchema + validateForm). */
  await page.evaluate((code) => {
    const api = new Function(code + '\nreturn { PropertySchema, validateForm, zodBaseType };')();
    window.__BH.PropertySchema = api.PropertySchema;
    window.__BH.validateForm = api.validateForm;
    window.__BH.zodBaseType = api.zodBaseType;
  }, VALIDATION_CODE);

  /* Modulos REALES: tasaciones (define sharePropertyWhatsApp) y propiedades. */
  await page.evaluate(() => new Promise((resolve, reject) => {
    const load = (src, next) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => { if (next) next(); else resolve(); };
      s.onerror = () => reject(new Error('No se pudo cargar ' + src));
      document.head.appendChild(s);
    };
    load('../../assets/js/admin-tasaciones.js', () => load('../../assets/js/admin-propiedades.js'));
  }));

  /* Espias sobre las funciones publicas del modulo. */
  await page.evaluate(() => {
    window.__WA_CALLS = [];
    window.__ML_CALLS = [];
    window.__RELA_CALLS = [];
    window.__LOAD_PROPERTIES_CALLS = 0;

    const wa = window.adminApp.sharePropertyWhatsApp;
    window.adminApp.sharePropertyWhatsApp = function () {
      window.__WA_CALLS.push({ id: arguments[0], code: arguments[1] });
      return wa.apply(this, arguments);
    };

    const lp = window.__BH.loadProperties;
    window.__BH.loadProperties = function () {
      window.__LOAD_PROPERTIES_CALLS++;
      return lp.apply(this, arguments);
    };
  });

  /* page.evaluate recibe UN solo argumento: se pasa todo en un objeto. */
  await page.evaluate((payload) => window.__setupDb(payload.fixture, payload.opts), {
    fixture: fixture(),
    opts: dbOpts || {},
  });
  return page;
}

/* Llena el formulario del modal (markup real) */
async function fillForm(page, values) {
  await page.evaluate((vals) => {
    const form = document.getElementById('propertyForm');
    form.reset();
    Object.keys(vals).forEach((k) => {
      const el = form.elements[k];
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!vals[k];
      else el.value = vals[k] == null ? '' : String(vals[k]);
      /* El modulo REAL deshabilita el input de la moneda inactiva
         (togglePriceFields): hay que disparar el change como lo hace la UI. */
      if (k === 'price_currency') el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }, values);
}

async function submitForm(page, op) {
  await page.evaluate(() => document.getElementById('propertyForm').requestSubmit());
  await page.waitForFunction(
    (wanted) => window.__HARNESS_LOG.some((e) => e.op === wanted),
    op,
    { timeout: 15000 }
  );
}

/* Vacia campos del form (para probar que se pueden limpiar) */
async function clearFields(page, names) {
  await page.evaluate((list) => {
    const form = document.getElementById('propertyForm');
    list.forEach((k) => {
      const el = form.elements[k];
      if (!el) return;
      if (el.type === 'checkbox') el.checked = false;
      else el.value = '';
    });
  }, names);
}

function writeOps(log, op) {
  return log.filter((e) => e.op === op && e.table === 'properties');
}

const FORM_COMPLETO = {
  title: 'Casa de prueba',
  property_type: 'casa',
  status: 'venta',
  price_usd: 150000,
  price_currency: 'USD',
  zone: 'Palermo',
  locality: 'CABA',
  address: 'Av. Test 123',
  rooms: 3,
  bedrooms: 2,
  bathrooms: 1,
  garage_spaces: 1,
  surface_covered: 90,
  surface_total: 180,
  year_built: 2015,
  maintenance_fee: 30000,
  inscription_number: '99-888777-6',
  is_published: true,
};

/* ============================================================
   1. Payload del alta (INSERT)
   ============================================================ */
test.describe('Propiedades: payload del alta', () => {
  test('el INSERT manda created_by, el precio en la moneda elegida y nunca price_ars', async ({ page }) => {
    await boot(page);
    await fillForm(page, FORM_COMPLETO);
    await submitForm(page, 'insert');

    const log = await page.evaluate(() => window.__HARNESS_LOG);
    const ins = writeOps(log, 'insert');
    expect(ins).toHaveLength(1);

    const p = ins[0].payload[0];
    expect(p.title).toBe('Casa de prueba');
    expect(p.created_by).toBe(USER_ID);
    expect(p.price_usd).toBe(150000);
    expect(p.price_currency).toBe('USD');
    /* price_ars NO es una columna de properties: no puede viajar en el payload */
    expect(p).not.toHaveProperty('price_ars');
    expect(Array.isArray(p.image_urls)).toBe(true);
    expect(p.zone).toBe('Palermo');
  });

  test('con moneda ARS el precio viaja en price_usd + price_currency', async ({ page }) => {
    await boot(page);
    await fillForm(page, Object.assign({}, FORM_COMPLETO, { price_currency: 'ARS', price_usd: '', price_ars: 50000000 }));
    await submitForm(page, 'insert');

    const log = await page.evaluate(() => window.__HARNESS_LOG);
    const p = writeOps(log, 'insert')[0].payload[0];
    expect(p.price_currency).toBe('ARS');
    expect(p.price_usd).toBe(50000000);
    expect(p).not.toHaveProperty('price_ars');
  });
});

/* ============================================================
   2. Payload de la edicion (UPDATE)
   ============================================================ */
test.describe('Propiedades: payload de la edicion', () => {
  test('el UPDATE NO manda created_by (no pisa la autoria de la ficha)', async ({ page }) => {
    await boot(page);
    await page.evaluate((id) => window.adminApp.editProperty(id), PROP_NORMAL);
    await submitForm(page, 'update');

    const log = await page.evaluate(() => window.__HARNESS_LOG);
    const upd = writeOps(log, 'update');
    expect(upd).toHaveLength(1);
    expect(upd[0].payload).not.toHaveProperty('created_by');
    expect(upd[0].filters).toEqual([{ t: 'eq', col: 'id', val: PROP_NORMAL }]);
  });

  test('los campos opcionales vacios se mandan como null (se pueden limpiar)', async ({ page }) => {
    await boot(page);
    await page.evaluate((id) => window.adminApp.editProperty(id), PROP_NORMAL);
    await clearFields(page, [
      'description', 'address', 'locality', 'video_url', 'facebook_url',
      'tiktok_url', 'inscription_number', 'year_built', 'maintenance_fee', 'agent_id',
    ]);
    await submitForm(page, 'update');

    const log = await page.evaluate(() => window.__HARNESS_LOG);
    const p = writeOps(log, 'update')[0].payload;
    ['description', 'address', 'locality', 'video_url', 'facebook_url', 'tiktok_url',
      'inscription_number', 'year_built', 'maintenance_fee', 'agent_id', 'owner_id',
    ].forEach((campo) => {
      expect(p).toHaveProperty(campo, null);
    });
  });

  test('un campo con valor NO se manda como null', async ({ page }) => {
    await boot(page);
    await page.evaluate((id) => window.adminApp.editProperty(id), PROP_NORMAL);
    await submitForm(page, 'update');

    const log = await page.evaluate(() => window.__HARNESS_LOG);
    const p = writeOps(log, 'update')[0].payload;
    expect(p.description).toBe('Descripcion original de la propiedad');
    expect(p.address).toBe('Av. Siempreviva 742');
    expect(p.year_built).toBe(2010);
  });
});

/* ============================================================
   3. Validacion (schema REAL de admin-app.js)
   ============================================================ */
test.describe('Propiedades: validacion', () => {
  test('la validacion acepta property_type=ph (esta en el enum de la DB)', async ({ page }) => {
    await boot(page);
    const res = await page.evaluate(() => {
      const r = window.__BH.PropertySchema.safeParse({
        title: 'Casa tipo ph', price_usd: 100, price_currency: 'USD',
        property_type: 'ph', status: 'venta', zone: 'Centro',
      });
      return { ok: r.success, issues: r.success ? [] : r.error.issues.map((i) => String(i.path.join('.'))) };
    });
    expect(res.issues).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test('la zona es obligatoria (en la DB es NOT NULL)', async ({ page }) => {
    await boot(page);
    const res = await page.evaluate(() => {
      const r = window.__BH.PropertySchema.safeParse({
        title: 'Casa sin zona', price_usd: 100, price_currency: 'USD',
        property_type: 'casa', status: 'venta',
      });
      return { ok: r.success, issues: r.success ? [] : r.error.issues.map((i) => String(i.path.join('.'))) };
    });
    expect(res.ok).toBe(false);
    expect(res.issues).toContain('zone');
  });

  test('el schema incluye full_bathrooms y has_storage (columnas que existen en la DB)', async ({ page }) => {
    await boot(page);
    const shape = await page.evaluate(() => Object.keys(window.__BH.PropertySchema.shape));
    expect(shape).toContain('full_bathrooms');
    expect(shape).toContain('has_storage');
  });
});

/* ============================================================
   4. Acciones en lote
   ============================================================ */
test.describe('Propiedades: acciones en lote', () => {
  async function seleccionarTodas(page) {
    await page.evaluate(() => window.__BH.loadProperties());
    await page.waitForSelector('#propertiesTableBody .prop-row-check');
    await page.evaluate(() => {
      document.querySelectorAll('#propertiesTableBody .prop-row-check').forEach((c) => {
        c.checked = true;
        c.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  }

  test('publicar en lote NO publica las vendidas ni las reservadas', async ({ page }) => {
    await boot(page);
    await seleccionarTodas(page);
    await page.click('#propBulkPublish');
    await page.waitForFunction(() => window.__TOASTS.length > 0, null, { timeout: 15000 });

    const log = await page.evaluate(() => window.__HARNESS_LOG);
    const upd = writeOps(log, 'update');
    expect(upd.length).toBeGreaterThan(0);
    const inFilter = upd[upd.length - 1].filters.find((f) => f.t === 'in');
    expect(inFilter).toBeTruthy();
    expect(inFilter.vals).toEqual([PROP_NORMAL]);

    const toasts = await page.evaluate(() => window.__TOASTS);
    expect(toasts.some((t) => /1 publicad/.test(t.msg))).toBe(true);
  });

  test('el toast del bulk NO miente cuando la RLS filtra todas las filas', async ({ page }) => {
    await boot(page, { rls: true, blockedIds: [PROP_NORMAL, PROP_VENDIDA, PROP_RESERVADA] });
    await seleccionarTodas(page);
    await page.click('#propBulkPublish');
    await page.waitForFunction(() => window.__TOASTS.length > 0, null, { timeout: 15000 });

    const toasts = await page.evaluate(() => window.__TOASTS);
    expect(toasts.some((t) => /No se actualiz/i.test(t.msg))).toBe(true);
    expect(toasts.some((t) => /publicad/.test(t.msg))).toBe(false);
  });
});

/* ============================================================
   5. Papelera
   ============================================================ */
test.describe('Propiedades: papelera', () => {
  test('borrar usa el dialogo del panel (no confirm nativo) y hace soft-delete', async ({ page }) => {
    await boot(page);
    await page.evaluate((id) => window.adminApp.deleteProperty(id), PROP_NORMAL);
    await page.waitForFunction(() => window.__HARNESS_LOG.some((e) => e.op === 'update'), null, { timeout: 15000 });

    const native = await page.evaluate(() => window.__NATIVE_CONFIRMS);
    const confirms = await page.evaluate(() => window.__CONFIRMS);
    expect(native).toEqual([]);
    expect(confirms).toHaveLength(1);

    const log = await page.evaluate(() => window.__HARNESS_LOG);
    const upd = writeOps(log, 'update')[0];
    expect(upd.payload.deleted_at).toBeTruthy();
    expect(upd.payload.is_published).toBe(false);
    expect(upd.filters.some((f) => f.t === 'is' && f.col === 'deleted_at' && f.val === null)).toBe(true);
  });

  test('restaurar de la papelera limpia deleted_at', async ({ page }) => {
    await boot(page);
    await page.evaluate((id) => window.adminApp.restoreProperty(id), PROP_PAPELERA);
    await page.waitForFunction(() => window.__HARNESS_LOG.some((e) => e.op === 'update'), null, { timeout: 15000 });

    const log = await page.evaluate(() => window.__HARNESS_LOG);
    const upd = writeOps(log, 'update')[0];
    expect(upd.payload).toHaveProperty('deleted_at', null);
    expect(upd.filters.some((f) => f.t === 'not' && f.col === 'deleted_at')).toBe(true);
  });

  test('eliminar definitivamente pide doble confirmacion con el dialogo del panel', async ({ page }) => {
    await boot(page);
    await page.evaluate((id) => window.adminApp.destroyProperty(id), PROP_NORMAL);
    await page.waitForFunction(() => window.__HARNESS_LOG.some((e) => e.op === 'delete'), null, { timeout: 15000 });

    const native = await page.evaluate(() => window.__NATIVE_CONFIRMS);
    const confirms = await page.evaluate(() => window.__CONFIRMS);
    expect(native).toEqual([]);
    expect(confirms).toHaveLength(2);
  });
});

/* ============================================================
   6. Handlers de fila
   ============================================================ */
test.describe('Propiedades: handlers de fila', () => {
  test('compartir por WhatsApp se dispara UNA sola vez (no hay doble listener)', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__BH.loadProperties());
    await page.waitForSelector('#propertiesTableBody [data-wa-share]');
    await page.click('#propertiesTableBody [data-wa-share]');

    const calls = await page.evaluate(() => window.__WA_CALLS);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe(PROP_NORMAL);
  });

  test('los botones de ML y de RELA se disparan una sola vez', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      window.ml_connected = true;
      return window.__BH.loadProperties();
    });
    await page.waitForSelector('#propertiesTableBody [data-ml-update-prop]');

    await page.click('#propertiesTableBody [data-ml-update-prop]');
    const ml = await page.evaluate(() => window.__ML_CALLS);
    expect(ml).toHaveLength(1);

    await page.click('#propertiesTableBody [data-rela-action="publish"]');
    const rela = await page.evaluate(() => window.__RELA_CALLS);
    expect(rela).toHaveLength(1);
  });
});

/* ============================================================
   7. Selector de propietarios
   ============================================================ */
test.describe('Propiedades: selector de propietarios', () => {
  test('marca los propietarios inactivos y excluye los borrados', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__BH.loadProperties());
    await page.waitForSelector('#propOwnerSelect option', { state: 'attached' });

    const opts = await page.evaluate(() => Array.from(document.querySelectorAll('#propOwnerSelect option'))
      .map((o) => ({ value: o.value, text: o.textContent.trim() })));

    const activo = opts.find((o) => o.value === OWNER_ACTIVO);
    const inactivo = opts.find((o) => o.value === OWNER_INACTIVO);
    const borrado = opts.find((o) => o.value === OWNER_BORRADO);

    expect(activo).toBeTruthy();
    expect(inactivo).toBeTruthy();
    expect(inactivo.text).toMatch(/\(inactivo\)/i);
    expect(borrado).toBeFalsy();
  });
});

/* ============================================================
   8. Realtime
   ============================================================ */
test.describe('Propiedades: realtime', () => {
  test('un cambio en properties recarga la tabla (no inserta filas fantasma)', async ({ page }) => {
    await boot(page);

    const res = await page.evaluate((code) => {
      window.__CORE_STUBS = [];
      const stub = (name) => function () { window.__CORE_STUBS.push(name); };
      window._coreRealtimeChannel = null;
      window.invalidateSearchCache = function () {};
      window.invalidateFichaCache = function () {};
      window.upsertVisitRow = stub('upsertVisitRow');
      window.removeVisitRow = stub('removeVisitRow');
      window.scheduleBadgeRefresh = stub('scheduleBadgeRefresh');
      window.upsertLeadCard = stub('upsertLeadCard');
      window.removeLeadCard = stub('removeLeadCard');
      window.upsertPropertyRow = stub('upsertPropertyRow');
      window.removePropertyRow = stub('removePropertyRow');
      window.populateBrokerFilters = stub('populateBrokerFilters');
      window.upsertAgentRow = stub('upsertAgentRow');
      window.removeAgentRow = stub('removeAgentRow');
      window.upsertOwnerRow = stub('upsertOwnerRow');
      window.removeOwnerRow = stub('removeOwnerRow');
      window.editingOwnerId = null;
      window.loadOwnerTasks = stub('loadOwnerTasks');
      window.upsertTasacionRow = stub('upsertTasacionRow');
      window.removeTasacionRow = stub('removeTasacionRow');
      window.handleRealtimeStatus = function () {};

      const clientPrevio = window.supabaseClient;
      let handler = null;
      window.supabaseClient = {
        channel: function () {
          return {
            on: function (evt, filter, h) { handler = h; return this; },
            subscribe: function () { return this; },
            unsubscribe: function () {}
          };
        }
      };

      const setup = new Function(code + '\nreturn setupCoreRealtime;')();
      setup();
      window.supabaseClient = clientPrevio;

      if (!handler) return { error: 'no se registro el handler' };
      handler({ table: 'properties', eventType: 'INSERT', new: { id: 'x', title: 'y' }, old: {} });
      return { stubs: window.__CORE_STUBS.slice() };
    }, REALTIME_CODE);

    expect(res.error).toBeUndefined();
    await page.waitForTimeout(1200);

    const calls = await page.evaluate(() => ({
      stubs: window.__CORE_STUBS.slice(),
      loads: window.__LOAD_PROPERTIES_CALLS
    }));
    expect(calls.stubs).not.toContain('upsertPropertyRow');
    expect(calls.loads).toBeGreaterThan(0);
  });
});

/* ============================================================
   9. Guardas estaticas
   ============================================================ */
test.describe('Propiedades: guardas estaticas', () => {
  test('la tabla de propiedades usa colspan=10 (tiene 10 columnas)', () => {
    const tab = extractBetween(adminHtml, '<section class="tab-module" id="tab-propiedades">', '<!-- 3. CRM LEADS -->');
    expect(tab).not.toContain('colspan="9"');
    expect(tab).toContain('colspan="10"');
  });

  test('el modulo de Propiedades no usa el confirm() nativo', () => {
    const nativos = propSrc.match(/(^|[^.\w])confirm\s*\(/g) || [];
    expect(nativos).toEqual([]);
  });

  test('admin-tasaciones.js NO maneja data-wa-share (el handler vive donde se renderiza el boton)', () => {
    expect(tasSrc).not.toContain('data-wa-share');
  });

  test('el CSV de propiedades usa is_published y excluye la papelera', () => {
    const csv = extractAssignedFunction(appSrc, 'window.exportPropertiesCSV = async function');
    expect(csv).toContain('is_published');
    expect(csv).not.toMatch(/\bp\.published\b/);
    expect(csv).toMatch(/\.is\('deleted_at',\s*null\)/);
  });

  test('el comentario de price_ars no afirma que sea una columna generada', () => {
    expect(propSrc).not.toMatch(/price_ars[^\n]*columna generada/i);
  });

  test('el modal ofrece el tipo ph y los campos full_bathrooms / has_storage', () => {
    expect(MODAL_HTML).toMatch(/<option value="ph">/);
    expect(MODAL_HTML).toContain('name="full_bathrooms"');
    expect(MODAL_HTML).toContain('name="has_storage"');
  });
});

module.exports = {
  ROOT, ADMIN_HTML, APP_SRC, PROP_SRC, TAS_SRC,
  adminHtml, appSrc, propSrc, tasSrc,
  matchingBrace, extractFunction, extractConst, extractConstObject, extractBetween,
  extractAssignedFunction,
  TAB_HTML, MODAL_HTML, VALIDATION_CODE, REALTIME_CODE,
  OWNER_ACTIVO, OWNER_INACTIVO, OWNER_BORRADO, USER_ID,
  PROP_NORMAL, PROP_VENDIDA, PROP_RESERVADA, PROP_PAPELERA,
  baseProperty, fixture, boot, fillForm, clearFields, submitForm, writeOps,
};

