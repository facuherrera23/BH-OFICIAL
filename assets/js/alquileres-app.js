/* ============================================================
   BIENENHAUS PROPIEDADES — Administración de Alquileres
   CONTROLADOR Supabase (se carga DESPUÉS de alquileres-core.js)
   ------------------------------------------------------------
   - El core original queda intacto: toda la funcionalidad (órdenes,
     liquidaciones, rendiciones, pagos, facturas, OCR, WhatsApp, Excel).
   - Este archivo reemplaza la capa de persistencia "archivo HTML que
     se descarga" por la tabla alquileres_state (una fila por usuario,
     RLS user_id = auth.uid()).
   - Script clásico TOP-LEVEL (sin IIFE) a propósito: comparte el entorno
     léxico global con alquileres-core.js — así puede asignar los let del
     core (S, FID, vista, DIRTY, LAST, SAVEDAT) y llamar bhInitS/render/
     tot/restaurarAdj. ÚNICAMENTE est() y guardarArchivo() se re-declaran
     (function declarations: la última gana y pisa la versión del core que
     descargaba el archivo). NINGÚN otro nombre puede repetir uno del
     core — sería SyntaxError en carga (guard: tests/alquileres-module.spec.js).
   - Comparte la sesión con el admin (mismo storageKey default de
     supabase-client.js): si ya estás logueado en el panel, no pide login.
   ============================================================ */

const CFG = window.BH_CONFIG || {};
const OKCFG = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY
  && typeof window.supabase !== 'undefined' && window.supabase.createClient);

let client = null;         // cliente Supabase (compartido con el admin)
let alqUser = null;        // usuario autenticado (para el upsert)
let saveTimer = null;      // debounce
let saving = false;
let savePending = false;
let saveError = false;
let attempts = 0;

/* ---------- Modo embebido (iframe del panel admin) ----------
   Cuando la página corre dentro del iframe de la section
   #tab-alquileres, el host ajusta la altura del iframe al contenido
   real vía postMessage {type:'bh-alq-height'} — sin scroll interno,
   con el sidebar del panel siempre visible. ResizeObserver reporta
   cualquier cambio de altura (render, gate, mes, vistas). */
let EMBEDDED = false;
try { EMBEDDED = window.self !== window.top; } catch (_) { EMBEDDED = true; }
function alqNotifyHeight() {
  if (!EMBEDDED) return;
  try { window.parent.postMessage({ type: 'bh-alq-height', h: document.documentElement.scrollHeight }, location.origin); } catch (_) {}
}
if (EMBEDDED) {
  document.body.classList.add('embed');
  if (typeof ResizeObserver === 'function') {
    const alqRO = new ResizeObserver(alqNotifyHeight);
    alqRO.observe(document.body);
    alqRO.observe(document.documentElement);
  } else {
    setInterval(alqNotifyHeight, 600);
  }
}

/* ---------- UI: boot fallido y gate de login ---------- */
function failBoot(msg) {
  const vv = document.getElementById('v');
  if (vv) vv.innerHTML = '<div class="card" style="text-align:center;color:#FF4757"><b>'
    + String(msg).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
    + '</b></div>';
}
function gateShow() {
  const g = document.getElementById('alqGate');
  if (g) g.style.display = 'flex';
  const vv = document.getElementById('v');
  if (vv) vv.innerHTML = '';
  const e = document.getElementById('alqGateError');
  if (e) { e.style.display = 'none'; e.textContent = ''; }
}
function gateHide() {
  const g = document.getElementById('alqGate');
  if (g) g.style.display = 'none';
}
function gateError(msg) {
  const e = document.getElementById('alqGateError');
  if (e) { e.textContent = msg; e.style.display = msg ? 'block' : 'none'; }
}
function traducirAuth(m) {
  const s = String(m || '').toLowerCase();
  if (s.includes('invalid login credentials')) return 'Correo o contraseña incorrectos.';
  if (s.includes('email not confirmed')) return 'Primero confirmá tu correo desde el mail que te envió el panel.';
  if (s.includes('too many requests')) return 'Demasiados intentos. Esperá un minuto y probá de nuevo.';
  if (s.includes('failed to fetch') || s.includes('network')) return 'Sin conexión con el servidor. Revisá tu internet y probá de nuevo.';
  return m || 'No se pudo ingresar.';
}

/* ---------- est(): estado del guardado en la nube ----------
   (re-declaración que pisa la del core; est() es llamada por el core
   en cada save()/render() y resuelve a ESTA versión) */
function est() {
  if (!client) return;
  const e = document.getElementById('est');
  if (!e) return;
  if (saveError) { e.textContent = '⚠ Error de guardado — reintentando…'; e.style.color = '#b45309'; return; }
  e.textContent = DIRTY ? '● Guardando cambios…' : '✔ Guardado en la nube ' + SAVEDAT;
  e.style.color = DIRTY ? '#fca5a5' : '#86efac';
}

/* ---------- Sincronización con alquileres_state ---------- */
async function syncNow() {
  if (saving) { savePending = true; return; }
  if (!client || !S || !alqUser) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const snap = JSON.stringify(S);
  if (snap === LAST && !saveError) { est(); return; } // nada cambió desde el último persistido
  saving = true; savePending = false;
  try {
    const { error } = await client
      .from('alquileres_state')
      .upsert({ user_id: alqUser.id, state: JSON.parse(snap), updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw error;
    attempts = 0; saveError = false;
    LAST = snap;
    DIRTY = JSON.stringify(S) !== LAST;
    SAVEDAT = new Date().toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
    try { localStorage.setItem(dk(), JSON.stringify({ saved: Date.now(), j: snap })); } catch (_) {}
  } catch (err) {
    console.error('[alquileres] guardado:', err);
    saveError = true;
    if (++attempts <= 5) { saveTimer = setTimeout(syncNow, 3000 * attempts); }
  } finally {
    saving = false;
    est();
    if (savePending) { savePending = false; scheduleSave(200); }
  }
}
function scheduleSave(ms) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(syncNow, ms);
}
window.__ALQ_SYNC = () => scheduleSave(1200);

/* guardarArchivo del core (descargaba el HTML) → ahora guarda en la nube.
   Re-declaración que pisa la del core: el botón 💾 del header y el
   cierre de mes (mesMas) llaman a esta versión. */
function guardarArchivo() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  return syncNow();
}

/* ---------- Carga inicial ---------- */
async function getSesion() {
  const { data: s } = await client.auth.getSession();
  if (s && s.session && s.session.user) return s.session.user;
  const { data: u } = await client.auth.getUser(); // refresca token vencido
  return u && u.user;
}

async function init() {
  let user = null;
  try { user = await getSesion(); } catch (e) { console.error('[alquileres] sesión:', e); }
  if (!user) { gateShow(); return; }

  alqUser = user;
  FID = user.id; // cache local por usuario (dk())

  let row = null, err = null;
  try {
    const r = await client.from('alquileres_state').select('state,updated_at').eq('user_id', user.id).maybeSingle();
    row = r.data; err = r.error;
  } catch (e) { err = e; }
  if (err) console.error('[alquileres] carga:', err);

  if (row && row.state && Array.isArray(row.state.props)) {
    try {
      S = row.state;
      bhInitS(S);
      mezclarHist();
      vista = S.vista || 'res';
      LAST = JSON.stringify(S);
      DIRTY = false;
      saveError = false;
      SAVEDAT = row.updated_at ? new Date(row.updated_at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '';
    } catch (e) {
      // Estado ilegible en la DB: no morir en blanco — arrancar vacío y avisar
      console.error('[alquileres] estado ilegible, arranco vacío:', e);
      S = null;
      gateError('');
    }
  }
  if (!S) {
    // Usuario nuevo (o estado ilegible): arranca vacío con el mes actual
    // (configura sus datos en "Datos de la inmobiliaria"). NO hereda
    // propiedades de nadie: la fila es propia (RLS) y la crea su primer guardado.
    const dd = new Date();
    S = { corr: { n: '', d: '', t: '', b: '', v1: 10, v2: 20, rec: 20, dAgua: 10 }, m: dd.getMonth(), y: dd.getFullYear(), vista: 'res', sel: null, props: [], hist: {}, pagos: {} };
    bhInitS(S);
    vista = 'res';
  }

  gateHide();
  render(); tot(); est();
  alqNotifyHeight();
  try { await restaurarAdj(); } catch (_) {}
}

/* ---------- Arranque ---------- */
if (OKCFG) {
  client = window.supabaseClient || window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  window.supabaseClient = client;

  /* Gate: login */
  const form = document.getElementById('alqGateForm');
  if (form) form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('alqGateBtn');
    const email = (document.getElementById('alqGateEmail').value || '').trim();
    const pass = document.getElementById('alqGatePass').value || '';
    if (btn) { btn.disabled = true; btn.textContent = 'Ingresando…'; }
    try {
      const { error } = await client.auth.signInWithPassword({ email, password: pass });
      if (error) { gateError(traducirAuth(error.message)); return; }
      await init();
    } catch (err) {
      gateError(traducirAuth(err && err.message));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Ingresar'; }
    }
  });

  /* Eventos de sesión / pestaña */
  try {
    client.auth.onAuthStateChange(ev => {
      if (ev === 'SIGNED_OUT') { window.location.reload(); return; }
      if (ev === 'SIGNED_IN' && !S) init();
    });
  } catch (_) {}

  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && S && DIRTY && saveTimer) { clearTimeout(saveTimer); saveTimer = null; syncNow(); }
  });

  init();

  /* Diagnóstico si la librería no cargó (vendor roto, etc.) */
  setTimeout(function check() {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      failBoot('La librería de base de datos no cargó. Revisá tu conexión y recargá (F5).');
    }
  }, 4000);
} else {
  failBoot('No se pudo inicializar la base de datos (recursos no cargados). Revisá tu conexión y recargá (F5).');
}
