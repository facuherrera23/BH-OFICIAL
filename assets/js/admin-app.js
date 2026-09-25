/* ============================================================
   BIENENHAUS PROPIEDADES — Admin Panel App (Luxury v2)
   Matches admin.html luxury design system
   ============================================================ */

const _usdFormatter = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const _arsFormatter = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const _numFormatter = new Intl.NumberFormat('es-AR');

(function () {
  'use strict';
  document.body.dataset.bhIifeStarted = 'true';

  /* Modularización: window.adminApp y los helpers DOM se publican
     acá (antes que cualquier asignación) porque los módulos
     admin-*.js se cargan después de este archivo y los leen. */
  window.adminApp = window.adminApp || {};
  window.$ = window.$ || ((sel, ctx = document) => ctx.querySelector(sel));
  window.$$ = window.$$ || ((sel, ctx = document) => Array.from(ctx.querySelectorAll(sel)));

  /* ------------------------------------------------
     DEBUG FLAG — false en producción, true solo en desarrollo
     ------------------------------------------------ */
  const DEBUG = false;

  function logError(...args) {
    if (DEBUG) console.error(...args);
  }

  function logWarn(...args) {
    if (DEBUG) console.warn(...args);
  }

  /* ------------------------------------------------
     PASSWORD SECURITY — HIBP k-anonymity check
     Fail-open: si la verificación falla, permite (no bloquear usuarios legítimos)
  ------------------------------------------------ */
  async function checkPasswordPwned(password) {
    try {
      const res = await fetch('https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/check-password-hash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': window.location.origin },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) return { pwned: false, count: 0, source: 'http_error' };
      const data = await res.json();
      return { pwned: !!data.pwned, count: data.count || 0 };
    } catch (err) {
      // Fail-open: error de red, CORS, timeout, etc.
      console.warn('[checkPasswordPwned] fail-open:', err);
      return { pwned: false, count: 0, source: 'error' };
    }
  }

  /* ------------------------------------------------
     0. STATE & REFS
     ------------------------------------------------ */
  let currentUser = null;
  let currentProfile = null;
  let currentSection = 'tab-dashboard';
  let editingPropertyId = null;
  let _submittingProperty = false;
  let _pendingPropertyNotes = [];
  let _submittingAgent = false;
let _submittingOwner = false;

  let _ownerFormSourcePropertyModal = false;

  let _createdOwnerId = null;

  let _submittingPortal = false;
  /* Pagination state */
  let _propPage = 1;
  let _propPageSize = 25;
  let _propTotalCount = 0;
  /* Propiedades: búsqueda server-side, filtros, papelera, selección masiva */
  let _propSearchQuery = '';
  let _propStatusFilter = '';
  let _propPubFilter = '';
  let _propAgentFilter = '';
  let _propViewTrash = false;
  let _propTrashCount = 0;
  let _propPaginationBound = false;
  const _propSelected = new Set();
  let _crmPage = 1;
  let _crmPageSize = 25;
  let _crmTotalCount = 0;
  let _tasacionesPage = 1;
  let _tasacionesPageSize = 25;
  let _tasacionesTotalCount = 0;

  /* ------------------------------------------------
     EVENT LISTENER REGISTRY (for cleanup on tab switch)
     ------------------------------------------------ */
  const _listenerRegistry = [];

  function on(el, event, handler, options) {
    if (!el) return;
    el.addEventListener(event, handler, options);
    _listenerRegistry.push({ el, event, handler, options });
  }

  function offAll() {
    _listenerRegistry.forEach(({ el, event, handler, options }) => {
      if (el) el.removeEventListener(event, handler, options);
    });
    _listenerRegistry.length = 0;
  }

function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  // Timezone selector (AR/UTC) for supervision module
  let _supTimezone = 'America/Argentina/Buenos_Aires';

  function getSupTimezone() {
    return _supTimezone;
  }

  function setSupTimezone(tz) {
    _supTimezone = tz;
    // Re-render current view if in supervision
    if (currentSection === 'tab-supervision' && _supCurrentView) {
      switchSupView(_supCurrentView);
    }
  }

  function formatDateWithTZ(dateStr, options = {}) {
    if (!dateStr) return '—';
    const defaultOpts = { timeZone: getSupTimezone(), ...options };
    return new Date(dateStr).toLocaleDateString('es-AR', defaultOpts);
  }

  function formatDateTimeWithTZ(dateStr, options = {}) {
    if (!dateStr) return '—';
    const defaultOpts = { timeZone: getSupTimezone(), hour: '2-digit', minute: '2-digit', ...options };
    return new Date(dateStr).toLocaleString('es-AR', defaultOpts);
  }
  let editingAgentId = null;
  let editingOwnerId = null;
  let editingLeadId = null;
  let editingVisitId = null;
  let toastTimer = null;
  let ml_connected = false;
  let ml_user = null;
  let ml_listings = [];
  let ml_configured = false;

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  /* ------------------------------------------------
     ZOD VALIDATION SCHEMAS
     ------------------------------------------------ */
  const z = window.Zod;

  // Property validation
  const PropertySchema = z.object({
    title: z.string().min(3, 'El título debe tener al menos 3 caracteres').max(120, 'Máximo 120 caracteres'),
    description: z.string().min(10, 'La descripción debe tener al menos 10 caracteres').max(5000, 'Máximo 5000 caracteres').optional().nullable(),
    property_code: z.string().max(30, 'Máximo 30 caracteres').optional().nullable(),
    price_usd: z.number().min(0).default(0),
    price_ars: z.number().min(0).default(0),
    price_currency: z.enum(['USD', 'ARS'], { errorMap: () => ({ message: 'Moneda debe ser USD o ARS' }) }).default('USD'),
    property_type: z.enum(['casa', 'departamento', 'terreno', 'local', 'oficina', 'galpon', 'quinta', 'otro'], { errorMap: () => ({ message: 'Tipo de propiedad inválido' }) }).default('casa'),
    status: z.enum(['venta', 'alquiler', 'vendido', 'alquilado', 'pausado'], { errorMap: () => ({ message: 'Operación debe ser venta o alquiler' }) }).default('venta'),
    zone: z.string().min(2, 'Zona/barrio requerido').max(80, 'Máximo 80 caracteres').optional().nullable(),
    locality: z.string().max(80, 'Máximo 80 caracteres').optional().nullable(),
    address: z.string().max(200, 'Máximo 200 caracteres').optional().nullable(),
    bedrooms: z.number().int().min(0).max(20).default(0),
    bathrooms: z.number().int().min(0).max(20).default(0),
    surface_covered: z.number().min(0).max(999999).default(0),
    surface_total: z.number().min(0).max(999999).default(0),
    garage_spaces: z.number().int().min(0).max(10).default(0),
    rooms: z.number().int().min(0).max(20).default(0),
    year_built: z.number().int().min(1800, 'Año inválido').max(2100, 'Año inválido').optional().nullable(),
    inscription_number: z.string().max(80, 'Máximo 80 caracteres').optional().nullable(),
    maintenance_fee: z.number().min(0).optional().nullable(),
    pets_allowed: z.boolean().default(false),
    furnished: z.boolean().default(false),
    video_url: z.string().url('URL de video inválida').optional().nullable(),
    is_published: z.boolean().default(false),
    facebook_url: z.string().url('URL de Facebook inválida').optional().nullable(),

    tiktok_url: z.string().url('URL de TikTok inválida').optional().nullable(),

    featured: z.boolean().default(false),
    is_retasada: z.boolean().default(false),
    is_oportunidad: z.boolean().default(false),
    is_shared: z.boolean().default(false),
    is_vendida: z.boolean().default(false),
    is_reservada: z.boolean().default(false),
    owner_id: z.string().uuid('ID de propietario inválido').optional().nullable(),
    agent_id: z.string().uuid('ID de broker inválido').optional().nullable(),
  }).superRefine((v, ctx) => {
    if (v.surface_total > 0 && v.surface_covered > 0 && v.surface_covered > v.surface_total) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['surface_covered'], message: 'La superficie cubierta no puede superar la superficie del terreno' });
    }
  });

  // Lead validation
  const LeadSchema = z.object({
    full_name: z.string().min(2, 'Nombre completo requerido').max(100, 'Máximo 100 caracteres'),
    email: z.string().email('Email inválido').max(150).optional().nullable(),
    phone: z.string().max(30).optional().nullable(),
    whatsapp: z.string().max(30).optional().nullable(),
    source: z.enum(['landing_page', 'newsletter', 'landing', 'ml', 'chat', 'referido', 'tasacion', 'walkin', 'manual']).default('manual'),
    stage: z.enum(['nuevo', 'contactado', 'calificado', 'visita_agendada', 'visita_realizada', 'negociacion', 'cerrado_ganado', 'cerrado_perdido']).default('nuevo'),
    property_id: z.string().uuid('ID de propiedad inválido').optional().nullable(),
    assigned_to: z.string().uuid('ID de broker inválido').optional().nullable(),
    budget_usd: z.number().min(0).max(10000000).default(0),
    preferred_zone: z.string().max(80).optional().nullable(),
    preferred_type: z.string().max(50).optional().nullable(),
    preferred_rooms: z.number().int().min(0).max(20).optional().nullable(),
    tipo_cliente: z.enum(['propietario','comprador','inversor','inquilino']).optional().nullable(),
    operation_type: z.enum(['compra','venta','alquiler']).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  });

  // Visit validation
  const VisitSchema = z.object({
    lead_id: z.preprocess(v => (v === '' || v == null ? null : v), z.string().uuid('ID de lead inválido').optional().nullable()),
    property_id: z.string().uuid('Seleccioná una propiedad'),
    agent_id: z.string().uuid('ID de broker inválido').optional().nullable(),
    client_name: z.string().min(2, 'Nombre del cliente requerido').max(100),
    client_phone: z.string().max(30).optional().nullable(),
    client_email: z.string().email('Email inválido').max(150).optional().nullable(),
    visit_date: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Fecha de visita inválida').transform(v => new Date(v).toISOString()),
    duration_minutes: z.number().int().min(15).max(480).default(60),
    status: z.enum(['pendiente', 'confirmada', 'completada', 'cancelada']).default('pendiente'),
    notes: z.string().max(1000).optional().nullable(),
  });

  // Tasación validation
  const TasacionSchema = z.object({
    property_id: z.string().uuid('ID de propiedad inválido').optional().nullable(),
    owner_id: z.string().uuid('ID de propietario inválido').optional().nullable(),
    broker_id: z.string().uuid('ID de broker inválido').optional().nullable(),
    type: z.enum(['venta', 'alquiler', 'hipotecario', 'judicial']),
    status: z.enum(['draft', 'finalized']).default('draft'),
    data: z.record(z.unknown()).default({}),
    valuation_usd: z.number().min(0).max(50000000).optional().nullable(),
    report_url: z.string().url('URL de reporte inválida').optional().nullable(),
    expires_at: z.string().datetime({ offset: true }).optional().nullable(),
  });

  // Agent validation
  const AgentSchema = z.object({
    full_name: z.string().min(2, 'Nombre completo requerido').max(100),
    email: z.string().email('Email inválido').max(150).optional().nullable(),
    phone: z.string().max(30).optional().nullable(),
    matricula: z.string().max(30).optional().nullable(),
    bio: z.string().max(2000).optional().nullable(),
    commission_rate: z.number().min(0).max(100).default(3),
    specialties: z.array(z.string()).default([]),
    status: z.enum(['activo', 'inactivo', 'licencia']).default('activo'),
    profile_id: z.string().uuid('ID de usuario inválido').optional().nullable(),
  });

  // Owner validation
  const OwnerSchema = z.object({
    full_name: z.string().min(2, 'Nombre completo requerido').max(100),
    dni_cuit: z.string().min(8, 'DNI/CUIT requerido').max(20).optional().nullable(),
    email: z.string().email('Email inválido').max(150).optional().nullable(),
    phone: z.string().max(30).optional().nullable(),
    address: z.string().max(200).optional().nullable(),
    preferred_contact: z.enum(['whatsapp', 'phone', 'email']).optional().nullable().default('whatsapp'),
    bank_name: z.string().max(100).optional().nullable(),
    cbu_cvu: z.string().max(30).optional().nullable(),
    alias_cbu: z.string().max(50).optional().nullable(),
    exclusive: z.boolean().default(false),
    exclusive_start: z.string().optional().nullable(),
    exclusive_end: z.string().optional().nullable(),
    commission_sale: z.number().min(0).max(100).optional().nullable(),
    commission_rent: z.number().min(0).max(100).optional().nullable(),
    commission_split: z.string().optional().nullable(),
    contract_notes: z.string().max(2000).optional().nullable(),
    dni_expiry: z.string().optional().nullable(),
    cuit_expiry: z.string().optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
  });

  // Helper: parse and validate form data
  function zodBaseType(field) {
    let t = field;
    while (t?._def && ['ZodOptional', 'ZodNullable', 'ZodDefault'].includes(t._def.typeName)) t = t._def.innerType;
    return t?._def?.typeName || null;
  }

  function validateForm(schema, formData) {
    const data = {};
    let unwrapped = schema;
    while (unwrapped && unwrapped._def && unwrapped._def.innerType) unwrapped = unwrapped._def.innerType;
    while (unwrapped && unwrapped._def && unwrapped._def.schema) unwrapped = unwrapped._def.schema;
    const shape = unwrapped && typeof unwrapped.shape === 'object' ? unwrapped.shape : {};

    for (const [key, value] of formData.entries()) {
      if (value === '' || value === undefined) continue;

      const fieldType = zodBaseType(shape[key]);

      // HTML checkboxes send "on" when checked; unchecked ones are absent from FormData
      if (value === 'on') {
        data[key] = true;
      }
      else if (fieldType === 'ZodNumber' && !isNaN(value) && !isNaN(parseFloat(value))) {
        data[key] = parseFloat(value);
      }
      // Boolean strings
      else if (value === 'true' || value === 'false') {
        data[key] = value === 'true';
      }
      else {
        data[key] = value;
      }
    }
    
    const result = schema.safeParse(data);
    if (!result.success) {
      const errors = result.error.flatten().fieldErrors;
      const messages = Object.entries(errors).map(([field, msgs]) => `${field}: ${msgs.join(', ')}`).join('; ');
      throw new Error('Validación fallida: ' + messages);
    }
    return result.data;
  }

  /* ------------------------------------------------
     1. AUTH
     ------------------------------------------------ */
  async function initAuth() {
    if (!window.supabaseClient) {
      logError('[BH] Supabase client not available — CDN may be blocked by browser extension');
      const loginScreen = $('#loginScreen');
      const errorEl = $('#loginError');
      if (loginScreen) loginScreen.classList.remove('is-hidden');
      if (errorEl) { errorEl.textContent = 'Error: No se pudo conectar. Desactivá el bloqueador de anuncios para este sitio.'; errorEl.style.display = 'block'; }
      hidePreloader();
      return;
    }

    try {
      /* Link de invitacion: #access_token=..&type=invite. Capturo el
         fragmento ANTES de getSession porque supabase-js lo consume y
         crea la sesion durante su inicializacion; el hash se limpia
         recien despues, para no romper esa deteccion. */
      const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
      const isInviteLink = hashParams.get('type') === 'invite';
      const inviteError = hashParams.get('error_description');

      const { data: { session } } = await window.supabaseClient.auth.getSession();

      if (hashParams.get('access_token') || inviteError) {
        window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
      }

      if (session) {
        currentUser = session.user;
        showApp();
        loadProfile().then(updateUserInfo).catch(() => {});
        if (isInviteLink && !inviteError) {
          openInvitePasswordModal(session.user?.email || '');
        }
      } else {
        showLogin();
        if (inviteError) {
          showToast('El enlace de invitación es inválido o ya expiró.', 'error');
        }
      }
    } catch (err) {
      logError('Auth init error:', err);
      showLogin();
    }

    window.supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        currentUser = session.user;
        window._bhCurrentUser = currentUser;
        showApp();
        loadProfile().then(updateUserInfo).catch(() => {});
      } else if (event === 'SIGNED_OUT') {
        currentUser = null;
        currentProfile = null;
        window._bhCurrentUser = null;
        window._bhCurrentProfile = null;
        authedSupabaseClient = null;
        authedClientTokenExpiry = 0;
        showLogin();
      }
    });
  }

  /* Cliente autenticado: usa el access token de la sesión para queries autenticadas */
  let authedSupabaseClient = null;
  let authedClientTokenExpiry = 0;

  function parseJwtExpiry(token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.exp * 1000; // exp is in seconds, convert to ms
    } catch {
      return 0;
    }
  }

  async function getAuthedClient() {
    const now = Date.now();
    // Si el cliente cacheado existe y su token no ha expirado (con 30s de margen)
    if (authedSupabaseClient && authedClientTokenExpiry > now + 30000) {
      return authedSupabaseClient;
    }
    if (!window.supabaseClient || !currentUser) return window.supabaseClient;
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session?.access_token) return window.supabaseClient;
    const { createClient } = window.supabase;
    authedSupabaseClient = createClient(window.BH_CONFIG.SUPABASE_URL, window.BH_CONFIG.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${session.access_token}` } },
      auth: { persistSession: false, storageKey: 'bh-authed-client' },
    });
    authedClientTokenExpiry = parseJwtExpiry(session.access_token);
    return authedSupabaseClient;
  }

    async function loadProfile() {
    if (!currentUser) return;
    try {
      const client = await getAuthedClient();
      let { data, error } = await client
        .from('profiles')
        .select('*')
        .eq('id', currentUser.id)
        .single();
      if (error && error.code === 'PGRST116') {
        await new Promise(r => setTimeout(r, 500));
        const retry = await client.from('profiles').select('*').eq('id', currentUser.id).single();
        data = retry.data; error = retry.error;
      }
      if (error && error.code === 'PGRST116') {
        try {
          await client.from('profiles').insert([{ id: currentUser.id, email: currentUser.email || null }]);
          const again = await client.from('profiles').select('*').eq('id', currentUser.id).single();
          data = again.data; error = again.error;
        } catch (_) { /* propagamos si sigue fallando */ }
      }
      if (error) throw error;
      currentProfile = data;
      window._bhCurrentProfile = currentProfile;

      /* El estado is_active es real: la edge function espeja el ban de
         GoTrue al desactivar, pero si la sesion ya estaba abierta sigue
         siendo valida hasta que expire; la corto aca tambien. */
      if (currentProfile.is_active === false) {
        showToast('Tu usuario está desactivado. Contactá a un administrador.', 'error');
        setTimeout(() => { window.supabaseClient.auth.signOut(); }, 2000);
        return;
      }

      /* Auto-sync del email: un admin pudo cambiarlo directo en auth.
         El trigger trg_profiles_guard_self solo bloquea rol/estado,
         asi que este update propio de email esta permitido. */
      const sessionEmail = currentUser?.email || '';
      if (sessionEmail && currentProfile.email !== sessionEmail) {
        const { error: syncErr } = await client
          .from('profiles')
          .update({ email: sessionEmail })
          .eq('id', currentUser.id);
        if (!syncErr) currentProfile.email = sessionEmail;
      }

      /* Con perfil y rol ya resueltos: el guard de Configuración evalúa contra el rol real. */
      loadConfig();
    } catch (err) {
      logError('Error loading profile:', err);
      const msg = (err && (err.message || err.hint)) ? String(err.message || err.hint) : 'error desconocido';
      logWarn('loadProfile falló: ' + msg + ' (código: ' + (err && err.code ? err.code : 'n/a') + ')');
      if (err && (err.code === '401' || /jwt|token|unauthorized/i.test(msg))) {
        showToast('No se pudieron cargar los permisos. Acceso denegado.', 'error');
        setTimeout(() => { window.supabaseClient.auth.signOut(); }, 2000);
      } else {
        showToast('Perfil no cargado (' + msg + '). Se reintenta solo; si persiste, recargá la página.', 'warning');
        setTimeout(() => { if (!currentProfile && currentUser) loadProfile(); }, 2000);
      }
    }
  }

  function showLogin() {
    const loginScreen = $('#loginScreen');
    const appLayout = $('#appLayout');
    if (loginScreen) loginScreen.classList.remove('is-hidden');
    if (appLayout) appLayout.style.display = 'none';
    hidePreloader();
  }

  // -- Visit Reminder System ----------------------------------

  function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
    if (localStorage.getItem('bh_notif_permission_asked')) return;
    localStorage.setItem('bh_notif_permission_asked', '1');
    Notification.requestPermission();
  }

  function sendBrowserNotification(title, body, tag) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body, tag, icon: 'assets/images/favicon.ico', renotify: true });
    } catch (_) { /* service worker fallback not available */ }
  }

  function reminderKey(visitId, type) {
    return 'bh_rem_' + visitId + '_' + type;
  }

  function isReminderSent(visitId, type) {
    return !!localStorage.getItem(reminderKey(visitId, type));
  }

  function markReminderSent(visitId, type) {
    localStorage.setItem(reminderKey(visitId, type), '1');
  }

  let _reminderInterval = null;

  function initVisitReminders() {
    if (_reminderInterval) return;
    checkVisitReminders();
    _reminderInterval = setInterval(checkVisitReminders, 5 * 60 * 1000);
  }

  async function checkVisitReminders() {
    if (!window.supabaseClient) return;
    try {
      const now = Date.now();
      const in24h = new Date(now + 24 * 60 * 60 * 1000).toISOString();
      const { data: visits, error } = await window.supabaseClient
        .from('visits')
        .select('id, client_name, visit_date, status, lead_id')
        .in('status', ['pendiente', 'confirmada'])
        .gte('visit_date', new Date(now).toISOString())
        .lte('visit_date', in24h)
        .order('visit_date', { ascending: true });
      if (error || !visits?.length) { updateAgendaBadge(0, null); return; }

      let soonestVisitDate = null;
      visits.forEach(v => {
        const visitTime = new Date(v.visit_date).getTime();
        const diffMs = visitTime - now;
        const diffH = diffMs / (1000 * 60 * 60);
        const clientLabel = v.client_name || 'Sin cliente';

        if (diffH <= 1 && diffH > 0 && !isReminderSent(v.id, '1h')) {
          markReminderSent(v.id, '1h');
          showToast('Visita en 1 hora: ' + clientLabel, 'warning');
          sendBrowserNotification('BH — Visita en 1 hora', clientLabel + ' — ' + new Date(v.visit_date).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }), 'visit-1h-' + v.id);
        } else if (diffH <= 24 && diffH > 1 && !isReminderSent(v.id, '24h')) {
          markReminderSent(v.id, '24h');
          showToast('Visita mañana: ' + clientLabel, 'info');
          sendBrowserNotification('BH — Visita mañana', clientLabel + ' — ' + new Date(v.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }), 'visit-24h-' + v.id);
        }

        if (!soonestVisitDate || visitTime < soonestVisitDate) {
          soonestVisitDate = visitTime;
        }
      });

      updateAgendaBadge(visits.length, soonestVisitDate);
    } catch (_) { /* silent — reminders are non-critical */ }
  }

  function updateAgendaBadge(count, soonestMs) {
    const badge = $('#agendaReminderBadge');
    if (!badge) return;
    if (count === 0) {
      badge.style.display = 'none';
      return;
    }
    badge.style.display = 'inline-flex';
    let label = count + ' visita' + (count !== 1 ? 's' : '') + ' próxim.';
    if (soonestMs) {
      const diffMs = soonestMs - Date.now();
      const diffH = Math.round(diffMs / (1000 * 60 * 60));
      if (diffH < 1) label += ' (<1h)';
      else if (diffH === 1) label += ' (1h)';
      else label += ' (' + diffH + 'h)';
    }
    badge.textContent = label;
  }

  function cleanupOldReminders() {
    const prefix = 'bh_rem_';
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        try {
          const ts = parseInt(localStorage.getItem(key), 10);
          if (!isNaN(ts) && ts < cutoff) localStorage.removeItem(key);
        } catch (_) { /* ignore */ }
      }
    }
  }

  cleanupOldReminders();

  // -- End Visit Reminder System ------------------------------

  function showApp() {
    const loginScreen = $('#loginScreen');
    const appLayout = $('#appLayout');
    const wasHidden = !appLayout || appLayout.style.display === 'none' || appLayout.style.display === '';
    if (loginScreen) loginScreen.classList.add('is-hidden');
    if (appLayout) appLayout.style.display = 'flex';
    hidePreloader();
    updateUserInfo();
    updateSidebarBadges();
    mlCheckStatus().catch(() => {});
    requestNotificationPermission();
    initVisitReminders();
    if (wasHidden) navigateTo('tab-dashboard');
  }

  function hidePreloader() {
    document.body.classList.remove('is-loading');
    const preloader = $('#preloader');
    if (preloader) preloader.classList.add('is-hidden');
    // Debug: add marker to page
    document.body.dataset.bhPreloaderHidden = 'true';
  }

  function updateUserInfo() {
    const nameEl = $('#sidebarUserName');
    const roleEl = $('#sidebarUserRole');
    const avatarEl = $('#sidebarUserAvatar');
    if (nameEl) nameEl.textContent = currentProfile?.full_name || currentUser?.email || 'Admin';
    if (roleEl) {
      const roleLabels = { super_admin: 'Super Admin', broker: 'Broker', agente: 'Agente' };
      roleEl.textContent = roleLabels[currentProfile?.role] || currentProfile?.role || 'Administrador';
    }
    if (avatarEl) avatarEl.textContent = (currentProfile?.full_name || currentUser?.email || 'A')[0].toUpperCase();
  }

  /* Login form */
  $('#loginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#loginEmail')?.value?.trim();
    const password = $('#loginPassword')?.value;
    const errorEl = $('#loginError');
    const btn = $('#btnLoginSubmit');

    if (!email || !password) return;
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
    if (btn) btn.disabled = true;

    try {
      const { error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err) {
      if (errorEl) { errorEl.textContent = err.message || 'Credenciales incorrectas'; errorEl.style.display = 'block'; }
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  /* Logout */
  $('#logoutBtn')?.addEventListener('click', async () => {
    try {
      await window.supabaseClient.auth.signOut();
    } catch (err) {
      logError('Logout error:', err);
      showToast('No se pudo cerrar sesión, intentá de nuevo', 'error');
    }
  });

  /* Aceptación de invitación: definir contraseña del usuario invitado */
  function openInvitePasswordModal(email) {
    const emailEl = $('#inviteSetupEmail');
    if (emailEl && email) emailEl.textContent = email;
    const errEl = $('#inviteSetupError');
    if (errEl) { errEl.style.display = 'none'; }
    $('#inviteSetupForm')?.reset();
    openModal('inviteSetupModal');
  }

  $('#inviteSetupForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const pwd = String(fd.get('password') || '');
    const pwd2 = String(fd.get('password2') || '');
    const errEl = $('#inviteSetupError');
    const btn = $('#inviteSetupBtn');
    const fail = (msg) => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };
    if (pwd.length < 6) return fail('La contraseña debe tener al menos 6 caracteres.');
    if (pwd !== pwd2) return fail('Las contraseñas no coinciden.');
    if (!btn || !window.supabaseClient) return;

    // HIBP check (fail-open)
    const pwned = await checkPasswordPwned(pwd);
    if (pwned.pwned) {
      return fail(`Esta contraseña apareció en ${pwned.count.toLocaleString('es-AR')} filtraciones de datos. Usa otra más segura.`);
    }

    btn.disabled = true;
    try {
      const { error } = await window.supabaseClient.auth.updateUser({ password: pwd });
      if (error) throw error;
      closeModal('inviteSetupModal');
      showToast('Contraseña definida. ¡Bienvenido al panel!', 'success');
    } catch (err) {
      fail(err.message || 'No se pudo definir la contraseña.');
    } finally {
      btn.disabled = false;
    }
  });

  /* ------------------------------------------------
     2. PRELOADER & CURSOR EFFECTS
     ------------------------------------------------ */
  function initCursorGlow() {
    const glow = $('#cursorGlow');
    const dot = $('#cursorDot');
    if (!glow && !dot) return;

    document.addEventListener('mouseenter', () => {
      if (glow) glow.classList.add('is-visible');
      if (dot) dot.classList.add('is-visible');
    });
    document.addEventListener('mouseleave', () => {
      if (glow) glow.classList.remove('is-visible');
      if (dot) dot.classList.remove('is-visible');
    });

    document.addEventListener('mousemove', (e) => {
      if (glow) {
        glow.style.left = e.clientX + 'px';
        glow.style.top = e.clientY + 'px';
      }
      if (dot) {
        dot.style.left = e.clientX + 'px';
        dot.style.top = e.clientY + 'px';
      }
    });
  }

  /* ------------------------------------------------
     3. NAVIGATION
     ------------------------------------------------ */
  $$('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      navigateTo(tab);
    });
  });

  function navigateTo(section) {
    const prevSection = currentSection;

    if (prevSection === 'tab-chat-redes' && section !== 'tab-chat-redes' && window.__chatTeardown) { window.__chatTeardown(); }
    currentSection = section;

    /* Sidebar active */
    $$('.nav-item[data-tab]').forEach(el => {
      el.classList.toggle('is-active', el.dataset.tab === section);
    });

    /* Module title */
    const titles = {
      'tab-dashboard': 'Dashboard Principal',
      'tab-propiedades': 'Gestión de Propiedades',
      'tab-leads': 'CRM & Prospectos',
      'tab-agenda': 'Agenda',
      'tab-tasaciones': 'Tasaciones',
      'tab-sitio-web': 'Editor del Sitio Web',
      'tab-portales': 'Portales & APIs',
      'tab-chat-redes': 'Chat Redes Sociales',
      'tab-agentes': 'Brokers & Asesores',
      'tab-propietarios': 'Padrón de Propietarios',
      'tab-usuarios': 'Usuarios & Permisos',
      'tab-configuracion': 'Configuración General',
      'tab-ficha-html': 'Ficha HTML',
      'tab-supervision': 'Centro de Supervisión',
    };
    const titleEl = $('#moduleTitle');
    if (titleEl) titleEl.textContent = titles[section] || 'Panel';

    /* Show / hide sections */
    $$('.tab-module').forEach(v => v.classList.remove('is-active'));
    const target = $(`#${section}`);
    if (target) target.classList.add('is-active');

/* Load data */
    const loaders = {
      'tab-dashboard': loadDashboard,
      'tab-leads': loadCRM,
      'tab-chat-redes': loadChatRedes,
      /* módulos extraídos a assets/js/admin-*.js (modularización): registran su loader en window.__BH al cargar */
      'tab-propiedades': () => window.__BH.loadProperties?.(),
      'tab-agenda': () => window.__BH.loadAgenda?.(),
      'tab-tasaciones': () => window.__BH.loadTasaciones?.(),
      'tab-sitio-web': () => window.__BH.loadCMS?.(),
      'tab-agentes': () => window.__BH.loadAgents?.(),
      'tab-propietarios': () => window.__BH.loadOwners?.(),
      'tab-usuarios': () => window.__BH.loadUsers?.(),
      'tab-portales': () => window.__BH.loadPortals?.(),
      'tab-ficha-html': () => window.__BH.loadFichaHtml?.(),
      'tab-supervision': () => window.__BH.loadSupervision?.(),
    };
    if (loaders[section]) loaders[section]();

    if (section === 'tab-tasaciones') {
      const editorView = $('#tasacionesEditorView');
      const listView = $('#tasacionesListView');
      const iframe = $('#tasacionesIframe');
      if (editorView) editorView.style.display = 'none';
      if (listView) listView.style.display = 'block';
      if (iframe) iframe.src = '';
    } else if (prevSection === 'tab-tasaciones') {
      const prevFrame = $('#tasacionesIframe');
      if (prevFrame) prevFrame.src = '';
    }

    /* Close mobile sidebar */
    $('#sidebar')?.classList.remove('is-open');
  }

  /* Mobile menu toggle */
  $('#mobileMenuToggle')?.addEventListener('click', () => {
    $('#sidebar')?.classList.toggle('is-open');
  });

  /* ------------------------------------------------
     4. DASHBOARD
     ------------------------------------------------ */
  async function loadDashboard() {
    const client = await getAuthedClient();
    if (!client) return;
    try {
      const now = new Date();
      const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
      const yearStart = new Date(now.getFullYear(), 0, 1).toISOString();
      const chartYear = _chartYear ?? now.getFullYear();
      const chartYearStart = new Date(chartYear, 0, 1).toISOString();
      const chartYearEnd = new Date(chartYear + 1, 0, 1).toISOString();
      const [propsRes, leadsRes, visitsRes, agentsRes, salesRes, chartLeadsRes] = await Promise.all([
        client.from('properties').select('price_usd, price_currency, zone, status, is_published, created_at, updated_at, agent_id').is('deleted_at', null),
        client.from('leads').select('id, stage, created_at, full_name, budget_usd, assigned_to').is('deleted_at', null).gte('created_at', yearStart),
        client.from('visits').select('id, visit_date, status, client_name, properties(id, title)').is('deleted_at', null).gte('visit_date', todayStart.toISOString()).order('visit_date', { ascending: true }).limit(8),
        client.from('agents').select('id, full_name, matricula').eq('status', 'activo').is('deleted_at', null),
        client.from('leads').select('assigned_to, estimated_value').eq('stage', 'cerrado_ganado').is('deleted_at', null).gte('updated_at', chartYearStart).lt('updated_at', chartYearEnd),
        client.from('leads').select('id, created_at').is('deleted_at', null).gte('created_at', chartYearStart).lt('created_at', chartYearEnd),
      ]);
      const firstError = [propsRes, leadsRes, visitsRes, agentsRes, salesRes, chartLeadsRes].find(r => r.error);
      if (firstError) throw firstError.error;

      const props = propsRes.data || [];
      const leads = leadsRes.data || [];
      const visits = visitsRes.data || [];
      const agents = agentsRes.data || [];
      const chartLeads = chartLeadsRes.data || [];

      /* KPIs: solo en cartera activa (venta/alquiler publicados, no vendidos ni pausados) */
      const activos = props.filter(p => p.is_published && ['venta', 'alquiler'].includes(p.status));
      const propsVenta = activos.filter(p => p.status === 'venta');
      const propsAlquiler = activos.filter(p => p.status === 'alquiler');
      /* Ambas columnas suman price_usd → los KPIs se muestran en USD (no mezclar monedas) */
      const volumenVenta = propsVenta.reduce((sum, p) => sum + (p.price_usd || 0), 0);
      const volumenAlquiler = propsAlquiler.reduce((sum, p) => sum + (p.price_usd || 0), 0);
      const activeProps = activos.length;
      const activeLeads = leads.filter(l => !['cerrado_ganado', 'cerrado_perdido'].includes(l.stage)).length;
      const upcomingVisits = visits.filter(v => v.status === 'pendiente' || v.status === 'confirmada').length;

      setKPI('kpiVolumenVenta', formatPrice(volumenVenta, 'USD'));
      setKPI('kpiVolumenAlquiler', formatPrice(volumenAlquiler, 'USD'));
      setKPI('kpiActivas', activeProps);
      setKPI('kpiLeads', activeLeads);
      setKPI('kpiVisitas', upcomingVisits);
      setKPI('kpiBrokers', agents.length);

      /* Zone progress */
      renderZoneProgress(props);
      renderConsultasVentasChart(props, chartLeads);

      /* Dashboard widgets */
      const salesByAgent = {};
      (salesRes.data || []).forEach(s => {
        if (s.assigned_to) salesByAgent[s.assigned_to] = (salesByAgent[s.assigned_to] || 0) + Number(s.estimated_value || 0);
      });
      (agents || []).forEach(a => { a.sales_ytd = salesByAgent[a.id] || 0; });
      renderDashVisits(visits);
      renderDashLeads(leads);
      renderDashBrokers(agents);
      const stamp = $('#dashLastUpdated');
      if (stamp) stamp.textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      const refreshBtn = $('#dashRefreshBtn');
      if (refreshBtn && !refreshBtn.dataset.bound) {
        refreshBtn.dataset.bound = '1';
        refreshBtn.addEventListener('click', () => loadDashboard());
      }
      const prevY = $('#chartPrevYear'), nextY = $('#chartNextYear');
      if (prevY && !prevY.dataset.bound) {
        prevY.dataset.bound = '1';
        prevY.addEventListener('click', () => { _chartYear = (_chartYear ?? new Date().getFullYear()) - 1; loadDashboard(); });
      }
      if (nextY && !nextY.dataset.bound) {
        nextY.dataset.bound = '1';
        nextY.addEventListener('click', () => {
          const y = (_chartYear ?? new Date().getFullYear()) + 1;
          if (y > new Date().getFullYear()) return;
          _chartYear = y;
          loadDashboard();
        });
      }
    } catch (err) {
      logError('Dashboard error:', err);
      showToast('Error al cargar el Dashboard: ' + err.message, 'error');
    }
  }

  function setKPI(id, value) {
    const el = $(`#${id}`);
    if (el) el.textContent = typeof value === 'number' ? value.toLocaleString('es-AR') : value;
    const card = el && el.closest('.kpi-card');
    if (card && !card.dataset.navBound) {
      card.dataset.navBound = '1';
      card.style.cursor = 'pointer';
      card.title = 'Ver detalle';
      card.addEventListener('click', () => {
        const navMap = { kpiVolumenVenta: 'tab-propiedades', kpiVolumenAlquiler: 'tab-propiedades', kpiActivas: 'tab-propiedades', kpiLeads: 'tab-leads', kpiVisitas: 'tab-agenda', kpiBrokers: 'tab-agentes' };
        const target = navMap[id];
        if (target) navigateTo(target);
      });
    }
  }

  let _chartYear = null;
  function renderConsultasVentasChart(props, leads) {
    const container = $('#consultasVentasChart');
    if (!container) return;
    const now = new Date();
    const year = _chartYear ?? now.getFullYear();

    const pill = $('#chartYearPill');
    if (pill) pill.innerHTML = '<i class="fas fa-calendar"></i> ' + year;

    const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const months = [];
    const lastMonth = year === now.getFullYear() ? now.getMonth() : 11;
    for (let m = 0; m <= lastMonth; m++) months.push(m);

    const inMonth = (iso, m) => {
      if (!iso) return false;
      const d = new Date(iso);
      return d.getFullYear() === year && d.getMonth() === m;
    };

    const consultas = months.map(m => leads.filter(l => inMonth(l.created_at, m)).length);
    const ventas = months.map(m => props.filter(p => ['vendido', 'alquilado'].includes(p.status) && inMonth(p.updated_at, m)).length);

    const max = Math.max(...consultas, ...ventas);
    if (!max) {
      container.innerHTML = `<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:40px 20px;">Sin movimientos registrados en ${year} todavía.</p>`;
      return;
    }

    const legend = `
      <div class="chart-legend">
        <span><i style="background:var(--accent);"></i>Consultas</span>
        <span><i style="background:var(--success);"></i>Ventas</span>
      </div>`;

    const cols = months.map((m, i) => {
      const cH = Math.round((consultas[i] / max) * 100);
      const vH = Math.round((ventas[i] / max) * 100);
      return `
        <div class="chart-col">
          <div class="chart-bars-group">
            <div class="chart-bar-fill is-consultas" style="height:${cH}%;" title="${consultas[i]} ${consultas[i] === 1 ? 'consulta' : 'consultas'}"></div>
            <div class="chart-bar-fill is-ventas" style="height:${vH}%;" title="${ventas[i]} ${ventas[i] === 1 ? 'venta' : 'ventas'}"></div>
          </div>
          <span class="chart-label">${monthNames[m]}</span>
        </div>`;
    }).join('');

    container.innerHTML = legend + `<div class="chart-mock-bar-container">${cols}</div>`;
  }

  function renderZoneProgress(props) {
    const container = $('#zoneProgressContainer');
    if (!container) return;

    const zones = {};
    props.forEach(p => {
      const z = p.zone || 'Sin zona';
      zones[z] = (zones[z] || 0) + 1;
    });

    const entries = Object.entries(zones).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      container.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Las zonas se actualizarán al cargar propiedades.</p>';
      return;
    }
    const totalZona = entries.reduce((sum, [, c]) => sum + c, 0);

    const max = Math.max(...entries.map(e => e[1]));
    container.innerHTML = entries.slice(0, 6).map(([zone, count]) => {
      const pct = Math.round((count / max) * 100);
      return `
        <div style="display:flex; align-items:center; gap:12px; padding:10px 0; border-bottom:1px solid var(--border-subtle);">
          <span style="color:var(--text-secondary); font-size:13px; min-width:120px;">${esc(zone)}</span>
          <div style="flex:1; height:6px; background:rgba(255,255,255,0.05); border-radius:99px; overflow:hidden;">
            <div style="height:100%; width:${pct}%; background:linear-gradient(90deg, var(--accent), var(--glow)); border-radius:99px;"></div>
          </div>
          <span style="color:var(--accent); font-size:13px; font-weight:600; min-width:60px; text-align:right;" title="${Math.round((count / totalZona) * 100)}% de la cartera">${count} <span style="color:var(--text-dim); font-weight:400; font-size:11px;">(${Math.round((count / totalZona) * 100)}%)</span></span>
        </div>`;
    }).join('');
  }

  function renderDashVisits(visits) {
    const el = $('#dashVisitsList');
    if (!el) return;
    const upcoming = visits.filter(v => v.status === 'pendiente' || v.status === 'confirmada').slice(0, 4);
    if (!upcoming.length) {
      el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; padding:16px 0;">Sin visitas registradas</p>';
      return;
    }
    el.innerHTML = upcoming.map(v => `
      <div data-visit-id="${v.id}" style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border-subtle); cursor:pointer;">
        <div style="min-width:0;">
          <div style="color:#fff; font-size:13px; font-weight:500;">${esc(v.client_name || 'Sin cliente')}</div>
          <div style="color:var(--text-dim); font-size:11px;">${v.visit_date ? new Date(v.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'}${v.properties?.title ? ' · ' + esc(v.properties.title) : ''}</div>
        </div>
        <span class="nav-badge" style="background:${v.status === 'confirmada' ? 'rgba(0,200,120,0.15)' : 'rgba(255,184,0,0.15)'}; color:${v.status === 'confirmada' ? 'var(--success)' : 'var(--warning)'}; font-size:11px;">${esc(v.status || 'pendiente')}</span>
      </div>
    `).join('');
    el.querySelectorAll('[data-visit-id]').forEach(row => {
      row.addEventListener('click', () => window.adminApp && window.adminApp.editVisit(row.dataset.visitId));
    });
  }

  function renderDashLeads(leads) {
    const el = $('#dashLeadsList');
    if (!el) return;
    const hot = leads.filter(l => ['contactado', 'calificado', 'visita_agendada', 'visita_realizada', 'negociacion'].includes(l.stage)).slice(0, 4);
    if (!hot.length) {
      el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; padding:16px 0;">Sin leads registrados</p>';
      return;
    }
    const stageColors = { contactado: '#3B82F6', calificado: '#3B82F6', visita_agendada: '#FFB800', visita_realizada: '#FFB800', negociacion: 'var(--accent)' };
    el.innerHTML = hot.map(l => `
      <div data-lead-id="${l.id}" style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border-subtle); cursor:pointer;">
        <div>
          <div style="color:#fff; font-size:13px; font-weight:500;">${esc(l.full_name || 'Sin nombre')}</div>
          <div style="color:var(--text-dim); font-size:11px;">${l.budget_usd ? 'USD ' + l.budget_usd.toLocaleString('es-AR') : 'Sin presupuesto'}</div>
        </div>
        <span class="nav-badge" style="background:${stageColors[l.stage] || 'rgba(255,255,255,0.1)'}; color:#fff; font-size:11px;">${esc(l.stage || 'nuevo')}</span>
      </div>
    `).join('');
    el.querySelectorAll('[data-lead-id]').forEach(row => {
      row.addEventListener('click', () => {
        if (window.BH_CRM && window.BH_CRM.open) { window.BH_CRM.open(row.dataset.leadId); }
      });
    });
  }

  function renderDashBrokers(agents) {
    const el = $('#dashBrokersList');
    if (!el) return;
    const sorted = [...agents].sort((a, b) => (b.sales_ytd || 0) - (a.sales_ytd || 0)).slice(0, 4);
    if (!sorted.length) {
      el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; padding:16px 0;">Sin brokers registrados</p>';
      return;
    }
    el.innerHTML = sorted.map((a, i) => `
      <div style="display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--border-subtle);">
        <div style="width:28px; height:28px; border-radius:50%; background:var(--surface-2); display:flex; align-items:center; justify-content:center; color:var(--accent); font-size:11px; font-weight:700;">${i + 1}</div>
        <div style="flex:1;">
          <div style="color:#fff; font-size:13px; font-weight:500;">${esc(a.full_name || 'Sin nombre')}</div>
          <div style="color:var(--text-dim); font-size:11px;">${esc(a.matricula || 'S/M')}</div>
        </div>
        <span style="color:var(--success); font-size:12px; font-weight:600;">${formatPrice(a.sales_ytd)}</span>
      </div>
    `).join('');
  }

  /* Extraido a assets/js/admin-propiedades.js (modularizacion) */
  /* ------------------------------------------------
     7. CRM — LEADS PIPELINE
     ------------------------------------------------ */
  /* CRM anterior (Kanban) removido: el módulo nuevo vive en assets/js/admin-crm.js y gestiona la sección #tab-leads. loadCRM queda como shim para compatibilidad con el sistema de navegación del panel. */
  async function loadCRM() {
    if (window.BH_CRM && typeof window.BH_CRM.init === 'function') { window.BH_CRM.init(); }
    else if (typeof window.initCrm === 'function') { window.initCrm(); }
    else { console.warn('[crm] módulo CRM no cargado'); }
  }

  /* ---- NEW LEAD (modal + form) ---- */
  let _submittingLead = false;

  function setBtnLoading(btn, loadingText) {
    if (!btn) return;
    btn.dataset._origTxt = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = loadingText;
  }
  function restoreBtn(btn) {
    if (!btn) return;
    btn.disabled = false;
    if (btn.dataset._origTxt) btn.innerHTML = btn.dataset._origTxt;
  }

  on($('#btnNewLead'), 'click', () => {
    editingLeadId = null;
    $('#leadForm')?.reset();
    // Recargar brokers disponibles
    loadAgentSelect($('#leadBrokerSelect'));
    openModal('leadModal');
  });

  on($('#leadForm'), 'submit', async (e) => {
    e.preventDefault();
    if (_submittingLead) return;
    _submittingLead = true;
    const btn = $('#leadSaveBtn');
    setBtnLoading(btn, '<i class="fas fa-spinner fa-spin"></i> Guardando...');

    try {
      const formData = new FormData(e.target);

      // Zod validation
      const validated = validateForm(LeadSchema, formData);

      const data = {
        full_name: validated.full_name,
        phone: validated.phone,
        email: validated.email,
        whatsapp: validated.whatsapp,
        budget_usd: validated.budget_usd,
        stage: validated.stage,
        preferred_type: validated.preferred_type,
        preferred_zone: validated.preferred_zone,
        notes: validated.notes,
        source: validated.source,
        property_id: validated.property_id,
        assigned_to: validated.assigned_to,
        preferred_rooms: validated.preferred_rooms,
        tipo_cliente: validated.tipo_cliente,
        operation_type: validated.operation_type,
      };
      const nextFollowRaw = String(formData.get('next_followup_at') || '').trim();
      if (nextFollowRaw) {
        const d = new Date(nextFollowRaw);
        if (isNaN(d.getTime())) { showToast('La fecha de próximo contacto es inválida', 'error'); _submittingLead = false; restoreBtn(btn); return; }
        data.next_followup_at = d.toISOString();
      }


      // ── ANTI-DUPLICADO: sólo si NO estamos editando
      if (!editingLeadId) {

      var phone = (validated.phone || '').trim();
      var whatsappNum = (validated.whatsapp || '').trim();
      var phoneDigits = phone.replace(/\D/g, '');
      var wnumDigits = whatsappNum.replace(/\D/g, '');

      if (phoneDigits.length >= 6 || wnumDigits.length >= 6) {
        var existing = null;
        var last8Reverse = p => p.slice(-8); // últimos 8 dígitos como clave
        try {
          var ds = [];
          if (phoneDigits.length >= 6) ds.push('phone.ilike.%' + last8Reverse(phoneDigits) + '%');
          if (wnumDigits.length >= 6 && wnumDigits !== phoneDigits) ds.push('whatsapp.ilike.%' + last8Reverse(wnumDigits) + '%');
          if (ds.length) {
            var r = await window.supabaseClient
              .from('leads')
              .select('id, full_name, phone, whatsapp, stage, deleted_at')
              .or(ds.join(','))
              .is('deleted_at', null)
              .limit(1);
            if (r && r.error) throw r.error;
            if (r && r.data && r.data.length) existing = r.data[0];
          }
        } catch (qerr) {
          // si falla el check (red/RLS) no bloquear al usuario — seguir
          console.warn('[dup-check]', qerr.message);
        }

        if (existing) {
          var lbl = existing.full_name || existing.phone || existing.whatsapp || existing.id;
          var stageLbl = existing.stage || 'nuevo';
          var okOpen = confirm('Prospecto ya existente: ' + lbl + ' (estado: ' + stageLbl + ').\n\n¿Ir al pipeline existente?');
          if (okOpen) {
            closeModal('leadModal');
            if (window.BH_CRM && window.BH_CRM.open) { window.BH_CRM.open(existing.id); } else { window.location.hash = '#tab-leads'; }
          }
          _submittingLead = false;
          restoreBtn(btn);
          return;
        }

        // y opción recuperar registro blando-eliminado
        try {
          var r2 = await window.supabaseClient
            .from('leads')
            .select('id, full_name, phone, stage')
            .or(ds.join(','))
            .not('deleted_at', 'is', 'null')
            .order('deleted_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (r2 && !r2.error && r2.data) {
            var recuperar = confirm('Este contacto existe pero fue eliminado antes (' + (r2.data.full_name || r2.data.phone || '') + ').\n\n¿Recuperar al nuevo (quita el borrado) o crear uno nuevo?\n\nAceptar = Recuperar · Cancelar = Crear nuevo lead');
            if (recuperar) {
              await mutate('leads', async () => {
                const { error } = await window.supabaseClient.from('leads').update({ deleted_at: null, ...data }).eq('id', r2.data.id);
                if (error) throw error;
              });
              showToast('Lead recuperado y actualizado', 'success');
              closeModal('leadModal');
              loadCRM();
              updateSidebarBadges();
              _submittingLead = false;
              restoreBtn(btn);
              return;
            }
          }
        } catch (_) {}
      }


      }
      if (editingLeadId) {
        await mutate('leads', async () => {
          const { error } = await window.supabaseClient.from('leads').update(data).eq('id', editingLeadId);
          if (error) throw error;
        });
        showToast('Lead actualizado', 'success');
      } else {
        await mutate('leads', async () => {
          const { error } = await window.supabaseClient.from('leads').insert([data]);
          if (error) throw error;
        });
        showToast('Lead registrado', 'success');
      }

      closeModal('leadModal');
      loadCRM(); // delega en el nuevo módulo si está cargado
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      _submittingLead = false;
      restoreBtn(btn);
    }
  });

  window.adminApp.editLead = async function (id) {
    try {
      const [{ data: lead, error: leadErr }, { data: visits, error: visitsErr }] = await Promise.all([
        window.supabaseClient.from('leads').select('*').eq('id', id).single(),
        window.supabaseClient.from('visits').select('id, visit_date, status, client_name, property_id').eq('lead_id', id).order('visit_date', { ascending: true }),
      ]);
      if (leadErr) throw leadErr;
      if (visitsErr) throw visitsErr;

      editingLeadId = id;
      const form = $('#leadForm');
      if (!form) return;

      await loadAgentSelect($('#leadBrokerSelect'), lead.assigned_to);
      /* setF defensivo: el form actual puede no tener todos los campos heredados */
      const setF = (name, val) => { const el = form.elements[name]; if (el) el.value = val; };
      setF('full_name', lead.full_name || '');
      setF('phone', lead.phone || '');
      setF('email', lead.email || '');
      setF('whatsapp', lead.whatsapp || '');
      setF('budget_usd', lead.budget_usd || '');
      setF('stage', lead.stage || 'nuevo');
      setF('preferred_type', lead.preferred_type || '');
      setF('preferred_zone', lead.preferred_zone || '');
      setF('preferred_rooms', lead.preferred_rooms ?? '');
      setF('notes', lead.notes || '');
      setF('source', lead.source || 'manual');
      setF('assigned_to', lead.assigned_to || '');
      setF('property_id', lead.property_id || '');
      const nextFollowInput = form.elements.next_followup_at;
      if (nextFollowInput) {
        if (lead.next_followup_at) {
          const d = new Date(lead.next_followup_at);
          const pad = n => String(n).padStart(2, '0');
          nextFollowInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } else {
          nextFollowInput.value = '';
        }
      }
      openModal('leadModal');
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.adminApp.deleteLead = async function (id) {
    if (!confirm('¿Eliminar este prospecto?')) return;
    try {
      await mutate('leads', async () => {
        const { error } = await window.supabaseClient.from('leads').update({ deleted_at: new Date().toISOString() }).eq('id', id);
        if (error) throw error;
      });
      showToast('Lead eliminado', 'success');
      loadCRM();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };


/* Edit lead */
  

  /* Delete lead */
  

  /* Extraido a assets/js/admin-agenda.js (modularizacion) */
  async function loadAgentSelect(selectEl, selectedValue = null) {
    if (!selectEl || !window.supabaseClient) return;
    const placeholder = selectEl.options[0]?.text || 'Sin broker asignado';
    try {
      const { data, error } = await window.supabaseClient
        .from('agents')
        .select('id, full_name')
        .eq('status', 'activo')
        .is('deleted_at', null)
        .order('full_name');
      if (error) throw error;
      const valueToSet = selectedValue !== null ? selectedValue : selectEl.value;
      selectEl.innerHTML = `<option value="">${esc(placeholder)}</option>`;
      (data || []).forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.full_name;
        selectEl.appendChild(opt);
      });
      if (valueToSet) selectEl.value = valueToSet;
    } catch (_) { /* silent */ }
  }

  async function loadPropertySelect(selectEl, selectedValue = null) {
    if (!selectEl || !window.supabaseClient) return;
    const placeholder = selectEl.options[0]?.text || '— Seleccionar propiedad —';
    try {
      const { data, error } = await window.supabaseClient
        .from('properties')
        .select('id, title, property_code')
        .is('deleted_at', null)
        .order('title');
      if (error) throw error;
      selectEl.innerHTML = `<option value="">${esc(placeholder)}</option>`;
      (data || []).forEach(p => {
        const code = p.property_code ? ` [${esc(p.property_code)}]` : '';
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.title + code;
        selectEl.appendChild(opt);
      });
      if (selectedValue) selectEl.value = selectedValue;
    } catch (_) { /* silent */ }
}

  async function refreshOwnerSelect(selectEl, selectedId = null) {
    if (!selectEl || !window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('owners')
        .select('id, full_name')
        .is('deleted_at', null)
        .order('full_name');
      if (error) return;
      selectEl.innerHTML = '<option value="">Sin propietario asignado</option>' +
        (data || []).map(o => `<option value="${esc(o.id)}">${esc(o.full_name)}</option>`).join('');
      if (selectedId) selectEl.value = selectedId;
    } catch (_) { /* silent */ }
  }


  /* Save visit */
  /* Extraido a assets/js/admin-cms.js (modularizacion) */
  /* Extraido a assets/js/admin-agentes.js (modularizacion) */
  /* Extraido a assets/js/admin-propietarios.js (modularizacion) */
  /* Extraido a assets/js/admin-usuarios.js (modularizacion) */
  /* Extraido a assets/js/admin-portales.js (modularizacion) */
  /* Extraido a assets/js/admin-tasaciones.js (modularizacion) */
  /* ------------------------------------------------
     14. MODALS
     ------------------------------------------------ */
  function openModal(id) {
    const modal = $(`#${id}`);
    if (modal) {
      modal.classList.add('is-open');
      document.body.style.overflow = 'hidden';
    }
  }

  function closeModal(id) {
    const modal = $(`#${id}`);
    if (modal) {
      modal.classList.remove('is-open');
      document.body.style.overflow = '';
    }
  }

  /* Diálogo de confirmación contextual (reemplaza confirm() nativo) */
  function showConfirmDialog({ title, message, icon = 'fas fa-circle-question', confirmText = 'Confirmar', cancelText = 'Cancelar', danger = false }) {

    return new Promise(resolve => {

      const modal = $('#confirmModal');

      const iconEl = $('#confirmIcon');

      const titleEl = $('#confirmTitle');

      const msgEl = $('#confirmMsg');

      const okBtn = $('#confirmOk');

      const cancelBtn = $('#confirmCancel');

      if (!modal || !okBtn || !cancelBtn) { resolve(window.confirm(message)); return; }

      $('#confirmBoxInner').classList.toggle('is-danger', danger);

      iconEl.className = icon;

      titleEl.textContent = title;

      msgEl.textContent = message;

      okBtn.className = danger ? 'btn-danger-solid' : 'btn-luxury-action';

      okBtn.innerHTML = esc(confirmText);

      cancelBtn.textContent = cancelText;

      openModal('confirmModal');

      const done = (val) => {

        closeModal('confirmModal');

        okBtn.removeEventListener('click', onOk);

        cancelBtn.removeEventListener('click', onCancel);

        document.removeEventListener('keydown', onKey, true);

        resolve(val);

      };

      const onOk = () => done(true);

      const onCancel = () => done(false);

      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };

      okBtn.addEventListener('click', onOk);

      cancelBtn.addEventListener('click', onCancel);

      document.addEventListener('keydown', onKey, true);

      setTimeout(() => okBtn.focus(), 60);

    });

  }

  window.showConfirmDialog = showConfirmDialog;

  function showInputPrompt({ title, message = '', icon = 'fas fa-pen', placeholder = '', confirmText = 'Aceptar', cancelText = 'Cancelar' }) {

    return new Promise(resolve => {

      const modal = $('#inputPromptModal');

      const textEl = $('#inputPromptText');

      const okBtn = $('#inputPromptOk');

      const cancelBtn = $('#inputPromptCancel');

      if (!modal || !textEl || !okBtn || !cancelBtn) { resolve(window.prompt(message || title, '')); return; }

      $('#inputPromptIcon').className = icon;

      $('#inputPromptTitle').textContent = title;

      const msgEl = $('#inputPromptMsg');

      msgEl.textContent = message;

      msgEl.style.display = message ? '' : 'none';

      textEl.value = '';

      textEl.placeholder = placeholder;

      okBtn.textContent = confirmText;

      cancelBtn.textContent = cancelText;

      openModal('inputPromptModal');

      const done = (val) => {

        closeModal('inputPromptModal');

        okBtn.removeEventListener('click', onOk);

        cancelBtn.removeEventListener('click', onCancel);

        document.removeEventListener('keydown', onKey, true);

        resolve(val);

      };

      const onOk = () => done(textEl.value.trim());

      const onCancel = () => done(null);

      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };

      okBtn.addEventListener('click', onOk);

      cancelBtn.addEventListener('click', onCancel);

      document.addEventListener('keydown', onKey, true);

      setTimeout(() => textEl.focus(), 60);

    });

  }

  window.showInputPrompt = showInputPrompt;

  /* Close on backdrop click */
  $$('.admin-modal').forEach(overlay => {
    on(overlay, 'click', (e) => {
      if (e.target === overlay) {
        overlay.classList.remove('is-open');
        document.body.style.overflow = '';
      }
    });
  });

  /* Close on Escape */
  on(document, 'keydown', (e) => {
    if (e.key === 'Escape') {
      $$('.admin-modal.is-open').forEach(m => {
        m.classList.remove('is-open');
        document.body.style.overflow = '';
      });
    }
  });

  /* Close buttons */
  $$('.modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.admin-modal');
      if (modal) {
        modal.classList.remove('is-open');
        document.body.style.overflow = '';
      }
    });
  });

  /* ------------------------------------------------
     14B. CSV EXPORT
     ------------------------------------------------ */
  function escapeCSV(val) {
    if (val == null) return '';
    const s = String(val);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function downloadCSV(filename, rows, headers) {
    let csv = headers.map(escapeCSV).join(',') + '\n';
    rows.forEach(function(row) {
      csv += row.map(escapeCSV).join(',') + '\n';
    });
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  window.exportLeadsCSV = async function() {
    if (!window.supabaseClient) return;
    let q = window.supabaseClient
      .from('leads')
      .select('id, full_name, email, phone, whatsapp, stage, source, tipo_cliente, operation_type, budget_usd, preferred_zone, notes, created_at')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(5000);
    const sv = document.getElementById('crmSearch');
    if (sv && sv.value.trim()) {
      const s = sv.value.trim().replace(/[%_]/g, ' ');
      q = q.or(['full_name', 'email', 'phone', 'whatsapp', 'notes', 'preferred_zone'].map(f => f + '.ilike.%' + s + '%').join(','));
    }
    const stSel = document.getElementById('crmStatusFilter');
    if (stSel && stSel.value) q = q.eq('stage', stSel.value); else q = q.neq('stage', 'cerrado_perdido');
    const orSel = document.getElementById('crmOriginFilter');
    if (orSel && orSel.value) q = q.eq('source', orSel.value);
    const tpSel = document.getElementById('crmTipoOperacionFilter');
    if (tpSel && tpSel.value) q = q.eq('operation_type', tpSel.value);
    const agSel = document.getElementById('crmAgentFilter');
    if (agSel && agSel.value === '__none__') q = q.is('assigned_to', null);
    else if (agSel && agSel.value) q = q.eq('assigned_to', agSel.value);
    const { data, error } = await q;
    if (error) { showToast('Error exportando: ' + error.message, 'error'); return; }
    const headers = ['Nombre', 'Email', 'Teléfono', 'WhatsApp', 'Estado', 'Origen', 'Tipo cliente', 'Operación', 'Presupuesto USD', 'Zona preferida', 'Notas', 'Fecha alta'];
    const rows = (data || []).map(function(l) {
      return [l.full_name, l.email, l.phone, l.whatsapp, l.stage, l.source, l.tipo_cliente, l.operation_type, l.budget_usd, l.preferred_zone, l.notes, l.created_at];
    });
    const date = new Date().toISOString().slice(0, 10);
    downloadCSV('leads-' + date + '.csv', rows, headers);
    showToast('Leads exportados (' + rows.length + ')');
  };

  window.exportPropertiesCSV = async function() {
    if (!window.supabaseClient) return;
    const { data, error } = await window.supabaseClient.from('properties').select('*').order('created_at', { ascending: false });
    if (error) { showToast('Error exportando: ' + error.message, 'error'); return; }
    const headers = ['ID', 'Título', 'Tipo', 'Zona', 'Dirección', 'Precio', 'Moneda', 'Dormitorios', 'Baños', 'm²', 'Estado', 'Publicada', 'Fecha'];
    const rows = data.map(function(p) {
      return [p.id, p.title, p.property_type, p.zone, p.address, p.price_usd, p.price_currency || 'USD', p.bedrooms, p.bathrooms, p.area_m2, p.status, p.published, p.created_at];
    });
    const date = new Date().toISOString().slice(0, 10);
    downloadCSV('propiedades-' + date + '.csv', rows, headers);
    showToast('Propiedades exportadas (' + rows.length + ')');
  };

  window.exportTasacionesCSV = async function() {
    if (!window.supabaseClient) return;
    const { data, error } = await window.supabaseClient
      .from('tasaciones')
      .select('id, title, status, type, created_at, updated_at, valuation_usd, property_id, owner_id')
      .order('created_at', { ascending: false });
    if (error) { showToast('Error exportando: ' + error.message, 'error'); return; }
    const propIds = [...new Set((data || []).map(t => t.property_id).filter(Boolean))];
    const ownerIds = [...new Set((data || []).map(t => t.owner_id).filter(Boolean))];
    const [propsRes, ownersRes] = await Promise.all([
      propIds.length ? window.supabaseClient.from('properties').select('id, property_code, title').in('id', propIds) : { data: [] },
      ownerIds.length ? window.supabaseClient.from('owners').select('id, full_name').in('id', ownerIds) : { data: [] }
    ]);
    const propMap = new Map((propsRes.data || []).map(p => [p.id, p]));
    const ownerMap = new Map((ownersRes.data || []).map(o => [o.id, o]));
    const headers = ['ID', 'Título', 'Tipo', 'Estado', 'Propiedad', 'Propietario', 'Valor Estimado (USD)', 'Fecha creación', 'Última edición'];
    const rows = data.map(function(t) {
      const prop = t.property_id ? propMap.get(t.property_id) : null;
      const propName = prop ? (prop.property_code || '') + ' - ' + (prop.title || '') : '';
      const owner = t.owner_id ? ownerMap.get(t.owner_id) : null;
      return [t.id, t.title, t.type || '', t.status, propName, owner?.full_name || '', t.valuation_usd || '', t.created_at, t.updated_at];
    });
    const date = new Date().toISOString().slice(0, 10);
    downloadCSV('tasaciones-' + date + '.csv', rows, headers);
    showToast('Tasaciones exportadas (' + rows.length + ')');
  };

  // --- SUPERVISIÓN CSV EXPORTS ---
  window.exportSupAlertsCSV = async function() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient.from('supervision_alerts').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      const headers = ['ID', 'Severidad', 'Tipo', 'Usuario', 'Usuario ID', 'Módulo', 'Descripción', 'Evidencia', 'Estado', 'Asignado a', 'Creado', 'Actualizado', 'Notas'];
      const rows = (data || []).map(a => [
        a.id,
        a.severity,
        a.alert_type || a.rule_name,
        a.user_name || '',
        a.user_id || '',
        a.module || '',
        a.description || '',
        a.evidence ? JSON.stringify(a.evidence) : '',
        a.status,
        a.assigned_to || '',
        a.created_at,
        a.updated_at,
        a.notes || ''
      ]);
      const date = new Date().toISOString().slice(0, 10);
      downloadCSV('supervision-alertas-' + date + '.csv', rows, headers);
      showToast('Alertas exportadas (' + rows.length + ')', 'success');
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.exportSupUsersCSV = async function() {
    if (!window.supabaseClient) return;
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const [auditRes, profilesRes] = await Promise.all([
        window.supabaseClient.from('audit_log').select('user_id, action, status, created_at, metadata').gte('created_at', weekAgo),
        window.supabaseClient.from('profiles').select('id, full_name, email, role')
      ]);
      if (auditRes.error) throw auditRes.error;
      if (profilesRes.error) throw profilesRes.error;
      const audit = auditRes.data || [];
      const profiles = profilesRes.data || [];
      const profileMap = new Map(profiles.map(p => [p.id, p]));

      const userStats = {};
      audit.forEach(a => {
        const uid = a.user_id || 'unknown';
        if (!userStats[uid]) userStats[uid] = { actions: 0, errors: 0, sensitive: 0, exports: 0, bulk: 0, lastActivity: null };
        userStats[uid].actions++;
        if (a.status === 'error' || a.status === 'critical') userStats[uid].errors++;
        if (a.metadata?.sensitive === true) userStats[uid].sensitive++;
        if (a.action === 'export' || a.action?.includes('export')) userStats[uid].exports++;
        if (a.action?.includes('bulk') || a.metadata?.bulk === true) userStats[uid].bulk++;
        const ts = a.created_at ? new Date(a.created_at).getTime() : 0;
        if (ts > (userStats[uid].lastActivity || 0)) userStats[uid].lastActivity = ts;
      });

      const { data: alerts } = await window.supabaseClient.from('supervision_alerts').select('user_id').eq('status', 'open');
      const alertCounts = {};
      (alerts || []).forEach(a => { alertCounts[a.user_id] = (alertCounts[a.user_id] || 0) + 1; });

      const headers = ['Usuario ID', 'Nombre', 'Email', 'Rol', 'Acciones (7d)', 'Errores', 'Sensibles', 'Exportaciones', 'Masivas', 'Última actividad', 'Alertas abiertas'];
      const rows = Object.entries(userStats).map(([uid, stats]) => {
        const profile = profileMap.get(uid);
        return [
          uid,
          profile?.full_name || profile?.email || uid,
          profile?.email || '',
          profile?.role || '',
          stats.actions,
          stats.errors,
          stats.sensitive,
          stats.exports,
          stats.bulk,
          stats.lastActivity ? new Date(stats.lastActivity).toISOString() : '',
          alertCounts[uid] || 0
        ];
      });
      const date = new Date().toISOString().slice(0, 10);
      downloadCSV('supervision-usuarios-' + date + '.csv', rows, headers);
      showToast('Usuarios supervisión exportados (' + rows.length + ')', 'success');
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.exportSupModulesCSV = async function() {
    if (!window.supabaseClient) return;
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await window.supabaseClient.from('audit_log').select('module, action, status, user_id').gte('created_at', weekAgo);
      if (error) throw error;
      const audit = data || [];

      const modStats = {};
      audit.forEach(a => {
        const mod = a.module || 'general';
        if (!modStats[mod]) modStats[mod] = { total: 0, errors: 0, actions: new Set(), users: new Set() };
        modStats[mod].total++;
        modStats[mod].actions.add(a.action);
        modStats[mod].users.add(a.user_id);
        if (a.status === 'error' || a.status === 'critical') modStats[mod].errors++;
      });

      const headers = ['Módulo', 'Total acciones', 'Usuarios únicos', 'Acciones únicas', 'Errores', 'Tasa error %'];
      const rows = Object.entries(modStats).map(([mod, stats]) => {
        const errorRate = stats.total > 0 ? ((stats.errors / stats.total) * 100).toFixed(1) : 0;
        return [mod, stats.total, stats.users.size, stats.actions.size, stats.errors, errorRate + '%'];
      });
      const date = new Date().toISOString().slice(0, 10);
      downloadCSV('supervision-modulos-' + date + '.csv', rows, headers);
      showToast('Módulos supervisión exportados (' + rows.length + ')', 'success');
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
};

window.exportAnomaliesCSV = async function() {
  if (!window.supabaseClient) return;
  try {
    const timeWindow = $('#anomTimeWindow')?.value || '1 hour';
    const { data, error } = await window.supabaseClient.from('supervision_anomalies').select('*').eq('time_window', timeWindow).order('created_at', { ascending: false });
    if (error) throw error;
    const headers = ['ID', 'Módulo', 'Usuario', 'Acción', 'Métrica', 'Ventana', 'Observado', 'Esperado', 'Desv. Est.', 'Z-Score', 'Percentil', 'Severidad', 'Estado', 'Creada', 'Reconocida', 'Resuelta', 'Evidencia'];
    const rows = (data || []).map(a => [a.id, a.module || '', a.user_id || '', a.action || '', a.metric || '', a.time_window || '', a.observed_value, a.expected_mean, a.expected_stddev, a.z_score, a.percentile_rank, a.severity, a.status, a.created_at, a.acknowledged_at, a.resolved_at, JSON.stringify(a.evidence || {})]);
    const date = new Date().toISOString().slice(0, 10);
    downloadCSV('supervision-anomalias-' + date + '.csv', rows, headers);
    showToast('Anomalías exportadas (' + rows.length + ')', 'success');
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
};

/* ------------------------------------------------
   15. TOAST NOTIFICATIONS
   ------------------------------------------------ */
  function showToast(message, type = 'success') {
    const toast = $('#toastMsg');
    const text = $('#toastText');
    if (!toast || !text) return;

    const icons = {
      success: 'fas fa-circle-check',
      error: 'fas fa-circle-exclamation',
      info: 'fas fa-circle-info',
      warning: 'fas fa-triangle-exclamation',
    };
    const colors = {
      success: 'var(--accent)',
      error: 'var(--danger)',
      info: '#3B82F6',
      warning: 'var(--warning)',
    };

    const iconEl = toast.querySelector('i');
    if (iconEl) {
      iconEl.className = icons[type] || icons.success;
      iconEl.style.color = colors[type] || colors.success;
    }
    text.textContent = message;
    toast.classList.add('is-visible');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('is-visible');
    }, 4000);
  }

  /* ------------------------------------------------
     16. QUICK ACTIONS & GLOBAL SEARCH
     ------------------------------------------------ */
  $$('.quick-action-chip[data-action]').forEach(chip => {
    on(chip, 'click', () => {
      const action = chip.dataset.action;
      switch (action) {
        case 'openPropertyModal':
          editingPropertyId = null;
          resetPropertyForm();
          openModal('propertyModal');
          break;
        case 'openLeadModal':
          editingLeadId = null;
          $('#leadForm')?.reset();
          loadAgentSelect($('#leadBrokerSelect'));
          openModal('leadModal');
          break;
        case 'openVisitModal':
          editingVisitId = null;
          $('#visitForm')?.reset();
          loadAgentSelect($('#visitBrokerSelect'));
          loadPropertySelect($('#visitPropertySelect'));
          openModal('visitModal');
          break;
        case 'openOwnerModal':
          editingOwnerId = null;
          $('#ownerForm')?.reset();
          openModal('ownerModal');
          break;
        case 'goToCMS':
          navigateTo('tab-sitio-web');
          break;
        case 'goToAgenda':
          navigateTo('tab-agenda');
          break;
        case 'goToLeads':
          navigateTo('tab-leads');
          break;
        case 'goToAgents':
          navigateTo('tab-agentes');
          break;
        case 'goToDashboard':
          navigateTo('tab-dashboard');
          break;
      }
    });
  });

  /* Dashboard quick-view buttons */
  $$('[data-action="goToAgenda"], [data-action="goToLeads"], [data-action="goToAgents"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'goToAgenda') navigateTo('tab-agenda');
      else if (action === 'goToLeads') navigateTo('tab-leads');
      else if (action === 'goToAgents') navigateTo('tab-agentes');
    });
  });

  /* ------------------------------------------------
     16.5. CHAT REDES SOCIALES (Zernio Inbox)
     ------------------------------------------------ */
  document.body.dataset.bhChatVarsStart = 'true';
  let _chatRealtimeChannel = null;
  let _coreRealtimeChannel = null;
  let _chatCurrentConv = null;

  let _chatConversationsCache = [];
  let _chatPlatformFilter = 'all';
  let _chatSearchTerm = '';
  let _chatUnreadTotal = 0;
  let _pendingSendTempId = null;
  let _chatListenersBound = false;
  let _lastIncomingToastAt = 0;

  window.__chatTeardown = function () {
    if (_chatRealtimeChannel) { try { _chatRealtimeChannel.unsubscribe(); } catch {} _chatRealtimeChannel = null; }
    _chatCurrentConv = null;
    _pendingSendTempId = null;
    _chatConversationsCache = [];
  };
  document.body.dataset.bhBeforeLoadChatRedes = 'true';

async function loadChatRedes() {
    if (!currentUser || !window.supabaseClient) return;
    if (currentProfile?.role !== 'super_admin') {
      showToast('Acceso denegado: solo super_admin', 'error');
      navigateTo('tab-dashboard');
      return;
    }

    // Referencias DOM
    const searchEl = $('#chatSearch');
    const listEl = $('#chatConversationsList');
    const messagesEl = $('#chatMessages');
    const headerEl = $('#chatHeader');
    const composerEl = $('.chat-composer');
    const contactNameEl = $('.chat-contact-name');
    const platformBadgeEl = $('.chat-platform-badge');
    const accountBadgeEl = $('.chat-account-badge');
    const syncBtn = $('#btnSyncChat');
    const syncStatusEl = $('#chatSyncStatus');
    const markReadBtn = $('#btnMarkRead');
    const composerTextarea = $('#chatComposer');
    const sendBtn = $('#btnSendMessage');
    const filterChips = $$('.filter-chip');
    const composerHint = $('#composerPlatformHint');

    // Reset estado
    _chatCurrentConv = null;
    _pendingSendTempId = null;
    headerEl.style.display = 'none';
    composerEl.style.display = 'none';
    messagesEl.innerHTML = '<div class="chat-empty" style="text-align:center; padding:60px 20px; color:var(--text-dim); flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px;"><i class="fas fa-comments" style="font-size:48px; opacity:0.3;"></i><p>Selecciona una conversación para comenzar</p></div>';

    // Cargar cuentas para filtro
    const { data: accounts } = await window.supabaseClient
      .from('zernio_accounts')
      .select('zernio_account_id, platform, username, status')
      .eq('status', 'connected');

    // Eventos: búsqueda (solo se enganchan una vez; loadChatRedes se re-ejecuta cada vez que se entra a la pestaña)
    if (!_chatListenersBound) {
      on(searchEl, 'input', debounce(() => {
        _chatSearchTerm = searchEl.value.toLowerCase().trim();
        renderConversations();
      }, 150));

      // Eventos: filtros plataforma
      filterChips.forEach(chip => {
on(chip, 'click', () => {
          filterChips.forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          _chatPlatformFilter = chip.dataset.platform;
          renderConversations();
        });
      });

      // Evento: sincronizar
      syncBtn?.addEventListener('click', async () => {
        syncBtn.disabled = true;
        syncBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sincronizando...';
        syncStatusEl.textContent = 'Sincronizando...';

        try {
          // 1. Listar cuentas desde Zernio
          const accountsRes = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/zernio-proxy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${(await window.supabaseClient.auth.getSession()).data.session?.access_token}` },
            body: JSON.stringify({ action: 'list_accounts' })
          });
          const accountsData = await accountsRes.json();
          if (!accountsRes.ok) throw new Error(accountsData.error || 'Error listando cuentas');

          // 2. Backfill conversaciones
          const convRes = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/zernio-proxy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${(await window.supabaseClient.auth.getSession()).data.session?.access_token}` },
            body: JSON.stringify({ action: 'backfill_conversations' })
          });
          const convData = await convRes.json();
          if (!convRes.ok) throw new Error(convData.error || 'Error backfill conversaciones');

          // 3. Backfill mensajes (opcional, más lento)
          // TODO: podríamos backfill mensajes de conversaciones recientes

          syncStatusEl.textContent = `OK: ${accountsData.count} cuentas, ${convData.total} conversaciones`;
          showToast('Sincronización completada', 'success');
          loadConversations();
        } catch (err) {
          syncStatusEl.textContent = 'Error: ' + err.message;
          showToast('Error en sincronización: ' + err.message, 'error');
        } finally {
          syncBtn.disabled = false;
          syncBtn.innerHTML = '<i class="fas fa-arrows-rotate"></i> Sincronizar Ahora';
        }
      });

      // Eventos composer
      composerTextarea?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      if (composerTextarea && !composerTextarea.dataset.autosizeBound) {
        composerTextarea.dataset.autosizeBound = '1';
        composerTextarea.addEventListener('input', () => {
          composerTextarea.style.height = 'auto';
          composerTextarea.style.height = Math.min(composerTextarea.scrollHeight, 120) + 'px';
          try {
            if (_chatCurrentConv?.id) sessionStorage.setItem('chatDraft:' + _chatCurrentConv.id, composerTextarea.value);
          } catch (_) {}
        });
      }

      sendBtn?.addEventListener('click', sendMessage);
      markReadBtn?.addEventListener('click', markReadCurrent);

      _chatListenersBound = true;
    }

    // Cargar conversaciones inicial
    await loadConversations();

    // Realtime
    setupRealtime();
    setupCoreRealtime();

    // Funciones auxiliares
    async function loadConversations() {
      invalidateSearchCache();
      if (!listEl) return;
      listEl.innerHTML = '<div class="chat-empty" style="text-align:center; padding:40px 20px; color:var(--text-dim);">Cargando conversaciones...</div>';
      try {
        const { data, error } = await window.supabaseClient
          .from('zernio_conversations')
          .select('id, account_id, contact_name, contact_handle, platform, last_message_at, last_message_preview, unread_count, status')
          .eq('status', 'open')
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(100);
        if (error) throw error;
        renderConversations(data || []);
      } catch (err) {
        logError('loadConversations error:', err);
        listEl.innerHTML = '<div class="chat-empty" style="text-align:center; padding:40px 20px; color:var(--danger);">Error al cargar conversaciones</div>';
      }
    }

    function renderConversations(convs = null) {
      if (!listEl) return;
      if (convs) { _chatConversationsCache = convs; }

      let conversations = _chatConversationsCache || [];
      if (!conversations.length) {
        listEl.innerHTML = '<div class="chat-empty" style="text-align:center; padding:40px 20px; color:var(--text-dim);">No hay conversaciones</div>';
        return;
      }

      // Filtrar
      if (_chatSearchTerm) {
        const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const q = norm(_chatSearchTerm);
        conversations = conversations.filter(c =>
          norm(c.contact_name).includes(q) || norm(c.contact_handle).includes(q)
        );
      }
      if (_chatPlatformFilter !== 'all') {
        conversations = conversations.filter(c => {
          if (c.platform === _chatPlatformFilter) return true;
          const acc = accounts?.find(a => a.zernio_account_id === c.account_id);
          return acc?.platform === _chatPlatformFilter;
        });
      }

      if (!conversations.length) {
        listEl.innerHTML = '<div class="chat-empty" style="text-align:center; padding:40px 20px; color:var(--text-dim);">' + ((_chatSearchTerm || _chatPlatformFilter !== 'all') ? 'Sin resultados para el filtro activo' : 'No hay conversaciones') + '</div>';
        _chatUnreadTotal = (_chatConversationsCache || []).reduce((sum, c) => sum + (c.unread_count || 0), 0);
        updateSidebarChatBadge();
        return;
      }
      _chatUnreadTotal = (_chatConversationsCache || []).reduce((sum, c) => sum + (c.unread_count || 0), 0);
      updateSidebarChatBadge();

      // Build with DOM to avoid innerHTML sink — all dynamic values already escaped via esc()
      // Map accounts for O(1) lookup instead of array.find() in loop
      const accountById = new Map((accounts || []).map(a => [a.zernio_account_id, a]));
      listEl.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (const c of conversations) {
        const acc = accountById.get(c.account_id);
        const platformIcon = getPlatformIcon(acc?.platform);
        const platformLabel = acc?.platform || '—';
        const timeAgo = c.last_message_at ? formatRelativeTime(c.last_message_at) : '—';
        const unread = c.unread_count || 0;
        const isActive = _chatCurrentConv?.id === c.id;

        const item = document.createElement('div');
        item.className = `chat-conv-item ${isActive ? 'active' : ''}`;
        item.dataset.convId = c.id;
        item.style.cssText = `
          display:flex; gap:10px; padding:12px; border-radius:10px; cursor:pointer;
          transition:background 0.15s; border:1px solid ${isActive ? 'var(--accent)' : 'transparent'};
          background:${isActive ? 'rgba(31,200,195,0.1)' : 'rgba(255,255,255,0.02)'};
        `;

        const iconWrap = document.createElement('div');
        iconWrap.style.cssText = 'width:40px; height:40px; border-radius:50%; background:rgba(31,200,195,0.15); display:flex; align-items:center; justify-content:center; flex-shrink:0;';
        iconWrap.innerHTML = platformIcon;

        const contentWrap = document.createElement('div');
        contentWrap.style.cssText = 'flex:1; min-width:0;';

        const nameRow = document.createElement('div');
        nameRow.style.cssText = 'display:flex; justify-content:space-between; gap:8px;';
        const nameEl = document.createElement('span');
        nameEl.style.cssText = 'font-weight:600; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
        nameEl.textContent = c.contact_name || 'Sin nombre';
        const timeEl = document.createElement('span');
        timeEl.style.cssText = 'font-size:11px; color:var(--text-dim); white-space:nowrap;';
        timeEl.textContent = timeAgo;
        nameRow.append(nameEl, timeEl);

        const previewRow = document.createElement('div');
        previewRow.style.cssText = 'display:flex; justify-content:space-between; gap:8px; margin-top:4px;';
        const previewEl = document.createElement('span');
        previewEl.style.cssText = 'font-size:12px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
        previewEl.textContent = c.last_message_preview || '';
        const platformEl = document.createElement('span');
        platformEl.style.cssText = 'font-size:10px; color:var(--text-dim); white-space:nowrap;';
        platformEl.textContent = platformLabel;
        previewRow.append(previewEl, platformEl);

        contentWrap.append(nameRow, previewRow);
        item.append(iconWrap, contentWrap);

        if (unread > 0) {
          const badge = document.createElement('span');
          badge.className = 'chat-unread-badge';
          badge.style.cssText = 'background:var(--accent); color:#fff; font-size:11px; font-weight:700; padding:2px 6px; border-radius:10px; min-width:18px; text-align:center;';
          badge.textContent = String(unread);
          item.append(badge);
        }

        frag.appendChild(item);
      }
      listEl.appendChild(frag);

      // Click handlers
      $$('#chatConversationsList .chat-conv-item').forEach(item => {
        on(item, 'click', () => openConversation(item.dataset.convId));
      });
    }

    async function openConversation(convId) {
      const { data, error } = await window.supabaseClient
        .from('zernio_conversations')
        .select('*, account:zernio_accounts(platform, username)')
        .eq('id', convId)
        .single();
      if (error || !data) { showToast('No se pudo abrir la conversación', 'error'); return; }

      _chatCurrentConv = data;

      // Match chat ↔ CRM por teléfono/handle
      let matchedLead = null;
      try {
        const digits = String(data.contact_handle || '').replace(/\D/g, '');
        if (digits.length >= 6) {
          const last8 = digits.slice(-8);
          const leadRes = await window.supabaseClient
            .from('leads')
            .select('id, full_name, stage')
            .or('phone.ilike.%' + last8 + '%,whatsapp.ilike.%' + last8 + '%')
            .is('deleted_at', null)
            .limit(1)
            .maybeSingle();
          matchedLead = leadRes?.data || null;
        }
      } catch (_) {}

      // UI
      headerEl.style.display = 'flex';
      composerEl.style.display = 'block';
      document.querySelector('.chat-empty')?.remove();
      renderChatLeadBanner(matchedLead, data);

      const acc = data.account;
      contactNameEl.textContent = data.contact_name || 'Sin nombre';
      platformBadgeEl.innerHTML = getPlatformIcon(data.account?.platform) + ' ' + (data.account?.platform || '—');
      accountBadgeEl.textContent = data.account?.username ? '@' + data.account.username : '—';

      let lastInAt = null; try { const { data: lastIn } = await window.supabaseClient.from('zernio_messages').select('occurred_at').eq('conversation_id', convId).eq('direction', 'in').order('occurred_at', { ascending: false }).limit(1).maybeSingle(); lastInAt = lastIn?.occurred_at || null; } catch {}

      const windowClosed = lastInAt ? (Date.now() - new Date(lastInAt).getTime() > 24 * 60 * 60 * 1000) : true;
      const platform = data.account?.platform || 'desconocido';
      const isWindowed = platform === 'whatsapp' || platform === 'instagram';
      const blocked = windowClosed && isWindowed;

      if (blocked) {
        composerHint.innerHTML = '<i class="fas fa-clock"></i> ' + platform + ' · fuera de ventana 24h — no se puede responder (esperá que el contacto escriba)';
        composerHint.style.color = 'var(--warning)';
      } else if (data.account?.username) {
        composerHint.innerHTML = '<i class="fas fa-check-circle" style="color:var(--accent);"></i> ' + platform + ' · ventana abierta';
        composerHint.style.color = 'var(--text-dim)';
      } else {
        composerHint.textContent = platform;
        composerHint.style.color = 'var(--text-dim)';
      }

      composerTextarea.disabled = blocked;
      sendBtn.disabled = blocked;
      if (blocked) {
        composerTextarea.placeholder = 'Ventana de 24h cerrada — el contacto debe escribir primero';
      } else {
        composerTextarea.placeholder = 'Escribe tu respuesta...';
      }

      const attachBtnEl = $('#btnAttachFile');
      const attachInput = $('#chatAttachmentInput');
      const attachPreview = $('#chatAttachPreview');
      if (attachBtnEl && attachInput) {
        attachBtnEl.disabled = blocked;
        attachBtnEl.onclick = () => attachInput.click();
        attachInput.onchange = () => {
          const file = attachInput.files?.[0];
          if (!file) return;
          if (file.size > 10 * 1024 * 1024) { showToast('Archivo máximo 10MB', 'error'); attachInput.value = ''; return; }
          if (attachPreview?.dataset.url) URL.revokeObjectURL(attachPreview.dataset.url);
          const url = URL.createObjectURL(file);
          if (attachPreview) {
            const ext = (file.name.split('.').pop() || '').toLowerCase();
            const type = file.type.startsWith('image') ? 'image' : file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'file';
            attachPreview.innerHTML = `<span style="display:flex;align-items:center;gap:6px;"><i class="fas fa-paperclip" style="color:var(--accent);"></i> <span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${esc(file.name)} (${(file.size/1024).toFixed(0)} KB)</span><button type="button" onclick="this.parentElement.parentElement.style.display='none'; document.getElementById('chatAttachmentInput').value='';" style="background:none;border:none;color:var(--danger);cursor:pointer;"><i class="fas fa-times"></i></button></span>`;
            attachPreview.dataset.type = type;
            attachPreview.dataset.url = url;
            attachPreview.dataset.name = file.name;
            attachPreview.style.display = 'flex';
          }
        };
      }

      if (data.unread_count > 0) {
        await markRead(convId);
        data.unread_count = 0;
        const cached = (_chatConversationsCache || []).find(c => c.id === convId);
        if (cached) cached.unread_count = 0;
        _chatUnreadTotal = (_chatConversationsCache || []).reduce((sum, c) => sum + (c.unread_count || 0), 0);
        updateSidebarChatBadge();
      }

      try {
        const draft = sessionStorage.getItem('chatDraft:' + convId) || '';
        if (composerTextarea) { composerTextarea.value = draft; composerTextarea.style.height = 'auto'; }
      } catch (_) {}

      // Cargar mensajes
      await loadMessages(convId);

      // Actualizar lista visual
      $$('#chatConversationsList .chat-conv-item').forEach(el => {
        el.classList.toggle('active', el.dataset.convId === convId);
        const badge = el.querySelector('.chat-unread-badge');
        if (badge) badge.remove();
      });

      // Chat sidebar actions
      const createLeadBtn = $('#btnChatCreateLead');
      const scheduleVisitBtn = $('#btnChatScheduleVisit');
      const assignBrokerBtn = $('#btnChatAssignBroker');

      if (createLeadBtn) {
        createLeadBtn.onclick = async () => {
          if (!_chatCurrentConv) return;
          try {
            const digits = String(_chatCurrentConv.contact_handle || '').replace(/\D/g, '');
            if (digits.length >= 6) {
              const existing = await window.supabaseClient
                .from('leads')
                .select('id, full_name')
                .or('phone.ilike.%' + digits.slice(-8) + '%,whatsapp.ilike.%' + digits.slice(-8) + '%')
                .is('deleted_at', null)
                .limit(1)
                .maybeSingle();
              if (existing?.data) {
                showToast('Ya existe el lead: ' + (existing.data.full_name || ''), 'warning');
                document.querySelector('[data-tab="tab-leads"]')?.click();
                setTimeout(() => { if (window.BH_CRM?.open) window.BH_CRM.open(existing.data.id); }, 500);
                return;
              }
            }
            const normPhone = (window.BH_CRM && window.BH_CRM.telNumber && window.BH_CRM.telNumber(_chatCurrentConv.contact_handle)) || (_chatCurrentConv.contact_handle || '');
            const normWa = (window.BH_CRM && window.BH_CRM.waNumber && window.BH_CRM.waNumber(_chatCurrentConv.contact_handle)) || null;
            const { data: lead, error } = await window.supabaseClient
              .from('leads')
              .insert([{
                full_name: _chatCurrentConv.contact_name || 'Sin nombre',
                phone: normPhone,
                whatsapp: normWa,
                source: 'chat',
                stage: 'nuevo',
                assigned_to: _chatCurrentConv.broker_id || null,
                property_id: _chatCurrentConv.property_id || null,
                notes: `Creado desde chat Zernio (conv: ${_chatCurrentConv.id})`
              }])
              .select()
              .single();
            if (error) throw error;
            showToast('Lead creado: ' + (lead.full_name || lead.id), 'success');
            renderChatLeadBanner({ id: lead.id, full_name: lead.full_name, stage: 'nuevo' }, _chatCurrentConv);
            loadCRM();
            updateSidebarBadges();
          } catch (err) {
            showToast('Error creando lead: ' + err.message, 'error');
          }
        };
      }

      if (scheduleVisitBtn) {
        scheduleVisitBtn.onclick = () => {
          if (!_chatCurrentConv) return;
          window.adminApp.openVisitModal({
            lead_id: null,
            client_name: _chatCurrentConv.contact_name || '',
            client_phone: _chatCurrentConv.contact_handle || '',
            property_id: _chatCurrentConv.property_id || '',
            broker_id: _chatCurrentConv.broker_id || null
          });
        };
      }

      if (assignBrokerBtn) {
        assignBrokerBtn.onclick = async () => {
          if (!_chatCurrentConv) return;
          const { data: agents } = await window.supabaseClient
            .from('agents')
            .select('id, full_name')
            .eq('status', 'activo')
            .is('deleted_at', null)
            .order('full_name');
          if (!agents?.length) { showToast('No hay brokers activos', 'warning'); return; }

          const brokerSelect = $('#brokerAssignSelect');
          const modal = $('#brokerAssignModal');
          if (brokerSelect) {
            brokerSelect.innerHTML = '<option value="">— Seleccionar broker —</option>' +
              agents.map(a => `<option value="${a.id}">${a.full_name}</option>`).join('');
          }

          openModal('brokerAssignModal');

          const form = $('#brokerAssignForm');
          const handleSubmit = async (e) => {
            e.preventDefault();
            const brokerId = brokerSelect.value;
            if (!brokerId) { showToast('Selecciona un broker', 'warning'); return; }

            const selected = agents.find(a => a.id === brokerId);
            if (!selected) { showToast('Selección inválida', 'warning'); return; }

            try {
              const { error } = await window.supabaseClient
                .from('zernio_conversations')
                .update({ broker_id: selected.id, updated_at: new Date().toISOString() })
                .eq('id', _chatCurrentConv.id);
              if (error) throw error;
              _chatCurrentConv.broker_id = selected.id;
              showToast('Broker asignado: ' + selected.full_name, 'success');
              closeModal('brokerAssignModal');
              form.removeEventListener('submit', handleSubmit);
            } catch (err) {
              showToast('Error asignando broker: ' + err.message, 'error');
            }
          };
          form.addEventListener('submit', handleSubmit);

          const cancelBtn = modal.querySelector('.modal-close-btn');
          const closeHandler = () => {
            closeModal('brokerAssignModal');
            form.removeEventListener('submit', handleSubmit);
          };
          modal.querySelectorAll('.modal-close-btn').forEach(btn => btn.onclick = closeHandler);
        };
      }
    }

    window.adminApp.openChatConversation = openConversation;

    const STAGE_LABELS_LEAD = { nuevo: 'Nuevo', contactado: 'Contactado', calificado: 'Calificado', visita_agendada: 'Visita agendada', visita_realizada: 'Visita realizada', negociacion: 'Negociación', cerrado_ganado: 'Ganado', cerrado_perdido: 'Perdido' };
    function renderChatLeadBanner(lead, conv) {
      let banner = document.getElementById('chatLeadBanner');
      if (banner) banner.remove();
      banner = document.createElement('div');
      banner.id = 'chatLeadBanner';
      banner.style.cssText = 'margin:0 16px 8px; padding:10px 14px; border-radius:10px; font-size:12.5px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;';
      if (lead) {
        banner.style.background = 'rgba(31,200,195,0.08)';
        banner.style.border = '1px solid rgba(31,200,195,0.35)';
        banner.innerHTML =
          '<i class="fas fa-user-check" style="color:var(--accent);"></i> ' +
          '<span><strong>' + esc(lead.full_name || 'Lead') + '</strong> ya está en el CRM (' +
          esc(STAGE_LABELS_LEAD[lead.stage] || lead.stage) + ')</span>' +
          '<button type="button" class="btn-action" id="chatOpenLeadCrm" style="margin-left:auto;"><i class="fas fa-arrow-right"></i> Ver en CRM</button>';
        banner.querySelector('#chatOpenLeadCrm').addEventListener('click', () => {
          document.querySelector('[data-tab="tab-leads"]')?.click();
          setTimeout(() => {
            if (window.BH_CRM && window.BH_CRM.open) window.BH_CRM.open(lead.id);
          }, 500);
        });
      } else {
        banner.style.background = 'rgba(250,204,21,0.06)';
        banner.style.border = '1px solid rgba(250,204,21,0.3)';
        banner.innerHTML =
          '<i class="fas fa-user-plus" style="color:#FACC15;"></i> ' +
          '<span style="color:var(--text-secondary);">Este contacto no existe en el CRM</span>';
      }
      const host = document.getElementById('chatMessages') || headerEl?.parentElement;
      if (host && host.parentElement) host.parentElement.insertBefore(banner, host);
    }

    async function loadMessages(convId) {
      if (!messagesEl) return;
      messagesEl.innerHTML = '<div class="chat-empty" style="text-align:center; padding:40px 20px; color:var(--text-dim);">Cargando mensajes...</div>';
      try {
        const { data, error } = await window.supabaseClient
          .from('zernio_messages')
          .select('*')
          .eq('conversation_id', convId)
          .order('occurred_at', { ascending: true })
          .limit(100);
        if (error) throw error;

        if (!data || data.length === 0) {
          messagesEl.innerHTML = '<div class="chat-empty" style="text-align:center; padding:60px 20px; color:var(--text-dim);"><i class="fas fa-comments" style="font-size:48px; opacity:0.3;"></i><p>Sin mensajes aún</p></div>';
          return;
        }

        messagesEl.innerHTML = data.map(m => {
          const isOut = m.direction === 'out';
          const time = m.occurred_at ? new Date(m.occurred_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
          const ticks = getTicks(m.status);
          return `
            <div class="chat-bubble ${isOut ? 'out' : 'in'}" data-msg-id="${esc(m.id)}" style="
              display:flex; flex-direction:column; max-width:75%; ${isOut ? 'align-self:flex-end; margin-left:auto;' : 'align-self:flex-start; margin-right:auto;'}
            ">
              <div style="background:${m.direction === 'out' ? 'var(--accent)' : 'rgba(255,255,255,0.05)'}; color:#fff; padding:10px 14px; border-radius:${m.direction === 'out' ? '18px 18px 4px 18px' : '18px 18px 18px 4px'}; max-width:100%; word-wrap:break-word;">
                ${renderBody(m)}
              </div>
              <div style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:10px; color:var(--text-dim); ${isOut ? 'justify-content:flex-end;' : ''}">
                <span>${new Date(m.occurred_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</span>
                ${isOut ? `<span class="tick-icon ${m.status || ''}">${ticks}</span>` : ''}
              </div>
            </div>
          `;
        }).join('');

        // Scroll to bottom
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } catch (err) {
        logError('loadMessages error:', err);
        messagesEl.innerHTML = '<div class="chat-empty" style="text-align:center; padding:40px 20px; color:var(--danger);">Error cargando mensajes</div>';
      }
    }

    let _sending = false;
    async function sendMessage() {
      if (_sending) return;
      if (!_chatCurrentConv || !composerTextarea) return;
      const text = composerTextarea.value.trim();

      const attachPreview = $('#chatAttachPreview');
      const attachInput = $('#chatAttachmentInput');
      const file = attachInput?.files?.[0];

      if (!text && !file) return;
      _sending = true;

      let attachmentPayload = null;
      if (file) {
        const reader = new FileReader();
        const dataUrl = await new Promise((res, rej) => {
          reader.onload = () => res(reader.result);
          reader.onerror = () => rej(new Error('Error leyendo archivo'));
          reader.readAsDataURL(file);
        });
        attachmentPayload = {
          url: dataUrl,
          type: file.type.startsWith('image') ? 'image' : file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'file',
        };
        if (attachPreview) { attachPreview.style.display = 'none'; if (attachPreview.dataset.url) { URL.revokeObjectURL(attachPreview.dataset.url); delete attachPreview.dataset.url; } }
        attachInput.value = '';
      }
      try { if (_chatCurrentConv?.id) sessionStorage.removeItem('chatDraft:' + _chatCurrentConv.id); } catch (_) {}

      composerTextarea.value = '';
      composerTextarea.style.height = 'auto';

      const tempId = 'temp_' + Date.now();
      _pendingSendTempId = tempId;
      appendMessage({ body: text || (attachmentPayload ? '[Adjunto]' : ''), direction: 'out', occurred_at: new Date().toISOString(), status: 'sending', id: tempId, attachment: attachmentPayload });
      messagesEl.scrollTop = messagesEl.scrollHeight;

      try {
        const session = await window.supabaseClient.auth.getSession();
        const res = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/zernio-proxy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.data.session?.access_token}`
          },
          body: JSON.stringify({
            action: attachmentPayload ? 'send_message_attachment' : 'send_message',
            conversationId: _chatCurrentConv.id,
            text,
            attachmentUrl: attachmentPayload?.url,
            attachmentType: attachmentPayload?.type,
          })
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) { let parsedErr = null; try { parsedErr = typeof data.error === 'string' ? JSON.parse(data.error) : data.error; } catch {} if (data.window_closed && !parsedErr) { const platform = data.platform || 'whatsapp'; const msg = platform === 'instagram' ? 'Instagram rechaza mensajes fuera de la ventana de 24h. Esperá a que el contacto te escriba.' : 'Ventana de 24h cerrada'; showToast(msg, 'warning'); throw new Error(msg); } const userMsg = parsedErr?.user_message || parsedErr?.message || data.error || 'Error enviando'; throw new Error(userMsg); }

        if (data.window_closed) {
          const platform = data.platform || 'whatsapp'; const msg = platform === 'instagram' ? 'Instagram: ventana de 24h cerrada (esperá a que el contacto te escriba)' : 'Ventana de 24h de WhatsApp cerrada: puede requerir plantilla aprobada'; showToast(msg, 'warning');
        }
        // El mensaje real (con su id definitivo y ticks) llega vía Realtime,
        // que reemplaza esta burbuja optimista — ver setupRealtime().
      } catch (err) {
        _pendingSendTempId = null;
        showToast('Error enviando: ' + err.message, 'error');
        // Marcar error en la burbuja temporal correcta (por su tempId real) - usar DOM, no innerHTML
        const tempEl = messagesEl.querySelector(`[data-temp-id="${tempId}"]`);
        if (tempEl) {
          let ticksEl = tempEl.querySelector('.tick-icon');
          if (!ticksEl) {
            ticksEl = document.createElement('span');
            ticksEl.className = 'tick-icon failed';
            const footerRow = tempEl.querySelector('div:last-child');
            footerRow?.appendChild(ticksEl);
          }
          tempEl.dataset.pendingText = text;
          tempEl.title = err.message + ' (click para reintentar)';
          tempEl.style.cursor = 'pointer';
          ticksEl.className = 'tick-icon failed';
          ticksEl.textContent = '✕';
          ticksEl.style.color = 'var(--danger)';
          ticksEl.style.cursor = 'pointer';
          const retryHandler = (e) => {
            e.stopPropagation();
            tempEl.removeEventListener('click', retryHandler);
            tempEl.style.cursor = '';
            tempEl.style.background = '';
            tempEl.title = '';
            ticksEl.style.cursor = '';
            const retryText = tempEl.dataset.pendingText || '';
            tempEl.remove();
            const composer = document.getElementById('chatComposer');
            composer.value = retryText;
            composer.dispatchEvent(new Event('input', { bubbles: true }));
            sendMessage();
          };
          tempEl.addEventListener('click', retryHandler);
        }
      } finally {
        _sending = false;
      }
    }

    function renderAttachment(att) {
      if (!att) return '';
      const url = att.url || att.link || '';
      if (!url) return '';
      const type = String(att.type || '').toLowerCase();
      if (type === 'image' || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) {
        return `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="" style="max-width:220px; max-height:220px; border-radius:12px; display:block; margin-top:6px;" loading="lazy" /></a>`;
      }
      if (type === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(url)) {
        return `<video src="${esc(url)}" controls style="max-width:220px; border-radius:12px; display:block; margin-top:6px;"></video>`;
      }
      if (type === 'audio' || /\.(mp3|ogg|wav|m4a)(\?|$)/i.test(url)) {
        return `<audio src="${esc(url)}" controls style="max-width:220px; display:block; margin-top:6px;"></audio>`;
      }
      const name = att.name || 'Adjunto';
      return `<a href="${esc(url)}" target="_blank" rel="noopener" style="display:flex; align-items:center; gap:6px; margin-top:6px; color:var(--accent); font-size:12px;"><i class="fas fa-paperclip"></i> ${esc(name)}</a>`;
    }

    function renderBody(m) {
      if (m.status === 'deleted') {
        return '<span style="opacity:0.6; font-style:italic;"><i class="fas fa-ban"></i> Mensaje eliminado</span>';
      }
      const bodyHtml = esc(m.body || '');
      const att = m.attachment;
      const attHtml = att ? renderAttachment(att) : '';
      return bodyHtml + (attHtml ? (bodyHtml ? '<br/>' : '') + attHtml : '');
    }

    async function markReadCurrent() {
      if (!_chatCurrentConv) return;
      const list = _chatConversationsCache || [];
      const conv = list.find(c => c.id === _chatCurrentConv.id);
      const unread = conv?.unread_count || 0;
      if (unread === 0) { showToast('Sin mensajes sin leer', 'info'); return; }
      await markRead(_chatCurrentConv.id);
    }

    async function markRead(convId) {
      try {
        const { data: { session } } = await window.supabaseClient.auth.getSession();
        const res = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/zernio-proxy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
          body: JSON.stringify({ action: 'mark_read', conversationId: convId })
        });
        if (!res.ok) { logWarn('mark_read HTTP ' + res.status); }
        await window.supabaseClient.from('zernio_conversations').update({ unread_count: 0 }).eq('id', convId);
        loadConversations();
      } catch (err) {
        logError('markRead error:', err);
      }
    }

    function appendMessage(m) {
      if (!messagesEl) return;
      const empty = messagesEl.querySelector('.chat-empty');
      if (empty) empty.remove();
      const isOut = m.direction === 'out';
      const time = m.occurred_at ? new Date(m.occurred_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
      const ticks = getTicks(m.status || 'sent');
      const div = document.createElement('div');
      div.className = 'chat-bubble ' + (m.direction === 'out' ? 'out' : 'in');
      div.dataset.tempId = m.id;
      div.style.cssText = `display:flex; flex-direction:column; max-width:75%; ${m.direction === 'out' ? 'align-self:flex-end; margin-left:auto;' : 'align-self:flex-start; margin-right:auto;'}`;
      div.innerHTML = `
        <div style="background:${m.direction === 'out' ? 'var(--accent)' : 'rgba(255,255,255,0.05)'}; color:${m.status === 'deleted' ? 'var(--text-dim)' : '#fff'}; padding:10px 14px; border-radius:${m.direction === 'out' ? '18px 18px 4px 18px' : '18px 18px 18px 4px'}; max-width:100%; word-wrap:break-word;">
          ${renderBody(m)}
        </div>
        <div style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:10px; color:var(--text-dim); ${m.direction === 'out' ? 'justify-content:flex-end;' : ''}">
          <span>${new Date(m.occurred_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</span>
          ${m.direction === 'out' ? `<span class="tick-icon ${m.status || ''}">${ticks}</span>` : ''}
        </div>
      `;
      messagesEl.appendChild(div);
      const isNearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 150;
      if (isNearBottom) { messagesEl.scrollTop = messagesEl.scrollHeight; }
    }

    function getTicks(status) {

      if (status === 'read') return '<i class="fas fa-check-double" style="color:var(--accent);" title="Leído"></i>';

      if (status === 'delivered') return '<i class="fas fa-check-double" style="color:var(--text-dim);" title="Entregado"></i>';

      if (status === 'sent') return '<i class="fas fa-check" style="color:var(--text-dim);" title="Enviado"></i>';

      if (status === 'sending') return '<i class="fas fa-circle-notch fa-spin" style="color:var(--text-dim);" title="Enviando..."></i>';

      if (status === 'failed') return '<i class="fas fa-exclamation-triangle" style="color:var(--danger);" title="Falló"></i>';

      return '<i class="fas fa-check" style="color:var(--text-dim);"></i>';

    }

    function getPlatformIcon(platform) {
      const icons = {
        instagram: '<i class="fab fa-instagram" style="color:#E1306C; font-size:18px;"></i>',
        facebook: '<i class="fab fa-facebook" style="color:#1877F2; font-size:18px;"></i>',
        whatsapp: '<i class="fab fa-whatsapp" style="color:#25D366; font-size:18px;"></i>',
        telegram: '<i class="fab fa-telegram" style="color:#0088CC; font-size:18px;"></i>',
      };
      return icons[platform] || '<i class="fas fa-comments" style="color:var(--accent); font-size:18px;"></i>';
    }

    function getPlatformLabel(platform) {
      const labels = { instagram: 'Instagram', facebook: 'Facebook Messenger', whatsapp: 'WhatsApp', telegram: 'Telegram' };
      return labels[platform] || platform || '—';
    }

    function formatRelativeTime(iso) {
      const d = new Date(iso);
      const diff = Date.now() - d.getTime();
      const mins = Math.floor(diff / 60000);
      const hours = Math.floor(diff / 3600000);
      const days = Math.floor(diff / 86400000);
      if (mins < 1) return 'ahora';
      if (mins < 60) return `${mins}m`;
      if (hours < 24) return `${hours}h`;
      if (days < 7) return `${days}d`;
      return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
    }

function setupCoreRealtime() {
      if (_coreRealtimeChannel) {
        _coreRealtimeChannel.unsubscribe();
        _coreRealtimeChannel = null;
      }
      const tables = ['visits', 'leads', 'properties', 'agents', 'owners', 'owner_tasks', 'tasaciones', 'commissions', 'commission_liquidations', 'commission_payments'];
      _coreRealtimeChannel = window.supabaseClient.channel('core-tables')
        .on('postgres_changes', { event: '*', schema: 'public', table: tables }, payload => {
          const table = payload.table;
          const event = payload.eventType;
          const newRecord = payload.new;
          const oldRecord = payload.old;

          invalidateSearchCache();
          if (table === 'properties') invalidateFichaCache();
          if (window.Bus) window.Bus.emit(table + ':changed', { event, new: newRecord, old: oldRecord });

          switch (table) {
            case 'visits':
              if (event === 'INSERT') {
                upsertVisitRow(newRecord);
                updateSidebarBadges();
                if (newRecord?.lead_id) loadCRM();
              } else if (event === 'UPDATE') {
                upsertVisitRow(newRecord);
                updateSidebarBadges();
              } else if (event === 'DELETE') {
                removeVisitRow(oldRecord.id);
                updateSidebarBadges();
              }
              if (event === 'INSERT' && newRecord?.lead_id) loadCRM();
              break;
            case 'leads':
              if (event === 'INSERT' || event === 'UPDATE') {
                upsertLeadCard(newRecord);
              } else if (event === 'DELETE') {
                removeLeadCard(oldRecord.id);
              }
              updateSidebarBadges();
              break;
            case 'properties':
              if (event === 'INSERT' || event === 'UPDATE') {
                upsertPropertyRow(newRecord);
              } else if (event === 'DELETE') {
                removePropertyRow(oldRecord.id);
              }
              updateSidebarBadges();
              break;
            case 'agents':
              if (event === 'INSERT' || event === 'UPDATE') {
                upsertAgentRow(newRecord);
                populateBrokerFilters();
              } else if (event === 'DELETE') {
                removeAgentRow(oldRecord.id);
              }
              updateSidebarBadges();
              break;
            case 'owners':
              if (event === 'INSERT' || event === 'UPDATE') {
                upsertOwnerRow(newRecord);
              } else if (event === 'DELETE') {
                removeOwnerRow(oldRecord.id);
              }
              updateSidebarBadges();
              break;
            case 'owner_tasks':

              if (editingOwnerId && $('#ownerModal')?.classList.contains('is-open')) {

                loadOwnerTasks(editingOwnerId);



              loadOwners();

              }

              updateSidebarBadges();

              break;

            case 'tasaciones':
              if (event === 'INSERT' || event === 'UPDATE') {
                upsertTasacionRow(newRecord);
              } else if (event === 'DELETE') {
                removeTasacionRow(oldRecord.id);
              }
              updateSidebarBadges();
              break;
          }
        })
        .subscribe();
    }

    function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

    function setupRealtime() {
      if (_chatRealtimeChannel) {
        _chatRealtimeChannel.unsubscribe();
        _chatRealtimeChannel = null;
      }
      _chatRealtimeChannel = window.supabaseClient.channel('zernio-chat')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'zernio_messages' }, payload => {
          const m = payload.new;
          const isIncoming = m.direction === 'in';
          const now = Date.now();
          const toastOk = now - _lastIncomingToastAt > 3000; // throttle
          if (toastOk) _lastIncomingToastAt = now;
          if (!_chatCurrentConv || m.conversation_id !== _chatCurrentConv.id) {
            loadConversations(); // actualizar badge
            if (isIncoming && toastOk) showToast('Nuevo mensaje entrante', 'info');
            return;
          }
          if (isIncoming && toastOk) showToast('Nuevo mensaje de ' + (_chatCurrentConv.contact_name || 'contacto'), 'info');
          // Si es el eco del mensaje que acabamos de enviar de forma optimista,
          // sacamos la burbuja temporal y dejamos que se agregue la real (con ticks reales).
          if (m.direction === 'out' && _pendingSendTempId) {
            const tempEl = messagesEl.querySelector(`[data-temp-id="${_pendingSendTempId}"]`);
            if (tempEl) tempEl.remove();
            _pendingSendTempId = null;
          }
          // Evitar duplicados si el mensaje ya está renderizado (temp o definitivo)
          if (messagesEl.querySelector(`[data-temp-id="${m.id}"]`) || messagesEl.querySelector(`[data-msg-id="${m.id}"]`)) return;
          appendMessage(m);
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'zernio_messages' }, payload => {
          const m = payload.new;
          if (!_chatCurrentConv || m.conversation_id !== _chatCurrentConv.id) return;
          const el = messagesEl.querySelector(`[data-temp-id="${m.id}"]`) || messagesEl.querySelector(`[data-msg-id="${m.id}"]`);
          if (!el) return;

          if (m.status === 'deleted') {
            const bubble = el.querySelector('div');
            if (bubble) bubble.innerHTML = '<span style="opacity:0.6; font-style:italic;"><i class="fas fa-ban"></i> Mensaje eliminado</span>';
            return;
          }

          const ticksEl = el.querySelector('.tick-icon');
          if (ticksEl) { ticksEl.innerHTML = getTicks(m.status); ticksEl.className = 'tick-icon ' + (m.status || ''); }

          if (m.body) {
            const bubbleEl = el.querySelector('div');
            if (bubbleEl) bubbleEl.innerHTML = renderBody(m);
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'zernio_conversations' }, debounce(() => {
          loadConversations();
        }, 400))
        .subscribe();
    }

    function updateSidebarChatBadge() {
      const badge = $('#sideBadgeChatRedes');
      if (badge) badge.textContent = _chatUnreadTotal || '0';
    }
  }
  document.body.dataset.bhAfterChat = 'true';

  /* Global search */
  let _searchCache = null;
  let _searchCacheExpiresAt = 0;
  const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — evita datos desactualizados de leads/agents/owners
  const SEARCH_RESULT_LIMIT = 15;
  let _gsActions = [];
  let _gsActiveIndex = -1;
  let _gsRunId = 0;

  /* Búsqueda tolerante a tildes/diacríticos (castellano) */
  const GS_ACCENT = { a: '[a\u00e0\u00e1\u00e4\u00e2]', e: '[e\u00e8\u00e9\u00eb\u00ea]', i: '[i\u00ec\u00ed\u00ef\u00ee]', o: '[o\u00f2\u00f3\u00f6\u00f4]', u: '[u\u00f9\u00fa\u00fc\u00fb]', n: '[n\u00f1]', c: '[c\u00e7]' };
  function gsNorm(str) {
    return String(str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  async function getSearchCache() {
    if (_searchCache && Date.now() < _searchCacheExpiresAt) return _searchCache;
    const empty = { properties: [], leads: [], agents: [], owners: [], visits: [], tasaciones: [], profiles: [], conversations: [] };
    if (!window.supabaseClient) return empty;

    /* Promise.allSettled: si un módulo falla o falta permiso RLS, los demás siguen funcionando */
    const requests = [
      ['properties', window.supabaseClient.from('properties').select('id, title, zone, address, price_usd, status, property_code').is('deleted_at', null).order('created_at', { ascending: false }).limit(200)],
      ['leads', window.supabaseClient.from('leads').select('id, full_name, email, phone, stage').is('deleted_at', null).order('created_at', { ascending: false }).limit(200)],
      ['agents', window.supabaseClient.from('agents').select('id, full_name, email, matricula').is('deleted_at', null).order('created_at', { ascending: false }).limit(100)],
      ['owners', window.supabaseClient.from('owners').select('id, full_name, email, phone').is('deleted_at', null).order('created_at', { ascending: false }).limit(100)],
      ['visits', window.supabaseClient.from('visits').select('id, client_name, client_phone, visit_date, status').order('visit_date', { ascending: false }).limit(200)],
      ['tasaciones', window.supabaseClient.from('tasaciones').select('id, title, status, created_at').order('created_at', { ascending: false }).limit(200)],
      ['profiles', window.supabaseClient.from('profiles').select('id, full_name, email, role').order('created_at', { ascending: true }).limit(100)],
      ['conversations', window.supabaseClient.from('zernio_conversations').select('id, contact_name, contact_handle, last_message_preview, status').eq('status', 'open').order('last_message_at', { ascending: false, nullsFirst: false }).limit(100)],
    ];

    const settled = await Promise.allSettled(requests.map(([, req]) => req));
    _searchCache = { ...empty };
    settled.forEach((res, i) => {
      const name = requests[i][0];
      if (res.status === 'fulfilled') {
        _searchCache[name] = res.value.data || [];
      } else {
        console.warn('[búsqueda global] falló carga de "' + name + '":', res.reason?.message || res.reason);
      }
    });
    _searchCacheExpiresAt = Date.now() + SEARCH_CACHE_TTL_MS;
    return _searchCache;
  }

  function invalidateSearchCache() { _searchCache = null; _searchCacheExpiresAt = 0; }
function invalidateFichaCache() { _fichaPropsCache = []; _fichaAgentsCache = []; if (window.loadFichaHtml) window.loadFichaHtml(); }

async function mutate(table, fn) {
  try {
    const result = await fn();
    invalidateSearchCache();
    if (table === 'properties') invalidateFichaCache();
    if (window.Bus) window.Bus.emit(table + ':changed', result);
    return result;
  } catch (err) {
    throw err;
  }
}

  /* Resalta la coincidencia con <mark> sobre texto YA escapado (CSP/XSS safe).
     Tolerante a tildes: cada vocal matchea sus variantes con diacríticos. */
  function gsHighlight(text, q) {
    const safe = esc(String(text ?? ''));
    const qn = gsNorm(q).trim();
    if (!qn) return safe;
    const pat = qn.split('').map((ch) => GS_ACCENT[ch] || ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    try {
      return safe.replace(new RegExp('(' + pat + ')', 'gi'), '<mark>$1</mark>');
    } catch (_err) {
      return safe;
    }
  }

  /* ------------------------------------------------
     17. SIDEBAR BADGES
     ------------------------------------------------ */
  async function updateSidebarBadges() {
    if (!currentUser || !window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient.rpc('get_sidebar_badge_counts');
      if (error) throw error;
      const counts = data || { properties: 0, leads: 0, visits: 0, owners: 0, tasaciones: 0 };

      const propsEl = $('#sideBadgeProps');
      const leadsEl = $('#sideBadgeLeads');
      const visitsEl = $('#sideBadgeVisits');
      const ownersEl = $('#sideBadgeOwners');
      const tasEl = $('#sideBadgeTasaciones');

      if (propsEl) propsEl.textContent = counts.properties || 0;
      if (leadsEl) leadsEl.textContent = (counts.leads || 0) + ' Activos';
      if (visitsEl) visitsEl.textContent = (counts.visits || 0) + ' Citas';
      if (ownersEl) {
        const overdueTasks = counts.owner_tasks_overdue || 0;
        ownersEl.textContent = (counts.owners || 0) + ' Activos' + (overdueTasks > 0 ? ' · ' + overdueTasks + ' tareas vencidas' : '');
        if (overdueTasks > 0) ownersEl.style.color = 'var(--danger)';
      }
      if (tasEl) tasEl.textContent = counts.tasaciones || 0;
    } catch (err) {
      logError('Badge update error:', err);
    }
    loadNotifications();
  }

  /* ------------------------------------------------
     17.5 NOTIFICATIONS (Campanita)
     ------------------------------------------------ */
  let _notifItems = [];
  const NOTIF_SEEN_KEY = 'bh_notif_last_seen';
  const NOTIF_READ_IDS_KEY = 'bh_notif_read_ids';

  function getNotifReadIds() {
    try { return new Set(JSON.parse(localStorage.getItem(NOTIF_READ_IDS_KEY)) || []); } catch (_) { return new Set(); }
  }
  function saveNotifReadIds(set) {
    try { localStorage.setItem(NOTIF_READ_IDS_KEY, JSON.stringify(Array.from(set).slice(-300))); } catch (_) {}
  }
  function markNotifRead(id) { const ids = getNotifReadIds(); ids.add(id); saveNotifReadIds(ids); }
  function isNotifRead(item, lastSeen) { const readIds = getNotifReadIds(); return readIds.has(item.id) || (item.ts <= lastSeen && item.ts <= Date.now()); }

  function getNotifLastSeen() {
    const v = localStorage.getItem(NOTIF_SEEN_KEY);
    return v ? parseInt(v, 10) || 0 : 0;
  }

  function setNotifLastSeen(ts) {
    try { localStorage.setItem(NOTIF_SEEN_KEY, String(ts)); } catch (_) {}
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '—';
    const diffMin = Math.round((Date.now() - new Date(dateStr).getTime()) / 60000);
    if (diffMin < 1) return 'ahora mismo';
    if (diffMin < 60) return `hace ${diffMin} min`;
    const diffH = Math.round(diffMin / 60);
    if (diffH < 24) return `hace ${diffH} h`;
    const diffD = Math.round(diffH / 24);
    if (diffD < 7) return `hace ${diffD} d`;
    return formatDateWithTZ(dateStr, { day: '2-digit', month: 'short' });
  }

  function timeUntil(dateStr) {
    if (!dateStr) return '—';
    const diffMin = Math.round((new Date(dateStr).getTime() - Date.now()) / 60000);
    if (diffMin <= 0) return 'en curso';
    if (diffMin < 60) return `en ${diffMin} min`;
    const diffH = Math.round(diffMin / 60);
    if (diffH < 24) return `en ${diffH} h`;
    const diffD = Math.round(diffH / 24);
    return `en ${diffD} d`;
  }

  async function loadNotifications() {
    if (!currentUser || !window.supabaseClient) return;
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const nowIso = new Date().toISOString();
      const soonIso = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      const [leadsRes, visitsRes, tasRes, alertsRes] = await Promise.all([
        window.supabaseClient.from('leads').select('id, full_name, created_at').eq('stage', 'nuevo').gte('created_at', since).order('created_at', { ascending: false }).limit(5),
        window.supabaseClient.from('visits').select('id, client_name, visit_date').eq('status', 'pendiente').gte('visit_date', nowIso).lte('visit_date', soonIso).order('visit_date', { ascending: true }).limit(5),
        window.supabaseClient.from('tasaciones').select('id, title, created_at').neq('status', 'finalized').gte('created_at', since).order('created_at', { ascending: false }).limit(5),
        window.supabaseClient.from('supervision_alerts').select('id, severity, title, module, created_at, user_id, assigned_to').eq('status', 'open').in('severity', ['critical', 'high']).order('created_at', { ascending: false }).limit(5),
      ]);

      const items = [];

      (leadsRes.data || []).forEach(l => {
        items.push({
          id: 'lead-' + l.id,
          icon: 'fas fa-user-plus',
          color: '#3B82F6',
          title: `Nuevo prospecto: ${l.full_name || 'Sin nombre'}`,
          sub: timeAgo(l.created_at),
          tab: 'tab-leads',
          ts: new Date(l.created_at).getTime(),
        });
      });

      (visitsRes.data || []).forEach(v => {
        items.push({
          id: 'visit-' + v.id,
          icon: 'fas fa-calendar-check',
          color: '#1FC8C3',
          title: `Visita con ${v.client_name || 'cliente'} ${timeUntil(v.visit_date)}`,
          sub: new Date(v.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
          tab: 'tab-agenda',
          ts: new Date(v.visit_date).getTime(),
        });
      });

      (tasRes.data || []).forEach(t => {
        items.push({
          id: 'tas-' + t.id,
          icon: 'fas fa-calculator',
          color: '#F97316',
          title: `Tasación pendiente: ${t.title || 'Sin título'}`,
          sub: timeAgo(t.created_at),
          tab: 'tab-tasaciones',
          ts: new Date(t.created_at).getTime(),
        });
      });

      // Supervisión: alertas critical/high abiertas
      const severityColors = { critical: '#EF4444', high: '#F97316' };
      const severityLabels = { critical: 'Crítica', high: 'Alta' };
      const severityIcons = { critical: 'fas fa-shield-alt', high: 'fas fa-exclamation-triangle' };
      (alertsRes.data || []).forEach(a => {
        items.push({
          id: 'sup-' + a.id,
          icon: severityIcons[a.severity] || 'fas fa-shield-alt',
          color: severityColors[a.severity] || '#EF4444',
          title: `${severityLabels[a.severity] || a.severity}: ${a.title}`,
          sub: `${a.module} • ${timeAgo(a.created_at)}`,
          tab: 'tab-supervision',
          ts: new Date(a.created_at).getTime(),
          // Guardar info para navegar a vista Alertas
          _supView: 'alerts',
        });
      });

      if (_chatUnreadTotal > 0) {
        items.push({
          id: 'chat-unread',
          icon: 'fas fa-comments',
          color: '#8B5CF6',
          title: `${_chatUnreadTotal} mensaje${_chatUnreadTotal === 1 ? '' : 's'} sin leer`,
          sub: 'Chat Redes Sociales',
          tab: 'tab-chat-redes',
          ts: Date.now(),
        });
      }

      items.sort((a, b) => b.ts - a.ts);
      _notifItems = items.slice(0, 10);
      renderNotifications();
    } catch (err) {
      logError('Notifications load error:', err);
    }
  }

  function renderNotifications() {
    const listEl = $('#notifList');
    const pingEl = $('#notifPingBadge');
    if (!listEl) return;

    const lastSeen = getNotifLastSeen();
    const unseenCount = _notifItems.filter(n => !isNotifRead(n, lastSeen)).length;
    if (pingEl) pingEl.style.display = unseenCount > 0 ? 'block' : 'none';

    if (!_notifItems.length) {
      listEl.innerHTML = '<div class="notif-empty"><i class="far fa-bell-slash"></i><span>Sin novedades por ahora</span></div>';
      return;
    }

    listEl.innerHTML = _notifItems.map(n => {
      const isUnread = !isNotifRead(n, lastSeen);
      const bg = n.color.startsWith('#') ? n.color + '20' : 'rgba(31,200,195,0.15)';
      return `
        <div class="notif-item${isUnread ? ' is-unread' : ''}" data-tab="${esc(n.tab)}" data-id="${esc(n.id)}">
          <div class="notif-item-icon" style="color:${n.color}; background:${bg};"><i class="${esc(n.icon)}"></i></div>
          <div class="notif-item-body">
            <div class="notif-item-title">${esc(n.title)}</div>
            <div class="notif-item-sub">${esc(n.sub)}</div>
          </div>
          ${isUnread ? '<span class="notif-dot"></span>' : ''}
        </div>`;
    }).join('');
  }

  function initNotifications() {
    const btn = $('#notifBtn');
    const wrapper = $('#notifWrapper');
    const panel = $('#notifPanel');
    const markAllBtn = $('#notifMarkAllRead');
    if (!btn || !panel || !wrapper) return;

    function closePanel() {
      panel.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
    }

    function togglePanel() {
      const willOpen = !panel.classList.contains('is-open');
      panel.classList.toggle('is-open', willOpen);
      btn.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) loadNotifications();
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    markAllBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      setNotifLastSeen(Date.now());
      const ids = getNotifReadIds();
      _notifItems.forEach((n) => ids.add(n.id));
      saveNotifReadIds(ids);
      renderNotifications();
    });

    panel.addEventListener('click', (e) => {
      const item = e.target.closest('.notif-item');
      if (!item) return;
      const n = _notifItems.find((x) => x.id === item.dataset.id);
      if (n) {
        /* Click = leída. Solo este ítem (ids), sin mover lastSeen (evita ocultar futuras) */
        markNotifRead(n.id);
        renderNotifications();
        if (n.tab) {
          navigateTo(n.tab);
          // Si es supervisión y tiene vista específica, cambiar sub-tab
          if (n.tab === 'tab-supervision' && n._supView) {
            setTimeout(() => switchSupView(n._supView), 100);
          }
        }
      }
      closePanel();
    });

    document.addEventListener('click', (e) => {
      if (!wrapper.contains(e.target)) closePanel();
    });

on(document, 'keydown', (e) => {
      if (e.key === 'Escape') closePanel();
    });
  }

  let _fichaPropsCache = [];
  let _fichaAgentsCache = [];
  let _fichaPhotos = [];
  let _fichaFooterTimer = null;

  /* Extraido a assets/js/admin-ficha.js (modularizacion) */
  /* Extraido a assets/js/admin-supervision-panel.js (modularizacion) */
  /* ------------------------------------------------
     NÚCLEO COMPARTIDO PARA MÓDULOS (modularización)
     Los módulos admin-<nombre>.js son IIFEs que se cargan
     después de este archivo y leen helpers de window.__BH
     (destructurados al inicio) y el estado compartido vía
     accessors globales (bare reads/assignments resueltos
     por defineProperty: lectura/escritura en vivo).
     ------------------------------------------------ */
  window.__BH = Object.assign(window.__BH || {}, {
    $, $$, on, offAll, esc, logError, logWarn,
    formatDateWithTZ, formatDateTimeWithTZ, getSupTimezone, setSupTimezone,
    showToast, openModal, closeModal, showConfirmDialog, showInputPrompt,
    downloadCSV, mutate, z, zodBaseType, validateForm,
    setBtnLoading, restoreBtn,
    loadAgentSelect, loadPropertySelect, refreshOwnerSelect,
    updateSidebarBadges, invalidateSearchCache, navigateTo,
    updateAgendaBadge, sendBrowserNotification, requestNotificationPermission,
    formatPrice, formatNumber, checkPasswordPwned, getAuthedClient,
    setKPI, updateUserInfo, OwnerSchema, PropertySchema, LeadSchema, VisitSchema, TasacionSchema, AgentSchema,
  });
  const __bhAccessor = (name, get, set) => Object.defineProperty(window, name, { get, set, configurable: true });
  __bhAccessor('currentUser', () => currentUser, v => { currentUser = v; });
  __bhAccessor('currentProfile', () => currentProfile, v => { currentProfile = v; });
  __bhAccessor('currentSection', () => currentSection, v => { currentSection = v; });
  __bhAccessor('editingPropertyId', () => editingPropertyId, v => { editingPropertyId = v; });
  __bhAccessor('editingOwnerId', () => editingOwnerId, v => { editingOwnerId = v; });
  __bhAccessor('editingAgentId', () => editingAgentId, v => { editingAgentId = v; });
  __bhAccessor('editingLeadId', () => editingLeadId, v => { editingLeadId = v; });
  __bhAccessor('editingVisitId', () => editingVisitId, v => { editingVisitId = v; });
  __bhAccessor('_ownerFormSourcePropertyModal', () => _ownerFormSourcePropertyModal, v => { _ownerFormSourcePropertyModal = v; });
  __bhAccessor('_submittingAgent', () => _submittingAgent, v => { _submittingAgent = v; });
  __bhAccessor('_submittingPortal', () => _submittingPortal, v => { _submittingPortal = v; });
  __bhAccessor('_submittingProperty', () => _submittingProperty, v => { _submittingProperty = v; });
  __bhAccessor('_propPage', () => _propPage, v => { _propPage = v; });
  __bhAccessor('_propPageSize', () => _propPageSize, v => { _propPageSize = v; });
  __bhAccessor('_propTotalCount', () => _propTotalCount, v => { _propTotalCount = v; });
  __bhAccessor('_propSearchQuery', () => _propSearchQuery, v => { _propSearchQuery = v; });
  __bhAccessor('_propStatusFilter', () => _propStatusFilter, v => { _propStatusFilter = v; });
  __bhAccessor('_propPubFilter', () => _propPubFilter, v => { _propPubFilter = v; });
  __bhAccessor('_propAgentFilter', () => _propAgentFilter, v => { _propAgentFilter = v; });
  __bhAccessor('_propViewTrash', () => _propViewTrash, v => { _propViewTrash = v; });
  __bhAccessor('_propTrashCount', () => _propTrashCount, v => { _propTrashCount = v; });
  __bhAccessor('_propPaginationBound', () => _propPaginationBound, v => { _propPaginationBound = v; });
  __bhAccessor('_propSelected', () => _propSelected, v => { _propSelected = v; });
  __bhAccessor('_fichaPropsCache', () => _fichaPropsCache, v => { _fichaPropsCache = v; });
  __bhAccessor('_fichaAgentsCache', () => _fichaAgentsCache, v => { _fichaAgentsCache = v; });
  __bhAccessor('_fichaPhotos', () => _fichaPhotos, v => { _fichaPhotos = v; });
  __bhAccessor('_fichaFooterTimer', () => _fichaFooterTimer, v => { _fichaFooterTimer = v; });
  __bhAccessor('_tasacionesPage', () => _tasacionesPage, v => { _tasacionesPage = v; });
  __bhAccessor('_tasacionesPageSize', () => _tasacionesPageSize, v => { _tasacionesPageSize = v; });
  __bhAccessor('_tasacionesTotalCount', () => _tasacionesTotalCount, v => { _tasacionesTotalCount = v; });
  __bhAccessor('_pendingPropertyNotes', () => _pendingPropertyNotes, v => { _pendingPropertyNotes = v; });
  __bhAccessor('_createdOwnerId', () => _createdOwnerId, v => { _createdOwnerId = v; });
  __bhAccessor('ml_connected', () => ml_connected, v => { ml_connected = v; });
  __bhAccessor('ml_user', () => ml_user, v => { ml_user = v; });
  __bhAccessor('ml_listings', () => ml_listings, v => { ml_listings = v; });
  __bhAccessor('ml_configured', () => ml_configured, v => { ml_configured = v; });

  /* ------------------------------------------------
     18. UTILITY
     ------------------------------------------------ */
  function formatPrice(price, currency) {
    if (!price) return '-';
    return currency === 'ARS' ? _arsFormatter.format(price) : _usdFormatter.format(price);
  }

  function formatNumber(num) {
    return _numFormatter.format(num);
  }

  /* ------------------------------------------------
     19. INIT
     ------------------------------------------------ */
  function startApp() {

    // ML OAuth callback via hash — ml-oauth/start redirects back to admin.html#/mercadolibre?ml=connected=1
    // or #/mercadolibre?ml=error&message=<msg>. Parse from hash (not searchParams).
    (function handleMlCallbackQuery() {
      try {
        const url = new URL(window.location.href);
        // El callback redirige a /admin#/mercadolibre?ml=... — leer params dentro del hash, no en ?query
        const hashPart = url.hash.includes('?') ? url.hash.split('?')[1] : '';
        const hashParams = new URLSearchParams(hashPart);
        const mlRaw = hashParams.get('ml');
        if (!mlRaw) return;
        const mlStatus = mlRaw.startsWith('connected') ? 'connected' : mlRaw;
        if (mlStatus === 'connected') {
          showToast('¡Cuenta de Mercado Libre conectada exitosamente!', 'success');
          ml_connected = true;
          setTimeout(async () => { await window.__BH.mlCheckStatus?.(); window.__BH.loadPortals?.(); navigateTo('tab-portales'); }, 100);
        } else if (mlStatus === 'error') {
          const msg = hashParams.get('message') || 'Error desconocido';
          showToast('Error al conectar con Mercado Libre: ' + decodeURIComponent(msg), 'error');
        }
        // Limpiar params ML del hash para que un reload no repita el toast
        const cleanHash = url.hash.replace(/\?ml=[^&#]*(&message=[^&#]*)?(&user_id=[^&#]*)?/, '').replace(/(\?|&)+$/, '');
        window.history.replaceState({}, '', url.pathname + (cleanHash && cleanHash !== '#' ? cleanHash : ''));
      } catch (e) {
        console.warn('[ML] callback parse failed:', e.message);
      }
    })();

    // Deferred initialization - runs after DOM is ready
    const _origLoadProperties = window.__BH.loadProperties;
    window.__BH.loadProperties = function () { invalidateSearchCache(); return _origLoadProperties.apply(this, arguments); };

    let _gsDebounceTimer = null;
    $('#globalSearchInput')?.addEventListener('input', (e) => {
      clearTimeout(_gsDebounceTimer);
      _gsDebounceTimer = setTimeout(() => runGlobalSearch(e.target.value), 250);
    });

    async function runGlobalSearch(rawQuery) {
      const myRun = ++_gsRunId;
      const q = gsNorm(rawQuery).trim();
      const resultsContainer = $('#globalSearchResults');
      if (!resultsContainer) return;
      if (!q || q.length < 2) { resultsContainer.innerHTML = ''; resultsContainer.style.display = 'none'; _gsActiveIndex = -1; return; }

      const cache = await getSearchCache();
      if (myRun !== _gsRunId) return;
      const results = [];

      /* Atajos de módulo: escribir el nombre del módulo también lo encuentra */
      const MODULE_HITS = [
        { name: 'Fichas HTML', sub: 'Generador de fichas por propiedad', tab: 'tab-ficha-html', color: '#14B8A6', icon: 'fas fa-file-export', keys: ['ficha'] },
        { name: 'Propiedades', sub: 'Catálogo de inmuebles', tab: 'tab-propiedades', color: 'var(--accent)', icon: 'fas fa-building', keys: ['propiedad', 'inmueb', 'catalogo'] },
        { name: 'Leads & CRM', sub: 'Prospectos y propietarios', tab: 'tab-leads', color: '#3B82F6', icon: 'fas fa-users', keys: ['lead', 'crm', 'prospecto'] },
        { name: 'Agenda', sub: 'Visitas y recordatorios', tab: 'tab-agenda', color: '#F59E0B', icon: 'fas fa-calendar', keys: ['agenda', 'visita', 'calendario'] },
        { name: 'Tasaciones', sub: 'Valoraciones de inmuebles', tab: 'tab-tasaciones', color: '#EF4444', icon: 'fas fa-calculator', keys: ['tasacion', 'tasar'] },
        { name: 'Agentes & Brokers', sub: 'Equipo comercial', tab: 'tab-agentes', color: '#10B981', icon: 'fas fa-id-badge', keys: ['agente', 'broker', 'equipo'] },
        { name: 'Chat Redes Sociales', sub: 'Conversaciones entrantes', tab: 'tab-chat-redes', color: '#06B6D4', icon: 'fas fa-comments', keys: ['chat', 'mensaje', 'zernio', 'whatsapp', 'redes'] },
        { name: 'Sitio Web (CMS)', sub: 'Contenido del sitio público', tab: 'tab-sitio-web', color: '#8B5CF6', icon: 'fas fa-globe', keys: ['sitio', 'web', 'cms', 'contenido'] },
        { name: 'Portales', sub: 'Mercado Libre y RELA', tab: 'tab-portales', color: '#FACC15', icon: 'fas fa-store', keys: ['portal', 'mercado', 'rela'] },
        { name: 'Usuarios', sub: 'Roles y permisos', tab: 'tab-usuarios', color: '#8B5CF6', icon: 'fas fa-user-shield', keys: ['usuario', 'rol', 'permiso'] },
        { name: 'Configuración', sub: 'Integraciones y ajustes', tab: 'tab-configuracion', color: 'var(--text-dim)', icon: 'fas fa-cog', keys: ['config', 'ajuste', 'integracion'] },
      ];
      MODULE_HITS.forEach((m) => {
        if (m.keys.some((k) => gsNorm(k).startsWith(q) || (q.length >= 3 && gsNorm(k).includes(q)))) {
          results.push({ icon: m.icon, text: 'Módulo: ' + m.name, sub: m.sub, tab: m.tab, color: m.color, action: () => navigateTo(m.tab) });
        }
      });

      const matches = (fields) => fields.some(f => f && gsNorm(f).includes(q));

      for (const p of cache.properties) {
        if (!matches([p.title, p.zone, p.address, p.property_code])) continue;
        results.push({ icon: 'fas fa-home', text: p.title || 'Sin título', sub: [p.zone, p.address].filter(Boolean).join(', '), tab: 'tab-propiedades', color: 'var(--accent)', action: () => { navigateTo('tab-propiedades'); window.adminApp.editProperty(p.id); } });
      }
      for (const l of cache.leads) {
        if (!matches([l.full_name, l.email, l.phone])) continue;
        results.push({ icon: 'fas fa-user', text: l.full_name || 'Sin nombre', sub: l.email || l.phone || '', tab: 'tab-leads', color: '#3B82F6', action: () => { navigateTo('tab-leads'); window.adminApp.editLead(l.id); } });
      }
      for (const a of cache.agents) {
        if (!matches([a.full_name, a.email, a.matricula])) continue;
        results.push({ icon: 'fas fa-id-badge', text: a.full_name || 'Sin nombre', sub: a.matricula || a.email || '', tab: 'tab-agentes', color: '#10B981', action: () => { navigateTo('tab-agentes'); window.adminApp.editAgent(a.id); } });
      }
      for (const o of cache.owners) {
        if (!matches([o.full_name, o.email, o.phone])) continue;
        results.push({ icon: 'fas fa-user-tie', text: o.full_name || 'Sin nombre', sub: o.email || o.phone || '', tab: 'tab-propietarios', color: '#F97316', action: () => { navigateTo('tab-propietarios'); window.adminApp.editOwner(o.id); } });
      }
      for (const v of cache.visits) {
        if (!matches([v.client_name, v.client_phone])) continue;
        results.push({ icon: 'fas fa-calendar-check', text: v.client_name || 'Sin cliente', sub: [v.visit_date ? new Date(v.visit_date).toLocaleDateString('es-AR') : '', v.status].filter(Boolean).join(' · '), tab: 'tab-agenda', color: '#F59E0B', action: () => { navigateTo('tab-agenda'); window.adminApp.editVisit(v.id); } });
      }
      for (const t of cache.tasaciones) {
        if (!matches([t.title])) continue;
        results.push({ icon: 'fas fa-chart-line', text: t.title || 'Sin título', sub: t.status === 'finalized' ? 'Finalizada' : 'Borrador', tab: 'tab-tasaciones', color: '#EF4444', action: () => { navigateTo('tab-tasaciones'); window.navigateToTasacion(t.id, t.title || ''); } });
      }
      for (const u of cache.profiles) {
        if (!matches([u.full_name, u.email, u.role])) continue;
        results.push({ icon: 'fas fa-user-shield', text: u.full_name || u.email || 'Sin nombre', sub: [u.email, USER_ROLE_LABELS[u.role] || u.role].filter(Boolean).join(' · '), tab: 'tab-usuarios', color: '#8B5CF6', action: () => navigateTo('tab-usuarios') });
      }
      for (const c of cache.conversations) {
        if (!matches([c.contact_name, c.contact_handle, c.last_message_preview])) continue;
        results.push({ icon: 'fas fa-comments', text: c.contact_name || c.contact_handle || 'Sin contacto', sub: c.last_message_preview || '', tab: 'tab-chat-redes', color: '#06B6D4', action: () => { navigateTo('tab-chat-redes'); setTimeout(() => window.adminApp.openChatConversation?.(c.id), 400); } });
      }

      if (!results.length) {
        resultsContainer.innerHTML = '<div class="gs-empty">Sin resultados para "' + esc(q) + '"</div>';
        resultsContainer.style.display = 'block';
        _gsActiveIndex = -1;
        return;
      }

      _gsActions = results.map((r) => (typeof r.action === 'function' ? r.action : null));

      resultsContainer.innerHTML = results.slice(0, SEARCH_RESULT_LIMIT).map((r, i) => `
        <div class="gs-result${i === 0 ? ' is-active' : ''}" data-index="${i}" data-tab="${esc(r.tab)}" style="display:flex; align-items:center; gap:10px; padding:10px 14px; cursor:pointer; border-bottom:1px solid var(--border-subtle); transition:background 0.15s;">
          <i class="${esc(r.icon)}" style="font-size:14px; color:${r.color}; min-width:18px; text-align:center;"></i>
          <div style="flex:1; min-width:0;">
            <div style="color:#fff; font-size:13px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${gsHighlight(r.text, q)}</div>
            <div style="color:var(--text-dim); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${gsHighlight(r.sub, q)}</div>
          </div>
        </div>
      `).join('');
      resultsContainer.style.display = 'block';
      _gsActiveIndex = 0;
    }

    $('#globalSearchInput')?.addEventListener('keydown', (e) => {
      const container = $('#globalSearchResults');
      if (!container || container.style.display !== 'block') return;

      if (e.key === 'Escape') {
        container.style.display = 'none';
        _gsActiveIndex = -1;
        e.target.value = '';
        return;
      }

      const items = $$('.gs-result', container);
      if (!items.length) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        _gsActiveIndex = e.key === 'ArrowDown'
          ? Math.min(_gsActiveIndex + 1, items.length - 1)
          : Math.max(_gsActiveIndex - 1, 0);
        items.forEach((el, i) => el.classList.toggle('is-active', i === _gsActiveIndex));
        items[_gsActiveIndex]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        items[Math.max(_gsActiveIndex, 0)]?.click();
      }
    });

    document.addEventListener('click', (e) => {
      const results = $('#globalSearchResults');
      const input = $('#globalSearchInput');
      if (results && !results.contains(e.target) && e.target !== input) {
        results.style.display = 'none';
      }
    });

    /* Security: resultados de busqueda sin handlers inline (CSP-safe) */
    (() => {
      const gsResults = $('#globalSearchResults');
      if (!gsResults) return;
      gsResults.addEventListener('click', (e) => {
        const item = e.target.closest('.gs-result');
        if (!item) return;
        const idx = parseInt(item.dataset.index, 10);
        const action = Number.isInteger(idx) ? _gsActions[idx] : null;
        if (typeof action === 'function') action();
        else if (item.dataset.tab) navigateTo(item.dataset.tab);
        gsResults.style.display = 'none';
        _gsActiveIndex = -1;
        const input = $('#globalSearchInput');
        if (input) input.value = '';
      });
      gsResults.addEventListener('mouseover', (e) => {
        const item = e.target.closest('.gs-result');
        if (item) item.style.background = 'rgba(255,255,255,0.04)';
      });
      gsResults.addEventListener('mouseout', (e) => {
        const item = e.target.closest('.gs-result');
        if (item) item.style.background = '';
      });

    /* ------------------------------------------------
       FIX: Robust navigation event listeners + Ficha HTML loader
       ------------------------------------------------ */
    (function attachNavListeners() {
      $$('.nav-item[data-tab]').forEach(item => {
        if (!item.dataset.bhNavBound) {
          item.dataset.bhNavBound = 'true';
          item.addEventListener('click', () => navigateTo(item.dataset.tab));
        }
      });
      if ($('#tab-ficha-html')) {
        window.loadFichaHtml = async function() {
          if (!window.supabaseClient) return;
          try {
            const [propsRes, agentsRes] = await Promise.all([
        window.supabaseClient.from('properties').select('id, title, property_code, zone, address, price_usd, rooms, area_m2, description, image_urls, agent_id').is('deleted_at', null).order('created_at', { ascending: false }),
window.supabaseClient.from('agents').select('id, full_name, phone, email').eq('status', 'activo').is('deleted_at', null)
            ]);
            if (propsRes.error) throw propsRes.error;
            if (agentsRes.error) throw agentsRes.error;
            window._fichaPropsCache = propsRes.data || [];
            window._fichaAgentsCache = agentsRes.data || [];
            window.startFichaFooterRotator();
            console.log('[Ficha HTML] CRM data loaded:', window._fichaPropsCache.length, 'properties');
          } catch (err) {
            logError('Ficha HTML load error:', err);
            window.showToast?.('No se pudieron cargar los datos de la ficha', 'error');
          }
        };
      }
    })();
    })();

    initNotifications();
    setInterval(() => { if (currentUser) loadNotifications(); }, 90000);

    initAuth();
    initCursorGlow();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
  } else {
    startApp(); // DOM already ready
  }
})
();

// ============================================================
// EJECUTIVO DASHBOARD FUNCTIONS
// ============================================================
(async function() {
'use strict';

// DOM helpers for this IIFE
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

// Executive Dashboard State
let _execFromDate = '';
let _execToDate = '';

  // Load Executive Dashboard
  window.loadExecutiveDashboard = async function() {
    const currentUser = window._bhCurrentUser;
    const currentProfile = window._bhCurrentProfile;
    if (!currentUser || !window.supabaseClient) return;
    if (currentProfile?.role !== 'super_admin') return;

    _execFromDate = $('#execFromDate').value || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    _execToDate = $('#execToDate').value || new Date().toISOString().split('T')[0];

    await Promise.all([
      loadExecKPIs(),
      loadExecTrendChart(),
      loadExecTopOpps(),
      loadExecStrategicAlerts(),
      loadExecMonthlyTable()
    ]);
  };

  async function loadExecKPIs() {
    if (!window.supabaseClient) return;
    try {
      const fromDate = new Date(_execFromDate).toISOString();
      const toDate = new Date(new Date(_execToDate).getTime() + 24 * 60 * 60 * 1000).toISOString();

      // Parallel queries for all KPIs
      const [
        leadsRes,
        visitsRes,
        closedRes,
        propertiesRes,
        auditRes,
        brokerRes
      ] = await Promise.all([
        window.supabaseClient.from('leads').select('id, stage, created_at, budget_usd').gte('created_at', _execFromDate).lte('created_at', _execToDate),
        window.supabaseClient.from('visits').select('id, visit_date, lead_id').gte('visit_date', _execFromDate).lte('visit_date', _execToDate),
        window.supabaseClient.from('leads').select('id, stage, created_at, budget_usd').eq('stage', 'cerrado_ganado').gte('updated_at', _execFromDate).lte('updated_at', _execToDate),
        window.supabaseClient.from('properties').select('price_usd, price_currency, status, is_published').eq('is_published', true).neq('status', 'vendido'),
        window.supabaseClient.from('audit_log').select('user_id, action, status, created_at, metadata').gte('created_at', new Date(_execFromDate).toISOString()).lte('created_at', new Date(_execToDate).toISOString()),
        window.supabaseClient.from('agents').select('id, full_name, sales_ytd').eq('status', 'activo').is('deleted_at', null)
      ]);

      const leads = leadsRes.data || [];
      const visits = visitsRes.data || [];
      const closed = closedRes.data || [];
      const properties = propertiesRes.data || [];
      const audit = auditRes.data || [];
      const brokers = brokerRes.data || [];

      // KPI: Conversión Lead→Cierre
      const totalLeads = leads.length;
      const totalClosed = closed.length;
      const convRate = totalLeads > 0 ? ((totalClosed / totalLeads) * 100).toFixed(1) : 0;
      setKPI('execConvRate', convRate + '%');

      // KPI: Tiempo medio cierre
      if (closed.length > 0) {
        const closeTimes = closed.map(l => {
          const created = new Date(l.created_at).getTime();
          const closedAt = new Date(l.updated_at).getTime();
          return (closedAt - created) / (1000 * 60 * 60 * 24);
        });
        const avgClose = (closeTimes.reduce((a, b) => a + b, 0) / closeTimes.length).toFixed(1);
        setKPI('execAvgCloseTime', avgClose + ' días');
      } else {
        setKPI('execAvgCloseTime', '—');
      }

      const _execPropsVenta = properties.filter(p => p.status === 'venta' || (!p.status && (p.price_currency || 'USD') === 'USD'));
      const _execPropsAlquiler = properties.filter(p => p.status === 'alquiler' || p.price_currency === 'ARS');
      const _execVenta = _execPropsVenta.reduce((s, p) => s + (p.price_usd || 0), 0);
      const _execAlquiler = _execPropsAlquiler.reduce((s, p) => s + (p.price_usd || 0), 0);
      setKPI('execPortfolioVenta', formatPrice(_execVenta, 'USD'));
      setKPI('execPortfolioAlquiler', formatPrice(_execAlquiler, 'ARS'));

      // KPI: ROI Marketing (leads por USD invertido - estimado)
      const marketingSpend = 10000; // USD estimado mensual
      const leadsPerDollar = marketingSpend > 0 ? (totalLeads / marketingSpend).toFixed(2) : 0;
      setKPI('execMarketingROI', leadsPerDollar + ' leads/USD');

      // KPI: Productividad Brokers
      const activeBrokers = brokers.filter(b => b.sales_ytd && b.sales_ytd > 0).length;
      const totalSales = brokers.reduce((sum, b) => sum + (b.sales_ytd || 0), 0);
      const prodPerBroker = activeBrokers > 0 ? (totalSales / activeBrokers).toFixed(0) : 0;
      setKPI('execBrokerProd', '$' + parseInt(prodPerBroker).toLocaleString('es-AR'));

      // KPI: SLA Respuesta
      const newLeads = leads.filter(l => l.stage === 'nuevo').length;
      const contactedLeads = leads.filter(l => ['contactado', 'calificado', 'visita_agendada', 'visita_realizada', 'negociacion', 'cerrado_ganado'].includes(l.stage)).length;
      const slaRate = totalLeads > 0 ? ((contactedLeads / totalLeads) * 100).toFixed(1) : 0;
      setKPI('execSLAResponse', slaRate + '%');

      // Update sidebar badges
      updateSidebarBadges();
    } catch (err) {
      logError('loadExecKPIs error:', err);
    }
  }

  async function loadExecTrendChart() {
    if (!window.supabaseClient) return;
    const container = $('#execTrendChart');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:40px;">Cargando tendencia...</p>';

    try {
      const fromDate = new Date(_execFromDate).toISOString();
      const toDate = new Date(new Date(_execToDate).getTime() + 24 * 60 * 60 * 1000).toISOString();

      const [leadsRes, visitsRes, closedRes] = await Promise.all([
        window.supabaseClient.from('leads').select('created_at').gte('created_at', new Date(_execFromDate).toISOString()).lte('created_at', _execToDate),
        window.supabaseClient.from('visits').select('visit_date').gte('visit_date', new Date(_execFromDate).toISOString()).lte('visit_date', new Date(_execToDate).toISOString()),
        window.supabaseClient.from('leads').select('updated_at').eq('stage', 'cerrado_ganado').gte('updated_at', new Date(_execFromDate).toISOString()).lte('updated_at', new Date(_execToDate).toISOString())
      ]);

      const leads = leadsRes.data || [];
      const visits = visitsRes.data || [];
      const closed = closedRes.data || [];

      // Group by month for last 12 months
      const months = [];
      const now = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push({
          key: d.toISOString().slice(0, 7),
          label: d.toLocaleDateString('es-AR', { month: 'short', year: '2-digit' })
        });
      }

      const trendData = months.map(m => {
        const start = new Date(m.key + '-01').toISOString();
        const end = new Date(new Date(m.key + '-01').getFullYear(), new Date(m.key + '-01').getMonth() + 1, 1).toISOString();
        return {
          month: m.label,
          leads: leads.filter(l => l.created_at >= start && l.created_at < end).length,
          visits: visits.filter(v => v.visit_date >= start && v.visit_date < end).length,
          closed: closed.filter(c => c.updated_at >= start && c.updated_at < end).length
        };
      });

      const maxVal = Math.max(...trendData.map(d => d.leads), ...trendData.map(d => d.visits), ...trendData.map(d => d.closed), 1);
      const container = $('#execTrendChart');
      if (!container) return;

      container.innerHTML = `
        <div style="display:flex; align-items:end; justify-content:space-between; height:180px; gap:4px; padding:0 8px;">
          ${trendData.map(d => `
            <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:4px; min-width:30px;">
              <div style="height:${(d.leads / maxVal) * 160}px; width:100%; background:var(--accent); border-radius:2px 2px 0 0; transition:height 0.3s;" title="Leads: ${d.leads}"></div>
              <div style="height:${(d.visits / maxVal) * 160}px; width:100%; background:#3B82F6; border-radius:2px 2px 0 0; transition:height 0.3s;" title="Visitas: ${d.visits}"></div>
              <div style="height:${(d.closed / maxVal) * 160}px; width:100%; background:var(--success); border-radius:2px 2px 0 0; transition:height 0.3s;" title="Cierres: ${d.closed}"></div>
              <div style="font-size:9px; color:var(--text-dim); white-space:nowrap;">${d.month}</div>
            </div>
          `).join('')}
        </div>
        <div class="chart-legend" style="display:flex; justify-content:center; gap:16px; margin-top:12px; font-size:11px;">
          <span><i style="background:var(--accent); width:10px; height:10px; display:inline-block; margin-right:4px; border-radius:2px;"></i>Leads</span>
          <span><i style="background:#3B82F6; width:10px; height:10px; display:inline-block; margin-right:4px; border-radius:2px;"></i>Visitas</span>
          <span><i style="background:var(--success); width:10px; height:10px; display:inline-block; margin-right:4px; border-radius:2px;"></i>Cierres</span>
        </div>
      `;
    } catch (err) {
      logError('loadExecTrendChart error:', err);
      const container = $('#execTrendChart');
      if (container) container.innerHTML = '<p style="color:var(--danger); text-align:center; padding:40px;">Error cargando tendencia</p>';
    }
  }

  async function loadExecTopOpps() {
    if (!window.supabaseClient) return;
    const container = $('#execTopOpps');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--text-dim); text-align:center; padding:20px;">Cargando...</p>';

    try {
      // Get top properties by value that are not sold
      const { data: props } = await window.supabaseClient
        .from('properties')
        .select('id, title, price_usd, zone, status, created_at')
        .eq('is_published', true)
        .neq('status', 'vendido')
        .neq('status', 'alquilado')
        .order('price_usd', { ascending: false })
        .limit(10);

      const { data: leads } = await window.supabaseClient
        .from('leads')
        .select('id, full_name, budget_usd, property_id, stage, created_at')
        .in('stage', ['visita_agendada', 'visita_realizada', 'negociacion'])
        .order('budget_usd', { ascending: false })
        .limit(10);

      let html = '<div style="display:flex; flex-direction:column; gap:12px;">';
      
      if (props && props.length) {
        html += '<div style="margin-bottom:16px;"><strong style="color:var(--accent);">Propiedades Top</strong></div>';
        props.forEach((p, i) => {
          html += `<div style="padding:10px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px; display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-weight:600; color:#fff;">${i + 1}. ${p.title || 'Sin título'}</div>
              <div style="font-size:11px; color:var(--text-dim);">${p.zone || 'Sin zona'} • ${p.status}</div>
            </div>
            <div style="color:var(--accent); font-weight:700;">${formatPrice(p.price_usd, p.price_currency)}</div>
          </div>`;
        });
      }

      if (leads && leads.length) {
        html += '<div style="margin-top:16px;"><strong style="color:var(--accent);">Leads Calientes</strong></div>';
        leads.forEach((l, i) => {
          html += `<div style="padding:10px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px; display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-weight:600; color:#fff;">${i + 1}. ${esc(l.full_name || 'Sin nombre')}</div>
              <div style="font-size:11px; color:var(--text-dim);">${esc(l.stage)} • ${l.property_id ? 'Con propiedad' : 'Sin propiedad'}</div>
            </div>
            <div style="color:#F59E0B; font-weight:700;">${l.budget_usd ? 'USD ' + l.budget_usd.toLocaleString('es-AR') : 'Sin presupuesto'}</div>
          </div>`;
        });
      }

      if (!props.length && !leads.length) {
        html = '<p style="color:var(--text-dim); text-align:center; padding:20px;">Sin oportunidades destacadas</p>';
      }

      html += '</div>';
      const container = $('#execTopOpps');
      if (container) container.innerHTML = html;
    } catch (err) {
      logError('loadExecTopOpps error:', err);
      const container = $('#execTopOpps');
      if (container) container.innerHTML = '<p style="color:var(--danger); text-align:center; padding:20px;">Error cargando oportunidades</p>';
    }
  }

  async function loadExecStrategicAlerts() {
    if (!window.supabaseClient) return;
    const container = $('#execStrategicAlerts');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--text-dim); text-align:center; padding:20px;">Cargando...</p>';

    try {
      const [alertsRes, anomaliesRes, auditRes] = await Promise.all([
        window.supabaseClient.from('supervision_alerts').select('*').eq('status', 'open').in('severity', ['critical', 'high']).order('created_at', { ascending: false }).limit(5),
        window.supabaseClient.from('supervision_anomalies').select('*').eq('status', 'open').in('severity', ['critical', 'high']).order('created_at', { ascending: false }).limit(5),
        window.supabaseClient.from('audit_log').select('*').eq('status', 'critical').gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).order('created_at', { ascending: false }).limit(5)
      ]);

      const alerts = alertsRes.data || [];
      const anomalies = anomaliesRes.data || [];
      const criticalAudit = auditRes.data || [];

      let html = '<div style="display:flex; flex-direction:column; gap:12px;">';

      if (alerts.length) {
        html += '<div><strong style="color:#EF4444;">?? Alertas Críticas/Alta</strong></div>';
        alerts.forEach(a => {
          html += `<div style="padding:10px; background:rgba(239,68,68,0.1); border:1px solid #EF4444; border-radius:8px;">
            <div style="font-weight:600; color:#EF4444;">${a.title || a.rule_name || a.alert_type}</div>
            <div style="font-size:11px; color:var(--text-dim);">${a.module} • ${a.user_name || a.user_id} • ${new Date(a.created_at).toLocaleString('es-AR')}</div>
          </div>`;
        });
      }

      if (anomalies.length) {
        html += '<div style="margin-top:8px;"><strong style="color:#F97316;">?? Anomalías Detectadas</strong></div>';
        anomalies.forEach(a => {
          html += `<div style="padding:10px; background:rgba(249,115,22,0.1); border:1px solid #F97316; border-radius:8px;">
            <div style="font-weight:600; color:#F97316;">${a.module} • ${a.action} (${a.metric})</div>
            <div style="font-size:11px; color:var(--text-dim);">Valor: ${a.observed_value} vs Esperado: ${a.expected_mean} • Z-Score: ${a.z_score?.toFixed(2) || 'N/A'} • Percentil: ${a.percentile_rank}%</div>
          </div>`;
        });
      }

      if (criticalAudit.length) {
        html += '<div style="margin-top:8px;"><strong style="color:#EF4444;">?? Eventos Críticos (24h)</strong></div>';
        criticalAudit.forEach(a => {
          html += `<div style="padding:10px; background:rgba(239,68,68,0.1); border:1px solid #EF4444; border-radius:8px;">
            <div style="font-weight:600; color:#EF4444;">${a.action} en ${a.module}</div>
            <div style="font-size:11px; color:var(--text-dim);">${a.user_id} • ${new Date(a.created_at).toLocaleString('es-AR')}</div>
          </div>`;
        });
      }

      if (!alerts.length && !anomalies.length && !criticalAudit.length) {
        html = '<p style="color:var(--success); text-align:center; padding:20px;"><i class="fas fa-check-circle"></i> Sin alertas estratégicas activas</p>';
      }

      html += '</div>';
      const container = $('#execStrategicAlerts');
      if (container) container.innerHTML = html;
    } catch (err) {
      logError('loadExecStrategicAlerts error:', err);
      const container = $('#execStrategicAlerts');
      if (container) container.innerHTML = '<p style="color:var(--danger); text-align:center; padding:20px;">Error cargando alertas</p>';
    }
  }

  async function loadExecMonthlyTable() {
    if (!window.supabaseClient) return;
    const tbody = $('#execMonthlyTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" style="padding:40px; text-align:center; color:var(--text-dim);">Cargando...</td></tr>';

    try {
      const now = new Date();
      const months = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push({
          key: d.toISOString().slice(0, 7),
          label: d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })
        });
      }

      const [leadsRes, visitsRes, closedRes, propsRes] = await Promise.all([
        window.supabaseClient.from('leads').select('created_at, budget_usd, stage').gte('created_at', new Date(now.getFullYear(), now.getMonth() - 11, 1).toISOString()),
        window.supabaseClient.from('visits').select('visit_date').gte('visit_date', new Date(now.getFullYear(), now.getMonth() - 11, 1).toISOString()),
        window.supabaseClient.from('leads').select('updated_at, budget_usd').eq('stage', 'cerrado_ganado').gte('updated_at', new Date(now.getFullYear(), now.getMonth() - 11, 1).toISOString()),
        window.supabaseClient.from('properties').select('created_at, price_usd, status').eq('is_published', true).gte('created_at', new Date(now.getFullYear(), now.getMonth() - 11, 1).toISOString())
      ]);

      const leads = leadsRes.data || [];
      const visits = visitsRes.data || [];
      const closed = closedRes.data || [];
      const props = propsRes.data || [];

      const rows = months.map(m => {
        const start = new Date(m.key + '-01').toISOString();
        const end = new Date(new Date(m.key + '-01').getFullYear(), new Date(m.key + '-01').getMonth() + 1, 1).toISOString();

        const mLeads = leads.filter(l => l.created_at >= start && l.created_at < end);
        const mVisits = visits.filter(v => v.visit_date >= start && v.visit_date < end);
        const mClosed = closed.filter(c => c.updated_at >= start && c.updated_at < end);
        const mProps = props.filter(p => p.created_at >= start && p.created_at < end);

        const totalValue = mClosed.reduce((sum, c) => sum + (c.budget_usd || 0), 0);
        const convRate = mLeads.length > 0 ? ((mClosed.length / mLeads.length) * 100).toFixed(1) : 0;
        const avgCloseTime = mClosed.length > 0 ? 
          (mClosed.reduce((sum, c) => sum + (new Date(c.updated_at).getTime() - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24), 0) / mClosed.length).toFixed(1) : 0;
        const avgTicket = mClosed.length > 0 ? (totalValue / mClosed.length).toFixed(0) : 0;

        return `<tr style="border-bottom:1px solid var(--border-subtle);">
          <td style="padding:10px 16px; color:#fff; font-weight:500;">${m.label}</td>
          <td style="padding:10px 16px; text-align:right; color:var(--accent);">${mLeads.length}</td>
          <td style="padding:10px 16px; text-align:right; color:#3B82F6;">${mVisits.length}</td>
          <td style="padding:10px 16px; text-align:right; color:var(--success); font-weight:600;">${mClosed.length}</td>
          <td style="padding:10px 16px; text-align:right; color:var(--accent); font-weight:600;">USD ${totalValue.toLocaleString('es-AR')}</td>
          <td style="padding:10px 16px; text-align:right; color:#F59E0B;">${convRate}%</td>
          <td style="padding:10px 16px; text-align:right; color:#8B5CF6;">${avgCloseTime} días</td>
          <td style="padding:10px 16px; text-align:right; color:#F59E0B;">USD ${parseInt(avgTicket).toLocaleString('es-AR')}</td>
        </tr>`;
      }).join('');

      const tbody = $('#execMonthlyTableBody');
      if (tbody) tbody.innerHTML = rows;
    } catch (err) {
      logError('loadExecMonthlyTable error:', err);
      const tbody = $('#execMonthlyTableBody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="padding:40px; text-align:center; color:var(--danger);">Error cargando tabla mensual</td></tr>';
    }
  }

  // Event listeners for executive dashboard
  $('#execRefreshBtn')?.addEventListener('click', () => loadExecutiveDashboard());
  $('#execExportBtn')?.addEventListener('click', exportExecCSV);
  $('#execFromDate')?.addEventListener('change', () => loadExecutiveDashboard());
  $('#execToDate')?.addEventListener('change', () => loadExecutiveDashboard());

  function exportExecCSV() {
    if (!window.supabaseClient) return;
    // Export executive KPIs
    const kpis = {};
    ['execConvRate', 'execAvgCloseTime', 'execPortfolioVenta', 'execPortfolioAlquiler', 'execMarketingROI', 'execBrokerProd', 'execSLAResponse'].forEach(id => {
      const el = $('#' + id);
      if (el) kpis[id] = el.textContent;
    });
    const headers = ['KPI', 'Valor'];
    const rows = Object.entries(kpis).map(([k, v]) => [k, v]);
    const date = new Date().toISOString().slice(0, 10);
    downloadCSV('ejecutivo-kpis-' + date + '.csv', rows, headers);
    showToast('KPIs ejecutivos exportados', 'success');
  }

  // FASE 1.1: delega clicks de los botones migrados a data-action (CSP-safe)
  // vía window[action]; exportSupOverviewCSV se expone en la IIFE principal.
  window.closeCdnWarning = function () {
    const bannerEl = document.getElementById('cdnWarningBanner');
    if (bannerEl) bannerEl.style.display = 'none';
  };

  window.createOwnerTask = function () {

    window.adminApp.createOwnerTask();

  };

  const dataActionWhitelist = ['exportPropertiesCSV', 'exportLeadsCSV', 'exportTasacionesCSV', 'exportSupOverviewCSV', 'exportSupAlertsCSV', 'exportSupUsersCSV', 'exportSupModulesCSV', 'loadMoreSupAudit', 'loadMoreSupAlerts', 'closeSupUserDetail', 'loadMoreAnomalies', 'closeSupAuditDetail', 'simulateSupRule', 'closeCdnWarning', 'createOwnerTask', 'backToSupTeam', 'refreshSupTeam', 'refreshSupEmployee', 'loadMoreEmployeeActivity'];
  document.addEventListener('click', function (ev) {
    const target = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (dataActionWhitelist.indexOf(action) === -1) return; // no pisa los quick-action chips (ya bindeados en la sección 16)
    const fn = window[action];
    if (typeof fn === 'function') {
      if (target.tagName === 'A') ev.preventDefault();
      fn.call(target);
    }
  });
})();



