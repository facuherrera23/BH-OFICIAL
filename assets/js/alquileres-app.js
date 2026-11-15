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
let loadFailed = false;    // true = la carga inicial falló → sync BLOQUEADO
                           // (si arrancara vacío, el primer auto-guardado
                           // pisaría la fila real con un estado vacío)
let rowStamp = null;       // updated_at de la fila tal como está en pantalla
                           // (null = usuario nuevo, sin fila remota todavía)
let conflictOpen = false;  // overlay de conflicto multi-dispositivo visible
let forceSave = false;     // el usuario eligió pisar la versión remota

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

/* Pantalla de reintento: la carga inicial falló (red/JWT) o el estado de la
   DB no se pudo interpretar. Muestra el problema + botón Reintentar;
   mientras loadFailed, syncNow está bloqueado — los datos reales de la nube
   jamás se pisan con un estado vacío. */
function showRetry() {
  failBoot('No se pudo cargar tu administración desde la nube (error de conexión). Tus datos están a salvo: no se guarda nada hasta que cargue bien.');
  const card = document.querySelector('#v .card');
  if (card && !document.getElementById('alqRetryBtn')) {
    const b = document.createElement('button');
    b.id = 'alqRetryBtn';
    b.textContent = 'Reintentar';
    b.style.cssText = 'margin-top:14px;padding:9px 22px;border-radius:9px;border:0;background:linear-gradient(135deg,#1FC8C3,#0E9488);color:#fff;font-weight:700;cursor:pointer;font-family:inherit;font-size:14px';
    b.addEventListener('click', () => { b.disabled = true; b.textContent = 'Reintentando…'; init(); });
    card.appendChild(b);
  }
}

/* ---------- Conflicto multi-dispositivo (Bloque 1.H) ----------
   La fila en la nube tiene un updated_at más nuevo que el de nuestra carga:
   otro dispositivo guardó después de nosotros (o mientras esta pestaña
   estaba en segundo plano). El guardado queda frenado hasta que el usuario
   decida: recargar desde la nube o pisar conscientemente. */
function conflictShow(cuando) {
  conflictOpen = true;
  const m = document.getElementById('alqConflictMsg');
  if (m) m.textContent = 'La administración se guardó desde otro dispositivo'
    + (cuando ? ' el ' + cuando : '')
    + '. Si guardás ahora, reemplazás esos cambios con los de esta pantalla. Si no, recargá para ver la versión de la nube (los cambios de acá se pierden).';
  const o = document.getElementById('alqConflict');
  if (o) o.style.display = 'flex';
  est();
}
function conflictHide() {
  conflictOpen = false;
  const o = document.getElementById('alqConflict');
  if (o) o.style.display = 'none';
  est();
}

function alqEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- Snapshot inmutable al cerrar mes (Bloque 1.B) ----------
   El core llama window.__ALQ_SNAPSHOT(mesCerrado, añoCerrado) dentro de
   mesMas(>0), ANTES de blanquear los servicios y avanzar el mes: la copia es
   exactamente "la administración como estaba al cerrar X". Best-effort: un
   fallo del respaldo nunca bloquea el cierre de mes. */
async function alqSnapshot(cm, cy) {
  if (!client || !alqUser || !S) return;
  try {
    const copy = JSON.parse(JSON.stringify(S)); // copia PROFUNDA inmediata (S sigue mutando)
    const { error } = await client.from('alquileres_snapshots').insert({
      user_id: alqUser.id,
      label: 'Cierre ' + MES[cm] + ' ' + cy,
      period: cy + '-' + String(cm + 1).padStart(2, '0'),
      state: copy,
    });
    if (error) console.error('[alquileres] snapshot:', error);
  } catch (e) { console.error('[alquileres] snapshot:', e); }
}
window.__ALQ_SNAPSHOT = (cm, cy) => { alqSnapshot(cm, cy); };

/* ---------- KPIs para el Dashboard del panel (Bloque 2.E + 2.D) ----------
   Se calculan con la MISMA lógica del core (calc/sorted/pagoG/listaInq —
   funciones del core accesibles desde acá) y viajan DENTRO del estado
   (S.kpis) en cada sync: el Dashboard los lee vía RPC sin duplicar la
   lógica de negocio. Vencimientos: misma fórmula que alertas() del core. */
function alqKpisCompute() {
  if (!S || !Array.isArray(S.props)) return null;
  let orden = 0, hon = 0, neto = 0, cobrados = 0, liquidadas = 0, cobrables = 0;
  const venc = [];
  for (const p of sorted()) {
    const c = calc(p);
    hon += (+c.hon || 0);
    if (c.cuenta) continue; // cuenta del cliente: sin orden/neto/cobranza (como el resumen)
    cobrables++;
    orden += (+c.tot || 0);
    neto += (+c.neto || 0);
    // cobro del inquilino del mes en curso — misma semántica que cobroTxt()
    const L = listaInq('inq:' + p.cod, ym(), c.tot);
    const sCob = L.reduce((a, x) => a + (+x.m || 0), 0);
    if (L.length && sCob >= c.tot - 0.5) cobrados++;
    // liquidación al propietario — misma semántica que liqTxt()
    if (pagoG('prop:' + own(p), ym()).ok) liquidadas++;
    // vencimientos de contrato — misma fórmula que alertas(); acotado a
    // [-3, +3] meses para que un contrato viejo no contamine para siempre
    if (p.fin) {
      const fp = String(p.fin).split('-').map(Number);
      if (fp[0] && fp[1]) {
        const d = (fp[0] - S.y) * 12 + (fp[1] - 1 - S.m);
        if (d <= 3 && d >= -3) venc.push({ cod: p.cod, dir: p.dir || '', fin: p.fin, d });
      }
    }
  }
  const r2 = v => Math.round((+v || 0) * 100) / 100;
  return {
    m: S.m, y: S.y, props: S.props.length, cobrables,
    orden: r2(orden), hon: r2(hon), neto: r2(neto),
    cobrados, liquidadas,
    vencimientos: venc.sort((a, b) => a.d - b.d).slice(0, 10),
  };
}

/* ---------- Ventana de respaldos: listar + restaurar ---------- */
let alqSnapsCache = [];
async function alqSnapsOpen() {
  const o = document.getElementById('alqSnaps');
  if (!o || !client || !alqUser) return;
  o.style.display = 'flex';
  const list = document.getElementById('alqSnapsList');
  list.innerHTML = '<div style="color:#8E9BAE;font-size:13px;padding:14px 0">Cargando respaldos…</div>';
  try {
    const { data, error } = await client
      .from('alquileres_snapshots')
      .select('id,label,period,created_at,state')
      .eq('user_id', alqUser.id)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw error;
    alqSnapsCache = data || [];
    if (!alqSnapsCache.length) {
      list.innerHTML = '<div style="color:#8E9BAE;font-size:13px;padding:14px 0">Todavía no hay respaldos: se crean automáticamente cada vez que cerrás un mes (botón "Cerrar mes y pasar al siguiente").</div>';
      return;
    }
    list.innerHTML = alqSnapsCache.map((s, i) => {
      const kb = Math.round(JSON.stringify(s.state).length / 1024);
      const props = (s.state && Array.isArray(s.state.props)) ? s.state.props.length : '?';
      return '<div style="display:flex;gap:10px;align-items:center;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px;margin-bottom:8px">'
        + '<div style="flex:1;min-width:0"><div style="color:#F8FAFC;font-weight:700;font-size:13.5px">' + alqEsc(s.label) + '</div>'
        + '<small style="color:#8E9BAE">' + alqEsc(new Date(s.created_at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })) + ' · ' + props + ' propiedades · ' + kb + ' KB</small></div>'
        + '<button class="s" data-snap="' + i + '" style="background:transparent;color:#F8FAFC;border-color:#5b6b85">Restaurar</button></div>';
    }).join('');
    list.querySelectorAll('button[data-snap]').forEach(b => b.addEventListener('click', () => alqSnapsRestore(Number(b.dataset.snap))));
  } catch (e) {
    console.error('[alquileres] respaldos:', e);
    list.innerHTML = '<div style="color:#FF4757;font-size:13px;padding:14px 0">No se pudieron cargar los respaldos. Revisá tu conexión y probá de nuevo.</div>';
  }
}
async function alqSnapsRestore(i) {
  const s = alqSnapsCache[i];
  if (!s || !s.state || !Array.isArray(s.state.props)) return;
  if (!confirm('Restaurar "' + s.label + '"?\n\nSe reemplaza TODO el estado actual por el respaldo (meses posteriores incluidos) y se guarda en la nube. Esta acción no se puede deshacer.')) return;
  try {
    S = s.state;
    bhInitS(S);
    mezclarHist();
    HM = ym(); vista = 'res';
    LAST = null;           // fuerza el guardado del estado restaurado
    DIRTY = true;
    saveError = false; attempts = 0;
    render(); tot(); est();
    syncNow(); // persiste el estado restaurado (con chequeo de conflicto)
    const o = document.getElementById('alqSnaps');
    if (o) o.style.display = 'none';
  } catch (e) {
    console.error('[alquileres] restaurar:', e);
    alert('El respaldo no se pudo restaurar (estado ilegible).');
  }
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
  if (conflictOpen) { e.textContent = '⚠ Modificada en otro dispositivo — decidí en el aviso'; e.style.color = '#F59E0B'; return; }
  if (saveError) { e.textContent = '⚠ Error de guardado — reintentando…'; e.style.color = '#F59E0B'; return; }
  e.textContent = DIRTY ? '● Guardando cambios…' : '✔ Guardado en la nube ' + SAVEDAT;
  e.style.color = DIRTY ? '#fca5a5' : '#86efac';
}

/* ---------- Sincronización con alquileres_state ---------- */
async function syncNow() {
  if (saving) { savePending = true; return; }
  if (!client || !S || !alqUser || loadFailed) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  // KPIs para el Dashboard (Bloque 2.E): recalculados con la lógica del core
  // y persistidos dentro del estado — el Dashboard solo los lee.
  if (S && Array.isArray(S.props)) { try { S.kpis = alqKpisCompute(); } catch (_) {} }
  const snap = JSON.stringify(S);
  if (snap === LAST && !saveError) { est(); return; } // nada cambió desde el último persistido

  // Conflicto multi-dispositivo (Bloque 1.H): la fila remota es más nueva que
  // nuestra carga → otro dispositivo guardó después de nosotros. Frenar el
  // guardado y avisar. Si la verificación falla (red), seguimos: el upsert
  // mismo va a fallar si no hay conexión.
  // ⚠️ Comparar por INSTANTE (Date.parse), nunca por string: PostgREST
  // re-formatea el timestamptz ('...+00:00') y el toISOString que mandamos es
  // '...Z' — un string-distinto sería un falso conflicto en cada guardado propio.
  if (!forceSave) {
    let remote = null, eRemote = null;
    try {
      const r = await client.from('alquileres_state').select('updated_at').eq('user_id', alqUser.id).maybeSingle();
      remote = r.data; eRemote = r.error;
    } catch (e) { eRemote = e; }
    const remoteMs = remote && remote.updated_at ? Date.parse(remote.updated_at) : NaN;
    const localMs = rowStamp ? Date.parse(rowStamp) : NaN;
    if (!eRemote && remote && !Number.isNaN(remoteMs) && !Number.isNaN(localMs) && remoteMs !== localMs) {
      conflictShow(new Date(remoteMs).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }));
      return;
    }
  } else {
    forceSave = false;
  }

  saving = true; savePending = false;
  try {
    const sentAt = new Date().toISOString();
    const { error } = await client
      .from('alquileres_state')
      .upsert({ user_id: alqUser.id, state: JSON.parse(snap), updated_at: sentAt }, { onConflict: 'user_id' });
    if (error) throw error;
    attempts = 0; saveError = false;
    LAST = snap;
    rowStamp = sentAt; // el stamp remoto ahora es el que acabamos de escribir
    DIRTY = JSON.stringify(S) !== LAST;
    SAVEDAT = new Date(sentAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
    try { localStorage.setItem(dk(), JSON.stringify({ saved: Date.now(), j: snap })); } catch (_) {}
  } catch (err) {
    console.error('[alquileres] guardado:', err);
    saveError = true;
    if (++attempts <= 5) { saveTimer = setTimeout(syncNow, 3000 * attempts); }
    else { saveTimer = setTimeout(syncNow, 30000); } // tras 5 fallos: reintento lento permanente (el estado "reintentando…" es verdad)
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

  let cargado = false;
  if (row && row.state && Array.isArray(row.state.props)) {
    try {
      S = row.state;
      bhInitS(S);
      mezclarHist();
      vista = S.vista || 'res';
      LAST = JSON.stringify(S);
      rowStamp = row.updated_at || null; // base para el chequeo de conflicto
      conflictOpen = false; forceSave = false;
      DIRTY = false;
      saveError = false;
      attempts = 0;
      SAVEDAT = row.updated_at ? new Date(row.updated_at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '';
      cargado = true;
    } catch (e) {
      // Estado ilegible en la DB: NO arrancar vacío — la fila queda intacta
      // para inspección/recuperación y el sync sigue bloqueado (loadFailed).
      console.error('[alquileres] estado ilegible:', e);
      S = null;
    }
  }
  if (!cargado && (row || err)) {
    // Hay fila propia (ilegible) o la lectura falló (red/JWT): NUNCA arrancar
    // vacío — el primer auto-guardado pisaría la fila real con un estado
    // vacío (el RLS lo permite: es la fila propia). Pantalla de reintento.
    loadFailed = true;
    gateHide();
    showRetry();
    return;
  }
  if (!S) {
    // Usuario nuevo (lectura OK sin fila): arranca vacío con el mes actual
    // (configura sus datos en "Datos de la inmobiliaria"). NO hereda
    // propiedades de nadie: la fila es propia (RLS) y la crea su primer guardado.
    const dd = new Date();
    S = { corr: { n: '', d: '', t: '', b: '', v1: 10, v2: 20, rec: 20, dAgua: 10 }, m: dd.getMonth(), y: dd.getFullYear(), vista: 'res', sel: null, props: [], hist: {}, pagos: {} };
    bhInitS(S);
    vista = 'res';
    rowStamp = null; // sin fila remota: no hay conflicto posible en el primer guardado
  }
  loadFailed = false;

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

  /* Conflicto al volver a la pestaña (Bloque 1.H): mientras estuvo oculta,
     otro dispositivo pudo guardar. Chequeo liviano (una lectura de updated_at);
     si la remota es más nueva → aviso con las dos salidas. Comparación por
     instante (Date.parse) — ver el comentario en syncNow. */
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !client || !S || !alqUser || loadFailed || saving || conflictOpen) return;
    client.from('alquileres_state').select('updated_at').eq('user_id', alqUser.id).maybeSingle()
      .then(r => {
        const remoteMs = r && !r.error && r.data && r.data.updated_at ? Date.parse(r.data.updated_at) : NaN;
        const localMs = rowStamp ? Date.parse(rowStamp) : NaN;
        if (!Number.isNaN(remoteMs) && !Number.isNaN(localMs) && remoteMs !== localMs) {
          conflictShow(new Date(remoteMs).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }));
        }
      })
      .catch(_ => _);
  });

  /* Overlays: botones del conflicto y cierre de respaldos */
  const cRel = document.getElementById('alqConflictReload');
  if (cRel) cRel.addEventListener('click', () => { window.location.reload(); });
  const cOver = document.getElementById('alqConflictOverwrite');
  if (cOver) cOver.addEventListener('click', () => { conflictHide(); forceSave = true; syncNow(); });
  const sClose = document.getElementById('alqSnapsClose');
  if (sClose) sClose.addEventListener('click', () => { const o = document.getElementById('alqSnaps'); if (o) o.style.display = 'none'; });

  /* Reconexión de red: si la carga inicial había fallado, reintentar sola. */
  window.addEventListener('online', () => { if (loadFailed && !S) init(); });

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
