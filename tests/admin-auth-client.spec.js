// ============================================================
// Cliente autenticado del admin — singleton de GoTrueClient
// ------------------------------------------------------------
// Bug real (2026-10-30, reportado por el dueño durante la subida de
// contenido a YouTube):
//
//   "GoTrueClient@bh-authed-client:1 Multiple GoTrueClient instances detected
//    in the same browser context. It is not an error, but this should be
//    avoided as it may produce undefined behavior when used concurrently
//    under the same storage key."
//
// Causa raíz: getAuthedClient() chequeaba la caché ANTES del await de
// getSession(). Varias llamadas concurrentes (el Studio de Contenido dispara
// varias en paralelo: historial, cola, categorías, auditoría...) pasaban el
// chequeo con el cliente en null y creaban un GoTrueClient cada una, todas
// con el storageKey 'bh-authed-client'.
//
// Fix: el cliente se crea UNA sola vez (guard por promesa) y, cuando Supabase
// rota el token, sólo se actualiza la cabecera Authorization.
//
// Este test evalúa el BLOQUE REAL de assets/js/admin-app.js en un sandbox y
// reproduce el contador de instancias de @supabase/auth-js, así que falla
// contra el código viejo y pasa contra el nuevo.
// ============================================================
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-app.js'), 'utf8');

const START_MARK = '/* === BH-AUTH-CLIENT:START ===';
const END_MARK = '/* === BH-AUTH-CLIENT:END === */';

function extractBlock() {
  const start = SRC.indexOf(START_MARK);
  const end = SRC.indexOf(END_MARK);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('assets/js/admin-app.js no tiene el bloque BH-AUTH-CLIENT delimitado');
  }
  return SRC.slice(start, end);
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeJwt(payload) {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.firma`;
}

/* Levanta el bloque real en un sandbox con un supabase falso que reproduce el
   contador de instancias de @supabase/auth-js (y su warning). */
function boot() {
  const warnings = [];
  const instances = Object.create(null);
  const created = [];
  let session = {
    access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' }),
    user: { id: 'u-1' },
  };

  const createClient = (url, key, opts = {}) => {
    const storageKey = (opts.auth && opts.auth.storageKey) || 'default-storage-key';
    const instanceID = instances[storageKey] || 0;
    instances[storageKey] = instanceID + 1;
    if (instanceID > 0) {
      warnings.push(
        `GoTrueClient@${storageKey}:${instanceID} Multiple GoTrueClient instances detected in the same browser context.`
      );
    }
    const headers = { ...((opts.global && opts.global.headers) || {}) };
    const client = {
      url,
      key,
      opts,
      headers,
      /* PostgrestClient copia las cabeceras al construirse (new Headers). */
      rest: { headers: new Headers(headers) },
    };
    created.push(client);
    return client;
  };

  const mainClient = {
    auth: { getSession: async () => ({ data: { session } }) },
  };

  const sandbox = {
    console: { warn: (m) => warnings.push(String(m)), log: () => {}, error: () => {}, info: () => {} },
    Date, Math, JSON, Number, String, Boolean, Object, Array, Promise, Error,
    Uint8Array, TextDecoder, Headers, atob, btoa,
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.window = {
    BH_CONFIG: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'anon-test-key' },
    supabase: { createClient },
    supabaseClient: mainClient,
  };
  vm.createContext(sandbox);

  const src = [
    'var currentUser = { id: "u-1" };',
    extractBlock(),
    'globalThis.__api = { getAuthedClient, parseJwtExpiry, decodeJwtPayload, setUser(u) { currentUser = u; } };',
  ].join('\n');
  vm.runInContext(src, sandbox, { filename: 'admin-app.js#BH-AUTH-CLIENT' });

  return {
    api: sandbox.__api,
    warnings,
    created,
    instances,
    mainClient,
    setSession: (s) => { session = s; },
    setUser: (u) => sandbox.__api.setUser(u),
  };
}

test.describe('Cliente autenticado del admin — sin instancias duplicadas de GoTrue', () => {
  test('llamadas concurrentes crean UN solo cliente (sin warning)', async () => {
    const h = boot();
    const clients = await Promise.all([
      h.api.getAuthedClient(),
      h.api.getAuthedClient(),
      h.api.getAuthedClient(),
      h.api.getAuthedClient(),
      h.api.getAuthedClient(),
    ]);

    expect(h.created).toHaveLength(1);
    expect(h.warnings).toEqual([]);
    for (const c of clients) expect(c).toBe(h.created[0]);
  });

  test('el cliente autenticado usa su propio storageKey (no colisiona con el principal)', async () => {
    const h = boot();
    await h.api.getAuthedClient();
    const opts = h.created[0].opts;
    expect(opts.auth.storageKey).toBe('bh-authed-client');
    expect(opts.auth.persistSession).toBe(false);
  });

  test('llamadas secuenciales tampoco recrean el cliente', async () => {
    const h = boot();
    const a = await h.api.getAuthedClient();
    const b = await h.api.getAuthedClient();
    const c = await h.api.getAuthedClient();
    expect(h.created).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(h.warnings).toEqual([]);
  });

  test('cuando el token rota se actualiza la cabecera y NO se crea otro cliente', async () => {
    const h = boot();
    /* Token inicial ya vencido → cada llamada vuelve a leer la sesión (como
       pasa cuando el access token de Supabase está por expirar). */
    const viejo = makeJwt({ exp: Math.floor(Date.now() / 1000) - 10, role: 'authenticated' });
    h.setSession({ access_token: viejo, user: { id: 'u-1' } });

    const primero = await h.api.getAuthedClient();
    expect(primero.headers.Authorization).toBe(`Bearer ${viejo}`);

    /* Supabase rota el token. */
    const nuevo = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' });
    h.setSession({ access_token: nuevo, user: { id: 'u-1' } });

    const segundo = await h.api.getAuthedClient();
    expect(segundo).toBe(primero);            // misma instancia
    expect(h.created).toHaveLength(1);         // NO se creó otro GoTrueClient
    expect(h.warnings).toEqual([]);
    expect(segundo.headers.Authorization).toBe(`Bearer ${nuevo}`);
    /* PostgREST lee sus propias cabeceras → tienen que estar rotadas también. */
    expect(segundo.rest.headers.get('authorization')).toBe(`Bearer ${nuevo}`);
  });

  test('el token expirado no rompe: se re-lee la sesión en cada llamada', async () => {
    const h = boot();
    const vencido = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60, role: 'authenticated' });
    h.setSession({ access_token: vencido, user: { id: 'u-1' } });
    await h.api.getAuthedClient();
    await h.api.getAuthedClient();
    await h.api.getAuthedClient();
    expect(h.created).toHaveLength(1);
    expect(h.warnings).toEqual([]);
  });

  test('parseJwtExpiry decodifica payloads base64url (- y _), no sólo base64', () => {
    const h = boot();
    const payload = { exp: 1893456000, role: 'authenticated', nota: '???>>' };
    const token = makeJwt(payload);
    /* El payload usa el alfabeto base64url → atob() estándar lo rechaza. */
    expect(/[-_]/.test(token.split('.')[1])).toBe(true);
    expect(h.api.parseJwtExpiry(token)).toBe(1893456000 * 1000);
  });

  test('sin sesión autenticada devuelve el cliente principal (sin crear otro)', async () => {
    const h = boot();
    h.setSession(null);
    const c = await h.api.getAuthedClient();
    expect(h.created).toHaveLength(0);
    expect(c).toBe(h.mainClient);
  });

  test('sin usuario autenticado devuelve el cliente principal', async () => {
    const h = boot();
    h.setUser(null);
    const c = await h.api.getAuthedClient();
    expect(h.created).toHaveLength(0);
    expect(c).toBe(h.mainClient);
  });
});
