// RELA / ZonaProp — refresco automático del panel cuando cambia un aviso.
// Guards estáticos + behavioral (sin BD ni red): el realtime del admin debe
// suscribirse a rela_listings y, ante un cambio, refrescar Propiedades, el
// panel de Portales → RELA y los badges.
//
// POR QUÉ: antes había que recargar la pestaña para ver el botón "Publicar en
// RELA" o los contadores después de un publish/update/unpublish.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-app.js'), 'utf8');
const PORTALES_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-portales.js'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261124000001_rela_listings_realtime.sql'), 'utf8');

function matchingBrace(src, openIdx) {
  let depth = 0, quote = null, inLine = false, inBlock = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (inLine) { if (ch === '\n') inLine = false; continue; }
    if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; i++; } continue; }
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '/' && nx === '/') { inLine = true; i++; continue; }
    if (ch === '/' && nx === '*') { inBlock = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('No se pudo balancear el bloque desde ' + openIdx);
}
function extractFunction(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('No se encontró la función ' + name);
  const open = src.indexOf('{', m.index);
  return src.slice(m.index, matchingBrace(src, open) + 1);
}
function extractAssignedFunction(src, marker) {
  const idx = src.indexOf(marker);
  if (idx < 0) throw new Error('No se encontró: ' + marker);
  const open = src.indexOf('{', idx);
  return src.slice(idx, matchingBrace(src, open) + 1);
}

const REALTIME_CODE = extractFunction(APP_SRC, 'setupCoreRealtime');
const REFRESH_CODE = extractAssignedFunction(PORTALES_SRC, 'window.adminApp.refreshRelaPanel = function');

test.describe('RELA realtime — guards estáticos', () => {
  test('rela_listings está en la lista de tablas del canal core', () => {
    const tables = REALTIME_CODE.match(/const tables = \[[^\]]+\]/);
    expect(tables).not.toBeNull();
    expect(tables[0]).toContain("'rela_listings'");
  });

  test('el handler de rela_listings refresca propiedades, panel y badges', () => {
    const marker = "case 'rela_listings':";
    expect(REALTIME_CODE).toContain(marker);
    const bloque = REALTIME_CODE.slice(REALTIME_CODE.indexOf(marker), REALTIME_CODE.indexOf("break;", REALTIME_CODE.indexOf(marker)));
    expect(bloque).toContain('debouncedPropertiesRefresh()');
    expect(bloque).toContain('window.adminApp.refreshRelaPanel');
    expect(bloque).toContain('scheduleBadgeRefresh()');
  });

  test('refreshRelaPanel existe, tiene debounce y no redibuja un panel oculto', () => {
    expect(REFRESH_CODE).toContain('clearTimeout(_relaRefreshTimer)');
    expect(REFRESH_CODE).toContain('setTimeout(');
    expect(REFRESH_CODE).toContain('getClientRects()');
    expect(REFRESH_CODE).toContain('loadRelaPanel()');
    // Conserva el resultado de un preflight/import que el usuario esté leyendo.
    expect(REFRESH_CODE).toContain('preflightHtml');
    expect(REFRESH_CODE).toContain('contactsHtml');
  });

  test('la migración publica rela_listings en supabase_realtime (idempotente)', () => {
    expect(MIGRATION).toContain('pg_publication_tables');
    expect(MIGRATION).toContain('alter publication supabase_realtime add table public.rela_listings');
    expect(MIGRATION).toContain('if not exists');
  });
});

test.describe('RELA realtime — handler real', () => {
  test('un cambio en rela_listings dispara los tres refrescos (sin tocar filas del CRM)', async ({ page }) => {
    const res = await page.evaluate((code) => {
      window.__CORE_STUBS = [];
      const stub = (name) => function () { window.__CORE_STUBS.push(name); };
      window._coreRealtimeChannel = null;
      window.invalidateSearchCache = function () {};
      window.invalidateFichaCache = function () {};
      window.upsertPropertyRow = stub('upsertPropertyRow');
      window.upsertVisitRow = stub('upsertVisitRow');
      window.removeVisitRow = stub('removeVisitRow');
      window.upsertLeadCard = stub('upsertLeadCard');
      window.removeLeadCard = stub('removeLeadCard');
      window.populateBrokerFilters = stub('populateBrokerFilters');
      window.upsertAgentRow = stub('upsertAgentRow');
      window.removeAgentRow = stub('removeAgentRow');
      window.upsertOwnerRow = stub('upsertOwnerRow');
      window.removeOwnerRow = stub('removeOwnerRow');
      window.editingOwnerId = null;
      window.loadOwnerTasks = stub('loadOwnerTasks');
      window.upsertTasacionRow = stub('upsertTasacionRow');
      window.removeTasacionRow = stub('removeTasacionRow');
      window.scheduleBadgeRefresh = stub('scheduleBadgeRefresh');
      window.handleRealtimeStatus = function () {};
      window.__BH = { loadProperties: stub('loadProperties') };
      window.adminApp = { refreshRelaPanel: stub('refreshRelaPanel') };

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
      if (!handler) return { error: 'no se registró el handler' };
      handler({ table: 'rela_listings', eventType: 'UPDATE', new: { id: 'x', status: 'PUBLISHED' }, old: {} });
      return { stubs: window.__CORE_STUBS.slice() };
    }, REALTIME_CODE);

    expect(res.error).toBeUndefined();
    await page.waitForTimeout(900);
    const stubs = await page.evaluate(() => window.__CORE_STUBS.slice());
    expect(stubs).toContain('refreshRelaPanel');
    expect(stubs).toContain('loadProperties');
    expect(stubs).toContain('scheduleBadgeRefresh');
    expect(stubs).not.toContain('upsertPropertyRow');
  });
});
