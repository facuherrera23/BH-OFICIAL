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
  let _submittingAgent = false;
  let _submittingOwner = false;
  let _submittingPortal = false;

  /* Pagination state */
  let _propPage = 1;
  let _propPageSize = 25;
  let _propTotalCount = 0;
  let _crmPage = 1;
  let _crmPageSize = 25;
  let _crmTotalCount = 0;
  let _visitsPage = 1;
  let _visitsPageSize = 25;
  let _visitsTotalCount = 0;
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
    video_url: z.string().url('URL de video inválida').optional().nullable(),
    is_published: z.boolean().default(false),
    featured: z.boolean().default(false),
    is_retasada: z.boolean().default(false),
    is_oportunidad: z.boolean().default(false),
    is_shared: z.boolean().default(false),
    is_vendida: z.boolean().default(false),
    is_reservada: z.boolean().default(false),
    owner_id: z.string().uuid('ID de propietario inválido').optional().nullable(),
    agent_id: z.string().uuid('ID de broker inválido').optional().nullable(),
  });

  // Lead validation
  const LeadSchema = z.object({
    full_name: z.string().min(2, 'Nombre completo requerido').max(100, 'Máximo 100 caracteres'),
    email: z.string().email('Email inválido').max(150).optional().nullable(),
    phone: z.string().max(30).optional().nullable(),
    whatsapp: z.string().max(30).optional().nullable(),
    source: z.enum(['landing', 'ml', 'chat', 'referido', 'tasacion', 'walkin', 'manual']).default('manual'),
    stage: z.enum(['nuevo', 'contactado', 'visita', 'oferta', 'cerrado', 'perdido']).default('nuevo'),
    property_id: z.string().uuid('ID de propiedad inválido').optional().nullable(),
    assigned_to: z.string().uuid('ID de broker inválido').optional().nullable(),
    budget_usd: z.number().min(0).max(10000000).default(0),
    preferred_zone: z.string().max(80).optional().nullable(),
    preferred_type: z.string().max(50).optional().nullable(),
    preferred_rooms: z.number().int().min(0).max(20).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  });

  // Visit validation
  const VisitSchema = z.object({
    lead_id: z.string().uuid('ID de lead inválido').optional().nullable(),
    property_id: z.string().uuid('Seleccioná una propiedad'),
    agent_id: z.string().uuid('ID de broker inválido').optional().nullable(),
    client_name: z.string().min(2, 'Nombre del cliente requerido').max(100),
    client_phone: z.string().max(30).optional().nullable(),
    client_email: z.string().email('Email inválido').max(150).optional().nullable(),
    visit_date: z.string().transform(v => v.length === 16 ? v + ':00' : v).pipe(z.string().datetime({ offset: false, message: 'Fecha de visita inválida' })),
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
    const shape = typeof schema.shape === 'object' ? schema.shape : {};

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
      const { data, error } = await client
        .from('profiles')
        .select('*')
        .eq('id', currentUser.id)
        .single();
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
      currentProfile = null;
      window._bhCurrentProfile = null;
      showToast('No se pudieron cargar los permisos. Acceso denegado.', 'error');
      setTimeout(() => { window.supabaseClient.auth.signOut(); }, 2000);
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
      'tab-agenda': 'Agenda de Visitas',
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
      'tab-agenda': loadVisits,
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
      const [propsRes, leadsRes, visitsRes, agentsRes] = await Promise.all([
        client.from('properties').select('price_usd, price_currency, zone, status, is_published, created_at, updated_at'),
        client.from('leads').select('stage, created_at'),
        client.from('visits').select('*').order('visit_date', { ascending: true }).limit(5),
        client.from('agents').select('*').eq('status', 'activo').is('deleted_at', null),
      ]);

      const props = propsRes.data || [];
      const leads = leadsRes.data || [];
      const visits = visitsRes.data || [];
      const agents = agentsRes.data || [];

      /* KPIs */
      const propsVenta = props.filter(p => p.status === 'venta' || (!p.status && (p.price_currency || 'USD') === 'USD'));
      const propsAlquiler = props.filter(p => p.status === 'alquiler' || p.price_currency === 'ARS');
      const volumenVenta = propsVenta.reduce((sum, p) => sum + (p.price_usd || 0), 0);
      const volumenAlquiler = propsAlquiler.reduce((sum, p) => sum + (p.price_usd || 0), 0);
      const activeProps = props.filter(p => p.is_published && p.status !== 'vendido' && p.status !== 'alquilado').length;
      const activeLeads = leads.filter(l => !['cerrado', 'perdido'].includes(l.stage)).length;
      const upcomingVisits = visits.filter(v => v.status === 'pendiente' || v.status === 'confirmada').length;

      setKPI('kpiVolumenVenta', formatPrice(volumenVenta, 'USD'));
      setKPI('kpiVolumenAlquiler', formatPrice(volumenAlquiler, 'ARS'));
      setKPI('kpiActivas', activeProps);
      setKPI('kpiLeads', activeLeads);
      setKPI('kpiVisitas', upcomingVisits);
      setKPI('kpiBrokers', agents.length);

      /* Zone progress */
      renderZoneProgress(props);
      renderConsultasVentasChart(props, leads);

      /* Dashboard widgets */
      renderDashVisits(visits);
      renderDashLeads(leads);
      renderDashBrokers(agents);
    } catch (err) {
      logError('Dashboard error:', err);
    }
  }

  function setKPI(id, value) {
    const el = $(`#${id}`);
    if (el) el.textContent = typeof value === 'number' ? value.toLocaleString('es-AR') : value;
  }

  function renderConsultasVentasChart(props, leads) {
    const container = $('#consultasVentasChart');
    if (!container) return;

    const now = new Date();
    const year = now.getFullYear();
    const pill = $('#chartYearPill');
    if (pill) pill.innerHTML = '<i class="fas fa-calendar"></i> ' + year;

    const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const months = [];
    for (let m = 0; m <= now.getMonth(); m++) months.push(m);

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

    const max = Math.max(...entries.map(e => e[1]));
    container.innerHTML = entries.slice(0, 6).map(([zone, count]) => {
      const pct = Math.round((count / max) * 100);
      return `
        <div style="display:flex; align-items:center; gap:12px; padding:10px 0; border-bottom:1px solid var(--border-subtle);">
          <span style="color:var(--text-secondary); font-size:13px; min-width:120px;">${esc(zone)}</span>
          <div style="flex:1; height:6px; background:rgba(255,255,255,0.05); border-radius:99px; overflow:hidden;">
            <div style="height:100%; width:${pct}%; background:linear-gradient(90deg, var(--accent), var(--glow)); border-radius:99px;"></div>
          </div>
          <span style="color:var(--accent); font-size:13px; font-weight:600; min-width:30px; text-align:right;">${count}</span>
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
      <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border-subtle);">
        <div>
          <div style="color:#fff; font-size:13px; font-weight:500;">${esc(v.client_name || 'Sin cliente')}</div>
          <div style="color:var(--text-dim); font-size:11px;">${v.visit_date ? new Date(v.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'}</div>
        </div>
        <span class="nav-badge" style="background:${v.status === 'confirmada' ? 'rgba(0,200,120,0.15)' : 'rgba(255,184,0,0.15)'}; color:${v.status === 'confirmada' ? 'var(--success)' : 'var(--warning)'}; font-size:11px;">${esc(v.status || 'pendiente')}</span>
      </div>
    `).join('');
  }

  function renderDashLeads(leads) {
    const el = $('#dashLeadsList');
    if (!el) return;
    const hot = leads.filter(l => ['contactado', 'visita', 'oferta'].includes(l.stage)).slice(0, 4);
    if (!hot.length) {
      el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; padding:16px 0;">Sin leads registrados</p>';
      return;
    }
    const stageColors = { contactado: '#3B82F6', visita: '#FFB800', oferta: 'var(--accent)' };
    el.innerHTML = hot.map(l => `
      <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border-subtle);">
        <div>
          <div style="color:#fff; font-size:13px; font-weight:500;">${esc(l.full_name || 'Sin nombre')}</div>
          <div style="color:var(--text-dim); font-size:11px;">${l.budget_usd ? 'USD ' + l.budget_usd.toLocaleString('es-AR') : 'Sin presupuesto'}</div>
        </div>
        <span class="nav-badge" style="background:${stageColors[l.stage] || 'rgba(255,255,255,0.1)'}; color:#fff; font-size:11px;">${esc(l.stage || 'nuevo')}</span>
      </div>
    `).join('');
  }

  function renderDashBrokers(agents) {
    const el = $('#dashBrokersList');
    if (!el) return;
    const sorted = agents.toSorted((a, b) => (b.sales_ytd || 0) - (a.sales_ytd || 0)).slice(0, 4);
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
      // Get total count for pagination
      const { count: totalCount, error: countError } = await client
        .from('properties')
        .select('*', { count: 'exact', head: true });
      if (countError) throw countError;
      _propTotalCount = totalCount || 0;
      console.log('[loadProperties] Total count:', _propTotalCount);

      const from = (_propPage - 1) * _propPageSize;
      const to = from + _propPageSize - 1;

      const [propsRes, listingsRes, ownersRes, relaRes] = await Promise.all([
        client.from('properties').select('*').order('created_at', { ascending: false }).range(from, to),
        ml_connected
          ? client.from('ml_listings').select('property_id, ml_listing_id, status')
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
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--text-dim);">No hay propiedades cargadas</td></tr>';
        return;
      }

      tbody.innerHTML = data.map(p => {
        const thumb = p.image_urls?.[0] || 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=200&q=60&fit=crop';
        const loc = [p.zone, p.address].filter(Boolean).join(', ');
        const mlInfo = mlMap[p.id];
        let mlBadge = '';
        let mlButtons = '';

        if (mlInfo) {
          const mlStatusColor = mlInfo.status === 'active' ? 'var(--success)' : mlInfo.status === 'paused' ? 'var(--warning)' : 'var(--text-dim)';
          const mlStatusText = esc(mlInfo.status === 'active' ? 'En ML' : mlInfo.status === 'paused' ? 'Pausado' : mlInfo.status || 'ML');
          mlBadge = `<span class="nav-badge status-pill ${mlInfo.status === 'active' ? 'active' : 'paused'}" style="font-size:10px; margin-left:4px;">${mlStatusText}</span>`;
          /* Security: ml_listing_id es texto externo (API de ML): viaja en data-* + delegacion, NUNCA dentro de onclick */
          mlButtons = `
              <button class="btn-action" style="font-size:11px; color:#FFE600;" title="Actualizar en ML" data-ml-update-prop="${esc(p.id)}" data-ml-listing="${esc(mlInfo.ml_listing_id)}"><i class="fas fa-arrows-rotate"></i></button>
              <button class="btn-action danger" style="font-size:11px;" title="Quitar de ML" data-ml-remove data-ml-listing="${esc(mlInfo.ml_listing_id)}"><i class="fas fa-link-slash"></i></button>`;
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
          ? `<span style="font-family:monospace; font-size:12px; font-weight:600; color:var(--accent); background:rgba(31,200,195,0.1); padding:2px 6px; border-radius:4px;">${esc(p.property_code)}</span>`
          : '<span style="color:var(--text-dim); font-size:11px;">—</span>';

        return `
        <tr>
          <td>${codeBadge}</td>
          <td>
            <div style="display:flex; align-items:center; gap:12px;">
              <img src="${esc(thumb)}" alt="${esc(p.title || '')}" style="width:52px; height:52px; border-radius:var(--radius-sm); object-fit:cover; border:1px solid var(--border-subtle);" />
              <div>
                <div style="font-weight:600; color:#fff; font-size:13.5px;">${esc(p.title || 'Sin título')}${mlBadge}${relaBadge}</div>
                <div style="color:var(--text-dim); font-size:12px; margin-top:2px;"><i class="fas fa-location-dot" style="margin-right:4px;"></i>${esc(loc || 'Sin ubicación')}</div>
              </div>
            </div>
          </td>
          <td style="font-size:13px;">${p.area_m2 ? p.area_m2 + ' m²' : '-'}</td>
          <td style="font-size:13px;">${p.rooms || '-'}</td>
          <td style="font-weight:600; color:var(--accent); font-size:13.5px;">${formatPrice(p.price_usd, p.price_currency)}</td>
          <td><span class="nav-badge" style="background:${p.status === 'venta' ? 'rgba(31,200,195,0.15)' : 'rgba(255,184,0,0.15)'}; color:${p.status === 'venta' ? 'var(--accent)' : 'var(--warning)'}; font-size:11px;">${esc(p.status || 'venta')}</span></td>
          <td style="font-size:12px; color:${p.owner_id ? '#fff' : 'var(--text-dim)'};">${esc(ownerMap[p.owner_id] || '—')}</td>
          <td>
              <div style="display:flex; gap:4px; flex-wrap:wrap;">
                <span class="nav-badge" style="background:${p.is_published ? 'rgba(0,200,120,0.15)' : 'rgba(255,255,255,0.06)'}; color:${p.is_published ? 'var(--success)' : 'var(--text-dim)'}; font-size:11px;">${p.is_published ? 'Publicada' : 'Borrador'}</span>
                ${p.featured ? '<span class="nav-badge" style="background:rgba(255,184,0,0.15); color:var(--warning); font-size:11px;"><i class="fas fa-star" style="margin-right:4px;"></i>Destacada</span>' : ''}
                ${p.is_retasada ? '<span class="nav-badge" style="background:rgba(139,92,246,0.15); color:#8b5cf6; font-size:11px;"><i class="fas fa-tag" style="margin-right:4px;"></i>Retasada</span>' : ''}
                ${p.is_oportunidad ? '<span class="nav-badge" style="background:rgba(239,68,68,0.15); color:#ef4444; font-size:11px;"><i class="fas fa-bolt" style="margin-right:4px;"></i>Oportunidad</span>' : ''}
                ${p.is_shared ? '<span class="nav-badge" style="background:rgba(6,182,212,0.15); color:#06b6d4; font-size:11px;"><i class="fas fa-share-nodes" style="margin-right:4px;"></i>Compartido</span>' : ''}
                ${p.is_vendida ? '<span class="nav-badge" style="background:rgba(75,85,99,0.18); color:#4b5563; font-size:11px;"><i class="fas fa-check-circle" style="margin-right:4px;"></i>Vendida</span>' : ''}
                ${p.is_reservada ? '<span class="nav-badge" style="background:rgba(234,179,8,0.18); color:#ca8a04; font-size:11px;"><i class="fas fa-lock" style="margin-right:4px;"></i>Reservada</span>' : ''}

              </div>
            </td>
            <td style="white-space:nowrap;">
            <div style="display:flex; gap:6px; align-items:center; flex-wrap:nowrap; white-space:nowrap;">
              ${mlButtons}
              ${relaButtons}
              ${p.is_published ? `<button class="btn-action" style="font-size:11px; color:#25D366;" title="Compartir ficha por WhatsApp" data-wa-share="${esc(p.id)}" data-wa-code="${esc(p.property_code || '')}"><i class="fab fa-whatsapp"></i></button>` : ''}
              <button class="btn-action" title="Editar" onclick="window.adminApp.editProperty('${p.id}')"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteProperty('${p.id}')"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>`;
      }).join('');
} catch (err) {
      logError('Error loading properties:', err);
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--danger);">Error al cargar propiedades</td></tr>';
    }

    // Pagination controls
    on(pagePrev, 'click', () => { if (_propPage > 1) { _propPage--; loadProperties(); } });
    on(pageNext, 'click', () => { const totalPages = Math.ceil(_propTotalCount / _propPageSize); if (_propPage < totalPages) { _propPage++; loadProperties(); } });
    on(pageSize, 'change', () => { _propPageSize = parseInt(pageSize.value); _propPage = 1; loadProperties(); });

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
  }

  /* Vista previa inmediata de las imágenes nuevas seleccionadas (antes de guardar) */
  on($('#propImageFilesInput'), 'change', (e) => {
    const previews = $('#imagePreviewGrid');
    if (!previews) return;

    /* Sacar las previews de una selección anterior (mantener las de imágenes
       ya existentes, que sí tienen su input hidden existing_image_urls) */
    previews.querySelectorAll('.image-preview-item[data-new-file]').forEach(el => el.remove());

    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
    files.forEach(file => {
      const objectUrl = URL.createObjectURL(file);
      const item = document.createElement('div');
      item.className = 'image-preview-item';
      item.dataset.newFile = 'true';
      item.style.cssText = 'position:relative; width:80px; height:80px; border-radius:8px; overflow:hidden; border:1px solid var(--accent);';
      item.innerHTML = `
        <img src="${objectUrl}" alt="" style="width:100%; height:100%; object-fit:cover;" />
        <span style="position:absolute; bottom:0; left:0; right:0; background:rgba(31,200,195,0.85); color:#04121a; font-size:8px; font-weight:700; text-align:center; padding:1px 0; text-transform:uppercase; letter-spacing:0.5px;">Nueva</span>
      `;
      previews.appendChild(item);
    });
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

      if (validated.is_vendida || validated.is_reservada) {
        data.is_published = false;
      }

      /* Image uploads */
      const imageFiles = formData.getAll('image_files');
      const existingUrls = formData.getAll('existing_image_urls').filter(u => u);
      const uploadPromises = [];
      for (const file of imageFiles) {
        if (file && file.size > 0) {
          uploadPromises.push(uploadToCloudinary(file));
        }
      }
      const newUrls = await Promise.all(uploadPromises);
      data.image_urls = [...existingUrls, ...newUrls];

      if (editingPropertyId) {
        await mutate('properties', async () => {
          const { error } = await window.supabaseClient
            .from('properties')
            .update(data)
            .eq('id', editingPropertyId);
          if (error) throw error;
        });
        showToast('Propiedad actualizada correctamente', 'success');
      } else {
        await mutate('properties', async () => {
          const { error } = await window.supabaseClient
            .from('properties')
            .insert([data]);
          if (error) throw error;
        });
        showToast('Propiedad creada correctamente', 'success');
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
            <div class="image-preview-item" style="position:relative; width:80px; height:80px; border-radius:8px; overflow:hidden; border:1px solid var(--border-subtle);">
              <img src="${esc(url)}" alt="" style="width:100%; height:100%; object-fit:cover;" />
              <input type="hidden" name="existing_image_urls" value="${esc(url)}" />
              <button type="button" class="preview-remove" style="position:absolute; top:4px; right:4px; width:20px; height:20px; border-radius:50%; background:rgba(0,0,0,0.7); color:#fff; border:none; cursor:pointer; font-size:10px; display:flex; align-items:center; justify-content:center;"><i class="fas fa-times"></i></button>
            </div>
          `).join('')
            : '';
        }
      }

      const title = $('#propModalTitle');
      if (title) title.textContent = 'Editar Propiedad';
      openModal('propertyModal');
    } catch (err) {
      showToast('Error al cargar propiedad', 'error');
    }
  };

  /* Delete property */
  window.adminApp.deleteProperty = async function (id) {
    if (!confirm('¿Eliminar esta propiedad? Esta acción no se puede deshacer.')) return;
    try {
      const { error } = await window.supabaseClient.from('properties').delete().eq('id', id);
      if (error) throw error;
      showToast('Propiedad eliminada', 'success');
      loadProperties();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al eliminar: ' + err.message, 'error');
    }
  };

  /* Property search */
  on($('#propSearchInput'), 'input', (e) => {
    const q = e.target.value.toLowerCase();
    const rows = $$('#propertiesTableBody tr');
    rows.forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = text.includes(q) ? '' : 'none';
    });
  });

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
  async function loadCRM() {
    invalidateSearchCache();
    const client = await getAuthedClient();
    if (!client) return;
    try {
      /* Get total count for pagination */
      const { count: totalCount, error: countError } = await client
        .from('leads')
        .select('*', { count: 'exact', head: true });
      if (countError) throw countError;
      _crmTotalCount = totalCount || 0;

      const from = (_crmPage - 1) * _crmPageSize;
      const to = from + _crmPageSize - 1;

      /* Traer leads y sus visitas (próximas y última) en una sola query */
      const [{ data: leads, error: leadsErr }, { data: visits, error: visitsErr }] = await Promise.all([
        client.from('leads').select('*').order('created_at', { ascending: false }).range(from, to),
        client.from('visits')
          .select('id, lead_id, visit_date, status, client_name')
          .neq('status', 'cancelada')
          .order('visit_date', { ascending: true }),
      ]);
      if (leadsErr) throw leadsErr;
      if (visitsErr) throw visitsErr;

      /* Agrupar visitas por lead_id para acceso rápido */
      const visitsByLead = {};
      (visits || []).forEach(v => {
        if (v.lead_id) {
          if (!visitsByLead[v.lead_id]) visitsByLead[v.lead_id] = [];
          visitsByLead[v.lead_id].push(v);
        }
      });

      /* Group by stage */
      const groups = { nuevo: [], contactado: [], visita: [], oferta: [], cerrado: [], perdido: [] };
      (leads || []).forEach(lead => {
        lead.score = computeLeadScore(lead);
        const stage = lead.stage || 'nuevo';
        if (groups[stage]) groups[stage].push(lead);
      });
      Object.values(groups).forEach(arr => arr.sort((a, b) => (b.score || 0) - (a.score || 0)));

      /* Map stages to columns */
      const columnMap = {
        'cards-nuevos': { stages: ['nuevo'], badge: 'badge-nuevos' },
        'cards-contactados': { stages: ['contactado'], badge: 'badge-contactados' },
        'cards-visita': { stages: ['visita'], badge: 'badge-visita' },
        'cards-oferta': { stages: ['oferta', 'cerrado', 'perdido'], badge: 'badge-oferta' },
      };

      Object.entries(columnMap).forEach(([containerId, { stages, badge }]) => {
        const container = document.querySelector('#' + containerId);
        const badgeEl = document.querySelector('#' + badge);
        const leadsArr = stages.flatMap(s => groups[s] || []);

        if (badgeEl) badgeEl.textContent = leadsArr.length;

        if (!container) return;
        if (!leadsArr.length) {
          container.innerHTML = '<p style="text-align:center; color:var(--text-dim); font-size:12px; padding:24px 8px;">Sin prospectos</p>';
          return;
        }

        const htmlParts = [];
        leadsArr.forEach(function(l) {
          const leadVisits = visitsByLead[l.id] || [];
          const upcomingVisit = leadVisits.find(function(v) { return v.status === 'pendiente' || v.status === 'confirmada'; });
          const hasFutureVisit = !!upcomingVisit;
          const showScheduleBtn = (l.stage === 'contactado' || l.stage === 'visita') && !hasFutureVisit;

          let visitInfo = '';
          if (upcomingVisit) {
            const badgeColor = upcomingVisit.status === 'confirmada' ? 'rgba(0,200,120,0.2)' : 'rgba(255,184,0,0.2)';
            const badgeTextColor = upcomingVisit.status === 'confirmada' ? 'var(--success)' : 'var(--warning)';
            const visitDate = new Date(upcomingVisit.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
            visitInfo = '<div style="margin-top:6px; padding:6px 8px; background:rgba(31,200,195,0.08); border-radius:4px; font-size:11px; color:var(--accent); display:flex; align-items:center; gap:6px;">' +
              '<i class="fas fa-calendar-day"></i>' +
              '<span>' + esc(visitDate) + '</span>' +
              '<span class="nav-badge" style="font-size:9px; background:' + badgeColor + '; color:var(--success);">' + esc(upcomingVisit.status) + '</span>' +
              '</div>';
          }

          let scheduleBtn = '';
          if (showScheduleBtn) {
            scheduleBtn = '<button class="btn-action" data-open-visit data-lead-id="' + esc(l.id) + '" data-client-name="' + esc(l.full_name) + '" data-client-phone="' + esc(l.phone || l.whatsapp || '') + '" data-property-id="' + esc(l.property_id || '') + '" style="padding:4px 8px; font-size:10px; margin-top:8px; width:100%; background:rgba(31,200,195,0.15); color:var(--accent); border:1px solid var(--accent);">' +
              '<i class="fas fa-calendar-plus"></i> Agendar visita' +
              '</button>';
          }

          const budgetHtml = l.budget_usd ? '<div style="color:var(--accent); font-size:12px; font-weight:500;">USD ' + l.budget_usd.toLocaleString('es-AR') + '</div>' : '';
          const prefType = l.preferred_type ? l.preferred_type.charAt(0).toUpperCase() + l.preferred_type.slice(1) : '';
          const prefZone = l.preferred_zone ? '· ' + esc(l.preferred_zone) : '';
          const createdDate = new Date(l.created_at).toLocaleDateString('es-AR');

          const scoreVal = l.score || 0;
          const scoreColor = scoreVal >= 80 ? 'rgba(239,68,68,0.2)' : scoreVal >= 50 ? 'rgba(255,184,0,0.2)' : 'rgba(255,255,255,0.06)';
          const scoreTextColor = scoreVal >= 80 ? '#ef4444' : scoreVal >= 50 ? 'var(--warning)' : 'var(--text-dim)';

          const cardHtml =
            '<div class="lead-card" style="background:var(--surface-2); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:14px; margin-bottom:10px; cursor:pointer;" onclick="window.adminApp.editLead(\'' + esc(l.id) + '\')">' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">' +
              '<div style="font-weight:600; color:#fff; font-size:13px;">' + esc(l.full_name || 'Sin nombre') + '</div>' +
              '<span class="nav-badge" style="font-size:10px; background:' + scoreColor + '; color:' + scoreTextColor + '; font-weight:600; padding:2px 6px; border-radius:10px;">' + scoreVal + '</span>' +
            '</div>' +
            '<div style="color:var(--text-dim); font-size:11px; margin-bottom:6px;">' + esc(prefType) + (prefZone ? ' · ' + esc(l.preferred_zone) : '') + '</div>' +
            (l.budget_usd ? '<div style="color:var(--accent); font-size:12px; font-weight:500;">USD ' + l.budget_usd.toLocaleString('es-AR') + '</div>' : '') +
            visitInfo +
            scheduleBtn +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top:8px; border-top:1px solid var(--border-subtle);">' +
              '<span style="color:var(--text-dim); font-size:10px;">' + new Date(l.created_at).toLocaleDateString('es-AR') + '</span>' +
              '<div style="display:flex; gap:4px;">' +
                '<button class="btn-action" style="padding:4px 6px; font-size:10px;" title="Editar" onclick="event.stopPropagation(); window.adminApp.editLead(\'' + esc(l.id) + '\')"><i class="fas fa-pen"></i></button>' +
                '<button class="btn-action danger" style="padding:4px 6px; font-size:10px;" title="Eliminar" onclick="event.stopPropagation(); window.adminApp.deleteLead(\'' + esc(l.id) + '\')"><i class="fas fa-trash"></i></button>' +
              '</div>' +
            '</div>' +
            '</div>';
          htmlParts.push(cardHtml);
        });
        container.innerHTML = htmlParts.join('');
      });
    } catch (err) {
      logError('CRM error:', err);
    }
  }

  /* Create lead */
  on($('#btnNewLead'), 'click', () => {
    editingLeadId = null;
    $('#leadForm')?.reset();
    loadAgentSelect($('#leadBrokerSelect'));
    openModal('leadModal');
  });

  /* Save lead */
  let _submittingLead = false;
  on($('#leadForm'), 'submit', async (e) => {
    e.preventDefault();
    if (_submittingLead) return;
    _submittingLead = true;
    const btn = $('#leadSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

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
      };

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
      loadCRM();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      _submittingLead = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Registrar Lead'; }
    }
  });

/* Edit lead */
  window.adminApp.editLead = async function (id) {
    try {
      const [{ data: lead, error: leadErr }, { data: visits, error: visitsErr }] = await Promise.all([
        window.supabaseClient.from('leads').select('*').eq('id', id).single(),
        window.supabaseClient
          .from('visits')
          .select('id, visit_date, status, client_name, property_id')
          .eq('lead_id', id)
          .order('visit_date', { ascending: true }),
      ]);
      if (leadErr) throw leadErr;
      if (visitsErr) throw visitsErr;

      editingLeadId = id;
      const form = $('#leadForm');
      if (form) {
        await loadAgentSelect($('#leadBrokerSelect'), lead.assigned_to);
        form.elements.full_name.value = lead.full_name || '';
        form.elements.phone.value = lead.phone || '';
        form.elements.email.value = lead.email || '';
        form.elements.budget_usd.value = lead.budget_usd || '';
        form.elements.stage.value = lead.stage || 'nuevo';
        form.elements.preferred_type.value = lead.preferred_type || '';
        form.elements.preferred_rooms.value = lead.preferred_rooms || '';
        form.elements.preferred_zone.value = lead.preferred_zone || '';
        form.elements.notes.value = lead.notes || '';
        form.elements.assigned_to.value = lead.assigned_to || '';
      }

      /* Visitas asociadas en el modal */
      const visitsContainer = $('#leadVisitsContainer');
      if (visitsContainer) {
        if (visits?.length) {
          visitsContainer.innerHTML = `
            <div style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border-subtle);">
              <div style="font-weight:600; color:var(--accent); font-size:12px; margin-bottom:8px;">Visitas asociadas (${visits.length})</div>
              ${visits.map(v => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:8px; background:var(--surface-2); border-radius:6px; margin-bottom:6px; font-size:12px;">
                  <div>
                    <div style="font-weight:500; color:#fff;">${new Date(v.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                    <div style="color:var(--text-dim); font-size:11px;">${esc(v.client_name || 'Sin cliente')} · ${esc(v.status)}</div>
                  </div>
                  <button class="btn-action" style="font-size:10px;" onclick="event.stopPropagation(); window.adminApp.editVisit('${v.id}')">
                    <i class="fas fa-external-link-alt"></i> Ver en Agenda
                  </button>
                </div>
              `).join('')}
            </div>`;
        } else {
          visitsContainer.innerHTML = `
            <div style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border-subtle); color:var(--text-dim); font-size:12px;">
              Sin visitas asociadas. <button type="button" class="btn-action" data-open-visit data-lead-id="${esc(editingLeadId)}" data-client-name="${esc(lead.full_name)}" data-client-phone="${esc(lead.phone || lead.whatsapp || '')}" data-property-id="${esc(lead.property_id || '')}" style="padding:2px 8px; font-size:10px; margin-left:8px;"><i class="fas fa-calendar-plus"></i> Agendar primera visita</button>
            </div>`;
        }
      }

      openModal('leadModal');
    } catch (err) {
      logError('Error al cargar lead:', err);
      showToast('Error al cargar lead', 'error');
    }
  };

  /* Delete lead */
  window.adminApp.deleteLead = async function (id) {
    if (!confirm('¿Eliminar este lead?')) return;
    try {
      const { error } = await window.supabaseClient.from('leads').delete().eq('id', id);
      if (error) throw error;
      showToast('Lead eliminado', 'success');
      loadCRM();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  /* ------------------------------------------------
     8. VISITS / AGENDA
     ------------------------------------------------ */
  async function loadVisits() {
    invalidateSearchCache();
    const tbody = $('#visitsTableBody');
    const pageInfo = $('#visitsPageInfo');
    const pagePrev = $('#visitsPagePrev');
    const pageNext = $('#visitsPageNext');
    const pageSize = $('#visitsPageSize');
    const visitsBrokerFilter = $('#visitsBrokerFilter');
    const calBrokerFilter = $('#calBrokerFilter');
    if (!tbody) return;
    const client = await getAuthedClient();
    if (!client) return;

    /* Get selected broker filter */
    const brokerFilter = (visitsBrokerFilter?.value || calBrokerFilter?.value || '').trim();

    try {
      /* Get total count for pagination */
      let countQuery = client.from('visits').select('*', { count: 'exact', head: true });
       if (brokerFilter) countQuery = countQuery.eq('agent_id', brokerFilter);
      const { count: totalCount, error: countError } = await countQuery;
      if (countError) throw countError;
      _visitsTotalCount = totalCount || 0;

      const from = (_visitsPage - 1) * _visitsPageSize;
      const to = from + _visitsPageSize - 1;

      /* JOIN con leads para mostrar nombre del lead y link a CRM */
      let dataQuery = client
        .from('visits')
        .select('*, leads(id, full_name, stage), agents(id, full_name), properties(id, title, property_code)')
        .order('visit_date', { ascending: true })
        .range(from, to);
      if (brokerFilter) dataQuery = dataQuery.eq('agent_id', brokerFilter);
      const { data, error } = await dataQuery;

      if (error) throw error;

      calVisitsCache = data || [];
      renderCalendar();

      /* Update pagination UI */
      const totalPages = Math.ceil(_visitsTotalCount / _visitsPageSize);
      if (pageInfo) pageInfo.textContent = `Página ${_visitsPage} de ${totalPages || 1}`;
      if (pagePrev) pagePrev.disabled = _visitsPage <= 1;
      if (pageNext) pageNext.disabled = _visitsPage >= totalPages;

      if (!data?.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--text-dim);">No hay visitas programadas</td></tr>';
        return;
      }

      tbody.innerHTML = data.map(visitRowHtml).join('');

      /* Actualizar header de la tabla si existe */
      const thead = tbody.closest('table').querySelector('thead');
      if (thead && !thead.querySelector('th:nth-child(3)')?.textContent?.includes('Lead')) {
        thead.innerHTML = `
          <tr>
            <th>Fecha y Hora</th>
            <th>Cliente</th>
            <th>Lead (CRM)</th>
            <th>Propiedad</th>
            <th>Estado</th>
            <th>Vinculado</th>
            <th>Acciones</th>
          </tr>`;
      }
    } catch (err) {
      logError('Visits error:', err);
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--danger);">Error al cargar visitas</td></tr>';
    }
  }

  /* ========== CALENDARIO AGENDA ========== */
  let calCurrentDate = new Date();
  let calVisitsCache = [];
  let calViewMode = 'table';

  function renderCalendar(visitsCache = calVisitsCache) {
    const grid = $('#calendarGrid');
    if (!grid) return;

    const year = calCurrentDate.getFullYear();
    const month = calCurrentDate.getMonth();
    const today = new Date();
    const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDay = firstDay.getDay();
    const daysInMonth = lastDay.getDate();
    const prevMonthLastDay = new Date(year, month, 0).getDate();

    const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const monthEl = $('#calCurrentMonth');
    if (monthEl) monthEl.textContent = monthNames[calCurrentDate.getMonth()] + ' ' + calCurrentDate.getFullYear();

    const statusFilter = $('#calStatusFilter')?.value || '';
    const brokerFilter = $('#calBrokerFilter')?.value || '';
    const monthVisits = visitsCache.filter(v => {
      if (!v.visit_date) return false;
      const d = new Date(v.visit_date);
      if (d.getFullYear() !== calCurrentDate.getFullYear() || d.getMonth() !== calCurrentDate.getMonth()) return false;
      if (statusFilter && v.status !== statusFilter) return false;
      if (brokerFilter && v.agent_id !== brokerFilter) return false;
      return true;
    });

    const visitsByDay = {};
    monthVisits.forEach(v => {
      const dv = new Date(v.visit_date);
      const dayStr = dv.getFullYear() + '-' + String(dv.getMonth() + 1).padStart(2, '0') + '-' + String(dv.getDate()).padStart(2, '0');
      if (!visitsByDay[dayStr]) visitsByDay[dayStr] = [];
      visitsByDay[dayStr].push(v);
    });

let html = '';
let dayCount = 1;
    let nextMonthDay = 1;

    for (let week = 0; week < 6; week++) {
      for (let dow = 0; dow < 7; dow++) {
        let isCurrentMonth = false;
        let dayNum = 0;
        let dateStr = '';

        if (week === 0 && dow < startDay) {
          const prevMonthLastDay = new Date(year, month, 0).getDate();
          dayNum = prevMonthLastDay - (startDay - dow - 1);
          const prevMonth = month === 0 ? 11 : month - 1;
          const prevYear = month === 0 ? year - 1 : year;
          dateStr = prevYear + '-' + String(prevMonth + 1).padStart(2, '0') + '-' + String(dayNum).padStart(2, '0');
          isCurrentMonth = false;
        } else if (dayCount <= daysInMonth) {
          dayNum = dayCount++;
          dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(dayNum).padStart(2, '0');
          isCurrentMonth = true;
        } else {
          dayNum = nextMonthDay++;
          const nextMonth = month === 11 ? 0 : month + 1;
          const nextYear = month === 11 ? year + 1 : year;
          dateStr = nextYear + '-' + String(nextMonth + 1).padStart(2, '0') + '-' + String(dayNum).padStart(2, '0');
          isCurrentMonth = false;
        }

        const isToday = dateStr === todayStr;
        const dayVisits = visitsByDay[dateStr] || [];

        let eventsHtml = '';
        if (dayVisits.length > 0) {
          const filteredEvents = dayVisits.filter(v => !statusFilter || v.status === statusFilter);
          const maxShow = 3;
          filteredEvents.slice(0, maxShow).forEach(v => {
            const timeStr = v.visit_date ? new Date(v.visit_date).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
            const leadName = v.leads?.full_name ? ' · ' + v.leads.full_name : '';
            eventsHtml += '<div class="cal-event ' + v.status + '" data-visit-id="' + v.id + '" style="cursor:pointer;" onclick="event.stopPropagation(); window.adminApp.editVisit(\'' + v.id + '\')">' + esc(timeStr) + ' ' + esc(v.client_name || 'Sin cliente') + leadName + '</div>';
          });
          if (filteredEvents.length > 3) {
            eventsHtml += '<div class="cal-event-more" onclick="event.stopPropagation(); filterVisitsByDate(\'' + dateStr + '\')">+' + (filteredEvents.length - 3) + ' más</div>';
          }
        }

        const otherMonthClass = isCurrentMonth ? '' : ' other-month';
        const todayClass = isCurrentMonth && dateStr === todayStr ? ' today' : '';

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
  }

  function updateViewToggle() {
    const calView = $('#visitsCalendarView');
    const tableView = $('#visitsTableView');
    const calBtn = $('#viewCalendarBtn');
    const tableBtn = $('#viewTableBtn');
    if (calView && tableView) {
      if (calViewMode === 'calendar') {
        calView.style.display = 'block';
        tableView.style.display = 'none';
        calBtn?.classList.add('active');
        tableBtn?.classList.remove('active');
      } else {
        calView.style.display = 'none';
        tableView.style.display = 'block';
        calBtn?.classList.remove('active');
        tableBtn?.classList.add('active');
      }
    }
  }

  $('#viewCalendarBtn')?.addEventListener('click', function() {
    calViewMode = 'calendar';
    updateViewToggle();
  });
  $('#viewTableBtn')?.addEventListener('click', function() {
    calViewMode = 'table';
    updateViewToggle();
    loadVisits();
  });

  $('#calPrevMonth')?.addEventListener('click', function() {
    calCurrentDate.setMonth(calCurrentDate.getMonth() - 1);
    renderCalendar();
  });
  $('#calNextMonth')?.addEventListener('click', function() {
    calCurrentDate.setMonth(calCurrentDate.getMonth() + 1);
    renderCalendar();
  });
  $('#calTodayBtn')?.addEventListener('click', function() {
    calCurrentDate = new Date();
    renderCalendar();
  });
  $('#calStatusFilter')?.addEventListener('change', function() {
    renderCalendar();
  });
  $('#calBrokerFilter')?.addEventListener('change', function() {
    renderCalendar();
    loadVisits(); // Also refresh table with same filter
  });
  $('#visitsBrokerFilter')?.addEventListener('change', function() {
    _visitsPage = 1;
    loadVisits();
  });

  /* Populate broker filters on load */
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
      const tableFilter = $('#visitsBrokerFilter');
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
      if (tableFilter) {
        const current = tableFilter.value;
        tableFilter.innerHTML = '<option value="">Todos los brokers</option>';
        brokers.forEach(b => {
          const opt = document.createElement('option');
          opt.value = b.id;
          opt.textContent = b.full_name;
          tableFilter.appendChild(opt);
        });
        if (current) tableFilter.value = current;
      }
    } catch (_) { /* silent */ }
  }

  /* Call populate on module init */
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
    // ============================================

    function upsertVisitRow(v) {
      const tbody = $('#visitsTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector(`tr[data-id="${v.id}"]`);
      const rowHtml = visitRowHtml(v);
      if (existing) {
        existing.outerHTML = rowHtml;
      } else {
        tbody.insertAdjacentHTML('afterbegin', rowHtml);
      }
    }

    function removeVisitRow(id) {
      const row = $('#visitsTableBody')?.querySelector(`tr[data-id="${id}"]`);
      if (row) row.remove();
    }

    function upsertPropertyRow(prop) {
      const tbody = $('#propertiesTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector(`tr[data-id="${prop.id}"]`);
      if (existing) {
        existing.outerHTML = buildPropertyRowHtml(prop);
      } else {
        tbody.insertAdjacentHTML('afterbegin', buildPropertyRowHtml(prop));
      }
    }

    function removePropertyRow(id) {
      const row = $('#propertiesTableBody')?.querySelector(`tr[data-id="${id}"]`);
      if (row) row.remove();
    }

    function upsertAgentRow(agent) {
      const tbody = $('#agentsTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector(`tr[data-id="${agent.id}"]`);
      if (existing) {
        existing.outerHTML = buildAgentRowHtml(agent);
      } else {
        tbody.insertAdjacentHTML('afterbegin', buildAgentRowHtml(agent));
      }
    }

    function removeAgentRow(id) {
      const row = $('#agentsTableBody')?.querySelector(`tr[data-id="${id}"]`);
      if (row) row.remove();
    }

    function upsertOwnerRow(owner) {
      const tbody = $('#ownersTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector(`tr[data-id="${owner.id}"]`);
      if (existing) {
        existing.outerHTML = buildOwnerRowHtml(owner);
      } else {
        tbody.insertAdjacentHTML('afterbegin', buildOwnerRowHtml(owner));
      }
    }

    function removeOwnerRow(id) {
      const row = $('#ownersTableBody')?.querySelector(`tr[data-id="${id}"]`);
      if (row) row.remove();
    }

    function upsertTasacionRow(t) {
      const tbody = $('#tasacionesTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector(`tr[data-id="${t.id}"]`);
      if (existing) {
        existing.outerHTML = buildTasacionRowHtml(t);
      } else {
        tbody.insertAdjacentHTML('afterbegin', buildTasacionRowHtml(t));
      }
    }

    function removeTasacionRow(id) {
      const row = $('#tasacionesTableBody')?.querySelector(`tr[data-id="${id}"]`);
      if (row) row.remove();
    }

    // Helper: extract row builders from existing load functions
    function buildLeadCardHtml(l) {
      const leadVisits = (window._visitsByLeadCache?.[l.id] || []);
      const upcomingVisit = leadVisits.find(v => v.status === 'pendiente' || v.status === 'confirmada');
      const hasFutureVisit = !!upcomingVisit;
      const showScheduleBtn = (l.stage === 'contactado' || l.stage === 'visita') && !hasFutureVisit;
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

    function buildOwnerRowHtml(o) {
      return `<tr data-id="${o.id}">
        <td>${esc(o.full_name)}</td>
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

    function buildTasacionRowHtml(t) {
      const statusLabel = t.status === 'finalized' ? 'Finalizada' : 'Borrador';
      const statusClass = t.status === 'finalized' ? 'active' : 'pending';
      const date = t.created_at ? new Date(t.created_at).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
      const valuation = t.valuation_usd ? '$ ' + Number(t.valuation_usd).toLocaleString('es-AR') : '-';
      return `<tr data-id="${t.id}">
        <td style="font-weight:600; color:#fff;">${esc(t.title || 'Sin título')}</td>
        <td style="color:var(--text-muted);">${t.properties ? esc(t.properties.code + ' - ' + t.properties.title) : '-'}</td>
        <td style="color:var(--text-muted);">${t.owners ? esc(t.owners.full_name) : '-'}</td>
        <td style="color:var(--accent); font-weight:600;">${valuation}</td>
        <td><span class="status-pill" style="background:rgba(201,169,110,0.12); color:#c9a96e;">${t.type === 'venta' ? 'Venta' : t.type === 'alquiler' ? 'Alquiler' : t.type || '-'}</span></td>
        <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
        <td>${date}</td>
        <td>
          <button class="icon-badge-btn" title="Abrir" data-open-tasacion="${t.id}" data-tasacion-title="${esc(t.title || '')}"><i class="fas fa-external-link-alt"></i></button>
          <button class="icon-badge-btn" title="Exportar PDF" data-pdf-tasacion="${t.id}" data-tasacion-title="${esc(t.title || '')}"><i class="fas fa-file-pdf" style="color:var(--danger);"></i></button>
          <button class="icon-badge-btn" title="Eliminar" data-del-tasacion="${t.id}"><i class="fas fa-trash" style="color:var(--danger);"></i></button>
        </td>
      </tr>`;
    }

    function buildCommissionRowHtml(c) {
      const statusClass = c.status === 'pendiente' ? 'comm-pendiente' : c.status === 'liquidada' ? 'comm-liquidada' : c.status === 'pagada' ? 'comm-pagada' : '';
      const statusLabel = { pendiente: 'Pendiente', liquidada: 'Liquidada', pagada: 'Pagada', cancelada: 'Cancelada' }[c.status] || c.status;
      const netArs = c.net_amount_ars || (c.commission_amount_ars - (c.iibb_amount_ars || 0) - (c.ganancias_amount_ars || 0));
      return `<tr data-id="${c.id}">
        <td>${esc(c.owners?.full_name || '—')}</td>
        <td>${esc(c.properties?.title || c.properties?.property_code || '—')}</td>
        <td>${esc(c.agents?.full_name || '—')}</td>
        <td>${esc(c.operation_type === 'venta' ? 'Venta' : 'Alquiler')}</td>
        <td>USD ${(c.commission_amount_usd || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
        <td>${c.iibb_rate || 0}%</td>
        <td>${c.ganancias_rate || 0}%</td>
        <td class="price-cell">${formatNumber(netArs)}</td>
        <td>${c.due_date ? new Date(c.due_date).toLocaleDateString('es-AR') : '—'}</td>
        <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
        <td>
          <button class="btn-action" title="Marcar pagada" onclick="window.adminApp.markCommissionPaid('${c.id}')" style="${c.status === 'pagada' ? 'display:none' : ''}"><i class="fas fa-check"></i></button>
          <button class="btn-action" title="Ver liquidación" onclick="window.adminApp.viewCommissionLiquidation('${c.id}')"><i class="fas fa-eye"></i></button>
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
      const _stageCol = { nuevo:'nuevos', contactado:'contactados', visita:'visita', oferta:'oferta', cerrado:'oferta', perdido:'oferta' };
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

  /* Create visit */
  on($('#btnNewVisit'), 'click', () => {
    editingVisitId = null;
    delete window._pendingLeadId;
    $('#visitForm')?.reset();
    loadAgentSelect($('#visitBrokerSelect'));
    loadPropertySelect($('#visitPropertySelect'));
    /* Limpiar selector dinámico si existe */
    const oldSelect = $('#visitLeadSelect');
    if (oldSelect) oldSelect.remove();
    const oldInfo = $('#visitLeadInfo');
    if (oldInfo) oldInfo.remove();
    openModal('visitModal');
  });

  /* openVisitModal — llamado desde CRM con pre-llenado */
  window.adminApp.openVisitModal = function (prefill = {}) {
    editingVisitId = null;
    const form = $('#visitForm');
    if (form) form.reset();
    /* Limpiar selector dinámico si existe */
    const oldSelect = $('#visitLeadSelect');
    if (oldSelect) oldSelect.remove();
    const oldInfo = $('#visitLeadInfo');
    if (oldInfo) oldInfo.remove();

    /* Cargar brokers en el dropdown */
    loadAgentSelect($('#visitBrokerSelect'));

    /* Pre-llenar desde CRM */
    if (prefill.visit_date) {
      const d = new Date(prefill.visit_date);
      const visitDateEl = document.querySelector('#visitForm [name="visit_date"]');
      if (visitDateEl) visitDateEl.value = d.toISOString().slice(0, 16);
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
    if (prefill.lead_id) {
      window._pendingLeadId = prefill.lead_id;
    } else {
      delete window._pendingLeadId;
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

  /* Save visit */
  let _submittingVisit = false;
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
        lead_id: validated.lead_id ?? window._pendingLeadId ?? null,
        property_id: validated.property_id,
        agent_id: validated.agent_id,
        duration_minutes: validated.duration_minutes,
      };

      /* Conflict detection: same broker, overlapping time */
      if (data.agent_id && data.visit_date && data.duration_minutes) {
        const visitStart = new Date(data.visit_date).getTime();
        const visitEnd = visitStart + data.duration_minutes * 60 * 1000;
        const { data: conflicts, error: conflictError } = await window.supabaseClient
          .from('visits')
          .select('id, client_name, visit_date, duration_minutes')
          .eq('agent_id', data.agent_id)
          .in('status', ['pendiente', 'confirmada'])
          .neq('id', editingVisitId || '00000000-0000-0000-0000-000000000000');
        if (!conflictError && conflicts?.length) {
          const hasOverlap = conflicts.some(c => {
            const cStart = new Date(c.visit_date).getTime();
            const cEnd = cStart + (c.duration_minutes || 60) * 60 * 1000;
            return visitStart < cEnd && visitEnd > cStart;
          });
          if (hasOverlap) {
            const conflict = conflicts.find(c => {
              const cStart = new Date(c.visit_date).getTime();
              const cEnd = cStart + (c.duration_minutes || 60) * 60 * 1000;
              return visitStart < cEnd && visitEnd > cStart;
            });
            if (conflict) {
              showToast(`Conflicto: ${conflict.client_name} ya tiene visita en ese horario`, 'warning');
              return;
            }
          }
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
        /* Show confirmation link */
        if (inserted?.id && data.client_email) {
          const confirmUrl = `${window.location.origin}/confirmar-visita.html?token=${confirmation_token}`;
          showToast(`Link de confirmación: ${confirmUrl} (copiado al portapapeles)`, 'info', 8000);
          navigator.clipboard.writeText(confirmUrl).catch(() => {});
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
          if (leadData && leadData.stage === 'visita') {
            const confirmMove = confirm('¿Mover el lead a "Oferta / Cierre"?');
            if (confirmMove) {
              await window.supabaseClient
                .from('leads')
                .update({ stage: 'oferta', updated_at: new Date().toISOString() })
                .eq('id', newLeadId);
              showToast('Lead movido a Oferta / Cierre', 'success');
            }
          }
        } catch (_) {}
      }

      /* Si se asignó lead_id nuevo (era NULL) ? el trigger DB actualizará lead a "visita" */
      /* Si se quitó lead_id (era valor ? NULL) ? no hacemos nada en lead */

      closeModal('visitModal');
      /* Limpiar flag pendiente */
      delete window._pendingLeadId;
      loadVisits();
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
      const severityLabels = { critical: '?? Crítica', high: '?? Alta', medium: '?? Media', low: '?? Baja', info: '? Info' };
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
      const severityLabels = { critical: '?? Crítica', high: '?? Alta', medium: '?? Media', low: '?? Baja', info: '? Info' };
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

      if (form) {
        /* Cargar brokers en dropdown existente */
        await loadAgentSelect($('#visitBrokerSelect'), data.agent_id);
        await loadPropertySelect($('#visitPropertySelect'), data.property_id);

        if (data.visit_date) {
          const d = new Date(data.visit_date);
          form.elements.visit_date.value = d.toISOString().slice(0, 16);
        }
        form.elements.status.value = data.status || 'pendiente';
        form.elements.client_name.value = data.client_name || '';
        form.elements.client_phone.value = data.client_phone || '';
        form.elements.client_email.value = data.client_email || '';
        form.elements.duration_minutes.value = data.duration_minutes || 60;
        form.elements.agent_id.value = data.agent_id || '';
        form.elements.notes.value = data.notes || '';

        /* Lead selector para vincular/desvincular */
        const leadSelect = document.createElement('select');
        leadSelect.id = 'visitLeadSelect';
        leadSelect.name = 'lead_id';
        leadSelect.style.cssText = 'width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--border-input); background:rgba(255,255,255,0.03); color:#fff; font-size:13px; margin-top:8px;';
        leadSelect.innerHTML = '<option value="">— Sin lead vinculado (visita espontánea) —</option>';
        
        /* Cargar leads en stage "contactado" o "visita" que no tengan visita futura */
        try {
          const { data: availableLeads } = await window.supabaseClient
            .from('leads')
            .select('id, full_name, stage, phone, whatsapp, property_id')
            .in('stage', ['contactado', 'visita'])
            .order('full_name');
          
          if (availableLeads?.length) {
            availableLeads.forEach(l => {
              const opt = document.createElement('option');
              opt.value = l.id;
              opt.textContent = `${l.full_name} (${l.stage})`;
              if (l.property_id) opt.textContent += ' ??';
              leadSelect.appendChild(opt);
            });
          }
        } catch (_) {}

        if (form.elements.lead_id) form.elements.lead_id.remove();
        form.appendChild(leadSelect);
        
        /* Seleccionar lead actual si existe */
        if (data.lead_id) leadSelect.value = data.lead_id;

        /* Mostrar info del lead seleccionado */
        const leadInfo = document.createElement('div');
        leadInfo.id = 'visitLeadInfo';
        leadInfo.style.cssText = 'margin-top:8px; padding:8px 12px; background:rgba(31,200,195,0.08); border-radius:6px; font-size:12px; display:none;';
        form.appendChild(leadInfo);
        
        leadSelect.addEventListener('change', async (e) => {
          const selectedId = e.target.value;
          const infoEl = $('#visitLeadInfo');
          if (selectedId) {
            try {
              const { data: leadData } = await window.supabaseClient
                .from('leads')
                .select('full_name, stage, phone, whatsapp, property_id')
                .eq('id', selectedId)
                .single();
              if (leadData) {
                infoEl.style.display = 'block';
                infoEl.innerHTML = `
                  <strong>${esc(leadData.full_name)}</strong> · Etapa: ${esc(leadData.stage)}
                  ${leadData.property_id ? ' · <span style="color:var(--accent);">?? Propiedad asignada</span>' : ' · <span style="color:var(--warning);">?? Sin propiedad asignada</span>'}
                `;
                /* Auto-rellenar campos si no estaban llenos */
                if (!form.elements.client_name.value) form.elements.client_name.value = leadData.full_name || '';
                if (!form.elements.client_phone.value) form.elements.client_phone.value = leadData.phone || leadData.whatsapp || '';
              }
            } catch (_) {}
          } else {
            infoEl.style.display = 'none';
            infoEl.innerHTML = '';
          }
        });

        /* Disparar cambio si ya hay lead seleccionado */
        if (data.lead_id) leadSelect.dispatchEvent(new Event('change'));
      }

      openModal('visitModal');
    } catch (err) {
      logError('Error al cargar visita:', err);
      showToast('Error al cargar visita', 'error');
    }
  };

  /* Delete visit */
  window.adminApp.deleteVisit = async function (id) {
    if (!confirm('¿Eliminar esta visita?')) return;
    try {
      const { error } = await window.supabaseClient.from('visits').delete().eq('id', id);
      if (error) throw error;
      showToast('Visita eliminada', 'success');
      loadVisits();
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
      loadVisits();
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
      loadVisits();
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
    seo: 'seo'
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
    } catch (err) {
      logError('CMS error:', err);
    }
  }

  function populateCMSFields() {
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

  on($('#cmsSaveBtn'), 'click', async () => {
    const btn = $('#cmsSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const fields = $$('.cms-field[data-key]');
      const updatesBySection = {};

      fields.forEach(field => {
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
      subtitle: 'en Buenos Aires',
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
        client.from('app_settings').select('key, value'),
        client.from('zernio_config').select('value').eq('key', 'api_key').maybeSingle()
      ]);
      if (error) throw error;
      if (!prefRes.error && Array.isArray(prefRes.data)) {
        const prefs = prefRes.data.find(r => r.key === 'preferences');
        const rateInput = $('#cfg_usd_rate');
        if (prefs?.value && typeof prefs.value.usd_rate === 'number' && rateInput) rateInput.value = prefs.value.usd_rate;
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

      const { error: upErr } = await client
        .from('app_settings')
        .upsert({ key: 'preferences', value: { usd_rate: rateVal }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (upErr) throw upErr;

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
    row.innerHTML = statusChip('Supabase', true, 'conectado')
      + statusChip('Cloudinary', !!window.BH_Cloudinary, window.BH_Cloudinary ? 'listo' : 'no disponible')
      + statusChip('Brevo SMTP', true, 'límite 30 envíos/hora')
      + statusChip('Mercado Libre', !!ml_connected, ml_configured ? 'credenciales OK' : 'sin configurar');
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
      const res = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/zernio-proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.data.session?.access_token}` },
        body: JSON.stringify({ action: 'list_accounts' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error en respuesta');
      statusEl.textContent = '? Conectado · ' + data.count + ' cuenta(s) sincronizada(s)';
      statusEl.style.color = 'var(--success)';
    } catch (err) {
      statusEl.textContent = '? ' + err.message;
      statusEl.style.color = 'var(--danger)';
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
          Array.from(form.elements.specialties.options).forEach(opt => {
            opt.selected = (data.specialties || []).includes(opt.value);
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
  async function loadOwners() {
    invalidateSearchCache();
    const tbody = $('#ownersTableBody');
    if (!tbody) return;
    const client = await getAuthedClient();
    if (!client) return;

    try {
      const { data: owners, error } = await client
        .from('owners')
        .select('*')
        .is('deleted_at', null)
        .order('created_at', { ascending: true });

      if (error) throw error;

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
      const totalAlerts = expiringSoon + expiredExcl + totalDocAlerts;
      if (exclBadge) {
        if (totalAlerts > 0) {
          exclBadge.textContent = (owners || []).length + ' Activos · ' + totalAlerts + ' alertas';
          exclBadge.style.color = 'var(--warning)';
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

      if (!owners?.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim);">No hay propietarios cargados</td></tr>';
        updateCommissionsKPI();
        loadCommissionDashboard();
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
            <div style="font-size:12px; color:var(--text-dim);">${esc(o.bank_name || '-')}</div>
            <div style="font-size:11px; color:var(--text-dim);">${o.cbu_cvu ? esc(o.cbu_cvu.slice(0, 8)) + '...' : ''}</div>
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
    /* Update commission KPI and load dashboard */
    updateCommissionsKPI();
    loadCommissionDashboard();
  }

  /* Commission KPI - sum of pending commissions */
  async function updateCommissionsKPI() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('commissions')
        .select('commission_amount_usd')
        .eq('status', 'pendiente');
      if (error) throw error;
      const total = (data || []).reduce((sum, c) => sum + (c.commission_amount_usd || 0), 0);
      const el = $('#ownerKpiCommissions');
      if (el) el.textContent = total > 0 ? 'USD ' + formatNumber(total) : 'USD 0';
    } catch (_) { /* silent */ }
  }

  /* Commission Dashboard */
  async function loadCommissionDashboard() {
    if (!window.supabaseClient) return;

    /* Populate filter dropdowns */
    await populateCommissionFilters();

    /* Load all three tabs */
    await loadPendingCommissions();
    await loadLiquidations();
    await loadPayments();
  }

  async function populateCommissionFilters() {
    if (!window.supabaseClient) return;
    try {
      const [brokersRes, ownersRes] = await Promise.all([
        window.supabaseClient.from('agents').select('id, full_name').eq('status', 'activo').is('deleted_at', null).order('full_name'),
        window.supabaseClient.from('owners').select('id, full_name').is('deleted_at', null).order('full_name')
      ]);
      const brokers = brokersRes.data || [];
      const owners = ownersRes.data || [];

      const brokerFilter = $('#commFilterBroker');
      const ownerFilter = $('#commFilterOwner');
      if (brokerFilter) {
        const cur = brokerFilter.value;
        brokerFilter.innerHTML = '<option value="">Todos los Brokers</option>';
        brokers.forEach(b => { const o = document.createElement('option'); o.value = b.id; o.textContent = b.full_name; brokerFilter.appendChild(o); });
        if (cur) brokerFilter.value = cur;
      }
      if (ownerFilter) {
        const cur = ownerFilter.value;
        ownerFilter.innerHTML = '<option value="">Todos los Propietarios</option>';
        owners.forEach(o => { const opt = document.createElement('option'); opt.value = o.id; opt.textContent = o.full_name; ownerFilter.appendChild(opt); });
        if (cur) ownerFilter.value = cur;
      }
    } catch (_) { /* silent */ }
  }

  async function loadPendingCommissions() {
    const body = $('#commPendingBody');
    if (!body) return;
    if (!window.supabaseClient) return;

    const broker = $('#commFilterBroker')?.value || '';
    const owner = $('#commFilterOwner')?.value || '';
    const status = $('#commFilterStatus')?.value || '';

    try {
      let query = window.supabaseClient
        .from('commissions')
        .select('*, owners(full_name), properties(property_code, title), agents(full_name)')
        .order('created_at', { ascending: false });
      if (broker) query = query.eq('broker_id', broker);
      if (owner) query = query.eq('owner_id', owner);
      if (status) query = query.eq('status', status);

      const { data, error } = await query;
      if (error) throw error;

      if (!data?.length) {
        body.innerHTML = '<tr><td colspan="11" style="text-align:center; padding:40px; color:var(--text-dim);">Sin comisiones</td></tr>';
        return;
      }

      body.innerHTML = data.map(c => {
        const statusClass = c.status === 'pendiente' ? 'comm-pendiente' : c.status === 'liquidada' ? 'comm-liquidada' : c.status === 'pagada' ? 'comm-pagada' : '';
        const statusLabel = { pendiente: 'Pendiente', liquidada: 'Liquidada', pagada: 'Pagada', cancelada: 'Cancelada' }[c.status] || c.status;
        const netArs = c.net_amount_ars || (c.commission_amount_ars - (c.iibb_amount_ars || 0) - (c.ganancias_amount_ars || 0));
        return `
          <tr>
            <td>${esc(c.owners?.full_name || '—')}</td>
            <td>${esc(c.properties?.title || c.properties?.property_code || '—')}</td>
            <td>${esc(c.agents?.full_name || '—')}</td>
            <td>${esc(c.operation_type === 'venta' ? 'Venta' : 'Alquiler')}</td>
            <td>USD ${(c.commission_amount_usd || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
            <td>${c.iibb_rate || 0}%</td>
            <td>${c.ganancias_rate || 0}%</td>
            <td class="price-cell">${formatNumber(netArs)}</td>
            <td>${c.due_date ? new Date(c.due_date).toLocaleDateString('es-AR') : '—'}</td>
            <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
            <td>
              <button class="btn-action" title="Marcar pagada" onclick="window.adminApp.markCommissionPaid('${c.id}')" style="${c.status === 'pagada' ? 'display:none' : ''}"><i class="fas fa-check"></i></button>
              <button class="btn-action" title="Ver liquidación" onclick="window.adminApp.viewCommissionLiquidation('${c.id}')"><i class="fas fa-eye"></i></button>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      logError('Pending commissions error:', err);
      body.innerHTML = '<tr><td colspan="11" style="text-align:center; padding:40px; color:var(--danger);">Error cargando comisiones</td></tr>';
    }
  }

  async function loadLiquidations() {
    const body = $('#commLiquidationsBody');
    if (!body) return;
    if (!window.supabaseClient) return;

    try {
      const { data, error } = await window.supabaseClient
        .from('commission_liquidations')
        .select('*, agents(full_name), owners(full_name)')
        .order('period_start', { ascending: false });
      if (error) throw error;

      if (!data?.length) {
        body.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--text-dim);">Sin liquidaciones</td></tr>';
        return;
      }

      body.innerHTML = data.map(l => `
        <tr>
          <td>${new Date(l.period_start).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })}</td>
          <td>${esc(l.agents?.full_name || '—')}</td>
          <td>${esc(l.owners?.full_name || '—')}</td>
          <td>USD ${(l.gross_commission_usd || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
          <td>${formatNumber(l.iibb_retention_ars || 0)}</td>
          <td>${formatNumber(l.ganancias_retention_ars || 0)}</td>
          <td class="price-cell">${formatNumber(l.net_amount_ars || 0)}</td>
          <td><span class="status-badge ${l.status === 'pagada' ? 'status-vigente' : l.status === 'confirmada' ? 'status-por-vencer' : ''}">${esc(l.status)}</span></td>
          <td>
            <button class="btn-action" title="Ver PDF" onclick="window.adminApp.viewLiquidationPDF('${l.id}')"><i class="fas fa-file-pdf"></i></button>
            <button class="btn-action" title="Marcar pagada" onclick="window.adminApp.markLiquidationPaid('${l.id}')" style="${l.status === 'pagada' ? 'display:none' : ''}"><i class="fas fa-check"></i></button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      logError('Liquidations error:', err);
      body.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--danger);">Error cargando liquidaciones</td></tr>';
    }
  }

  async function loadPayments() {
    const body = $('#commPaymentsBody');
    if (!body) return;
    if (!window.supabaseClient) return;

    try {
      const { data, error } = await window.supabaseClient
        .from('commission_payments')
        .select('*, agents(full_name), owners(full_name)')
        .order('payment_date', { ascending: false });
      if (error) throw error;

      if (!data?.length) {
        body.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--text-dim);">Sin pagos registrados</td></tr>';
        return;
      }

      body.innerHTML = data.map(p => `
        <tr>
          <td>${new Date(p.payment_date).toLocaleDateString('es-AR')}</td>
          <td>${esc(p.agents?.full_name || '—')}</td>
          <td>${esc(p.owners?.full_name || '—')}</td>
          <td class="price-cell">${formatNumber(p.amount_ars)}</td>
          <td>${esc(p.payment_method || '—')}</td>
          <td>${esc(p.reference || '—')}</td>
          <td><button class="btn-action" title="Eliminar" onclick="window.adminApp.deletePayment('${p.id}')"><i class="fas fa-trash"></i></button></td>
        </tr>
      `).join('');
    } catch (err) {
      logError('Payments error:', err);
      body.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--danger);">Error cargando pagos</td></tr>';
    }
  }

  /* Commission tab switching */
  $$('.comm-tab-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const tab = this.dataset.commTab;
      $$('.comm-tab-btn').forEach(b => { b.classList.remove('is-active'); b.style.background = 'none'; b.style.color = 'var(--text-dim)'; });
      $$('.comm-tab-content').forEach(c => c.style.display = 'none');
      this.classList.add('is-active');
      this.style.background = 'rgba(31,200,195,0.15)';
      this.style.color = 'var(--accent)';
      const target = $('#' + tab);
      if (target) target.style.display = 'block';
    });
  });

  /* Filter events for commissions */
  $('#commFilterBroker')?.addEventListener('change', loadPendingCommissions);
  $('#commFilterOwner')?.addEventListener('change', loadPendingCommissions);
  $('#commFilterStatus')?.addEventListener('change', loadPendingCommissions);

  /* Generate Liquidation button: agrupa comisiones pendientes del período por broker+propietario */
  $('#btnGenerateLiquidation')?.addEventListener('click', async () => {
    const periodStart = prompt('Fecha inicio (YYYY-MM-DD):', new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toISOString().split('T')[0]);
    if (!periodStart) return;
    const periodEnd = prompt('Fecha fin (YYYY-MM-DD):', new Date(new Date().getFullYear(), new Date().getMonth(), 0).toISOString().split('T')[0]);
    if (!periodEnd) return;
    if (!window.supabaseClient) return;
    try {
      const { data: pending, error } = await window.supabaseClient
        .from('commissions')
        .select('*')
        .eq('status', 'pendiente')
        .gte('due_date', periodStart)
        .lte('due_date', periodEnd);
      if (error) throw error;
      if (!pending?.length) {
        showToast('No hay comisiones pendientes en ese período', 'info');
        return;
      }

      const groups = {};
      pending.forEach(c => {
        const key = (c.broker_id || 'sin-broker') + '|' + (c.owner_id || 'sin-propietario');
        if (!groups[key]) groups[key] = { broker_id: c.broker_id || null, owner_id: c.owner_id || null, items: [] };
        groups[key].items.push(c);
      });

      let created = 0;
      for (const g of Object.values(groups)) {
        const gross_usd = g.items.reduce((s, c) => s + (c.commission_amount_usd || 0), 0);
        const gross_ars = g.items.reduce((s, c) => s + (c.commission_amount_ars || 0), 0);
        const iibb = g.items.reduce((s, c) => s + (c.iibb_amount_ars || 0), 0);
        const ganancias = g.items.reduce((s, c) => s + (c.ganancias_amount_ars || 0), 0);
        const net = g.items.reduce((s, c) => s + (c.net_amount_ars || (c.commission_amount_ars || 0) - (c.iibb_amount_ars || 0) - (c.ganancias_amount_ars || 0)), 0);

        const { data: liq, error: liqErr } = await window.supabaseClient
          .from('commission_liquidations')
          .insert([{
            period_start: periodStart, period_end: periodEnd,
            broker_id: g.broker_id, owner_id: g.owner_id,
            gross_commission_usd: gross_usd, gross_amount_ars: gross_ars,
            iibb_retention_ars: iibb, ganancias_retention_ars: ganancias,
            net_amount_ars: net, status: 'confirmada', created_by: currentUser?.id || null
          }])
          .select('id')
          .single();
        if (liqErr) throw liqErr;

        const ids = g.items.map(c => c.id);
        const { error: upErr } = await window.supabaseClient
          .from('commissions')
          .update({ status: 'liquidada', liquidation_id: liq.id })
          .in('id', ids);
        if (upErr) throw upErr;
        created++;
      }

      showToast(`${created} liquidación(es) generada(s) sobre ${pending.length} comisión(es)`, 'success');
      await loadLiquidations();
      await loadPendingCommissions();
      await updateCommissionsKPI();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });

  /* Commission actions */
  window.adminApp.markCommissionPaid = async function(id) {
    if (!confirm('¿Marcar comisión como pagada? Se registrará el pago correspondiente.')) return;
    try {
      const { data: c, error: fetchErr } = await window.supabaseClient.from('commissions').select('*').eq('id', id).single();
      if (fetchErr) throw fetchErr;
      const paidDate = new Date().toISOString().split('T')[0];
      await mutate('commissions', async () => {
        const { error } = await window.supabaseClient.from('commissions').update({ status: 'pagada', paid_date: paidDate, updated_at: new Date().toISOString() }).eq('id', id);
        if (error) throw error;
      });
      const net = c.net_amount_ars || ((c.commission_amount_ars || 0) - (c.iibb_amount_ars || 0) - (c.ganancias_amount_ars || 0));
      await mutate('commission_payments', async () => {
        const { error } = await window.supabaseClient.from('commission_payments').insert([{
          commission_id: id, liquidation_id: c.liquidation_id || null,
          broker_id: c.broker_id || null, owner_id: c.owner_id || null,
          amount_ars: net, payment_method: 'transferencia', payment_date: paidDate,
          reference: 'Pago directo comisión', created_by: currentUser?.id || null
        }]);
        if (error) throw error;
      });
      showToast('Comisión marcada como pagada', 'success');
      await loadPendingCommissions();
      await loadPayments();
      await updateCommissionsKPI();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.adminApp.viewCommissionLiquidation = async function(id) {
    if (!window.supabaseClient) return;
    try {
      const { data: c, error } = await window.supabaseClient
        .from('commissions')
        .select('*, owners(full_name, bank_name, cbu_cvu, alias_cbu), properties(property_code, title), agents(full_name)')
        .eq('id', id)
        .single();
      if (error) throw error;
      const net = c.net_amount_ars || ((c.commission_amount_ars || 0) - (c.iibb_amount_ars || 0) - (c.ganancias_amount_ars || 0));
      const statusLabel = { pendiente: 'Pendiente', liquidada: 'Liquidada', pagada: 'Pagada', cancelada: 'Cancelada' }[c.status] || c.status;
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Comisión ${c.id.slice(0,8)}</title>
        <style>body{font-family:Inter,sans-serif;padding:24px;color:#1a1a2e;} h1{border-bottom:2px solid #1fc8c3;padding-bottom:8px;font-size:20px;}
        .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;margin-top:12px;} .label{color:#666;} @media print{body{padding:0;}</style>
        </head><body>
        <h1>Detalle de Comisión</h1>
        <div class="grid">
          <div><span class="label">Estado:</span> ${esc(statusLabel)}</div>
          <div><span class="label">Operación:</span> ${esc(c.operation_type === 'venta' ? 'Venta' : 'Alquiler')}/div>
          <div><span class="label">Propietario:</span> ${esc(c.owners?.full_name || '—')}</div>
          <div><span class="label">Broker:</span> ${esc(c.agents?.full_name || '—')}</div>
          <div><span class="label">Propiedad:</span> ${esc(c.properties?.title || c.properties?.property_code || '—')}</div>
          <div><span class="label">Vencimiento:</span> ${c.due_date ? new Date(c.due_date + 'T00:00:00').toLocaleDateString('es-AR') : '—'}</div>
          <div><span class="label">Monto USD:</span> USD ${Number(c.commission_amount_usd || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</div>
          <div><span class="label">Monto ARS:</span> $ ${formatNumber(c.commission_amount_ars || 0)}</div>
          <div><span class="label">IIBB (${c.iibb_rate || 0}%):</span> $ ${formatNumber(c.iibb_amount_ars || 0)}</div>
          <div><span class="label">Ganancias (${c.ganancias_rate || 0}%):</span> $ ${formatNumber(c.ganancias_amount_ars || 0)}</div>
          <div style="font-weight:700;"><span class="label">Neto a pagar:</span> $ ${formatNumber(net)}</div>
          ${c.paid_date ? `<div><span class="label">Pagada el:</span> ${new Date(c.paid_date + 'T00:00:00').toLocaleDateString('es-AR')}</div>` : ''}
          ${c.liquidation_id ? `<div><span class="label">Liquidación:</span> ${c.liquidation_id.slice(0,8)}</div>` : ''}
        </div>
        ${c.owners ? `<div style="margin-top:16px; padding-top:12px; border-top:1px solid #eee; font-size:12px;">
          <strong>Datos de pago del propietario:</strong> ${esc(c.owners.bank_name || '—')} · CBU/CVU ${esc(c.owners.cbu_cvu || '—')} · Alias ${esc(c.owners.alias_cbu || '—')}
        </div>` : ''}
        <script>window.print();</script>
        </body></html>`;
      const w = window.open('', '_blank');
      w.document.write(html);
      w.document.close();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.adminApp.viewLiquidationPDF = async function(id) {
    if (!window.supabaseClient) return;
    try {
      const { data: l, error } = await window.supabaseClient
        .from('commission_liquidations')
        .select('*, agents(full_name), owners(full_name, bank_name, cbu_cvu, alias_cbu)')
        .eq('id', id)
        .single();
      if (error) throw error;
      const { data: items } = await window.supabaseClient
        .from('commissions')
        .select('*, properties(property_code, title)')
        .eq('liquidation_id', id);
      const statusLabel = { borrador: 'Borrador', confirmada: 'Confirmada', pagada: 'Pagada' }[l.status] || l.status;
      const itemRows = (items || []).map(c => `
        <tr>
          <td>${esc(c.properties?.property_code || c.properties?.title || '—')}</td>
          <td>${esc(c.operation_type)}</td>
          <td style="text-align:right;">USD ${Number(c.commission_amount_usd || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
          <td style="text-align:right;">$ ${formatNumber(c.commission_amount_ars || 0)}</td>
          <td style="text-align:right;">$ ${formatNumber(c.iibb_amount_ars || 0)}</td>
          <td style="text-align:right;">$ ${formatNumber(c.ganancias_amount_ars || 0)}</td>
          <td style="text-align:right;">$ ${formatNumber(c.net_amount_ars || (c.commission_amount_ars || 0) - (c.iibb_amount_ars || 0) - (c.ganancias_amount_ars || 0))}</td>
        </tr>`).join('');
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Liquidación ${new Date(l.period_start + 'T00:00:00').toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })}</title>
        <style>body{font-family:Inter,sans-serif;padding:24px;color:#1a1a2e;} h1{border-bottom:2px solid #1fc8c3;padding-bottom:8px;font-size:20px;}
        table{width:100%;border-collapse:collapse;margin-top:16px;font-size:12px;} th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;}
        .total{font-weight:700;background:#f5f5f5;} @media print{body{padding:0;}}</style>
        </head><body>
        <h1>Liquidación de Comisiones — ${esc(statusLabel)}</h1>
        <p style="font-size:13px;">
          <strong>Período:</strong> ${new Date(l.period_start + 'T00:00:00').toLocaleDateString('es-AR')} al ${new Date(l.period_end + 'T00:00:00').toLocaleDateString('es-AR')}<br>
          <strong>Broker:</strong> ${esc(l.agents?.full_name || '—')} &nbsp;·&nbsp; <strong>Propietario:</strong> ${esc(l.owners?.full_name || '—')}
        </p>
        <table>
          <thead><tr><th>Propiedad</th><th>Operación</th><th>Monto USD</th><th>Monto ARS</th><th>IIBB</th><th>Ganancias</th><th>Neto</th></tr></thead>
          <tbody>${itemRows || '<tr><td colspan="7">Sin comisiones asociadas</td></tr>'}</tbody>
          <tfoot><tr class="total"><td colspan="2">Totales</td><td style="text-align:right;">USD ${Number(l.gross_commission_usd || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td><td style="text-align:right;">$ ${formatNumber(l.gross_amount_ars || 0)}</td><td style="text-align:right;">$ ${formatNumber(l.iibb_retention_ars || 0)}</td><td style="text-align:right;">$ ${formatNumber(l.ganancias_retention_ars || 0)}</td><td style="text-align:right;">$ ${formatNumber(l.net_amount_ars || 0)}</td></tr></tfoot>
        </table>
        ${l.owners ? `<p style="margin-top:16px; font-size:12px;"><strong>Datos de pago:</strong> ${esc(l.owners.bank_name || '—')} · CBU/CVU ${esc(l.owners.cbu_cvu || '—')} · Alias ${esc(l.owners.alias_cbu || '—')}</p>` : ''}
        <script>window.print();</script>
        </body></html>`;
      const w = window.open('', '_blank');
      w.document.write(html);
      w.document.close();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.adminApp.markLiquidationPaid = async function(id) {
    if (!confirm('¿Marcar liquidación como pagada? Se marcarán sus comisiones y se registrará el pago.')) return;
    try {
      const { data: l, error: fetchErr } = await window.supabaseClient.from('commission_liquidations').select('*').eq('id', id).single();
      if (fetchErr) throw fetchErr;
      const { error } = await window.supabaseClient.from('commission_liquidations').update({ status: 'pagada', updated_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
      const paidDate = new Date().toISOString().split('T')[0];
      await window.supabaseClient.from('commissions').update({ status: 'pagada', paid_date: paidDate, updated_at: new Date().toISOString() }).eq('liquidation_id', id);
      await window.supabaseClient.from('commission_payments').insert([{
        liquidation_id: id, broker_id: l.broker_id || null, owner_id: l.owner_id || null,
        amount_ars: l.net_amount_ars || 0, payment_method: 'transferencia', payment_date: paidDate,
        reference: 'Pago liquidación', created_by: currentUser?.id || null
      }]);
      showToast('Liquidación marcada como pagada', 'success');
      await loadLiquidations();
      await loadPayments();
      await loadPendingCommissions();
      await updateCommissionsKPI();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  window.adminApp.deletePayment = async function(id) {
    if (!confirm('¿Eliminar este pago?')) return;
    try {
      await mutate('commission_payments', async () => {
        const { error } = await window.supabaseClient.from('commission_payments').delete().eq('id', id);
        if (error) throw error;
      });
      showToast('Pago eliminado', 'success');
      await loadPayments();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  };

  /* Create owner */
  on($('#btnNewOwner'), 'click', () => {
    editingOwnerId = null;
    $('#ownerForm')?.reset();
    const title = $('#ownerModalTitle');
    if (title) title.textContent = 'Expediente de Propietario';
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
          const { error } = await window.supabaseClient.from('owners').insert([data]);
          if (error) throw error;
        });
        showToast('Propietario creado', 'success');
      }

      closeModal('ownerModal');
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
      if (title) title.textContent = 'Editar Propietario';

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
    } catch (err) {
      showToast('Error al cargar propietario', 'error');
    }
  };

  /* Generate Portal Link for Owner */
  window.adminApp.generateOwnerPortalLink = async function() {
    if (!editingOwnerId) return showToast('Primero guarde el propietario', 'warning');
    if (!window.supabaseClient) return;
    try {
      const token = crypto.randomUUID();
      const { error } = await window.supabaseClient
        .from('owner_portal_tokens')
        .upsert([{
          owner_id: editingOwnerId,
          token: token,
          scopes: ['read_properties', 'read_commissions', 'read_documents'],
          created_by: currentUser?.id || null
        }], { onConflict: 'owner_id' });
      if (error) throw error;
      const portalUrl = `${window.location.origin}/portal-propietario.html?token=${token}`;
      navigator.clipboard.writeText(portalUrl).then(() => {
        showToast('Link de portal copiado al portapapeles: ' + portalUrl, 'success', 8000);
      }).catch(() => {
        showToast('Link generado: ' + portalUrl + ' (copie manualmente)', 'info', 8000);
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

      list.innerHTML = requirements.map(req => {
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
        const doc = {
          id: crypto.randomUUID(),
          name: file.name,
          type: file.type,
          size: file.size,
          url: urlData.publicUrl,
          uploaded_at: new Date().toISOString(),
          expiry: null
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
    if (!confirm('¿Eliminar este propietario? Se archivará su expediente (soft delete).')) return;
    try {
      const { error } = await window.supabaseClient.from('owners').update({ deleted_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
      showToast('Propietario eliminado', 'success');
      loadOwners();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

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
      const w = window.open('', '_blank');
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
    if (
      !window.confirm(
        nextActive
          ? `¿Reactivar el acceso de ${label}?`
          : `¿Desactivar el acceso de ${label}? No podrá volver a iniciar sesión.`,
      )
    ) {
      return;
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
    const fullName = String(fd.get('full_name') || '').trim();
    const email = String(fd.get('email') || '').trim().toLowerCase();
    const phone = String(fd.get('phone') || '').trim();
    const row = usersCache.find((u) => u.id === userId);
    if (!userId || !row) return;

    const isSelf = userId === currentProfile.id;
    const isAdmin = canManageUsers();

    /* Sin rol admin solo hay autogestion: defensa extra junto al backend. */
    if (!isAdmin && !isSelf) {
      showToast('Solo podés editar tu propio usuario.', 'error');
      return;
    }
    if (!fullName) {
      showToast('El nombre completo es obligatorio', 'error');
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

    /* Get published property count + portal settings from DB */
    const [propsRes, settingsRes] = await Promise.all([
      window.supabaseClient.from('properties').select('*', { count: 'exact', head: true }).eq('is_published', true),
      window.supabaseClient.from('portal_settings').select('portal_name, is_active'),
    ]);

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
        const mlBtnHtml = ml_connected
          ? `<button class="btn-action danger" style="font-size:11px; padding:6px 12px;" onclick="window.adminApp.mlDisconnect()"><i class="fas fa-link-slash"></i> Desconectar</button>`
          : ml_configured
            ? `<button class="btn-action" style="font-size:11px; padding:6px 12px; background:rgba(255,230,0,0.15); color:#FFE600; border:1px solid rgba(255,230,0,0.3);" onclick="window.adminApp.mlConnect()"><i class="fas fa-link"></i> Conectar ML</button>`
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
        <div style="display:flex; align-items:center; justify-content:center; gap:10px; margin-top:12px;">
          ${mlBtnHtml}
          ${!ml_configured ? `<button class="btn-action" title="Configurar credenciales" style="font-size:11px; padding:6px 12px;" onclick="window.adminApp.mlToggleConfig()"><i class="fas fa-cog"></i></button>` : ''}
          ${ml_connected ? `<button class="btn-action" title="Importar desde ML" style="font-size:11px; padding:6px 12px;" onclick="window.adminApp.mlImportFromML()"><i class="fas fa-file-import"></i></button>` : ''}
        </div>
        ${configPanelHtml}
      </div>`;
      }

      return `
      <div class="glass-panel portal-card" style="padding:24px; text-align:center;">
        <div style="width:56px; height:56px; border-radius:16px; background:${p.color}20; display:flex; align-items:center; justify-content:center; margin:0 auto 14px;">
          <i class="${p.icon}" style="font-size:24px; color:${p.color};"></i>
        </div>
        <h3 style="color:#fff; font-size:16px; font-weight:700; margin-bottom:4px;">${p.name}</h3>
        <p style="color:var(--text-dim); font-size:12px; margin-bottom:14px;">${count} inmuebles publicables</p>
        <div style="display:flex; align-items:center; justify-content:center; gap:10px;">
          <label class="toggle-switch${isActive ? ' is-active' : ''}" onclick="this.classList.toggle('is-active'); window.adminApp.togglePortal('${p.name}', this.classList.contains('is-active'))">
            <input type="checkbox" ${isActive ? 'checked' : ''} style="opacity:0; width:0; height:0; position:absolute;" />
          </label>
          <button class="btn-action" title="Configurar API" onclick="window.adminApp.openPortalConfig(${i})"><i class="fas fa-cog"></i></button>
        </div>
      </div>`;
    }).join('');

    loadRelaPanel();
  }

  window.adminApp.togglePortal = async function (portalName, isActive) {
    try {
      const { error } = await window.supabaseClient
        .from('portal_settings')
        .upsert({ portal_name: portalName, is_active: isActive }, { onConflict: 'portal_name' });
      if (error) throw error;
      showToast(`${portalName} ${isActive ? 'activado' : 'desactivado'}`, 'success');
    } catch (err) {
      showToast('Error al actualizar portal: ' + err.message, 'error');
      loadPortals();
    }
  };

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
        Object.keys(data).forEach(key => {
          if (key !== 'portal_name' && key !== 'is_active' && key !== 'id') {
            const input = $(`#portalField_${key}`);
            if (input) input.value = data[key] || '';
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
        if (input) upsertData[f.name] = input.value?.trim() || '';
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

  /* Sync all button */
  on($('#syncAllBtn'), 'click', () => {
    showToast('Sincronización iniciada — próximamente', 'info');
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

  // Mapeo action -> endpoint. Las nuevas funciones separadas (ml-publish, ml-portal-status,
  // ml-disconnect) reciben paths limpios; el resto cae al multiplexor legacy ml-api.
  const ML_FUNCTION_PATHS = {
    'publish': 'ml-publish',
    'portal-status': 'ml-portal-status',
    'disconnect': 'ml-disconnect',
  };

  async function mlApiCall(action, body = {}) {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) throw new Error('No hay sesión activa');
    if (!window.BH_CONFIG?.SUPABASE_URL) throw new Error('Configuración de Supabase no disponible (BH_CONFIG)');

    const fnPath = ML_FUNCTION_PATHS[action] || `ml-api?action=${encodeURIComponent(action)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ML_API_TIMEOUT_MS);
    try {
      const res = await fetch(`${ML_FUNCTIONS_BASE}/${fnPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Error ML API (${res.status})`);
      return json;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Tiempo de espera agotado al contactar Mercado Libre');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function mlCheckStatus() {
    try {
      const result = await mlApiCall('portal-status');
      ml_connected = !!result.connected;
      ml_configured = !!result.configured;
      ml_user = result.user || null;
      ml_listings = Array.isArray(result.listings) ? result.listings : [];
    } catch (err) {
      console.warn('[ML] Status check failed:', err.message);
      ml_connected = false;
      ml_configured = false;
      ml_user = null;
      ml_listings = [];
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
      if (!res.ok) throw new Error(result.error || 'Error al generar URL de autenticación');
      const authUrl = result.authorizationUrl || result.authUrl;
      if (!authUrl) throw new Error('ml-oauth/start no devolvió authorizationUrl');

      /* Open popup for OAuth flow */
      const width = 800, height = 600;
      const left = (screen.width - width) / 2;
      const top = (screen.height - height) / 2;
      const popup = window.open(authUrl, 'ml_oauth',
        `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`);

      /* Listen for message from ml-callback Edge Function */
      const handler = async (event) => {
        if (event.data?.type === 'ML_AUTH_SUCCESS') {
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
    if (!confirm('¿Desconectar la cuenta de Mercado Libre? Se perderán las credenciales de acceso.')) return;
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
    if (!confirm('¿Publicar esta propiedad en Mercado Libre?')) return;

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

      if (!confirm('¿Publicar esta propiedad en Mercado Libre?')) return;

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
    if (!confirm('¿Actualizar esta propiedad en Mercado Libre?')) return;
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
  window.adminApp.mlRemoveProperty = async function (listingId) {
    if (!confirm('¿Eliminar esta propiedad de Mercado Libre?')) return;
    try {
      showToast('Eliminando de Mercado Libre...', 'info');
      await mlApiCall('remove', { listing_id: listingId });
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
    if (!confirm('¿Importar propiedades desde Mercado Libre? Se crearán como borradores en el sistema.')) return;

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
    const res = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/rela-proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({ action, ...body }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
    return json;
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
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            ${status?.dry_run ? '<span class="nav-badge" style="background:rgba(255,184,0,0.15); color:var(--warning); font-size:11px;"><i class="fas fa-flask"></i> DRY-RUN activo</span>' : ''}
            <button class="btn-action" onclick="window.adminApp.relaSyncCatalogs()"><i class="fas fa-rotate"></i> Catálogos</button>
            <button class="btn-action" onclick="window.adminApp.relaReconcile()"><i class="fas fa-arrows-rotate"></i> Reconciliar</button>
            <button class="btn-action" onclick="window.adminApp.openRelaConfig()"><i class="fas fa-cog"></i> Configurar</button>
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
    const pageSize = $('#tasacionesPageSize');
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
      const [propsRes, ownersRes] = await Promise.all([
        propIds.length ? window.supabaseClient.from('properties').select('id, code, title').in('id', propIds) : { data: [] },
        ownerIds.length ? window.supabaseClient.from('owners').select('id, full_name').in('id', ownerIds) : { data: [] }
      ]);
      const propMap = new Map((propsRes.data || []).map(p => [p.id, p]));
      const ownerMap = new Map((ownersRes.data || []).map(o => [o.id, o]));

      /* Update pagination UI */
      const totalPages = Math.ceil(_tasacionesTotalCount / _tasacionesPageSize);
      if (pageInfo) pageInfo.textContent = `Página ${_tasacionesPage} de ${totalPages || 1}`;
      if (pagePrev) pagePrev.disabled = _tasacionesPage <= 1;
      if (pageNext) pageNext.disabled = _tasacionesPage >= totalPages;

      if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--text-dim);">No hay tasaciones registradas</td></tr>';
        return;
      }

      tbody.innerHTML = data.map(t => {
        const statusLabel = t.status === 'finalized' ? 'Finalizada' : 'Borrador';
        const statusClass = t.status === 'finalized' ? 'active' : 'pending';
        const date = t.created_at ? new Date(t.created_at).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
        const prop = t.property_id ? propMap.get(t.property_id) : null;
        const propName = prop ? (prop.code ? prop.code + ' - ' + (prop.title || '') : (prop.title || '')) : '-';
        const owner = t.owner_id ? ownerMap.get(t.owner_id) : null;
        const ownerName = owner ? (owner.full_name || '-') : '-';
        const typeLabel = t.type === 'venta' ? 'Venta' : t.type === 'alquiler' ? 'Alquiler' : t.type || '-';
        let valuation = t.valuation_usd;
        if (!valuation && t.data && typeof t.data === 'object') {
          valuation = t.data.valuation_usd || t.data.final_valuation || null;
        }
        const valuationStr = valuation ? '$ ' + Number(valuation).toLocaleString('es-AR') : '-';
        return `<tr>
          <td style="font-weight:600; color:#fff;">${esc(t.title || 'Sin título')}</td>
          <td style="color:var(--text-muted); font-size:13px;">${esc(propName)}</td>
          <td style="color:var(--text-muted); font-size:13px;">${esc(ownerName)}</td>
          <td style="color:var(--accent); font-weight:600; font-size:13px;">${valuationStr}</td>
          <td><span class="status-pill" style="background:rgba(201,169,110,0.12); color:#c9a96e;">${esc(typeLabel)}</span></td>
          <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
          <td style="color:var(--text-muted); font-size:13px;">${date}</td>
          <td>
            <button class="icon-badge-btn" title="Abrir" data-open-tasacion="${esc(t.id)}" data-tasacion-title="${esc(t.title || '')}"><i class="fas fa-external-link-alt"></i></button>
            <button class="icon-badge-btn" title="Exportar PDF" data-pdf-tasacion="${esc(t.id)}" data-tasacion-title="${esc(t.title || '')}"><i class="fas fa-file-pdf" style="color:var(--danger);"></i></button>
            <button class="icon-badge-btn" title="Eliminar" data-del-tasacion="${esc(t.id)}"><i class="fas fa-trash" style="color:var(--danger);"></i></button>
          </td>
        </tr>`;
      }).join('');

      /* Pagination controls */
      on(pagePrev, 'click', () => { if (_tasacionesPage > 1) { _tasacionesPage--; loadTasaciones(); } });
      on(pageNext, 'click', () => { const totalPages = Math.ceil(_tasacionesTotalCount / _tasacionesPageSize); if (_tasacionesPage < totalPages) { _tasacionesPage++; loadTasaciones(); } });
      on(pageSize, 'change', () => { _tasacionesPageSize = parseInt(pageSize.value); _tasacionesPage = 1; loadTasaciones(); });

    } catch (err) {
      logError('loadTasaciones error:', err);
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--danger);">Error al cargar tasaciones</td></tr>';
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
    window.open(url, '_blank');
  }

  /* ------------------------------------------------
     Security: delegated handlers (sin onclick inline; datos externos viajan en data-* esc()'
     ------------------------------------------------ */
  on($('#propertiesTableBody'), 'click', (e) => {
    const upd = e.target.closest('[data-ml-update-prop]');
    if (upd) { window.adminApp.mlUpdateProperty(upd.dataset.mlUpdateProp, upd.dataset.mlListing || ''); return; }
    const rem = e.target.closest('[data-ml-remove]');
    if (rem) { window.adminApp.mlRemoveProperty(rem.dataset.mlListing || ''); return; }
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
    const btn = e.target.closest('.preview-remove');
    if (btn) btn.closest('.image-preview-item')?.remove();
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
        window.supabaseClient.from('properties').select('id, code, title').is('deleted_at', null).order('code'),
        window.supabaseClient.from('owners').select('id, full_name').is('deleted_at', null).order('full_name')
      ]);
      propSelect.innerHTML = '<option value="">Sin vincular</option>' +
        (propsRes.data || []).map(p => '<option value="' + esc(p.id) + '">' + esc(p.code || '') + ' - ' + esc(p.title || '') + '</option>').join('');
      ownerSelect.innerHTML = '<option value="">Sin vincular</option>' +
        (ownersRes.data || []).map(o => '<option value="' + esc(o.id) + '">' + esc(o.full_name || '') + '</option>').join('');
    } catch (_) { /* silent: dropdowns stay with defaults */ }
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
    const { data, error } = await window.supabaseClient.from('leads').select('*').order('created_at', { ascending: false });
    if (error) { showToast('Error exportando: ' + error.message, 'error'); return; }
    const headers = ['ID', 'Nombre', 'Email', 'Teléfono', 'Mensaje', 'Propiedad', 'Estado', 'Fecha'];
    const rows = data.map(function(l) {
      return [l.id, l.name, l.email, l.phone, l.message, l.property_title, l.status, l.created_at];
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
      propIds.length ? window.supabaseClient.from('properties').select('id, code, title').in('id', propIds) : { data: [] },
      ownerIds.length ? window.supabaseClient.from('owners').select('id, full_name').in('id', ownerIds) : { data: [] }
    ]);
    const propMap = new Map((propsRes.data || []).map(p => [p.id, p]));
    const ownerMap = new Map((ownersRes.data || []).map(o => [o.id, o]));
    const headers = ['ID', 'Título', 'Tipo', 'Estado', 'Propiedad', 'Propietario', 'Valor Estimado (USD)', 'Fecha creación', 'Última edición'];
    const rows = data.map(function(t) {
      const prop = t.property_id ? propMap.get(t.property_id) : null;
      const propName = prop ? (prop.code || '') + ' - ' + (prop.title || '') : '';
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
  let _chatPlatformFilter = 'all';
  let _chatSearchTerm = '';
  let _chatUnreadTotal = 0;
  let _pendingSendTempId = null;
  let _chatListenersBound = false;
  document.body.dataset.bhBeforeLoadChatRedes = 'true';

async function loadChatRedes() {
    if (!currentUser || !window.supabaseClient) return;
    if (!['super_admin', 'broker'].includes(currentProfile?.role)) {
      showToast('Acceso denegado: solo super_admin y brokers', 'error');
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
          .select('id, account_id, contact_name, contact_handle, last_message_at, last_message_preview, unread_count, status')
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
      let conversations = convs || [];
      if (!conversations.length) {
        listEl.innerHTML = '<div class="chat-empty" style="text-align:center; padding:40px 20px; color:var(--text-dim);">No hay conversaciones</div>';
        return;
      }

      // Filtrar
      if (_chatSearchTerm) {
        conversations = conversations.filter(c =>
          (c.contact_name || '').toLowerCase().includes(_chatSearchTerm) ||
          (c.contact_handle || '').toLowerCase().includes(_chatSearchTerm)
        );
      }
      if (_chatPlatformFilter !== 'all') {
        conversations = conversations.filter(c => {
          const acc = accounts?.find(a => a.zernio_account_id === c.account_id);
          return acc?.platform === _chatPlatformFilter;
        });
      }

      _chatUnreadTotal = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
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
      if (error || !data) return;

      _chatCurrentConv = data;

      // UI
      headerEl.style.display = 'flex';
      composerEl.style.display = 'block';
      document.querySelector('.chat-empty')?.remove();

      const acc = data.account;
      contactNameEl.textContent = data.contact_name || 'Sin nombre';
      platformBadgeEl.innerHTML = getPlatformIcon(data.account?.platform) + ' ' + (data.account?.platform || '—');
      accountBadgeEl.textContent = data.account?.username ? '@' + data.account.username : '—';

      // Marcar leído
      if (data.unread_count > 0) {
        await markRead(convId);
        data.unread_count = 0;
      }

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
            const { data: lead, error } = await window.supabaseClient
              .from('leads')
              .insert([{
                full_name: _chatCurrentConv.contact_name || 'Sin nombre',
                phone: _chatCurrentConv.contact_handle || '',
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
            <div class="chat-bubble ${isOut ? 'out' : 'in'}" style="
              display:flex; flex-direction:column; max-width:75%; ${isOut ? 'align-self:flex-end; margin-left:auto;' : 'align-self:flex-start; margin-right:auto;'}
            ">
              <div style="background:${isOut ? 'var(--accent)' : 'rgba(255,255,255,0.05)'}; color:${isOut ? '#fff' : '#fff'}; padding:10px 14px; border-radius:${isOut ? '18px 18px 4px 18px' : '18px 18px 18px 4px'}; max-width:100%; word-wrap:break-word;">
                ${esc(m.body || '')}
              </div>
              <div style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:10px; color:var(--text-dim); ${isOut ? 'justify-content:flex-end;' : ''}">
                <span>${new Date(m.occurred_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</span>
                ${isOut ? `<span class="tick-icon">${ticks}</span>` : ''}
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

    async function sendMessage() {
      if (!_chatCurrentConv || !composerTextarea) return;
      const text = composerTextarea.value.trim();
      if (!text) return;

      composerTextarea.value = '';
      composerTextarea.style.height = 'auto';

      // Optimistic UI
      const tempId = 'temp_' + Date.now();
      _pendingSendTempId = tempId;
      appendMessage({ body: text, direction: 'out', occurred_at: new Date().toISOString(), status: 'sending', id: tempId });
      messagesEl.scrollTop = messagesEl.scrollHeight;

      try {
        const session = await window.supabaseClient.auth.getSession();
        const res = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/zernio-proxy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.data.session?.access_token}`
          },
          body: JSON.stringify({ action: 'send_message', conversationId: _chatCurrentConv.id, text })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error enviando');

        if (data.window_closed) {
          showToast('Ventana de 24h de WhatsApp cerrada: puede requerir plantilla aprobada', 'warning');
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
            ticksEl.className = 'tick-icon';
            const footerRow = tempEl.querySelector('div:last-child');
            footerRow?.appendChild(ticksEl);
          }
          ticksEl.style.color = 'var(--danger)';
          ticksEl.textContent = '?';
          tempEl.title = err.message;
        }
      }
    }

    async function markReadCurrent() {
      if (!_chatCurrentConv) return;
      await markRead(_chatCurrentConv.id);
    }

    async function markRead(convId) {
      try {
        const { data: { session } } = await window.supabaseClient.auth.getSession();
        await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/zernio-proxy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
          body: JSON.stringify({ action: 'mark_read', conversationId: convId })
        });
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
      const ticks = m.status === 'sent' ? '?' : m.status === 'delivered' ? '??' : m.status === 'read' ? '??' : '?';
      const div = document.createElement('div');
      div.className = 'chat-bubble ' + (m.direction === 'out' ? 'out' : 'in');
      div.dataset.tempId = m.id;
      div.style.cssText = `display:flex; flex-direction:column; max-width:75%; ${m.direction === 'out' ? 'align-self:flex-end; margin-left:auto;' : 'align-self:flex-start; margin-right:auto;'}`;
      div.innerHTML = `
        <div style="background:${m.direction === 'out' ? 'var(--accent)' : 'rgba(255,255,255,0.05)'}; color:#fff; padding:10px 14px; border-radius:${m.direction === 'out' ? '18px 18px 4px 18px' : '18px 18px 18px 4px'}; max-width:100%; word-wrap:break-word;">
          ${esc(m.body || '')}
        </div>
        <div style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:10px; color:var(--text-dim); ${m.direction === 'out' ? 'justify-content:flex-end;' : ''}">
          <span>${new Date(m.occurred_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</span>
          ${m.direction === 'out' ? `<span class="tick-icon">${ticks}</span>` : ''}
        </div>
      `;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function getTicks(status) {
      if (status === 'read') return '??';
      if (status === 'delivered') return '??';
      if (status === 'sent') return '?';
      return '?';
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
      const tables = ['visits', 'leads', 'properties', 'agents', 'owners', 'tasaciones', 'commissions', 'commission_liquidations', 'commission_payments'];
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
          if (!_chatCurrentConv || m.conversation_id !== _chatCurrentConv.id) {
            loadConversations(); // actualizar badge
            return;
          }
          // Si es el eco del mensaje que acabamos de enviar de forma optimista,
          // sacamos la burbuja temporal y dejamos que se agregue la real (con ticks reales).
          if (m.direction === 'out' && _pendingSendTempId) {
            const tempEl = messagesEl.querySelector(`[data-temp-id="${_pendingSendTempId}"]`);
            if (tempEl) tempEl.remove();
            _pendingSendTempId = null;
          }
          // Evitar duplicados si el mensaje ya está renderizado
          if (messagesEl.querySelector(`[data-temp-id="${m.id}"]`)) return;
          appendMessage(m);
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'zernio_messages' }, payload => {
          const m = payload.new;
          if (!_chatCurrentConv || m.conversation_id !== _chatCurrentConv.id) return;
          // Actualizar ticks
          const el = messagesEl.querySelector(`[data-temp-id="${m.id}"]`) || messagesEl.querySelector(`[data-msg-id="${m.id}"]`);
          if (el) {
            const ticksEl = el.querySelector('.tick-icon');
            if (ticksEl) ticksEl.textContent = getTicks(m.status);
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'zernio_conversations' }, () => {
          loadConversations();
        })
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

  async function getSearchCache() {
    if (_searchCache && Date.now() < _searchCacheExpiresAt) return _searchCache;
    const empty = { properties: [], leads: [], agents: [], owners: [], visits: [], tasaciones: [], profiles: [], conversations: [] };
    if (!window.supabaseClient) return empty;

    /* Promise.allSettled: si un módulo falla o falta permiso RLS, los demás siguen funcionando */
    const requests = [
      ['properties', window.supabaseClient.from('properties').select('id, title, zone, address, price_usd, status').is('deleted_at', null).order('created_at', { ascending: false }).limit(200)],
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

  /* Resalta la coincidencia con <mark> sobre texto YA escapado (CSP/XSS safe) */
  function gsHighlight(text, q) {
    const safe = esc(String(text ?? ''));
    if (!q) return safe;
    const needle = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      return safe.replace(new RegExp('(' + needle + ')', 'gi'), '<mark>$1</mark>');
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
      if (ownersEl) ownersEl.textContent = (counts.owners || 0) + ' Activos';
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
      const severityLabels = { critical: '?? Crítica', high: '?? Alta' };
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
    const unseenCount = _notifItems.filter(n => n.ts > lastSeen).length;
    if (pingEl) pingEl.style.display = unseenCount > 0 ? 'block' : 'none';

    if (!_notifItems.length) {
      listEl.innerHTML = '<div class="notif-empty"><i class="far fa-bell-slash"></i><span>Sin novedades por ahora</span></div>';
      return;
    }

    listEl.innerHTML = _notifItems.map(n => {
      const isUnread = n.ts > lastSeen;
      const bg = n.color.startsWith('#') ? n.color + '20' : 'rgba(31,200,195,0.15)';
      return `
        <div class="notif-item${isUnread ? ' is-unread' : ''}" data-tab="${esc(n.tab)}">
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
      renderNotifications();
    });

    panel.addEventListener('click', (e) => {
      const item = e.target.closest('.notif-item');
      if (!item) return;
      if (item.dataset.tab) {
        navigateTo(item.dataset.tab);
        // Si es supervisión y tiene vista específica, cambiar sub-tab
        if (item.dataset.tab === 'tab-supervision' && item._supView) {
          setTimeout(() => switchSupView(item._supView), 100);
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
    if (!currentUser || !window.supabaseClient) return;
    
    // Check super_admin role
    if (currentProfile?.role !== 'super_admin') {
      showToast('Acceso denegado: solo Super Admin', 'error');
      navigateTo('tab-dashboard');
      return;
    }

    // Initialize sub-tab listeners
    initSupSubTabs();
    
    // Load initial data
    await refreshSupervisionKPIs();
    await loadSupUsersDropdown();
    await loadSupModulesDropdown();
    
    // Start auto-refresh if enabled
    if (_supAutoRefresh) startSupAutoRefresh();
    
    // Setup Realtime for audit_log and supervision_alerts
    setupSupRealtime();
    
    // Initialize executive dashboard date defaults
    const now = new Date();
    const monthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    const today = new Date();
    $('#execFromDate').value = monthAgo.toISOString().split('T')[0];
    $('#execToDate').value = today.toISOString().split('T')[0];
    
    // Load executive dashboard if it's the current view
    if (_supCurrentView === 'executive') {
      await loadExecutiveDashboard();
    }
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
    const tabs = $$('.sup-subtab');
    tabs.forEach(tab => {
      if (tab.dataset.supBound) return;
      tab.dataset.supBound = 'true';
      tab.addEventListener('click', () => switchSupView(tab.dataset.view));
    });

    // Toolbar buttons
    on($('#supRefreshBtn'), 'click', () => refreshSupervisionKPIs());
    on($('#supAutoRefreshBtn'), 'click', toggleSupAutoRefresh);
    on($('#supExportBtn'), 'click', exportSupervisionCSV);
    on($('#supExportAnomaliesBtn'), 'click', exportAnomaliesCSV);

    // Timezone selector
    on($('#supTimezoneFilter'), 'change', (e) => {
      setSupTimezone(e.target.value);
    });

    // Anomalies toolbar
    on($('#anomRefreshBtn'), 'click', () => loadAnomaliesTable());
    on($('#anomExportBtn'), 'click', exportAnomaliesCSV);
    on($('#anomTimeWindow'), 'change', () => {
      _anomTimeWindow = $('#anomTimeWindow').value;
      loadAnomaliesTable();
    });
    on($('#anomSeverityFilter'), 'change', () => {
      _anomSeverityFilter = $('#anomSeverityFilter').value;
      loadAnomaliesTable();
    });
  }

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
      const severityLabels = { critical: '?? Crítica', high: '?? Alta', medium: '?? Media', low: '?? Baja', info: '? Info' };
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
@media print{body{background:#fff;padding:0}.ficha-sheet{width:100%;box-shadow:none}.ficha-photo-grid{grid-template-columns:repeat(3,1fr);gap:14px}.ficha-site-footer{break-inside:avoid}}
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
        const mlStatus = hashParams.get('ml');
        if (!mlStatus) return;
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
      const q = String(rawQuery || '').toLowerCase().trim();
      const resultsContainer = $('#globalSearchResults');
      if (!resultsContainer) return;
      if (!q || q.length < 2) { resultsContainer.innerHTML = ''; resultsContainer.style.display = 'none'; _gsActiveIndex = -1; return; }

      const cache = await getSearchCache();
      if (myRun !== _gsRunId) return;
      const results = [];

      if ('ficha'.startsWith(q) || q.includes('ficha')) {
        results.push({ icon: 'fas fa-file-export', text: 'Módulo Ficha HTML', sub: 'Generador de fichas por propiedad', tab: 'tab-ficha-html', color: '#14B8A6', action: () => navigateTo('tab-ficha-html') });
      }

      const matches = (fields) => fields.some(f => f && f.toLowerCase().includes(q));

      for (const p of cache.properties) {
        if (!matches([p.title, p.zone, p.address])) continue;
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
              window.supabaseClient.from('properties').select('id, title, property_code, zone, address, price_usd, rooms, area_m2, description, image_urls, agent_id').order('created_at', { ascending: false }),
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
        window.supabaseClient.from('leads').select('id, stage, created_at, budget_usd').in('stage', ['cerrado']).gte('closed_at', _execFromDate).lte('closed_at', _execToDate),
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

      // KPI: Conversión Lead?Cierre
      const totalLeads = leads.length;
      const totalClosed = closed.length;
      const convRate = totalLeads > 0 ? ((totalClosed / totalLeads) * 100).toFixed(1) : 0;
      setKPI('execConvRate', convRate + '%');

      // KPI: Tiempo medio cierre
      if (closed.length > 0) {
        const closeTimes = closed.map(l => {
          const created = new Date(l.created_at).getTime();
          const closedAt = new Date(l.closed_at || l.updated_at).getTime();
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
      const contactedLeads = leads.filter(l => ['contactado', 'visita', 'oferta', 'cerrado'].includes(l.stage)).length;
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
        window.supabaseClient.from('leads').select('closed_at').in('stage', ['cerrado']).gte('closed_at', new Date(_execFromDate).toISOString()).lte('closed_at', new Date(_execToDate).toISOString())
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
          closed: closed.filter(c => c.closed_at >= start && c.closed_at < end).length
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
        .in('stage', ['visita', 'oferta'])
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
              <div style="font-weight:600; color:#fff;">${i + 1}. ${l.full_name || 'Sin nombre'}</div>
              <div style="font-size:11px; color:var(--text-dim);">${l.stage} • ${l.property_id ? 'Con propiedad' : 'Sin propiedad'}</div>
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
        window.supabaseClient.from('leads').select('closed_at, budget_usd').eq('stage', 'cerrado').gte('closed_at', new Date(now.getFullYear(), now.getMonth() - 11, 1).toISOString()),
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
        const mClosed = closed.filter(c => c.closed_at >= start && c.closed_at < end);
        const mProps = props.filter(p => p.created_at >= start && p.created_at < end);

        const totalValue = mClosed.reduce((sum, c) => sum + (c.budget_usd || 0), 0);
        const convRate = mLeads.length > 0 ? ((mClosed.length / mLeads.length) * 100).toFixed(1) : 0;
        const avgCloseTime = mClosed.length > 0 ? 
          (mClosed.reduce((sum, c) => sum + (new Date(c.closed_at || c.updated_at).getTime() - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24), 0) / mClosed.length).toFixed(1) : 0;
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
  const dataActionWhitelist = ['exportPropertiesCSV', 'exportLeadsCSV', 'exportTasacionesCSV', 'exportSupOverviewCSV', 'exportSupAlertsCSV', 'exportSupUsersCSV', 'exportSupModulesCSV', 'loadMoreSupAudit', 'loadMoreSupAlerts', 'closeSupUserDetail', 'loadMoreAnomalies', 'closeSupAuditDetail', 'simulateSupRule', 'closeCdnWarning'];
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


