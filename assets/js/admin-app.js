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
      'tab-propiedades': loadProperties,
      'tab-leads': loadCRM,
      'tab-agenda': loadAgenda,
      'tab-tasaciones': loadTasaciones,
      'tab-sitio-web': loadCMS,
      'tab-chat-redes': loadChatRedes,
      'tab-agentes': loadAgents,
      'tab-propietarios': loadOwners,
      'tab-usuarios': loadUsers,
      'tab-portales': loadPortals,
      'tab-ficha-html': loadFichaHtml,
      'tab-supervision': loadSupervision,
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

  /* ------------------------------------------------
     5. PROPERTIES CRUD
     ------------------------------------------------ */
  async function loadProperties() {
    invalidateSearchCache();
    const tbody = $('#propertiesTableBody');
    const pageInfo = $('#propPageInfo');
    const pagePrev = $('#propPagePrev');
    const pageNext = $('#propPageNext');
    const pageSize = $('#propPageSize');
    if (!tbody) return;
    const client = await getAuthedClient();
    if (!client) return;

    try {
      const applyPropFilters = (q) => {
        let query = q;
        if (_propViewTrash) query = query.not('deleted_at', 'is', null);
        else query = query.is('deleted_at', null);
        if (_propStatusFilter) query = query.eq('status', _propStatusFilter);
        if (_propPubFilter === 'published') query = query.eq('is_published', true);
        else if (_propPubFilter === 'draft') query = query.eq('is_published', false);
        if (_propAgentFilter) query = query.eq('agent_id', _propAgentFilter);
        if (_propSearchQuery) {
          const safe = _propSearchQuery.replace(/[%_,()]/g, ' ');
          query = query.or(`title.ilike.%${safe}%,zone.ilike.%${safe}%,address.ilike.%${safe}%,property_code.ilike.%${safe}%,locality.ilike.%${safe}%`);
        }
        return query;
      };

      const { count: totalCount, error: countError } = await applyPropFilters(
        client.from('properties').select('*', { count: 'exact', head: true })
      );
      if (countError) throw countError;
      _propTotalCount = totalCount || 0;

      const from = (_propPage - 1) * _propPageSize;
      const to = from + _propPageSize - 1;

      const [, trashRes] = await Promise.all([
        Promise.resolve(null),
        client.from('properties').select('id', { count: 'exact', head: true }).not('deleted_at', 'is', null)
      ]);
      _propTrashCount = trashRes.count || 0;
      const trashBtn = $('#propTrashToggle');
      if (trashBtn) {
        trashBtn.innerHTML = '<i class="fas fa-trash-can"></i> Papelera' + (_propTrashCount ? ' (' + _propTrashCount + ')' : '');
        trashBtn.classList.toggle('is-active', _propViewTrash);
      }

      const [propsRes, listingsRes, ownersRes, relaRes] = await Promise.all([
        applyPropFilters(client.from('properties').select('*')).order('created_at', { ascending: false }).range(from, to),
        ml_connected
          ? client.from('ml_listings').select('property_id, ml_listing_id:ml_item_id, status:ml_status')
          : Promise.resolve({ data: [] }),
        client.from('owners').select('id, full_name').is('deleted_at', null).order('full_name'),
        client.from('rela_listings').select('property_id, codigo_aviso, status, remote_status, last_error'),
      ]);

      const data = propsRes.data;
      const error = propsRes.error;
      if (error) throw error;

      const mlMap = {};
      (listingsRes.data || []).forEach(l => { if (l.property_id) mlMap[l.property_id] = l; });

      const relaMap = {};
      (relaRes.data || []).forEach(l => { if (l.property_id) relaMap[l.property_id] = l; });

      const ownerMap = {};
      (ownersRes.data || []).forEach(o => { ownerMap[o.id] = o.full_name; });

      const ownerSelect = $('#propOwnerSelect');
      if (ownerSelect) {
        const currentVal = ownerSelect.value;
        ownerSelect.innerHTML = '<option value="">Sin propietario asignado</option>' +
          (ownersRes.data || []).map(o => `<option value="${esc(o.id)}">${esc(o.full_name)}</option>`).join('');
        if (currentVal) ownerSelect.value = currentVal;
      }

      // Update pagination UI
      const totalPages = Math.ceil(_propTotalCount / _propPageSize);
      if (pageInfo) pageInfo.textContent = `Página ${_propPage} de ${totalPages || 1}`;
      if (pagePrev) pagePrev.disabled = _propPage <= 1;
      if (pageNext) pageNext.disabled = _propPage >= totalPages;

      if (!data?.length) {
        const emptyMsg = _propViewTrash
          ? 'La papelera está vacía'
          : (_propSearchQuery || _propStatusFilter || _propPubFilter || _propAgentFilter)
            ? 'No hay propiedades que coincidan con los filtros'
            : 'No hay propiedades cargadas';
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:40px; color:var(--text-dim);">' + emptyMsg + '</td></tr>';
        const selectAll = $('#propSelectAll');
        if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
        updatePropBulkBar();
        return;
      }

      tbody.innerHTML = data.map(p => {
        const rawThumb = p.image_urls?.[0] || 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=200&q=60&fit=crop';
        const thumb = rawThumb.includes('res.cloudinary.com') && rawThumb.includes('/upload/')
          ? rawThumb.replace('/upload/', '/upload/w_200,h_200,c_fill,')
          : rawThumb;
        const loc = [p.zone, p.address].filter(Boolean).join(', ');
        const mlInfo = mlMap[p.id];
        let mlBadge = '';
        let mlButtons = '';

        if (mlInfo && mlInfo.status !== 'closed') {
          const mlStatusColor = mlInfo.status === 'active' ? 'var(--success)' : mlInfo.status === 'paused' ? 'var(--warning)' : 'var(--text-dim)';
          const mlStatusText = esc(mlInfo.status === 'active' ? 'En ML' : mlInfo.status === 'paused' ? 'Pausado' : mlInfo.status || 'ML');
          mlBadge = `<span class="nav-badge status-pill ${mlInfo.status === 'active' ? 'active' : 'paused'}" style="font-size:10px; margin-left:4px;">${mlStatusText}</span>`;
          /* Security: ml_listing_id es texto externo (API de ML): viaja en data-* + delegacion, NUNCA dentro de onclick */
          mlButtons = `
              <button class="btn-action" style="font-size:11px; color:#FFE600;" title="Actualizar en ML" data-ml-update-prop="${esc(p.id)}" data-ml-listing="${esc(mlInfo.ml_listing_id)}"><i class="fas fa-arrows-rotate"></i></button>
              <button class="btn-action danger" style="font-size:11px;" title="Quitar de ML" data-ml-remove data-ml-prop="${esc(p.id)}" data-ml-listing="${esc(mlInfo.ml_listing_id)}"><i class="fas fa-link-slash"></i></button>`;
        } else if (ml_connected) {
          mlButtons = `<button class="btn-action" style="font-size:11px; color:#FFE600;" title="Publicar en ML" data-ml-publish="${esc(p.id)}"><i class="fas fa-shopping-cart"></i></button>`;
        }

        const relaInfo = relaMap[p.id];
        let relaBadge = '';
        let relaButtons = '';
        if (relaInfo) {
          const relaColor = relaInfo.status === 'PUBLISHED' ? 'var(--success)' : relaInfo.status === 'ERROR' || relaInfo.status === 'BLOCKED' ? 'var(--danger)' : 'var(--warning)';
          const relaText = relaInfo.status === 'PUBLISHED' ? 'RELA' : relaInfo.status === 'ERROR' ? 'RELA Error' : relaInfo.status === 'BLOCKED' ? 'RELA Bloqueado' : 'RELA ' + relaInfo.status;
          relaBadge = `<span class="nav-badge" style="background:rgba(59,130,246,0.15); color:${relaColor}; font-size:10px; margin-left:4px;" title="${esc(relaInfo.last_error || relaInfo.remote_status || '')}">${esc(relaText)}</span>`;
          relaButtons = `
              <button class="btn-action" style="font-size:11px; color:#3B82F6;" title="Sincronizar RELA" data-rela-action="update" data-rela-prop="${esc(p.id)}"><i class="fas fa-arrows-rotate"></i></button>
              <button class="btn-action danger" style="font-size:11px;" title="Despublicar de RELA" data-rela-action="unpublish" data-rela-prop="${esc(p.id)}"><i class="fas fa-cloud-arrow-down"></i></button>`;
        } else {
          relaButtons = `<button class="btn-action" style="font-size:11px; color:#3B82F6;" title="Publicar en RELA (ZonaProp)" data-rela-action="publish" data-rela-prop="${esc(p.id)}"><i class="fas fa-cloud-arrow-up"></i></button>`;
        }

        const codeBadge = p.property_code
          ? `<span class="props-code">${esc(p.property_code)}</span>`
          : '<span style="color:var(--text-dim); font-size:11px;">—</span>';

        const stateBadges = [
          `<span class="props-badge" style="background:${p.is_published ? 'rgba(0,200,120,0.15)' : 'rgba(255,255,255,0.06)'}; color:${p.is_published ? 'var(--success)' : 'var(--text-dim)'};">${p.is_published ? 'Publicada' : 'Borrador'}</span>`,
          p.featured ? '<span class="props-badge" style="background:rgba(255,184,0,0.15); color:var(--warning);"><i class="fas fa-star"></i>Destacada</span>' : '',
          p.is_retasada ? '<span class="props-badge" style="background:rgba(139,92,246,0.15); color:#8b5cf6;"><i class="fas fa-tag"></i>Retasada</span>' : '',
          p.is_oportunidad ? '<span class="props-badge" style="background:rgba(239,68,68,0.15); color:#ef4444;"><i class="fas fa-bolt"></i>Oportunidad</span>' : '',
          p.is_shared ? '<span class="props-badge" style="background:rgba(6,182,212,0.15); color:#06b6d4;"><i class="fas fa-share-nodes"></i>Compartido</span>' : '',
          p.is_vendida ? '<span class="props-badge" style="background:rgba(75,85,99,0.18); color:#9ca3af;"><i class="fas fa-check-circle"></i>Vendida</span>' : '',
          p.is_reservada ? '<span class="props-badge" style="background:rgba(234,179,8,0.18); color:#ca8a04;"><i class="fas fa-lock"></i>Reservada</span>' : ''
        ].filter(Boolean).join('');

        return `
        <tr>
          <td><input type="checkbox" class="prop-row-check props-check" data-prop-id="${esc(p.id)}" ${_propSelected.has(p.id) ? 'checked' : ''} /></td>
          <td>${codeBadge}</td>
          <td>
            <div class="props-prop">
              <img class="props-thumb" src="${esc(thumb)}" alt="${esc(p.title || '')}" loading="lazy" />
              <div class="props-prop-body">
                <span class="props-title" title="${esc(p.title || '')}">${esc(p.title || 'Sin título')}${mlBadge}${relaBadge}</span>
                <span class="props-loc" title="${esc(loc)}"><i class="fas fa-location-dot"></i>${esc(loc || 'Sin ubicación')}</span>
              </div>
            </div>
          </td>
          <td class="props-num">${p.area_m2 ? p.area_m2 + ' m²' : '—'}</td>
          <td class="props-num">${p.rooms || '—'}</td>
          <td class="props-price">${formatPrice(p.price_usd, p.price_currency)}</td>
          <td><span class="props-badge" style="background:${p.status === 'venta' ? 'rgba(31,200,195,0.15)' : 'rgba(255,184,0,0.15)'}; color:${p.status === 'venta' ? 'var(--accent)' : 'var(--warning)'};">${esc(p.status || 'venta')}</span></td>
          <td><span class="props-owner${p.owner_id ? '' : ' is-empty'}" title="${esc(ownerMap[p.owner_id] || '')}">${esc(ownerMap[p.owner_id] || '—')}</span></td>
          <td><div class="props-state">${stateBadges}</div></td>
            <td data-col-actions>
            ${_propViewTrash ? `
            <div class="props-actions">
              <button class="btn-action" style="color:var(--success);" title="Restaurar propiedad" data-prop-act="restore" data-prop-id="${esc(p.id)}"><i class="fas fa-trash-arrow-up"></i></button>
              <button class="btn-action danger" title="Eliminar definitivamente (solo Super Admin; borra fotos y documentos)" data-prop-act="destroy" data-prop-id="${esc(p.id)}"><i class="fas fa-ban"></i></button>
            </div>` : `
            <div class="props-actions">
              ${mlButtons}
              ${relaButtons}
              ${p.is_published ? `<button class="btn-action" style="color:#25D366;" title="Compartir ficha por WhatsApp" data-wa-share="${esc(p.id)}" data-wa-code="${esc(p.property_code || '')}"><i class="fab fa-whatsapp"></i></button>` : ''}
              ${p.is_published && p.property_code ? `<a class="btn-action" title="Ver ficha pública" href="fichas/${encodeURIComponent(p.property_code)}.html" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i></a>` : ''}
              <button class="btn-action" title="Duplicar propiedad" data-prop-act="duplicate" data-prop-id="${esc(p.id)}"><i class="fas fa-copy"></i></button>
              <button class="btn-action" title="Editar" data-prop-act="edit" data-prop-id="${esc(p.id)}"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" title="Eliminar (va a la papelera)" data-prop-act="delete" data-prop-id="${esc(p.id)}"><i class="fas fa-trash"></i></button>
            </div>`}
          </td>
        </tr>`;
      }).join('');
} catch (err) {
      logError('Error loading properties:', err);
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:40px; color:var(--danger);">Error al cargar propiedades</td></tr>';
    }

      bindPropertyToolbar();
      loadPropAgentFilter();
      syncPropSelectAll();
      updatePropBulkBar();

    // Pagination controls — se registran una sola vez (fix: antes se duplicaban en cada carga)
    if (!_propPaginationBound) {
      _propPaginationBound = true;
      on(pagePrev, 'click', () => { if (_propPage > 1) { _propPage--; loadProperties(); } });
      on(pageNext, 'click', () => { const totalPages = Math.ceil(_propTotalCount / _propPageSize); if (_propPage < totalPages) { _propPage++; loadProperties(); } });
      on(pageSize, 'change', () => { _propPageSize = parseInt(pageSize.value); _propPage = 1; loadProperties(); });
    }

  } // end loadProperties

  /* Create button */
  on($('#btnNewProp'), 'click', () => {
    editingPropertyId = null;
    resetPropertyForm();
    loadAgentSelect($('#propAgentSelect'));
    openModal('propertyModal');
  });

  /* Topbar create button */
  on($('#topbarNewProp'), 'click', () => {
    editingPropertyId = null;
    resetPropertyForm();
    loadAgentSelect($('#propAgentSelect'));
    openModal('propertyModal');
  });

  function resetPropertyForm() {
    const form = $('#propertyForm');
    if (form) form.reset();
    const previews = $('#imagePreviewGrid');
    if (previews) previews.innerHTML = '';
    const codeInput = $('#propCode');
    if (codeInput) { codeInput.value = ''; codeInput.removeAttribute('readonly'); }
    const title = $('#propModalTitle');
    if (title) title.textContent = 'Nueva Propiedad';

    const docsSection = $('#propertyDocsSection');

    if (docsSection) docsSection.style.display = 'none';
    const histSection = $('#propertyHistorySection');
    if (histSection) histSection.style.display = 'none';
    const histList = $('#propertyHistoryList');
    if (histList) histList.innerHTML = '';
    const notesSection = $('#propertyNotesSection');
    if (notesSection) notesSection.style.display = 'block';
    const notesList = $('#propertyNotesList');
    if (notesList) notesList.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:16px;">Todavía no hay notas</p>';
    const noteInput = $('#propertyNoteInput');
    if (noteInput) noteInput.value = '';
    _pendingPropertyNotes = [];
    _newImageFiles = [];
  }

  /* Vista previa inmediata de las imágenes nuevas seleccionadas (antes de guardar) */
  let _newImageFiles = [];

  const PREVIEW_STAR_BASE = 'position:absolute; bottom:4px; right:4px; width:20px; height:20px; border-radius:50%; border:1px solid rgba(255,255,255,0.25); cursor:pointer; font-size:10px; display:flex; align-items:center; justify-content:center; color:#fff;';
  const PREVIEW_STAR_IDLE = 'rgba(0,0,0,0.55)';
  const PREVIEW_STAR_ACTIVE = 'rgba(250,204,21,0.92)';

  function refreshPreviewBadges() {
    const previews = $('#imagePreviewGrid');
    if (!previews) return;
    const items = previews.querySelectorAll('.image-preview-item');
    items.forEach((item, idx) => {
      let badge = item.querySelector('.preview-portada-badge');
      const star = item.querySelector('.preview-portada-btn');
      if (idx === 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'preview-portada-badge';
          badge.style.cssText = 'position:absolute; top:4px; left:4px; background:rgba(250,204,21,0.92); color:#1a1a1a; font-size:9px; font-weight:700; padding:1px 6px; border-radius:4px; pointer-events:none;';
          badge.textContent = 'PORTADA';
          item.appendChild(badge);
        }
        if (star) { star.style.background = PREVIEW_STAR_ACTIVE; star.style.color = '#1a1a1a'; }
      } else {
        if (badge) badge.remove();
        if (star) { star.style.background = PREVIEW_STAR_IDLE; star.style.color = '#fff'; }
      }
    });
  }

  function setPreviewAsPortada(item) {
    const previews = $('#imagePreviewGrid');
    if (!previews || !item || item.parentNode !== previews) return;
    if (previews.firstElementChild !== item) previews.insertBefore(item, previews.firstElementChild);
    refreshPreviewBadges();
  }

  function previewPortadaBtnHtml() {
    return '<button type="button" class="preview-portada-btn" title="Usar como foto de portada" style="' + PREVIEW_STAR_BASE + PREVIEW_STAR_IDLE + '"><i class="fas fa-star"></i></button>';
  }

  function initPreviewDnD() {
    const previews = $('#imagePreviewGrid');
    if (!previews || previews.dataset.dndBound) return;
    previews.dataset.dndBound = '1';
    let dragging = null;
    previews.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.image-preview-item');
      if (!item) return;
      dragging = item;
      e.dataTransfer.effectAllowed = 'move';
      item.style.opacity = '0.4';
    });
    previews.addEventListener('dragend', () => {
      if (dragging) dragging.style.opacity = '';
      dragging = null;
      refreshPreviewBadges();
    });
    previews.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragging) return;
      const target = e.target.closest('.image-preview-item');
      if (!target || target === dragging) return;
      const rect = target.getBoundingClientRect();
      const after = (e.clientX - rect.left) > rect.width / 2;
      target.parentNode.insertBefore(dragging, after ? target.nextSibling : target);
    });
    previews.addEventListener('drop', (e) => { e.preventDefault(); refreshPreviewBadges(); });
  }
  initPreviewDnD();

  on($('#propImageFilesInput'), 'change', (e) => {
    const previews = $('#imagePreviewGrid');
    if (!previews) return;

    previews.querySelectorAll('.image-preview-item[data-new-file]').forEach(el => el.remove());
    _newImageFiles = [];

    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
    files.forEach(file => {
      const objectUrl = URL.createObjectURL(file);
      _newImageFiles.push({ url: objectUrl, file });
      const item = document.createElement('div');
      item.className = 'image-preview-item';
      item.dataset.newFile = 'true';
      item.dataset.objUrl = objectUrl;
      item.draggable = true;
      item.style.cssText = 'position:relative; width:80px; height:80px; border-radius:8px; overflow:hidden; border:1px solid var(--accent); cursor:grab;';
      item.innerHTML = `
        <img src="${objectUrl}" alt="" style="width:100%; height:100%; object-fit:cover;" />
        <span style="position:absolute; bottom:0; left:0; right:0; background:rgba(31,200,195,0.85); color:#04121a; font-size:8px; font-weight:700; text-align:center; padding:1px 0; text-transform:uppercase; letter-spacing:0.5px;">Nueva</span>
        ${previewPortadaBtnHtml()}
        <button type="button" class="preview-remove" title="Quitar" style="position:absolute; top:4px; right:4px; width:20px; height:20px; border-radius:50%; background:rgba(0,0,0,0.7); color:#fff; border:none; cursor:pointer; font-size:10px; display:flex; align-items:center; justify-content:center;"><i class="fas fa-times"></i></button>
      `;
      previews.appendChild(item);
    });
    refreshPreviewBadges();
  });

  /* Save property */
  on($('#propertyForm'), 'submit', async (e) => {
    e.preventDefault();
    if (_submittingProperty) return;
    _submittingProperty = true;
    const btn = $('#propertySaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const formData = new FormData(e.target);
      
      // Zod validation
      const validated = validateForm(PropertySchema, formData);
      const { price_currency, price_ars: _formArs, ...rest } = validated;
      
      let priceUsd;
      if (price_currency === 'ARS' && validated.price_ars > 0) {
        priceUsd = validated.price_ars;
      } else {
        priceUsd = validated.price_usd;
      }
      
      if (!priceUsd || priceUsd <= 0) {
        throw new Error('El precio de la propiedad debe ser mayor a 0');
      }
      
      const data = {
        ...rest,
        price_usd: priceUsd,
        price_currency,
        area_m2: validated.surface_covered,
        owner_id: validated.owner_id || null,
        created_by: currentUser?.id || null,
      };
      if (!data.property_code) delete data.property_code;
      if (editingPropertyId) delete data.property_code;
      if (data.year_built == null) delete data.year_built;
      if (data.maintenance_fee == null) delete data.maintenance_fee;

      if (validated.is_vendida || validated.is_reservada) {
        data.is_published = false;
      }

      const previewItems = Array.from(document.querySelectorAll('#imagePreviewGrid .image-preview-item'));
      const orderedExistingUrls = [];
      const orderedNewFiles = [];
      previewItems.forEach(item => {
        if (item.dataset.newFile) {
          const entry = _newImageFiles.find(x => x.url === item.dataset.objUrl);
          if (entry) orderedNewFiles.push(entry.file);
        } else {
          const hidden = item.querySelector('input[name="existing_image_urls"]');
          if (hidden && hidden.value) orderedExistingUrls.push(hidden.value);
        }
      });
      const uploadPromises = orderedNewFiles.map(f => uploadToCloudinary(f));
      const newUrls = await Promise.all(uploadPromises);
      data.image_urls = [...orderedExistingUrls, ...newUrls];

      if (editingPropertyId) {
        await mutate('properties', async () => {
          const { error } = await window.supabaseClient
            .from('properties')
            .update(data)
            .eq('id', editingPropertyId);
          if (error) throw error;
        });
        showToast('Propiedad actualizada correctamente', 'success');
        fichaPublishOnSave(editingPropertyId);
      
      } else {
        const newPropId = await mutate('properties', async () => {
          const { data: inserted, error } = await window.supabaseClient
            .from('properties')
            .insert([data])
            .select('id');
          if (error) throw error;
          return inserted?.[0]?.id || null;
        });
        showToast('Propiedad creada correctamente', 'success');
        fichaPublishOnSave(newPropId);
      
        if (_pendingPropertyNotes.length && newPropId) await flushPendingPropertyNotes(newPropId);
      }

      closeModal('propertyModal');
      loadProperties();
      updateSidebarBadges();
    } catch (err) {
      logError('Error saving property:', err);
      showToast('Error al guardar: ' + err.message, 'error');
    } finally {
      _submittingProperty = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Inmueble'; }
    }
  });


  /* Generar/regenerar ficha HTML tras guardar una propiedad */

  const fichaPublishOnSave = async (propertyId) => {
    if (!propertyId) return;
    if (!window.BH_CONFIG?.SUPABASE_URL) return;
    try {
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (!session) return;
      const res = await fetch(window.BH_CONFIG.SUPABASE_URL + '/functions/v1/ficha-publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ property_id: propertyId })
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { logWarn('ficha-publish falló (' + res.status + '): ' + (out.error || 'desconocido')); return; }
      console.log('[ficha] generada para', propertyId, out.url || '');
    } catch (e) {
      logWarn('ficha-publish fetch error: ' + e.message);
    }
  };


    /* Edit property */
  window.adminApp = window.adminApp || {};
  window.adminApp.loadSupervision = loadSupervision;
  window.adminApp.loadAnomaliesTable = loadAnomaliesTable;
  window.adminApp.editProperty = async function (id) {
    try {
      const { data, error } = await window.supabaseClient
        .from('properties')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;

        editingPropertyId = id;
      const form = $('#propertyForm');
      if (form) {
        form.reset();
        const codeInput = $('#propCode');
        if (codeInput) codeInput.value = data.property_code || '';
        form.elements.title.value = data.title || '';
        form.elements.description.value = data.description || '';
        form.elements.price_currency.value = data.price_currency || 'USD';
        if (data.price_currency === 'ARS') {
          form.elements.price_usd.value = '';
          form.elements.price_ars.value = data.price_usd || '';
        } else {
          form.elements.price_usd.value = data.price_usd || '';
          form.elements.price_ars.value = '';
        }
        form.elements.property_type.value = data.property_type || '';
        form.elements.status.value = data.status || 'venta';
        form.elements.zone.value = data.zone || '';
        form.elements.locality.value = data.locality || '';
        form.elements.address.value = data.address || '';
        form.elements.bedrooms.value = data.bedrooms || '';
        form.elements.bathrooms.value = data.bathrooms || '';
        form.elements.surface_covered.value = data.surface_covered || data.area_m2 || '';
        form.elements.surface_total.value = data.surface_total || '';
        form.elements.garage_spaces.value = data.garage_spaces || '';
        form.elements.rooms.value = data.rooms || '';
        form.elements.is_published.checked = data.is_published || false;
        form.elements.featured.checked = data.featured || false;
        form.elements.is_retasada.checked = data.is_retasada || false;
        form.elements.is_oportunidad.checked = data.is_oportunidad || false;
        form.elements.is_shared.checked = data.is_shared || false;
        form.elements.is_vendida.checked = data.is_vendida || false;
        form.elements.is_reservada.checked = data.is_reservada || false;
        form.elements.video_url.value = data.video_url || '';
        form.elements.facebook_url.value = data.facebook_url || '';
        form.elements.tiktok_url.value = data.tiktok_url || '';
        if (form.elements.year_built) form.elements.year_built.value = data.year_built || '';
        if (form.elements.inscription_number) form.elements.inscription_number.value = data.inscription_number || '';
        if (form.elements.maintenance_fee) form.elements.maintenance_fee.value = data.maintenance_fee || '';
        if (form.elements.pets_allowed) form.elements.pets_allowed.checked = data.pets_allowed || false;
        if (form.elements.furnished) form.elements.furnished.checked = data.furnished || false;

        const ownerSel = $('#propOwnerSelect');
        if (ownerSel) ownerSel.value = data.owner_id || '';

        const agentSel = $('#propAgentSelect');
        if (agentSel) {
          await loadAgentSelect(agentSel, data.agent_id);
        }

        // Trigger currency field toggle
        const currencySelect = document.getElementById('priceCurrencySelect');
        if (currencySelect) {
          currencySelect.dispatchEvent(new Event('change'));
        }

        const previews = $('#imagePreviewGrid');
        if (previews) {
          previews.innerHTML = data.image_urls?.length
            ? data.image_urls.map(url => `
              <div class="image-preview-item" draggable="true" style="position:relative; width:80px; height:80px; border-radius:8px; overflow:hidden; border:1px solid var(--border-subtle); cursor:grab;">
              <img src="${esc(url)}" alt="" style="width:100%; height:100%; object-fit:cover;" />
              <input type="hidden" name="existing_image_urls" value="${esc(url)}" />
              ${previewPortadaBtnHtml()}
              <button type="button" class="preview-remove" style="position:absolute; top:4px; right:4px; width:20px; height:20px; border-radius:50%; background:rgba(0,0,0,0.7); color:#fff; border:none; cursor:pointer; font-size:10px; display:flex; align-items:center; justify-content:center;"><i class="fas fa-times"></i></button>
            </div>
          `).join('')
            : '';
          refreshPreviewBadges();
        }
      }

      const title = $('#propModalTitle');
      if (title) title.textContent = 'Editar Propiedad';

      const docsSection = $('#propertyDocsSection');

      if (docsSection) docsSection.style.display = 'block';

      loadPropertyDocs(editingPropertyId);
      _pendingPropertyNotes = [];
      loadPropertyNotes(editingPropertyId);
      loadPropertyHistory(editingPropertyId);
      openModal('propertyModal');
    } catch (err) {
      showToast('Error al cargar propiedad', 'error');
    }
  };

  /* Delete property → soft-delete (va a la papelera, recuperable) */
  window.adminApp.deleteProperty = async function (id) {
    if (!confirm('¿Enviar esta propiedad a la papelera?\nSe puede restaurar después desde la vista Papelera.')) return;
    try {
      const { error } = await window.supabaseClient
        .from('properties')
        .update({ deleted_at: new Date().toISOString(), is_published: false })
        .eq('id', id)
        .is('deleted_at', null);
      if (error) throw error;
      showToast('Propiedad movida a la papelera', 'success');
      _propSelected.delete(id);
      loadProperties();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al eliminar: ' + err.message, 'error');
    }
  };

  window.adminApp.restoreProperty = async function (id) {
    try {
      const { error } = await window.supabaseClient
        .from('properties')
        .update({ deleted_at: null })
        .eq('id', id)
        .not('deleted_at', 'is', null);
      if (error) throw error;
      showToast('Propiedad restaurada como borrador', 'success');
      loadProperties();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al restaurar: ' + err.message, 'error');
    }
  };

  window.adminApp.destroyProperty = async function (id) {
    if (currentProfile?.role !== 'super_admin') {
      showToast('Solo un Super Admin puede eliminar definitivamente', 'error');
      return;
    }
    if (!confirm('⚠️ ELIMINACIÓN DEFINITIVA\n\nSe borra la propiedad y todos sus documentos, y NO se puede recuperar.\n¿Confirmás?')) return;
    if (!confirm('Última confirmación: ¿eliminar permanentemente esta propiedad?')) return;
    try {
      const { data: propDocs } = await window.supabaseClient
        .from('property_documents')
        .select('storage_path')
        .eq('property_id', id);
      if (propDocs?.length) {
        await window.supabaseClient.storage.from('property-documents').remove(propDocs.map(d => d.storage_path));
      }
      const { error } = await window.supabaseClient.from('properties').delete().eq('id', id);
      if (error) throw error;
      showToast('Propiedad eliminada definitivamente', 'success');
      loadProperties();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al eliminar definitivamente: ' + err.message, 'error');
    }
  };

  window.adminApp.duplicateProperty = async function (id) {
    try {
      const { data, error } = await window.supabaseClient
        .from('properties')
        .select('*')
        .eq('id', id)
        .is('deleted_at', null)
        .single();
      if (error || !data) throw error || new Error('No se encontró la propiedad');

      editingPropertyId = null;
      resetPropertyForm();
      const form = $('#propertyForm');
      if (form) {
        form.elements.title.value = 'Copia de ' + (data.title || '');
        form.elements.description.value = data.description || '';
        form.elements.price_currency.value = data.price_currency || 'USD';
        if (data.price_currency === 'ARS') {
          form.elements.price_usd.value = '';
          form.elements.price_ars.value = data.price_usd || '';
        } else {
          form.elements.price_usd.value = data.price_usd || '';
          form.elements.price_ars.value = '';
        }
        form.elements.property_type.value = data.property_type || '';
        form.elements.status.value = data.status || 'venta';
        form.elements.zone.value = data.zone || '';
        form.elements.locality.value = data.locality || '';
        form.elements.address.value = data.address || '';
        form.elements.bedrooms.value = data.bedrooms || '';
        form.elements.bathrooms.value = data.bathrooms || '';
        form.elements.surface_covered.value = data.surface_covered || data.area_m2 || '';
        form.elements.surface_total.value = data.surface_total || '';
        form.elements.garage_spaces.value = data.garage_spaces || '';
        form.elements.rooms.value = data.rooms || '';
        form.elements.is_published.checked = false;
        form.elements.featured.checked = false;
        form.elements.is_retasada.checked = data.is_retasada || false;
        form.elements.is_oportunidad.checked = data.is_oportunidad || false;
        form.elements.is_shared.checked = data.is_shared || false;
        form.elements.is_vendida.checked = false;
        form.elements.is_reservada.checked = false;
        form.elements.video_url.value = data.video_url || '';
        form.elements.facebook_url.value = data.facebook_url || '';
        form.elements.tiktok_url.value = data.tiktok_url || '';
        if (form.elements.year_built) form.elements.year_built.value = data.year_built || '';
        if (form.elements.inscription_number) form.elements.inscription_number.value = data.inscription_number || '';
        if (form.elements.maintenance_fee) form.elements.maintenance_fee.value = data.maintenance_fee || '';
        if (form.elements.pets_allowed) form.elements.pets_allowed.checked = data.pets_allowed || false;
        if (form.elements.furnished) form.elements.furnished.checked = data.furnished || false;

        const ownerSel = $('#propOwnerSelect');
        if (ownerSel) ownerSel.value = data.owner_id || '';
        const agentSel = $('#propAgentSelect');
        if (agentSel) await loadAgentSelect(agentSel, data.agent_id);
        const previews = $('#imagePreviewGrid');
        if (previews) {
          previews.innerHTML = (data.image_urls || []).map(url => `
            <div class="image-preview-item" draggable="true" style="position:relative; width:80px; height:80px; border-radius:8px; overflow:hidden; border:1px solid var(--border-subtle); cursor:grab;">
              <img src="${esc(url)}" alt="" style="width:100%; height:100%; object-fit:cover;" />
              <input type="hidden" name="existing_image_urls" value="${esc(url)}" />
              ${previewPortadaBtnHtml()}
              <button type="button" class="preview-remove" title="Quitar" style="position:absolute; top:4px; right:4px; width:20px; height:20px; border-radius:50%; background:rgba(0,0,0,0.7); color:#fff; border:none; cursor:pointer; font-size:10px; display:flex; align-items:center; justify-content:center;"><i class="fas fa-times"></i></button>
            </div>
          `).join('');
          refreshPreviewBadges();
        }
        const currencySelect = $('#priceCurrencySelect');
        if (currencySelect) currencySelect.dispatchEvent(new Event('change'));
      }
      const title = $('#propModalTitle');
      if (title) title.textContent = 'Duplicar propiedad (nueva ficha, sin publicar)';
      const notesSection = $('#propertyNotesSection');
      if (notesSection) notesSection.style.display = 'block';
      openModal('propertyModal');
      showToast('Completá y guardá — se crea como borrador con código nuevo', 'info');
    } catch (err) {
      showToast('Error al duplicar: ' + err.message, 'error');
    }
  };

  function updatePropBulkBar() {
    const bar = $('#propBulkBar');
    if (!bar) return;
    const n = _propSelected.size;
    if (n === 0 || _propViewTrash) { bar.classList.remove('is-visible'); return; }
    bar.classList.add('is-visible');
    const lbl = $('#propBulkCount');
    if (lbl) lbl.textContent = n + ' seleccionada' + (n !== 1 ? 's' : '');
    const mlBtn = $('#propBulkPublishMl');
    if (mlBtn) mlBtn.style.display = ml_connected ? '' : 'none';
  }

  function resetPropSelection() {
    _propSelected.clear();
    const selectAll = $('#propSelectAll');
    if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
    updatePropBulkBar();
  }

  async function propBulkAction(action) {
    const ids = [..._propSelected];
    if (!ids.length) return;
    if (action === 'assign_agent') {
      const sel = $('#propBulkAgentSelect');
      const agentId = sel ? sel.value : '';
      if (!agentId) { showToast('Elegí un broker en el selector', 'error'); return; }
      const res = await window.supabaseClient.from('properties').update({ agent_id: agentId }).in('id', ids);
      if (res.error) { showToast('Error: ' + res.error.message, 'error'); return; }
      showToast('Broker asignado a ' + ids.length + ' propiedades', 'success');
    } else if (action === 'publish_ml') {
      if (!ml_connected) { showToast('Conectá tu cuenta de Mercado Libre primero', 'warning'); return; }
      const bar = $('#propBulkPublishMl');
      if (bar) { bar.disabled = true; bar.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Publicando en ML…'; }
      let ok = 0; const fails = [];
      for (const id of ids) {
        try { await mlApiCall('publish', { property_id: id }); ok++; }
        catch (err) { fails.push(err.message); }
      }
      if (bar) { bar.disabled = false; bar.innerHTML = '<i class="fas fa-shopping-cart"></i> Publicar en ML'; }
      showToast(`ML: ${ok} publicadas${fails.length ? ', ' + fails.length + ' con error' : ''}`, fails.length ? 'warning' : 'success');
      await mlCheckStatus(true);
    } else {
      const publish = action === 'publish';
      const res = await window.supabaseClient.from('properties').update({ is_published: publish }).in('id', ids);
      if (res.error) { showToast('Error: ' + res.error.message, 'error'); return; }
      showToast(ids.length + (publish ? ' publicadas' : ' pasadas a borrador'), 'success');
    }
    resetPropSelection();
    loadProperties();
    updateSidebarBadges();
  }

  let _propSearchTimer = null;
  function bindPropertyToolbar() {
    const search = $('#propSearchInput');
    if (search && !search.dataset.boundServer) {
      search.dataset.boundServer = '1';
      search.addEventListener('input', () => {
        clearTimeout(_propSearchTimer);
        _propSearchTimer = setTimeout(() => {
          _propSearchQuery = search.value.trim();
          _propPage = 1;
          loadProperties();
        }, 350);
      });
    }
    const status = $('#propStatusFilter');
    if (status && !status.dataset.bound) {
      status.dataset.bound = '1';
      status.addEventListener('change', () => { _propStatusFilter = status.value; _propPage = 1; loadProperties(); });
    }
    const pub = $('#propPubFilter');
    if (pub && !pub.dataset.bound) {
      pub.dataset.bound = '1';
      pub.addEventListener('change', () => { _propPubFilter = pub.value; _propPage = 1; loadProperties(); });
    }
    const agent = $('#propAgentFilter');
    if (agent && !agent.dataset.bound) {
      agent.dataset.bound = '1';
      agent.addEventListener('change', () => { _propAgentFilter = agent.value; _propPage = 1; loadProperties(); });
    }
    const trashToggle = $('#propTrashToggle');
    if (trashToggle && !trashToggle.dataset.bound) {
      trashToggle.dataset.bound = '1';
      trashToggle.addEventListener('click', () => {
        _propViewTrash = !_propViewTrash;
        _propPage = 1;
        resetPropSelection();
        loadProperties();
      });
    }

    const tbodyEl = $('#propertiesTableBody');
    if (tbodyEl && !tbodyEl.dataset.propDelegation) {
      tbodyEl.dataset.propDelegation = '1';
      tbodyEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-prop-act]');
        if (!btn) return;
        const id = btn.dataset.propId;
        const act = btn.dataset.propAct;
        if (!id) return;
        if (act === 'edit') window.adminApp.editProperty(id);
        else if (act === 'delete') window.adminApp.deleteProperty(id);
        else if (act === 'restore') window.adminApp.restoreProperty(id);
        else if (act === 'destroy') window.adminApp.destroyProperty(id);
        else if (act === 'duplicate') window.adminApp.duplicateProperty(id);
      });
      tbodyEl.addEventListener('change', (e) => {
        const chk = e.target.closest('.prop-row-check');
        if (!chk) return;
        const id = chk.dataset.propId;
        if (chk.checked) _propSelected.add(id); else _propSelected.delete(id);
        syncPropSelectAll();
        updatePropBulkBar();
      });
    }

    const selectAll = $('#propSelectAll');
    if (selectAll && !selectAll.dataset.bound) {
      selectAll.dataset.bound = '1';
      selectAll.addEventListener('change', () => {
        const checks = $$('#propertiesTableBody .prop-row-check');
        checks.forEach(c => {
          c.checked = selectAll.checked;
          const id = c.dataset.propId;
          if (selectAll.checked) _propSelected.add(id); else _propSelected.delete(id);
        });
        updatePropBulkBar();
      });
    }

    [['propBulkPublish', 'publish'], ['propBulkUnpublish', 'unpublish'], ['propBulkAssign', 'assign_agent'], ['propBulkPublishMl', 'publish_ml']].forEach(([id, act]) => {
      const b = $(`#${id}`);
      if (b && !b.dataset.bound) {
        b.dataset.bound = '1';
        b.addEventListener('click', () => propBulkAction(act));
      }
    });
    const clearBtn = $('#propBulkClear');
    if (clearBtn && !clearBtn.dataset.bound) {
      clearBtn.dataset.bound = '1';
      clearBtn.addEventListener('click', resetPropSelection);
    }
  }

  function syncPropSelectAll() {
    const selectAll = $('#propSelectAll');
    if (!selectAll) return;
    const checks = $$('#propertiesTableBody .prop-row-check');
    const checked = checks.filter(c => c.checked);
    selectAll.checked = checks.length > 0 && checked.length === checks.length;
    selectAll.indeterminate = checked.length > 0 && checked.length < checks.length;
  }

  async function loadPropAgentFilter() {
    const sel = $('#propAgentFilter');
    if (!sel || sel.dataset.filled) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('agents')
        .select('id, full_name')
        .eq('status', 'activo')
        .order('full_name');
      if (error) throw error;
      sel.dataset.filled = '1';
      (data || []).forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.full_name;
        sel.appendChild(opt);
      });
      const bulkSel = $('#propBulkAgentSelect');
      if (bulkSel && !bulkSel.dataset.filled) {
        bulkSel.dataset.filled = '1';
        (data || []).forEach(a => {
          const opt = document.createElement('option');
          opt.value = a.id;
          opt.textContent = a.full_name;
          bulkSel.appendChild(opt);
        });
      }
    } catch (_) {}
  }

  /* ------------------------------------------------
     6. CLOUDINARY UPLOAD
     ------------------------------------------------ */
  async function uploadToCloudinary(file) {
    if (!window.BH_Cloudinary) throw new Error('BH_Cloudinary no disponible');
    return window.BH_Cloudinary.uploadImage(file, 'bienenhaus/properties');
  }

  function computeLeadScore(lead) {
    let score = 0;

    const sourceScores = { walkin: 15, referido: 13, tasacion: 12, chat: 10, ml: 8, landing: 6, manual: 4 };
    score += sourceScores[lead.source] || 4;

    if (lead.budget_usd > 0) score += 5;
    if (lead.budget_usd > 100000) score += 5;
    if (lead.budget_usd > 300000) score += 5;
    if (lead.budget_usd > 500000) score += 5;

    if (lead.phone || lead.whatsapp) score += 5;
    if (lead.email) score += 5;
    if (lead.full_name) score += 5;

    if (lead.preferred_type) score += 4;
    if (lead.preferred_zone) score += 4;
    if (lead.preferred_rooms) score += 3;
    if (lead.notes && lead.notes.length > 10) score += 5;

    const stageScores = { nuevo: 4, contactado: 8, visita: 14, oferta: 18, cerrado: 20, perdido: 2 };
    score += stageScores[lead.stage] || 4;

    if (lead.assigned_to) score += 3;
    if (lead.property_id) score += 2;

    return Math.min(100, Math.max(0, score));
  }

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
  

  /* ------------------------------------------------
     8. AGENDA
     ------------------------------------------------ */
  let calCurrentDate = new Date();
  let calEventsCache = [];
  let calViewMode = 'month'; // 'month' | 'week' | 'day'

  const AGENDA_TYPE_LABELS = {
    visita: 'Visita',
    llamada: 'Llamada',
    nota: 'Nota',
    email: 'Email',
    followup: 'Followup',
    tarea: 'Tarea',
    cambio: 'Cambio de estado',
    alerta: 'Alerta',
    comision: 'Comisión',
    documento: 'Documento',
    contacto: 'Contacto'
  };

  const ACTIVITY_TO_TYPE = {
    call: 'llamada',
    note: 'nota',
    email: 'email',
    visit: 'visita',
    followup: 'followup',
    status_change: 'cambio',
    task: 'tarea'
  };

  const TIMELINE_TO_TYPE = {
    note: 'nota',
    alert: 'alerta',
    commission: 'comision',
    document: 'documento',
    contact: 'contacto'
  };

  async function loadAgenda() {
    invalidateSearchCache();
    const client = await getAuthedClient();
    if (!client) return;

    const trashMode = ($('#calStatusFilter')?.value === 'eliminada');
    try {
      const since90 = new Date(Date.now() - 90 * 86400000).toISOString();
      let visitsQ = client
        .from('visits')
        .select('*, leads(id, full_name, stage), agents(id, full_name), properties(id, title, property_code)')
        .gte('visit_date', new Date(Date.now() - 180 * 86400000).toISOString())
        .lte('visit_date', new Date(Date.now() + 180 * 86400000).toISOString())
        .order('visit_date', { ascending: true });
      visitsQ = trashMode ? visitsQ.not('deleted_at', 'is', null) : visitsQ.is('deleted_at', null);
      const [visitsRes, actsRes, tasksRes, timelineRes] = await Promise.all([
        client
          .from('visits')
          .select('*, leads(id, full_name, stage), agents(id, full_name), properties(id, title, property_code)')
          .is('deleted_at', null)
          .gte('visit_date', new Date(Date.now() - 180 * 86400000).toISOString())
          .lte('visit_date', new Date(Date.now() + 180 * 86400000).toISOString())
          .order('visit_date', { ascending: true }),
        client
          .from('lead_activities')
          .select('*, leads(id, full_name, stage, assigned_to)')
          .gte('created_at', since90)
          .order('created_at', { ascending: false })
          .limit(1000),
        client
          .from('lead_tasks')
          .select('*, leads(id, full_name, stage, assigned_to)')
          .order('due_at', { ascending: true })
          .limit(500),
        client
          .from('owner_timeline_entries')
          .select('*, owners(id, full_name)')
          .gte('created_at', since90)
          .order('created_at', { ascending: false })
          .limit(1000)
      ]);
      if (visitsRes.error) throw visitsRes.error;
      if (actsRes.error) throw actsRes.error;
      if (tasksRes.error) throw tasksRes.error;
      if (timelineRes.error) throw timelineRes.error;

      const events = [];

      /* Visitas programadas */
      (visitsRes.data || []).forEach(v => {
        if (!v.visit_date) return;
        events.push({
          key: 'vis-' + v.id,
          type: 'visita',
          source: 'visits',
          entity: v.client_name || 'Visita',
          date: new Date(v.visit_date),
          title: v.client_name || 'Visita',
          subtitle: (v.properties?.title ? v.properties.title : '') +
            (v.leads?.full_name ? (v.properties?.title ? ' · ' : '') + v.leads.full_name : ''),
          status: v.status || 'pendiente',
          brokerId: v.agent_id || null,
          leadId: v.lead_id || null,
          onClick: trashMode
            ? async function () {
                if (!confirm('¿Restaurar esta visita eliminada?')) return;
                const rr = await window.supabaseClient.from('visits').update({ deleted_at: null }).eq('id', v.id);
                if (rr.error) { showToast('Error: ' + rr.error.message, 'error'); return; }
                showToast('Visita restaurada.', 'success');
                loadAgenda();
              }
            : function () { window.adminApp.editVisit(v.id); }
        });
      });

      /* Actividades de leads (sin estado de visita propio) */
      (actsRes.data || []).forEach(a => {
        const type = ACTIVITY_TO_TYPE[a.activity_type] || 'nota';
        events.push({
          key: 'act-' + a.id,
          type: type,
          source: 'lead_activities',
          entity: a.leads?.full_name || 'Lead',
          date: new Date(a.created_at),
          title: a.title || AGENDA_TYPE_LABELS[type],
          subtitle: (a.description || '') +
            (a.leads?.full_name ? (a.description ? ' · ' : '') + a.leads.full_name : ''),
          status: '',
          brokerId: a.leads?.assigned_to || null,
          leadId: a.lead_id || null,
          onClick: function () {
            if (a.lead_id && window.adminApp.editLead) window.adminApp.editLead(a.lead_id);
          }
        });
      });

      /* Tareas de leads (fecha = due_at) */
      (tasksRes.data || []).forEach(t => {
        if (!t.due_at) return;
        events.push({
          key: 'task-' + t.id,
          type: 'tarea',
          source: 'lead_tasks',
          entity: t.leads?.full_name || 'Tarea',
          date: new Date(t.due_at),
          title: t.title || 'Tarea',
          subtitle: ('Prioridad: ' + (t.priority || 'media')) +
            (t.leads?.full_name ? ' · ' + t.leads.full_name : ''),
          status: t.status || 'pendiente',
          brokerId: t.assigned_to || t.leads?.assigned_to || null,
          leadId: t.lead_id || null,
          onClick: function () {
            if (t.lead_id && window.adminApp.editLead) window.adminApp.editLead(t.lead_id);
          }
        });
      });

      /* Timeline de propietarios */
      (timelineRes.data || []).forEach(o => {
        const type = TIMELINE_TO_TYPE[o.type] || 'nota';
        events.push({
          key: 'own-' + o.id,
          type: type,
          source: 'owner_timeline_entries',
          entity: o.owners?.full_name || 'Propietario',
          date: new Date(o.created_at),
          title: (o.owners?.full_name || 'Propietario') + ' · ' + AGENDA_TYPE_LABELS[type],
          subtitle: o.text || '',
          status: '',
          brokerId: o.created_by || null,
          ownerId: o.owner_id || null,
          onClick: function () {
            if (o.owner_id && window.adminApp.editOwner) window.adminApp.editOwner(o.owner_id);
          }
        });
      });

      calEventsCache = events;
      renderAgenda();
      updateAgendaKpis(events);
    } catch (err) {
      logError('Agenda error:', err);
      showToast('Error al cargar la agenda', 'error');
    }
  }

  function updateAgendaKpis(events) {
    const visits = events.filter(e => e.type === 'visita');
    const now = new Date();
    const todayStr = agendaDayKey(now);
    const weekEnd = new Date(now); weekEnd.setDate(now.getDate() + (7 - now.getDay()));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const hoy = visits.filter(v => agendaDayKey(v.date) === todayStr && v.status !== 'cancelada').length;
    const semana = visits.filter(v => v.date >= now && v.date <= weekEnd && v.status !== 'cancelada').length;
    const sinConfirmar = visits.filter(v => v.date >= now && v.status === 'pendiente').length;
    const mesHechas = visits.filter(v => v.status === 'completada' && v.date >= monthStart).length;
    const vencidas = visits.filter(v => v.date < now && ['pendiente', 'confirmada', 'en_curso'].includes(v.status)).length;
    const cerradasMes = visits.filter(v => v.date >= monthStart && ['completada', 'cancelada'].includes(v.status));
    const asistencia = cerradasMes.length ? Math.round(cerradasMes.filter(v => v.status === 'completada').length / cerradasMes.length * 100) + '%' : '—';
    const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    set('#agendaKpiHoy', hoy);
    set('#agendaKpiSemana', semana);
    set('#agendaKpiSinConfirmar', sinConfirmar);
    set('#agendaKpiMes', mesHechas);
    set('#agendaKpiVencidas', vencidas);
    set('#agendaKpiAsistencia', asistencia);
  }

  /* ---------- Helpers de fecha ---------- */
  const AGENDA_MONTH_NAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const AGENDA_DOW_SHORT = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

  function agendaDayKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function agendaFilters() {
    return {
      status: $('#calStatusFilter')?.value || '',
      type: $('#calTypeFilter')?.value || '',
      broker: $('#calBrokerFilter')?.value || ''
    };
  }

  function agendaMatches(ev, f) {
    if (f.type && ev.type !== f.type) return false;
    if (f.broker && ev.brokerId !== f.broker) return false;
    if (f.status === 'eliminada') return ev.type === 'visita';
    if (f.status && (!ev.status || ev.status !== f.status)) return false;
    return true;
  }

  function agendaLabel() {
    if (calViewMode === 'day') {
      return AGENDA_MONTH_NAMES[calCurrentDate.getMonth()] + ' ' + calCurrentDate.getDate() + ', ' + calCurrentDate.getFullYear();
    }
    if (calViewMode === 'week') {
      const start = new Date(calCurrentDate);
      start.setDate(calCurrentDate.getDate() - ((calCurrentDate.getDay() + 6) % 7));
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      const sameMonth = start.getMonth() === end.getMonth();
      if (start.getFullYear() !== end.getFullYear()) {
        return start.getDate() + ' ' + AGENDA_MONTH_NAMES[start.getMonth()] + ' — ' + end.getDate() + ' ' + AGENDA_MONTH_NAMES[end.getMonth()] + ' ' + end.getFullYear();
      }
      return (sameMonth ? '' : AGENDA_MONTH_NAMES[start.getMonth()] + ' ') + start.getDate() + ' — ' + AGENDA_MONTH_NAMES[end.getMonth()] + ' ' + end.getDate() + ', ' + end.getFullYear();
    }
    return AGENDA_MONTH_NAMES[calCurrentDate.getMonth()] + ' ' + calCurrentDate.getFullYear();
  }

  function agendaEventEl(ev) {
    const timeStr = ev.date
      ? ev.date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
      : '';
    const tooltip = ev.subtitle ? ev.title + ' — ' + ev.subtitle : ev.title;
    const stCls = ev.status ? ' ev--' + ev.status : '';
    const overdue = ev.status && ev.status !== 'completada' && ev.status !== 'cancelada' && ev.date && ev.date.getTime() < Date.now();
    const odCls = overdue ? ' ev--vencida' : '';
    return '<div class="cal-event ev-' + ev.type + stCls + odCls + '" data-key="' + ev.key + '" title="' + esc(tooltip) + '">' +
      (timeStr ? '<span class="ag-event-time">' + esc(timeStr) + '</span> ' : '') +
      esc(ev.title) +
      '</div>';
  }

  /* ---------- Vista Mes ---------- */
  function renderMonthView() {
    const grid = $('#calendarGrid');
    if (!grid) return;
    const f = agendaFilters();
    const year = calCurrentDate.getFullYear();
    const month = calCurrentDate.getMonth();
    const today = new Date();
    const todayStr = agendaDayKey(today);

    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startDay = (firstDay.getDay() + 6) % 7;
    const prevMonthLastDay = new Date(year, month, 0).getDate();

    const eventsByDay = {};
    calEventsCache.forEach(ev => {
      if (!agendaMatches(ev, f)) return;
      const dk = agendaDayKey(ev.date);
      if (!eventsByDay[dk]) eventsByDay[dk] = [];
      eventsByDay[dk].push(ev);
    });
    Object.keys(eventsByDay).forEach(dk => {
      eventsByDay[dk].sort((a, b) => (a.date - b.date));
    });

    const monthEl = $('#calCurrentMonth');
    if (monthEl) monthEl.textContent = agendaLabel();

    let html = '';
    let dayCount = 1;
    let nextMonthDay = 1;

    for (let week = 0; week < 6; week++) {
      for (let dow = 0; dow < 7; dow++) {
        let isCurrentMonth = false;
        let dayNum = 0;
        let dateStr = '';

        if (week === 0 && dow < startDay) {
          dayNum = prevMonthLastDay - (startDay - dow - 1);
          const prevMonth = month === 0 ? 11 : month - 1;
          const prevYear = month === 0 ? year - 1 : year;
          dateStr = prevYear + '-' + String(prevMonth + 1).padStart(2, '0') + '-' + String(dayNum).padStart(2, '0');
        } else if (dayCount <= daysInMonth) {
          dayNum = dayCount++;
          dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(dayNum).padStart(2, '0');
          isCurrentMonth = true;
        } else {
          dayNum = nextMonthDay++;
          const nextMonth = month === 11 ? 0 : month + 1;
          const nextYear = month === 11 ? year + 1 : year;
          dateStr = nextYear + '-' + String(nextMonth + 1).padStart(2, '0') + '-' + String(dayNum).padStart(2, '0');
        }

        const isToday = dateStr === todayStr;
        const dayEvents = eventsByDay[dateStr] || [];
        const maxShow = 3;
        let eventsHtml = '';
        dayEvents.slice(0, maxShow).forEach(ev => {
          eventsHtml += agendaEventEl(ev);
        });
        if (dayEvents.length > maxShow) {
          eventsHtml += '<div class="cal-event-more" data-goto-date="' + dateStr + '">+' + (dayEvents.length - maxShow) + ' más</div>';
        }

        const otherMonthClass = isCurrentMonth ? '' : ' other-month';
        const todayClass = isCurrentMonth && isToday ? ' today' : '';

        html += '<div class="cal-day' + otherMonthClass + todayClass + '" data-date="' + dateStr + '" data-current-month="' + isCurrentMonth + '">' +
          '<div class="cal-day-number">' + dayNum + '</div>' +
          '<div class="cal-events">' + eventsHtml + '</div>' +
          '</div>';
      }
    }

    const gridEl = document.getElementById('calendarGrid');
    if (gridEl) {
      const headers = gridEl.querySelectorAll('.cal-day-header');
      gridEl.innerHTML = '';
      headers.forEach(h => gridEl.appendChild(h));
      gridEl.insertAdjacentHTML('beforeend', html);
    }
    bindAgendaClicks();
  }

  /* ---------- Vista Semana ---------- */
  function renderWeekView() {
    const container = $('#calendarWeekGrid');
    if (!container) return;
    const f = agendaFilters();
    const monthEl = $('#calCurrentMonth');
    if (monthEl) monthEl.textContent = agendaLabel();

    const start = new Date(calCurrentDate);
    start.setDate(calCurrentDate.getDate() - ((calCurrentDate.getDay() + 6) % 7));
    start.setHours(0, 0, 0, 0);

    const eventsByDay = {};
    calEventsCache.forEach(ev => {
      if (!agendaMatches(ev, f)) return;
      const dk = agendaDayKey(ev.date);
      if (!eventsByDay[dk]) eventsByDay[dk] = [];
      eventsByDay[dk].push(ev);
    });
    Object.keys(eventsByDay).forEach(dk => {
      eventsByDay[dk].sort((a, b) => (a.date - b.date));
    });

    const todayStr = agendaDayKey(new Date());
    let html = '';
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const dk = agendaDayKey(d);
      const isToday = dk === todayStr;
      let eventsHtml = '';
      (eventsByDay[dk] || []).forEach(ev => {
        eventsHtml += agendaEventEl(ev);
      });
      html +=
        '<div class="cal-week-col' + (isToday ? ' today' : '') + '" data-date="' + dk + '">' +
        '<div class="cal-week-day-head">' +
        '<span class="cal-week-dayname">' + AGENDA_DOW_SHORT[i] + '</span>' +
        '<span class="cal-week-daynum">' + d.getDate() + '</span>' +
        '</div>' +
        '<div class="cal-week-events">' + (eventsHtml || '<span class="cal-week-empty">—</span>') + '</div>' +
        '</div>';
    }
    container.innerHTML = html;
    bindAgendaClicks();
  }

  /* ---------- Vista Día ---------- */
  function renderDayView() {
    const container = $('#calendarDayView');
    if (!container) return;
    const f = agendaFilters();
    const monthEl = $('#calCurrentMonth');
    if (monthEl) monthEl.textContent = agendaLabel();

    const dk = agendaDayKey(calCurrentDate);
    const dayEvents = calEventsCache
      .filter(ev => agendaDayKey(ev.date) === dk && agendaMatches(ev, f))
      .sort((a, b) => (a.date - b.date));

    let html = '';
    if (!dayEvents.length) {
      html = '<div class="cal-day-empty">Sin eventos para este día'
        + ' <button type="button" class="btn-action" id="calDayEmptyAdd" style="margin-left:12px;"><i class="fas fa-plus"></i> Agendar visita aquí</button></div>';
    } else {
      const isToday = dk === agendaDayKey(new Date());
      let nowMarked = false;
      dayEvents.forEach(ev => {
        if (isToday && !nowMarked && ev.date.getTime() >= Date.now()) {
          html += '<div class="cal-day-now"><span>' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) + ' — ahora</span></div>';
          nowMarked = true;
        }
        const timeStr = ev.date
          ? ev.date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
          : '';
        html +=
          '<div class="cal-day-row" data-key="' + ev.key + '">' +
          '<div class="cal-day-row-time">' + esc(timeStr) + '</div>' +
          '<div class="cal-day-row-main">' +
          '<div class="cal-event ev-' + ev.type + '" data-key="' + ev.key + '">' + esc(ev.title) + '</div>' +
          (ev.subtitle ? '<div class="cal-day-row-sub">' + esc(ev.subtitle) + '</div>' : '') +
          '</div>' +
          '</div>';
      });
      if (isToday && !nowMarked) {
        html += '<div class="cal-day-now"><span>' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) + ' — día finalizado</span></div>';
      }
    }
    container.innerHTML = html;
    const addBtn = $('#calDayEmptyAdd');
    if (addBtn) addBtn.addEventListener('click', () => { if (window.adminApp.openVisitModal) window.adminApp.openVisitModal({ visit_date: calCurrentDate.toISOString() }); });
    bindAgendaClicks();
  }

  function renderAgenda() {
    if (calViewMode === 'week') renderWeekView();
    else if (calViewMode === 'day') renderDayView();
    else renderMonthView();
    updateViewSwitcher();
  }

  function updateViewSwitcher() {
    $('#calViewMonthBtn')?.classList.toggle('active', calViewMode === 'month');
    $('#calViewWeekBtn')?.classList.toggle('active', calViewMode === 'week');
    $('#calViewDayBtn')?.classList.toggle('active', calViewMode === 'day');
    const grid = $('#calendarGrid');
    const week = $('#calendarWeekGrid');
    const day = $('#calendarDayView');
    if (grid) grid.style.display = calViewMode === 'month' ? 'grid' : 'none';
    if (week) week.style.display = calViewMode === 'week' ? 'grid' : 'none';
    if (day) day.style.display = calViewMode === 'day' ? 'block' : 'none';
  }

  async function rescheduleVisitToDay(visitId, dateStr, oldDate) {
    if (!confirm('Mover la visita al ' + dateStr + '?')) return;
    try {
      const d = new Date(oldDate);
      const [y, m, dd] = dateStr.split('-').map(Number);
      const target = new Date(y, m - 1, dd, d.getHours(), d.getMinutes());
      const { error } = await window.supabaseClient.from('visits').update({ visit_date: target.toISOString() }).eq('id', visitId);
      if (error) throw error;
      if (ev.leadId) {
        try {
          await window.supabaseClient.from('lead_activities').insert([{
            lead_id: ev.leadId,
            activity_type: 'note',
            title: 'Visita reprogramada (arrastrar y soltar)',
            description: d.toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' → ' + target.toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
          }]);
        } catch (_) {}
      }
      showToast('Visita reprogramada al ' + target.toLocaleDateString('es-AR'), 'success');
      loadAgenda();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  }

  function goToDayView(dateStr) {
    const parts = String(dateStr).split('-');
    if (parts.length !== 3) return;
    calCurrentDate = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    calViewMode = 'day';
    renderAgenda();
  }

  function calStep(dir) {
    if (calViewMode === 'day') calCurrentDate.setDate(calCurrentDate.getDate() + dir);
    else if (calViewMode === 'week') calCurrentDate.setDate(calCurrentDate.getDate() + 7 * dir);
    else calCurrentDate.setMonth(calCurrentDate.getMonth() + dir);
    renderAgenda();
  }

  function bindAgendaClicks() {
    /* Drag & drop: arrastrar una visita a otro día = reprogramar (conserva hora) */
    document.querySelectorAll('#calendarGrid .cal-event[data-key^="vis-"], #calendarWeekGrid .cal-event[data-key^="vis-"]').forEach(el => {
      el.draggable = true;
      el.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/plain', el.dataset.key);
        e.dataTransfer.effectAllowed = 'move';
      });
    });
    document.querySelectorAll('#calendarGrid .cal-day[data-date], #calendarWeekGrid .cal-week-col[data-date]').forEach(el => {
      el.addEventListener('dragover', function (e) {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('text/plain')) { e.preventDefault(); el.classList.add('cal-drop-target'); }
      });
      el.addEventListener('dragleave', function () { el.classList.remove('cal-drop-target'); });
      el.addEventListener('drop', async function (e) {
        e.preventDefault();
        el.classList.remove('cal-drop-target');
        const key = e.dataTransfer.getData('text/plain');
        const targetDate = el.getAttribute('data-date');
        if (!key || !key.startsWith('vis-') || !targetDate) return;
        const visitId = key.slice(4);
        const ev = calEventsCache.find(x => x.key === key);
        if (!ev) return;
        await rescheduleVisitToDay(visitId, targetDate, ev.date);
      });
    });

    document.querySelectorAll('#calendarGrid .cal-day[data-date]').forEach(el => {
      el.onclick = function (e) {
        if (e.target.closest('.cal-event, .cal-event-more')) return;
        goToDayView(el.getAttribute('data-date'));
      };
    });
    document.querySelectorAll('#calendarWeekGrid .cal-week-col[data-date]').forEach(el => {
      el.onclick = function (e) {
        if (e.target.closest('.cal-event')) return;
        goToDayView(el.getAttribute('data-date'));
      };
    });
    document.querySelectorAll('#calendarGrid .cal-event[data-key], #calendarWeekGrid .cal-event[data-key], #calendarDayView .cal-event[data-key], .cal-day-row[data-key]').forEach(el => {
      el.onclick = function (e) {
        e.stopPropagation();
        const key = el.getAttribute('data-key');
        const ev = calEventsCache.find(x => x.key === key);
        if (ev && ev.onClick) ev.onClick();
      };
    });
    document.querySelectorAll('#calendarGrid .cal-event-more[data-goto-date]').forEach(el => {
      el.onclick = function (e) {
        e.stopPropagation();
        goToDayView(el.getAttribute('data-goto-date'));
      };
    });
  }

  /* ---------- Handlers de cabecera ---------- */
  $('#calPrevMonth')?.addEventListener('click', function () { calStep(-1); });
  $('#calNextMonth')?.addEventListener('click', function () { calStep(1); });
  $('#calTodayBtn')?.addEventListener('click', function () {
    calCurrentDate = new Date();
    renderAgenda();
  });
  $('#calViewMonthBtn')?.addEventListener('click', function () {
    calViewMode = 'month';
    renderAgenda();
  });
  $('#calViewWeekBtn')?.addEventListener('click', function () {
    calViewMode = 'week';
    renderAgenda();
  });
  $('#calViewDayBtn')?.addEventListener('click', function () {
    calViewMode = 'day';
    renderAgenda();
  });
  $('#calStatusFilter')?.addEventListener('change', function () { renderAgenda(); });
  $('#calTypeFilter')?.addEventListener('change', function () { renderAgenda(); });
  $('#calBrokerFilter')?.addEventListener('change', function () { renderAgenda(); });

  /* Persistencia de filtros (sobrevive al cambio de pestaña/recarga) */
  ['calStatusFilter', 'calTypeFilter', 'calBrokerFilter'].forEach(id => {
    const el = $('#' + id);
    if (!el) return;
    const saved = localStorage.getItem('agenda:' + id);
    if (saved) { el.value = saved; }
    el.addEventListener('change', () => { localStorage.setItem('agenda:' + id, el.value); });
  });

  /* Compartir la agenda del día vía WhatsApp */
  $('#calShareDayBtn')?.addEventListener('click', function () {
    const dk = agendaDayKey(calCurrentDate);
    const dayEvents = calEventsCache
      .filter(ev => agendaDayKey(ev.date) === dk && ev.status !== 'cancelada' && ev.type === 'visita')
      .sort((a, b) => a.date - b.date);
    const fecha = calCurrentDate.toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: 'long' });
    let text = '📅 *Agenda ' + fecha + '*\n';
    if (!dayEvents.length) text += '\nSin visitas para este día.';
    else dayEvents.forEach(ev => {
      const t = ev.date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      text += '\n• ' + t + ' — ' + ev.title + (ev.subtitle ? ' · ' + ev.subtitle : '') + ' [' + ev.status + ']';
    });
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  });

  /* Reasignación masiva: mueve las visitas futuras de un broker a otro */
  window.adminApp.reassignBrokerVisits = async function (fromAgentId, toAgentId) {
    if (!fromAgentId || !toAgentId || fromAgentId === toAgentId) { showToast('Elegí brokers distintos.', 'warning'); return; }
    if (!confirm('¿Reasignar todas las visitas futuras de este broker al otro?')) return;
    try {
      const { error, count } = await window.supabaseClient
        .from('visits')
        .update({ agent_id: toAgentId })
        .eq('agent_id', fromAgentId)
        .is('deleted_at', null)
        .in('status', ['pendiente', 'confirmada'])
        .gte('visit_date', new Date().toISOString())
        .select('id');
      if (error) throw error;
      showToast('Reasignadas ' + (count ?? '?') + ' visitas futuras.', 'success');
      loadAgenda();
      updateSidebarBadges();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  };

  /* Imprimir la vista actual */
  $('#calPrintBtn')?.addEventListener('click', function () { window.print(); });

  /* KPIs clickeables: atajos de navegación */
  $('#agendaKpiHoy')?.closest('.crm-kpi')?.addEventListener('click', function () {
    calCurrentDate = new Date(); calViewMode = 'day'; renderAgenda();
  });
  $('#agendaKpiSemana')?.closest('.crm-kpi')?.addEventListener('click', function () {
    calCurrentDate = new Date(); calViewMode = 'week'; renderAgenda();
  });
  $('#agendaKpiSinConfirmar')?.closest('.crm-kpi')?.addEventListener('click', function () {
    const f = $('#calStatusFilter'); if (f) { f.value = 'pendiente'; localStorage.setItem('agenda:calStatusFilter', 'pendiente'); }
    renderAgenda();
  });
  $('#agendaKpiVencidas')?.closest('.crm-kpi')?.addEventListener('click', function () {
    const f = $('#calStatusFilter'); if (f) { f.value = 'pendiente'; localStorage.setItem('agenda:calStatusFilter', 'pendiente'); }
    calViewMode = 'day'; renderAgenda();
  });

  /* Navegación por teclado: ← → cambian el período, t vuelve a hoy (solo con la pestaña abierta) */
  document.addEventListener('keydown', function (e) {
    if (e.target.closest('input, textarea, select')) return;
    const agendaTab = $('#tab-agenda');
    if (!agendaTab || agendaTab.offsetParent === null) return;
    if (e.key === 'ArrowLeft') { calStep(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { calStep(1); e.preventDefault(); }
    else if (e.key === 't' || e.key === 'T') { calCurrentDate = new Date(); renderAgenda(); }
  });

  /* ---------- Filtro de brokers (solo calendario) ---------- */
  async function populateBrokerFilters() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('agents')
        .select('id, full_name')
        .eq('status', 'activo')
        .is('deleted_at', null)
        .order('full_name');
      if (error) throw error;
      const brokers = data || [];
      const calFilter = $('#calBrokerFilter');
      if (calFilter) {
        const current = calFilter.value;
        calFilter.innerHTML = '<option value="">Todos los brokers</option>';
        brokers.forEach(b => {
          const opt = document.createElement('option');
          opt.value = b.id;
          opt.textContent = b.full_name;
          calFilter.appendChild(opt);
        });
        if (current) calFilter.value = current;
      }
    } catch (_) { /* silent */ }
  }

  populateBrokerFilters();

  function visitRowHtml(v) {
    const dateStr = v.visit_date
      ? new Date(v.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '-';
    const lead = v.leads;
    const leadLink = lead
      ? `<button class="btn-action" style="font-size:10px; color:var(--accent);" title="Ver en CRM" onclick="event.stopPropagation(); window.adminApp.editLead('${lead.id}')">
           <i class="fas fa-user"></i> ${esc(lead.full_name)} <i class="fas fa-external-link-alt" style="font-size:9px; margin-left:2px;"></i>
         </button>`
      : '<span style="color:var(--text-dim); font-size:12px;">—</span>';

    let countdownHtml = '';
    if ((v.status === 'pendiente' || v.status === 'confirmada') && v.visit_date) {
      const diffMs = new Date(v.visit_date).getTime() - Date.now();
      if (diffMs > 0) {
        const diffH = diffMs / (1000 * 60 * 60);
        const diffM = diffMs / (1000 * 60);
        let label, color, bg;
        if (diffH < 1) { label = Math.round(diffM) + 'min'; color = '#ef4444'; bg = 'rgba(239,68,68,0.15)'; }
        else if (diffH < 24) { label = Math.round(diffH) + 'h'; color = '#FFB800'; bg = 'rgba(255,184,0,0.15)'; }
        else { label = Math.round(diffH / 24) + 'd'; color = 'var(--accent)'; bg = 'rgba(31,200,195,0.15)'; }
        countdownHtml = `<span class="nav-badge" style="font-size:10px; background:${bg}; color:${color}; margin-left:6px; padding:2px 6px; border-radius:8px;"><i class="fas fa-clock" style="margin-right:3px;"></i>${label}</span>`;
      }
    }

    /* Check-in / Check-out buttons for pending/confirmed visits */
    let checkinHtml = '';
    if ((v.status === 'pendiente' || v.status === 'confirmada') && !v.check_in) {
      checkinHtml = `<button class="btn-action" title="Marcar llegada" onclick="window.adminApp.checkinVisit('${v.id}')" style="background:rgba(0,200,120,0.15); color:var(--success);"><i class="fas fa-sign-in-alt"></i></button>`;
    } else if (v.check_in && !v.check_out) {
      checkinHtml = `<button class="btn-action" title="Marcar salida" onclick="window.adminApp.checkoutVisit('${v.id}')" style="background:rgba(31,200,195,0.15); color:var(--accent);"><i class="fas fa-sign-out-alt"></i></button>`;
    }

    /* Show check-in/out times if set */
    let checkinTimeHtml = '';
    if (v.check_in) {
      const ci = new Date(v.check_in).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      checkinTimeHtml = `<div style="font-size:11px; color:var(--success);"><i class="fas fa-sign-in-alt"></i> ${ci}</div>`;
    }
    if (v.check_out) {
      const co = new Date(v.check_out).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      checkinTimeHtml += `<div style="font-size:11px; color:var(--accent);"><i class="fas fa-sign-out-alt"></i> ${co}</div>`;
    }

    return `
      <tr>
        <td style="font-size:13px;">${dateStr}</td>
        <td style="font-size:13px; font-weight:500;">${esc(v.client_name || 'Sin cliente')}</td>
        <td style="font-size:13px; color:var(--text-dim);">${leadLink}</td>
        <td style="font-size:12px; color:var(--text-dim);">${v.properties?.title ? esc(v.properties.title) : '—'}</td>
        <td><span class="nav-badge" style="background:${v.status === 'confirmada' ? 'rgba(0,200,120,0.15)' : v.status === 'completada' ? 'rgba(31,200,195,0.15)' : 'rgba(255,184,0,0.15)'}; color:${v.status === 'confirmada' ? 'var(--success)' : v.status === 'completada' ? 'var(--accent)' : 'var(--warning)'}; font-size:11px;">${esc(v.status || 'pendiente')}</span>${countdownHtml}</td>
        <td style="font-size:12px; color:var(--text-dim);">${v.leads?.full_name ? esc(v.leads.full_name) : '—'}</td>
        <td>
          <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
            ${v.confirmation_token && v.client_email ? '<button class="btn-action" title="Copiar link de confirmacion" onclick="window.adminApp.copyVisitLink(\'${v.id}\')"><i class="fas fa-link"></i></button>' : ''}
            <button class="btn-action" title="Editar" onclick="window.adminApp.editVisit('${v.id}')"><i class="fas fa-pen"></i></button>
            ${checkinHtml}
            ${checkinTimeHtml}
            <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteVisit('${v.id}')"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>`;
  }

  

    // ============================================
    // GRANULAR REALTIME ROW UPDATES
    // (Las funciones upsert*/remove* están definidas más abajo, junto a sus
    //  builders HTML correspondientes. Este bloque se duplicaba por error.)
    // ============================================

    // Helper: extract row builders from existing load functions
    function buildLeadCardHtml(l) {
      const leadVisits = (window._visitsByLeadCache?.[l.id] || []);
      const upcomingVisit = leadVisits.find(v => v.status === 'pendiente' || v.status === 'confirmada');
      const hasFutureVisit = !!upcomingVisit;
      const showScheduleBtn = (l.stage === 'contactado' || l.stage === 'visita_agendada') && !hasFutureVisit;
      const budgetHtml = l.budget_usd ? '<div style="color:var(--accent); font-size:12px; font-weight:500;">USD ' + l.budget_usd.toLocaleString('es-AR') + '</div>' : '';
      const prefType = l.preferred_type ? l.preferred_type.charAt(0).toUpperCase() + l.preferred_type.slice(1) : '';
      const prefZone = l.preferred_zone ? '· ' + esc(l.preferred_zone) : '';
      const scoreVal = l.score || 0;
      const scoreColor = scoreVal >= 80 ? 'rgba(239,68,68,0.2)' : scoreVal >= 50 ? 'rgba(255,184,0,0.2)' : 'rgba(255,255,255,0.06)';
      const scoreTextColor = scoreVal >= 80 ? '#ef4444' : scoreVal >= 50 ? 'var(--warning)' : 'var(--text-dim)';
      let visitInfo = '';
      if (upcomingVisit) {
        const badgeColor = upcomingVisit.status === 'confirmada' ? 'rgba(0,200,120,0.2)' : 'rgba(255,184,0,0.2)';
        const badgeTextColor = upcomingVisit.status === 'confirmada' ? 'var(--success)' : 'var(--warning)';
        const visitDate = new Date(upcomingVisit.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        visitInfo = '<div style="margin-top:6px; padding:6px 8px; background:rgba(31,200,195,0.08); border-radius:4px; font-size:11px; color:var(--accent); display:flex; align-items:center; gap:6px;">' +
          '<i class="fas fa-calendar-day"></i>' +
          '<span>' + esc(visitDate) + '</span>' +
          '<span class="nav-badge" style="font-size:9px; background:' + badgeColor + '; color:' + badgeTextColor + ';">' + esc(upcomingVisit.status) + '</span>' +
          '</div>';
      }
      let scheduleBtn = '';
      if (showScheduleBtn) {
        scheduleBtn = '<button class="btn-action" data-open-visit data-lead-id="' + esc(l.id) + '" data-client-name="' + esc(l.full_name) + '" data-client-phone="' + esc(l.phone || l.whatsapp || '') + '" data-property-id="' + esc(l.property_id || '') + '" style="padding:4px 8px; font-size:10px; margin-top:8px; width:100%; background:rgba(31,200,195,0.15); color:var(--accent); border:1px solid var(--accent);">' +
          '<i class="fas fa-calendar-plus"></i> Agendar visita' +
          '</button>';
      }
      return `
        <div class="lead-card" data-lead-id="${l.id}" style="background:var(--surface-2); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:14px; margin-bottom:10px; cursor:pointer;" onclick="window.adminApp.editLead('${esc(l.id)}')">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <div style="font-weight:600; color:#fff; font-size:13px;">${esc(l.full_name || 'Sin nombre')}</div>
            <span class="nav-badge" style="font-size:10px; background:rgba(31,200,195,0.12); color:var(--accent); font-weight:600; padding:2px 6px; border-radius:10px;">${l.score || 0}</span>
          </div>
          <div style="color:var(--text-dim); font-size:11px; margin-bottom:6px;">${esc(l.preferred_type || '')}${l.preferred_zone ? ' · ' + esc(l.preferred_zone) : ''}</div>
          ${budgetHtml}
          ${visitInfo}
          ${scheduleBtn}
          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top:8px; border-top:1px solid var(--border-subtle);">
            <span style="color:var(--text-dim); font-size:10px;">${new Date(l.created_at).toLocaleDateString('es-AR')}</span>
            <div style="display:flex; gap:4px;">
              <button class="btn-action" style="padding:4px 6px; font-size:10px;" title="Editar" onclick="event.stopPropagation(); window.adminApp.editLead('${esc(l.id)}')"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" style="padding:4px 6px; font-size:10px;" title="Eliminar" onclick="event.stopPropagation(); window.adminApp.deleteLead('${esc(l.id)}')"><i class="fas fa-trash"></i></button>
            </div>
          </div>
        </div>`;
    }

    function buildPropertyRowHtml(p) {
      return `<tr data-id="${p.id}">
        <td style="font-weight:600; color:#fff;">${esc(p.title)}</td>
        <td>${esc(p.property_code || '')}</td>
        <td>${esc(p.zone)}</td>
        <td>${p.surface_total ? p.surface_total + ' m²' : '-'}</td>
        <td>${p.rooms || '-'}</td>
        <td style="font-weight:600; color:var(--accent);">${p.price_usd ? '$ ' + Number(p.price_usd).toLocaleString('es-AR') : '-'}</td>
        <td><span class="nav-badge" style="background:${p.status === 'venta' ? 'rgba(31,200,195,0.15)' : 'rgba(255,184,0,0.15)'}; color:${p.status === 'venta' ? 'var(--accent)' : 'var(--warning)'};">${esc(p.status || 'venta')}</span></td>
        <td style="color:${p.owner_id ? '#fff' : 'var(--text-dim)'};">${esc(p.owner_id ? '?' : '—')}</td>
        <td>
          <div style="display:flex; gap:4px; flex-wrap:wrap;">
            ${p.is_published ? '<span class="nav-badge" style="background:rgba(0,200,120,0.15); color:var(--success);">Publicada</span>' : '<span class="nav-badge" style="background:rgba(255,255,255,0.06); color:var(--text-dim);">Borrador</span>'}
            ${p.featured ? '<span class="nav-badge" style="background:rgba(255,184,0,0.15); color:var(--warning);"><i class="fas fa-star" style="margin-right:4px;"></i>Destacada</span>' : ''}
            ${p.is_retasada ? '<span class="nav-badge" style="background:rgba(139,92,246,0.15); color:#8b5cf6;"><i class="fas fa-tag" style="margin-right:4px;"></i>Retasada</span>' : ''}
            ${p.is_oportunidad ? '<span class="nav-badge" style="background:rgba(239,68,68,0.15); color:#ef4444;"><i class="fas fa-bolt" style="margin-right:4px;"></i>Oportunidad</span>' : ''}
            ${p.is_shared ? '<span class="nav-badge" style="background:rgba(6,182,212,0.15); color:#06b6d4;"><i class="fas fa-share-nodes" style="margin-right:4px;"></i>Compartido</span>' : ''}
            ${p.is_vendida ? '<span class="nav-badge" style="background:rgba(75,85,99,0.18); color:#4b5563;"><i class="fas fa-check-circle" style="margin-right:4px;"></i>Vendida</span>' : ''}
            ${p.is_reservada ? '<span class="nav-badge" style="background:rgba(234,179,8,0.18); color:#ca8a04;"><i class="fas fa-lock" style="margin-right:4px;"></i>Reservada</span>' : ''}

          </div>
        </td>
        <td>
          <div style="display:flex; gap:6px; align-items:center;">
            <button class="btn-action" title="Editar" onclick="window.adminApp.editProperty(\'${p.id}\')"><i class="fas fa-pen"></i></button>
            <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteProperty(\'${p.id}\')"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>`;
    }

    function buildAgentRowHtml(a) {
      return `<tr data-id="${a.id}">
        <td>
          <div style="display:flex; align-items:center; gap:10px;">
            <img style="width:36px; height:36px; border-radius:50%; object-fit:cover; border:1px solid var(--border-subtle);" src="${esc(a.photo_url || 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=100&q=60&fit=crop')}" alt="" />
            <div>
              <div style="font-weight:600; color:#fff; font-size:13px;">${esc(a.full_name || 'Sin nombre')}</div>
              <div style="color:var(--text-dim); font-size:11px;">${esc(a.email || '')}</div>
            </div>
          </td>
          <td>${esc(a.matricula || '-')}</td>
          <td>${(a.specialties && a.specialties.length) ? a.specialties.map(s => '<span class="nav-badge" style="background:rgba(16,185,129,0.12); color:#10b981; font-size:10px; margin-right:3px;">${esc(s)}</span>').join('') : '<span style="color:var(--text-dim);">—</span>'}</td>
          <td style="color:var(--accent);">${a.commission_rate != null ? esc(a.commission_rate + '%') : '3%'}</td>
          <td><span class="nav-badge" style="background:${a.status === 'activo' ? 'rgba(0,200,120,0.15)' : a.status === 'licencia' ? 'rgba(255,184,0,0.15)' : 'rgba(255,255,255,0.06)'}; color:${a.status === 'activo' ? 'var(--success)' : a.status === 'licencia' ? 'var(--warning)' : 'var(--text-dim)'}; font-size:11px;">${esc(a.status || 'activo')}</span></td>
          <td>${esc(a.phone || '-')}</td>
          <td>
            <div style="display:flex; gap:6px;">
              <button class="btn-action" title="Editar" onclick="window.adminApp.editAgent(\'${a.id}\')"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteAgent(\'${a.id}\')"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>`;
    }

    function ownerExpiryBadges(o) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const in30 = new Date(today.getTime() + 30 * 86400000);
      const badges = [];
      if (o.exclusive) {
        badges.push('<span class="nav-badge" style="background:rgba(31,200,195,0.12); color:var(--accent);"><i class="fas fa-star" style="margin-right:3px;"></i>Exclusivo</span>');
        if (o.exclusive_end) {
          const end = new Date(o.exclusive_end);
          if (end < today) badges.push('<span class="nav-badge" style="background:rgba(239,68,68,0.15); color:var(--danger);">Excl. vencida</span>');
          else if (end <= in30) badges.push('<span class="nav-badge" style="background:rgba(255,184,0,0.15); color:var(--warning);">Vence ' + end.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' }) + '</span>');
        }
      }
      if (o.dni_expiry && new Date(o.dni_expiry) <= in30) badges.push('<span class="nav-badge" style="background:rgba(239,68,68,0.12); color:var(--danger);">DNI por vencer</span>');
      if (o.cuit_expiry && new Date(o.cuit_expiry) <= in30) badges.push('<span class="nav-badge" style="background:rgba(239,68,68,0.12); color:var(--danger);">CUIT por vencer</span>');
      return badges.length ? '<div style="display:flex; gap:4px; flex-wrap:wrap; margin-top:4px;">' + badges.join('') + '</div>' : '';
    }

    function buildOwnerRowHtml(o) {
      const wa = window.BH_CRM && window.BH_CRM.waNumber ? window.BH_CRM.waNumber(o.phone) : null;
      return `<tr data-id="${o.id}">
        <td>
          <div style="display:flex; align-items:center; gap:8px;">
            <strong>${esc(o.full_name)}</strong>
            ${wa ? '<a class="crm-contact-btn crm-contact-btn--wa" href="https://wa.me/' + wa + '" target="_blank" rel="noopener" title="WhatsApp" style="width:26px; height:26px; padding:0; display:inline-flex; align-items:center; justify-content:center;"><i class="fab fa-whatsapp"></i></a>' : ''}
          </div>
          ${ownerExpiryBadges(o)}
        </td>
        <td>${esc(o.dni_cuit || '-')}</td>
        <td>${esc(o.email || '-')}</td>
        <td>${esc(o.phone || '-')}</td>
        <td>${esc(o.address || '-')}</td>
        <td>
          <div style="display:flex; gap:6px;">
            <button class="btn-action" title="Editar" onclick="window.adminApp.editOwner('${o.id}')"><i class="fas fa-pen"></i></button>
            <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteOwner('${o.id}')"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>`;
    }

    function tasAvatarColor(name) {
      const colors = ['#20B8AB', '#3b82f6', '#8C64DC', '#e67e22', '#39D98A', '#CC3535', '#FFB432', '#1abc9c', '#9b59b6', '#e74c3c'];
      let hash = 0;
      const s = String(name || '');
      for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
      return colors[Math.abs(hash) % colors.length];
    }

    function tasInitials(text) {
      const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return 'T';
      return parts.slice(0, 2).map(p => p.charAt(0)).join('').toUpperCase();
    }

    function buildTasacionRowHtml(t, extras) {
      const ownerName = (t.owners && t.owners.full_name) || (extras && extras.ownerName) || null;
      const propName = t.properties
        ? [t.properties.property_code || t.properties.code, t.properties.title].filter(Boolean).join(' · ')
        : ((extras && extras.propName) || null);
      const statusLabel = t.status === 'finalized' ? 'Finalizada' : 'Borrador';
      const statusClass = t.status === 'finalized' ? 'active' : 'pending';
      const date = t.created_at ? new Date(t.created_at).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
      const typeLabel = t.type === 'venta' ? 'Venta' : t.type === 'alquiler' ? 'Alquiler' : (t.type || '');
      const typeChip = typeLabel
        ? `<span class="crm-tipo-chip crm-tipo-chip--tas${t.type === 'alquiler' ? ' tas-chip--alquiler' : ''}">${esc(typeLabel)}</span>`
        : '';
      let valuation = t.valuation_usd;
      if (!valuation && t.data && typeof t.data === 'object') {
        valuation = t.data.valuation_usd || t.data.final_valuation || null;
      }
      const valuationStr = valuation ? 'US$ ' + Number(valuation).toLocaleString('es-AR') : '—';
      const avatarBase = ownerName || t.title || 'Tasacion';
      const meta = [ownerName, propName].filter(Boolean).map(x => esc(x)).join(' · ') || 'Sin vínculos en el CRM';
      return `<tr class="tas-row" data-id="${esc(t.id)}">
        <td><div class="crm-client-row"><span class="crm-client-avatar" style="background:${tasAvatarColor(avatarBase)}">${esc(tasInitials(avatarBase))}</span><div><strong>${esc(t.title || 'Sin título')}</strong>${typeChip}<div class="crm-meta">${meta}</div></div></div></td>
        <td><span class="tas-valor">${valuationStr}</span></td>
        <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
        <td><span class="tas-fecha">${date}</span></td>
        <td class="crm-td-actions">
          <button class="btn-action" title="Abrir" data-open-tasacion="${esc(t.id)}" data-tasacion-title="${esc(t.title || '')}"><i class="fas fa-external-link-alt"></i></button>
          <button class="btn-action" title="Exportar PDF" data-pdf-tasacion="${esc(t.id)}" data-tasacion-title="${esc(t.title || '')}"><i class="fas fa-file-pdf"></i></button>
          <button class="btn-action danger" title="Eliminar" data-del-tasacion="${esc(t.id)}"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }


    function upsertVisitRow(v) {
      const tbody = $('#visitsTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector('tr[data-id="' + v.id + '"]');
      const rowHtml = visitRowHtml(v);
      if (existing) {
        existing.outerHTML = rowHtml;
      } else {
        tbody.insertAdjacentHTML('afterbegin', rowHtml);
      }
    }

    function removeVisitRow(id) {
      const row = $('#visitsTableBody')?.querySelector('tr[data-id="' + id + '"]');
      if (row) row.remove();
    }

    function upsertPropertyRow(p) {
      const tbody = $('#propertiesTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector('tr[data-id="' + p.id + '"]');
      if (existing) {
        existing.outerHTML = buildPropertyRowHtml(p);
      } else {
        tbody.insertAdjacentHTML('afterbegin', buildPropertyRowHtml(p));
      }
    }

    function removePropertyRow(id) {
      const row = $('#propertiesTableBody')?.querySelector('tr[data-id="' + id + '"]');
      if (row) row.remove();
    }

    function upsertAgentRow(agent) {
      const tbody = $('#agentsTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector('tr[data-id="' + agent.id + '"]');
      if (existing) {
        existing.outerHTML = buildAgentRowHtml(agent);
      } else {
        tbody.insertAdjacentHTML('afterbegin', buildAgentRowHtml(agent));
      }
    }

    function removeAgentRow(id) {
      const row = $('#agentsTableBody')?.querySelector('tr[data-id="' + id + '"]');
      if (row) row.remove();
    }

    function upsertOwnerRow(owner) {
      const tbody = $('#ownersTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector('tr[data-id="' + owner.id + '"]');
      if (existing) {
        existing.outerHTML = buildOwnerRowHtml(owner);
      } else {
        tbody.insertAdjacentHTML('afterbegin', buildOwnerRowHtml(owner));
      }
    }

    function removeOwnerRow(id) {
      const row = $('#ownersTableBody')?.querySelector('tr[data-id="' + id + '"]');
      if (row) row.remove();
    }

    function upsertTasacionRow(t) {
      const tbody = $('#tasacionesTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector('tr[data-id="' + t.id + '"]');
      if (existing) {
        existing.outerHTML = buildTasacionRowHtml(t);
      } else {
        tbody.insertAdjacentHTML('afterbegin', buildTasacionRowHtml(t));
      }
    }

    function removeTasacionRow(id) {
      const row = $('#tasacionesTableBody')?.querySelector('tr[data-id="' + id + '"]');
      if (row) row.remove();
    }

    // Lead card helper (for CRM kanban)
    function upsertLeadCard(lead) {
      const _stageCol = { nuevo:'nuevos', contactado:'contactados', calificado:'contactados', visita_agendada:'visita', visita_realizada:'visita', negociacion:'oferta', cerrado_ganado:'oferta', cerrado_perdido:'oferta' };
      const stage = lead.stage || 'nuevo';
      const container = document.querySelector('#cards-' + (_stageCol[stage] || 'nuevos'));
      if (!container) return;
      const existing = container.querySelector('[data-lead-id="' + lead.id + '"]');
      if (existing) {
        existing.outerHTML = buildLeadCardHtml(lead);
      } else {
        container.insertAdjacentHTML('afterbegin', buildLeadCardHtml(lead));
      }
    }

    function removeLeadCard(id) {
      document.querySelectorAll('.lead-card[data-lead-id]').forEach(el => {
        if (el.dataset.leadId === id) el.remove();
      });
    }

  /* Lead selector del modal de visitas */
  async function loadVisitLeadSelect(selectedId = null) {
    const sel = $('#visitLeadSelectEl');
    if (!sel || !window.supabaseClient) return;
    try {
      const { data } = await window.supabaseClient
        .from('leads')
        .select('id, full_name, stage')
        .is('deleted_at', null)
        .not('stage', 'in', '("cerrado_ganado","cerrado_perdido")')
        .order('full_name');
      sel.innerHTML = '<option value="">— Sin lead (visita espontánea) —</option>' +
        (data || []).map(l => `<option value="${l.id}">${esc(l.full_name)}</option>`).join('');
      if (selectedId) sel.value = selectedId;
    } catch (_) { /* silent */ }
  }

  async function loadLeadContextForVisit(leadId) {
    const box = $('#visitLeadHistory');
    if (!box) return;
    if (!leadId) { box.style.display = 'none'; box.innerHTML = ''; return; }
    try {
      const { data, error } = await window.supabaseClient
        .from('lead_activities')
        .select('title, description, created_at')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })
        .limit(4);
      if (error || !data || !data.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.innerHTML = '<div style="font-size:11px; color:var(--text-dim); margin-bottom:6px; text-transform:uppercase; letter-spacing:.5px;">Historial reciente del lead</div>' +
        data.map(a => {
          const dd = new Date(a.created_at).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
          return '<div style="padding:5px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:12px;">'
            + '<strong style="color:var(--text-secondary);">' + esc(a.title || 'Nota') + '</strong>'
            + (a.description ? ' <span style="color:var(--text-dim);">' + esc(String(a.description).slice(0, 90)) + (a.description.length > 90 ? '…' : '') + '</span>' : '')
            + ' <span style="color:var(--text-dim); float:right; font-size:11px;">' + dd + '</span></div>';
        }).join('');
      box.style.display = 'block';
    } catch (_) { box.style.display = 'none'; }
  }

  /* Create visit */
  on($('#btnNewVisit'), 'click', () => {
    editingVisitId = null;
    const copyBtn = $('#visitCopyLinkBtn');
    if (copyBtn) copyBtn.style.display = 'none';
    const cbox = $('#visitConflictBox');
    if (cbox) cbox.style.display = 'none';
    const slotsWrap = $('#visitSlotsWrap');
    if (slotsWrap) slotsWrap.style.display = 'none';
    $('#visitForm')?.reset();
    loadAgentSelect($('#visitBrokerSelect'));
    loadPropertySelect($('#visitPropertySelect'));
    loadVisitLeadSelect();
    document.querySelectorAll('.visit-dur-chip').forEach(b => b.classList.toggle('is-active', b.dataset.min === '60'));
    openModal('visitModal');
  });

  /* openVisitModal — llamado desde CRM con pre-llenado */
  window.adminApp.openVisitModal = function (prefill = {}) {
    editingVisitId = null;
    const form = $('#visitForm');
    if (form) form.reset();

    loadAgentSelect($('#visitBrokerSelect'));
    loadVisitLeadSelect(prefill.lead_id || null);

    /* Pre-llenar desde CRM */
    if (prefill.visit_date) {
      const d = new Date(prefill.visit_date);
      setVisitDateParts(d);

    }
    if (prefill.client_name) {
      const el = document.querySelector('#visitForm [name="client_name"]');
      if (el) el.value = prefill.client_name;
    }
    if (prefill.client_phone) {
      const el = document.querySelector('#visitForm [name="client_phone"]');
      if (el) el.value = prefill.client_phone;
    }
    if (prefill.client_email) {
      const el = document.querySelector('#visitForm [name="client_email"]');
      if (el) el.value = prefill.client_email;
    }
    if (prefill.duration_minutes) {
      const el = document.querySelector('#visitForm [name="duration_minutes"]');
      if (el) el.value = prefill.duration_minutes;
    }
    if (prefill.agent_id) {
      const el = document.querySelector('#visitForm [name="agent_id"]');
      if (el) el.value = prefill.agent_id;
    }
    if (prefill.property_id) {
      loadPropertySelect($('#visitPropertySelect'), prefill.property_id);
    } else {
      loadPropertySelect($('#visitPropertySelect'));
    }


    openModal('visitModal');
  };

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
  let _submittingVisit = false;

  function initVisitDateFields() {
    ['visitDateDay', 'visitDateTime'].forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.dataset.bound) { el.dataset.bound = '1'; el.addEventListener('change', syncVisitDateHidden); }
    });
  }

  function setVisitDateParts(d) {
    const dateEl = $('#visitDateDay');
    const timeEl = $('#visitDateTime');
    if (dateEl) dateEl.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (timeEl) timeEl.value = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    syncVisitDateHidden();
  }

  function syncVisitDateHidden() {
    const hidden = $('#visitForm') ? $('#visitForm').elements['visit_date'] : null;
    if (!hidden) return;
    const day = $('#visitDateDay')?.value;
    const time = $('#visitDateTime')?.value;
    hidden.value = (day && time) ? (day + 'T' + time) : '';
  }

  initVisitDateFields();

  /* Chips de duración: 1 click fija el campo */
  document.querySelectorAll('.visit-dur-chip').forEach(btn => {
    btn.addEventListener('click', function () {
      const input = $('#visitForm')?.elements['duration_minutes'];
      if (input) input.value = this.dataset.min;
      document.querySelectorAll('.visit-dur-chip').forEach(b => b.classList.toggle('is-active', b === this));
    });
  });

  /* Huecos del broker: al elegir broker+fecha, listar su agenda de ese día */
  async function refreshBrokerSlots() {
    const wrap = $('#visitSlotsWrap');
    const hint = $('#visitSlotsHint');
    if (!wrap || !hint) return;
    const agentId = $('#visitBrokerSelect')?.value;
    const dateVal = $('#visitDateDay')?.value;
    if (!agentId || !dateVal || !window.supabaseClient) { wrap.style.display = 'none'; return; }
    try {
      const dayStart = new Date(dateVal + 'T00:00:00');
      const dayEnd = new Date(dateVal + 'T23:59:59');
      const { data } = await window.supabaseClient.from('visits')
        .select('id, client_name, visit_date, duration_minutes')
        .eq('agent_id', agentId)
        .is('deleted_at', null)
        .in('status', ['pendiente', 'confirmada'])
        .gte('visit_date', dayStart.toISOString())
        .lte('visit_date', dayEnd.toISOString())
        .order('visit_date', { ascending: true });
      const busy = (data || []).filter(v => v.id !== editingVisitId);
      wrap.style.display = 'block';
      if (!busy.length) {
        hint.innerHTML = '<span style="color:var(--success);">✔ Broker libre todo el día.</span>';
        return;
      }
      const lines = busy.map(v => {
        const t = new Date(v.visit_date);
        const end = new Date(t.getTime() + (v.duration_minutes || 60) * 60000);
        const fmt = d => d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        return `<div>⏰ ${fmt(t)}–${fmt(end)} — ${esc(v.client_name || 'Visitante')}</div>`;
      }).join('');
      hint.innerHTML = '<strong style="color:var(--warning);">Ocupado:</strong>' + lines;
    } catch (_) { wrap.style.display = 'none'; }
  }
  $('#visitBrokerSelect')?.addEventListener('change', refreshBrokerSlots);
  $('#visitDateDay')?.addEventListener('change', refreshBrokerSlots);

  /* Google Calendar: link de "agregar evento" con los datos del modal */
  $('#visitGCalBtn')?.addEventListener('click', function () {
    const form = $('#visitForm');
    if (!form) return;
    const hidden = form.elements['visit_date'];
    syncVisitDateHidden();
    const raw = hidden && hidden.value;
    if (!raw) { showToast('Elegí fecha y hora primero.', 'warning'); return; }
    const start = new Date(raw);
    const durMin = parseInt(form.elements['duration_minutes']?.value || '60', 10) || 60;
    const end = new Date(start.getTime() + durMin * 60000);
    const fmtG = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const propSel = $('#visitPropertySelect');
    const propText = propSel && propSel.selectedIndex > 0 ? propSel.options[propSel.selectedIndex].text : '';
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: 'Visita: ' + (form.elements['client_name']?.value || 'Cliente'),
      details: (propText ? 'Propiedad: ' + propText + '\n' : '') + (form.elements['notes']?.value || ''),
      dates: fmtG(start) + '/' + fmtG(end),
    });
    window.open('https://calendar.google.com/calendar/render?' + params.toString(), '_blank', 'noopener');
  });

  /* Aviso si la visita está en el pasado */
  $('#visitForm')?.addEventListener('submit', function (e) {
    syncVisitDateHidden();
    const raw = e.target.elements['visit_date']?.value;
    if (raw && new Date(raw).getTime() < Date.now() - 60000) {
      if (!confirm('La visita está en el pasado. ¿Guardar igual?')) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
  }, true);

  on($('#visitForm'), 'submit', async (e) => {
    e.preventDefault();
    if (_submittingVisit) return;
    _submittingVisit = true;
    const btn = $('#visitSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const oldVisit = editingVisitId
        ? (await window.supabaseClient.from('visits').select('status, lead_id').eq('id', editingVisitId).single()).data
        : null;
      const oldStatus = oldVisit?.status ?? null;
      const oldLeadId = oldVisit?.lead_id ?? null;

      const formData = new FormData(e.target);
      
      // Zod validation
      const validated = validateForm(VisitSchema, formData);
      const data = {
        visit_date: validated.visit_date,
        status: validated.status,
        client_name: validated.client_name,
        client_phone: validated.client_phone,
        client_email: validated.client_email,
        notes: validated.notes,
        lead_id: validated.lead_id ?? null,
        property_id: validated.property_id,
        agent_id: validated.agent_id,
        duration_minutes: validated.duration_minutes,
      };

      /* Conflict detection: mismo broker O misma propiedad, horarios solapados */
      if ((data.agent_id || data.property_id) && data.visit_date && data.duration_minutes) {
        const visitStart = new Date(data.visit_date).getTime();
        const visitEnd = visitStart + data.duration_minutes * 60 * 1000;
        let cq = window.supabaseClient
          .from('visits')
          .select('id, client_name, visit_date, duration_minutes, agent_id, property_id')
          .in('status', ['pendiente', 'confirmada', 'en_curso'])
          .is('deleted_at', null)
          .neq('id', editingVisitId || '00000000-0000-0000-0000-000000000000');
        const parts = [];
        if (data.agent_id) parts.push('agent_id.eq.' + data.agent_id);
        if (data.property_id) parts.push('property_id.eq.' + data.property_id);
        cq = cq.or(parts.join(','));
        const { data: probConflicts } = await cq;
        const conflict = (probConflicts || []).find(c => {
          const cStart = new Date(c.visit_date).getTime();
          const cEnd = cStart + (c.duration_minutes || 60) * 60 * 1000;
          return visitStart < cEnd && visitEnd > cStart;
        });
        if (conflict) {
          const motivo = data.agent_id && conflict.agent_id === data.agent_id
            ? `el broker ya tiene una visita (${conflict.client_name || 'otra'})`
            : 'la propiedad ya tiene una visita';
          showToast(`Conflicto de agenda: ${motivo} en ese horario`, 'warning', 6000);
          const box = $('#visitConflictBox');
          if (box) {
            const cStart = new Date(conflict.visit_date);
            box.innerHTML = '⚠ ' + esc(motivo) + ' el ' + cStart.toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) +
              ' <button type="button" class="btn-action" style="margin-left:8px; padding:4px 10px; font-size:11px;" id="visitConflictOpen">Ver</button>';
            box.style.display = 'block';
            box.querySelector('#visitConflictOpen').onclick = (ev) => {
              ev.preventDefault();
              closeModal('visitModal');
              window.adminApp.editVisit(conflict.id);
            };
          }
          return;
        }
      }

      const newStatus = data.status;
      const newLeadId = data.lead_id;
      const leadIdChanged = oldLeadId !== newLeadId;

      if (editingVisitId) {
        await mutate('visits', async () => {
          const { error } = await window.supabaseClient.from('visits').update(data).eq('id', editingVisitId);
          if (error) throw error;
        });
        showToast('Visita actualizada', 'success');
      } else {
        /* Generate confirmation_token for new visit */
        const confirmation_token = crypto.randomUUID();
        const insertData = { ...data, confirmation_token };
        let inserted = null;
        await mutate('visits', async () => {
          const { data: insertedData, error } = await window.supabaseClient.from('visits').insert([insertData]).select('id').single();
          if (error) throw error;
          inserted = insertedData;
        });
        showToast('Visita agendada', 'success');
        if (inserted?.id && data.lead_id) {
          try {
            await window.supabaseClient.from('lead_activities').insert([{
              lead_id: data.lead_id,
              activity_type: 'note',
              title: 'Visita agendada desde el panel',
              description: new Date(data.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
            }]);
          } catch (_) {}
        }
        /* Link de confirmación: siempre se copia; con email avisa, con teléfono ofrece WhatsApp */
        if (inserted?.id) {
          const confirmUrl = `${window.location.origin}/confirmar-visita.html?token=${confirmation_token}`;
          navigator.clipboard.writeText(confirmUrl).catch(() => {});
          const waPhone = (window.BH_CRM && window.BH_CRM.waNumber && window.BH_CRM.waNumber(data.client_phone)) || null;
          if (waPhone) {
            const wa = `https://wa.me/${waPhone}?text=` + encodeURIComponent(`Hola ${data.client_name}, te comparto el link para confirmar tu visita: ${confirmUrl}`);
            showToast('Link copiado. Abrir WhatsApp al cliente…', 'info', 6000);
            window.open(wa, '_blank', 'noopener');
          } else {
            showToast(`Link de confirmación copiado al portapapeles`, 'info', 8000);
          }
        }
      }

      /* Prompt: visita completada ? mover lead a Oferta */
      if (newStatus === 'completada' && oldStatus !== 'completada' && newLeadId) {
        try {
          const { data: leadData } = await window.supabaseClient
            .from('leads')
            .select('stage')
            .eq('id', newLeadId)
            .single();
          if (leadData && leadData.stage === 'visita_agendada') {
            const confirmMove = confirm('¿Mover el lead a "Negociación"?');
            if (confirmMove) {
              await window.supabaseClient
                .from('leads')
                .update({ stage: 'negociacion', updated_at: new Date().toISOString() })
                .eq('id', newLeadId);
              showToast('Lead movido a Negociación', 'success');
            }
          }
        } catch (_) {}
      }

      /* Si se asignó lead_id nuevo (era NULL) ? el trigger DB actualizará lead a "visita" */
      /* Si se quitó lead_id (era valor ? NULL) ? no hacemos nada en lead */

      closeModal('visitModal');
      loadAgenda();
      loadCRM(); // Refrescar CRM por si cambió stage
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      _submittingVisit = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Confirmar Cita'; }
    }
  });

  // ============================================================
  // ANOMALÍAS ESTADÍSTICAS
  // ============================================================
  let _anomCursor = null; // { created_at, id }
  let _anomHasMore = true;
  let _anomTimeWindow = '1 hour';
  let _anomSeverityFilter = '';

  async function loadAnomaliesTable(append = false) {
    if (!window.supabaseClient) return;
    const tbody = $('#anomTableBody');
    const loadMoreBtn = $('#anomLoadMore');
    if (!tbody) return;
    if (!append) {
      tbody.innerHTML = '<tr><td colspan="12" style="padding:40px; text-align:center; color:var(--text-dim);">Cargando...</td></tr>';
      _anomCursor = null;
      _anomHasMore = true;
    }
    try {
      const timeWindow = $('#anomTimeWindow')?.value || '1 hour';
      const severityFilter = $('#anomSeverityFilter')?.value || '';
      
      let query = window.supabaseClient
        .from('supervision_anomalies')
        .select('*')
        .eq('time_window', timeWindow)
        .order('created_at', { ascending: false })
        .limit(51); // 51 para detectar hasMore
      
      if (severityFilter) {
        query = query.eq('severity', severityFilter);
      }
      
      // Cursor-based pagination
      if (_anomCursor) {
        query = query.or(`created_at.lt.${_anomCursor.created_at},and(created_at.eq.${_anomCursor.created_at},id.lt.${_anomCursor.id})`);
      }

      const { data, error } = await query;
      if (error) throw error;
      const anomalies = data || [];
      const hasMore = anomalies.length > 50;
      const rows = hasMore ? anomalies.slice(0, 50) : anomalies;
      _anomHasMore = hasMore;
      if (rows.length) {
        _anomCursor = { created_at: rows[rows.length - 1].created_at, id: rows[rows.length - 1].id };
      }

      const severityColors = { critical: '#EF4444', high: '#F97316', medium: '#FFB800', low: '#3B82F6', info: '#1FC8C3' };
      const severityLabels = { critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja', info: 'Info' };
      const statusLabels = { open: 'Abierta', acknowledged: 'Reconocida', investigating: 'Investigando', resolved: 'Resuelta', dismissed: 'Descartada', false_positive: 'Falso Positivo' };
      const statusPillClass = {
        open: 'pending', acknowledged: 'active', investigating: 'active',
        resolved: 'success', dismissed: 'pending', false_positive: 'pending'
      };

      const renderRows = rows.map(a => {
        const color = severityColors[a.severity] || 'var(--text-secondary)';
        const userLabel = a.user_id ? `${a.user_id.slice(0,8)}...` : 'sistema';
        return `<tr style="border-bottom:1px solid var(--border-subtle);">
          <td style="padding:8px 10px;"><span style="color:${color}; font-weight:600;">${severityLabels[a.severity] || a.severity}</span></td>
          <td style="padding:8px 10px; color:var(--accent);">${esc(a.module || '—')}</td>
          <td style="padding:8px 10px; color:var(--text-secondary);">${esc(userLabel)}</td>
          <td style="padding:8px 10px; color:var(--text-secondary);">${esc(a.action || '—')}</td>
          <td style="padding:8px 10px; color:var(--text-secondary);">${esc(a.metric || '—')}</td>
          <td style="padding:8px 10px; text-align:center; color:var(--text-secondary);">${esc(a.time_window || '—')}</td>
          <td style="padding:8px 10px; text-align:right; color:#fff; font-weight:600; font-family:monospace; font-size:11px;">${a.observed_value ? a.observed_value.toLocaleString('es-AR') : '—'}</td>
          <td style="padding:8px 10px; text-align:right; color:var(--text-secondary); font-family:monospace; font-size:11px;">${a.expected_mean ? a.expected_mean.toFixed(2) : '—'}</td>
          <td style="padding:8px 10px; text-align:center; color:#fff; font-family:monospace; font-size:11px;">${a.z_score !== null && a.z_score !== undefined ? a.z_score.toFixed(2) : '—'}</td>
          <td style="padding:8px 10px; text-align:center; color:var(--accent); font-weight:600; font-size:11px;">${a.percentile_rank !== null && a.percentile_rank !== undefined ? a.percentile_rank.toFixed(1) + '%' : '—'}</td>
          <td style="padding:8px 10px; text-align:center;"><span class="status-pill ${statusPillClass[a.status] || 'pending'}" style="font-size:10px;">${statusLabels[a.status] || a.status}</span></td>
          <td style="padding:8px 10px; text-align:center;">
            <div style="display:flex; gap:4px; justify-content:center; flex-wrap:wrap;">
              ${a.status === 'open' ? `
                <button class="btn-action" onclick="acknowledgeAnomaly('${esc(a.id)}')" title="Reconocer"><i class="fas fa-check"></i></button>
              ` : ''}
              ${(a.status === 'acknowledged' || a.status === 'investigating') ? `
                <button class="btn-action" onclick="resolveAnomaly('${esc(a.id)}')" title="Marcar resuelta"><i class="fas fa-flag-checkered"></i></button>
              ` : ''}
              ${(a.status === 'open' || a.status === 'acknowledged' || a.status === 'investigating') ? `
                <button class="btn-action" onclick="dismissAnomaly('${esc(a.id)}')" title="Descartar"><i class="fas fa-times"></i></button>
              ` : ''}
              ${a.status === 'false_positive' ? `
                <button class="btn-action" onclick="reopenAnomaly('${esc(a.id)}')" title="Reabrir"><i class="fas fa-undo"></i></button>
              ` : ''}
              <button class="btn-action" onclick="viewAnomalyDetail('${esc(a.id)}')" title="Ver detalle"><i class="fas fa-eye"></i></button>
            </div>
          </td>
        </tr>`;
      }).join('');

      if (append) {
        tbody.innerHTML += renderRows;
      } else {
        tbody.innerHTML = renderRows;
      }

      if (loadMoreBtn) {
        loadMoreBtn.style.display = _anomHasMore ? 'inline-flex' : 'none';
      }
    } catch (err) {
      logError('loadAnomaliesTable error:', err);
      tbody.innerHTML = '<tr><td colspan="12" style="padding:40px; text-align:center; color:var(--danger);">Error cargando anomalías</td></tr>';
      if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    }
  }

  window.loadMoreAnomalies = function() {
    loadAnomaliesTable(true);
  };

  window.acknowledgeAnomaly = async function(id) {
    if (!window.supabaseClient) return;
    try {
      await window.supabaseClient.from('supervision_anomalies').update({ status: 'acknowledged', acknowledged_by: currentUser.id, acknowledged_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
      showToast('Anomalía reconocida', 'success');
      loadAnomaliesTable();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.resolveAnomaly = async function(id) {
    if (!window.supabaseClient) return;
    try {
      await window.supabaseClient.from('supervision_anomalies').update({ status: 'resolved', resolved_by: currentUser.id, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
      showToast('Anomalía marcada como resuelta', 'success');
      loadAnomaliesTable();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.dismissAnomaly = async function(id) {
    if (!window.supabaseClient) return;
    try {
      await window.supabaseClient.from('supervision_anomalies').update({ status: 'dismissed', dismissed_by: currentUser.id, dismissed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
      showToast('Anomalía descartada', 'success');
      loadAnomaliesTable();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.reopenAnomaly = async function(id) {
    if (!window.supabaseClient) return;
    try {
      await window.supabaseClient.from('supervision_anomalies').update({ status: 'open', updated_at: new Date().toISOString() }).eq('id', id);
      showToast('Anomalía reabierta', 'success');
      loadAnomaliesTable();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.viewAnomalyDetail = async function(id) {
    if (!window.supabaseClient) return;
    try {
      const { data } = await window.supabaseClient.from('supervision_anomalies').select('*').eq('id', id).single();
      if (!data) return;
      const severityColors = { critical: '#EF4444', high: '#F97316', medium: '#FFB800', low: '#3B82F6', info: '#1FC8C3' };
      const severityLabels = { critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja', info: 'Info' };
      const statusLabels = { open: 'Abierta', acknowledged: 'Reconocida', investigating: 'Investigando', resolved: 'Resuelta', dismissed: 'Descartada', false_positive: 'Falso Positivo' };
      const color = severityColors[data.severity] || 'var(--text-secondary)';
      
      // Show in a modal
      let modal = $('#anomDetailModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'anomDetailModal';
        modal.className = 'admin-modal';
        modal.innerHTML = `
          <div class="modal-box" style="max-width:600px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px;">
              <h3 id="anomDetailTitle" style="font-family:var(--font-heading); font-size:22px; color:#fff; margin:0;"></h3>
              <button type="button" class="status-pill pending" onclick="closeModal('anomDetailModal')"><i class="fas fa-times"></i></button>
            </div>
            <div id="anomDetailContent" style="max-height:70vh; overflow-y:auto;"></div>
          </div>
        `;
        document.body.appendChild(modal);
      }
      $('#anomDetailTitle').textContent = `Anomalía: ${data.module} · ${data.action}`;
      $('#anomDetailContent').innerHTML = `
        <div style="line-height:1.8; font-size:13px;">
          <div><strong>ID:</strong> <code style="color:var(--accent);">${esc(data.id)}</code></div>
          <div><strong>Severidad:</strong> <span style="color:${color}; font-weight:600;">${severityLabels[data.severity] || data.severity}</span></div>
          <div><strong>Estado:</strong> <span style="color:var(--accent);">${esc(data.status)}</span></div>
          <div><strong>Módulo:</strong> <span style="color:var(--accent);">${esc(data.module || '—')}</span></div>
          <div><strong>Acción:</strong> ${esc(data.action || '—')}</div>
          <div><strong>Métrica:</strong> ${esc(data.metric || '—')}</div>
          <div><strong>Ventana:</strong> ${esc(data.time_window || '—')}</div>
          <hr style="margin:12px 0; border-color:var(--border-subtle);">
          <div><strong>Valor observado:</strong> <span style="color:#fff; font-family:monospace; font-weight:600;">${data.observed_value ? data.observed_value.toLocaleString('es-AR') : '—'}</span></div>
          <div><strong>Valor esperado (media):</strong> <span style="color:var(--text-secondary); font-family:monospace;">${data.expected_mean ? data.expected_mean.toFixed(2) : '—'}</span></div>
          <div><strong>Desviación estándar:</strong> <span style="color:var(--text-secondary); font-family:monospace;">${data.expected_stddev !== null ? data.expected_stddev.toFixed(2) : '—'}</span></div>
          <div><strong>Z-Score:</strong> <span style="color:${data.z_score !== null ? (Math.abs(data.z_score) > 2 ? '#EF4444' : 'var(--accent)') : 'var(--text-secondary)'}; font-family:monospace; font-weight:600;">${data.z_score !== null ? data.z_score.toFixed(2) : '—'}</span></div>
          <div><strong>Percentil:</strong> <span style="color:var(--accent); font-weight:600;">${data.percentile_rank !== null ? data.percentile_rank.toFixed(1) + '%' : '—'}</span></div>
          <div><strong>Evidencia:</strong><pre style="background:rgba(255,255,255,0.03); padding:12px; border-radius:8px; font-size:11px; overflow:auto; max-height:200px; margin-top:8px;">${esc(JSON.stringify(data.evidence || {}, null, 2))}</pre></div>
          <hr style="margin:16px 0; border-color:var(--border-subtle);">
          <div><strong>Creada:</strong> ${data.created_at ? new Date(data.created_at).toLocaleString('es-AR') : '—'}</div>
          <div><strong>Reconocida:</strong> ${data.acknowledged_at ? new Date(data.acknowledged_at).toLocaleString('es-AR') : '—'}</div>
          <div><strong>Resuelta:</strong> ${data.resolved_at ? new Date(data.resolved_at).toLocaleString('es-AR') : '—'}</div>
        </div>
      `;
      openModal('anomDetailModal');
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };


/* Edit visit */
  window.adminApp.copyVisitLink = async function (id) {
  try {
    const { data, error } = await window.supabaseClient
      .from('visits').select('confirmation_token, client_email').eq('id', id).single();
    if (error) throw error;
    if (!data?.confirmation_token) { showToast('Esta visita no tiene link de confirmación.', 'error'); return; }
    const url = `${window.location.origin}/confirmar-visita.html?token=${data.confirmation_token}`;
    try { await navigator.clipboard.writeText(url); showToast('Link copiado: ' + url, 'success', 6000); }
    catch (_) { window.prompt('Copiá este link:', url); }
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
};

window.adminApp.editVisit = async function (id) {
    try {
      const { data, error } = await window.supabaseClient
        .from('visits')
        .select('*, leads!left(id, full_name, stage, phone, whatsapp, property_id)')
        .eq('id', id)
        .single();
      if (error) throw error;

      editingVisitId = id;
      const form = $('#visitForm');
      const lead = data.leads;
      const copyBtn = $('#visitCopyLinkBtn');
      if (copyBtn) {
        copyBtn.style.display = data.confirmation_token ? 'inline-flex' : 'none';
        copyBtn.onclick = (e) => { e.preventDefault(); window.adminApp.copyVisitLink(id); };
      }

      if (form) {
        /* Cargar brokers en dropdown existente */
        await loadAgentSelect($('#visitBrokerSelect'), data.agent_id);
        await loadPropertySelect($('#visitPropertySelect'), data.property_id);

        if (data.visit_date) {
          const d = new Date(data.visit_date);
          setVisitDateParts(d);
        }
        form.elements.status.value = data.status || 'pendiente';
        form.elements.client_name.value = data.client_name || '';
        form.elements.client_phone.value = data.client_phone || '';
        form.elements.client_email.value = data.client_email || '';
        form.elements.duration_minutes.value = data.duration_minutes || 60;
        form.elements.agent_id.value = data.agent_id || '';
        form.elements.notes.value = data.notes || '';

        /* Selector de lead (estático en el modal) con auto-relleno */
        const leadSelect = $('#visitLeadSelectEl');
        await loadVisitLeadSelect(data.lead_id || null);

        if (leadSelect && !leadSelect.dataset.autofillBound) {
          leadSelect.dataset.autofillBound = '1';
          leadSelect.addEventListener('change', async (e) => {
            const selectedId = e.target.value;
            loadLeadContextForVisit(selectedId || null);
            if (!selectedId) return;
            try {
              const { data: leadData } = await window.supabaseClient
                .from('leads')
                .select('full_name, stage, phone, whatsapp, property_id')
                .eq('id', selectedId)
                .single();
              if (leadData) {
                if (!form.elements.client_name.value) form.elements.client_name.value = leadData.full_name || '';
                if (!form.elements.client_phone.value) form.elements.client_phone.value = leadData.phone || leadData.whatsapp || '';
                if (leadData.property_id && !form.elements.property_id.value) {
                  await loadPropertySelect($('#visitPropertySelect'), leadData.property_id);
                }
              }
            } catch (_) {}
          });
        }
        if (data.lead_id) { leadSelect.dispatchEvent(new Event('change')); }
      }

      openModal('visitModal');
    } catch (err) {
      logError('Error al cargar visita:', err);
      showToast('Error al cargar visita', 'error');
    }
  };

  /* Delete visit */
  window.adminApp.deleteVisit = async function (id) {
    if (!confirm('¿Eliminar esta visita? Queda en baja lógica (recuperable desde la DB).')) return;
    try {
      const { error } = await window.supabaseClient.from('visits').update({ deleted_at: new Date().toISOString(), status: 'cancelada' }).eq('id', id);
      if (error) throw error;
      showToast('Visita eliminada (baja lógica)', 'success');
      loadAgenda();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  /* Check-in / Check-out */
  window.adminApp.checkinVisit = async function (id) {
    try {
      const { error } = await window.supabaseClient
        .from('visits')
        .update({ check_in: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      showToast('Llegada registrada', 'success');
      loadAgenda();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.adminApp.checkoutVisit = async function (id) {
    try {
      const { error } = await window.supabaseClient
        .from('visits')
        .update({ check_out: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      showToast('Salida registrada', 'success');
      loadAgenda();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  /* Export ICS / CSV */
  function generateICS(visits) {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//BIENENHAUS//Agenda de Visitas//ES',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH'
    ];
    visits.forEach(v => {
      const dtStart = new Date(v.visit_date).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const dtEnd = new Date(new Date(v.visit_date).getTime() + (v.duration_minutes || 60) * 60 * 1000)
        .toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const uid = v.id + '@bienenhaus.com.ar';
      const summary = 'Visita: ' + (v.client_name || 'Sin cliente');
      const description = [
        'Cliente: ' + (v.client_name || 'Sin cliente'),
        'Teléfono: ' + (v.client_phone || '—'),
        'Email: ' + (v.client_email || '—'),
        'Broker: ' + (v.agents?.full_name || 'Por asignar'),
        'Estado: ' + (v.status || 'pendiente'),
        v.notes ? 'Notas: ' + v.notes : ''
      ].filter(Boolean).join('\\n');
      const location = v.property_id ? 'Propiedad asignada' : 'Por confirmar';
      lines.push(
        'BEGIN:VEVENT',
        'UID:' + uid,
        'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z',
        'DTSTART:' + dtStart,
        'DTEND:' + dtEnd,
        'SUMMARY:' + summary,
        'DESCRIPTION:' + description,
        'LOCATION:' + location,
        'STATUS:' + (v.status === 'confirmada' ? 'CONFIRMED' : v.status === 'cancelada' ? 'CANCELLED' : 'TENTATIVE'),
        'END:VEVENT'
      );
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  function generateCSV(visits) {
    const headers = ['Fecha', 'Hora', 'Cliente', 'Teléfono', 'Email', 'Broker', 'Estado', 'Propiedad', 'Lead', 'Notas', 'Check-in', 'Check-out'];
    const rows = visits.map(v => {
      const d = v.visit_date ? new Date(v.visit_date) : null;
      const fecha = d ? d.toLocaleDateString('es-AR') : '';
      const hora = d ? d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
      const checkin = v.check_in ? new Date(v.check_in).toLocaleTimeString('es-AR') : '';
      const checkout = v.check_out ? new Date(v.check_out).toLocaleTimeString('es-AR') : '';
      return [
        fecha,
        hora,
        v.client_name || '',
        v.client_phone || '',
        v.client_email || '',
        v.agents?.full_name || '',
        v.status || '',
        v.property_id ? 'Sí' : 'No',
        v.leads?.full_name || '',
        (v.notes || '').replace(/\n/g, ' '),
        checkin,
        checkout
      ].map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',');
    });
    return [headers.join(','), ...rows].join('\n');
  }

  window.adminApp.exportVisitsICS = async function() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('visits')
        .select('*, agents(full_name), leads(full_name)')
        .order('visit_date', { ascending: true });
      if (error) throw error;
      const ics = generateICS(data || []);
      const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'agenda-visitas-' + new Date().toISOString().slice(0,10) + '.ics';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Archivo .ics descargado', 'success');
    } catch (err) {
      showToast('Error exportando ICS: ' + err.message, 'error');
    }
  };

  window.adminApp.exportVisitsCSV = async function() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('visits')
        .select('*, agents(full_name), leads(full_name)')
        .order('visit_date', { ascending: true });
      if (error) throw error;
      const csv = generateCSV(data || []);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'agenda-visitas-' + new Date().toISOString().slice(0,10) + '.csv';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Archivo .csv descargado', 'success');
    } catch (err) {
      showToast('Error exportando CSV: ' + err.message, 'error');
    }
  };

  /* Event listeners for export buttons */
  $('#btnExportICS')?.addEventListener('click', window.adminApp.exportVisitsICS);
  $('#btnExportCSV')?.addEventListener('click', window.adminApp.exportVisitsCSV);

  /* ------------------------------------------------
     9. CMS EDITOR
     ------------------------------------------------ */
  let cmsData = {};
  let _cmsDirty = false;
  const _cmsDirtyFields = new Set();
  function cmsMarkDirty(key, value) {
    _cmsDirty = true;
    if (value !== undefined && String(value).trim() !== '') _cmsDirtyFields.add(key);
    else _cmsDirtyFields.delete(key);
    cmsUpdateDirtyUI();
  }
  function cmsUpdateDirtyUI() {
    const btn = $('#cmsSaveBtn');
    if (!btn) return;
    const n = _cmsDirtyFields.size;
    if (_cmsDirty && n > 0) {
      btn.classList.add('has-changes');
      btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar (' + n + ')';
    } else {
      btn.classList.remove('has-changes');
      btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar Cambios Web';
    }
  }

  const CMS_FIELD_MAP = {
    hero_line1:    { section: 'hero', path: 'title' },
    hero_line2:    { section: 'hero', path: 'subtitle' },
    hero_eyebrow:  { section: 'hero', path: 'eyebrow' },
    hero_desc:     { section: 'hero', path: 'description' },
    hero_bg:       { section: 'hero', path: 'bg_image_url' },
    hero_video:    { section: 'hero', path: 'video_url' },
    serv_title:    { section: 'services', path: 'title' },
    serv_badge:    { section: 'services', path: 'badge' },
    serv_desc:     { section: 'services', path: 'description' },
    team_title:    { section: 'team', path: 'title' },
    stat1_val:     { section: 'stats', path: 'properties_sold' },
    stat1_title:   { section: 'stats', path: 'stat1_label' },
    proc_title:    { section: 'process', path: 'title' }
  };

  const SECTION_ID_TO_DB_KEY = {
    hero: 'hero',
    catalogo: 'catalog',
    servicios: 'services',
    equipo: 'team',
    stats: 'stats',
    proceso: 'process',
    contacto: 'contact',
    formulario: 'form',
    navbar: 'navbar',
    footer: 'footer',
    seo: 'seo',
    nosotros: 'nosotros'
  };

  async function loadCMS() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('site_content')
        .select('*');

      if (error) throw error;

      cmsData = {};
      (data || []).forEach(item => {
        cmsData[item.section_key] = item;
      });

      populateCMSFields();
      cmsPopulateNested();
      cmsLastSavedInfo();
    } catch (err) {
      logError('CMS error:', err);
    }
  }

  const CMS_NESTED_SCHEMAS = {
    services_items: ['cmsServicesItems', [{ key: 'icon', label: 'Icono (clase FA)', placeholder: 'fas fa-home' }, { key: 'title', label: 'Título', placeholder: 'Venta' }, { key: 'desc', label: 'Descripción', placeholder: 'Estrategia personalizada...' }]],
    proceso_pasos: ['cmsProcessSteps', [{ key: 'num', label: 'Número', placeholder: '01' }, { key: 'title', label: 'Título', placeholder: 'Tasación' }, { key: 'desc', label: 'Descripción', placeholder: 'Analizamos tu propiedad...' }]],
    navbar_items: ['cmsNavbarItems', [{ key: 'label', label: 'Etiqueta', placeholder: 'Inicio' }, { key: 'url', label: 'URL / Ancla', placeholder: '#hero' }]],
    navbar_mobile_items: ['cmsNavbarMobileItems', [{ key: 'label', label: 'Etiqueta', placeholder: 'Inicio' }, { key: 'url', label: 'URL / Ancla', placeholder: '#hero' }]],
    form_options: ['cmsFormOptions', [{ key: 'value', label: 'Valor', placeholder: 'comprar' }, { key: 'label', label: 'Etiqueta', placeholder: 'Quiero comprar' }]],
    form_fields: ['cmsFormFields', [{ key: 'name', label: 'Nombre del campo (id)', placeholder: 'phone' }, { key: 'label', label: 'Etiqueta', placeholder: 'Teléfono' }, { key: 'type', label: 'Tipo', placeholder: 'tel' }]],
    footer_nav_links: ['cmsFooterNavLinks', [{ key: 'label', label: 'Etiqueta', placeholder: 'Propiedades' }, { key: 'url', label: 'URL / Ancla', placeholder: '#propiedades' }]],
    footer_service_links: ['cmsFooterServiceLinks', [{ key: 'label', label: 'Etiqueta', placeholder: 'Ventas' }, { key: 'url', label: 'URL / Ancla', placeholder: '#servicios' }]],
    nosotros_valores: ['cmsNosotrosValores', [{ key: 'icon', label: 'Icono (clase FA)', placeholder: 'fas fa-scale-balanced' }, { key: 'title', label: 'Título', placeholder: 'Honestidad y Transparencia' }, { key: 'desc', label: 'Descripción', placeholder: 'Hablar siempre con la verdad...' }]],
  };

  function cmsPopulateNested() {
    for (const [key, [containerId, schema]] of Object.entries(CMS_NESTED_SCHEMAS)) {
      const container = document.getElementById(containerId);
      if (!container) continue;
      container.innerHTML = '';
      const SECTION_KEYS = {
        services_items: 'services',
        proceso_pasos: 'process',
        navbar_items: 'navbar',
        navbar_mobile_items: 'navbar',
        form_options: 'form',
        form_fields: 'form',
        footer_nav_links: 'footer',
        footer_service_links: 'footer',
        nosotros_valores: 'nosotros',
      };
      const list = (cmsData[SECTION_KEYS[key]]?.content || {})[key];
      if (Array.isArray(list)) list.forEach(v => cmsAddListItem(containerId, schema, v));
    }
  }

  function cmsPopulateNested() {
    for (const [key, [containerId, schema]] of Object.entries(CMS_NESTED_SCHEMAS)) {
      const container = document.getElementById(containerId);
      if (!container) continue;
      container.innerHTML = '';
      for (const sec of Object.values(cmsData)) {
        const list = sec?.content?.[key];
        if (Array.isArray(list)) list.forEach(v => cmsAddListItem(containerId, schema, v));
      }
    }
  }

  function populateCMSFields() {
    _cmsDirty = false;
    _cmsDirtyFields.clear();
    $$('.cms-field[data-key]').forEach(input => {
      const key = input.dataset.key;
      const mapping = CMS_FIELD_MAP[key];
      if (mapping && cmsData[mapping.section]) {
        const content = cmsData[mapping.section].content || {};
        input.value = content[mapping.path] || '';
        return;
      }
      const sectionEl = input.closest('.cms-section-content');
      if (sectionEl) {
        const domId = sectionEl.id.replace('cms-', '');
        const dbSection = SECTION_ID_TO_DB_KEY[domId];
        if (dbSection && cmsData[dbSection]) {
          const content = cmsData[dbSection].content || {};
          input.value = content[key] || '';
        }
      }
    });
    cmsUpdateDirtyUI();
    if (heroBgHidden?.value && heroBgPreview) {
      heroBgPreview.innerHTML = '<img src="' + esc(heroBgHidden.value) + '" alt="Hero background" />';
    }
  }

  $$('.cms-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.cms-tab-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      $$('.cms-section-content').forEach(s => s.classList.remove('is-active'));
      const target = $(`#${btn.dataset.cms}`);
      if (target) target.classList.add('is-active');
    });
  });

  $$('.cms-field[data-key]').forEach(f => {
    const watch = () => cmsMarkDirty(f.dataset.key, f.value);
    f.addEventListener('input', watch);
    f.addEventListener('change', watch);
  });
  window.addEventListener('beforeunload', (e) => {
    if (_cmsDirty && _cmsDirtyFields.size > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  function cmsLastSavedInfo() {
    const el = $('#cmsLastSaved');
    if (!el) return;
    const stamps = Object.values(cmsData).map(s => s?.updated_at).filter(Boolean);
    if (!stamps.length) { el.textContent = ''; return; }
    const latest = new Date(Math.max(...stamps.map(t => new Date(t).getTime())));
    el.textContent = 'Último guardado: ' + latest.toLocaleString('es-AR');
  }

  on($('#cmsPreviewBtn'), 'click', () => { window.open('/', '_blank', 'noopener'); });

  function cmsAddListItem(containerId, fields, values = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const wrap = document.createElement('div');
    wrap.className = 'cms-field';
    wrap.style.cssText = 'padding:12px; background:rgba(255,255,255,0.03); border-radius:8px; margin-bottom:12px; position:relative;';
    wrap.innerHTML = fields.map(f =>
      `<div style="margin-bottom:8px;"><label style="font-size:11px; color:var(--text-dim);">${f.label}</label><input type="text" data-subkey="${f.key}" value="${esc(values[f.key] ?? '')}" placeholder="${f.placeholder || ''}" style="width:100%; padding:8px 10px; background:rgba(255,255,255,0.04); border:1px solid var(--border-input); border-radius:6px; color:#fff; font-size:12px;" /></div>`
    ).join('') + `<button type="button" class="grupo-item-remove" style="position:absolute; top:6px; right:6px; background:none; border:none; color:var(--danger); cursor:pointer;"><i class="fas fa-trash"></i></button>`;
    wrap.querySelector('.grupo-item-remove')?.addEventListener('click', () => { wrap.remove(); cmsMarkDirty(containerId, 'x'); });
    wrap.querySelectorAll('input').forEach(i => i.addEventListener('input', () => cmsMarkDirty(containerId, 'x')));
    container.appendChild(wrap);
    if (!Object.keys(values).length) cmsMarkDirty(containerId, 'x');
  }

  function cmsItemsPack(containerId, subkeys) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return [...container.querySelectorAll('.cms-field')].map(wrap => {
      const obj = {};
      wrap.querySelectorAll('[data-subkey]').forEach(i => {
        const k = i.dataset.subkey;
        if (subkeys.includes(k)) obj[k] = i.value.trim();
      });
      return Object.keys(obj).length ? obj : null;
    }).filter(Boolean);
  }

  on($('#cmsAddServiceBtn'), 'click', () => cmsAddListItem('cmsServicesItems', [
    { key: 'icon', label: 'Icono (clase FA)', placeholder: 'fas fa-home' },
    { key: 'title', label: 'Título', placeholder: 'Venta' },
    { key: 'desc', label: 'Descripción', placeholder: 'Estrategia personalizada...' },
  ]));
  on($('#cmsAddProcessStepBtn'), 'click', () => cmsAddListItem('cmsProcessSteps', [
    { key: 'num', label: 'Número', placeholder: '01' },
    { key: 'title', label: 'Título', placeholder: 'Tasación' },
    { key: 'desc', label: 'Descripción', placeholder: 'Analizamos tu propiedad...' },
  ]));
  on($('#cmsAddNavbarItemBtn'), 'click', () => cmsAddListItem('cmsNavbarItems', [
    { key: 'label', label: 'Etiqueta', placeholder: 'Inicio' },
    { key: 'url', label: 'URL / Ancla', placeholder: '#hero' },
  ]));
  on($('#cmsAddNavbarMobileItemBtn'), 'click', () => cmsAddListItem('cmsNavbarMobileItems', [
    { key: 'label', label: 'Etiqueta', placeholder: 'Inicio' },
    { key: 'url', label: 'URL / Ancla', placeholder: '#hero' },
  ]));
  on($('#cmsAddFormOptionBtn'), 'click', () => cmsAddListItem('cmsFormOptions', [
    { key: 'value', label: 'Valor', placeholder: 'comprar' },
    { key: 'label', label: 'Etiqueta', placeholder: 'Quiero comprar' },
  ]));
  on($('#cmsAddFormFieldBtn'), 'click', () => cmsAddListItem('cmsFormFields', [
    { key: 'name', label: 'Nombre del campo (id)', placeholder: 'phone' },
    { key: 'label', label: 'Etiqueta', placeholder: 'Teléfono' },
    { key: 'type', label: 'Tipo', placeholder: 'tel' },
  ]));
  on($('#cmsAddFooterNavLinkBtn'), 'click', () => cmsAddListItem('cmsFooterNavLinks', [
    { key: 'label', label: 'Etiqueta', placeholder: 'Propiedades' },
    { key: 'url', label: 'URL / Ancla', placeholder: '#propiedades' },
  ]));
  on($('#cmsAddFooterServiceLinkBtn'), 'click', () => cmsAddListItem('cmsFooterServiceLinks', [
    { key: 'label', label: 'Etiqueta', placeholder: 'Ventas' },
    { key: 'url', label: 'URL / Ancla', placeholder: '#servicios' },
  ]));
  on($('#cmsAddValorBtn'), 'click', () => cmsAddListItem('cmsNosotrosValores', [
    { key: 'icon', label: 'Icono (clase FA)', placeholder: 'fas fa-scale-balanced' },
    { key: 'title', label: 'Título', placeholder: 'Honestidad y Transparencia' },
    { key: 'desc', label: 'Descripción', placeholder: 'Hablar siempre con la verdad...' },
  ]));

  const CMS_CHAR_LIMITS = { meta_title: 60, meta_description: 160, og_title: 60, og_description: 200, description: 500 };
  function cmsCharCounterInit() {
    $$('.cms-field[data-key]').forEach(f => {
      if (f.dataset.counterBound) return;
      f.dataset.counterBound = '1';
      const limit = CMS_CHAR_LIMITS[f.dataset.key];
      if (!limit) return;
      const counter = document.createElement('small');
      counter.style.cssText = 'display:block; margin-top:4px; font-size:10px; color:var(--text-dim);';
      counter.textContent = '0/' + limit;
      f.parentElement.appendChild(counter);
      const upd = () => {
        counter.textContent = (f.value?f.value.length:0) + '/' + limit;
        counter.style.color = (f.value?.length||0) > limit ? 'var(--danger)' : 'var(--text-dim)';
      };
      f.addEventListener('input', upd);
      upd();
    });
  }
  cmsCharCounterInit();

  $$('.cms-field[data-key]').forEach(f => {
    if (f.dataset.undoBound) return;
    f.dataset.undoBound = '1';
    f.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        const prev = f.dataset.prevValue;
        if (prev !== undefined && prev !== f.value) {
          f.value = prev;
          cmsMarkDirty(f.dataset.key, f.value);
          e.preventDefault();
        }
      }
    });
    f.addEventListener('input', () => { f.dataset.prevValue = f.value; });
  });

  on($('#cmsSaveBtn'), 'click', async () => {
    if (!_cmsDirty || _cmsDirtyFields.size === 0) {
      showToast('No hay cambios para guardar', 'info');
      return;
    }
    const btn = $('#cmsSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const fields = $$('.cms-field[data-key]');
      const updatesBySection = {};

      const urlFields = ['og_url', 'og_image', 'twitter_image', 'hero_video_url', 'cta_url', 'instagram', 'facebook', 'linkedin', 'youtube', 'video_url'];
      const requiredFields = ['title', 'meta_title', 'meta_description'];
      const errors = [];
      fields.forEach(f => {
        const k = f.dataset.key;
        if (!_cmsDirtyFields.has(k)) return;
        if (requiredFields.includes(k) && !String(f.value).trim()) errors.push(`"${k}" está vacío pero es requerido`);
        if (urlFields.includes(k) && f.value && !/^(https?:\/\/|#|\/)/.test(f.value)) errors.push(`"${k}" no es una URL válida`);
      });
      if (errors.length) {
        showToast('Revisá antes de guardar: ' + errors.slice(0, 3).join(' | '), 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar Cambios Web'; }
        return;
      }

      const nested = {
        servicios_items: cmsItemsPack('cmsServicesItems', ['icon', 'title', 'desc']),
        proceso_pasos: cmsItemsPack('cmsProcessSteps', ['num', 'title', 'desc']),
        navbar_items: cmsItemsPack('cmsNavbarItems', ['label', 'url']),
        navbar_mobile_items: cmsItemsPack('cmsNavbarMobileItems', ['label', 'url']),
        form_options: cmsItemsPack('cmsFormOptions', ['value', 'label']),
        form_fields: cmsItemsPack('cmsFormFields', ['name', 'label', 'type']),
        footer_nav_links: cmsItemsPack('cmsFooterNavLinks', ['label', 'url']),
        footer_service_links: cmsItemsPack('cmsFooterServiceLinks', ['label', 'url']),
        nosotros_valores: cmsItemsPack('cmsNosotrosValores', ['icon', 'title', 'desc']),
      };
      const NESTED_TO_SECTION = {
        servicios_items: 'services',
        proceso_pasos: 'process',
        navbar_items: 'navbar',
        navbar_mobile_items: 'navbar',
        form_options: 'form',
        form_fields: 'form',
        footer_nav_links: 'footer',
        footer_service_links: 'footer',
        nosotros_valores: 'nosotros',
      };
      for (const [k, items] of Object.entries(nested)) {
        if (!items.length) continue;
        const section = NESTED_TO_SECTION[k];
        if (!updatesBySection[section]) updatesBySection[section] = {};
        updatesBySection[section][k] = items;
      }

      fields.forEach(field => {
        if (!_cmsDirtyFields.has(field.dataset.key)) return;
        const key = field.dataset.key;
        const mapping = CMS_FIELD_MAP[key];
        if (mapping) {
          if (!updatesBySection[mapping.section]) updatesBySection[mapping.section] = {};
          updatesBySection[mapping.section][mapping.path] = field.value;
          return;
        }
        const sectionEl = field.closest('.cms-section-content');
        if (sectionEl) {
          const domId = sectionEl.id.replace('cms-', '');
          const dbSection = SECTION_ID_TO_DB_KEY[domId];
          if (dbSection) {
            if (!updatesBySection[dbSection]) updatesBySection[dbSection] = {};
            updatesBySection[dbSection][key] = field.value;
          }
        }
      });

      const sectionEntries = Object.entries(updatesBySection);
      await Promise.all(sectionEntries.map(async ([sectionKey, newFields]) => {
        const existing = cmsData[sectionKey];
        const mergedContent = { ...(existing?.content || {}), ...newFields };

        if (existing) {
          const { error } = await window.supabaseClient
            .from('site_content')
            .update({ content: mergedContent })
            .eq('id', existing.id);
          if (error) throw error;
          cmsData[sectionKey].content = mergedContent;
        } else {
          const { data, error } = await window.supabaseClient
            .from('site_content')
            .insert([{ section_key: sectionKey, content: mergedContent }])
            .select()
            .single();
          if (error) throw error;
          cmsData[sectionKey] = data;
        }
      }));
      const savedCount = sectionEntries.length;
      _cmsDirty = false;
      _cmsDirtyFields.clear();
      cmsUpdateDirtyUI();
      cmsLastSavedInfo();
      showToast(`${savedCount} secciones guardadas correctamente`, 'success');
    } catch (err) {
      showToast('Error al guardar: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar Cambios Web'; }
    }
  });

  const DEFAULT_CMS_CONTENT = {
    hero: {
      title: 'Encontrá tu próximo hogar',
      subtitle: 'en Córdoba',
      eyebrow: 'Bienvenidos a Bienenhaus',
      description: 'Propiedades seleccionadas, asesoramiento experto y la confianza de una inmobiliaria con trayectoria.',
      bg_image_url: '',
      video_url: ''
    },
    services: {
      title: 'Nuestros Servicios',
      badge: 'Qué ofrecemos',
      description: 'Acompañamos cada paso de tu operación inmobiliaria con profesionalidad y transparencia.'
    },
    team: {
      title: 'Nuestro Equipo'
    },
    stats: {
      title: 'Nuestros Números',
      description: 'Años de experiencia respaldan cada operación.',
      properties_sold: '500+',
      stat1_label: 'Propiedades vendidas'
    },
    process: {
      title: 'Cómo Trabajamos'
    }
  };

  async function globalResetCMS() {
    const confirmed = confirm(
      '?? REINICIO GLOBAL DE CMS\n\n' +
      'Esta acción ELIMINARÁ todo el contenido del CMS (Hero, Servicios, Equipo, Stats, Proceso) ' +
      'y restaurará los valores por defecto de fábrica.\n\n' +
      '¿Estás seguro de que querés continuar?'
    );
    if (!confirmed) return;

    const doubleConfirmed = confirm(
      '?? CONFIRMACIÓN FINAL\n\n' +
      'Se borrarán TODOS los registros de site_content.\n' +
      'Esta acción NO se puede deshacer.\n\n' +
      'Escribí "RESET" para confirmar:'
    );
    if (!doubleConfirmed) return;

    const userInput = prompt('Escribí "RESET" para confirmar el reinicio global:');
    if (userInput !== 'RESET') {
      showToast('Reinicio cancelado: texto incorrecto', 'warning');
      return;
    }

    const btn = $('#cmsResetBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reiniciando...'; }

    try {
      const { error } = await window.supabaseClient
        .from('site_content')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');

      if (error) throw error;

      cmsData = {};

      $$('.cms-field[data-key]').forEach(input => {
        input.value = '';
      });

      if (heroBgPreview) {
        heroBgPreview.innerHTML = '<i class="fas fa-cloud-arrow-up"></i><span>Sin imagen</span>';
        heroBgPreview.style.position = '';
      }
      if (heroBgHidden) heroBgHidden.value = '';

      populateCMSFieldsWithDefaults();

      invalidateRequestCache('site_content');

      showToast('? CMS reiniciado a valores de fábrica', 'success');
    } catch (err) {
      logError('Global reset error:', err);
      showToast('Error en reinicio global: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-rotate-left"></i> Reinicio Global'; }
    }
  }

  function populateCMSFieldsWithDefaults() {
    Object.entries(DEFAULT_CMS_CONTENT).forEach(([sectionKey, content]) => {
      Object.entries(content).forEach(([path, value]) => {
        Object.entries(CMS_FIELD_MAP).forEach(([dataKey, mapping]) => {
          if (mapping.section === sectionKey && mapping.path === path) {
            const input = $(`.cms-field[data-key="${dataKey}"]`);
            if (input) input.value = value;
          }
        });
      });
    });
  }

  on($('#cmsResetBtn'), 'click', async () => {
    await globalResetCMS();
  });

  const heroBgFile = $('#cmsHeroBgFile');
  const heroBgPreview = $('#cmsHeroBgPreview');
  const heroBgHidden = $('#cms_hero_bg');

  on($('#cmsHeroBgUpload'), 'click', () => heroBgFile?.click());

  on(heroBgFile, 'change', (e) => {
    (async () => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) { showToast('Solo se permiten imágenes', 'error'); return; }

      try {
        heroBgPreview.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Subiendo...</span>';
        if (!window.BH_Cloudinary) { showToast('Cloudinary no disponible', 'error'); return; }
        const url = await window.BH_Cloudinary.uploadImage(file, 'bienenhaus/hero');
        if (heroBgHidden) heroBgHidden.value = url;
        heroBgPreview.innerHTML = '<img src="' + esc(url) + '" alt="Hero background" /><span style="position:absolute;bottom:2px;right:2px;font-size:9px;background:rgba(0,0,0,.7);padding:2px 5px;border-radius:3px;">Cloudinary ?</span>';
        heroBgPreview.style.position = 'relative';
        showToast('Imagen subida a Cloudinary', 'success');
      } catch (err) {
        logError('Upload error:', err);
        heroBgPreview.innerHTML = '<i class="fas fa-cloud-arrow-up"></i><span>Error al subir</span>';
        showToast('Error al subir imagen: ' + err.message, 'error');
      }
    })();
  });

  /* ------------------------------------------------
     9b. CONFIGURACIÓN GENERAL (site_content + app_settings)
     ------------------------------------------------ */
  let cfgData = {};

  const CFG_FIELD_MAP = {
    razon_social:     { section: 'footer',  path: 'razon_social' },
    matricula:        { section: 'footer',  path: 'matricula' },
    watermark:        { section: 'footer',  path: 'copyright' },
    cuit:             { section: 'footer',  path: 'cuit' },
    whatsapp:         { section: 'contact', path: 'whatsapp' },
    email:            { section: 'contact', path: 'email' },
    phone:            { section: 'contact', path: 'phone' },
    schedule:         { section: 'contact', path: 'schedule' },
    social_instagram: { section: 'social',  path: 'instagram' },
    social_facebook:  { section: 'social',  path: 'facebook' },
    social_linkedin:  { section: 'social',  path: 'linkedin' },
    social_youtube:   { section: 'social',  path: 'youtube' },
    zernio_api_key:   { section: 'zernio',  path: 'api_key' }
  };

  function applyCfgGuard() {
    const editable = canManageUsers();
    $$('.cfg-field, .cfg-field-pref').forEach(i => { i.disabled = !editable; });
    const saveBtn = $('#cfgSaveBtn');
    if (saveBtn) saveBtn.disabled = !editable;
    const note = $('#cfgGuardNote');
    if (note) note.style.display = editable ? 'none' : 'block';
  }

  function populateCfgFields() {
    $$('.cfg-field[data-key]').forEach(input => {
      const m = CFG_FIELD_MAP[input.dataset.key];
      if (!m || !cfgData[m.section]) return;
      input.value = (cfgData[m.section].content || {})[m.path] || '';
    });
  }

  async function loadConfig() {
    const client = await getAuthedClient();
    if (!client) return;
    try {
      const [{ data: rows, error }, prefRes, zernioRes] = await Promise.all([
        client.from('site_content').select('id, section_key, content').in('section_key', ['contact', 'footer', 'social']),
        client.from('app_settings').select('key, value, updated_at'),
        client.from('zernio_config').select('value').eq('key', 'api_key').maybeSingle()
      ]);
      if (error) throw error;
      if (!prefRes.error && Array.isArray(prefRes.data)) {
        const prefs = prefRes.data.find(r => r.key === 'preferences');
        const rateInput = $('#cfg_usd_rate');
        if (prefs?.value && typeof prefs.value.usd_rate === 'number' && rateInput) rateInput.value = prefs.value.usd_rate;
        const hint = $('#cfgUsdRateHint');
        if (hint && prefs?.updated_at) {
          const daysOld = Math.floor((Date.now() - new Date(prefs.updated_at).getTime()) / 86400000);
          hint.textContent = daysOld > 7 ? `⚠ Cotización cargada hace ${daysOld} días — conviene actualizarla` : `Actualizada hace ${daysOld} día${daysOld === 1 ? '' : 's'}`;
          hint.style.color = daysOld > 7 ? 'var(--warning)' : 'var(--text-dim)';
        }
      }
      if (zernioRes.data?.value) {
        const val = zernioRes.data.value;
        const apiKey = typeof val === 'string' ? val : val.key;
        if (apiKey) {
          const keyInput = $('#cfg_zernio_api_key');
          if (keyInput) keyInput.value = apiKey;
        }
      }
      cfgData = {};
      (rows || []).forEach(item => { cfgData[item.section_key] = item; });
      populateCfgFields();
      applyCfgGuard();
      renderCfgStatus();
      renderCfgSession();
    } catch (err) {
      logError('Config error:', err);
      showToast('Error al cargar configuración: ' + err.message, 'error');
    }
  }

  on($('#cfgSaveBtn'), 'click', async () => {
    const btn = $('#cfgSaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';
    try {
      const client = await getAuthedClient();
      const rateRaw = ($('#cfg_usd_rate')?.value ?? '').trim();
      let rateVal = null;
      if (rateRaw !== '') {
        rateVal = Number(rateRaw);
        if (!Number.isFinite(rateVal) || rateVal <= 0) throw new Error('La cotización USD debe ser un número positivo.');
      }

      const updatesBySection = {};
      $$('.cfg-field[data-key]').forEach(field => {
        const m = CFG_FIELD_MAP[field.dataset.key];
        if (!m) return;
        if (!updatesBySection[m.section]) updatesBySection[m.section] = {};
        updatesBySection[m.section][m.path] = field.value.trim();
      });

      await Promise.all(Object.entries(updatesBySection).map(async ([sectionKey, newFields]) => {
        if (sectionKey === 'zernio') {
          const apiKey = newFields.api_key?.trim();
          if (apiKey) {
            const { error } = await client
              .from('zernio_config')
              .upsert({ key: 'api_key', value: apiKey, updated_at: new Date().toISOString() }, { onConflict: 'key' });
            if (error) throw error;
          }
          return;
        }
        const existing = cfgData[sectionKey];
        const mergedContent = { ...(existing?.content || {}), ...newFields };
        if (existing) {
          const { error } = await client
            .from('site_content').update({ content: mergedContent }).eq('id', existing.id);
          if (error) throw error;
          existing.content = mergedContent;
        } else {
          const { data, error } = await client
            .from('site_content').insert([{ section_key: sectionKey, content: mergedContent }]).select().single();
          if (error) throw error;
          cfgData[sectionKey] = data;
        }
      }));

      if (rateVal !== null) {
        const { error: upErr } = await client
          .from('app_settings')
          .upsert({ key: 'preferences', value: { usd_rate: rateVal }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
        if (upErr) throw upErr;
      }

      showToast('Configuración guardada correctamente', 'success');
    } catch (err) {
      showToast('Error al guardar: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar Cambios';
    }
  });

  function statusChip(label, ok, detail) {
    const color = ok ? '#4ade80' : '#f87171';
    return '<span style="display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border-radius:999px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.03); font-size:12px; color:#ddd;">'
      + '<span style="width:8px; height:8px; border-radius:50%; background:' + color + '; box-shadow:0 0 6px ' + color + ';"></span>'
      + esc(label)
      + (detail ? '&nbsp;<span style="color:var(--text-dim);">· ' + esc(detail) + '</span>' : '')
      + '</span>';
  }

  function renderCfgStatus() {
    const row = $('#cfgStatusRow');
    if (!row || !window.supabaseClient) return;
    // Chips honestos: solo marcan verde lo verificado en esta sesión
    let zernioChip = statusChip('Zernio', false, 'sin verificar');
    try {
      const probe = JSON.parse(sessionStorage.getItem('cfgZernioLastProbe') || 'null');
      if (probe && Date.now() - probe.at < 30 * 60 * 1000) {
        zernioChip = probe.ok
          ? statusChip('Zernio', true, `OK hace ${Math.floor((Date.now() - probe.at) / 60000)}min (${probe.ms}ms)`)
          : statusChip('Zernio', false, `falló ${new Date(probe.at).toLocaleTimeString('es-AR')}`);
      }
    } catch (_) {}
    row.innerHTML = statusChip('Supabase', true, 'conectado')
      + statusChip('Cloudinary', !!window.BH_Cloudinary, window.BH_Cloudinary ? 'listo' : 'no disponible')
      + statusChip('Brevo SMTP', false, 'no verificado en esta sesión')
      + statusChip('Mercado Libre', !!ml_connected, ml_configured ? 'credenciales OK' : 'sin configurar')
      + zernioChip;
  }

  function renderCfgSession() {
    const info = $('#cfgSessionInfo');
    if (!info) return;
    info.innerHTML = '<strong style="color:#fff;">' + esc(currentUser?.email || '—') + '</strong> · rol: ' + esc(currentProfile?.role || '—');
  }

  /* Zernio Config UI helpers */
  on($('#toggleZernioKey'), 'click', () => {
    const input = $('#cfg_zernio_api_key');
    const icon = $('#toggleZernioKey i');
    if (!input || !icon) return;
    if (input.type === 'password') {
      input.type = 'text';
      icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
      input.type = 'password';
      icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
  });

  on($('#btnTestZernio'), 'click', async () => {
    const btn = $('#btnTestZernio');
    const statusEl = $('#zernioTestStatus');
    const keyInput = $('#cfg_zernio_api_key');
    const apiKey = keyInput?.value?.trim();
    if (!apiKey) { statusEl.textContent = '? Ingresá tu API Key primero'; statusEl.style.color = 'var(--warning)'; return; }
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Probando...';
    statusEl.textContent = 'Conectando...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const session = await window.supabaseClient.auth.getSession();
      const t0 = performance.now();
      const res = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/zernio-proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.data.session?.access_token}` },
        body: JSON.stringify({ action: 'list_accounts' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error en respuesta');
      const ms = Math.round(performance.now() - t0);
      statusEl.textContent = `Conectado · ${data.count} cuenta(s) · ${ms}ms · ${new Date().toLocaleTimeString('es-AR')}`;
      statusEl.style.color = 'var(--success)';
      sessionStorage.setItem('cfgZernioLastProbe', JSON.stringify({ ok: true, at: Date.now(), ms, count: data.count }));
    } catch (err) {
      statusEl.textContent = '✗ ' + err.message;
      statusEl.style.color = 'var(--danger)';
      sessionStorage.setItem('cfgZernioLastProbe', JSON.stringify({ ok: false, at: Date.now(), error: err.message }));
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plug"></i> Probar Conexión Zernio';
    }
  });

  /* ------------------------------------------------
     10. AGENTS CRUD
     ------------------------------------------------ */
  async function loadAgents() {
    invalidateSearchCache();
    const tbody = $('#agentsTableBody');
    if (!tbody) return;
    const client = await getAuthedClient();
    if (!client) return;

    try {
      const { data, error } = await client
        .from('agents')
        .select('*')
        .is('deleted_at', null)
        .order('created_at', { ascending: true });

      if (error) throw error;

      if (!data?.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--text-dim);">No hay agentes cargados</td></tr>';
        return;
      }

      tbody.innerHTML = data.map(a => `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:10px;">
              <img style="width:36px; height:36px; border-radius:50%; object-fit:cover; border:1px solid var(--border-subtle);" src="${esc(a.photo_url || 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=100&q=60&fit=crop')}" alt="" />
              <div>
                <div style="font-weight:600; color:#fff; font-size:13px;">${esc(a.full_name || 'Sin nombre')}</div>
                <div style="color:var(--text-dim); font-size:11px;">${esc(a.email || '')}</div>
              </div>
            </div>
          </td>
          <td style="font-size:13px;">${esc(a.matricula || '-')}</td>
          <td style="font-size:12px;">${(a.specialties && a.specialties.length) ? a.specialties.map(s => `<span class="nav-badge" style="background:rgba(16,185,129,0.12); color:#10b981; font-size:10px; margin-right:3px;">${esc(s)}</span>`).join('') : '<span style="color:var(--text-dim);">—</span>'}</td>
          <td style="font-size:13px; color:var(--accent);">${a.commission_rate != null ? esc(a.commission_rate + '%') : '3%'}</td>
          <td><span class="nav-badge" style="background:${a.status === 'activo' ? 'rgba(0,200,120,0.15)' : a.status === 'licencia' ? 'rgba(255,184,0,0.15)' : 'rgba(255,255,255,0.06)'}; color:${a.status === 'activo' ? 'var(--success)' : a.status === 'licencia' ? 'var(--warning)' : 'var(--text-dim)'}; font-size:11px;">${esc(a.status || 'activo')}</span></td>
          <td style="font-size:13px;">${esc(a.phone || '-')}</td>
          <td>
            <div style="display:flex; gap:6px;">
              <button class="btn-action" title="Editar" onclick="window.adminApp.editAgent('${a.id}')"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteAgent('${a.id}')"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      logError('Agents error:', err);
    }
  }

  /* Create agent */
  on($('#btnNewAgent'), 'click', () => {
    editingAgentId = null;
    $('#agentForm')?.reset();
    // form.reset() no limpia multi-selects: quedaba la selección del agente editado
    const specSel = document.querySelector('#agentForm [name="specialties"]');
    if (specSel) Array.from(specSel.options).forEach(o => { o.selected = false; });
    const title = $('#agentModalTitle');
    if (title) title.textContent = 'Registrar Asesor / Broker';
    const profileSelect = document.querySelector('#agentForm [name="profile_id"]');
    if (profileSelect && window.supabaseClient) {
      window.supabaseClient.from('profiles').select('id, full_name, email, role')
        .order('full_name')
        .then(({ data }) => {
          if (data) {
            profileSelect.innerHTML = '<option value="">— Sin vincular —</option>' +
              data.map(u => `<option value="${u.id}">${u.full_name || u.email} (${u.role})</option>`).join('');
          }
        });
    }
    openModal('agentModal');
  });

  /* Save agent */
  on($('#agentForm'), 'submit', async (e) => {
    e.preventDefault();
    if (_submittingAgent) return;
    _submittingAgent = true;
    const btn = $('#agentSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const formData = new FormData(e.target);
      
      // Zod validation
      const validated = validateForm(AgentSchema, formData);
      const specialtiesSel = e.target.elements.specialties;
      const data = {
        full_name: validated.full_name,
        email: validated.email,
        phone: validated.phone,
        matricula: validated.matricula,
        bio: validated.bio,
        commission_rate: validated.commission_rate,
        specialties: specialtiesSel ? Array.from(specialtiesSel.selectedOptions).map(o => o.value) : [],
        status: validated.status,
      };

      const photoFile = formData.get('photo_file');
      if (photoFile && photoFile.size > 0) {
        data.photo_url = await uploadToCloudinary(photoFile);
      }

      if (editingAgentId) {
        if (!data.photo_url) delete data.photo_url;
        await mutate('agents', async () => {
          const { error } = await window.supabaseClient.from('agents').update(data).eq('id', editingAgentId);
          if (error) throw error;
        });
        showToast('Agente actualizado', 'success');
      } else {
        await mutate('agents', async () => {
          const { error } = await window.supabaseClient.from('agents').insert([data]);
          if (error) throw error;
        });
        showToast('Agente creado', 'success');
      }

      closeModal('agentModal');
      loadAgents();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      _submittingAgent = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Broker'; }
    }
  });

  /* Edit agent */
  window.adminApp.editAgent = async function (id) {
    try {
      const { data, error } = await window.supabaseClient.from('agents').select('*').eq('id', id).single();
      if (error) throw error;
      editingAgentId = id;
      const form = $('#agentForm');
      if (form) {
        form.elements.full_name.value = data.full_name || '';
        form.elements.email.value = data.email || '';
        form.elements.phone.value = data.phone || '';
        form.elements.matricula.value = data.matricula || '';
        form.elements.bio.value = data.bio || '';
form.elements.commission_rate.value = data.commission_rate ?? 3;
        form.elements.status.value = data.status || 'activo';
        form.elements.profile_id.value = data.profile_id || '';
        if (form.elements.specialties && data.specialties) {
          const specSet = new Set(data.specialties);
          Array.from(form.elements.specialties.options).forEach(opt => {
            opt.selected = specSet.has(opt.value);
          });
        }
      }
      const title = $('#agentModalTitle');
      if (title) title.textContent = 'Editar Agente';
      openModal('agentModal');
    } catch (err) {
      showToast('Error al cargar agente', 'error');
    }
  };

  window.adminApp.deleteAgent = async function (id) {
    if (!confirm('¿Eliminar este agente? (soft delete, se puede restaurar)')) return;
    try {
      const { error } = await window.supabaseClient
        .from('agents')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      showToast('Agente eliminado (soft delete)', 'success');
      loadAgents();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  /* ------------------------------------------------
     11. OWNERS CRUD
     ------------------------------------------------ */
  let _ownersTrashMode = false;
  window.adminApp.toggleOwnersTrash = function () {
    _ownersTrashMode = !_ownersTrashMode;
    const btn = $('#ownerTrashToggle');
    if (btn) {
      btn.classList.toggle('is-active', _ownersTrashMode);
      btn.innerHTML = _ownersTrashMode ? '<i class="fas fa-arrow-left"></i> Volver a activos' : '<i class="fas fa-trash-can"></i> Papelera';
    }
    loadOwners();
  };

  async function loadOwners() {
    invalidateSearchCache();
    const tbody = $('#ownersTableBody');
    if (!tbody) return;
    const client = await getAuthedClient();
    if (!client) return;

    try {
      const q = client.from('owners').select('*');
      const { data: owners, error } = _ownersTrashMode
        ? await q.not('deleted_at', 'is', null).order('deleted_at', { ascending: false })
        : await q.is('deleted_at', null).order('created_at', { ascending: true });

      if (error) throw error;

      /* Próxima tarea activa por propietario: una sola query (order asc por due_date) y map a owner_id */

      const { data: openTasks } = await client
        .from('owner_tasks')
        .select('owner_id, description, due_date')
        .in('status', ['pendiente', 'en_progreso'])
        .order('due_date', { ascending: true });

      const nextTaskByOwner = {};
      (openTasks || []).forEach(t => {
        if (!nextTaskByOwner[t.owner_id]) nextTaskByOwner[t.owner_id] = t;
      });

      /* Orden del padrón: próxima tarea más cercana a vencer primero (vencidas arriba de todo); sin tareas activas al final conservando el orden previo */

      (owners || []).sort((a, b) => {
        const ta = nextTaskByOwner[a.id] ? new Date(nextTaskByOwner[a.id].due_date).getTime() : Infinity;
        const tb = nextTaskByOwner[b.id] ? new Date(nextTaskByOwner[b.id].due_date).getTime() : Infinity;
        return ta - tb;
      });

      /* Load property counts per owner for KPIs */
      const { data: props } = await client
        .from('properties')
        .select('owner_id, price_usd, is_published');

      const ownerProps = {};
      const ownerPublishedValue = {};
      (props || []).forEach(p => {
        if (p.owner_id) {
          ownerProps[p.owner_id] = (ownerProps[p.owner_id] || 0) + 1;
          if (p.is_published) {
            ownerPublishedValue[p.owner_id] = (ownerPublishedValue[p.owner_id] || 0) + (p.price_usd || 0);
          }
        }
      });

      /* KPIs */
      const totalCount = (owners || []).length;
      const exclusiveCount = (owners || []).filter(o => o.exclusive).length;
      const exclusiveValue = (owners || [])
        .filter(o => o.exclusive)
        .reduce((sum, o) => sum + (ownerPublishedValue[o.id] || 0), 0);

      /* Expiring exclusivities (next 30 days) */
      const now = new Date();
      const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const expiringSoon = (owners || []).filter(o => o.exclusive && o.exclusive_end && new Date(o.exclusive_end) <= in30 && new Date(o.exclusive_end) >= now).length;
      const expiredExcl = (owners || []).filter(o => o.exclusive && o.exclusive_end && new Date(o.exclusive_end) < now).length;

      /* DNI/CUIT expiry alerts (next 90 days) */
      const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      const dniExpiring = (owners || []).filter(o => o.dni_expiry && new Date(o.dni_expiry) <= in90 && new Date(o.dni_expiry) >= now).length;
      const dniExpired = (owners || []).filter(o => o.dni_expiry && new Date(o.dni_expiry) < now).length;
      const cuitExpiring = (owners || []).filter(o => o.cuit_expiry && new Date(o.cuit_expiry) <= in90 && new Date(o.cuit_expiry) >= now).length;
      const cuitExpired = (owners || []).filter(o => o.cuit_expiry && new Date(o.cuit_expiry) < now).length;

      setKPI('ownerKpiTotal', totalCount);
      setKPI('ownerKpiValue', 'USD ' + formatNumber(exclusiveValue));
      setKPI('ownerKpiExpiring', expiringSoon + expiredExcl);

      /* Update sidebar badge for expiring exclusivities + DNI/CUIT */
      const exclBadge = $('#sideBadgeOwners');
      const totalDocAlerts = dniExpiring + dniExpired + cuitExpiring + cuitExpired;
      const tasksOverdue = (openTasks || []).filter(t => new Date(t.due_date).getTime() < Date.now()).length;

      const totalAlerts = expiringSoon + expiredExcl + totalDocAlerts + tasksOverdue;
      if (exclBadge) {
        if (totalAlerts > 0) {
          exclBadge.textContent = (owners || []).length + ' Activos' + (totalAlerts > 0 ? ' · ' + totalAlerts + ' alertas' : '') + (tasksOverdue > 0 ? ' · ' + tasksOverdue + ' tareas vencidas' : '');
          exclBadge.style.color = tasksOverdue > 0 ? 'var(--danger)' : 'var(--warning)';
        } else {
          exclBadge.textContent = (owners || []).length + ' Activos';
          exclBadge.style.color = '';
        }
      }

      /* Show DNI/CUIT alerts in dashboard if any */
      const docAlertEl = $('#ownerDocAlert');
      if (docAlertEl && totalDocAlerts > 0) {
        docAlertEl.style.display = 'flex';
        docAlertEl.innerHTML = `
          <i class="fas fa-id-card"></i>
          <div>
            <h4>?? Documentos por vencer</h4>
            <p>${dniExpiring + cuitExpiring} DNI/CUIT vencen en =90 días${dniExpired + cuitExpired > 0 ? ' · ' + (dniExpired + cuitExpired) + ' vencidos' : ''}.</p>
          </div>
        `;
      } else if (docAlertEl) {
        docAlertEl.style.display = 'none';
      }

      if (_ownersTrashMode) {
        if (!owners?.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim);">La papelera está vacía</td></tr>';
          return;
        }
        tbody.innerHTML = owners.map(o => `
          <tr>
            <td><strong>${esc(o.full_name || 'Sin nombre')}</strong><br><small style="color:var(--text-dim);">${esc(o.dni_cuit || 'S/DNI')}</small></td>
            <td colspan="3" style="color:var(--text-dim);">Eliminado el ${o.deleted_at ? new Date(o.deleted_at).toLocaleDateString('es-AR') : '?'}</td>
            <td>
              <div style="display:flex; gap:6px;">
                <button class="btn-action" title="Restaurar" onclick="window.adminApp.restoreOwner('${o.id}')"><i class="fas fa-rotate-left"></i></button>
              </div>
            </td>
          </tr>`).join('');
        return;
      }

      if (!owners?.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim);">No hay propietarios cargados</td></tr>';
        return;
      }

      tbody.innerHTML = owners.map(o => `
        <tr>
          <td>
            <div>
              <div style="font-weight:600; color:#fff; font-size:13px;">${esc(o.full_name || 'Sin nombre')}</div>
              <div style="color:var(--text-dim); font-size:11px;">${esc(o.dni_cuit || 'S/DNI')}</div>
            </div>
          </td>
          <td>
            <div style="font-size:13px;">${esc(o.phone || '-')}</div>
            <div style="color:var(--text-dim); font-size:11px;">${esc(o.email || '')}</div>
          </td>
          <td><span class="nav-badge" style="background:${o.exclusive ? 'rgba(31,200,195,0.15)' : 'rgba(255,255,255,0.06)'}; color:${o.exclusive ? 'var(--accent)' : 'var(--text-dim)'}; font-size:11px;">${o.exclusive ? 'Exclusivo' : 'Normal'}</span></td>
          <td>
${(() => { const t = nextTaskByOwner[o.id]; if (!t) return '<div style="font-size:12px; color:var(--text-dim);">—</div>'; const tl = fmtTaskTimeLeft(t.due_date); const chipColor = tl.overdue ? 'var(--danger)' : tl.soon ? 'var(--warning)' : 'var(--accent)'; return `<div style="font-size:12px; color:var(--text-main); font-weight:500;">${esc(t.description.length > 42 ? t.description.slice(0, 42) + '…' : t.description)}</div><div style="font-size:11px; font-weight:600; color:${chipColor}; margin-top:2px;"><i class="fas fa-clock" style="font-size:10px; margin-right:4px;"></i>${tl.text}</div>`; })()}

          </td>
          <td>
            <div style="display:flex; gap:6px;">
              <button class="btn-action" title="Editar" onclick="window.adminApp.editOwner('${o.id}')"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteOwner('${o.id}')"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      logError('Owners error:', err);
    }
  }


  /* Create owner */
  on($('#btnNewOwner'), 'click', () => {
    editingOwnerId = null;
    $('#ownerForm')?.reset();
    const title = $('#ownerModalTitle');
    if (title) title.textContent = 'Expediente de Propietario';

    loadAgentSelect($('#ownerTaskAgentSelect'));
openModal('ownerModal');

  });

  on($('#btnAddOwnerInline'), 'click', () => {
    _ownerFormSourcePropertyModal = true;
    editingOwnerId = null;
    $('#ownerForm')?.reset();
    const title = $('#ownerModalTitle');
    if (title) title.textContent = 'Nuevo Propietario';
    openModal('ownerModal');
  });
  /* Save owner */
  on($('#ownerForm'), 'submit', async (e) => {
    e.preventDefault();
    if (_submittingOwner) return;
    _submittingOwner = true;
    const btn = $('#ownerSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const formData = new FormData(e.target);
      
      // Zod validation
      const validated = validateForm(OwnerSchema, formData);

      /* validación de formato CUIT/CUIL (Argentina): 11 dígitos */
      if (validated.dni_cuit && validated.dni_cuit.length >= 13) {
        const digits = validated.dni_cuit.replace(/\D/g, '');
        if (digits.length === 11) {
          const mult = [5,4,3,2,7,6,5,4,3,2];
          const sum = digits.slice(0, 10).split('').reduce((a, d, i) => a + (+d) * mult[i], 0);
          const checkDigit = 11 - (sum % 11);
          const expected = checkDigit === 11 ? 0 : checkDigit === 10 ? 9 : checkDigit;
          if (+digits[10] !== expected) throw new Error('CUIT/CUIL inválido (dígito verificador incorrecto)');
        }
      }

      /* dup check por DNI/CUIT solo si no estamos editando */
      if (!editingOwnerId && validated.dni_cuit) {
        const digits = validated.dni_cuit.replace(/\D/g, '');
        if (digits.length >= 7) {
          const last4 = digits.slice(-4);
          const cand = await window.supabaseClient.from('owners')
            .select('id, full_name')
            .is('deleted_at', null)
            .ilike('dni_cuit', '%' + last4 + '%')
            .limit(1);
          if (!cand.error && cand.data && cand.data.length) {
            throw new Error('Ya existe un propietario con DNI/CUIT similar: ' + cand.data[0].full_name);
          }
        }
      }

      /* commission_split: JSON válido o vacío */
      let splitJson = null;
      const splitRaw = (validated.commission_split || '').trim();
      if (splitRaw) {
        try {
          splitJson = JSON.parse(splitRaw);
        } catch (_) {
          throw new Error('Comisión Split: el JSON no es válido');
        }
      }

      const data = {
        full_name: validated.full_name,
        email: validated.email,
        phone: validated.phone,
        dni_cuit: validated.dni_cuit,
        address: validated.address,
        preferred_contact: validated.preferred_contact || 'whatsapp',
        bank_name: validated.bank_name || '',
        cbu_cvu: validated.cbu_cvu || '',
        alias_cbu: validated.alias_cbu || '',
        exclusive: validated.exclusive || false,
        exclusive_start: validated.exclusive_start || null,
        exclusive_end: validated.exclusive_end || null,
        commission_sale: validated.commission_sale ?? null,
        commission_rent: validated.commission_rent ?? null,
        commission_split: splitJson,
        contract_notes: validated.contract_notes || null,
        dni_expiry: validated.dni_expiry || null,
        cuit_expiry: validated.cuit_expiry || null,
        notes: validated.notes,
      };

      if (editingOwnerId) {
        await mutate('owners', async () => {
          const { error } = await window.supabaseClient.from('owners').update(data).eq('id', editingOwnerId);
          if (error) throw error;
        });
        showToast('Propietario actualizado', 'success');
      } else {
        await mutate('owners', async () => {
const { data: created, error } = await window.supabaseClient.from('owners').insert([data]).select('id').single();
          if (error) throw error;
          _createdOwnerId = created?.id || null;
        });
        showToast('Propietario creado', 'success');
      }
closeModal('ownerModal');

      if (_ownerFormSourcePropertyModal) {
        _ownerFormSourcePropertyModal = false;
        await refreshOwnerSelect($('#propOwnerSelect'), _createdOwnerId);
        _createdOwnerId = null;
      }

      loadOwners();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      _submittingOwner = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Expediente'; }
    }
  });

  /* Edit owner */
  window.adminApp.editOwner = async function (id) {
    try {
      const { data, error } = await window.supabaseClient.from('owners').select('*').eq('id', id).single();
      if (error) throw error;
      editingOwnerId = id;
      const form = $('#ownerForm');
      if (form) {
        form.elements.full_name.value = data.full_name || '';
        form.elements.email.value = data.email || '';
        form.elements.phone.value = data.phone || '';
        form.elements.dni_cuit.value = data.dni_cuit || '';
        form.elements.address.value = data.address || '';
        form.elements.preferred_contact.value = data.preferred_contact || 'whatsapp';
        form.elements.bank_name.value = data.bank_name || '';
        form.elements.cbu_cvu.value = data.cbu_cvu || '';
        form.elements.alias_cbu.value = data.alias_cbu || '';
        form.elements.exclusive.checked = data.exclusive || false;
        if (form.elements.exclusive_start) form.elements.exclusive_start.value = data.exclusive_start || '';
        if (form.elements.exclusive_end) form.elements.exclusive_end.value = data.exclusive_end || '';
        if (form.elements.commission_sale) form.elements.commission_sale.value = data.commission_sale ?? '';
        if (form.elements.commission_rent) form.elements.commission_rent.value = data.commission_rent ?? '';
        if (form.elements.commission_split) form.elements.commission_split.value = data.commission_split ? (typeof data.commission_split === 'string' ? data.commission_split : JSON.stringify(data.commission_split)) : '';
        if (form.elements.contract_notes) form.elements.contract_notes.value = data.contract_notes || '';
        if (form.elements.dni_expiry) form.elements.dni_expiry.value = data.dni_expiry || '';
        if (form.elements.cuit_expiry) form.elements.cuit_expiry.value = data.cuit_expiry || '';
        form.elements.notes.value = data.notes || '';
      }
      const title = $('#ownerModalTitle');
      if (title) {
        title.textContent = 'Editar Propietario';
        let contactRow = title.parentElement && title.parentElement.querySelector('.owner-contact-row');
        if (!contactRow) {
          contactRow = document.createElement('div');
          contactRow.className = 'owner-contact-row';
          contactRow.style.cssText = 'display:flex; gap:8px; margin:-6px 0 12px; flex-wrap:wrap;';
          title.parentElement.insertBefore(contactRow, title.nextSibling);
        }
        const wa = (window.BH_CRM && window.BH_CRM.waNumber) ? (window.BH_CRM.waNumber(data.phone) || window.BH_CRM.waNumber(data.whatsapp)) : null;
        const tel = (window.BH_CRM && window.BH_CRM.telNumber) ? window.BH_CRM.telNumber(data.phone) : (data.phone || null);
        contactRow.innerHTML =
          (wa ? '<a class="crm-contact-btn crm-contact-btn--wa" href="https://wa.me/' + wa + '" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> WhatsApp</a>' : '') +
          (tel ? '<a class="crm-contact-btn" href="tel:+' + tel + '"><i class="fas fa-phone"></i> Llamar</a>' : '') +
          (data.email ? '<a class="crm-contact-btn" href="mailto:' + esc(data.email) + '"><i class="fas fa-envelope"></i> Email</a>' : '');
        contactRow.style.display = contactRow.innerHTML ? 'flex' : 'none';
      }

      /* Reset tabs to first */
      $$('#ownerModal .owner-tab-btn').forEach((btn, i) => {
        btn.classList.toggle('is-active', i === 0);
        btn.style.background = i === 0 ? 'rgba(31,200,195,0.15)' : 'none';
        btn.style.color = i === 0 ? 'var(--accent)' : 'var(--text-dim)';
      });
      $$('#ownerModal .owner-tab-content').forEach((c, i) => c.style.display = i === 0 ? 'block' : 'none');

      openModal('ownerModal');

      /* Load tab data in background */
      loadOwnerDocuments(id);
      loadOwnerProperties(id);
      loadOwnerTasaciones(id);
      loadOwnerTimeline(id);
      loadOwnerChecklist(id);

      loadOwnerTasks(id);



      const agentSelect = $('#ownerTaskAgentSelect');

      if (agentSelect) loadAgentSelect(agentSelect);
    } catch (err) {
      showToast('Error al cargar propietario', 'error');
    }
  };

  /* Generate Portal Link for Owner */
  window.adminApp.generateOwnerPortalLink = async function() {

    if (!editingOwnerId) return showToast('Primero guarde el propietario', 'warning');

    if (!window.supabaseClient) return;

    try {

      /* El agente elige cuántos días el acceso queda válido */
      const daysStr = prompt('Días de validez del acceso del propietario (ej: 30, 90, 180)', '90');

      if (daysStr === null) return;

      const days = parseInt(daysStr, 10);

      if (!days || days < 1) { showToast('Duración inválida', 'error'); return; }

      /* Código corto legible: sin 0/O ni 1/I/L para no confundir leyendo por teléfono */
      const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

      const rnd = crypto.getRandomValues(new Uint8Array(5));

      let token = '';

      for (let i = 0; i < 5; i++) token += CHARS[rnd[i] % CHARS.length];

      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

      const { error } = await window.supabaseClient

        .from('owner_portal_tokens')

        .upsert([{

          owner_id: editingOwnerId,

          token: token,

          scopes: ['read_properties', 'read_commissions', 'read_documents'],

          expires_at: expiresAt,

          created_by: currentUser?.id || null

        }], { onConflict: 'owner_id' });

      if (error) throw error;

      const portalUrl = window.location.origin + '/portal-propietario.html?token=' + token;

      const msg = 'Código: ' + token + '  ·  Válido hasta: ' + new Date(expiresAt).toLocaleDateString('es-AR') + '. Link directo: ' + portalUrl;

      navigator.clipboard.writeText(msg).then(() => {

        showToast('Código copiado: ' + token, 'success', 8000);

      }).catch(() => {

        showToast('Código: ' + token + ' (copie manualmente)', 'info', 8000);

      });

    } catch (err) {

      showToast('Error: ' + err.message, 'error');

    }

  };

$('#btnGeneratePortalLink')?.addEventListener('click', window.adminApp.generateOwnerPortalLink);

  /* Owner Checklist */
  async function loadOwnerChecklist(ownerId) {
    const select = $('#checklistOperationType');
    const list = $('#ownerChecklistList');
    if (!select || !list) return;
    if (!window.supabaseClient) return;

    const type = select.value;
    try {
      const [reqRes, ownerRes] = await Promise.all([
        window.supabaseClient
          .from('document_requirements')
          .select('*')
          .eq('operation_type', type)
          .order('sort_order'),
        window.supabaseClient
          .from('owners')
          .select('documents')
          .eq('id', ownerId)
          .single()
      ]);

      const requirements = reqRes.data || [];
      const ownerDocs = ownerRes.data?.documents || [];

      if (!requirements.length) {
        list.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Sin requisitos configurados para este tipo</p>';
        return;
      }

      const doneCount = requirements.filter(req => ownerDocs.some(d => (d.document_key === req.document_key) || (d.name && d.name.toLowerCase().includes(req.document_key.toLowerCase())))).length;
      const pct = Math.round((doneCount / requirements.length) * 100);
      const barColor = pct === 100 ? 'var(--success)' : pct >= 60 ? 'var(--accent)' : 'var(--warning)';
      let barHtml = '<div style="margin-bottom:14px; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px;">' +
        '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; font-size:12px;">' +
        '<span style="color:var(--text-dim);">Progreso del expediente</span>' +
        '<span style="color:' + barColor + '; font-weight:700;">' + doneCount + '/' + requirements.length + ' (' + pct + '%)</span>' +
        '</div>' +
        '<div style="height:6px; background:rgba(255,255,255,0.06); border-radius:999px; overflow:hidden;">' +
        '<div style="width:' + pct + '%; height:100%; background:' + barColor + '; transition:width .4s ease;"></div></div></div>';

      list.innerHTML = barHtml + requirements.map(req => {
        const hasDoc = ownerDocs.some(d => (d.document_key === req.document_key) || (d.name && d.name.toLowerCase().includes(req.document_key.toLowerCase())));
        const isMissing = req.is_mandatory && !hasDoc;
        let cls = 'check-done', label = 'Completo';
        if (isMissing) { cls = 'check-missing'; label = 'Falta (Obligatorio)'; }
        else if (!hasDoc) { cls = 'check-pending'; label = 'Pendiente'; }
        return `
          <div class="doc-item">
            <div class="doc-main">
              <div class="doc-icon other"><i class="fas ${getReqIcon(req.document_key)}"></i></div>
              <div class="doc-info">
                <div class="doc-name">${esc(req.label)}${req.is_mandatory ? ' <span style="color:#ef4444; font-size:10px;">*</span>' : ''}</div>
                <div class="doc-meta">${esc(req.description || '')}</div>
              </div>
            </div>
            <div class="doc-status">
              <span class="check-icon ${cls}"><i class="fas ${cls === 'check-done' ? 'fa-check' : cls === 'check-missing' ? 'fa-times' : 'fa-clock'}"></i></span>
              <span style="font-size:11px; color:var(--text-dim);">${label}</span>
            </div>
          </div>
        `;
      }).join('');
    } catch (_) {
      list.innerHTML = '<p style="color:var(--text-dim); text-align:center; padding:20px;">Error cargando checklist</p>';
    }
  }

  function getReqIcon(key) {
    const icons = {
      escritura: 'fa-file-signature',
      dni: 'fa-id-card',
      servicios: 'fa-file-invoice',
      planos: 'fa-drafting-compass',
      certificado_dominio: 'fa-certificate',
      inhibiciones: 'fa-gavel',
      plano_mensura: 'fa-ruler-combined',
      reglamento_copropiedad: 'fa-book',
      expensas: 'fa-receipt',
      libre_deuda: 'fa-check-circle'
    };
    return icons[key] || 'fa-file-alt';
  }

  $('#checklistOperationType')?.addEventListener('change', function() {
    if (editingOwnerId) loadOwnerChecklist(editingOwnerId);
  });

  /* Tab switching for owner modal */
  $$('#ownerModal .owner-tab-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const tab = this.dataset.ownerTab;
      $$('#ownerModal .owner-tab-btn').forEach(b => {
        b.classList.remove('is-active');
        b.style.background = 'none';
        b.style.color = 'var(--text-dim)';
      });
      this.classList.add('is-active');
      this.style.background = 'rgba(31,200,195,0.15)';
      this.style.color = 'var(--accent)';
      $$('#ownerModal .owner-tab-content').forEach(c => c.style.display = 'none');
      const target = $('#ownerTab-' + tab);
      if (target) target.style.display = 'block';
    });
  });

  /* Owner Tasks — CRM de seguimiento */

  const OWNER_TASK_TYPE_LABEL = { contact: 'Contacto', document: 'Documento', commission: 'Comisión', alert: 'Alerta', note: 'Nota' };
  const OWNER_TASK_PRIORITY_LABEL = { baja: 'Baja', media: 'Media', alta: 'Alta' };
  const OWNER_TASK_STATUS_LABEL = { pendiente: 'Pendiente', en_progreso: 'En progreso', completada: 'Completada', cancelada: 'Cancelada' };

  function fmtTaskDate(iso) {
    try {
      return new Date(iso).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return iso; }
  }

  function fmtTaskTimeLeft(iso) {
    const diff = new Date(iso).getTime() - Date.now();
    const abs = Math.abs(diff);
    const days = Math.floor(abs / 86400000);
    const hours = Math.floor((abs % 86400000) / 3600000);
    const mins = Math.floor((abs % 3600000) / 60000);
    const human = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    if (diff < 0) return { text: `Vencida hace ${human}`, overdue: true };
    if (diff < 24 * 3600000) return { text: `Vence hoy · ${human}`, soon: true };
    return { text: `Vence en ${human}`, soon: false };
  }

  async function loadOwnerTasks(ownerId) {
    const list = $('#ownerTasksList');
    if (!list || !window.supabaseClient || !ownerId) return;

    try {
      const { data, error } = await window.supabaseClient
        .from('owner_tasks')
        .select('id, type, description, due_date, status, priority, assigned_to, agent:agents!assigned_to(full_name)')
        .eq('owner_id', ownerId)
        .order('due_date', { ascending: true });

      if (error) throw error;

      if (!data || !data.length) {
        list.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Sin tareas registradas</p>';
        return;
      }

      list.innerHTML = data.map(t => {
        const isOverdue = ['pendiente', 'en_progreso'].includes(t.status) && new Date(t.due_date).getTime() < Date.now();
        const isDone = ['completada', 'cancelada'].includes(t.status);
        const priorityColor = t.priority === 'alta' ? 'var(--danger)' : t.priority === 'media' ? 'var(--warning)' : 'var(--accent)';
        return `
          <div style="display:flex; align-items:flex-start; gap:12px; padding:12px 14px; margin-bottom:8px; background:rgba(255,255,255,0.02); border:1px solid ${isOverdue ? 'var(--danger)' : 'var(--border-subtle)'}; border-radius:10px; ${isDone ? 'opacity:0.55;' : ''}">
            <div style="flex:1; min-width:0;">
              <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <span style="color:#fff; font-size:13px; font-weight:600; ${isDone ? 'text-decoration:line-through;' : ''}">${esc(t.description)}</span>
                ${isOverdue ? '<span style="font-size:10px; font-weight:700; color:var(--danger); background:var(--danger-bg); border-radius:999px; padding:2px 8px;">VENCIDA</span>' : ''}
              </div>
              <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:4px; font-size:11px; color:var(--text-dim);">
                <span>${esc(OWNER_TASK_TYPE_LABEL[t.type] || t.type)}</span>
                <span style="color:${priorityColor}; font-weight:600;">${esc(OWNER_TASK_PRIORITY_LABEL[t.priority] || t.priority)}</span>
                <span>Vence: ${fmtTaskDate(t.due_date)}</span>
                ${t.agent?.full_name ? `<span>→ ${esc(t.agent.full_name)}</span>` : ''}
                <span style="color:${isDone ? 'var(--success)' : 'var(--text-dim)'};">${esc(OWNER_TASK_STATUS_LABEL[t.status] || t.status)}</span>
              </div>
            </div>
            ${!isDone ? `
            <div style="display:flex; gap:6px; flex-shrink:0;">
              <button type="button" class="btn-icon btn-icon--accent" title="Completar" onclick="window.adminApp.completeOwnerTask('${t.id}')"><i class="fas fa-check"></i></button>
              <button type="button" class="btn-icon" title="Cancelar" onclick="window.adminApp.cancelOwnerTask('${t.id}')"><i class="fas fa-ban"></i></button>
              <button type="button" class="btn-icon" title="Eliminar" style="color:var(--danger);" onclick="window.adminApp.deleteOwnerTask('${t.id}')"><i class="fas fa-trash"></i></button>
            </div>` : ''}
          </div>
        `;
      }).join('');
    } catch (_) {
      list.innerHTML = '<p style="color:var(--text-dim); text-align:center; padding:20px;">Error cargando tareas</p>';
    }
  }

  window.adminApp.createOwnerTask = async function () {
    if (!editingOwnerId) return showToast('Primero guarde el propietario', 'warning');
    if (!window.supabaseClient) return;

    const description = $('#ownerTaskDescription')?.value?.trim();
    const dueDateLocal = $('#ownerTaskDueDate')?.value;
    const type = $('#ownerTaskType')?.value || 'contact';
    const priority = $('#ownerTaskPriority')?.value || 'media';
    const remindBefore = parseInt($('#ownerTaskRemind')?.value, 10) || 1440;
    const assignedTo = $('#ownerTaskAgentSelect')?.value || null;

    if (!description) return showToast('Ingresá una descripción', 'warning');
    if (!dueDateLocal) return showToast('Ingresá la fecha límite', 'warning');

    // Dup-check: misma descripción para el mismo propietario el mismo día
    const dayStart = new Date(dueDateLocal); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dueDateLocal); dayEnd.setHours(23, 59, 59, 999);
    const { data: existingTask } = await window.supabaseClient
      .from('owner_tasks')
      .select('id')
      .eq('owner_id', editingOwnerId)
      .ilike('description', description)
      .gte('due_date', dayStart.toISOString())
      .lte('due_date', dayEnd.toISOString())
      .in('status', ['pendiente', 'en_progreso'])
      .limit(1)
      .maybeSingle();
    if (existingTask) {
      showToast('Esa tarea ya existe para este propietario ese día.', 'warning');
      return;
    }

    try {
      const { error } = await mutate('owner_tasks', () =>
        window.supabaseClient.from('owner_tasks').insert([{
          owner_id: editingOwnerId,
          description,
          type,
          priority,
          due_date: new Date(dueDateLocal).toISOString(),
          remind_before_minutes: remindBefore,
          assigned_to: assignedTo,
          created_by: currentUser?.id || null
        }])
      );

      if (error) throw error;

      $('#ownerTaskDescription').value = '';
      $('#ownerTaskDueDate').value = '';
      $('#ownerTaskType').value = 'contact';
      $('#ownerTaskPriority').value = 'media';
      $('#ownerTaskRemind').value = '1440';

      showToast('Tarea creada', 'success');
      loadOwnerTasks(editingOwnerId);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.adminApp.completeOwnerTask = async function (taskId) {
    if (!window.supabaseClient) return;
    const resultNotes = prompt('Nota de cierre (opcional):', '');

    try {
      const task = await mutate('owner_tasks', async () => {
        const { data, error } = await window.supabaseClient
          .from('owner_tasks')
          .update({ status: 'completada', result_notes: resultNotes || null })
          .eq('id', taskId)
          .select()
          .single();
        if (error) throw error;

        const { error: tlError } = await window.supabaseClient
          .from('owner_timeline_entries')
          .insert([{
            owner_id: data.owner_id,
            type: data.type,
            text: `Tarea completada: ${data.description}${resultNotes ? ' — ' + resultNotes : ''}`,
            created_by: currentUser?.id || null
          }]);
        if (tlError) throw tlError;

        return data;
      });

      showToast('Tarea completada', 'success');
      loadOwnerTasks(task.owner_id);
      loadOwnerTimeline(task.owner_id);
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.adminApp.cancelOwnerTask = async function (taskId) {
    if (!window.supabaseClient) return;
    if (!confirm('¿Cancelar esta tarea?')) return;

    try {
      await mutate('owner_tasks', () =>
        window.supabaseClient.from('owner_tasks').update({ status: 'cancelada' }).eq('id', taskId)
      );
      showToast('Tarea cancelada', 'success');
      if (editingOwnerId) loadOwnerTasks(editingOwnerId);
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.adminApp.deleteOwnerTask = async function (taskId) {
    if (!window.supabaseClient) return;
    if (!confirm('¿Eliminar esta tarea? Esta acción no se puede deshacer.')) return;

    try {
      await mutate('owner_tasks', () =>
        window.supabaseClient.from('owner_tasks').delete().eq('id', taskId)
      );
      showToast('Tarea eliminada', 'success');
      if (editingOwnerId) loadOwnerTasks(editingOwnerId);
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };



  /* Owner Documents */
  async function loadOwnerDocuments(ownerId) {
    const el = $('#ownerDocsList');
    if (!el) return;
    if (!window.supabaseClient) return;
    try {
      const { data: owner } = await window.supabaseClient.from('owners').select('documents').eq('id', ownerId).single();
      const docs = (owner?.documents || []).sort((a, b) => new Date(b.uploaded_at || 0) - new Date(a.uploaded_at || 0));
      if (!docs.length) {
        el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Sin documentos cargados</p>';
        return;
      }
      el.innerHTML = docs.map(d => `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px; margin-bottom:8px; font-size:13px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <i class="fas fa-file-${d.type === 'pdf' ? 'pdf' : d.type === 'image' ? 'image' : 'alt'} ${getDocIcon(d.type)}" style="color:var(--accent); font-size:18px;"></i>
            <div>
              <div style="font-weight:500; color:#fff;">${esc(d.name || 'Documento')}</div>
              <div style="font-size:11px; color:var(--text-dim);">${d.type?.toUpperCase() || 'FILE'} · ${d.size ? (d.size / 1024).toFixed(1) + ' KB' : ''} · ${d.uploaded_at ? new Date(d.uploaded_at).toLocaleDateString('es-AR') : ''}${d.expiry ? ' · Vence: ' + new Date(d.expiry).toLocaleDateString('es-AR') : ''}</div>
            </div>
          </div>
          <div style="display:flex; gap:6px;">
            ${d.url ? `<a href="${esc(d.url)}" target="_blank" class="btn-action" title="Ver"><i class="fas fa-eye"></i></a>` : ''}
            <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteOwnerDoc('${ownerId}', '${esc(d.id)}')"><i class="fas fa-trash"></i></button>
          </div>
        </div>
      `).join('');
    } catch (_) { /* silent */ }
  }

  function getDocIcon(type) {
    if (!type) return '';
    if (type.includes('pdf')) return 'fa-file-pdf';
    if (type.includes('image') || type.includes('photo')) return 'fa-file-image';
    if (type.includes('word') || type.includes('doc')) return 'fa-file-word';
    return 'fa-file-alt';
  }

  window.adminApp.deleteOwnerDoc = async function (ownerId, docId) {
    if (!confirm('¿Eliminar este documento?')) return;
    try {
      const { data: owner } = await window.supabaseClient.from('owners').select('documents').eq('id', ownerId).single();
      const docs = (owner?.documents || []).filter(d => d.id !== docId);
      const { error } = await window.supabaseClient.from('owners').update({ documents: docs }).eq('id', ownerId);
      if (error) throw error;
      showToast('Documento eliminado', 'success');
      loadOwnerDocuments(ownerId);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  /* Document upload handler */
  $('#btnAddOwnerDoc')?.addEventListener('click', async () => {
    if (!editingOwnerId) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.doc,.docx,.jpg,.jpeg,.png,.heic';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) return showToast('Máx 10 MB', 'warning');
      try {
        const ext = file.name.split('.').pop();
        const path = `owners/${editingOwnerId}/${Date.now()}.${ext}`;
        const { error: upErr } = await window.supabaseClient.storage.from('documents').upload(path, file);
        if (upErr) throw upErr;
          const { data: urlData } = window.supabaseClient.storage.from('documents').getPublicUrl(path);
          const autoKey = (() => {
            const n = file.name.toLowerCase();
            const rules = [
              ['dni_frente', /^dni.*frente|frente.*dni/],
              ['dni_dorso', /dorso/],
              ['dni', /dni|documento/],
              ['cuit', /cuit|cuil/],
              ['escritura', /escritura|titulo/],
              ['contrato', /contrato/],
              ['reglamento', /reglamento/],
              ['plano', /plano/],
            ];
            for (const [key, re] of rules) { if (re.test(n)) return key; }
            return null;
          })();
          const doc = {
            id: crypto.randomUUID(),
            name: file.name,
            type: file.type,
            size: file.size,
            url: urlData.publicUrl,
            uploaded_at: new Date().toISOString(),
            expiry: null,
            document_key: autoKey
          };
        const { data: owner } = await window.supabaseClient.from('owners').select('documents').eq('id', editingOwnerId).single();
        const docs = (owner?.documents || []).concat(doc);
        await window.supabaseClient.from('owners').update({ documents: docs }).eq('id', editingOwnerId);
        showToast('Documento subido', 'success');
        loadOwnerDocuments(editingOwnerId);
      } catch (err) {
        showToast('Error subiendo: ' + err.message, 'error');
      }
    };
    input.click();
  });
/* Property Documents */

  const PROPERTY_DOC_TYPES = [

    { key: 'dni_frente', label: 'DNI Titular · Frente', icon: 'fa-id-card' },

    { key: 'dni_dorso', label: 'DNI Titular · Dorso', icon: 'fa-id-card' },

    { key: 'escritura', label: 'Escritura', icon: 'fa-file-signature' },

    { key: 'rentas_provincial', label: 'Rentas Provincial', icon: 'fa-file-invoice' },

    { key: 'tasa_municipal', label: 'Tasa Municipal', icon: 'fa-city' },

    { key: 'planos_aprobados', label: 'Planos Aprobados', icon: 'fa-drafting-compass' },

    { key: 'factura_luz', label: 'Factura de Luz', icon: 'fa-bolt' },

    { key: 'factura_gas', label: 'Factura de Gas', icon: 'fa-fire' },

    { key: 'factura_agua', label: 'Factura de Agua', icon: 'fa-tint' },

    { key: 'expensas', label: 'Expensas', icon: 'fa-receipt' },

    { key: 'autorizacion_venta', label: 'Autorización de Venta', icon: 'fa-file-signature' },

    { key: 'reserva', label: 'Reserva', icon: 'fa-handshake' }

  ];



  function propertyDocStateMarkup(doc) {

    return doc

      ? '<span class="status-pill active" style="font-size:10px; padding:3px 8px;">Subido</span>'

      : '<span class="status-pill pending" style="font-size:10px; padding:3px 8px;">Falta</span>';

  }



  function propertyDocMetaMarkup(doc) {

    if (!doc) return '<div style="font-size:11px; color:var(--text-dim);">Sin archivo cargado</div>';

    const size = doc.size ? (doc.size / 1024).toFixed(1) + ' KB' : '';

    const date = doc.uploaded_at ? ' · ' + new Date(doc.uploaded_at).toLocaleDateString('es-AR') : '';

    return `<div style="font-size:11px; color:var(--text-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(doc.name)} · ${size}${date}</div>`;

  }



  async function loadPropertyDocs(propertyId) {

    const el = $('#propertyDocsChecklist');

    if (!el) return;

    if (!window.supabaseClient) return;

    if (!propertyId) {

      el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Guardá la propiedad para gestionar la documentación</p>';

      return;

    }

    try {

      const { data, error } = await window.supabaseClient

        .from('property_documents')

        .select('*')

        .eq('property_id', propertyId);

      if (error) throw error;

      const byKey = {};

      (data || []).forEach(d => { byKey[d.document_key] = d; });

      const uploaded = (data || []).length;

      const header = document.querySelector('#propertyDocsSection h4');

      if (header) header.textContent = `Documentación de la Propiedad (${uploaded}/${PROPERTY_DOC_TYPES.length})`;

      el.innerHTML = PROPERTY_DOC_TYPES.map(t => {

        const doc = byKey[t.key];

        const actions = doc

          ? '<a href="#" class="btn-action" title="Ver" onclick="event.preventDefault(); window.adminApp.openPropertyDoc(\'' + propertyId + '\', \'' + t.key + '\')"><i class="fas fa-eye"></i></a>' +

            '<button type="button" class="btn-action danger" title="Eliminar" onclick="window.adminApp.deletePropertyDoc(\'' + propertyId + '\', \'' + t.key + '\')"><i class="fas fa-trash"></i></button>'

          : '';

        const uploadBtn = '<button type="button" class="btn-action" title="' + (doc ? 'Reemplazar' : 'Subir') + '" onclick="window.adminApp.uploadPropertyDoc(\'' + propertyId + '\', \'' + t.key + '\')"><i class="fas fa-upload"></i></button>';

        return `

          <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px; margin-bottom:8px; font-size:13px;">

            <div style="display:flex; align-items:center; gap:10px; min-width:0;">

              <i class="fas ${t.icon}" style="color:var(--accent); font-size:16px; flex-shrink:0;"></i>

              <div style="min-width:0;">

                <div style="font-weight:500; color:#fff;">${esc(t.label)}</div>

                ${propertyDocMetaMarkup(doc)}

              </div>

            </div>

            <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">

              ${propertyDocStateMarkup(doc)}

              ${actions}

              ${uploadBtn}

            </div>

          </div>

        `;

      }).join('');

    } catch (err) {

      showToast('Error al cargar documentación', 'error');

    }

  }



  window.adminApp.uploadPropertyDoc = async function (propertyId, key) {

    if (!propertyId) return;

    const input = document.createElement('input');

    input.type = 'file';

    input.accept = '.pdf,.jpg,.jpeg,.png,.heic,.webp';

    input.onchange = async () => {

      const file = input.files[0];

      if (!file) return;

      if (file.size > 10 * 1024 * 1024) return showToast('Máx 10 MB', 'warning');

      try {

        const ext = file.name.split('.').pop();

        const path = `properties/${propertyId}/${key}-${Date.now()}.${ext}`;

        const { error: upErr } = await window.supabaseClient.storage.from('property-documents').upload(path, file);

        if (upErr) throw upErr;

        const { error: insErr } = await window.supabaseClient.from('property_documents').upsert({

          property_id: propertyId,

          document_key: key,

          name: file.name,

          type: file.type,

          size: file.size,

          storage_path: path,

          created_by: currentUser?.id || null

        }, { onConflict: 'property_id,document_key' });

        if (insErr) throw insErr;

        showToast('Documento subido', 'success');

        loadPropertyDocs(propertyId);

      } catch (err) {

        showToast('Error subiendo: ' + err.message, 'error');

      }

    };

    input.click();

  };



  window.adminApp.openPropertyDoc = async function (propertyId, key) {

    try {

      const { data: doc } = await window.supabaseClient

        .from('property_documents')

        .select('storage_path')

        .eq('property_id', propertyId)

        .eq('document_key', key)

        .single();

      if (!doc?.storage_path) return showToast('Documento no encontrado', 'warning');

      const { data: signed } = await window.supabaseClient.storage

        .from('property-documents')

        .createSignedUrl(doc.storage_path, 3600);

      if (signed?.signedUrl) window.open(signed.signedUrl, '_blank', 'noopener');

      else showToast('No se pudo generar el enlace', 'warning');

    } catch (err) {

      showToast('Error: ' + err.message, 'error');

    }

  };



  window.adminApp.deletePropertyDoc = async function (propertyId, key) {

    if (!confirm('¿Eliminar este documento?')) return;

    try {

      const { data: doc } = await window.supabaseClient

        .from('property_documents')

        .select('id, storage_path')

        .eq('property_id', propertyId)

        .eq('document_key', key)

        .single();

      if (!doc) return;

      if (doc.storage_path) {

        await window.supabaseClient.storage.from('property-documents').remove([doc.storage_path]);

      }

      const { error } = await window.supabaseClient.from('property_documents').delete().eq('id', doc.id);

      if (error) throw error;

      showToast('Documento eliminado', 'success');

      loadPropertyDocs(propertyId);

    } catch (err) {

      showToast('Error: ' + err.message, 'error');

    }

  };




  /* Notas internas de la propiedad */
  function pendingPropertyNoteMarkup(text) {
    return '<div style="padding:10px 12px; background:rgba(31,200,195,0.06); border:1px dashed var(--accent); border-radius:10px; margin-bottom:8px; font-size:13px;">'
      + '<span style="font-size:11px; color:var(--accent); font-weight:600;">Pendiente de guardar</span>'
      + '<div style="white-space:pre-wrap; word-break:break-word; color:#fff; margin-top:4px;">' + esc(text) + '</div>'
      + '</div>';
  }

  function propertyNoteMarkup(note, author) {
    return '<div style="padding:10px 12px; background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:10px; margin-bottom:8px; font-size:13px;">'
      + '<div style="display:flex; justify-content:space-between; gap:8px; margin-bottom:4px;">'
      + '<span style="font-size:11px; color:var(--accent); font-weight:600;">' + esc(author) + '</span>'
      + '<span style="font-size:11px; color:var(--text-dim);">' + esc(formatDateTimeWithTZ(note.created_at)) + '</span>'
      + '</div>'
      + '<div style="white-space:pre-wrap; word-break:break-word; color:#fff;">' + esc(note.note) + '</div>'
      + '</div>';
  }

  function renderPendingPropertyNotes() {
    const listEl = $('#propertyNotesList');
    if (!listEl) return;
    if (!_pendingPropertyNotes.length) {
      listEl.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:16px;">Todavía no hay notas</p>';
      return;
    }
    listEl.innerHTML = _pendingPropertyNotes.map(pendingPropertyNoteMarkup).join('');
  }

  async function loadPropertyHistory(propertyId) {
    const section = $('#propertyHistorySection');
    const listEl = $('#propertyHistoryList');
    if (!section || !listEl) return;
    if (!propertyId) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    listEl.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:12px;"><i class="fas fa-spinner fa-spin"></i> Cargando historial...</p>';
    try {
      const { data, error } = await window.supabaseClient
        .from('audit_log')
        .select('action, changed_fields, status, created_at, user_id')
        .eq('record_id', propertyId)
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw error;
      if (!data || !data.length) {
        listEl.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:12px;">Sin cambios registrados</p>';
        return;
      }
      const userIds = [...new Set(data.map(function(a) { return a.user_id; }).filter(Boolean))];
      let nameMap = {};
      if (userIds.length) {
        const pres = await window.supabaseClient.from('profiles').select('id, full_name').in('id', userIds);
        if (!pres.error && pres.data) nameMap = Object.fromEntries(pres.data.map(function(p) { return [p.id, p.full_name || '']; }));
      }
      const VERB = { insert: 'Creó', create: 'Creó', update: 'Editó', delete: 'Eliminó', update_sensitive: 'Modificó (sensible)' };
      listEl.innerHTML = data.map(function(a) {
        const who = a.user_id ? (nameMap[a.user_id] || '') : '';
        const whoTxt = who ? ' · ' + esc(who) : '';
        const dt = formatDateTimeWithTZ ? formatDateTimeWithTZ(a.created_at) : new Date(a.created_at).toLocaleString('es-AR');
        const changes = (a.changed_fields || []).filter(function(f) { return f !== 'updated_at'; });
        const changesTxt = changes.length ? ' <span style="color:var(--text-dim);">(' + esc(changes.join(', ')) + ')</span>' : '';
        const failed = a.status && a.status !== 'success' && a.status !== 'ok';
        return '<div style="padding:8px 10px; background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:8px; margin-bottom:6px; font-size:12px; color:#fff;' + (failed ? ' border-left:3px solid var(--danger);' : '') + '">'
          + '<strong>' + esc(VERB[a.action] || a.action) + '</strong>' + changesTxt
          + '<div style="color:var(--text-dim); font-size:11px; margin-top:2px;">' + esc(dt) + esc(whoTxt) + '</div>'
          + '</div>';
      }).join('');
    } catch (err) {
      logError('loadPropertyHistory error:', err);
      listEl.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:12px;">Historial no disponible</p>';
    }
  }

  async function loadPropertyNotes(propertyId) {
    const listEl = $('#propertyNotesList');
    if (!listEl) return;
    _pendingPropertyNotes = [];
    if (!propertyId) { renderPendingPropertyNotes(); return; }
    try {
      const { data: notes, error } = await window.supabaseClient
        .from('property_notes')
        .select('*')
        .eq('property_id', propertyId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      if (!notes || !notes.length) { renderPendingPropertyNotes(); return; }
      const userIds = [...new Set(notes.map(n => n.created_by).filter(Boolean))];
      let nameMap = {};
      if (userIds.length) {
        const { data: profiles, error: pErr } = await window.supabaseClient
          .from('profiles')
          .select('id, full_name')
          .in('id', userIds);
        if (!pErr && profiles) nameMap = Object.fromEntries(profiles.map(p => [p.id, p.full_name || '']));
      }
      listEl.innerHTML = notes.map(n =>
        propertyNoteMarkup(n, n.created_by ? (nameMap[n.created_by] || 'Usuario') : 'Usuario')
      ).join('');
    } catch (err) {
      logError('loadPropertyNotes error:', err);
      renderPendingPropertyNotes();
    }
  }

  async function flushPendingPropertyNotes(propertyId) {
    const notes = _pendingPropertyNotes.splice(0, _pendingPropertyNotes.length);
    if (!notes.length || !propertyId) return;
    try {
      const { error } = await window.supabaseClient
        .from('property_notes')
        .insert(notes.map(text => ({
          property_id: propertyId,
          note: text,
          created_by: (currentUser && currentUser.id) ? currentUser.id : null,
        })));
      if (error) throw error;
    } catch (err) {
      logError('flushPendingPropertyNotes error:', err);
      showToast('La propiedad se creó, pero falló al guardar las notas', 'error');
    }
  }

  on($('#propertyNoteAddBtn'), 'click', async () => {
    const input = $('#propertyNoteInput');
    const text = input && input.value ? input.value.trim() : '';
    if (!text) {
      showToast('Escribí una nota antes de guardarla', 'warning');
      return;
    }
    if (input) input.value = '';
    if (!editingPropertyId) {
      _pendingPropertyNotes.push(text);
      renderPendingPropertyNotes();
      return;
    }
    try {
      const { error } = await window.supabaseClient
        .from('property_notes')
        .insert([{ property_id: editingPropertyId, note: text, created_by: (currentUser && currentUser.id) ? currentUser.id : null }]);
      if (error) throw error;
      showToast('Nota agregada', 'success');
      loadPropertyNotes(editingPropertyId);
    } catch (err) {
      logError('propiedad nota error:', err);
      showToast('No se pudo guardar la nota', 'error');
    }
  });

  /* Owner Properties */

  async function loadOwnerProperties(ownerId) {
    const el = $('#ownerPropsList');
    if (!el) return;
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('properties')
        .select('id, property_code, title, status, price_usd, price_currency, zone, created_at')
        .eq('owner_id', ownerId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      if (!data?.length) {
        el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Sin propiedades vinculadas</p>';
        return;
      }
      el.innerHTML = data.map(p => `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px; margin-bottom:8px; font-size:13px;">
          <div>
            <div style="font-weight:500; color:#fff;">${esc(p.property_code || 'S/Código')} · ${esc(p.title || 'Sin título')}</div>
            <div style="font-size:11px; color:var(--text-dim);">${esc(p.zone || 'S/Zona')} · ${p.price_usd ? 'USD ' + formatNumber(p.price_usd) : 'S/Precio'} · ${esc(p.status || 'draft')}</div>
          </div>
          <button class="btn-action" title="Ver Propiedad" onclick="window.adminApp.editProperty('${p.id}')"><i class="fas fa-external-link-alt"></i></button>
        </div>
      `).join('');
    } catch (_) { /* silent */ }
  }

  /* Owner Tasaciones */
  async function loadOwnerTasaciones(ownerId) {
    const el = $('#ownerTasacionesList');
    if (!el) return;
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('tasaciones')
        .select('id, type, status, valuation_usd, created_at, expires_at, property_id')
        .eq('owner_id', ownerId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      /* tasaciones no tiene FK a properties: lookup separado */
      const propIds = [...new Set((data || []).map(t => t.property_id).filter(Boolean))];
      let propMap = {};
      if (propIds.length) {
        const { data: props } = await window.supabaseClient
          .from('properties')
          .select('id, property_code, title')
          .in('id', propIds);
        (props || []).forEach(p => { propMap[p.id] = p; });
      }
      const rows = (data || []).map(t => ({ ...t, properties: propMap[t.property_id] || null }));
      if (!rows.length) {
        el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Sin tasaciones registradas</p>';
        return;
      }
      el.innerHTML = rows.map(t => `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px; margin-bottom:8px; font-size:13px;">
          <div>
            <div style="font-weight:500; color:#fff;">${esc(t.type)} · ${esc(t.properties?.title || t.properties?.property_code || 'Propiedad')}</div>
            <div style="font-size:11px; color:var(--text-dim);">USD ${t.valuation_usd ? formatNumber(t.valuation_usd) : '—'} · ${esc(t.status)} · ${t.created_at ? new Date(t.created_at).toLocaleDateString('es-AR') : ''}${t.expires_at ? ' · Vence: ' + new Date(t.expires_at).toLocaleDateString('es-AR') : ''}</div>
          </div>
          <button class="btn-action" title="Ver Tasación" onclick="window.adminApp.editTasacion?.('${t.id}')"><i class="fas fa-external-link-alt"></i></button>
        </div>
      `).join('');
    } catch (err) {
      logError('loadOwnerTasaciones error:', err);
      el.innerHTML = '<p style="color:var(--danger); font-size:12px; text-align:center; padding:20px;">Error cargando tasaciones</p>';
    }
  }

  /* Owner Timeline */
  async function loadOwnerTimeline(ownerId) {
    const el = $('#ownerTimelineList');
    if (!el) return;
    if (!window.supabaseClient) return;
    try {
      const { data: timeline, error } = await window.supabaseClient
        .from('owner_timeline_entries')
        .select('id, type, text, created_at')
        .eq('owner_id', ownerId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      if (!timeline?.length) {
        el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Sin comunicaciones registradas</p>';
        return;
      }
      el.innerHTML = timeline.map(entry => `
        <div style="display:flex; gap:10px; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px; margin-bottom:8px; font-size:12px;">
          <div style="width:32px; height:32px; border-radius:50%; background:rgba(31,200,195,0.15); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
            <i class="fas ${getTimelineIcon(entry.type)}" style="color:var(--accent); font-size:12px;"></i>
          </div>
          <div style="flex:1;">
            <div style="font-weight:500; color:#fff;">${esc(entry.text || '')}</div>
            <div style="font-size:10px; color:var(--text-dim);">${(entry.type || 'note').toUpperCase()} · ${entry.created_at ? new Date(entry.created_at).toLocaleString('es-AR') : ''}</div>
          </div>
          <button class="btn-action" title="Eliminar" onclick="window.adminApp.deleteTimelineEntry('${ownerId}', '${entry.id}')"><i class="fas fa-trash" style="font-size:10px;"></i></button>
        </div>
      `).join('');
    } catch (err) {
      el.innerHTML = '<p style="color:var(--danger); text-align:center; padding:20px;">Error cargando timeline</p>';
    }
  }

  function getTimelineIcon(type) {
    const icons = { note: 'fa-sticky-note', whatsapp: 'fa-whatsapp', email: 'fa-envelope', call: 'fa-phone', meeting: 'fa-handshake' };
    return icons[type] || 'fa-comment';
  }

  window.adminApp.deleteTimelineEntry = async function (ownerId, entryId) {
    if (!confirm('¿Eliminar esta entrada?')) return;
    try {
      const { error } = await window.supabaseClient.from('owner_timeline_entries').delete().eq('id', entryId);
      if (error) throw error;
      showToast('Entrada eliminada', 'success');
      loadOwnerTimeline(ownerId);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  /* Add timeline entry */
  $('#btnAddTimelineEntry')?.addEventListener('click', async () => {
    const text = $('#ownerTimelineNote')?.value?.trim();
    const type = $('#ownerTimelineType')?.value || 'note';
    if (!text) return showToast('Ingresá una nota', 'warning');
    if (!editingOwnerId) return showToast('Primero guarde el propietario', 'warning');
    try {
      const { error } = await window.supabaseClient
        .from('owner_timeline_entries')
        .insert([{ owner_id: editingOwnerId, type, text, created_by: currentUser?.id || null }]);
      if (error) throw error;
      $('#ownerTimelineNote').value = '';
      showToast('Comunicación agregada', 'success');
      loadOwnerTimeline(editingOwnerId);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });

  /* Delete owner */
  window.adminApp.deleteOwner = async function (id) {
    let conProps = 0;
    try {
      const { count } = await window.supabaseClient.from('properties').select('id', { count: 'exact', head: true }).eq('owner_id', id).is('deleted_at', null);
      conProps = count || 0;
    } catch (_) {}
    const extra = conProps > 0 ? '\n⚠ Tiene ' + conProps + ' propiedad(es) a su nombre. Quedan vinculadas pero el propietario se oculta.' : '';
    if (!confirm('¿Eliminar este propietario? Baja lógica restaurable.' + extra)) return;
    try {
      const { error } = await window.supabaseClient.from('owners').update({ deleted_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
      showToast('Propietario eliminado (baja lógica)', 'success');
      loadOwners();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.adminApp.restoreOwner = async function (id) {
    try {
      const { error } = await window.supabaseClient.from('owners').update({ deleted_at: null }).eq('id', id);
      if (error) throw error;
      showToast('Propietario restaurado.', 'success');
      loadOwners();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  on($('#ownerTrashToggle'), 'click', () => window.adminApp.toggleOwnersTrash && window.adminApp.toggleOwnersTrash());

  /* Owner search */
  on($('#ownerSearchInput'), 'input', (e) => {
    const q = e.target.value.toLowerCase();
    $$('#ownersTableBody tr').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  /* Export Owners CSV / PDF */
  window.adminApp.exportOwnersCSV = async function() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('owners')
        .select('*')
        .is('deleted_at', null)
        .order('full_name');
      if (error) throw error;
      const headers = ['Nombre', 'DNI/CUIT', 'Teléfono', 'Email', 'Dirección', 'Banco', 'CBU/CVU', 'Alias CBU', 'Preferencia Contacto', 'Exclusivo', 'Fecha Inicio Excl.', 'Fecha Fin Excl.', 'Comisión Venta %', 'Comisión Alquiler %', 'Notas'];
      const rows = (data || []).map(o => [
        o.full_name || '',
        o.dni_cuit || '',
        o.phone || '',
        o.email || '',
        o.address || '',
        o.bank_name || '',
        o.cbu_cvu || '',
        o.alias_cbu || '',
        o.preferred_contact || '',
        o.exclusive ? 'Sí' : 'No',
        o.exclusive_start || '',
        o.exclusive_end || '',
        o.commission_sale || '',
        o.commission_rent || '',
        (o.notes || '').replace(/\n/g, ' ')
      ].map(c => '"' + String(c).replace(/"/g, '""') + '"').join(','));
      const csv = [headers.join(','), ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'propietarios-' + new Date().toISOString().slice(0,10) + '.csv';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Archivo .csv descargado', 'success');
    } catch (err) {
      showToast('Error exportando CSV: ' + err.message, 'error');
    }
  };

  window.adminApp.exportOwnersPDF = async function() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('owners')
        .select('*')
        .is('deleted_at', null)
        .order('full_name');
      if (error) throw error;
      const content = (data || []).map(o => `
        <div style="page-break-inside: avoid; margin-bottom: 24px; padding: 16px; border: 1px solid #ddd; border-radius: 8px;">
          <h3 style="margin: 0 0 12px; color: #1a1a2e;">${esc(o.full_name || 'Sin nombre')}</h3>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px;">
            <div><strong>DNI/CUIT:</strong> ${esc(o.dni_cuit || '—')}</div>
            <div><strong>Teléfono:</strong> ${esc(o.phone || '—')}</div>
            <div><strong>Email:</strong> ${esc(o.email || '—')}</div>
            <div><strong>Dirección:</strong> ${esc(o.address || '—')}</div>
            <div><strong>Banco:</strong> ${esc(o.bank_name || '—')}</div>
            <div><strong>CBU/CVU:</strong> ${esc(o.cbu_cvu || '—')}</div>
            <div><strong>Alias CBU:</strong> ${esc(o.alias_cbu || '—')}</div>
            <div><strong>Contacto:</strong> ${esc(o.preferred_contact || 'whatsapp')}</div>
            <div><strong>Exclusivo:</strong> ${o.exclusive ? 'Sí' : 'No'}</div>
            <div><strong>Ini. Exclusividad:</strong> ${o.exclusive_start || '—'}</div>
            <div><strong>Fin Exclusividad:</strong> ${o.exclusive_end || '—'}</div>
            <div><strong>Com. Venta:</strong> ${o.commission_sale || '—'}%</div>
            <div><strong>Com. Alquiler:</strong> ${o.commission_rent || '—'}%</div>
          </div>
          ${o.notes ? `<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #eee;"><strong>Notas:</strong><br>${esc(o.notes).replace(/\n/g, '<br>')}</div>` : ''}
        </div>
      `).join('');
      const html = `
        <!DOCTYPE html>
        <html><head>
          <meta charset="UTF-8">
          <title>Reporte Propietarios</title>
          <style>
            body { font-family: Inter, sans-serif; padding: 24px; color: #1a1a2e; }
            h1 { color: #1a1a2e; border-bottom: 2px solid #1fc8c3; padding-bottom: 8px; }
            @media print { body { padding: 0; } }
          </style>
        </head><body>
          <h1>Reporte de Propietarios — ${new Date().toLocaleDateString('es-AR')}</h1>
          ${content}
        </body></html>
      `;
      const w = window.open('', '_blank', 'noopener');
      w.document.write(html);
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 300);
      showToast('PDF generado (imprimir/guardar)', 'success');
    } catch (err) {
      showToast('Error generando PDF: ' + err.message, 'error');
    }
  };

  /* Event listeners for export buttons */
  $('#btnExportOwnersCSV')?.addEventListener('click', window.adminApp.exportOwnersCSV);
  $('#btnExportOwnersPDF')?.addEventListener('click', window.adminApp.exportOwnersPDF);

  /* ------------------------------------------------
     12. USERS MANAGEMENT
     ------------------------------------------------ */
  const USER_ROLE_LABELS = { super_admin: 'Super Admin', broker: 'Broker', agente: 'Agente' };
  const USER_ROLE_ORDER = ['super_admin', 'broker', 'agente'];
  let usersCache = [];

  function buildRoleSelect(userId, currentRole) {
    const isSelf = currentUser && userId === currentUser.id;
    if (isSelf) {
      return '<span style="color:var(--text-dim); font-size:12px;">Tu usuario</span>';
    }
    const options = USER_ROLE_ORDER.map(r =>
      `<option value="${r}" ${currentRole === r ? 'selected' : ''}>${USER_ROLE_LABELS[r]}</option>`
    ).join('');
    return `<select class="user-role-select" data-id="${esc(userId)}" data-current="${esc(currentRole || 'agente')}" style="background:rgba(255,255,255,0.03); border:1px solid var(--border-input); border-radius:10px; padding:7px 12px; color:#fff; font-size:12.5px;">${options}</select>`;
  }

  function canManageUsers() {
    return !!currentProfile && currentProfile.role === 'super_admin';
  }

  function userStatusCellHtml(u) {
    const isSelf = !!(currentUser && u.id === currentUser.id);
    const active = u.is_active !== false;
    if (!canManageUsers() || isSelf) {
      return '<span class="nav-badge" style="background:' + (active ? 'rgba(0,200,120,0.15)' : 'rgba(255,60,60,0.15)') + '; color:' + (active ? 'var(--success)' : 'var(--danger)') + '; font-size:11px;">' + (active ? 'Activo' : 'Inactivo') + '</span>';
    }
    return '<button type="button" class="nav-badge user-status-toggle" data-id="' + esc(u.id) + '" title="' + (active ? 'Desactivar acceso' : 'Reactivar acceso') + '" style="background:' + (active ? 'rgba(0,200,120,0.15)' : 'rgba(255,60,60,0.15)') + '; color:' + (active ? 'var(--success)' : 'var(--danger)') + '; font-size:11px; border:none; cursor:pointer;">' + (active ? 'Activo' : 'Inactivo') + '</button>';
  }

  function userEditCellHtml(u) {
    const isSelf = !!(currentUser && u.id === currentUser.id);
    if (!(canManageUsers() || isSelf)) {
      return '<span style="color:var(--text-dim); font-size:12px;">-</span>';
    }
    return '<button type="button" class="user-edit-btn" data-id="' + esc(u.id) + '" title="' + (isSelf ? 'Editar mi usuario' : 'Editar usuario') + '" style="background:rgba(255,255,255,0.05); border:1px solid var(--border-input); border-radius:8px; padding:6px 10px; color:var(--accent); cursor:pointer;"><i class="fas fa-pen-to-square"></i></button>';
  }

  async function loadUsers() {
    invalidateSearchCache();
    const tbody = $('#usersTableBody');
    if (!tbody) return;
    const client = await getAuthedClient();
    if (!client) return;

    try {
      const { data, error } = await client
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) throw error;
      usersCache = data || [];

      if (!usersCache.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--text-dim);">No hay usuarios</td></tr>';
        return;
      }

      tbody.innerHTML = data.map((u) => `
        <tr>
          <td style="font-weight:500; color:#fff; font-size:13px;">${esc(u.full_name || u.email || 'Sin nombre')}</td>
          <td style="font-size:13px; color:var(--text-dim);">${esc(u.email || '-')}</td>
          <td><span class="nav-badge" style="background:${u.role === 'super_admin' ? 'rgba(31,200,195,0.15)' : 'rgba(255,255,255,0.06)'}; color:${u.role === 'super_admin' ? 'var(--accent)' : 'var(--text-dim)'}; font-size:11px;">${esc(USER_ROLE_LABELS[u.role] || u.role || 'agente')}</span></td>
          <td>${userStatusCellHtml(u)}</td>
          <td style="color:var(--text-dim); font-size:12px;">${u.created_at ? new Date(u.created_at).toLocaleDateString('es-AR') : '-'}</td>
          <td>${buildRoleSelect(u.id, u.role)}</td>
          <td>${userEditCellHtml(u)}</td>
        </tr>`).join('');
    } catch (err) {
      logError('Users error:', err);
    }
  }

  /* User management via edge function manage-users (requiere super_admin). */
  async function getAdminToken() {
    if (!window.supabaseClient) throw new Error('Supabase no disponible');
    const { data, error } = await window.supabaseClient.auth.getSession();
    if (error || !data?.session?.access_token) throw new Error('Sesión requerida');
    return data.session.access_token;
  }

  async function callManageUsers(payload) {
    const token = await getAdminToken();
    const res = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/manage-users`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Error ${res.status}`);
    }
    return res.json().catch(() => ({}));
  }

  function showUserTempPassword(tempPassword, email) {
    const box = $('#userTempPassBox');
    const input = $('#userTempPass');
    if (box && input) {
      box.style.display = '';
      input.value = tempPassword;
      input.focus();
      input.select();
    }
    showToast(`Usuario creado: ${email}. Copiá la contraseña temporal y pasásela al usuario.`, 'warning');
  }

  on($('#userTempPass'), 'click', function () { this.select(); });
  on($('#userTempPassCopy'), 'click', async function () {
    const input = $('#userTempPass');
    if (!input || !input.value) return;
    try {
      await navigator.clipboard.writeText(input.value);
      showToast('Contraseña copiada al portapapeles', 'success');
    } catch {
      input.select();
      document.execCommand('copy');
      showToast('Contraseña copiada', 'success');
    }
  });

  on($('#btnExportUsers'), 'click', () => {
    if (!usersCache.length) { showToast('No hay usuarios para exportar', 'warning'); return; }
    const headers = ['ID', 'Nombre', 'Email', 'Teléfono', 'Rol', 'Activo', 'Creado'];
    const rows = usersCache.map(u => [
      u.id, u.full_name || '', u.email || '', u.phone || '',
      USER_ROLE_LABELS[u.role] || u.role || '', u.is_active === false ? 'No' : 'Sí',
      u.created_at ? new Date(u.created_at).toISOString().slice(0, 10) : ''
    ]);
    downloadCSV(`usuarios-${new Date().toISOString().slice(0, 10)}.csv`, rows, headers);
    showToast(`Usuarios exportados (${rows.length})`, 'success');
  });

  let _usersSearchTimer = null;
  const usersSearchEl = $('#usersSearchInput');
  if (usersSearchEl && !usersSearchEl.dataset.bound) {
    usersSearchEl.dataset.bound = '1';
    usersSearchEl.addEventListener('input', () => {
      clearTimeout(_usersSearchTimer);
      _usersSearchTimer = setTimeout(() => {
        const q = usersSearchEl.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        $$('#usersTableBody tr').forEach(tr => {
          const txt = (tr.textContent || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          tr.style.display = !q || txt.includes(q) ? '' : 'none';
        });
      }, 200);
    });
  }

  on($('#btnNewUser'), 'click', () => {
    $('#userForm')?.reset();
    const passBox = $('#userTempPassBox');
    if (passBox) passBox.style.display = 'none';
    openModal('userModal');
  });

  const userNoEmailCb = document.querySelector('#userForm input[name="no_email"]');
  on(userNoEmailCb, 'change', () => {
    const btn = $('#userSaveBtn');
    if (btn) btn.textContent = userNoEmailCb.checked ? 'Crear Usuario' : 'Enviar Invitación';
  });

  on($('#userForm'), 'submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = $('#userSaveBtn');
    if (!btn) return;
    const fd = new FormData(form);
    btn.disabled = true;
    try {
      const noEmail = fd.get('no_email') === 'on';
      const out = await callManageUsers({
        action: noEmail ? 'create-direct' : 'invite',
        email: String(fd.get('email') || '').trim(),
        full_name: String(fd.get('full_name') || '').trim(),
        phone: String(fd.get('phone') || '').trim(),
        role: String(fd.get('role') || 'agente'),
      });
      if (noEmail && out.tempPassword) {
        showUserTempPassword(out.tempPassword, String(fd.get('email') || '').trim());
        loadUsers();
      } else {
        showToast(`Invitación enviada a ${fd.get('email')}. Debe aceptarla desde su email para definir su contraseña.`, 'success');
        closeModal('userModal');
        form.reset();
        loadUsers();
      }
    } catch (err) {
      let msg = err.message || 'No se pudo enviar la invitación';
      if (/rate limit|too many|429/i.test(msg)) {
        msg = 'Se alcanzó el límite de emails por hora del servidor. Usá "Crear sin email" o configurá un SMTP propio (Authentication ? SMTP).';
      }
      showToast(msg, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  on($('#usersTableBody'), 'change', async (e) => {
    const select = e.target.closest('.user-role-select');
    if (!select) return;
    const previous = select.dataset.current || 'agente';
    const next = select.value;
    if (next === previous) return;

    if (previous === 'super_admin' && !window.confirm(`¿Quitar el rol Super Admin a este usuario?`)) {
      select.value = previous;
      return;
    }
    const ROLE_RANK = { agente: 1, broker: 2, super_admin: 3 };
    if ((ROLE_RANK[next] || 0) < (ROLE_RANK[previous] || 0) && !window.confirm(`¿Degradar a este usuario de ${USER_ROLE_LABELS[previous] || previous} a ${USER_ROLE_LABELS[next] || next}?`)) {
      select.value = previous;
      return;
    }
    select.disabled = true;
    try {
      await callManageUsers({ action: 'set-role', userId: select.dataset.id, role: next });
      showToast('Rol actualizado correctamente', 'success');
      loadUsers();
    } catch (err) {
      select.value = previous;
      showToast(err.message || 'No se pudo cambiar el rol', 'error');
    } finally {
      select.disabled = false;
    }
  });

  on($('#usersTableBody'), 'click', async (e) => {
    const editBtn = e.target.closest('.user-edit-btn');
    if (editBtn) {
      openUserEditor(editBtn.dataset.id);
      return;
    }
    const toggleBtn = e.target.closest('.user-status-toggle');
    if (toggleBtn && !toggleBtn.disabled) await toggleUserActive(toggleBtn.dataset.id);
  });

  on($('#sidebarUserProfile'), 'click', (e) => {
    /* Logout y cambio de contraseña viven dentro de la tarjeta:
       ninguno de los dos debe abrir el editor. */
    if (e.target.closest('#logoutBtn')) return;
    if (e.target.closest('#changePasswordBtn')) return;
    if (currentProfile?.id) openUserEditor(currentProfile.id);
  });

  function openPasswordModal() {
    $('#passwordChangeForm')?.reset();
    const errEl = $('#passwordChangeError');
    if (errEl) { errEl.style.display = 'none'; }
    openModal('passwordModal');
  }

  on($('#changePasswordBtn'), 'click', () => {
    if (!currentUser || !window.supabaseClient) return;
    openPasswordModal();
  });

  function openUserEditor(userId) {
    const row = usersCache.find((u) => u.id === userId);
    const form = $('#userEditForm');
    if (!row || !form || !currentProfile) return;

    form.reset();
    form.elements.userId.value = row.id;
    form.elements.full_name.value = row.full_name || '';
    form.elements.email.value = row.email || '';
    form.elements.phone.value = row.phone || '';
    form.elements.role.value = USER_ROLE_ORDER.includes(row.role) ? row.role : 'agente';
    form.elements.is_active.value = row.is_active === false ? 'false' : 'true';

    const isSelf = row.id === currentProfile.id;
    const lockPrivileged = isSelf || !canManageUsers();

    /* Rol y estado propios bloqueados en UI y backend: nadie se auto-degrada
       ni auto-desactiva, y nunca queda el sistema sin super_admin activo. */
    form.elements.role.disabled = lockPrivileged;
    form.elements.is_active.disabled = lockPrivileged;
    const roleHint = $('#userEditRoleHint');
    const statusHint = $('#userEditStatusHint');
    if (roleHint) roleHint.style.display = isSelf ? '' : 'none';
    if (statusHint) statusHint.style.display = isSelf ? '' : 'none';

    const note = $('#userEditEmailNote');
    if (note) {
      const showNote = isSelf && !canManageUsers();
      note.style.display = showNote ? '' : 'none';
      note.textContent = showNote
        ? 'Si cambiás tu email vas a recibir una confirmación en la casilla nueva para aplicar el cambio.'
        : '';
    }

    openModal('userEditModal');
  }

  async function toggleUserActive(userId) {
    if (!canManageUsers() || userId === currentProfile?.id) return;
    const row = usersCache.find((u) => u.id === userId);
    if (!row) return;

    const nextActive = row.is_active === false;
    const label = row.full_name || row.email || 'este usuario';
    if (!nextActive) {
      let orphanNote = '';
      try {
        const { count } = await window.supabaseClient.from('leads').select('id', { count: 'exact', head: true }).eq('assigned_to', userId).is('deleted_at', null);
        if (count) orphanNote = ` Tiene ${count} lead${count !== 1 ? 's' : ''} asignado${count !== 1 ? 's' : ''} que quedarán sin atención.`;
      } catch (_) {}
      if (!window.confirm(`¿Desactivar el acceso de ${label}? No podrá volver a iniciar sesión.${orphanNote}`)) return;
    } else {
      if (!window.confirm(`¿Reactivar el acceso de ${label}?`)) return;
    }

    try {
      await callManageUsers({ action: 'update-user', userId, is_active: nextActive });
      showToast(nextActive ? 'Usuario reactivado' : 'Usuario desactivado', 'success');
      loadUsers();
    } catch (err) {
      showToast(err.message || 'No se pudo cambiar el estado', 'error');
    }
  }

  on($('#userEditForm'), 'submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = $('#userEditSaveBtn');
    if (!btn || !currentProfile) return;

    const fd = new FormData(form);
    const userId = String(fd.get('userId') || '');
    const fullName = String(fd.get('full_name') || '').trim().replace(/\s+/g, ' ');
    const email = String(fd.get('email') || '').trim().toLowerCase();
    const phone = String(fd.get('phone') || '').trim();
    const row = usersCache.find((u) => u.id === userId);
    if (!userId || !row) return;

    if (!fullName || fullName.length < 2) {
      showToast('El nombre completo es obligatorio (mín. 2 caracteres)', 'error');
      return;
    }
    const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (email && !EMAIL_RX.test(email)) {
      showToast('Email inválido', 'error');
      return;
    }
    const dup = usersCache.find(u => u.id !== userId && String(u.email || '').toLowerCase() === email);
    if (dup) {
      showToast('Otro usuario ya usa ese email', 'error');
      return;
    }

    const isSelf = userId === currentProfile.id;
    const isAdmin = canManageUsers();

    /* Sin rol admin solo hay autogestion: defensa extra junto al backend. */
    if (!isAdmin && !isSelf) {
      showToast('Solo podés editar tu propio usuario.', 'error');
      return;
    }
    const emailChanged = !!email && email !== String(row.email || '').toLowerCase();

    btn.disabled = true;
    try {
      let emailNotice = '';

      /* Email propio sin rol admin: flujo estandar de Supabase con
         confirmacion por mail en ambas casillas. */
      if (!isAdmin && emailChanged) {
        const { error: emailErr } = await window.supabaseClient.auth.updateUser({ email });
        if (emailErr) throw emailErr;
        emailNotice = ' Cambio de email pendiente: revisá la casilla nueva para confirmarlo.';
      }

      const payload = isAdmin
        ? { action: 'update-user', userId, full_name: fullName, phone }
        : { action: 'update-self', full_name: fullName, phone };

      if (isAdmin && emailChanged) payload.email = email;

      if (isAdmin && !isSelf) {
        const nextRole = String(fd.get('role') || '');
        if (nextRole && nextRole !== row.role) {
          if (row.role === 'super_admin' && !window.confirm('¿Quitar el rol Super Admin a este usuario?')) {
            return;
          }
          payload.role = nextRole;
        }
        const nextActive = fd.get('is_active') !== 'false';
        if (nextActive !== (row.is_active !== false)) {
          if (row.role === 'super_admin' && !nextActive && !window.confirm(`¿Desactivar a ${row.full_name || 'este Super Admin'}? No podrá volver a iniciar sesión.`)) {
            return;
          }
          payload.is_active = nextActive;
        }
      }

      await callManageUsers(payload);

      closeModal('userEditModal');
      showToast(`Usuario actualizado.${emailNotice}`, 'success');
      await loadUsers();
      if (isSelf) {
        currentProfile = { ...currentProfile, full_name: fullName, phone };
        window._bhCurrentProfile = currentProfile;
        updateUserInfo();
      }
    } catch (err) {
      showToast(err.message || 'No se pudo actualizar el usuario', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  /* Eliminar usuario (solo super_admin, nunca uno mismo). Llama a Edge Function manage-users con action=delete-user */
  on($('#userEditDeleteBtn'), 'click', async () => {
    const form = $('#userEditForm');
    if (!form) return;
    const userId = form.elements.userId.value;
    if (!userId) return;

    if (!canManageUsers()) {
      showToast('Solo Super Admin puede eliminar usuarios', 'error');
      return;
    }
    if (userId === currentProfile?.id) {
      showToast('No podés eliminarte a vos mismo', 'error');
      return;
    }

    const row = usersCache.find(u => u.id === userId);
    const label = row?.full_name || row?.email || 'este usuario';
    if (!window.confirm(`¿Eliminar definitivamente a ${label}? Se borrará de auth.users y su perfil.`)) {
      return;
    }

    const btn = $('#userEditDeleteBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Eliminando...';
    try {
      await callManageUsers({ action: 'delete-user', userId });
      closeModal('userEditModal');
      showToast('Usuario eliminado', 'success');
      await loadUsers();
    } catch (err) {
      showToast(err.message || 'No se pudo eliminar el usuario', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'Eliminar Usuario';
    }
  });

  /* Cambio de contraseña propia: único flujo permitido. Se re-autentica con
     la contraseña actual antes de aplicar el cambio; Supabase solo actualiza
     la del usuario de la sesión, así nadie puede cambiar la de un tercero. */
  on($('#passwordChangeForm'), 'submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const currentPwd = String(fd.get('current_password') || '');
    const pwd = String(fd.get('password') || '');
    const pwd2 = String(fd.get('password2') || '');
    const errEl = $('#passwordChangeError');
    const btn = $('#passwordChangeBtn');
    const fail = (msg) => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!currentUser || !window.supabaseClient) return;
    if (!currentPwd) return fail('Ingresá tu contraseña actual.');
    if (pwd.length < 6) return fail('La nueva contraseña debe tener al menos 6 caracteres.');
    if (pwd !== pwd2) return fail('Las contraseñas nuevas no coinciden.');

    // HIBP check (fail-open)
    const pwned = await checkPasswordPwned(pwd);
    if (pwned.pwned) {
      return fail(`Esta contraseña apareció en ${pwned.count.toLocaleString('es-AR')} filtraciones de datos. Usa otra más segura.`);
    }

    btn.disabled = true;
    try {
      /* Verificación de identidad: si la actual no coincide, no se cambia nada. */
      const { error: verifyErr } = await window.supabaseClient.auth.signInWithPassword({
        email: currentUser.email,
        password: currentPwd,
      });
      if (verifyErr) {
        fail('La contraseña actual es incorrecta.');
        return;
      }

      const { error } = await window.supabaseClient.auth.updateUser({ password: pwd });
      if (error) throw error;

      closeModal('passwordModal');
      showToast('Contraseña actualizada correctamente', 'success');
    } catch (err) {
      fail(err.message || 'No se pudo cambiar la contraseña.');
    } finally {
      btn.disabled = false;
    }
  });

  /* ------------------------------------------------
     13. PORTALS
     ------------------------------------------------ */
  const PORTALS = [
    { name: 'ZonaProp', icon: 'fas fa-building', color: '#3B82F6', url: 'https://www.zonaprop.com.ar' },
    { name: 'Argenprop', icon: 'fas fa-home', color: '#10B981', url: 'https://www.argenprop.com' },
    { name: 'Mercado Libre', icon: 'fas fa-shopping-cart', color: '#FFE600', url: 'https://inmuebles.mercadolibre.com.ar' },
    { name: 'Argentpropiedades', icon: 'fas fa-key', color: '#F97316', url: 'https://www.argentpropiedades.com.ar' },
    { name: 'Properati', icon: 'fas fa-map-marker-alt', color: '#8B5CF6', url: 'https://www.properati.com.ar' },
    { name: 'MiArgPropiedad', icon: 'fas fa-house-chimney', color: '#EC4899', url: 'https://www.miargpropiedad.com.ar' },
  ];

  async function loadPortals() {
    const container = $('#portalsContainer');
    if (!container) return;
    if (!window.supabaseClient) return;

    mlCheckStatus(false).catch(() => {});
    updatePortalsBadge();

    const canManagePortals = ['super_admin', 'broker'].includes(currentProfile?.role);

    /* Get published property count + portal settings from DB */
    const [propsRes, settingsRes, mlConnRes, mlQuestionsRes] = await Promise.all([
      window.supabaseClient.from('properties').select('*', { count: 'exact', head: true }).eq('is_published', true).is('deleted_at', null),
      canManagePortals
        ? window.supabaseClient.from('portal_settings').select('*')
        : window.supabaseClient.from('portal_settings').select('portal_name, is_active'),
      window.supabaseClient.from('ml_connection').select('token_expires_at, nickname').limit(1).maybeSingle().then(r => r).catch(() => ({ data: null })),
      ml_connected
        ? window.supabaseClient.from('ml_questions').select('id', { count: 'exact', head: true }).eq('status', 'UNANSWERED').then(r => r).catch(() => ({ count: null }))
        : Promise.resolve({ count: null }),
    ]);
    if (propsRes.error) logWarn('portals: error contando publicados: ' + propsRes.error.message);
    if (settingsRes.error) logWarn('portals: error leyendo portal_settings: ' + settingsRes.error.message);

    const count = propsRes.count || 0;
    const settingsMap = {};
    (settingsRes.data || []).forEach(s => { settingsMap[s.portal_name] = s; });

    container.innerHTML = PORTALS.map((p, i) => {
      const db = settingsMap[p.name] || {};
      const isActive = db.is_active || false;

      if (p.name === 'Mercado Libre') {
        const statusColor = ml_connected ? 'var(--success)' : ml_configured ? '#FFE600' : 'var(--text-dim)';
        const statusText = ml_connected ? 'Conectado' : ml_configured ? 'Configurado' : 'No configurado';
        const statusIcon = ml_connected ? 'fas fa-circle-check' : ml_configured ? 'fas fa-circle-half-stroke' : 'fas fa-circle-xmark';
        const pendingQuestions = ml_connected ? (mlQuestionsRes.count ?? 0) : 0;
        const questionsHtml = ml_connected
          ? `<p style="font-size:11px; color:${pendingQuestions > 0 ? 'var(--warning)' : 'var(--text-dim)'}; margin-top:4px;">${pendingQuestions > 0 ? '⚠ ' : ''}${pendingQuestions} pregunta${pendingQuestions !== 1 ? 's' : ''} sin responder</p>`
          : '';
        const mlBtnHtml = ml_connected
          ? `<button class="btn-action danger" style="font-size:11px; padding:6px 12px; white-space:nowrap;" onclick="window.adminApp.mlDisconnect()"><i class="fas fa-link-slash"></i> Desconectar</button>`
          : ml_configured
            ? `<button class="btn-action" style="font-size:11px; padding:6px 12px; background:rgba(255,230,0,0.15); color:#FFE600; border:1px solid rgba(255,230,0,0.3);" onclick="window.adminApp.mlConnect()"><i class="fas fa-link"></i> Conectar ML</button>`
            : '';
        const activeListings = ml_connected ? ml_listings.filter(l => l.status === 'active').length : 0;
        const listingsHtml = ml_connected
          ? `<p style="color:var(--text-dim); font-size:11px; margin-top:2px;">${activeListings} aviso${activeListings !== 1 ? 's' : ''} activo${activeListings !== 1 ? 's' : ''} en ML</p>`
          : '';
        const mlTokenExpiry = mlConnRes?.data?.token_expires_at ? new Date(mlConnRes.data.token_expires_at) : null;
        const expiryHtml = ml_connected && mlTokenExpiry
          ? (() => {
              const daysLeft = Math.floor((mlTokenExpiry.getTime() - Date.now()) / 86400000);
              if (daysLeft < 0) return '<p style="font-size:11px; color:var(--danger); margin-top:6px;">⚠ Token ML vencido — reconectá</p>';
              if (daysLeft < 7) return `<p style="font-size:11px; color:var(--warning); margin-top:6px;">⚠ Token ML vence en ${daysLeft}d</p>`;
              return `<p style="font-size:10px; color:var(--text-dim); margin-top:6px;">Token ML OK (${daysLeft}d)</p>`;
            })()
          : '';
        const userInfoHtml = ml_connected && ml_user
          ? `<p style="color:var(--text-muted); font-size:11px; margin-top:6px;"><i class="fas fa-user" style="margin-right:4px;"></i>${esc(ml_user.ml_nickname || ml_user.ml_email || '')}</p>`
          : '';
        const configPanelHtml = !ml_configured ? `
          <div id="mlConfigPanel" class="ml-config-panel" style="display:none; margin-top:12px; text-align:left;">
            <div class="ml-config-field">
              <label>APP ID</label>
              <input type="text" id="mlAppIdInput" placeholder="Ej: 12345678901234" class="ml-config-input" />
            </div>
            <div class="ml-config-field">
              <label>SECRET KEY</label>
              <input type="password" id="mlSecretInput" placeholder="NGRD...tu-secret-key" class="ml-config-input" />
            </div>
            <button class="btn-action" style="width:100%; margin-top:8px; background:rgba(255,230,0,0.15); color:#FFE600; border:1px solid rgba(255,230,0,0.3);" onclick="window.adminApp.mlSaveCredentials()">
              <i class="fas fa-save"></i> Guardar Credenciales
            </button>
          </div>` : '';

        return `
      <div class="glass-panel portal-card" style="padding:24px; text-align:center;">
        <div style="width:56px; height:56px; border-radius:16px; background:${p.color}20; display:flex; align-items:center; justify-content:center; margin:0 auto 14px;">
          <i class="${p.icon}" style="font-size:24px; color:${p.color};"></i>
        </div>
        <h3 style="color:#fff; font-size:16px; font-weight:700; margin-bottom:4px;">${p.name}</h3>
        <div style="display:flex; align-items:center; justify-content:center; gap:6px; margin-bottom:14px;">
          <i class="${statusIcon}" style="font-size:12px; color:${statusColor};"></i>
          <span style="font-size:12px; color:${statusColor}; font-weight:600;">${statusText}</span>
        </div>
        ${userInfoHtml}
        ${listingsHtml}
        ${questionsHtml}
        ${expiryHtml}
        <div style="display:flex; align-items:center; justify-content:center; gap:8px; margin-top:12px; flex-wrap:wrap; ${canManagePortals ? '' : 'opacity:.5; pointer-events:none;'}">
          ${mlBtnHtml}
          ${!ml_configured ? `<button class="btn-action" title="Configurar credenciales" style="font-size:11px; padding:6px 12px;" onclick="window.adminApp.mlToggleConfig()"><i class="fas fa-cog"></i></button>` : ''}
          ${ml_connected ? `<button class="btn-action" title="Importar desde ML" style="font-size:11px; padding:6px 12px;" onclick="window.adminApp.mlImportFromML()"><i class="fas fa-file-import"></i></button>` : ''}
        </div>
        ${canManagePortals ? configPanelHtml : ''}
        ${canManagePortals ? '' : '<p style="font-size:11px; color:var(--text-dim); margin-top:10px;">Solo lectura para tu rol</p>'}
      </div>`;
      }

      const backendAvailable = ['Mercado Libre', 'ZonaProp'].includes(p.name);
      const isZona = p.name === 'ZonaProp';
      const zonaLinkHtml = isZona
        ? '<p style="font-size:11px; color:var(--text-dim); margin-top:10px;">Se gestiona desde el panel RELA de abajo</p>'
        : '';
      const ghostBadge = !backendAvailable
        ? '<span class="nav-badge" style="background:rgba(255,255,255,0.05); color:var(--text-dim); font-size:10px; margin-bottom:8px; display:inline-block;">Sin integración automática (próximamente)</span>'
        : '';
      return `
      <div class="glass-panel portal-card" style="padding:24px; text-align:center;${backendAvailable ? '' : ' opacity:.75;'}">
        <div style="width:56px; height:56px; border-radius:16px; background:${p.color}20; display:flex; align-items:center; justify-content:center; margin:0 auto 14px;">
          <i class="${p.icon}" style="font-size:24px; color:${p.color};"></i>
        </div>
        <h3 style="color:#fff; font-size:16px; font-weight:700; margin-bottom:4px;">${p.name}</h3>
        ${ghostBadge}
        <p style="color:var(--text-dim); font-size:12px; margin-bottom:14px;">${count} inmuebles publicables</p>
        <div style="display:flex; align-items:center; justify-content:center; gap:10px; ${canManagePortals && backendAvailable ? '' : 'opacity:.5; pointer-events:none;'}">
          <button type="button" role="switch" aria-checked="${isActive}" data-portal-toggle="${esc(p.name)}" class="portal-toggle${isActive ? ' is-on' : ''}" ${canManagePortals && backendAvailable ? '' : 'disabled title="' + (backendAvailable ? 'Solo super_admin o broker' : 'Sin integración todavía') + '"'}>
            <span class="portal-toggle-knob"></span>
          </button>
          <button class="btn-action" title="${canManagePortals ? 'Configurar API' : 'Solo super_admin o broker'}" onclick="window.adminApp.openPortalConfig(${i})"><i class="fas fa-cog"></i></button>
        </div>
        ${zonaLinkHtml}
        ${canManagePortals ? '' : '<p style="font-size:11px; color:var(--text-dim); margin-top:10px;">Solo lectura para tu rol</p>'}
      </div>`;
    }).join('');

    loadRelaPanel();
    loadSyncHistory();
    loadMlQuestionsPanel();
  }

  async function loadMlQuestionsPanel() {
    const el = $('#mlQuestionsList');
    if (!el || !window.supabaseClient) return;
    if (!ml_connected) {
      el.innerHTML = '<p style="color:var(--text-dim); font-size:12px;">Conectá Mercado Libre para ver preguntas de clientes.</p>';
      return;
    }
    try {
      const { data, error } = await window.supabaseClient
        .from('ml_questions')
        .select('id, question_id, ml_item_id, question_text, from_user_nickname, date_created, status, answer_text')
        .order('date_created', { ascending: false })
        .limit(20);
      if (error) throw error;
      if (!data || !data.length) {
        el.innerHTML = '<p style="color:var(--text-dim); font-size:12px;">Sin preguntas registradas todavía.</p>';
        return;
      }
      el.innerHTML = data.map(q => `
        <div style="padding:12px 14px; border:1px solid var(--border-subtle); border-radius:10px; background:rgba(255,255,255,0.02);">
          <div style="display:flex; justify-content:space-between; gap:10px; font-size:12px; color:var(--text-dim); margin-bottom:6px;">
            <span>${esc(q.ml_item_id || '')} · ${esc(q.from_user_nickname || 'anónimo')}</span>
            <span>${q.date_created ? new Date(q.date_created).toLocaleString('es-AR') : '—'}</span>
          </div>
          <div style="color:#fff; font-size:13px; margin-bottom:8px;">${esc(q.question_text || '')}</div>
          ${q.status === 'ANSWERED'
            ? `<div style="font-size:12px; color:var(--success);"><i class="fas fa-check"></i> ${esc(q.answer_text || 'Respondida')}</div>`
            : `<div style="margin-top:10px; display:flex; gap:8px;">
                 <input type="text" data-ml-answer-input="${q.id}" placeholder="Escribir respuesta..." style="flex:1; padding:8px 12px; background:rgba(255,255,255,0.03); border:1px solid var(--border-input); border-radius:8px; color:#fff; font-size:12px;" />
                 <button class="btn-action" data-ml-answer="${q.question_id || q.id}" style="padding:8px 14px; font-size:11px; white-space:nowrap;"><i class="fas fa-paper-plane"></i> Responder</button>
               </div>`}
        </div>
      `).join('');
      el.querySelectorAll('[data-ml-answer]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const input = btn.previousElementSibling;
          const text = input?.value?.trim();
          if (!text) { showToast('Escribí la respuesta primero', 'warning'); return; }
          btn.disabled = true;
          btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
          try {
            await mlApiCall('answer-question', { question_id: btn.dataset.mlAnswer, text });
            showToast('Respuesta enviada a ML', 'success');
            loadMlQuestionsPanel();
          }
          catch (err) { showToast('Error: ' + err.message, 'error'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Responder'; }
        });
      });
    } catch (err) {
      logWarn('ml questions: ' + err.message);
      el.innerHTML = '<p style="color:var(--text-dim); font-size:12px;">No se pudieron cargar las preguntas.</p>';
    }
  }

  async function loadSyncHistory() {
    const tbody = $('#syncLogsTableBody');
    if (!tbody || !window.supabaseClient) return;
    try {
      const [histRes, queueRes, relaRes] = await Promise.all([
        window.supabaseClient
          .from('ml_sync_history')
          .select('operation, status, created_at, queue_id, error')
          .order('created_at', { ascending: false })
          .limit(10),
        window.supabaseClient
          .from('ml_sync_queue')
          .select('id, property_id, operation, status, next_attempt_at, attempts, max_attempts, last_error, created_at')
          .in('status', ['pending', 'processing', 'failed'])
          .order('created_at', { ascending: false })
          .limit(10),
        window.supabaseClient
          .from('rela_webhook_events')
          .select('id, tipo_evento, referencia, processed, process_error, received_at')
          .order('received_at', { ascending: false })
          .limit(10)
          .then(r => r).catch(() => ({ data: null })),
      ]);
      if (histRes.error) throw histRes.error;
      const data = histRes.data || [];
      const queue = queueRes.data || [];

      const opLabels = { publish: 'Publicación', update: 'Actualización', delete: 'Eliminación' };
      const queueHtml = queue.map(row => `<tr>
        <td style="font-size:12px;">${new Date(row.created_at).toLocaleString('es-AR')}</td>
        <td><span class="nav-badge" style="background:rgba(255,230,0,0.12); color:#FFE600; font-size:10px;">Mercado Libre</span></td>
        <td style="font-size:12px;">${esc(opLabels[row.operation] || row.operation)} en cola (#${row.id})${row.attempts ? ` · intento ${row.attempts}/${row.max_attempts}` : ''}</td>
        <td><span class="nav-badge" style="background:${row.status === 'failed' ? 'rgba(239,68,68,0.12)' : 'rgba(255,184,0,0.12)'}; color:${row.status === 'failed' ? 'var(--danger)' : 'var(--warning)'}; font-size:10px;"${row.last_error ? ` title="${esc(row.last_error)}"` : ''}>${row.status === 'failed' ? 'Falló' : row.status === 'processing' ? 'Procesando' : 'En cola'}</span></td>
      </tr>`).join('');

      const relaRows = (relaRes?.data || []).map(ev => `<tr>
        <td style="font-size:12px;">${new Date(ev.received_at).toLocaleString('es-AR')}</td>
        <td><span class="nav-badge" style="background:rgba(59,130,246,0.12); color:#3B82F6; font-size:10px;">RELA / ZonaProp</span></td>
        <td style="font-size:12px;">${esc(ev.tipo_evento)}${ev.referencia ? ' · ' + esc(ev.referencia) : ''}</td>
        <td><span class="nav-badge" style="background:${ev.processed ? 'rgba(0,200,120,0.12)' : 'rgba(255,184,0,0.12)'}; color:${ev.processed ? 'var(--success)' : 'var(--warning)'}; font-size:10px;"${ev.process_error ? ` title="${esc(ev.process_error)}"` : ''}>${ev.processed ? 'OK' : 'Pendiente'}</span></td>
      </tr>`);

      if (!data.length && !queue.length && !relaRows.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:30px; color:var(--text-dim);">Sin sincronizaciones recientes</td></tr>';
        return;
      }
      tbody.innerHTML = queueHtml + relaRows.join('') + data.map(row => {
        const ok = row.status === 'success';
        return `<tr>
          <td style="font-size:12px;">${new Date(row.created_at).toLocaleString('es-AR')}</td>
          <td><span class="nav-badge" style="background:rgba(255,230,0,0.12); color:#FFE600; font-size:10px;">Mercado Libre</span></td>
          <td style="font-size:12px;">${esc(opLabels[row.operation] || row.operation)}${row.queue_id ? ' #' + row.queue_id : ''}</td>
          <td><span class="nav-badge" style="background:${ok ? 'rgba(0,200,120,0.12)' : 'rgba(239,68,68,0.12)'}; color:${ok ? 'var(--success)' : 'var(--danger)'}; font-size:10px;"${row.error ? ` title="${esc(row.error)}"` : ''}>${ok ? 'OK' : 'Falló'}</span></td>
        </tr>`;
      }).join('');
    } catch (err) {
      logWarn('sync history: ' + err.message);
    }
  }

  window.adminApp.togglePortal = async function (portalName, isActive) {
    const btn = document.querySelector(`[data-portal-toggle="${portalName}"]`);
    if (!btn || btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    try {
      const { error } = await window.supabaseClient
        .from('portal_settings')
        .upsert({ portal_name: portalName, is_active: isActive }, { onConflict: 'portal_name' });
      if (error) throw error;
      btn.classList.toggle('is-on', isActive);
      btn.setAttribute('aria-checked', String(isActive));
      showToast(`${portalName} ${isActive ? 'activado' : 'desactivado'}`, 'success');
    } catch (err) {
      showToast('Error al actualizar portal: ' + err.message, 'error');
    } finally {
      delete btn.dataset.busy;
    }
  };

  const portalsContainerEl = $('#portalsContainer');
  if (portalsContainerEl && !portalsContainerEl.dataset.toggleBound) {
    portalsContainerEl.dataset.toggleBound = '1';
    portalsContainerEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-portal-toggle]');
      if (!btn || btn.disabled) return;
      window.adminApp.togglePortal(btn.dataset.portalToggle, !btn.classList.contains('is-on'));
    });
  }

  /* Portal config field definitions per portal type */
  const PORTAL_CONFIG_FIELDS = {
    'ZonaProp': [
      { name: 'client_id', label: 'Client ID', type: 'text', required: true },
      { name: 'client_secret', label: 'Client Secret', type: 'password', required: true },
      { name: 'username', label: 'Username (opcional)', type: 'text', required: false },
      { name: 'password', label: 'Password (opcional)', type: 'password', required: false }
    ],
    'Argenprop': [
      { name: 'username', label: 'Username / Email', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true },
      { name: 'api_key', label: 'API Key (opcional)', type: 'text', required: false }
    ],
    'Argentpropiedades': [
      { name: 'client_id', label: 'Client ID', type: 'text', required: true },
      { name: 'client_secret', label: 'Client Secret', type: 'password', required: true }
    ],
    'Properati': [
      { name: 'api_key', label: 'API Key', type: 'text', required: true },
      { name: 'client_id', label: 'Client ID (opcional)', type: 'text', required: false }
    ],
    'MiArgPropiedad': [
      { name: 'username', label: 'Username / Email', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true },
      { name: 'api_key', label: 'API Key (opcional)', type: 'text', required: false }
    ],
    'Mercado Libre': [
      { name: 'app_id', label: 'APP ID', type: 'text', required: true },
      { name: 'secret_key', label: 'Secret Key', type: 'password', required: true }
    ]
  };

  function renderPortalConfigFields(portalName) {
    const fields = PORTAL_CONFIG_FIELDS[portalName] || [
      { name: 'api_key', label: 'API Key', type: 'text', required: true },
      { name: 'api_secret', label: 'Secret', type: 'password', required: true }
    ];
    const container = $('#portalConfigFields');
    if (!container) return;
    container.innerHTML = fields.map(f => `
      <div class="form-field">
        <label>${f.label} ${f.required ? '<span style="color:var(--danger);">*</span>' : ''}</label>
        <input type="${f.type}" id="portalField_${f.name}" name="${f.name}" ${f.required ? 'required' : ''} />
      </div>
    `).join('');
  }

  window.adminApp.openPortalConfig = async function (index) {
    const portal = PORTALS[index];
    if (!portal) return;
    const title = $('#modalPortalTitle');
    if (title) title.textContent = `Configurar ${portal.name}`;
    const idx = $('#portalIndex');
    if (idx) idx.value = index;

    renderPortalConfigFields(portal.name);

    try {
      const { data } = await window.supabaseClient
        .from('portal_settings')
        .select('*')
        .eq('portal_name', portal.name)
        .single();

      if (data) {
        const fields = PORTAL_CONFIG_FIELDS[portal.name] || [];
        fields.forEach(f => {
          const input = $(`#portalField_${f.name}`);
          if (!input) return;
          if (f.type === 'password') {
            const stored = data[f.name];
            input.value = '';
            input.placeholder = stored ? '•••••••• (guardado — escribí para reemplazar)' : 'Sin configurar';
          } else {
            input.value = data[f.name] || '';
          }
        });
      }
    } catch (_) {
    }

    openModal('portalModal');
  };

  on($('#portalApiForm'), 'submit', async (e) => {
    e.preventDefault();
    if (_submittingPortal) return;
    _submittingPortal = true;
    const index = parseInt($('#portalIndex')?.value, 10);
    const portal = PORTALS[index];
    if (!portal) { _submittingPortal = false; return; }
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }
try {
      const fields = PORTAL_CONFIG_FIELDS[portal.name] || [];
      const upsertData = { portal_name: portal.name };
      fields.forEach(f => {
        const input = $(`#portalField_${f.name}`);
        if (!input) return;
        const val = input.value?.trim() || '';
        // Campos sensibles vacíos = no tocar el valor guardado (evita pisar con "")
        if (f.type === 'password' && val === '') return;
        upsertData[f.name] = val;
      });

      await mutate('portal_settings', async () => {
        const { error } = await window.supabaseClient
          .from('portal_settings')
          .upsert(upsertData, { onConflict: 'portal_name' });
        if (error) throw error;
      });
      showToast(`${portal.name} configurado correctamente`, 'success');
      closeModal('portalModal');
    } catch (err) {
      showToast('Error al guardar: ' + err.message, 'error');
    } finally {
      _submittingPortal = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Credenciales'; }
    }
  });

  on($('#syncAllBtn'), 'click', async function () {
    this.disabled = true;
    this.innerHTML = '<i class="fas fa-rotate fa-spin"></i> Sincronizando...';
    const resultados = [];
    try {
      await mlCheckStatus(true);
      resultados.push(ml_connected ? 'ML conectado' : 'ML no configurado');

      const { data: relaCfg } = await window.supabaseClient
        .from('rela_config').select('codigo_inmobiliaria').eq('id', true).maybeSingle();
      if (relaCfg?.codigo_inmobiliaria) {
        try {
          const res = await relaApiCall('reconcile');
          resultados.push(`RELA: ${(res.reconciled || []).length} avisos reconciliados`);
        } catch (err) {
          resultados.push('RELA reconcile falló: ' + err.message);
        }
      } else {
        resultados.push('RELA sin configurar');
      }

      await loadPortals();
      showToast(resultados.join(' · '), 'success');
    } catch (err) {
      showToast('Error al sincronizar: ' + err.message, 'error');
    } finally {
      this.disabled = false;
      this.innerHTML = '<i class="fas fa-arrows-rotate"></i> Sincronizar Todo';
    }
  });

  /* ------------------------------------------------
     13B. MERCADO LIBRE INTEGRATION
     ------------------------------------------------ */
  const ML_FUNCTIONS_BASE = (() => {
    const url = window.BH_CONFIG?.SUPABASE_URL;
    if (!url) throw new Error('BH_CONFIG.SUPABASE_URL no configurado');
    return url + '/functions/v1';
  })();

  const ML_API_TIMEOUT_MS = 15000;
  // Mapeo action -> endpoint. Todas las acciones van a funciones dedicadas ya.
  // (Antes 'update'/'remove'/'sync-import' caían al multiplexor legacy ml-api, que leía
  // tokens en texto plano de portal_settings — camino roto desde la migración a ml_connection.)
  const ML_FUNCTION_PATHS = {
    'publish': 'ml-publish',
    'portal-status': 'ml-portal-status',
    'disconnect': 'ml-disconnect',

    'update': 'ml-publish',

    'remove': 'ml-publish',

    'sync-import': 'ml-sync-import',

  };
  async function mlApiCall(action, body = {}) {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) throw new Error('No hay sesión activa');
    if (!window.BH_CONFIG?.SUPABASE_URL) throw new Error('Configuración de Supabase no disponible (BH_CONFIG)');

    const fnPath = ML_FUNCTION_PATHS[action];

    if (!fnPath) throw new Error(`Acción ML no soportada: ${action}`);

    /* ml-publish exige body.action ('create' | 'update' | 'remove') */
    const outBody = fnPath === 'ml-publish'
      ? { ...body, action: action === 'publish' ? 'create' : action }
      : body;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ML_API_TIMEOUT_MS);
    try {
      const res = await fetch(`${ML_FUNCTIONS_BASE}/${fnPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(outBody),
        signal: controller.signal,
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Error ML API (${res.status})`);
      return json;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Tiempo de espera agotado al contactar Mercado Libre');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function updatePortalsBadge() {
    const el = document.getElementById('sideBadgePortales');
    if (!el) return;
    el.textContent = ml_connected ? ' On' : ml_configured ? ' Parcial' : ' Off';
    el.style.color = ml_connected ? 'var(--success)' : ml_configured ? '#FFE600' : 'var(--text-dim)';
  }

  let _mlStatusFetchedAt = 0;
  const ML_STATUS_TTL_MS = 60_000;
  async function mlCheckStatus(force = false) {
    if (!force && _mlStatusFetchedAt && (Date.now() - _mlStatusFetchedAt) < ML_STATUS_TTL_MS) return;
    try {
      const result = await mlApiCall('portal-status');
      _mlStatusFetchedAt = Date.now();
      ml_connected = !!result.connected;
      ml_configured = !!result.configured;
      ml_user = result.user || null;
      ml_listings = Array.isArray(result.listings) ? result.listings : [];
      updatePortalsBadge();
      updatePropBulkBar();
    } catch (err) {
      _mlStatusFetchedAt = 0;
      console.warn('[ML] Status check failed:', err.message);
      ml_connected = false;
      ml_configured = false;
      ml_user = null;
      ml_listings = [];
      updatePortalsBadge();
    }
  }

  /* Connect to Mercado Libre — opens OAuth popup via ml-oauth/start Edge Function */
  window.adminApp.mlConnect = async function () {
    try {
      showToast('Abriendo conexión con Mercado Libre...', 'info');
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (!session) throw new Error('No hay sesión activa');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ML_API_TIMEOUT_MS);
      const res = await fetch(`${ML_FUNCTIONS_BASE}/ml-oauth/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ action: 'start' }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const result = await res.json();
      if (!res.ok) {
        const msg = result.error || 'Error al generar URL de autenticación';
        if (/no configurad/i.test(msg)) {
          throw new Error('Credenciales de Mercado Libre no configuradas. Un super_admin debe guardarlas en Portales > Mercado Libre.');
        }
        throw new Error(msg);
      }
      const authUrl = result.authorizationUrl || result.authUrl;
      if (!authUrl) throw new Error('ml-oauth/start no devolvió authorizationUrl');

      /* Open popup for OAuth flow */
      const width = 800, height = 600;
      const left = (screen.width - width) / 2;
      const top = (screen.height - height) / 2;
      const popup = window.open(authUrl, 'ml_oauth',
        `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`);
      if (!popup) throw new Error('El navegador bloqueó la ventana emergente. Permití popups para este sitio y reintentá.');

      /* Listen for postMessage from ml-oauth Edge Function */
      const ML_MSG_ORIGIN = new URL(window.BH_CONFIG.SUPABASE_URL).origin;
      const handler = async (event) => {
        if (event.origin !== ML_MSG_ORIGIN) return;
        if (event.data?.type === 'ML_AUTH_SUCCESS') {
          _mlStatusFetchedAt = 0;
          window.removeEventListener('message', handler);
          if (popup && !popup.closed) popup.close();
          showToast('¡Cuenta de Mercado Libre conectada exitosamente!', 'success');
          ml_connected = true;
          ml_user = event.data.user || null;
          await mlCheckStatus();
          loadPortals();
        } else if (event.data?.type === 'ML_AUTH_ERROR') {
          window.removeEventListener('message', handler);
          if (popup && !popup.closed) popup.close();
          showToast('Error al conectar con Mercado Libre: ' + (event.data.error || 'Error desconocido'), 'error');
        }
      };
      window.addEventListener('message', handler);

      /* Timeout — close listener after 2 minutes */
      setTimeout(() => { window.removeEventListener('message', handler); }, 120000);
    } catch (err) {
      if (err.name === 'AbortError') {
        showToast('Tiempo de espera agotado al iniciar conexión ML', 'error');
      } else {
        showToast('Error al iniciar conexión ML: ' + err.message, 'error');
      }
    }
  };

  /* Disconnect from Mercado Libre */
  window.adminApp.mlDisconnect = async function () {
    if (!ml_connected) { showToast('No hay una cuenta de Mercado Libre conectada', 'warning'); return; }
    if (!(await showConfirmDialog({
      title: 'Desconectar Mercado Libre',
      message: 'Se desconectará la cuenta de Mercado Libre y se perderán las credenciales de acceso. ¿Continuar?',
      icon: 'fas fa-plug-circle-xmark',
      confirmText: 'Desconectar',
      danger: true,
    }))) return;
    try {
      await mlApiCall('disconnect');
      ml_connected = false;
      ml_user = null;
      ml_listings = [];
      ml_configured = false;
      showToast('Cuenta de Mercado Libre desconectada', 'success');
      await mlCheckStatus();
      loadPortals();
    } catch (err) {
      showToast('Error al desconectar: ' + err.message, 'error');
    }
  };

  /* Publish a property to Mercado Libre */
  window.adminApp.mlPublishProperty = async function (propertyId) {
    if (!ml_connected) { showToast('Conectá tu cuenta de Mercado Libre primero', 'warning'); return; }
    if (!(await showConfirmDialog({
      title: 'Publicar en Mercado Libre',
      message: 'Se publicará esta propiedad en Mercado Libre con los datos actuales. ¿Continuar?',
      icon: 'fab fa-envira',
      confirmText: 'Publicar',
    }))) return;

    try {
      /* Validación previa */
      const { data: prop, error: propErr } = await window.supabaseClient
        .from('properties')
        .select('title, description, image_urls, zone, price_usd, agent_id, status, is_published')
        .eq('id', propertyId)
        .single();
      if (propErr) throw propErr;

      const errors = [];
      if (!prop.image_urls || prop.image_urls.length < 3) errors.push('Mínimo 3 imágenes requeridas');
      if (!prop.description || prop.description.length < 100) errors.push('Descripción debe tener al menos 100 caracteres');
      if (!prop.zone) errors.push('Zona/barrio requerido');
      if (!prop.price_usd || prop.price_usd <= 0) errors.push('Precio válido requerido');
      if (!prop.agent_id) errors.push('Broker asignado requerido');
      if (!prop.is_published) errors.push('La propiedad debe estar publicada');

      if (errors.length) {
        showToast('Validación fallida: ' + errors.join('; '), 'error');
        return;
      }

      showToast('Publicando en Mercado Libre...', 'info');
      const result = await mlApiCall('publish', { property_id: propertyId });
      const listingId = result.listing_id || result.item_id || result.id || '';
      showToast('¡Propiedad publicada en Mercado Libre! ID: ' + listingId, 'success');
      await mlCheckStatus();
      loadProperties();
    } catch (err) {
      showToast('Error al publicar en ML: ' + err.message, 'error');
    }
  };

  /* Update a property listing on Mercado Libre */
  window.adminApp.mlUpdateProperty = async function (propertyId, listingId) {
    if (!ml_connected) { showToast('Conectá tu cuenta de Mercado Libre primero', 'warning'); return; }
    if (!(await showConfirmDialog({
      title: 'Actualizar en Mercado Libre',
      message: 'Se actualizará la publicación de esta propiedad en Mercado Libre. ¿Continuar?',
      icon: 'fas fa-rotate',
      confirmText: 'Actualizar',
    }))) return;
    try {
      showToast('Actualizando en Mercado Libre...', 'info');
      await mlApiCall('update', { property_id: propertyId, listing_id: listingId });
      showToast('¡Propiedad actualizada en Mercado Libre!', 'success');
      await mlCheckStatus();
      loadProperties();
    } catch (err) {
      showToast('Error al actualizar en ML: ' + err.message, 'error');
    }
  };

  /* Remove a property listing from Mercado Libre */
  window.adminApp.mlRemoveProperty = async function (listingId, propertyId) {
    if (!ml_connected) { showToast('Conectá tu cuenta de Mercado Libre primero', 'warning'); return; }
    if (!(await showConfirmDialog({
      title: 'Eliminar de Mercado Libre',
      message: 'La publicación de esta propiedad se eliminará de Mercado Libre. ¿Continuar?',
      icon: 'fas fa-trash-can',
      confirmText: 'Eliminar',
      danger: true,
    }))) return;
    try {
      showToast('Eliminando de Mercado Libre...', 'info');
      await mlApiCall('remove', { listing_id: listingId, property_id: propertyId });
      showToast('Propiedad eliminada de Mercado Libre', 'success');
      await mlCheckStatus();
      loadProperties();
    } catch (err) {
      showToast('Error al eliminar de ML: ' + err.message, 'error');
    }
  };

  /* Import properties from Mercado Libre */
  window.adminApp.mlImportFromML = async function () {
    if (!ml_connected) { showToast('Conectá tu cuenta de Mercado Libre primero', 'warning'); return; }
    if (!(await showConfirmDialog({
      title: 'Importar desde Mercado Libre',
      message: 'Se importarán las propiedades de Mercado Libre y se crearán como borradores en el sistema. ¿Continuar?',
      icon: 'fas fa-cloud-arrow-down',
      confirmText: 'Importar',
    }))) return;

    try {
      showToast('Importando propiedades desde Mercado Libre...', 'info');
      const result = await mlApiCall('sync-import');
      const count = result.imported || 0;
      showToast(`Se importaron ${count} propiedades desde Mercado Libre`, 'success');
      loadProperties();
    } catch (err) {
      showToast('Error al importar de ML: ' + err.message, 'error');
    }
  };

  /* ------------------------------------------------
     13C. OPEN RELA ARGENTINA (ZonaProp / QuintoAndar)
     ------------------------------------------------ */
  async function relaApiCall(action, body = {}) {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) throw new Error('No hay sesión activa');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ML_API_TIMEOUT_MS);
    try {
      const res = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/rela-proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ action, ...body }),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
      return json;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Tiempo de espera agotado al contactar RELA');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  window.adminApp.relaPropertyAction = async function (propertyId, action) {
    const labels = { publish: 'publicar en', update: 'sincronizar con', unpublish: 'despublicar de' };
    if (!confirm(`¿Confirmás ${labels[action] || action} RELA esta propiedad?`)) return;
    try {
      showToast(`RELA: ${action}…`, 'info');
      const result = await relaApiCall(action, { property_id: propertyId });
      if (result.blocked) {
        showToast('RELA bloqueó la publicación: ' + (result.errors || []).join(' | '), 'error');
      } else if (result.dry_run) {
        showToast(`DRY-RUN: el payload es válido (codigo ${result.codigo_aviso}). Desactivá DRY_RUN en Portales → RELA para publicar en serio.`, 'success');
        console.log('[RELA DRY-RUN payload]', result.payload);
      } else if (result.skipped) {
        showToast('RELA: ' + (result.reason || 'sin cambios'), 'info');
      } else {
        showToast(`RELA OK: ${result.remote_status || 'procesado'}${result.warnings?.length ? ' (warnings: ' + result.warnings.length + ')' : ''}`, 'success');
      }
      loadProperties();
    } catch (err) {
      showToast('Error RELA: ' + err.message, 'error');
    }
  };

  /* Panel RELA dentro del tab Portales */
  async function loadRelaPanel() {
    const el = $('#relaPortalPanel');
    if (!el || !window.supabaseClient) return;
    const canManage = ['super_admin', 'broker'].includes(currentProfile?.role);
    let status = null;
    let events = [];
    try {
      const { data } = await window.supabaseClient.rpc('rela_portal_status');
      status = data;
    } catch (err) { logError('rela_portal_status', err); }
    try {
      const res = await relaApiCall('events_list');
      events = res.events || [];
    } catch (_) { /* requiere sesión/edge fn; se ignora */ }

    const L = status?.listings || {};
    const dot = (ok) => `<span style="width:8px;height:8px;border-radius:50%;background:${ok ? '#4ade80' : '#f87171'};display:inline-block;box-shadow:0 0 6px ${ok ? '#4ade80' : '#f87171'};"></span>`;
    const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('es-AR') : '—';

    el.innerHTML = `
      <div class="glass-panel" style="padding:24px; margin-top:20px; text-align:left;">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="width:44px;height:44px;border-radius:12px;background:rgba(59,130,246,0.15);display:flex;align-items:center;justify-content:center;">
              <i class="fas fa-cloud" style="color:#3B82F6; font-size:18px;"></i>
            </div>
            <div>
              <h3 style="color:#fff; font-size:16px; font-weight:700; margin:0;">Open RELA (ZonaProp)</h3>
              <div style="font-size:12px; color:var(--text-dim);">${esc(status?.environment || 'sandbox')} · inmobiliaria: ${esc(status?.codigo_inmobiliaria || 'sin configurar')}</div>
            </div>
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;${canManage ? '' : ' opacity:.5; pointer-events:none;'}" title="${canManage ? '' : 'Solo super_admin o broker'}">
            ${status?.dry_run ? '<span class="nav-badge" style="background:rgba(255,184,0,0.15); color:var(--warning); font-size:11px; flex-shrink:0; white-space:nowrap;"><i class="fas fa-flask"></i> DRY-RUN activo</span>' : ''}
            <button class="btn-action" style="padding:6px 12px; font-size:11px; white-space:nowrap; flex-shrink:0;" onclick="window.adminApp.relaSyncCatalogs()"><i class="fas fa-rotate"></i> Catálogos</button>
            <button class="btn-action" style="padding:6px 12px; font-size:11px; white-space:nowrap; flex-shrink:0;" onclick="window.adminApp.relaReconcile()"><i class="fas fa-arrows-rotate"></i> Reconciliar</button>
            <button class="btn-action" style="padding:6px 12px; font-size:11px; white-space:nowrap; flex-shrink:0;" onclick="window.adminApp.openRelaConfig()"><i class="fas fa-cog"></i> Configurar</button>
          </div>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-top:16px;">
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Estado</div>
            <div style="font-size:13px; color:#fff; display:flex; align-items:center; gap:6px; margin-top:4px;">${dot(!!status?.codigo_inmobiliaria)} ${status?.codigo_inmobiliaria ? 'Configurado' : 'Pendiente credenciales'}</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Última sync</div>
            <div style="font-size:13px; color:#fff; margin-top:4px;">${fmtDate(status?.last_sync_at)}</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Avisos publicados</div>
            <div style="font-size:13px; color:#fff; margin-top:4px;">${L.published ?? 0}</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Errores / Bloqueados</div>
            <div style="font-size:13px; color:${(L.errors || L.blocked) ? 'var(--danger)' : '#fff'}; margin-top:4px;">${(L.errors ?? 0)} / ${(L.blocked ?? 0)}</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Callbacks</div>
            <div style="font-size:13px; color:#fff; margin-top:4px;">${dot(!!status?.callbacks_enabled)} ${status?.callbacks_enabled ? 'Activos' : 'Sin configurar'}</div>
          </div>
        </div>
        ${status?.last_error ? `<div style="margin-top:12px; font-size:12px; color:var(--danger);">Último error: ${esc(status.last_error)}</div>` : ''}
        ${events.length ? `
          <details style="margin-top:14px;">
            <summary style="cursor:pointer; font-size:12px; color:var(--text-dim);">Últimos eventos de callback (${events.length})</summary>
            <div style="margin-top:8px; font-size:11px; color:var(--text-muted); max-height:200px; overflow:auto;">
              ${events.map(ev => `<div style="padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
                ${esc(ev.tipo_evento)} · ${esc(ev.referencia || '—')} · ${fmtDate(ev.received_at)} · ${ev.processed ? '✓ procesado' : '⏳/⚠ pendiente'}${ev.lead_id ? ' · lead creado' : ''}
              </div>`).join('')}
            </div>
          </details>` : ''}
      </div>`;
  };

  window.adminApp.relaSyncCatalogs = async function () {
    if (!['super_admin', 'broker'].includes(currentProfile?.role)) { showToast('Solo super_admin o broker pueden sincronizar RELA', 'error'); return; }
    try {
      showToast('Sincronizando catálogos RELA (ubicaciones, tipos, planes)…', 'info');
      const res = await relaApiCall('catalogs_sync');
      const okCount = (res.synced || []).length;
      const failCount = Object.keys(res.failed || {}).length;
      showToast(`Catálogos: ${okCount} sincronizados${failCount ? ', ' + failCount + ' con error' : ''}`, failCount ? 'warning' : 'success');
      loadRelaPanel();
    } catch (err) { showToast('Error catálogos RELA: ' + err.message, 'error'); }
  };

  window.adminApp.relaReconcile = async function () {
    if (!['super_admin', 'broker'].includes(currentProfile?.role)) { showToast('Solo super_admin o broker pueden reconciliar RELA', 'error'); return; }
    if (!confirm('¿Reconciliar estados contra RELA? Consulta el estado real de cada aviso online.')) return;
    try {
      showToast('Reconciliando con RELA…', 'info');
      const res = await relaApiCall('reconcile');
      showToast(`Reconciliación: ${(res.reconciled || []).length} avisos consultados`, 'success');
      loadProperties();
      loadRelaPanel();
    } catch (err) { showToast('Error reconciliación: ' + err.message, 'error'); }
  };

  window.adminApp.openRelaConfig = async function () {
    try {
      const res = await relaApiCall('config_get');
      const c = res.config || {};
      const setId = (id, v) => { const el = $(id); if (el) el.value = v ?? ''; };
      setId('#relaCodigoInmobiliaria', c.codigo_inmobiliaria);
      setId('#relaIntegrador', c.integrador);
      setId('#relaPlan', c.plan_default);
      setId('#relaContactoNombre', c.contacto_nombre);
      setId('#relaContactoEmail', c.contacto_email);
      setId('#relaContactoTelefono', c.contacto_telefono);
      setId('#relaBaseUrl', c.base_url);
      setId('#relaEnv', c.environment);
      setId('#relaCatalogMapping', JSON.stringify(c.catalog_mapping || {}, null, 2));
      setId('#relaTipoPropMap', JSON.stringify(c.tipo_propiedad_map || {}, null, 2));
      setId('#relaUbicacionMap', JSON.stringify(c.ubicacion_map || {}, null, 2));
      const dry = $('#relaDryRun'); if (dry) dry.checked = !!c.dry_run;
      openModal('relaConfigModal');
    } catch (err) { showToast('Error al cargar config RELA: ' + err.message, 'error'); }
  };

  on($('#relaConfigForm'), 'submit', async (e) => {
    e.preventDefault();
    const parseJsonField = (id, label) => {
      const raw = $(id)?.value?.trim() || '{}';
      try { return JSON.parse(raw); }
      catch { throw new Error(`JSON inválido en ${label}`); }
    };
    try {
      const patch = {
        codigo_inmobiliaria: $('#relaCodigoInmobiliaria')?.value?.trim() || null,
        integrador: $('#relaIntegrador')?.value?.trim() || null,
        plan_default: $('#relaPlan')?.value?.trim() || 'SIMPLE',
        contacto_nombre: $('#relaContactoNombre')?.value?.trim() || null,
        contacto_email: $('#relaContactoEmail')?.value?.trim() || null,
        contacto_telefono: $('#relaContactoTelefono')?.value?.trim() || null,
        base_url: $('#relaBaseUrl')?.value?.trim() || 'https://api-zp-sandbox-open.navent.com',
        environment: $('#relaEnv')?.value === 'production' ? 'production' : 'sandbox',
        catalog_mapping: parseJsonField('#relaCatalogMapping', 'Mapeo de características'),
        tipo_propiedad_map: parseJsonField('#relaTipoPropMap', 'Mapeo de tipos de propiedad'),
        ubicacion_map: parseJsonField('#relaUbicacionMap', 'Mapeo de ubicaciones'),
        dry_run: !!$('#relaDryRun')?.checked,
      };
      const { error } = await window.supabaseClient.from('rela_config').update(patch).eq('id', true);
      if (error) throw error;
      showToast('Configuración RELA guardada', 'success');
      closeModal('relaConfigModal');
      loadRelaPanel();
    } catch (err) {
      showToast('Error al guardar RELA: ' + err.message, 'error');
    }
  });


  /* --- ML Config: get/save credentials from portal_settings --- */
  async function mlConfigGet() {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session || !session.access_token) throw new Error('No hay sesión activa o token inválido');
    const res = await fetch(`${ML_FUNCTIONS_BASE}/ml-config`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Error fetching ML config');
    return json;
  }

  async function mlConfigSave(appId, secretKey) {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session || !session.access_token) throw new Error('No hay sesión activa o token inválido');
    const res = await fetch(`${ML_FUNCTIONS_BASE}/ml-config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ ml_app_id: appId, ml_secret_key: secretKey }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Error saving ML config');
    return json;
  }

  window.adminApp.mlSaveCredentials = async function () {
    const appIdInput = $('#mlAppIdInput');
    const secretInput = $('#mlSecretInput');
    const appId = (appIdInput?.value || '').trim();
    const secret = (secretInput?.value || '').trim();

    if (!appId || !secret) {
      showToast('Completá ambos campos: APP_ID y SECRET_KEY', 'warning');
      return;
    }

    try {
      showToast('Guardando credenciales de Mercado Libre...', 'info');
      await mlConfigSave(appId, secret);
      ml_configured = true;
      updatePortalsBadge();
      showToast('Credenciales guardadas. Ahora podés conectar tu cuenta.', 'success');
      loadPortals();
    } catch (err) {
      showToast('Error al guardar credenciales: ' + err.message, 'error');
    }
  };

  window.adminApp.mlToggleConfig = function () {
    const panel = $('#mlConfigPanel');
    if (panel) {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    }
  };

  /* ------------------------------------------------
     13C. TASACIONES
     ------------------------------------------------ */
  function showTasacionEditor(id, title) {
    const listView = $('#tasacionesListView');
    const editorView = $('#tasacionesEditorView');
    const iframe = $('#tasacionesIframe');
    const titleEl = $('#tasacionesEditorTitle');
    if (listView) listView.style.display = 'none';
    if (editorView) editorView.style.display = 'block';
    if (titleEl) titleEl.textContent = title || '';
    if (iframe) {
      iframe.src = `tasacion.html?id=${id}`;
      iframe.onload = async () => {
        try {
          const { data: { session } } = await window.supabaseClient.auth.getSession();
          if (session && iframe.contentWindow) {
            /* Security: el iframe carga tasacion.html desde ESTE mismo origen; usar window.location.origin.
               El SUPABASE_URL previo hacia fallar la entrega del token por origin mismatch. */
            iframe.contentWindow.postMessage({ type: 'auth-session', token: session.access_token }, window.location.origin);
          }
        } catch (_) {}
      };
    }
  }

  function hideTasacionEditor() {
    const listView = $('#tasacionesListView');
    const editorView = $('#tasacionesEditorView');
    const iframe = $('#tasacionesIframe');
    if (editorView) editorView.style.display = 'none';
    if (listView) listView.style.display = 'block';
    if (iframe) iframe.src = '';
    loadTasaciones();
  }

  on($('#btnBackToList'), 'click', hideTasacionEditor);

  on($('#tasacionesPagePrev'), 'click', () => { if (_tasacionesPage > 1) { _tasacionesPage--; loadTasaciones(); } });
  on($('#tasacionesPageNext'), 'click', () => { const totalPages = Math.ceil(_tasacionesTotalCount / _tasacionesPageSize); if (_tasacionesPage < totalPages) { _tasacionesPage++; loadTasaciones(); } });
  on($('#tasacionesPageSize'), 'change', () => { _tasacionesPageSize = parseInt($('#tasacionesPageSize').value, 10); _tasacionesPage = 1; loadTasaciones(); });

  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type === 'tasaciones-back') hideTasacionEditor();
    if (e.data?.type === 'tasaciones-finalized' && e.data?.id) {
      _handleTasacionFinalized(e.data.id);
      loadTasaciones();
    }
  });

  async function _handleTasacionFinalized(tasacionId) {
    try {
      const { data: t, error } = await window.supabaseClient
        .from('tasaciones')
        .select('id, property_id, owner_id, broker_id, type, valuation_usd, title')
        .eq('id', tasacionId)
        .single();
      if (error || !t) return;

      if (t.owner_id) {
        const { data: existingLead } = await window.supabaseClient
          .from('leads')
          .select('id')
          .eq('source', 'tasacion')
          .eq('contact_name', t.title || 'Propietario')
          .maybeSingle();
        if (existingLead) return;

        const ownerRes = t.owner_id ? await window.supabaseClient.from('owners').select('full_name, phone, email').eq('id', t.owner_id).single() : null;
        const owner = ownerRes?.data;
        if (!owner) return;

        await window.supabaseClient.from('leads').insert({
          property_id: t.property_id || null,
          broker_id: t.broker_id || null,
          source: 'tasacion',
          stage: 'contactado',
          tags: ['tasacion', t.type || 'venta'],
          score: 40,
          contact_name: owner.full_name || 'Propietario',
          contact_phone: owner.phone || null,
          contact_email: owner.email || null,
          notes: 'Lead generado desde tasación ' + (t.title || '') + (t.valuation_usd ? '. Valor estimado: USD ' + Number(t.valuation_usd).toLocaleString('es-AR') : ''),
        });
        showToast('Lead creado desde tasación para ' + (owner.full_name || 'propietario'), 'success');
      }
    } catch (_) { /* silent */ }
  }

  async function loadTasaciones() {
    invalidateSearchCache();
    const tbody = $('#tasacionesTableBody');
    const pageInfo = $('#tasacionesPageInfo');
    const pagePrev = $('#tasacionesPagePrev');
    const pageNext = $('#tasacionesPageNext');
    if (!tbody) return;
    if (!currentUser || !window.supabaseClient) return;

    try {
      /* Get total count for pagination */
      const { count: totalCount, error: countError } = await window.supabaseClient
        .from('tasaciones')
        .select('*', { count: 'exact', head: true });
      if (countError) throw countError;
      _tasacionesTotalCount = totalCount || 0;

      const from = (_tasacionesPage - 1) * _tasacionesPageSize;
      const to = from + _tasacionesPageSize - 1;

      const { data, error } = await window.supabaseClient
        .from('tasaciones')
        .select('id, title, status, created_at, property_id, owner_id, type, data, valuation_usd')
        .order('created_at', { ascending: false })
        .range(from, to);
      if (error) throw error;

      const propIds = [...new Set((data || []).map(t => t.property_id).filter(Boolean))];
      const ownerIds = [...new Set((data || []).map(t => t.owner_id).filter(Boolean))];
      const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
      const [propsRes, ownersRes, finRes, draftRes, recentRes] = await Promise.all([
        propIds.length ? window.supabaseClient.from('properties').select('id, property_code, title').in('id', propIds) : { data: [] },
        ownerIds.length ? window.supabaseClient.from('owners').select('id, full_name').in('id', ownerIds) : { data: [] },
        window.supabaseClient.from('tasaciones').select('*', { count: 'exact', head: true }).eq('status', 'finalized'),
        window.supabaseClient.from('tasaciones').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
        window.supabaseClient.from('tasaciones').select('*', { count: 'exact', head: true }).gte('created_at', since30)
      ]);
      const propMap = new Map((propsRes.data || []).map(p => [p.id, { ...p, code: p.property_code || p.code || null }]));
      const ownerMap = new Map((ownersRes.data || []).map(o => [o.id, o]));

      const setKpi = (sel, val) => { const el = $(sel); if (el) el.textContent = val; };
      setKpi('#tasKpiTotal', _tasacionesTotalCount);
      setKpi('#tasKpiFinalizadas', finRes.count || 0);
      setKpi('#tasKpiBorradores', draftRes.count || 0);
      setKpi('#tasKpiRecientes', recentRes.count || 0);

      /* Update pagination UI */
      const totalPages = Math.ceil(_tasacionesTotalCount / _tasacionesPageSize);
      if (pageInfo) pageInfo.textContent = `Página ${_tasacionesPage} de ${totalPages || 1}`;
      if (pagePrev) pagePrev.disabled = _tasacionesPage <= 1;
      if (pageNext) pageNext.disabled = _tasacionesPage >= totalPages;

      if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5"><div class="tas-empty"><i class="fas fa-file-invoice"></i><p>No hay tasaciones registradas todavía.</p><span>Creá la primera con “Nueva Tasación”.</span></div></td></tr>';
        return;
      }

      tbody.innerHTML = data.map(t => {
        const prop = t.property_id ? propMap.get(t.property_id) : null;
        const propName = prop ? [prop.code, prop.title].filter(Boolean).join(' · ') : null;
        const owner = t.owner_id ? ownerMap.get(t.owner_id) : null;
        const ownerName = owner ? (owner.full_name || null) : null;
        return buildTasacionRowHtml(t, { propName, ownerName });
      }).join('');

    } catch (err) {
      logError('loadTasaciones error:', err);
      tbody.innerHTML = '<tr><td colspan="5" class="tas-empty-cell">Error al cargar tasaciones</td></tr>';
    }
  }

  window.navigateToTasacion = function (id, title) {
    showTasacionEditor(id, title);
  };

  async function _deleteTasacion(id) {
    if (!confirm('¿Eliminar esta tasación permanentemente?')) return;
    try {
      await mutate('tasaciones', async () => {
        const { error } = await window.supabaseClient.from('tasaciones').delete().eq('id', id);
        if (error) throw error;
      });
      showToast('Tasación eliminada', 'success');
      loadTasaciones();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al eliminar: ' + err.message, 'error');
    }
  }
  window.deleteTasacion = _deleteTasacion;

  function _openTasacionPDF(id) {
    const url = 'tasacion.html?id=' + encodeURIComponent(id) + '&print=1&token=' + encodeURIComponent(window.__bhAdminToken || '');
    window.open(url, '_blank', 'noopener');
  }

  /* ------------------------------------------------
     Security: delegated handlers (sin onclick inline; datos externos viajan en data-* esc()'
     ------------------------------------------------ */
  on($('#propertiesTableBody'), 'click', (e) => {
    const upd = e.target.closest('[data-ml-update-prop]');
    if (upd) { window.adminApp.mlUpdateProperty(upd.dataset.mlUpdateProp, upd.dataset.mlListing || ''); return; }
    const rem = e.target.closest('[data-ml-remove]');
    if (rem) { window.adminApp.mlRemoveProperty(rem.dataset.mlListing || '', rem.dataset.mlProp || ''); return; }
    const pub = e.target.closest('[data-ml-publish]');
    if (pub) { window.adminApp.mlPublishProperty(pub.dataset.mlPublish); return; }
    const relaBtn = e.target.closest('[data-rela-action]');
    if (relaBtn) { window.adminApp.relaPropertyAction(relaBtn.dataset.relaProp, relaBtn.dataset.relaAction); return; }
    const waBtn = e.target.closest('[data-wa-share]');
    if (waBtn) { window.adminApp.sharePropertyWhatsApp(waBtn.dataset.waShare, waBtn.dataset.waCode || ''); }
  });

  /* Delegado "Agendar visita" desde CRM (kanban, detalle de lead, listado).
     Los datos viajan en data-* con esc(); capture corta el bubble ANTES del onclick
     inline del card (editLead) y abre el modal con el prefill. */
  on(document, 'click', (e) => {
    const btn = e.target.closest('[data-open-visit]');
    if (!btn) return;
    e.stopPropagation();
    window.adminApp.openVisitModal({
      lead_id: btn.dataset.leadId || null,
      client_name: btn.dataset.clientName || '',
      client_phone: btn.dataset.clientPhone || '',
      property_id: btn.dataset.propertyId || ''
    });
  }, true);

  window.adminApp.sharePropertyWhatsApp = async function (propertyId, propertyCode) {
    if (!propertyCode) { showToast('La propiedad no tiene código; no se puede generar la ficha', 'error'); return; }
    try {
      const { data: p, error } = await window.supabaseClient
        .from('properties')
        .select('title, price_usd, price_currency, property_type, zone, address, rooms, bedrooms, bathrooms, surface_covered, surface_total, status')
        .eq('id', propertyId)
        .single();
      if (error || !p) throw new Error('No se pudo leer la propiedad');

      const TYPE = { casa: 'CASA', departamento: 'DEPARTAMENTO', terreno: 'TERRENO', local: 'LOCAL', oficina: 'OFICINA', galpon: 'GALPÓN', quinta: 'QUINTA', otro: 'PROPIEDAD' };
      // Restricción: solo caracteres BMP; wa.me degrada a U+FFFD los emojis fuera del BMP.
      const lines = [];
      lines.push('\u25C6 *' + (TYPE[p.property_type] || 'PROPIEDAD') + ' EN ' + (p.status === 'alquiler' ? 'ALQUILER' : 'VENTA') + '*');
      lines.push('');
      lines.push('\u2605 *' + (p.title || propertyCode) + '*');
      if (p.zone || p.address) lines.push('\u00BB ' + [p.zone, p.address].filter(Boolean).join(' \u00B7 '));
      lines.push('');
      if (p.price_usd) lines.push('\u2713 *' + (p.price_currency === 'ARS' ? '$' : 'USD') + ' ' + Number(p.price_usd).toLocaleString('es-AR') + '*');
      const feats = [];
      if (p.rooms) feats.push('\u2022 ' + p.rooms + ' ambientes');
      if (p.bedrooms) feats.push('\u2022 ' + p.bedrooms + ' dorm.');
      if (p.bathrooms) feats.push('\u2022 ' + p.bathrooms + ' ba\u00F1o' + (p.bathrooms === 1 ? '' : 's'));
      if (p.surface_total || p.surface_covered) feats.push('\u2022 ' + (p.surface_total || p.surface_covered) + ' m\u00B2');
      if (feats.length) { lines.push(''); lines.push(feats.join('  \u00B7  ')); }
      lines.push('');
      lines.push('\u25BC *Ficha completa con fotos*');
      lines.push('https://bienenhaus.com.ar/fichas/' + encodeURIComponent(propertyCode) + '.html');
      lines.push('');
      lines.push('\u2605 *BIENENHAUS PROPIEDADES* \u00B7 C\u00F3d. ' + propertyCode);

      window.open('https://wa.me/?text=' + encodeURIComponent(lines.join('\n')), '_blank', 'noopener');
    } catch (err) {
      showToast('Error al preparar el mensaje: ' + err.message, 'error');
    }
  };

  on($('#imagePreviewGrid'), 'click', (e) => {
    const starBtn = e.target.closest('.preview-portada-btn');
    if (starBtn) {
      const starItem = starBtn.closest('.image-preview-item');
      if (starItem) setPreviewAsPortada(starItem);
      return;
    }
    const btn = e.target.closest('.preview-remove');
    if (btn) {
      const item = btn.closest('.image-preview-item');
      if (item) {
        if (item.dataset.objUrl) {
          URL.revokeObjectURL(item.dataset.objUrl);
          _newImageFiles = _newImageFiles.filter(x => x.url !== item.dataset.objUrl);
          const fileInput = $('#propImageFilesInput');
          if (fileInput) fileInput.value = '';
        }
        item.remove();
        refreshPreviewBadges();
      }
    }
  });

  on($('#tasacionesTableBody'), 'click', (e) => {
    const open = e.target.closest('[data-open-tasacion]');
    if (open) { window.navigateToTasacion(open.dataset.openTasacion, open.dataset.tasacionTitle || ''); return; }
    const del = e.target.closest('[data-del-tasacion]');
    if (del) _deleteTasacion(del.dataset.delTasacion);
    const pdf = e.target.closest('[data-pdf-tasacion]');
    if (pdf) { _openTasacionPDF(pdf.dataset.pdfTasacion); return; }
  });

  async function createNewTasacion() {
    const propSelect = $('#tasaProperty');
    const ownerSelect = $('#tasaOwner');
    if (!propSelect || !ownerSelect) return;
      try {
        const [propsRes, ownersRes] = await Promise.all([
          window.supabaseClient.from('properties').select('id, property_code, title').is('deleted_at', null).order('property_code'),
          window.supabaseClient.from('owners').select('id, full_name').is('deleted_at', null).order('full_name')
        ]);
        if (propsRes.error) throw propsRes.error;
        if (ownersRes.error) throw ownersRes.error;
        propSelect.innerHTML = '<option value="">Sin vincular</option>' +
          (propsRes.data || []).map(p => '<option value="' + esc(p.id) + '">' + esc(p.property_code || '') + ' - ' + esc(p.title || '') + '</option>').join('');
        ownerSelect.innerHTML = '<option value="">Sin vincular</option>' +
          (ownersRes.data || []).map(o => '<option value="' + esc(o.id) + '">' + esc(o.full_name || '') + '</option>').join('');
      } catch (err) {
        logError('createNewTasacion error:', err);
        showToast('No se pudieron cargar propiedades/propietarios: ' + (err && err.message ? err.message : err), 'error');
      }
    openModal('newTasacionModal');
  }

  on($('#btnNewTasacion'), 'click', createNewTasacion);

  on($('#newTasacionForm'), 'submit', async (e) => {
    e.preventDefault();
    const userId = currentUser?.id;
    if (!userId) { showToast('No hay sesión activa', 'error'); return; }
    const type = $('#tasaType')?.value || 'venta';
    const propertyId = $('#tasaProperty')?.value || null;
    const ownerId = $('#tasaOwner')?.value || null;
    const title = type.charAt(0).toUpperCase() + type.slice(1) + (propertyId ? ' — ' + ($('#tasaProperty')?.selectedOptions?.[0]?.textContent || '') : '');
    try {
      const payload = { title: title, status: 'draft', type: type, created_by: userId };
      if (propertyId) payload.property_id = propertyId;
      if (ownerId) payload.owner_id = ownerId;
      let newTasacionId = null;
      await mutate('tasaciones', async () => {
        const { data, error } = await window.supabaseClient
          .from('tasaciones')
          .insert(payload)
          .select('id')
          .single();
        if (error) throw error;
        newTasacionId = data.id;
      });
      closeModal('newTasacionModal');
      showTasacionEditor(newTasacionId, title);
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al crear tasación: ' + err.message, 'error');
    }
  });

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

  const FICHA_FOOTER_MESSAGES = [
    { before: '¿Querés ', highlight: 'vender', after: ' tu propiedad?' },
    { before: '¿Querés ', highlight: 'comprar', after: ' tu próxima casa?' },
    { before: '¿Buscás ', highlight: 'alquilar', after: ' rápido y sin vueltas?' },
    { before: '¿Necesitás ', highlight: 'tasar', after: ' tu propiedad?' }
  ];

  async function loadFichaHtml() {
    if (!window.supabaseClient) return;
    try {
      const [propsRes, agentsRes] = await Promise.all([
        window.supabaseClient.from('properties').select('id, title, property_code, zone, address, price_usd, rooms, area_m2, description, image_urls, agent_id').order('created_at', { ascending: false }),
        window.supabaseClient.from('agents').select('id, full_name, phone, email').eq('status', 'activo')
      ]);
      if (propsRes.error) throw propsRes.error;
      if (agentsRes.error) throw agentsRes.error;
      _fichaPropsCache = propsRes.data || [];
      _fichaAgentsCache = agentsRes.data || [];
    } catch (err) {
      logError('Ficha:', err);
      showToast('No se pudieron cargar los datos de la ficha', 'error');
    }
    startFichaFooterRotator();
  }

  /* ------------------------------------------------
     SUPERVISION CENTER
     ------------------------------------------------ */
  let _supRealtimeChannel = null;
  let _supCurrentView = 'overview';
  let _supAutoRefresh = true;
  let _supAutoRefreshTimer = null;

  async function loadSupervision() {
    if (window.adminSupervision) {
      window.adminSupervision.load();
      return;
    }
    if (!currentUser || !window.supabaseClient) return;
    if (currentProfile?.role !== 'super_admin') {
      showToast('Acceso denegado: solo Super Admin', 'error');
      navigateTo('tab-dashboard');
      return;
    }
  }

  // ============ SUPERVISIÓN: TABLERO DEL EQUIPO ============

  const SUP_ROLE_LABELS = { super_admin: 'Super Admin', broker: 'Broker', agente: 'Agente' };
  const SUP_ROLE_COLORS = { super_admin: '#EF4444', broker: '#FACC15', agente: '#1FC8C3' };
  const SUP_MODULE_ICONS = {
    properties: { icon: 'fas fa-home', color: '#1FC8C3', label: 'propiedad' },
    crm: { icon: 'fas fa-user-plus', color: '#3B82F6', label: 'lead' },
    portales: { icon: 'fas fa-store', color: '#FACC15', label: 'publicación ML' },
    tasaciones: { icon: 'fas fa-calculator', color: '#10B981', label: 'tasación' },
    agenda: { icon: 'fas fa-calendar', color: '#8B5CF6', label: 'visita' },
    owners: { icon: 'fas fa-key', color: '#E67E22', label: 'propietario' },
    cms: { icon: 'fas fa-globe', color: '#06B6D4', label: 'sitio web' },
    brokers: { icon: 'fas fa-user-tie', color: '#F472B6', label: 'agente' },
    users: { icon: 'fas fa-user-shield', color: '#EF4444', label: 'usuario' },
    chat: { icon: 'fas fa-comments', color: '#25D366', label: 'chat' },
    config: { icon: 'fas fa-cog', color: '#6B7280', label: 'configuración' },
  };

  const SUP_ACTION_TEXT = {
    insert: (label) => `Creó ${label}`, create: (label) => `Creó ${label}`,
    update: (label) => `Editó ${label}`, delete: (label) => `Eliminó ${label}`,
    update_sensitive: (label) => `Modificó ${label} (dato sensible)`,
    remove: (label) => `Eliminó ${label}`,
    ml_publish: (label) => `Publicó ${label} en Mercado Libre`,
    message_received: (label) => `Recibió mensaje de ${label}`,
    anomaly_detected: (label) => `Anomalía detectada en ${label}`,
  };

  async function showSupTeamBoard() {
    $('#supTeamBoard').style.display = 'block';
    $('#supEmployeeDetail').style.display = 'none';
    await loadTeamGrid();
  }

  async function loadTeamGrid() {
    const grid = $('#supTeamGrid');
    if (!grid) return;
    grid.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding:60px; grid-column:1/-1;"><i class="fas fa-spinner fa-spin" style="font-size:28px; margin-bottom:10px;"></i><div>Cargando equipo...</div></div>';

    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayISO = todayStart.toISOString();

      const [profilesRes, auditRes] = await Promise.all([
        window.supabaseClient.from('profiles').select('id, full_name, email, role, is_active').is('deleted_at', null).order('full_name'),
        window.supabaseClient.from('audit_log').select('user_id, action, module, created_at').gte('created_at', todayISO).order('created_at', { ascending: false }).limit(500),
      ]);

      if (profilesRes.error) throw profilesRes.error;
      if (auditRes.error) throw auditRes.error;

      const profiles = profilesRes.data || [];
      const todayActions = auditRes.data || [];

      // Última actividad por usuario (de las acciones de hoy + query aparte para históricas)
      const lastActivityByUser = {};
      todayActions.forEach(a => {
        if (!lastActivityByUser[a.user_id]) lastActivityByUser[a.user_id] = a.created_at;
      });

      // Para usuarios sin actividad hoy, buscar su última acción histórica
      const usersWithoutToday = profiles.filter(p => !lastActivityByUser[p.id]);
      if (usersWithoutToday.length) {
        const lastActions = await Promise.all(
          usersWithoutToday.map(p =>
            window.supabaseClient.from('audit_log').select('created_at').eq('user_id', p.id).order('created_at', { ascending: false }).limit(1)
          )
        );
        lastActions.forEach((res, i) => {
          if (res.data && res.data[0]) lastActivityByUser[usersWithoutToday[i].id] = res.data[0].created_at;
        });
      }

      // Conteos de hoy por usuario
      const statsByUser = {};
      todayActions.forEach(a => {
        if (!statsByUser[a.user_id]) statsByUser[a.user_id] = { props: 0, leads: 0, ml: 0, total: 0 };
        statsByUser[a.user_id].total++;
        if (a.module === 'properties') statsByUser[a.user_id].props++;
        if (a.module === 'crm') statsByUser[a.user_id].leads++;
        if (a.module === 'portales') statsByUser[a.user_id].ml++;
      });

      const now = Date.now();
      const ONLINE_WINDOW = 15 * 60 * 1000;

      grid.innerHTML = profiles.map(p => {
        const stats = statsByUser[p.id] || { props: 0, leads: 0, ml: 0, total: 0 };
        const lastActivity = lastActivityByUser[p.id];
        const isOnline = lastActivity && (now - new Date(lastActivity).getTime()) < ONLINE_WINDOW;
        const lastText = lastActivity
          ? isOnline ? 'En línea' : 'Últ. actividad: ' + new Date(lastActivity).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
          : 'Sin actividad registrada';
        const initials = (p.full_name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
        const roleColor = SUP_ROLE_COLORS[p.role] || '#6B7280';
        return `<div class="sup-team-card" data-user-id="${esc(p.id)}" data-user-name="${esc(p.full_name)}" data-user-role="${esc(p.role)}" role="button" tabindex="0">>
          <div class="stc-status ${isOnline ? 'online' : 'offline'}" title="${isOnline ? 'En línea' : 'Desconectado'}"></div>
          <div class="stc-header">
            <div class="stc-avatar" style="background:${roleColor}22; color:${roleColor}; border:1px solid ${roleColor}44;">${esc(initials)}</div>
            <div>
              <div class="stc-name">${esc(p.full_name)}</div>
              <div class="stc-role">${esc(SUP_ROLE_LABELS[p.role] || p.role)}</div>
            </div>
          </div>
          <div class="stc-last"><i class="fas ${isOnline ? 'fa-circle' : 'fa-clock'}" style="font-size:9px; margin-right:4px; color:${isOnline ? '#10B981' : 'var(--text-dim)'};"></i>${esc(lastText)}</div>
          <div class="stc-stats">
            <div class="stc-stat"><div class="stc-stat-num" style="color:#1FC8C3;">${stats.props}</div><div class="stc-stat-label">Props</div></div>
            <div class="stc-stat"><div class="stc-stat-num" style="color:#3B82F6;">${stats.leads}</div><div class="stc-stat-label">Leads</div></div>
            <div class="stc-stat"><div class="stc-stat-num" style="color:#FACC15;">${stats.ml}</div><div class="stc-stat-label">ML</div></div>
          </div>
        </div>`;
      }).join('');

      grid.querySelectorAll('.sup-team-card').forEach(card => {
        card.addEventListener('click', () => {
          const id = card.dataset.userId;
          const name = card.dataset.userName;
          const role = card.dataset.userRole;
          if (id) showSupEmployeeDetail(id, name, role);
        });
      });
    } catch (err) {
      logError('loadTeamGrid error:', err);
      grid.innerHTML = '<div style="color:var(--danger); text-align:center; padding:40px; grid-column:1/-1;">Error cargando el equipo</div>';
    }
  }

  // ============ SUPERVISIÓN: DETALLE DE EMPLEADO ============

  let _supEmployeeUserId = null;
  let _supEmployeePage = 0;
  const _supEmployeePageSize = 30;

  async function showSupEmployeeDetail(userId, userName, role) {
    _supEmployeeUserId = userId;
    _supEmployeePage = 0;
    $('#supTeamBoard').style.display = 'none';
    $('#supEmployeeDetail').style.display = 'block';

    const roleColor = SUP_ROLE_COLORS[role] || '#6B7280';
    const roleLabel = SUP_ROLE_LABELS[role] || role;
    const initials = (userName || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

    $('#supEmployeeHeader').innerHTML = `
      <div style="width:60px; height:60px; border-radius:50%; background:${roleColor}22; color:${roleColor}; display:flex; align-items:center; justify-content:center; font-size:24px; font-weight:700; border:2px solid ${roleColor}44; flex-shrink:0;">${esc(initials)}</div>
      <div style="flex:1;">
        <div style="font-family:var(--font-heading); font-size:22px; color:#fff; font-weight:700;">${esc(userName)}</div>
        <div style="font-size:12px; color:${roleColor}; text-transform:uppercase; letter-spacing:1px; margin-top:4px;">${esc(roleLabel)}</div>
      </div>
      <button type="button" class="status-pill pending" style="padding:8px 14px; font-size:12px;" data-action="refreshSupEmployee">
        <i class="fas fa-arrows-rotate"></i> Actualizar
      </button>`;

    await loadEmployeeActivity(userId);
  }

  async function loadEmployeeActivity(userId) {
    const container = $('#supEmployeeActivity');
    if (!container || !userId) return;

    const moduleFilter = $('#supActivityModuleFilter')?.value;
    const from = _supEmployeePage * _supEmployeePageSize;

    container.innerHTML = '<div class="sup-act-empty"><i class="fas fa-spinner fa-spin"></i>Cargando actividad...</div>';

    try {
      let query = window.supabaseClient
        .from('audit_log')
        .select('id, action, module, entity_label, entity_type, changed_fields, metadata, status, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (moduleFilter) query = query.eq('module', moduleFilter);
      query = query.range(from, from + _supEmployeePageSize - 1);

      const { data, error } = await query;
      if (error) throw error;
      const entries = data || [];

      if (!entries.length && _supEmployeePage === 0) {
        container.innerHTML = '<div class="sup-act-empty"><i class="fas fa-inbox"></i>Sin actividad registrada</div>';
        $('#supEmployeeLoadMore').style.display = 'none';
        return;
      }

      // Agrupar por fecha
      const groups = {};
      entries.forEach(e => {
        const d = new Date(e.created_at);
        const dateKey = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        if (!groups[dateKey]) groups[dateKey] = [];
        groups[dateKey].push(e);
      });

      let html = '';
      for (const [dateKey, items] of Object.entries(groups)) {
        html += `<div class="sup-act-date-sep">${esc(dateKey)}</div>`;
        items.forEach(e => { html += renderActivityRow(e); });
      }

      if (_supEmployeePage === 0) {
        container.innerHTML = html;
      } else {
        container.insertAdjacentHTML('beforeend', html);
      }

      const hasMore = entries.length === _supEmployeePageSize;
      $('#supEmployeeLoadMore').style.display = hasMore ? 'inline-flex' : 'none';
    } catch (err) {
      logError('loadEmployeeActivity error:', err);
      container.innerHTML = '<div class="sup-act-empty" style="color:var(--danger);"><i class="fas fa-exclamation-triangle"></i>Error cargando actividad</div>';
    }
  }

  function renderActivityRow(e) {
    const meta = SUP_MODULE_ICONS[e.module] || { icon: 'fas fa-circle', color: '#6B7280', label: e.module };
    const actionFn = SUP_ACTION_TEXT[e.action] || ((l) => `${e.action} ${l}`);
    const entityName = e.entity_label || meta.label;
    const time = new Date(e.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

    const statusChip = e.status && e.status !== 'success' && e.status !== 'ok'
      ? `<span class="sup-act-chip" style="background:rgba(239,68,68,0.15); color:var(--danger);">${esc(e.status)}</span>` : '';

    const changesChip = (e.changed_fields && e.changed_fields.length)
      ? `<span class="sup-act-chip" style="background:rgba(255,184,0,0.12); color:var(--warning);">${e.changed_fields.length} cambio${e.changed_fields.length > 1 ? 's' : ''}</span>` : '';

    const mlUrl = e.metadata && e.metadata.permalink
      ? ` <a href="${esc(e.metadata.permalink)}" target="_blank" rel="noopener" style="color:#FACC15; font-size:11px; text-decoration:underline;">Ver en ML</a>` : '';

    const actionText = actionFn(`<span class="act-entity" style="color:${meta.color};">${esc(entityName)}</span>`);

    return `<div class="sup-act-row">
      <div class="sup-act-time">${time}</div>
      <div class="sup-act-icon" style="background:${meta.color}18; color:${meta.color}; border:1px solid ${meta.color}33;">
        <i class="${meta.icon}"></i>
      </div>
      <div class="sup-act-text">${actionText} ${statusChip} ${changesChip}${mlUrl}</div>
     </div>`;
  }

  async function refreshSupervisionKPIs() {
    if (!window.supabaseClient) return;
    
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    try {
      const [auditRes, alertsRes] = await Promise.all([
        window.supabaseClient.from('audit_log').select('user_id, action, module, status, created_at, metadata').gte('created_at', weekAgo),
        window.supabaseClient.from('supervision_alerts').select('*').eq('status', 'open')
      ]);

      const audit = auditRes.data || [];
      const alerts = alertsRes.data || [];

      // KPIs
      const uniqueUsers = new Set(audit.map(a => a.user_id).filter(Boolean)).size;
      const actionsToday = audit.filter(a => a.created_at >= todayStart).length;
      const successCount = audit.filter(a => a.status === 'success' || a.status === 'info').length;
      const errorCount = audit.filter(a => a.status === 'error' || a.status === 'critical').length;
      const sensitiveCount = audit.filter(a => a.metadata?.sensitive === true).length;
      const openAlerts = alerts.length;
      const criticalAlerts = alerts.filter(a => a.severity === 'critical').length;
      const exportsCount = audit.filter(a => a.action === 'export' || a.action?.includes('export')).length;
      const bulkOpsCount = audit.filter(a => a.action?.includes('bulk') || a.metadata?.bulk === true).length;

      setKPI('kpiActiveUsers', uniqueUsers);
      setKPI('kpiActionsToday', actionsToday.toLocaleString('es-AR'));
      setKPI('kpiSuccess', successCount.toLocaleString('es-AR'));
      setKPI('kpiErrors', errorCount.toLocaleString('es-AR'));
      setKPI('kpiSensitive', sensitiveCount.toLocaleString('es-AR'));
      setKPI('kpiOpenAlerts', openAlerts);
      setKPI('kpiCriticalAlerts', criticalAlerts);
      setKPI('kpiExports', exportsCount);
      setKPI('kpiBulkOps', bulkOpsCount);

      // Rankings
      renderSupRankings(audit);
      
      // Update sidebar badge
      const badge = $('#sideBadgeSupervision');
      if (badge) badge.textContent = openAlerts;

    } catch (err) {
      logError('refreshSupervisionKPIs error:', err);
      showToast('Error cargando KPIs de supervisión', 'error');
    }
  }

  async function renderSupRankings(audit) {
    const userIds = [...new Set(audit.map(a => a.user_id).filter(Boolean))];
    let userNames = {};
    if (userIds.length && window.supabaseClient) {
      try {
        const { data } = await window.supabaseClient
          .from('profiles')
          .select('id, full_name')
          .in('id', userIds);
        if (data) userNames = Object.fromEntries(data.map(u => [u.id, u.full_name]));
      } catch (_) {}
    }
    const getName = (uid) => userNames[uid] || uid;

    // Activity by User
    const byUser = {};
    audit.forEach(a => {
      const uid = a.user_id || 'unknown';
      byUser[uid] = (byUser[uid] || 0) + 1;
    });
    const topUsers = Object.entries(byUser).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const usersEl = $('#rankingUsers');
    if (usersEl) {
      usersEl.innerHTML = topUsers.length
        ? topUsers.map(([uid, count]) => `<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--border-subtle);"><span style="color:var(--text-secondary);">${esc(getName(uid))}</span><span style="color:var(--accent); font-weight:600;">${count}</span></div>`).join('')
        : '<div style="color:var(--text-dim); text-align:center; padding:20px;">Sin actividad</div>';
    }

    // Activity by Module
    const byModule = {};
    audit.forEach(a => {
      const mod = a.module || 'general';
      byModule[mod] = (byModule[mod] || 0) + 1;
    });
    const topModules = Object.entries(byModule).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const modulesEl = $('#rankingModules');
    if (modulesEl) {
      modulesEl.innerHTML = topModules.length
        ? topModules.map(([mod, count]) => `<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--border-subtle);"><span style="color:var(--text-secondary);">${esc(mod)}</span><span style="color:var(--accent); font-weight:600;">${count}</span></div>`).join('')
        : '<div style="color:var(--text-dim); text-align:center; padding:20px;">Sin datos</div>';
    }

    // Errors by User
    const errorsByUser = {};
    audit.filter(a => a.status === 'error' || a.status === 'critical').forEach(a => {
      const uid = a.user_id || 'unknown';
      errorsByUser[uid] = (errorsByUser[uid] || 0) + 1;
    });
    const topErrors = Object.entries(errorsByUser).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const errorsEl = $('#rankingErrors');
    if (errorsEl) {
      errorsEl.innerHTML = topErrors.length
        ? topErrors.map(([uid, count]) => `<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--border-subtle);"><span style="color:var(--text-secondary);">${esc(getName(uid))}</span><span style="color:var(--danger); font-weight:600;">${count}</span></div>`).join('')
        : '<div style="color:var(--text-dim); text-align:center; padding:20px;">Sin errores</div>';
    }

    // Sensitive actions
    const sensitiveByUser = {};
    audit.filter(a => a.metadata?.sensitive === true).forEach(a => {
      const uid = a.user_id || 'unknown';
      sensitiveByUser[uid] = (sensitiveByUser[uid] || 0) + 1;
    });
    const topSensitive = Object.entries(sensitiveByUser).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const sensitiveEl = $('#rankingSensitive');
    if (sensitiveEl) {
      sensitiveEl.innerHTML = topSensitive.length
        ? topSensitive.map(([uid, count]) => `<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--border-subtle);"><span style="color:var(--text-secondary);">${esc(getName(uid))}</span><span style="color:var(--warning); font-weight:600;">${count}</span></div>`).join('')
        : '<div style="color:var(--text-dim); text-align:center; padding:20px;">Sin acciones sensibles</div>';
    }
  }

  async function loadSupUsersDropdown() {
    if (!window.supabaseClient) return;
    try {
      const { data } = await window.supabaseClient.from('profiles').select('id, full_name, email, role').order('full_name');
      const select = $('#supUserFilter');
      if (select && data) {
        select.innerHTML = '<option value="">Todos los usuarios</option>' + data.map(u => `<option value="${esc(u.id)}">${esc(u.full_name || u.email)} (${esc(u.role)})</option>`).join('');
      }
    } catch (err) {
      logError('loadSupUsersDropdown error:', err);
    }
  }

  async function loadSupModulesDropdown() {
    if (!window.supabaseClient) return;
    try {
      const { data } = await window.supabaseClient.from('audit_log').select('module').gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
      const modules = [...new Set((data || []).map(a => a.module).filter(Boolean))].sort();
      const select = $('#supModuleFilter');
      if (select) {
        select.innerHTML = '<option value="">Todos los módulos</option>' + modules.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
      }
    } catch (err) {
      logError('loadSupModulesDropdown error:', err);
    }
  }

  function initSupSubTabs() {
    on($('#supRefreshBtn'), 'click', () => loadTeamGrid());
    on($('#supExportBtn'), 'click', exportSupervisionCSV);

    const moduleSel = $('#supActivityModuleFilter');
    if (moduleSel && !moduleSel.dataset.supBound) {
      moduleSel.dataset.supBound = 'true';
      moduleSel.addEventListener('change', () => {
        _supEmployeePage = 0;
        if (_supEmployeeUserId) loadEmployeeActivity(_supEmployeeUserId);
      });
    }

    const loadMore = $('#supEmployeeLoadMore');
    if (loadMore && !loadMore.dataset.supBound) {
      loadMore.dataset.supBound = 'true';
      loadMore.addEventListener('click', () => {
        _supEmployeePage++;
        if (_supEmployeeUserId) loadEmployeeActivity(_supEmployeeUserId);
      });
    }
  }

  window.showSupEmployeeDetail = showSupEmployeeDetail;
  window.backToSupTeam = function() { showSupTeamBoard(); };
  window.refreshSupTeam = function() { loadTeamGrid(); };
  window.refreshSupEmployee = function() { if (_supEmployeeUserId) loadEmployeeActivity(_supEmployeeUserId); };
  window.loadMoreEmployeeActivity = function() { _supEmployeePage++; if (_supEmployeeUserId) loadEmployeeActivity(_supEmployeeUserId); };

  function switchSupView(view) {
    _supCurrentView = view;
    
    // Update tab buttons
    $$('.sup-subtab').forEach(t => {
      const isActive = t.dataset.view === view;
      t.classList.toggle('is-active', isActive);
      t.style.background = isActive ? 'rgba(31,200,195,0.1)' : 'transparent';
      t.style.color = isActive ? 'var(--accent)' : 'var(--text-muted)';
    });

    // Show/hide views
    $$('.sup-view').forEach(v => {
      const isActive = v.id === 'supView-' + view;
      v.style.display = isActive ? 'block' : 'none';
    });

    // Show/hide view-specific export buttons
    const exportBtns = {
      overview: 'supExportBtn',
      alerts: 'supExportAlertsBtn',
      users: 'supExportUsersBtn',
      modules: 'supExportModulesBtn',
      anomalies: 'supExportAnomaliesBtn',
      audit: 'supExportBtn', // reuse overview button for audit
    };
    Object.values(exportBtns).forEach(id => {
      const el = $('#' + id);
      if (el) el.style.display = 'none';
    });
    const activeExportBtn = exportBtns[view];
    if (activeExportBtn) {
      const el = $('#' + activeExportBtn);
      if (el) el.style.display = 'inline-flex';
    }

    // Show/hide "Cargar más" buttons
    const loadMoreBtns = {
      audit: 'supAuditLoadMore',
      alerts: 'supAlertsLoadMore',
      anomalies: 'anomLoadMore',
    };
    Object.values(loadMoreBtns).forEach(id => {
      const el = $('#' + id);
      if (el) el.style.display = 'none';
    });
    const activeLoadMoreBtn = loadMoreBtns[view];
    if (activeLoadMoreBtn) {
      const el = $('#' + activeLoadMoreBtn);
      if (el) el.style.display = 'inline-flex';
    }

    // Load view-specific data
    switch (view) {
      case 'activity': loadSupActivity(); break;
      case 'users': loadSupUsersTable(); break;
      case 'modules': loadSupModulesGrid(); break;
      case 'alerts': loadSupAlertsTable(); break;
      case 'anomalies': loadAnomaliesTable(); break;
      case 'audit': loadSupAuditTable(); break;
      case 'rules': loadSupRulesTable(); break;
      case 'overview':
      default:
        // Already loaded by refreshSupervisionKPIs
        break;
    }
  }

  function toggleSupAutoRefresh() {
    _supAutoRefresh = !_supAutoRefresh;
    const btn = $('#supAutoRefreshBtn');
    const text = $('#supAutoRefreshText');
    if (btn && text) {
      if (_supAutoRefresh) {
        btn.classList.remove('pending');
        btn.style.background = 'rgba(31,200,195,0.15)';
        btn.style.color = 'var(--accent)';
        text.textContent = 'Realtime ON';
        startSupAutoRefresh();
      } else {
        btn.classList.add('pending');
        btn.style.background = 'rgba(255,184,0,0.15)';
        btn.style.color = 'var(--warning)';
        text.textContent = 'Realtime OFF';
        stopSupAutoRefresh();
      }
    }
  }

  function startSupAutoRefresh() {
    stopSupAutoRefresh();
    _supAutoRefreshTimer = setInterval(() => {
      if (_supAutoRefresh && _supCurrentView === 'overview') {
        refreshSupervisionKPIs();
      }
      if (_supAutoRefresh && _supCurrentView === 'activity') {
        loadSupActivity();
      }
      if (_supAutoRefresh && _supCurrentView === 'alerts') {
        loadSupAlertsTable();
      }
    }, 30000); // 30 seconds
  }

  function stopSupAutoRefresh() {
    if (_supAutoRefreshTimer) {
      clearInterval(_supAutoRefreshTimer);
      _supAutoRefreshTimer = null;
    }
  }

  function setupSupRealtime() {
    if (!window.supabaseClient) return;
    if (_supRealtimeChannel) {
      _supRealtimeChannel.unsubscribe();
    }
    _supRealtimeChannel = window.supabaseClient.channel('supervision-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audit_log' }, payload => {
        if (_supAutoRefresh) {
          refreshSupervisionKPIs();
          if (_supCurrentView === 'activity') loadSupActivity();
          if (_supCurrentView === 'audit') loadSupAuditTable();
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supervision_alerts' }, payload => {
        if (_supAutoRefresh) {
          refreshSupervisionKPIs();
          if (_supCurrentView === 'alerts') loadSupAlertsTable();
        }
      })
      .subscribe();
  }

  // --- VIEW: ACTIVITY (Live feed) ---
  let _supActivitySearch = '';
  let _supActivitySeverity = '';
  let _supActivityDebounce = null;

  async function loadSupActivity() {
    if (!window.supabaseClient) return;
    const listEl = $('#activityList');
    if (!listEl) return;

    // Inicializar listeners una sola vez
    if (!listEl.dataset.listenersBound) {
      listEl.dataset.listenersBound = 'true';
      const searchEl = $('#supActivitySearch');
      const severityEl = $('#supActivitySeverityFilter');
      if (searchEl) {
        searchEl.addEventListener('input', () => {
          clearTimeout(_supActivityDebounce);
          _supActivityDebounce = setTimeout(() => {
            _supActivitySearch = searchEl.value.toLowerCase().trim();
            renderSupActivity();
          }, 200);
        });
      }
      if (severityEl) {
        severityEl.addEventListener('change', () => {
          _supActivitySeverity = severityEl.value;
          renderSupActivity();
        });
      }
    }

    listEl.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding:20px;">Cargando actividad...</div>';
    try {
      const { data } = await window.supabaseClient.from('audit_log').select('user_id, action, module, status, metadata, created_at').order('created_at', { ascending: false }).limit(200);
      window._supActivityCache = data || [];
      renderSupActivity();
    } catch (err) {
      logError('loadSupActivity error:', err);
      listEl.innerHTML = '<div style="color:var(--danger); text-align:center; padding:20px;">Error cargando actividad</div>';
    }
  }

  function renderSupActivity() {
    const listEl = $('#activityList');
    if (!listEl) return;
    const activity = window._supActivityCache || [];
    if (!activity.length) {
      listEl.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding:40px;">Sin actividad reciente</div>';
      return;
    }

    // Filtrar en cliente (cache de 200 filas)
    let filtered = activity;
    if (_supActivitySearch) {
      filtered = filtered.filter(a =>
        (a.user_id || '').toLowerCase().includes(_supActivitySearch) ||
        (a.action || '').toLowerCase().includes(_supActivitySearch) ||
        (a.module || '').toLowerCase().includes(_supActivitySearch) ||
        (a.metadata ? JSON.stringify(a.metadata).toLowerCase() : '').includes(_supActivitySearch)
      );
    }
    if (_supActivitySeverity) {
      filtered = filtered.filter(a => a.status === _supActivitySeverity);
    }

    const severityColors = { critical: '#EF4444', error: '#EF4444', high: '#F97316', medium: '#FFB800', low: '#3B82F6', info: '#1FC8C3', success: 'var(--success)' };
    listEl.innerHTML = filtered.slice(0, 100).map(a => {
      const color = severityColors[a.status] || 'var(--text-secondary)';
      const time = a.created_at ? new Date(a.created_at).toLocaleString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      const meta = a.metadata ? `<br><span style="color:var(--text-dim); font-size:10px;">${esc(JSON.stringify(a.metadata)).slice(0, 200)}</span>` : '';
      return `<div style="border-bottom:1px solid var(--border-subtle); padding:8px 0; font-family:monospace; font-size:11px; line-height:1.6;">
        <span style="color:var(--text-dim);">[${esc(time)}]</span>
        <span style="color:${color}; margin:0 8px;">?</span>
        <span style="color:var(--accent);">${esc(a.module || 'general')}</span>
        <span style="color:var(--text-secondary);">${esc(a.action)}</span>
        <span style="color:var(--text-muted);">por ${esc(a.user_id || 'sistema')}</span>
        ${meta}
      </div>`;
    }).join('');
  }

  // --- VIEW: USERS TABLE ---
  async function loadSupUsersTable() {
    if (!window.supabaseClient) return;
    const tbody = $('#supUsersTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="10" style="padding:40px; text-align:center; color:var(--text-dim);">Cargando...</td></tr>';
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const [auditRes, profilesRes] = await Promise.all([
        window.supabaseClient.from('audit_log').select('user_id, action, status, created_at, metadata').gte('created_at', weekAgo),
        window.supabaseClient.from('profiles').select('id, full_name, email, role')
      ]);
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

      const alertCounts = {};
      const { data: alerts } = await window.supabaseClient.from('supervision_alerts').select('user_id').eq('status', 'open');
      (alerts || []).forEach(a => { alertCounts[a.user_id] = (alertCounts[a.user_id] || 0) + 1; });

      const { data: agentLinks } = await window.supabaseClient.from('agents').select('profile_id').not('profile_id', 'is', null);
      const agentProfileIds = new Set((agentLinks || []).map(a => a.profile_id));

      const rows = Object.entries(userStats).map(([uid, stats]) => {
        const profile = profileMap.get(uid);
        const name = profile ? `${esc(profile.full_name || profile.email)}` : `UID: ${uid.slice(0,8)}...`;
        const role = profile ? esc(profile.role) : '—';
        const broker = agentProfileIds.has(uid) ? 'Sí' : 'No';
        const lastAct = stats.lastActivity ? new Date(stats.lastActivity).toLocaleString('es-AR') : '—';
        const alertCount = alertCounts[uid] || 0;
        const statusClass = alertCount > 5 ? 'danger' : alertCount > 0 ? 'warning' : 'success';
        const statusText = alertCount > 5 ? '?? Crítico' : alertCount > 0 ? '?? Alerta' : '? OK';
        return `<tr style="border-bottom:1px solid var(--border-subtle);">
          <td style="padding:10px 16px; color:#fff;">${name}</td>
          <td style="padding:10px 16px; color:var(--text-secondary);">${role}</td>
          <td style="padding:10px 16px; color:var(--text-secondary);">${broker}</td>
          <td style="padding:10px 16px; color:var(--text-secondary);">${lastAct}</td>
          <td style="padding:10px 16px; text-align:right; color:var(--accent); font-weight:600;">${stats.actions.toLocaleString('es-AR')}</td>
          <td style="padding:10px 16px; text-align:right; color:var(--danger); font-weight:600;">${stats.errors}</td>
          <td style="padding:10px 16px; text-align:right; color:var(--warning); font-weight:600;">${stats.sensitive}</td>
          <td style="padding:10px 16px; text-align:right; color:#F59E0B; font-weight:600;">${stats.exports}</td>
          <td style="padding:10px 16px; text-align:center; color:${alertCount > 0 ? 'var(--danger)' : 'var(--success)'}; font-weight:600;">${alertCount}</td>
          <td style="padding:10px 16px; text-align:center;">
            <span class="status-pill ${statusClass}" style="font-size:10px;">${statusText}</span>
          </td>
        </tr>`;
      }).join('');

      tbody.innerHTML = rows || '<tr><td colspan="10" style="padding:40px; text-align:center; color:var(--text-dim);">Sin datos</td></tr>';

      // Click handlers for user detail
      $$('#supUsersTableBody tr').forEach(tr => {
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => {
          const uid = Object.keys(userStats)[Array.from(tr.parentNode.children).indexOf(tr)];
          if (uid) openSupUserDetail(uid, userStats[uid], profileMap.get(uid), audit.filter(a => a.user_id === uid));
        });
      });
    } catch (err) {
      logError('loadSupUsersTable error:', err);
      tbody.innerHTML = '<tr><td colspan="10" style="padding:40px; text-align:center; color:var(--danger);">Error cargando usuarios</td></tr>';
    }
  }

  function openSupUserDetail(uid, stats, profile, userAudit) {
    const detail = $('#supUserDetail');
    const nameEl = $('#supUserDetailName');
    if (!detail || !nameEl) return;
    nameEl.textContent = profile ? `${profile.full_name || profile.email}` : `UID: ${uid}`;
    $('#udTotalActivity').textContent = `${stats.actions} acciones (${stats.errors} errores, ${stats.sensitive} sensibles, ${stats.exports} exportaciones, ${stats.bulk} masivas)`;
    
    const byModule = {};
    userAudit.forEach(a => { byModule[a.module || 'general'] = (byModule[a.module || 'general'] || 0) + 1; });
    $('#udByModule').innerHTML = Object.entries(byModule).map(([m, c]) => `<div>${esc(m)}: <span style="color:var(--accent);">${c}</span></div>`).join('');
    
    $('#udRecentEvents').innerHTML = userAudit.slice(0, 20).map(a => {
      const time = a.created_at ? new Date(a.created_at).toLocaleString('es-AR') : '';
      return `<div style="border-bottom:1px solid var(--border-subtle); padding:4px 0; font-family:monospace; font-size:11px;">
        [${esc(time)}] ${esc(a.action)} en ${esc(a.module || 'general')} <span style="color:${a.status === 'error' ? 'var(--danger)' : a.status === 'critical' ? '#EF4444' : 'var(--text-secondary)'}">[${esc(a.status)}]</span>
      </div>`;
    }).join('');
    
    $('#udErrors').textContent = stats.errors ? `${stats.errors} errores en 7 días` : 'Sin errores';
    $('#udSensitive').textContent = stats.sensitive ? `${stats.sensitive} acciones sensibles` : 'Sin acciones sensibles';
    $('#udExports').textContent = stats.exports ? `${stats.exports} exportaciones` : 'Sin exportaciones';
    $('#udAlerts').innerHTML = `<button class="status-pill" onclick="navigateTo('tab-supervision'); setTimeout(() => switchSupView('alerts'), 100);">${stats.alerts || 0} alertas abiertas</button>`;
    $('#udCompare').textContent = `Promedio acciones/usuario: ${Math.round(Object.values(userStats).reduce((s, u) => s + u.actions, 0) / Object.keys(userStats).length)}`;
    
    detail.style.display = 'block';
    detail.scrollIntoView({ behavior: 'smooth' });
  }

  window.closeSupUserDetail = function() {
    const detail = $('#supUserDetail');
    if (detail) detail.style.display = 'none';
  };

  // --- VIEW: MODULES GRID ---
  async function loadSupModulesGrid() {
    if (!window.supabaseClient) return;
    const grid = $('.modules-grid');
    if (!grid) return;
    grid.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding:40px;">Cargando módulos...</div>';
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await window.supabaseClient.from('audit_log').select('module, action, status, created_at').gte('created_at', weekAgo);
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

      grid.innerHTML = Object.entries(modStats).map(([mod, stats]) => {
        const errorRate = stats.total > 0 ? ((stats.errors / stats.total) * 100).toFixed(1) : 0;
        const errorColor = errorRate > 10 ? 'var(--danger)' : errorRate > 5 ? 'var(--warning)' : 'var(--success)';
        return `<div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:12px; padding:20px;">
          <h4 style="color:var(--accent); margin:0 0 12px; font-size:14px;">${esc(mod)}</h4>
          <div style="display:grid; grid-template-columns:repeat(2,1fr); gap:8px; font-size:12px; color:var(--text-secondary);">
            <div>Total acciones: <span style="color:var(--accent); font-weight:600;">${stats.total.toLocaleString('es-AR')}</span></div>
            <div>Usuarios únicos: <span style="color:var(--accent); font-weight:600;">${stats.users.size}</span></div>
            <div>Acciones únicas: <span style="color:var(--accent); font-weight:600;">${stats.actions.size}</span></div>
            <div>Errores: <span style="color:${errorColor}; font-weight:600;">${stats.errors} (${errorRate}%)</span></div>
          </div>
        </div>`;
      }).join('');
    } catch (err) {
      logError('loadSupModulesGrid error:', err);
      grid.innerHTML = '<div style="color:var(--danger); text-align:center; padding:40px;">Error cargando módulos</div>';
    }
  }

  // --- VIEW: ALERTS TABLE ---
  let _supAlertsCursor = null;
  let _supAlertsHasMore = true;

  async function loadSupAlertsTable(append = false) {
    if (!window.supabaseClient) return;
    const tbody = $('#supAlertsTableBody');
    const loadMoreBtn = $('#supAlertsLoadMore');
    if (!tbody) return;
    if (!append) {
      tbody.innerHTML = '<tr><td colspan="10" style="padding:40px; text-align:center; color:var(--text-dim);">Cargando...</td></tr>';
      _supAlertsCursor = null;
      _supAlertsHasMore = true;
    }
    try {
      // Cargar usuarios para dropdown de asignación
      const { data: usersData } = await window.supabaseClient
        .from('profiles')
        .select('id, full_name, email, role')
        .eq('is_active', true)
        .order('full_name');
      const users = usersData || [];
      const userOptions = users.map(u => `<option value="${esc(u.id)}">${esc(u.full_name || u.email)} (${esc(u.role)})</option>`).join('');

      let query = window.supabaseClient.from('supervision_alerts').select('*').order('created_at', { ascending: false }).limit(51);
      if (_supAlertsCursor) {
        query = query.or(`created_at.lt.${_supAlertsCursor.created_at},and(created_at.eq.${_supAlertsCursor.created_at},id.lt.${_supAlertsCursor.id})`);
      }

      const { data, error } = await query;
      if (error) throw error;
      const alerts = data || [];
      const hasMore = alerts.length > 50;
      const rows = hasMore ? alerts.slice(0, 50) : alerts;
      _supAlertsHasMore = hasMore;
      if (rows.length) {
        _supAlertsCursor = { created_at: rows[rows.length - 1].created_at, id: rows[rows.length - 1].id };
      }

      const severityColors = { critical: '#EF4444', high: '#F97316', medium: '#FFB800', low: '#3B82F6', info: '#1FC8C3' };
      const severityLabels = { critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja', info: 'Info' };
      const statusLabels = { open: 'Abierta', assigned: 'Asignada', investigating: 'Investigando', acknowledged: 'Reconocida', resolved: 'Resuelta', dismissed: 'Descartada' };
      const statusPillClass = {
        open: 'pending', assigned: 'active', investigating: 'active',
        acknowledged: 'active', resolved: 'success', dismissed: 'pending'
      };
      const renderRows = rows.map(a => {
        const color = severityColors[a.severity] || 'var(--text-secondary)';
        const assignedName = a.assigned_to
          ? (users.find(u => u.id === a.assigned_to)?.full_name || users.find(u => u.id === a.assigned_to)?.email || a.assigned_to.slice(0,8)+'...')
          : '—';
        return `<tr style="border-bottom:1px solid var(--border-subtle);" data-alert-id="${esc(a.id)}">
          <td style="padding:10px 12px;"><span style="color:${color}; font-weight:600;">${severityLabels[a.severity] || a.severity}</span></td>
          <td style="padding:10px 12px; color:var(--text-secondary);">${esc(a.rule_name || a.alert_type || '—')}</td>
          <td style="padding:10px 12px; color:#fff;">${esc(a.user_name || a.user_id || '—')}</td>
          <td style="padding:10px 12px; color:var(--text-secondary);">${esc(a.module || '—')}</td>
          <td style="padding:10px 12px; color:var(--text-secondary);">${esc(a.description || '—').slice(0, 80)}${a.description && a.description.length > 80 ? '...' : ''}</td>
          <td style="padding:10px 12px; font-family:monospace; font-size:10px; color:var(--text-dim);">${a.evidence ? '?? Ver' : '—'}</td>
          <td style="padding:10px 12px; color:var(--text-secondary);">${a.created_at ? new Date(a.created_at).toLocaleString('es-AR') : '—'}</td>
          <td style="padding:10px 12px; color:var(--accent); font-weight:500; font-size:12px;">${esc(assignedName)}</td>
          <td style="padding:10px 12px;"><span class="status-pill ${statusPillClass[a.status] || 'pending'}" style="font-size:10px;">${statusLabels[a.status] || a.status}</span></td>
          <td style="padding:10px 12px; text-align:center;">
            <div style="display:flex; gap:4px; justify-content:center; flex-wrap:wrap;">
              ${a.status === 'open' ? `
                <select class="assign-user-select" data-alert-id="${esc(a.id)}" style="padding:4px 8px; border:1px solid var(--border-input); border-radius:4px; background:rgba(255,255,255,0.03); color:#fff; font-size:11px; min-width:140px;" onchange="assignSupAlert(this.value, '${esc(a.id)}')">
                  <option value="">— Asignar a —</option>
                  ${userOptions}
                </select>
              ` : ''}
              ${a.status === 'assigned' || a.status === 'investigating' ? `
                <button class="btn-action" onclick="acknowledgeSupAlert('${esc(a.id)}')" title="Reconocer (empezar investigación)"><i class="fas fa-check"></i></button>
                <button class="btn-action" onclick="resolveSupAlert('${esc(a.id)}')" title="Marcar resuelta"><i class="fas fa-flag-checkered"></i></button>
              ` : ''}
              ${a.status === 'open' || a.status === 'assigned' || a.status === 'investigating' || a.status === 'acknowledged' ? `
                <button class="btn-action" onclick="dismissSupAlert('${esc(a.id)}')" title="Descartar"><i class="fas fa-times"></i></button>
              ` : ''}
              ${a.notes ? `
                <button class="btn-action" onclick="viewSupAlertNotes('${esc(a.id)}')" title="Ver/editar notas"><i class="fas fa-sticky-note"></i></button>
              ` : ''}
              <button class="btn-action" onclick="viewSupAlertDetail('${esc(a.id)}')" title="Ver detalle completo"><i class="fas fa-eye"></i></button>
            </div>
          </td>
        </tr>`;
      }).join('');

      if (append) {
        tbody.innerHTML += renderRows;
      } else {
        tbody.innerHTML = renderRows;
      }

      if (loadMoreBtn) {
        loadMoreBtn.style.display = _supAlertsHasMore ? 'inline-flex' : 'none';
      }
    } catch (err) {
      logError('loadSupAlertsTable error:', err);
      tbody.innerHTML = '<tr><td colspan="10" style="padding:40px; text-align:center; color:var(--danger);">Error cargando alertas</td></tr>';
      if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    }
  }

  window.loadMoreSupAlerts = function() {
    loadSupAlertsTable(true);
  };

  window.assignSupAlert = async function(userId, alertId) {
    if (!userId || !window.supabaseClient) return;
    try {
      await window.supabaseClient.from('supervision_alerts').update({ assigned_to: userId, status: 'assigned', updated_at: new Date().toISOString() }).eq('id', alertId);
      showToast('Alerta asignada', 'success');
      loadSupAlertsTable();
      refreshSupervisionKPIs();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.acknowledgeSupAlert = async function(alertId) {
    if (!window.supabaseClient) return;
    try {
      await window.supabaseClient.from('supervision_alerts').update({ status: 'acknowledged', acknowledged_by: currentUser.id, acknowledged_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', alertId);
      showToast('Alerta reconocida - investigación iniciada', 'success');
      loadSupAlertsTable();
      refreshSupervisionKPIs();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.resolveSupAlert = async function(alertId) {
    if (!window.supabaseClient) return;
    try {
      await window.supabaseClient.from('supervision_alerts').update({ status: 'resolved', resolved_by: currentUser.id, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', alertId);
      showToast('Alerta marcada como resuelta', 'success');
      loadSupAlertsTable();
      refreshSupervisionKPIs();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.dismissSupAlert = async function(alertId) {
    if (!window.supabaseClient) return;
    try {
      await window.supabaseClient.from('supervision_alerts').update({ status: 'dismissed', dismissed_by: currentUser.id, dismissed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', alertId);
      showToast('Alerta descartada', 'success');
      loadSupAlertsTable();
      refreshSupervisionKPIs();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.viewSupAlertNotes = async function(alertId) {
    if (!window.supabaseClient) return;
    try {
      const { data } = await window.supabaseClient.from('supervision_alerts').select('notes').eq('id', alertId).single();
      if (!data) return;
      const currentNotes = data.notes || '';
      const newNotes = prompt('Notas de investigación:', currentNotes);
      if (newNotes === null) return; // Cancel
      if (newNotes === currentNotes) return; // No changes
      await window.supabaseClient.from('supervision_alerts').update({ notes: newNotes, updated_at: new Date().toISOString() }).eq('id', alertId);
      showToast('Notas actualizadas', 'success');
      loadSupAlertsTable();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.viewSupAlertDetail = async function(id) {
    if (!window.supabaseClient) return;
    try {
      const { data } = await window.supabaseClient.from('supervision_alerts').select('*').eq('id', id).single();
      if (!data) return;

      // Build detail content with button to navigate to Auditoría
      const evidence = data.evidence ? JSON.stringify(data.evidence, null, 2) : '—';
      const requestId = data.metadata?.request_id || data.evidence?.request_id || '—';
      const entityId = data.evidence?.entity_id || '—';
      const entityType = data.evidence?.entity_type || '—';

      const content = `
        <div style="line-height:1.8; font-size:13px;">
          <div><strong>ID:</strong> <code style="color:var(--accent);">${esc(data.id)}</code></div>
          <div><strong>Regla:</strong> ${esc(data.rule_name || data.alert_type || '—')}</div>
          <div><strong>Severidad:</strong> <span style="color:${({critical:'#EF4444',high:'#F97316',medium:'#FFB800',low:'#3B82F6',info:'#1FC8C3'}[data.severity]||'var(--text-secondary)')}; font-weight:600;">${esc(data.severity)}</span></div>
          <div><strong>Usuario:</strong> ${esc(data.user_name || data.user_id || '—')}</div>
          <div><strong>Módulo:</strong> <span style="color:var(--accent);">${esc(data.module || '—')}</span></div>
          <div><strong>Descripción:</strong> ${esc(data.description || '—')}</div>
          <div><strong>Evidencia:</strong><pre style="background:rgba(255,255,255,0.03); padding:12px; border-radius:8px; font-size:11px; overflow:auto; max-height:200px; margin-top:8px;">${esc(evidence)}</pre></div>
          <div style="margin-top:16px; padding:12px; background:rgba(31,200,195,0.1); border:1px solid rgba(31,200,195,0.3); border-radius:8px;">
            <div style="font-weight:600; color:var(--accent); margin-bottom:8px;">?? Vincular con Auditoría</div>
            <div style="font-size:12px; color:var(--text-secondary);">Si la alerta se generó desde un evento de auditoría, puedes buscar el evento original:</div>
            <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
              ${requestId !== '—' ? `<button class="btn-action" onclick="goToAuditFromAlert('request_id', '${esc(requestId)}')" title="Buscar por Request ID"><i class="fas fa-search"></i> Request ID: ${esc(requestId).slice(0,20)}...</button>` : ''}
              ${entityId !== '—' ? `<button class="btn-action" onclick="goToAuditFromAlert('entity_id', '${esc(entityId)}')" title="Buscar por Entity ID"><i class="fas fa-search"></i> Entity ID: ${esc(entityId).slice(0,20)}...</button>` : ''}
            </div>
          </div>
          <hr style="margin:16px 0; border-color:var(--border-subtle);">
          <div><strong>Creada:</strong> ${data.created_at ? new Date(data.created_at).toLocaleString('es-AR') : '—'}</div>
          <div><strong>Estado:</strong> ${esc(data.status)}</div>
        </div>
      `;

      // Show in a modal instead of alert
      let modal = $('#supAlertDetailModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'supAlertDetailModal';
        modal.className = 'admin-modal';
        modal.innerHTML = `
          <div class="modal-box" style="max-width:600px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px;">
              <h3 id="supAlertDetailTitle" style="font-family:var(--font-heading); font-size:22px; color:#fff; margin:0;"></h3>
              <button type="button" class="status-pill pending" onclick="closeModal('supAlertDetailModal')"><i class="fas fa-times"></i></button>
            </div>
            <div id="supAlertDetailContent" style="max-height:70vh; overflow-y:auto;"></div>
          </div>
        `;
        document.body.appendChild(modal);
      }
      $('#supAlertDetailTitle').textContent = `Alerta: ${esc(data.rule_name || data.alert_type || id)}`;
      $('#supAlertDetailContent').innerHTML = content;
      openModal('supAlertDetailModal');

    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  // Navegar a Auditoría desde alerta (filtra por request_id o entity_id)
  window.goToAuditFromAlert = function(filterType, value) {
    if (!value || value === '—') return;
    navigateTo('tab-supervision');
    setTimeout(() => {
      switchSupView('audit');
      if (filterType === 'request_id') {
        $('#supModuleFilter').value = ''; // no filtrar por módulo
        // Buscar en metadata.request_id - necesitamos filtro personalizado
        // Por ahora ponemos el valor en un campo temporal y filtramos
        window._auditCustomFilter = { type: 'request_id', value };
      } else if (filterType === 'entity_id') {
        window._auditCustomFilter = { type: 'entity_id', value };
      }
      loadSupAuditTable();
    }, 150);
  };

  // --- VIEW: AUDIT TABLE ---
  let _supAuditCursor = null; // { created_at, id }
  let _supAuditHasMore = true;

  async function loadSupAuditTable(append = false) {
    if (!window.supabaseClient) return;
    const tbody = $('#supAuditTableBody');
    const loadMoreBtn = $('#supAuditLoadMore');
    if (!tbody) return;
    if (!append) {
      tbody.innerHTML = '<tr><td colspan="9" style="padding:40px; text-align:center; color:var(--text-dim);">Cargando...</td></tr>';
      _supAuditCursor = null;
      _supAuditHasMore = true;
    }
    try {
      const fromDate = $('#supFromDate')?.value ? new Date($('#supFromDate').value).toISOString() : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const toDate = $('#supToDate')?.value ? new Date(new Date($('#supToDate').value).getTime() + 24 * 60 * 60 * 1000).toISOString() : new Date().toISOString();
      const moduleFilter = $('#supModuleFilter')?.value;
      const userFilter = $('#supUserFilter')?.value;
      const severityFilter = $('#supSeverityFilter')?.value;

      // Custom filter from alert detail (request_id or entity_id)
      const customFilter = window._auditCustomFilter || null;

      let query = window.supabaseClient.from('audit_log').select('*').gte('created_at', fromDate).lte('created_at', toDate).order('created_at', { ascending: false }).limit(51); // 51 para detectar hasMore
      if (moduleFilter) query = query.eq('module', moduleFilter);
      if (userFilter) query = query.eq('user_id', userFilter);
      if (severityFilter) query = query.eq('severity', severityFilter);
      // Custom filter from alert detail
      if (customFilter) {
        if (customFilter.type === 'request_id') {
          query = query.or(`request_id.eq.${customFilter.value},metadata->>request_id.eq.${customFilter.value}`);
        } else if (customFilter.type === 'entity_id') {
          query = query.or(`entity_id.eq.${customFilter.value},metadata->>entity_id.eq.${customFilter.value}`);
        }
        // Clear after use
        window._auditCustomFilter = null;
      }
      // Cursor-based pagination
      if (_supAuditCursor) {
        query = query.or(`created_at.lt.${_supAuditCursor.created_at},and(created_at.eq.${_supAuditCursor.created_at},id.lt.${_supAuditCursor.id})`);
      }

      const { data, error } = await query;
      if (error) throw error;
      const audit = data || [];
      const hasMore = audit.length > 50;
      const rows = hasMore ? audit.slice(0, 50) : audit;
      _supAuditHasMore = hasMore;
      if (rows.length) {
        _supAuditCursor = { created_at: rows[rows.length - 1].created_at, id: rows[rows.length - 1].id };
      }

      const resultColors = { success: 'var(--success)', error: 'var(--danger)', critical: '#EF4444', info: 'var(--accent)', warning: 'var(--warning)' };
      const renderRows = rows.map(a => {
        const color = resultColors[a.status] || 'var(--text-secondary)';
        return `<tr style="border-bottom:1px solid var(--border-subtle); cursor:pointer;" onclick="openSupAuditDetail('${esc(a.id)}')">
          <td style="padding:8px 10px; font-family:monospace; font-size:11px; color:var(--text-secondary);">${a.created_at ? new Date(a.created_at).toLocaleString('es-AR') : '—'}</td>
          <td style="padding:8px 10px; color:#fff;">${esc(a.user_id || 'sistema')}</td>
          <td style="padding:8px 10px; color:var(--text-secondary);">${esc(a.user_role || '—')}</td>
          <td style="padding:8px 10px; color:var(--accent); font-size:12px;">${esc(a.module || 'general')}</td>
          <td style="padding:8px 10px; color:#fff; font-weight:500;">${esc(a.action)}</td>
          <td style="padding:8px 10px; color:var(--text-secondary); font-family:monospace; font-size:11px;">${esc(a.entity_type || '—')}:${esc(a.entity_id || '—').slice(0, 20)}</td>
          <td style="padding:8px 10px; text-align:center;"><span style="color:${color}; font-weight:600; text-transform:uppercase; font-size:11px;">${esc(a.status || 'info')}</span></td>
          <td style="padding:8px 10px; color:var(--text-dim); font-family:monospace; font-size:10px;">${esc(a.ip_address || '—')}</td>
          <td style="padding:8px 10px; color:var(--text-dim); font-family:monospace; font-size:10px;">${esc(a.request_id || '—').slice(0, 20)}</td>
        </tr>`;
      }).join('');

      if (append) {
        tbody.innerHTML += renderRows;
      } else {
        tbody.innerHTML = renderRows;
      }

      // Botón "Cargar más"
      if (loadMoreBtn) {
        loadMoreBtn.style.display = _supAuditHasMore ? 'inline-flex' : 'none';
      }
    } catch (err) {
      logError('loadSupAuditTable error:', err);
      tbody.innerHTML = '<tr><td colspan="9" style="padding:40px; text-align:center; color:var(--danger);">Error cargando auditoría</td></tr>';
      if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    }
  }

  window.loadMoreSupAudit = function() {
    loadSupAuditTable(true);
  };

  window.openSupAuditDetail = async function(id) {
    if (!window.supabaseClient) return;
    const detail = $('#supAuditDetail');
    const content = $('#supAuditDetailContent');
    if (!detail || !content) return;
    try {
      const { data } = await window.supabaseClient.from('audit_log').select('*').eq('id', id).single();
      if (!data) return;
      content.innerHTML = `
        <div style="margin-bottom:12px;"><strong>ID:</strong> <code style="color:var(--accent);">${esc(data.id)}</code></div>
        <div style="margin-bottom:12px;"><strong>Fecha:</strong> ${data.created_at ? new Date(data.created_at).toLocaleString('es-AR') : '—'}</div>
        <div style="margin-bottom:12px;"><strong>Usuario:</strong> ${esc(data.user_id)} <span style="color:var(--text-dim);">(${esc(data.user_role || '—')})</span></div>
        <div style="margin-bottom:12px;"><strong>Módulo:</strong> <span style="color:var(--accent);">${esc(data.module || 'general')}</span></div>
        <div style="margin-bottom:12px;"><strong>Acción:</strong> <span style="color:#fff; font-weight:600;">${esc(data.action)}</span></div>
        <div style="margin-bottom:12px;"><strong>Entidad:</strong> ${esc(data.entity_type || '—')}:${esc(data.entity_id || '—')}</div>
        <div style="margin-bottom:12px;"><strong>Severidad:</strong> <span style="color:${resultColors[data.status] || 'var(--text-secondary)'}; font-weight:600; text-transform:uppercase;">${esc(data.status || 'info')}</span></div>
        <div style="margin-bottom:12px;"><strong>IP:</strong> ${esc(data.ip_address || '—')}</div>
        <div style="margin-bottom:12px;"><strong>Request ID:</strong> <code style="color:var(--accent);">${esc(data.request_id || '—')}</code></div>
        <div style="margin-bottom:12px;"><strong>Metadata:</strong><pre style="background:rgba(255,255,255,0.03); padding:12px; border-radius:8px; font-size:11px; overflow:auto; max-height:200px;">${esc(JSON.stringify(data.metadata || {}, null, 2))}</pre></div>
      `;
      detail.style.display = 'block';
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.closeSupAuditDetail = function() {
    const detail = $('#supAuditDetail');
    if (detail) detail.style.display = 'none';
  };

  const resultColors = { success: 'var(--success)', error: 'var(--danger)', critical: '#EF4444', info: 'var(--accent)', warning: 'var(--warning)' };

  // --- VIEW: RULES TABLE ---
  async function loadSupRulesTable() {
    if (!window.supabaseClient) return;
    const tbody = $('#supRulesTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9" style="padding:40px; text-align:center; color:var(--text-dim);">Cargando...</td></tr>';
    try {
      const { data } = await window.supabaseClient.from('supervision_rules').select('*').order('created_at', { ascending: false });
      const rules = data || [];
      if (!rules.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="padding:40px; text-align:center; color:var(--text-dim);">Sin reglas configuradas</td></tr>';
        return;
      }
      const severityColors = { critical: '#EF4444', high: '#F97316', medium: '#FFB800', low: '#3B82F6', info: '#1FC8C3' };
      tbody.innerHTML = rules.map(r => {
        const color = severityColors[r.severity] || 'var(--text-secondary)';
        return `<tr style="border-bottom:1px solid var(--border-subtle);">
          <td style="padding:10px 12px; color:#fff; font-weight:500;">${esc(r.name)}</td>
          <td style="padding:10px 12px; color:var(--text-secondary);">${esc(r.module || 'todos')}</td>
          <td style="padding:10px 12px; color:var(--text-secondary);">${esc(r.action || 'todas')}</td>
          <td style="padding:10px 12px; color:var(--text-secondary);">${esc(r.event_type || 'todos')}</td>
          <td style="padding:10px 12px; font-family:monospace; font-size:10px; color:var(--text-dim);">${esc(r.condition_json ? JSON.stringify(r.condition_json) : 'siempre')}</td>
          <td style="padding:10px 12px; text-align:center;"><span style="color:${color}; font-weight:600; text-transform:uppercase;">${esc(r.severity)}</span></td>
          <td style="padding:10px 12px; text-align:center; color:var(--text-secondary);">${esc(r.window)}</td>
          <td style="padding:10px 12px; text-align:center;">
            <label class="pf-toggle"><input type="checkbox" ${r.enabled ? 'checked' : ''} disabled><span class="toggle-slider"></span></label>
          </td>
          <td style="padding:10px 12px; text-align:center;">
            <button class="btn-action" onclick="editSupRule('${esc(r.id)}')"><i class="fas fa-edit"></i></button>
            <button class="btn-action danger" onclick="deleteSupRule('${esc(r.id)}')"><i class="fas fa-trash"></i></button>
          </td>
        </tr>`;
      }).join('');
    } catch (err) {
      logError('loadSupRulesTable error:', err);
      tbody.innerHTML = '<tr><td colspan="9" style="padding:40px; text-align:center; color:var(--danger);">Error cargando reglas</td></tr>';
    }
  }

  // Rules modal handlers
  on($('#supNewRuleBtn'), 'click', () => {
    switchSupView('rules');
    $('#supRuleForm')?.reset();
    $('#supRuleId').value = '';
    $('#supRuleModalTitle').textContent = 'Nueva Regla';
    openModal('supRuleModal');
  });

  window.editSupRule = async function(id) {
    if (!window.supabaseClient) return;
    try {
      const { data } = await window.supabaseClient.from('supervision_rules').select('*').eq('id', id).single();
      if (!data) return;
      $('#supRuleId').value = data.id;
      $('#supRuleForm [name="name"]').value = data.name;
      $('#supRuleForm [name="description"]').value = data.description || '';
      $('#supRuleForm [name="module"]').value = data.module || '';
      $('#supRuleForm [name="action"]').value = data.action || '';
      $('#supRuleForm [name="event_type"]').value = data.event_type || '';
      $('#supRuleForm [name="severity"]').value = data.severity;
      $('#supRuleForm [name="threshold"]').value = data.threshold;
      $('#supRuleForm [name="window"]').value = data.window;
      $('#supRuleForm [name="cooldown_minutes"]').value = data.cooldown_minutes;
      $('#supRuleForm [name="enabled"]').checked = data.enabled;
      $('#supRuleForm [name="filter_json"]').value = data.filter_json ? JSON.stringify(data.filter_json, null, 2) : '';
      $('#supRuleModalTitle').textContent = 'Editar Regla';
      openModal('supRuleModal');
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.deleteSupRule = async function(id) {
    if (!window.supabaseClient) return;
    if (!confirm('¿Eliminar esta regla?')) return;
    try {
      await window.supabaseClient.from('supervision_rules').delete().eq('id', id);
      showToast('Regla eliminada', 'success');
      loadSupRulesTable();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  // Simular regla: ejecuta la lógica contra audit_log reciente y muestra matches
  window.simulateSupRule = async function() {
    if (!window.supabaseClient) return;
    const fd = new FormData($('#supRuleForm'));
    const name = fd.get('name');
    const module = fd.get('module') || null;
    const action = fd.get('action') || null;
    const threshold = parseInt(fd.get('threshold')) || 0;
    const windowStr = fd.get('window') || '1 hour';
    const filterJson = fd.get('filter_json') ? JSON.parse(fd.get('filter_json')) : null;
    const cooldown = parseInt(fd.get('cooldown_minutes')) || 0;

    if (!name) { showToast('Ingrese un nombre para la regla', 'error'); return; }

    const modal = $('#supRuleModal');
    const btn = $('#supRuleSimulateBtn');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Simulando...';
    btn.disabled = true;

    try {
      const v_window = windowStr;
      const v_threshold = threshold;
      const v_filter = filterJson;

      let query = window.supabaseClient.from('audit_log').select('user_id, action, module, status, changed_fields, metadata, created_at').gte('created_at', new Date(Date.now() - parseInterval(v_window)).toISOString());
      if (module) query = query.eq('module', module);
      if (action) query = query.eq('action', action);

      const { data, error } = await query;
      if (error) throw error;
      const audit = data || [];

      let matches = [];
      if (v_filter && v_filter.contains) {
        const field = v_filter.contains;
        matches = audit.filter(a => a.changed_fields && a.changed_fields.includes(field) && a.user_id)
          .reduce((acc, a) => {
            acc[a.user_id] = (acc[a.user_id] || 0) + 1;
            return acc;
          }, {});
        matches = Object.entries(matches).filter(([_, count]) => count > v_threshold);
      } else {
        matches = audit.filter(a => a.user_id)
          .reduce((acc, a) => {
            acc[a.user_id] = (acc[a.user_id] || 0) + 1;
            return acc;
          }, {});
        matches = Object.entries(matches).filter(([_, count]) => count > v_threshold);
      }

      if (!matches.length) {
        showToast('Simulación: 0 usuarios superan el umbral', 'info');
        return;
      }

      // Verificar cooldown (alertas existentes recientes)
      const cooldownStart = new Date(Date.now() - cooldown * 60 * 1000).toISOString();
      const { data: existingAlerts } = await window.supabaseClient.from('supervision_alerts').select('user_id').eq('alert_type', name).gte('created_at', cooldownStart).in('status', ['open', 'assigned', 'investigating', 'acknowledged']);
      const cooledUsers = new Set((existingAlerts || []).map(a => a.user_id));

      const results = matches.map(([userId, count]) => ({
        userId,
        count,
        wouldAlert: !cooledUsers.has(userId),
        cooldownBlocked: cooledUsers.has(userId)
      }));

      // Mostrar resultados en modal
      const resultHtml = results.map(r => `
        <div style="padding:10px; border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:600;">${r.userId.slice(0,8)}...</div>
            <div style="font-size:11px; color:var(--text-dim);">${r.count} eventos en la ventana</div>
          </div>
          <span class="status-pill ${r.wouldAlert ? 'pending' : 'success'}" style="font-size:10px;">
            ${r.wouldAlert ? '?? Generaría alerta' : '? Bloqueado por cooldown'}
          </span>
        </div>
      `).join('');

      // Crear modal de resultados si no existe
      let resultModal = $('#supRuleSimulateResult');
      if (!resultModal) {
        resultModal = document.createElement('div');
        resultModal.id = 'supRuleSimulateResult';
        resultModal.className = 'admin-modal';
        resultModal.innerHTML = `
          <div class="modal-box" style="max-width:500px;">
            <h3 style="font-family:var(--font-heading); font-size:22px; color:#fff; margin-bottom:18px;">Resultado de Simulación</h3>
            <div id="supSimulateResultContent" style="max-height:300px; overflow-y:auto;"></div>
            <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:24px;">
              <button type="button" class="status-pill pending modal-close-btn" onclick="closeModal('supRuleSimulateResult')">Cerrar</button>
            </div>
          </div>
        `;
        document.body.appendChild(resultModal);
      }
      $('#supSimulateResultContent').innerHTML = `
        <div style="margin-bottom:16px; padding:12px; background:rgba(31,200,195,0.1); border-radius:8px; border:1px solid rgba(31,200,195,0.3);">
          <div style="font-weight:600; color:var(--accent);">Regla: ${esc(name)}</div>
          <div style="font-size:12px; color:var(--text-secondary);">Módulo: ${esc(module || 'todos')} | Acción: ${esc(action || 'todas')} | Ventana: ${esc(v_window)} | Umbral: > ${v_threshold}</div>
          <div style="font-size:12px; color:var(--text-secondary);">Cooldown: ${cooldown} min | ${matches.length} usuario(s) superan umbral</div>
        </div>
        ${resultHtml}
      `;
      openModal('supRuleSimulateResult');

    } catch (err) {
      logError('simulateSupRule error:', err);
      showToast('Error en simulación: ' + err.message, 'error');
    } finally {
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
  };

  // Helper: parse interval string like "1 hour", "10 minutes", "24 hours" to ms
  function parseInterval(str) {
    const m = String(str).match(/^(\d+)\s*(hour|hours|minute|minutes|day|days)$/i);
    if (!m) return 3600000; // default 1 hour
    const val = parseInt(m[1]);
    const unit = m[2].toLowerCase();
    if (unit.startsWith('hour')) return val * 3600000;
    if (unit.startsWith('minute')) return val * 60000;
    if (unit.startsWith('day')) return val * 86400000;
    return 3600000;
  }

  on($('#supRuleForm'), 'submit', async (e) => {
    e.preventDefault();
    if (!window.supabaseClient) return;
    const fd = new FormData(e.target);
    const id = fd.get('id');
    const payload = {
      name: fd.get('name'),
      description: fd.get('description'),
      module: fd.get('module') || null,
      action: fd.get('action') || null,
      event_type: fd.get('event_type') || null,
      severity: fd.get('severity'),
      threshold: parseInt(fd.get('threshold')) || 0,
      window: fd.get('window'),
      cooldown_minutes: parseInt(fd.get('cooldown_minutes')) || 0,
      enabled: fd.get('enabled') === 'on',
      filter_json: fd.get('filter_json') ? JSON.parse(fd.get('filter_json')) : null,
      updated_at: new Date().toISOString()
    };
    try {
      if (id) {
        await window.supabaseClient.from('supervision_rules').update(payload).eq('id', id);
      } else {
        await window.supabaseClient.from('supervision_rules').insert({ ...payload, created_at: new Date().toISOString() });
      }
      closeModal('supRuleModal');
      showToast(id ? 'Regla actualizada' : 'Regla creada', 'success');
      loadSupRulesTable();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  });

  function exportSupervisionCSV() {
    if (!window.supabaseClient) return;
    // Export current view data - for now export audit_log
    window.supabaseClient.from('audit_log').select('*').order('created_at', { ascending: false }).limit(1000).then(({ data, error }) => {
      if (error) { showToast('Error: ' + error.message, 'error'); return; }
      const headers = ['ID', 'Usuario', 'Rol', 'Módulo', 'Acción', 'Entidad', 'ID Entidad', 'Severidad', 'IP', 'Request ID', 'Metadata', 'Creado'];
      const rows = (data || []).map(r => [r.id, r.user_id, r.user_role, r.module, r.action, r.entity_type, r.entity_id, r.severity, r.ip_address, r.request_id, JSON.stringify(r.metadata || {}), r.created_at]);
      downloadCSV('supervision-audit-' + new Date().toISOString().slice(0, 10) + '.csv', rows, headers);
      showToast('Auditoría exportada (' + rows.length + ' filas)', 'success');
    });
  }

  function exportSupOverviewCSV() {
    if (!window.supabaseClient) return;
    // Export KPIs + rankings from overview
    const kpis = {};
    ['kpiActiveUsers','kpiActionsToday','kpiSuccess','kpiErrors','kpiSensitive','kpiOpenAlerts','kpiCriticalAlerts','kpiExports','kpiBulkOps'].forEach(id => {
      const el = $('#' + id);
      if (el) kpis[id] = el.textContent;
    });
    const rankings = {};
    ['rankingUsers','rankingModules','rankingErrors','rankingSensitive'].forEach(id => {
      const el = $('#' + id);
      if (el) rankings[id] = el.textContent;
    });
    const date = new Date().toISOString().slice(0, 10);
    // KPIs CSV
    const kpiHeaders = ['KPI', 'Valor'];
    const kpiRows = Object.entries(kpis).map(([k, v]) => [k, v]);
    downloadCSV('supervision-resumen-kpis-' + date + '.csv', kpiRows, kpiHeaders);
    // Rankings CSV (combined)
    const rankHeaders = ['Ranking', 'Detalle'];
    const rankRows = Object.entries(rankings).map(([k, v]) => [k, v]);
    downloadCSV('supervision-resumen-rankings-' + date + '.csv', rankRows, rankHeaders);
    showToast('Resumen supervisión exportado (KPIs + Rankings)', 'success');
  }
  window.exportSupOverviewCSV = exportSupOverviewCSV;

  function fichaFieldVal(id) {
    const el = $('#' + id);
    return el ? el.value.trim() : '';
  }

  function fichaHighlightLastWord(text) {
    const clean = String(text || '').trim() || 'Propiedad disponible';
    const parts = clean.split(/\s+/);
    if (parts.length === 1) return esc(clean);
    const last = parts.pop();
    return `${esc(parts.join(' '))} <span>${esc(last)}</span>`;
  }

  function fichaRenderPhotos() {
    const cover = $('#fichaCoverPhoto');
    const grid = $('#fichaPhotoGrid');
    if (!cover || !grid) return;
    cover.innerHTML = '';
    if (_fichaPhotos[0]) {
      const img = document.createElement('img');
      img.src = _fichaPhotos[0];
      img.alt = 'Foto principal de la propiedad';
      cover.appendChild(img);
    } else {
      cover.textContent = 'Foto principal';
    }
    grid.innerHTML = '';
    const secondary = _fichaPhotos.slice(1);
    const slots = Math.max(3, secondary.length);
    for (let i = 0; i < slots; i += 1) {
      const tile = document.createElement('div');
      tile.className = 'ficha-photo';
      if (secondary[i]) {
        const img = document.createElement('img');
        img.src = secondary[i];
        img.alt = `Foto ${i + 2} de la propiedad`;
        tile.appendChild(img);
      } else {
        tile.textContent = `Foto ${i + 2}`;
      }
      grid.appendChild(tile);
    }
  }

  function fichaUpdatePreview() {
    const titleEl = $('#fichaPreviewTitle');
    if (!titleEl) return;
    titleEl.innerHTML = fichaHighlightLastWord(fichaFieldVal('fichaTitle'));
    $('#fichaPreviewLocation').textContent = fichaFieldVal('fichaLocation') || 'A confirmar';
    $('#fichaPreviewPrice').textContent = fichaFieldVal('fichaPrice') || 'Consultar';
    $('#fichaPreviewRooms').textContent = fichaFieldVal('fichaRooms') || 'A confirmar';
    $('#fichaPreviewSurface').textContent = fichaFieldVal('fichaSurface') || 'A confirmar';
    $('#fichaPreviewDescription').textContent = fichaFieldVal('fichaDescription') || 'Sin descripción cargada.';
    $('#fichaPreviewContact').textContent = fichaFieldVal('fichaContact') || 'Contacto a confirmar';
    fichaRenderPhotos();
  }

  function fichaHideSuggestions() {
    const box = $('#fichaSuggestions');
    if (!box) return;
    box.innerHTML = '';
    box.style.display = 'none';
  }

  function fichaRenderSuggestions(rawQuery) {
    const box = $('#fichaSuggestions');
    if (!box) return;
    const q = String(rawQuery || '').toLowerCase().trim();
    if (!q) { fichaHideSuggestions(); return; }
    const matches = _fichaPropsCache.filter(p => [p.title, p.property_code, p.zone].some(f => f && String(f).toLowerCase().includes(q))).slice(0, 8);
    box.innerHTML = matches.length
      ? matches.map(p => `
        <button type="button" class="ficha-suggestion" data-prop-id="${esc(p.id)}">
          <strong>${esc(p.title || 'Sin título')}</strong>
          <small>${esc([p.property_code, p.zone].filter(Boolean).join(' · ') || 'Sin código')}</small>
        </button>`).join('')
      : '<div class="ficha-suggestion-empty">Sin resultados en el CRM</div>';
    box.style.display = 'block';
  }

  function fillFichaFromProperty(p) {
    const set = (id, val) => { const el = $('#' + id); if (el) el.value = val; };
    set('fichaTitle', p.title || '');
    set('fichaLocation', [p.zone, p.address].filter(Boolean).join(', '));
    set('fichaPrice', p.price_usd != null ? formatPrice(p.price_usd, p.price_currency) : 'Consultar');
    set('fichaRooms', p.rooms != null ? String(p.rooms) : '');
    set('fichaSurface', p.area_m2 != null ? `${p.area_m2} m²` : '');
    set('fichaDescription', p.description || '');
    const agent = _fichaAgentsCache.find(a => a.id === p.agent_id);
    set('fichaContact', agent ? [agent.full_name, agent.phone || agent.email].filter(Boolean).join(' · ') : '');
    _fichaPhotos = Array.isArray(p.image_urls) ? p.image_urls.filter(Boolean).slice() : [];
    fichaUpdatePreview();
  }

  function fichaGetShareText() {
    return [
      fichaFieldVal('fichaTitle') || 'Propiedad disponible',
      `Ubicación: ${fichaFieldVal('fichaLocation') || 'A confirmar'}`,
      `Precio: ${fichaFieldVal('fichaPrice') || 'Consultar'}`,
      `Ambientes: ${fichaFieldVal('fichaRooms') || 'A confirmar'}`,
      `Superficie: ${fichaFieldVal('fichaSurface') || 'A confirmar'}`,
      '',
      fichaFieldVal('fichaDescription') || 'Sin descripción cargada.',
      '',
      `Contacto: ${fichaFieldVal('fichaContact') || 'A confirmar'}`
    ].join('\n');
  }

  async function fichaShareText() {
    const text = fichaGetShareText();
    if (navigator.share) {
      try {
        await navigator.share({ title: fichaFieldVal('fichaTitle') || 'Propiedad Bienenhaus', text });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast('Texto copiado para reenviar', 'success');
    } catch (err) {
      showToast('No se pudo copiar el texto', 'error');
    }
  }

  function fichaSlug(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'propiedad';
  }

  function fichaDownloadHtml() {
    const blob = new Blob([fichaBuildStaticHtml()], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ficha-${fichaSlug($('#fichaTitle')?.value)}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('Ficha descargada como HTML autocontenido', 'success');
  }

  function fichaBuildStaticHtml() {
    const titleRaw = ($('#fichaTitle')?.value || '').trim() || 'Propiedad disponible';
    const coverSrc = _fichaPhotos[0] || '';
    const coverHtml = coverSrc
      ? `<img src="${esc(coverSrc)}" alt="Foto principal de la propiedad">`
      : 'Foto principal';
    const gridHtml = _fichaPhotos.slice(1)
      .map((src, i) => `<div class="ficha-photo"><img src="${esc(src)}" alt="Foto ${i + 2} de la propiedad"></div>`)
      .join('');
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(titleRaw)} | Bienenhaus</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f4f4f2;color:#111;font-family:Arial,Helvetica,sans-serif;padding:36px 16px}
.ficha-sheet{width:min(920px,100%);margin:0 auto;background:#fff;color:#000;box-shadow:0 18px 50px rgba(0,0,0,.28)}
.ficha-sheet-hero{background:#000;color:#fff;padding:34px 38px 32px;position:relative;overflow:hidden}
.ficha-sheet-hero::before{content:"";position:absolute;left:30px;bottom:28px;width:4px;height:100px;background:#14b8a6}
.ficha-sheet-hero::after{content:"";position:absolute;right:34px;top:34px;width:250px;height:4px;background:#14b8a6}
.ficha-kicker{color:#14b8a6;font-weight:900;text-transform:uppercase;letter-spacing:1.5px;font-size:15px;margin-bottom:12px}
.ficha-sheet-title{margin:0;font-size:clamp(34px,6vw,68px);line-height:.95;text-transform:uppercase;max-width:760px;word-break:break-word}
.ficha-sheet-title span{color:#14b8a6}
.ficha-sheet-body{padding:28px 34px 34px}
.ficha-photo-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:24px}
.ficha-photo{background:#e8e8e4;aspect-ratio:4/3;min-height:120px;display:flex;align-items:center;justify-content:center;color:#555;font-weight:800;text-transform:uppercase;letter-spacing:.8px;overflow:hidden}
.ficha-cover-photo{min-height:430px;aspect-ratio:16/9;margin-bottom:24px}
.ficha-photo img{width:100%;height:100%;object-fit:cover;display:block}
.ficha-content-grid{display:grid;grid-template-columns:1fr;gap:26px;margin-top:26px}
.ficha-description h2,.ficha-data-card h2{margin:0 0 12px;font-size:18px;text-transform:uppercase;letter-spacing:1px}
.ficha-description p{margin:0;white-space:pre-wrap;line-height:1.55;color:#222}
.ficha-data-card{background:#000;color:#fff;padding:22px;border-radius:6px;display:grid;grid-template-columns:repeat(4,1fr);gap:0 18px}
.ficha-data-card h2{grid-column:1/-1}
.ficha-detail{display:grid;gap:4px;padding:11px 0;border-bottom:1px solid #282828}
.ficha-detail:last-child{border-bottom:0}
.ficha-detail strong{color:#2dd4bf;text-transform:uppercase;font-size:12px;letter-spacing:.7px}
.ficha-detail span{overflow-wrap:anywhere}
.ficha-contact-band{margin-top:26px;background:#f4f4f2;padding:22px 26px;display:grid;grid-template-columns:1fr auto;gap:20px;align-items:end}
.ficha-contact-band h2{margin:0 0 10px;text-transform:uppercase;font-size:22px}
.ficha-contact-list{display:grid;gap:7px;font-weight:800}
.ficha-short-logo{font-weight:900;letter-spacing:-2px;font-size:32px}
.ficha-footer-hero{background:#000;color:#fff;padding:40px 38px 46px;position:relative;overflow:hidden}
.ficha-footer-arrow{position:absolute;top:26px;right:34px;line-height:0}
.ficha-footer-arrow svg{width:170px;height:14px;display:block}
.ficha-footer-headline{margin:30px 0 0;font-size:clamp(26px,4.6vw,44px);line-height:1.08;text-transform:uppercase;font-weight:900;min-height:2.3em;max-width:640px;transition:opacity .35s ease}
.ficha-footer-headline.is-fading{opacity:0}
.ficha-footer-headline span{color:#14b8a6}
.ficha-footer-contact{background:#fff;color:#000;padding:34px 38px}
.ficha-footer-contact h3{margin:0 0 20px;font-size:19px;text-transform:uppercase;letter-spacing:.4px;font-weight:900}
.ficha-footer-contact-list{display:grid;gap:16px}
.ficha-footer-contact-item{display:flex;align-items:center;gap:14px;font-weight:800;font-size:16px;overflow-wrap:anywhere}
.ficha-footer-contact-item svg{flex:none;width:28px;height:28px}
.ficha-footer-brand{background:#000;color:#fff;padding:42px 38px 40px;text-align:center;position:relative;overflow:hidden}
.ficha-footer-brand-arrow{position:absolute;bottom:30px;left:38px;line-height:0}
.ficha-footer-brand-arrow svg{width:14px;height:74px;display:block}
.ficha-footer-bh{font-weight:900;letter-spacing:-3px;font-size:42px;line-height:.85}
.ficha-footer-brand-name{margin-top:12px;font-weight:900;letter-spacing:3px;text-transform:uppercase;font-size:19px}
.ficha-footer-brand-sub{margin-top:5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-size:11.5px;color:#2dd4bf}
@media(max-width:680px){body{padding:12px 8px}.ficha-sheet-hero,.ficha-sheet-body{padding-left:22px;padding-right:22px}.ficha-sheet-hero::before,.ficha-sheet-hero::after{display:none}.ficha-cover-photo{min-height:240px}.ficha-photo-grid{grid-template-columns:repeat(2,1fr)}.ficha-data-card{grid-template-columns:1fr 1fr}.ficha-contact-band{grid-template-columns:1fr}.ficha-footer-hero,.ficha-footer-contact,.ficha-footer-brand{padding-left:22px;padding-right:22px}.ficha-footer-arrow,.ficha-footer-brand-arrow{display:none}}
@media print{@page{margin:12mm}body{background:#fff;padding:0}.ficha-sheet{width:100%;box-shadow:none}.ficha-sheet-hero,.ficha-footer-hero,.ficha-footer-brand{background:#fff;color:#000}.ficha-sheet-hero::before,.ficha-sheet-hero::after{print-color-adjust:exact;-webkit-print-color-adjust:exact}.ficha-kicker,.ficha-sheet-title span,.ficha-footer-headline span,.ficha-footer-brand-sub{color:#0f766e}.ficha-detail strong{color:#0f766e}.ficha-contact-band{background:#fff;border-top:2px solid #14b8a6}.ficha-photo{border:1px solid #e5e5e2}.ficha-photo-grid{grid-template-columns:repeat(3,1fr);gap:14px}.ficha-site-footer{break-inside:avoid}.ficha-footer-hero,.ficha-footer-contact,.ficha-footer-brand{page-break-inside:avoid}}
</style>
</head>
<body>
<article class="ficha-sheet">
<section class="ficha-sheet-hero">
<div class="ficha-kicker">Bienenhaus propiedades</div>
<h1 class="ficha-sheet-title">${fichaHighlightLastWord(titleRaw)}</h1>
</section>
<section class="ficha-sheet-body">
<div class="ficha-photo ficha-cover-photo">${coverHtml}</div>
<div class="ficha-photo-grid">${gridHtml}</div>
<div class="ficha-content-grid">
<div class="ficha-description">
<h2>Descripción</h2>
<p>${esc(fichaFieldVal('fichaDescription') || 'Sin descripción cargada.')}</p>
</div>
<div class="ficha-data-card">
<h2>Detalles</h2>
<div class="ficha-detail"><strong>Ubicación</strong><span>${esc(fichaFieldVal('fichaLocation') || 'A confirmar')}</span></div>
<div class="ficha-detail"><strong>Precio</strong><span>${esc(fichaFieldVal('fichaPrice') || 'Consultar')}</span></div>
<div class="ficha-detail"><strong>Ambientes</strong><span>${esc(fichaFieldVal('fichaRooms') || 'A confirmar')}</span></div>
<div class="ficha-detail"><strong>Superficie</strong><span>${esc(fichaFieldVal('fichaSurface') || 'A confirmar')}</span></div>
</div>
</div>
<div class="ficha-contact-band">
<div>
<h2>Contacto</h2>
<div class="ficha-contact-list">${esc(fichaFieldVal('fichaContact') || 'Contacto a confirmar')}</div>
</div>
<div class="ficha-short-logo">BH</div>
</div>
</section>
<footer class="ficha-site-footer">
<section class="ficha-footer-hero">
<div class="ficha-footer-arrow" aria-hidden="true"><svg viewBox="0 0 200 16" xmlns="http://www.w3.org/2000/svg"><path d="M2 8h190" stroke="#14b8a6" stroke-width="3" stroke-linecap="round"/><path d="M15 1L2 8l13 7" stroke="#14b8a6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div>
<h2 class="ficha-footer-headline" id="footerHeadline"></h2>
</section>
<section class="ficha-footer-contact">
<h3>Contáctanos y te asesoramos</h3>
<div class="ficha-footer-contact-list">
<div class="ficha-footer-contact-item"><svg viewBox="0 0 24 24" fill="#101010" xmlns="http://www.w3.org/2000/svg"><path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.23.2 2.23.2v2.45h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99A10 10 0 0 0 22 12Z"/></svg><span>Bienenhaus.prop</span></div>
<div class="ficha-footer-contact-item"><svg viewBox="0 0 24 24" fill="none" stroke="#101010" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.1" fill="#101010" stroke="none"/></svg><span>bienenhaus.prop</span></div>
<div class="ficha-footer-contact-item"><svg viewBox="0 0 24 24" fill="none" stroke="#101010" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M3.5 6.5 12 13l8.5-6.5"/></svg><span>bienenhaus.propiedades@gmail.com</span></div>
</div>
</section>
<section class="ficha-footer-brand">
<div class="ficha-footer-brand-arrow" aria-hidden="true"><svg viewBox="0 0 16 100" xmlns="http://www.w3.org/2000/svg"><path d="M8 98V12" stroke="#14b8a6" stroke-width="3" stroke-linecap="round"/><path d="M1 25L8 12l7 13" stroke="#14b8a6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div>
<div class="ficha-footer-bh">BH</div>
<div class="ficha-footer-brand-name">Bienenhaus</div>
<div class="ficha-footer-brand-sub">Propiedades &middot; CPI. 1.834</div>
</section>
</footer>
</article>
<script>
(function(){
var messages=[["¿Querés ","vender"," tu propiedad?"],["¿Querés ","comprar"," tu próxima casa?"],["¿Buscás ","alquilar"," rápido y sin vueltas?"],["¿Necesitás ","tasar"," tu propiedad?"]];
var el=document.getElementById("footerHeadline");
if(!el)return;
var i=0;
function render(){el.innerHTML=messages[i][0]+"<span>"+messages[i][1]+"</span>"+messages[i][2];}
render();
setInterval(function(){el.classList.add("is-fading");setTimeout(function(){i=(i+1)%messages.length;render();el.classList.remove("is-fading");},350);},3800);
})();
</script>
</body>
</html>`;
  }

  function startFichaFooterRotator() {
    const headline = $('#fichaFooterHeadline');
    if (!headline || _fichaFooterTimer) return;
    let index = 0;
    const render = () => {
      const m = FICHA_FOOTER_MESSAGES[index];
      headline.innerHTML = `${esc(m.before)}<span>${esc(m.highlight)}</span>${esc(m.after)}`;
    };
    render();
    _fichaFooterTimer = setInterval(() => {
      headline.classList.add('is-fading');
      setTimeout(() => {
        index = (index + 1) % FICHA_FOOTER_MESSAGES.length;
        render();
        headline.classList.remove('is-fading');
      }, 350);
    }, 3800);
  }

  on($('#fichaPropertySearch'), 'input', e => fichaRenderSuggestions(e.target.value));
  on($('#fichaPropertySearch'), 'blur', () => setTimeout(fichaHideSuggestions, 150));
  on($('#fichaSuggestions'), 'mousedown', e => {
    const btn = e.target.closest('.ficha-suggestion');
    if (!btn) return;
    e.preventDefault();
    const prop = _fichaPropsCache.find(p => p.id === btn.dataset.propId);
    if (prop) {
      fillFichaFromProperty(prop);
      const search = $('#fichaPropertySearch');
      if (search) search.value = prop.title || '';
    }
    fichaHideSuggestions();
  });

  ['fichaTitle', 'fichaLocation', 'fichaPrice', 'fichaRooms', 'fichaSurface', 'fichaDescription', 'fichaContact'].forEach(id => {
    $('#' + id)?.addEventListener('input', fichaUpdatePreview);
  });

  $('#fichaPhotos')?.addEventListener('change', e => {
    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    Promise.all(files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ url: String(reader.result), file });
      reader.onerror = reject;
      reader.readAsDataURL(file);
    }))).then(results => {
      _fichaPhotos = _fichaPhotos.concat(results.map(r => r.url));
      fichaUpdatePreview();
      renderFichaFilePreviews(results.map(r => r.url));
    }).catch(err => {
      logError('Ficha fotos:', err);
      showToast('No se pudieron cargar las fotos', 'error');
    });
  });

  const fichaFileBox = $('.ficha-file-box');
  if (fichaFileBox) {
    ['dragenter', 'dragover'].forEach(ev => {
      on(fichaFileBox, ev, e => { e.preventDefault(); e.stopPropagation(); fichaFileBox.classList.add('is-dragover'); });
    });
    ['dragleave', 'drop'].forEach(ev => {
      on(fichaFileBox, ev, e => { e.preventDefault(); e.stopPropagation(); fichaFileBox.classList.remove('is-dragover'); });
    });
    on(fichaFileBox, 'drop', e => {
      const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'));
      if (files.length) {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        const input = $('#fichaPhotos');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    on(fichaFileBox, 'click', e => {
      if (e.target === fichaFileBox || e.target.closest('.file-icon') || e.target.closest('.file-text') || e.target.closest('.file-sub')) {
        $('#fichaPhotos')?.click();
      }
    });
  }

  function renderFichaFilePreviews(urls) {
    const preview = $('#fichaFilePreview');
    if (!preview) return;
    preview.innerHTML = urls.map((url, i) => `
      <div class="ficha-file-preview-item" data-index="${i}">
        <img src="${url}" alt="Preview ${i + 1}" />
        <button type="button" class="remove" aria-label="Eliminar foto"><i class="fas fa-times"></i></button>
      </div>
    `).join('');
    preview.querySelectorAll('.remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const idx = parseInt(btn.closest('.ficha-file-preview-item').dataset.index, 10);
        _fichaPhotos.splice(idx, 1);
        fichaUpdatePreview();
        renderFichaFilePreviews(_fichaPhotos);
      });
    });
  }

  $('#fichaForm')?.addEventListener('reset', () => {
    setTimeout(() => {
      _fichaPhotos = [];
      fichaUpdatePreview();
      const preview = $('#fichaFilePreview');
      if (preview) preview.innerHTML = '';
    }, 0);
  });

  $('#fichaShareBtn')?.addEventListener('click', () => { fichaShareText(); });
  $('#fichaPrintBtn')?.addEventListener('click', () => window.print());
  $('#fichaDownloadBtn')?.addEventListener('click', fichaDownloadHtml);

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
          setTimeout(async () => { await mlCheckStatus(); loadPortals(); navigateTo('tab-portales'); }, 100);
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
    const _origLoadProperties = loadProperties;
    loadProperties = function () { invalidateSearchCache(); return _origLoadProperties.apply(this, arguments); };

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



