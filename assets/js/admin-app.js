/* ============================================================
   BIENENHAUS PROPIEDADES — Admin Panel App (Luxury v2)
   Matches admin.html luxury design system
   ============================================================ */

const _usdFormatter = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const _numFormatter = new Intl.NumberFormat('es-AR');

(function () {
  'use strict';
  console.log('[BH] IIFE STARTED');
  document.body.dataset.bhIifeStarted = 'true';

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

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
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
     1. AUTH
     ------------------------------------------------ */
  async function initAuth() {
    if (!window.supabaseClient) {
      console.error('[BH] Supabase client not available — CDN may be blocked by browser extension');
      const loginScreen = $('#loginScreen');
      const errorEl = $('#loginError');
      if (loginScreen) loginScreen.classList.remove('is-hidden');
      if (errorEl) { errorEl.textContent = 'Error: No se pudo conectar. Desactivá el bloqueador de anuncios para este sitio.'; errorEl.style.display = 'block'; }
      hidePreloader();
      return;
    }

    try {
      console.log('[BH] initAuth: checking session...');
      /* Link de invitacion: #access_token=..&type=invite. Capturo el
         fragmento ANTES de getSession porque supabase-js lo consume y
         crea la sesion durante su inicializacion; el hash se limpia
         recien despues, para no romper esa deteccion. */
      const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
      const isInviteLink = hashParams.get('type') === 'invite';
      const inviteError = hashParams.get('error_description');

      const { data: { session } } = await window.supabaseClient.auth.getSession();
      console.log('[BH] initAuth: session exists =', !!session);

      if (hashParams.get('access_token') || inviteError) {
        window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
      }

      if (session) {
        console.log('[BH] initAuth: calling showApp()');
        currentUser = session.user;
        showApp();
        loadProfile().then(updateUserInfo).catch(() => {});
        if (isInviteLink && !inviteError) {
          openInvitePasswordModal(session.user?.email || '');
        }
      } else {
        console.log('[BH] initAuth: calling showLogin() - no session');
        showLogin();
        if (inviteError) {
          showToast('El enlace de invitación es inválido o ya expiró.', 'error');
        }
      }
    } catch (err) {
      console.error('Auth init error:', err);
      showLogin();
    }

    window.supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        currentUser = session.user;
        showApp();
        loadProfile().then(updateUserInfo).catch(() => {});
      } else if (event === 'SIGNED_OUT') {
        currentUser = null;
        currentProfile = null;
        showLogin();
      }
    });
  }

  async function loadProfile() {
    if (!currentUser) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', currentUser.id)
        .single();
      if (error) throw error;
      currentProfile = data;

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
        const { error: syncErr } = await window.supabaseClient
          .from('profiles')
          .update({ email: sessionEmail })
          .eq('id', currentUser.id);
        if (!syncErr) currentProfile.email = sessionEmail;
      }

      /* Con perfil y rol ya resueltos: el guard de Configuración evalúa contra el rol real. */
      loadConfig();
    } catch (err) {
      console.error('Error loading profile:', err);
      currentProfile = null;
      showToast('No se pudieron cargar los permisos. Acceso denegado.', 'error');
      setTimeout(() => { window.supabaseClient.auth.signOut(); }, 2000);
    }
  }

  function showLogin() {
    console.log('[BH] showLogin() called');
    const loginScreen = $('#loginScreen');
    const appLayout = $('#appLayout');
    if (loginScreen) loginScreen.classList.remove('is-hidden');
    if (appLayout) appLayout.style.display = 'none';
    hidePreloader();
    console.log('[BH] showLogin() finished, preloader hidden');
  }

  function showApp() {
    console.log('[BH] showApp() called');
    const loginScreen = $('#loginScreen');
    const appLayout = $('#appLayout');
    const wasHidden = !appLayout || appLayout.style.display === 'none' || appLayout.style.display === '';
    if (loginScreen) loginScreen.classList.add('is-hidden');
    if (appLayout) appLayout.style.display = 'flex';
    hidePreloader();
    console.log('[BH] showApp() finished, preloader hidden');
    updateUserInfo();
    updateSidebarBadges();
    mlCheckStatus().catch(() => {});
    if (wasHidden) navigateTo('tab-dashboard');
  }

  function hidePreloader() {
    console.log('[BH] hidePreloader() called');
    document.body.classList.remove('is-loading');
    const preloader = $('#preloader');
    if (preloader) preloader.classList.add('is-hidden');
    console.log('[BH] hidePreloader() finished', { bodyClasses: document.body.className, preloaderClasses: preloader?.className });
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
    await window.supabaseClient.auth.signOut();
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
    if (!window.supabaseClient) return;
    try {
      const [propsRes, leadsRes, visitsRes, agentsRes] = await Promise.all([
        window.supabaseClient.from('properties').select('price_usd, zone, status, is_published, created_at'),
        window.supabaseClient.from('leads').select('stage, created_at'),
        window.supabaseClient.from('visits').select('*').order('visit_date', { ascending: true }).limit(5),
        window.supabaseClient.from('agents').select('*').eq('status', 'activo'),
      ]);

      const props = propsRes.data || [];
      const leads = leadsRes.data || [];
      const visits = visitsRes.data || [];
      const agents = agentsRes.data || [];

      /* KPIs */
      const totalValue = props.reduce((sum, p) => sum + (p.price_usd || 0), 0);
      const activeProps = props.filter(p => p.is_published && p.status !== 'vendido' && p.status !== 'alquilado').length;
      const avgTicket = activeProps > 0 ? Math.round(totalValue / activeProps) : 0;
      const activeLeads = leads.filter(l => !['cerrado', 'perdido'].includes(l.stage)).length;
      const upcomingVisits = visits.filter(v => v.status === 'pendiente' || v.status === 'confirmada').length;

      setKPI('kpiVolumen', 'USD ' + formatNumber(totalValue));
      setKPI('kpiActivas', activeProps);
      setKPI('kpiTicket', 'USD ' + formatNumber(avgTicket));
      setKPI('kpiLeads', activeLeads);
      setKPI('kpiVisitas', upcomingVisits);
      setKPI('kpiBrokers', agents.length);

      /* Zone progress */
      renderZoneProgress(props);

      /* Dashboard widgets */
      renderDashVisits(visits);
      renderDashLeads(leads);
      renderDashBrokers(agents);
    } catch (err) {
      console.error('Dashboard error:', err);
    }
  }

  function setKPI(id, value) {
    const el = $(`#${id}`);
    if (el) el.textContent = typeof value === 'number' ? value.toLocaleString('es-AR') : value;
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
    const tbody = $('#propertiesTableBody');
    if (!tbody) return;
    if (!window.supabaseClient) return;

    try {
      const [propsRes, listingsRes] = await Promise.all([
        window.supabaseClient.from('properties').select('*').order('created_at', { ascending: false }),
        ml_connected
          ? window.supabaseClient.from('ml_listings').select('property_id, ml_listing_id, status')
          : Promise.resolve({ data: [] }),
      ]);

      const data = propsRes.data;
      const error = propsRes.error;
      if (error) throw error;

      const mlMap = {};
      (listingsRes.data || []).forEach(l => { mlMap[l.property_id] = l; });

      if (!data?.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--text-dim);">No hay propiedades cargadas</td></tr>';
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
          mlButtons = `<button class="btn-action" style="font-size:11px; color:#FFE600;" title="Publicar en ML" data-ml-publish="${esc(p.id)}"><i class="fab fa-mercarto-libre"></i></button>`;
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
                <div style="font-weight:600; color:#fff; font-size:13.5px;">${esc(p.title || 'Sin título')}${mlBadge}</div>
                <div style="color:var(--text-dim); font-size:12px; margin-top:2px;"><i class="fas fa-location-dot" style="margin-right:4px;"></i>${esc(loc || 'Sin ubicación')}</div>
              </div>
            </div>
          </td>
          <td style="font-size:13px;">${p.area_m2 ? p.area_m2 + ' m²' : '-'}</td>
          <td style="font-size:13px;">${p.rooms || '-'}</td>
          <td style="font-weight:600; color:var(--accent); font-size:13.5px;">${formatPrice(p.price_usd)}</td>
          <td><span class="nav-badge" style="background:${p.status === 'venta' ? 'rgba(31,200,195,0.15)' : 'rgba(255,184,0,0.15)'}; color:${p.status === 'venta' ? 'var(--accent)' : 'var(--warning)'}; font-size:11px;">${esc(p.status || 'venta')}</span></td>
          <td><span class="nav-badge" style="background:${p.is_published ? 'rgba(0,200,120,0.15)' : 'rgba(255,255,255,0.06)'}; color:${p.is_published ? 'var(--success)' : 'var(--text-dim)'}; font-size:11px;">${p.is_published ? 'Publicada' : 'Borrador'}</span></td>
          <td>
            <div style="display:flex; gap:6px; align-items:center;">
              ${mlButtons}
              <button class="btn-action" title="Editar" onclick="window.adminApp.editProperty('${p.id}')"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteProperty('${p.id}')"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>`;
      }).join('');
    } catch (err) {
      console.error('Error loading properties:', err);
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--danger);">Error al cargar propiedades</td></tr>';
    }
  }

  /* Create button */
  $('#btnNewProp')?.addEventListener('click', () => {
    editingPropertyId = null;
    resetPropertyForm();
    openModal('propertyModal');
  });

  /* Topbar create button */
  $('#topbarNewProp')?.addEventListener('click', () => {
    editingPropertyId = null;
    resetPropertyForm();
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

  /* Save property */
  $('#propertyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_submittingProperty) return;
    _submittingProperty = true;
    const btn = $('#propertySaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const formData = new FormData(e.target);
      const data = {
        title: formData.get('title') || '',
        description: formData.get('description') || '',
        price_usd: parseFloat(formData.get('price_usd')) || 0,
        property_type: formData.get('property_type') || '',
        zone: formData.get('zone') || '',
        address: formData.get('address') || '',
        bedrooms: parseInt(formData.get('bedrooms')) || 0,
        bathrooms: parseInt(formData.get('bathrooms')) || 0,
        area_m2: parseFloat(formData.get('area_m2')) || 0,
        garage_spaces: parseInt(formData.get('garage_spaces')) || 0,
        rooms: parseInt(formData.get('rooms')) || 0,
        status: formData.get('status') || 'venta',
        is_published: formData.get('is_published') === 'on',
        featured: formData.get('featured') === 'on',
        created_by: currentUser?.id || null, // para trigger property_code
      };

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
        const { error } = await window.supabaseClient
          .from('properties')
          .update(data)
          .eq('id', editingPropertyId);
        if (error) throw error;
        showToast('Propiedad actualizada correctamente', 'success');
      } else {
        const { error } = await window.supabaseClient
          .from('properties')
          .insert([data]);
        if (error) throw error;
        showToast('Propiedad creada correctamente', 'success');
      }

      closeModal('propertyModal');
      loadProperties();
      updateSidebarBadges();
    } catch (err) {
      console.error('Error saving property:', err);
      showToast('Error al guardar: ' + err.message, 'error');
    } finally {
      _submittingProperty = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Inmueble'; }
    }
  });

  /* Edit property */
  window.adminApp = window.adminApp || {};
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
        form.elements.title.value = data.title || '';
        form.elements.description.value = data.description || '';
        form.elements.price_usd.value = data.price_usd || '';
        form.elements.property_type.value = data.property_type || '';
        form.elements.status.value = data.status || 'venta';
        form.elements.zone.value = data.zone || '';
        form.elements.address.value = data.address || '';
        form.elements.bedrooms.value = data.bedrooms || '';
        form.elements.bathrooms.value = data.bathrooms || '';
        form.elements.area_m2.value = data.area_m2 || '';
        form.elements.garage_spaces.value = data.garage_spaces || '';
        form.elements.rooms.value = data.rooms || '';
        form.elements.is_published.checked = data.is_published || false;
        form.elements.featured.checked = data.featured || false;

        // Código de propiedad (solo lectura en edición)
        const codeInput = $('#propCode');
        if (codeInput) {
          codeInput.value = data.property_code || '';
          codeInput.setAttribute('readonly', 'readonly');
        }

        const previews = $('#imagePreviewGrid');
        if (previews && data.image_urls?.length) {
          previews.innerHTML = data.image_urls.map(url => `
            <div class="image-preview-item" style="position:relative; width:80px; height:80px; border-radius:8px; overflow:hidden; border:1px solid var(--border-subtle);">
              <img src="${esc(url)}" alt="" style="width:100%; height:100%; object-fit:cover;" />
              <input type="hidden" name="existing_image_urls" value="${esc(url)}" />
              <button type="button" class="preview-remove" style="position:absolute; top:4px; right:4px; width:20px; height:20px; border-radius:50%; background:rgba(0,0,0,0.7); color:#fff; border:none; cursor:pointer; font-size:10px; display:flex; align-items:center; justify-content:center;"><i class="fas fa-times"></i></button>
            </div>
          `).join('');
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
  $('#propSearchInput')?.addEventListener('input', (e) => {
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

  /* ------------------------------------------------
     7. CRM — LEADS PIPELINE
     ------------------------------------------------ */
  console.log('[BH] MIDPOINT REACHED - LEADS section');
  async function loadCRM() {
    if (!window.supabaseClient) return;
    try {
      /* Traer leads y sus visitas (próximas y última) en una sola query */
      const [{ data: leads, error: leadsErr }, { data: visits, error: visitsErr }] = await Promise.all([
        window.supabaseClient.from('leads').select('*').order('created_at', { ascending: false }),
        window.supabaseClient.from('visits')
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
        const stage = lead.stage || 'nuevo';
        if (groups[stage]) groups[stage].push(lead);
      });

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

        var htmlParts = [];
        leadsArr.forEach(function(l) {
          var leadVisits = visitsByLead[l.id] || [];
          var upcomingVisit = leadVisits.find(function(v) { return v.status === 'pendiente' || v.status === 'confirmada'; });
          var hasFutureVisit = !!upcomingVisit;
          var showScheduleBtn = (l.stage === 'contactado' || l.stage === 'visita') && !hasFutureVisit;

          var visitInfo = '';
          if (upcomingVisit) {
            var badgeColor = upcomingVisit.status === 'confirmada' ? 'rgba(0,200,120,0.2)' : 'rgba(255,184,0,0.2)';
            var badgeTextColor = upcomingVisit.status === 'confirmada' ? 'var(--success)' : 'var(--warning)';
            var visitDate = new Date(upcomingVisit.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
            visitInfo = '<div style="margin-top:6px; padding:6px 8px; background:rgba(31,200,195,0.08); border-radius:4px; font-size:11px; color:var(--accent); display:flex; align-items:center; gap:6px;">' +
              '<i class="fas fa-calendar-day"></i>' +
              '<span>' + esc(visitDate) + '</span>' +
              '<span class="nav-badge" style="font-size:9px; background:' + badgeColor + '; color:var(--success);">' + esc(upcomingVisit.status) + '</span>' +
              '</div>';
          }

          var scheduleBtn = '';
          if (showScheduleBtn) {
            scheduleBtn = '<button class="btn-action" style="padding:4px 8px; font-size:10px; margin-top:8px; width:100%; background:rgba(31,200,195,0.15); color:var(--accent); border:1px solid var(--accent);" ' +
              'onclick="event.stopPropagation(); window.adminApp.openVisitModal({ lead_id: \'' + esc(l.id) + '\', client_name: \'' + esc(l.full_name) + '\', client_phone: \'' + esc(l.phone || l.whatsapp || '') + '\', property_id: \'' + esc(l.property_id || '') + '\' })">' +
              '<i class="fas fa-calendar-plus"></i> Agendar visita' +
              '</button>';
          }

          var budgetHtml = l.budget_usd ? '<div style="color:var(--accent); font-size:12px; font-weight:500;">USD ' + l.budget_usd.toLocaleString('es-AR') + '</div>' : '';
          var prefType = l.preferred_type ? l.preferred_type.charAt(0).toUpperCase() + l.preferred_type.slice(1) : '';
          var prefZone = l.preferred_zone ? '· ' + esc(l.preferred_zone) : '';
          var createdDate = new Date(l.created_at).toLocaleDateString('es-AR');

          var cardHtml =
            '<div class="lead-card" style="background:var(--surface-2); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:14px; margin-bottom:10px; cursor:pointer;" onclick="window.adminApp.editLead(\'' + esc(l.id) + '\')">' +
            '<div style="font-weight:600; color:#fff; font-size:13px; margin-bottom:4px;">' + esc(l.full_name || 'Sin nombre') + '</div>' +
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
      console.error('CRM error:', err);
    }
  }

  /* Create lead */
  $('#btnNewLead')?.addEventListener('click', () => {
    editingLeadId = null;
    $('#leadForm')?.reset();
    openModal('leadModal');
  });

  /* Save lead */
  let _submittingLead = false;
  $('#leadForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_submittingLead) return;
    _submittingLead = true;
    const btn = $('#leadSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const formData = new FormData(e.target);
      const data = {
        full_name: formData.get('full_name') || '',
        phone: formData.get('phone') || '',
        email: formData.get('email') || '',
        budget_usd: parseFloat(formData.get('budget_usd')) || 0,
        stage: formData.get('stage') || 'nuevo',
        preferred_type: formData.get('preferred_type') || '',
        preferred_zone: formData.get('preferred_zone') || '',
        notes: formData.get('notes') || '',
      };

      if (editingLeadId) {
        const { error } = await window.supabaseClient.from('leads').update(data).eq('id', editingLeadId);
        if (error) throw error;
        showToast('Lead actualizado', 'success');
      } else {
        const { error } = await window.supabaseClient.from('leads').insert([data]);
        if (error) throw error;
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
        form.elements.full_name.value = lead.full_name || '';
        form.elements.phone.value = lead.phone || '';
        form.elements.email.value = lead.email || '';
        form.elements.budget_usd.value = lead.budget_usd || '';
        form.elements.stage.value = lead.stage || 'nuevo';
        form.elements.preferred_type.value = lead.preferred_type || '';
        form.elements.preferred_zone.value = lead.preferred_zone || '';
        form.elements.notes.value = lead.notes || '';
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
              Sin visitas asociadas. <button class="btn-action" style="padding:2px 8px; font-size:10px; margin-left:8px;" onclick="event.stopPropagation(); window.adminApp.openVisitModal({ lead_id: '${editingLeadId}', client_name: '${esc(lead.full_name)}', client_phone: '${esc(lead.phone || lead.whatsapp || '')}', property_id: '${lead.property_id || ''}' })"><i class="fas fa-calendar-plus"></i> Agendar primera visita</button>
            </div>`;
        }
      }

      openModal('leadModal');
    } catch (err) {
      console.error('Error al cargar lead:', err);
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
    const tbody = $('#visitsTableBody');
    if (!tbody) return;
    if (!window.supabaseClient) return;

    try {
      /* JOIN con leads para mostrar nombre del lead y link a CRM */
      const { data, error } = await window.supabaseClient
        .from('visits')
        .select('*, leads!left(id, full_name, stage)')
        .order('visit_date', { ascending: true });

      if (error) throw error;

      calVisitsCache = data || [];
      renderCalendar();

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
      console.error('Visits error:', err);
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--danger);">Error al cargar visitas</td></tr>';
    }
  }

  /* ========== CALENDARIO AGENDA ========== */
  let calCurrentDate = new Date();
  let calVisitsCache = [];
  let calViewMode = 'table';

  function renderCalendar() {
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
    const monthVisits = calVisitsCache.filter(v => {
      if (!v.visit_date) return false;
      const d = new Date(v.visit_date);
      if (d.getFullYear() !== calCurrentDate.getFullYear() || d.getMonth() !== calCurrentDate.getMonth()) return false;
      if (statusFilter && v.status !== statusFilter) return false;
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
    renderCalendar(calVisitsCache);
  });
  $('#calTodayBtn')?.addEventListener('click', function() {
    calCurrentDate = new Date();
    renderCalendar(calVisitsCache);
  });
  $('#calStatusFilter')?.addEventListener('change', function() {
    renderCalendar(calVisitsCache);
  });

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

    return `
      <tr>
        <td style="font-size:13px;">${dateStr}</td>
        <td style="font-size:13px; font-weight:500;">${esc(v.client_name || 'Sin cliente')}</td>
        <td style="font-size:13px; color:var(--text-dim);">${leadLink}</td>
        <td style="font-size:13px; color:var(--text-dim);">${v.property_id ? '✓' : '—'}</td>
        <td><span class="nav-badge" style="background:${v.status === 'confirmada' ? 'rgba(0,200,120,0.15)' : v.status === 'completada' ? 'rgba(31,200,195,0.15)' : 'rgba(255,184,0,0.15)'}; color:${v.status === 'confirmada' ? 'var(--success)' : v.status === 'completada' ? 'var(--accent)' : 'var(--warning)'}; font-size:11px;">${esc(v.status || 'pendiente')}</span></td>
        <td style="font-size:12px; color:var(--text-dim);">${v.lead_id ? '✓' : '—'}</td>
        <td>
          <div style="display:flex; gap:6px;">
            <button class="btn-action" title="Editar" onclick="window.adminApp.editVisit('${v.id}')"><i class="fas fa-pen"></i></button>
            <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteVisit('${v.id}')"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>`;
  }

  function filterVisitsByDate(dateStr) {
    const tbody = $('#visitsTableBody');
    if (!tbody) return;
    const dayVisits = calVisitsCache.filter(v => {
      if (!v.visit_date) return false;
      const dv = new Date(v.visit_date);
      const ds = dv.getFullYear() + '-' + String(dv.getMonth() + 1).padStart(2, '0') + '-' + String(dv.getDate()).padStart(2, '0');
      return ds === dateStr;
    });
    tbody.innerHTML = dayVisits.length
      ? dayVisits.map(visitRowHtml).join('')
      : '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--text-dim);">No hay visitas en esta fecha</td></tr>';
    calViewMode = 'table';
    updateViewToggle();
  }

  /* Create visit */
  $('#btnNewVisit')?.addEventListener('click', () => {
    editingVisitId = null;
    $('#visitForm')?.reset();
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
    if (prefill.property_id) {
      const el = document.querySelector('#visitForm [name="property_id"]');
      if (el) el.value = prefill.property_id;
    }
    if (prefill.lead_id) {
      /* El selector se creará en editVisit al abrir modal, pero para nueva visita
         necesitamos setear el lead_id después de que se cree el selector.
         Usamos un flag temporal. */
      window._pendingLeadId = prefill.lead_id;
    }

    openModal('visitModal');
  };

  /* Save visit */
  let _submittingVisit = false;
  $('#visitForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_submittingVisit) return;
    _submittingVisit = true;
    const btn = $('#visitSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const formData = new FormData(e.target);
      const oldStatus = editingVisitId
        ? (await window.supabaseClient.from('visits').select('status, lead_id').eq('id', editingVisitId).single()).data?.status
        : null;
      const oldLeadId = editingVisitId
        ? (await window.supabaseClient.from('visits').select('lead_id').eq('id', editingVisitId).single()).data?.lead_id
        : null;

      const formDataObj = new FormData(e.target);
      const data = {
        visit_date: formDataObj.get('visit_date') || null,
        status: formDataObj.get('status') || 'pendiente',
        client_name: formDataObj.get('client_name') || '',
        client_phone: formDataObj.get('client_phone') || '',
        notes: formDataObj.get('notes') || '',
        lead_id: formDataObj.get('lead_id') || null,
      };

      const newStatus = data.status;
      const newLeadId = data.lead_id;
      const leadIdChanged = oldLeadId !== newLeadId;

      if (editingVisitId) {
        const { error } = await window.supabaseClient.from('visits').update(data).eq('id', editingVisitId);
        if (error) throw error;
        showToast('Visita actualizada', 'success');
      } else {
        const { error } = await window.supabaseClient.from('visits').insert([data]);
        if (error) throw error;
        showToast('Visita agendada', 'success');
      }

      /* Prompt: visita completada → mover lead a Oferta */
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

      /* Si se asignó lead_id nuevo (era NULL) → el trigger DB actualizará lead a "visita" */
      /* Si se quitó lead_id (era valor → NULL) → no hacemos nada en lead */

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
        if (data.visit_date) {
          const d = new Date(data.visit_date);
          form.elements.visit_date.value = d.toISOString().slice(0, 16);
        }
        form.elements.status.value = data.status || 'pendiente';
        form.elements.client_name.value = data.client_name || '';
        form.elements.client_phone.value = data.client_phone || '';
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
              if (l.property_id) opt.textContent += ' 🏠';
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
                  ${leadData.property_id ? ' · <span style="color:var(--accent);">🏠 Propiedad asignada</span>' : ' · <span style="color:var(--warning);">⚠️ Sin propiedad asignada</span>'}
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
      console.error('Error al cargar visita:', err);
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
      console.error('CMS error:', err);
    }
  }

  function populateCMSFields() {
    $$('.cms-field[data-key]').forEach(input => {
      const key = input.dataset.key;
      const mapping = CMS_FIELD_MAP[key];
      if (mapping && cmsData[mapping.section]) {
        const content = cmsData[mapping.section].content || {};
        input.value = content[mapping.path] || '';
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

  $('#cmsSaveBtn')?.addEventListener('click', async () => {
    const btn = $('#cmsSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const fields = $$('.cms-field[data-key]');
      const updatesBySection = {};

      fields.forEach(field => {
        const key = field.dataset.key;
        const mapping = CMS_FIELD_MAP[key];
        if (!mapping) return;
        if (!updatesBySection[mapping.section]) updatesBySection[mapping.section] = {};
        updatesBySection[mapping.section][mapping.path] = field.value;
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

  /* Reset CMS to reload from DB */
  $('#cmsResetBtn')?.addEventListener('click', async () => {
    if (!confirm('¿Restaurar los contenidos desde la base de datos?')) return;
    await loadCMS();
    showToast('Contenidos restaurados', 'success');
  });

  const heroBgFile = $('#cmsHeroBgFile');
  const heroBgPreview = $('#cmsHeroBgPreview');
  const heroBgHidden = $('#cms_hero_bg');

  $('#cmsHeroBgUpload')?.addEventListener('click', () => heroBgFile?.click());

  heroBgFile?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Solo se permiten imágenes', 'error'); return; }

    try {
      heroBgPreview.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Subiendo...</span>';
      if (!window.BH_Cloudinary) { showToast('Cloudinary no disponible', 'error'); return; }
      const url = await window.BH_Cloudinary.uploadImage(file, 'bienenhaus/hero');
      if (heroBgHidden) heroBgHidden.value = url;
      heroBgPreview.innerHTML = '<img src="' + esc(url) + '" alt="Hero background" /><span style="position:absolute;bottom:2px;right:2px;font-size:9px;background:rgba(0,0,0,.7);padding:2px 5px;border-radius:3px;">Cloudinary ✓</span>';
      heroBgPreview.style.position = 'relative';
      showToast('Imagen subida a Cloudinary', 'success');
    } catch (err) {
      console.error('Upload error:', err);
      heroBgPreview.innerHTML = '<i class="fas fa-cloud-arrow-up"></i><span>Error al subir</span>';
      showToast('Error al subir imagen: ' + err.message, 'error');
    }
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
    address:          { section: 'contact', path: 'address' },
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
    if (!window.supabaseClient) return;
    try {
      const [{ data: rows, error }, prefRes, zernioRes] = await Promise.all([
        window.supabaseClient.from('site_content').select('*').in('section_key', ['contact', 'footer', 'social']),
        window.supabaseClient.from('app_settings').select('*'),
        window.supabaseClient.from('zernio_config').select('value').eq('key', 'api_key').maybeSingle()
      ]);
      if (error) throw error;
      if (!prefRes.error && Array.isArray(prefRes.data)) {
        const prefs = prefRes.data.find(r => r.key === 'preferences');
        const rateInput = $('#cfg_usd_rate');
        if (prefs?.value && typeof prefs.value.usd_rate === 'number' && rateInput) rateInput.value = prefs.value.usd_rate;
      }
      if (zernioRes.data?.value?.key) {
        const keyInput = $('#cfg_zernio_api_key');
        if (keyInput) keyInput.value = zernioRes.data.value.key;
      }
      cfgData = {};
      (rows || []).forEach(item => { cfgData[item.section_key] = item; });
      populateCfgFields();
      applyCfgGuard();
      renderCfgStatus();
      renderCfgSession();
    } catch (err) {
      console.error('Config error:', err);
      showToast('Error al cargar configuración: ' + err.message, 'error');
    }
  }

  $('#cfgSaveBtn')?.addEventListener('click', async () => {
    const btn = $('#cfgSaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';
    try {
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
          // Guardar Zernio API Key en zernio_config
          const apiKey = newFields.api_key?.trim();
          if (apiKey) {
            const { error } = await window.supabaseClient
              .from('zernio_config')
              .upsert({ key: 'api_key', value: { key: apiKey }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
            if (error) throw error;
          }
          return;
        }
        const existing = cfgData[sectionKey];
        const mergedContent = { ...(existing?.content || {}), ...newFields };
        if (existing) {
          const { error } = await window.supabaseClient
            .from('site_content').update({ content: mergedContent }).eq('id', existing.id);
          if (error) throw error;
          existing.content = mergedContent;
        } else {
          const { data, error } = await window.supabaseClient
            .from('site_content').insert([{ section_key: sectionKey, content: mergedContent }]).select().single();
          if (error) throw error;
          cfgData[sectionKey] = data;
        }
      }));

      const { error: upErr } = await window.supabaseClient
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
  $('#toggleZernioKey')?.addEventListener('click', () => {
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

  $('#btnTestZernio')?.addEventListener('click', async () => {
    const btn = $('#btnTestZernio');
    const statusEl = $('#zernioTestStatus');
    const keyInput = $('#cfg_zernio_api_key');
    const apiKey = keyInput?.value?.trim();
    if (!apiKey) { statusEl.textContent = '⚠ Ingresá tu API Key primero'; statusEl.style.color = 'var(--warning)'; return; }
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
      statusEl.textContent = '✓ Conectado · ' + data.count + ' cuenta(s) sincronizada(s)';
      statusEl.style.color = 'var(--success)';
    } catch (err) {
      statusEl.textContent = '✗ ' + err.message;
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
    const tbody = $('#agentsTableBody');
    if (!tbody) return;
    if (!window.supabaseClient) return;

    try {
      const { data, error } = await window.supabaseClient
        .from('agents')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) throw error;

      if (!data?.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim);">No hay agentes cargados</td></tr>';
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
          <td><span class="nav-badge" style="background:${a.status === 'activo' ? 'rgba(0,200,120,0.15)' : 'rgba(255,255,255,0.06)'}; color:${a.status === 'activo' ? 'var(--success)' : 'var(--text-dim)'}; font-size:11px;">${esc(a.status || 'activo')}</span></td>
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
      console.error('Agents error:', err);
    }
  }

  /* Create agent */
  $('#btnNewAgent')?.addEventListener('click', () => {
    editingAgentId = null;
    $('#agentForm')?.reset();
    const title = $('#agentModalTitle');
    if (title) title.textContent = 'Registrar Asesor / Broker';
    openModal('agentModal');
  });

  /* Save agent */
  $('#agentForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_submittingAgent) return;
    _submittingAgent = true;
    const btn = $('#agentSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const formData = new FormData(e.target);
      const data = {
        full_name: formData.get('full_name') || '',
        email: formData.get('email') || '',
        phone: formData.get('phone') || '',
        matricula: formData.get('matricula') || '',
        bio: formData.get('bio') || '',
        status: formData.get('status') || 'activo',
      };

      const photoFile = formData.get('photo_file');
      if (photoFile && photoFile.size > 0) {
        data.photo_url = await uploadToCloudinary(photoFile);
      }

      if (editingAgentId) {
        if (!data.photo_url) delete data.photo_url;
        const { error } = await window.supabaseClient.from('agents').update(data).eq('id', editingAgentId);
        if (error) throw error;
        showToast('Agente actualizado', 'success');
      } else {
        const { error } = await window.supabaseClient.from('agents').insert([data]);
        if (error) throw error;
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
        form.elements.status.value = data.status || 'activo';
      }
      const title = $('#agentModalTitle');
      if (title) title.textContent = 'Editar Agente';
      openModal('agentModal');
    } catch (err) {
      showToast('Error al cargar agente', 'error');
    }
  };

  /* Delete agent */
  window.adminApp.deleteAgent = async function (id) {
    if (!confirm('¿Eliminar este agente?')) return;
    try {
      const { error } = await window.supabaseClient.from('agents').delete().eq('id', id);
      if (error) throw error;
      showToast('Agente eliminado', 'success');
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
    const tbody = $('#ownersTableBody');
    if (!tbody) return;
    if (!window.supabaseClient) return;

    try {
      const { data: owners, error } = await window.supabaseClient
        .from('owners')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) throw error;

      /* Load property counts per owner for KPIs */
      const { data: props } = await window.supabaseClient
        .from('properties')
        .select('owner_id, price_usd, is_published');

      const ownerProps = {};
      (props || []).forEach(p => {
        if (p.owner_id) {
          ownerProps[p.owner_id] = (ownerProps[p.owner_id] || 0) + 1;
        }
      });

      /* KPIs */
      const totalCount = (owners || []).length;
      const exclusiveCount = (owners || []).filter(o => o.exclusive).length;
      setKPI('ownerKpiTotal', totalCount);
      setKPI('ownerKpiExpiring', exclusiveCount);

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
      console.error('Owners error:', err);
    }
  }

  /* Create owner */
  $('#btnNewOwner')?.addEventListener('click', () => {
    editingOwnerId = null;
    $('#ownerForm')?.reset();
    const title = $('#ownerModalTitle');
    if (title) title.textContent = 'Expediente de Propietario';
    openModal('ownerModal');
  });

  /* Save owner */
  $('#ownerForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_submittingOwner) return;
    _submittingOwner = true;
    const btn = $('#ownerSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const formData = new FormData(e.target);
      const data = {
        full_name: formData.get('full_name') || '',
        email: formData.get('email') || '',
        phone: formData.get('phone') || '',
        dni_cuit: formData.get('dni_cuit') || '',
        address: formData.get('address') || '',
        preferred_contact: formData.get('preferred_contact') || 'whatsapp',
        bank_name: formData.get('bank_name') || '',
        cbu_cvu: formData.get('cbu_cvu') || '',
        alias_cbu: formData.get('alias_cbu') || '',
        exclusive: formData.get('exclusive') === 'on',
        notes: formData.get('notes') || '',
      };

      if (editingOwnerId) {
        const { error } = await window.supabaseClient.from('owners').update(data).eq('id', editingOwnerId);
        if (error) throw error;
        showToast('Propietario actualizado', 'success');
      } else {
        const { error } = await window.supabaseClient.from('owners').insert([data]);
        if (error) throw error;
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
        form.elements.notes.value = data.notes || '';
      }
      const title = $('#ownerModalTitle');
      if (title) title.textContent = 'Editar Propietario';
      openModal('ownerModal');
    } catch (err) {
      showToast('Error al cargar propietario', 'error');
    }
  };

  /* Delete owner */
  window.adminApp.deleteOwner = async function (id) {
    if (!confirm('¿Eliminar este propietario?')) return;
    try {
      const { error } = await window.supabaseClient.from('owners').delete().eq('id', id);
      if (error) throw error;
      showToast('Propietario eliminado', 'success');
      loadOwners();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  /* Owner search */
  $('#ownerSearchInput')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    $$('#ownersTableBody tr').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

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
    const tbody = $('#usersTableBody');
    if (!tbody) return;
    if (!window.supabaseClient) return;

    try {
      const { data, error } = await window.supabaseClient
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
      console.error('Users error:', err);
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

  $('#btnNewUser')?.addEventListener('click', () => {
    $('#userForm')?.reset();
    const passBox = $('#userTempPassBox');
    if (passBox) passBox.style.display = 'none';
    openModal('userModal');
  });

  const userNoEmailCb = document.querySelector('#userForm input[name="no_email"]');
  userNoEmailCb?.addEventListener('change', () => {
    const btn = $('#userSaveBtn');
    if (btn) btn.textContent = userNoEmailCb.checked ? 'Crear Usuario' : 'Enviar Invitación';
  });

  $('#userForm')?.addEventListener('submit', async (e) => {
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
        msg = 'Se alcanzó el límite de emails por hora del servidor. Usá "Crear sin email" o configurá un SMTP propio (Authentication → SMTP).';
      }
      showToast(msg, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('#usersTableBody')?.addEventListener('change', async (e) => {
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

  $('#usersTableBody')?.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('.user-edit-btn');
    if (editBtn) {
      openUserEditor(editBtn.dataset.id);
      return;
    }
    const toggleBtn = e.target.closest('.user-status-toggle');
    if (toggleBtn && !toggleBtn.disabled) await toggleUserActive(toggleBtn.dataset.id);
  });

  $('#sidebarUserProfile')?.addEventListener('click', (e) => {
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

  $('#changePasswordBtn')?.addEventListener('click', () => {
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

  $('#userEditForm')?.addEventListener('submit', async (e) => {
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
        updateUserInfo();
      }
    } catch (err) {
      showToast(err.message || 'No se pudo actualizar el usuario', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  /* Cambio de contraseña propia: único flujo permitido. Se re-autentica con
     la contraseña actual antes de aplicar el cambio; Supabase solo actualiza
     la del usuario de la sesión, así nadie puede cambiar la de un tercero. */
  $('#passwordChangeForm')?.addEventListener('submit', async (e) => {
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
      window.supabaseClient.from('portal_settings').select('*'),
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

  window.adminApp.openPortalConfig = async function (index) {
    const portal = PORTALS[index];
    if (!portal) return;
    const title = $('#modalPortalTitle');
    if (title) title.textContent = `Configurar ${portal.name}`;
    const idx = $('#portalIndex');
    if (idx) idx.value = index;

    try {
      const { data } = await window.supabaseClient
        .from('portal_settings')
        .select('api_key, api_secret')
        .eq('portal_name', portal.name)
        .single();

      const apiKey = $('#portalApiKey');
      const secret = $('#portalApiSecret');
      if (apiKey) apiKey.value = data?.api_key || '';
      if (secret) secret.value = data?.api_secret || '';
    } catch (_) {
      const apiKey = $('#portalApiKey');
      const secret = $('#portalApiSecret');
      if (apiKey) apiKey.value = '';
      if (secret) secret.value = '';
    }

    openModal('portalModal');
  };

  $('#portalApiForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const index = parseInt($('#portalIndex')?.value, 10);
    const portal = PORTALS[index];
    if (!portal) return;
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const apiKey = $('#portalApiKey')?.value?.trim() || '';
      const secret = $('#portalApiSecret')?.value?.trim() || '';
      const { error } = await window.supabaseClient
        .from('portal_settings')
        .upsert({ portal_name: portal.name, api_key: apiKey, api_secret: secret }, { onConflict: 'portal_name' });
      if (error) throw error;
      showToast(`${portal.name} configurado correctamente`, 'success');
      closeModal('portalModal');
    } catch (err) {
      showToast('Error al guardar: ' + err.message, 'error');
    } finally {
      _submittingOwner = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Expediente'; }
    }
  });

  /* Sync all button */
  $('#syncAllBtn')?.addEventListener('click', () => {
    showToast('Sincronización iniciada — próximamente', 'info');
  });

  /* ------------------------------------------------
     13B. MERCADO LIBRE INTEGRATION
     ------------------------------------------------ */
  const ML_FUNCTIONS_BASE = (window.BH_CONFIG?.SUPABASE_URL || '') + '/functions/v1';

  async function mlApiCall(action, body = {}) {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) throw new Error('No hay sesión activa');

    const res = await fetch(`${ML_FUNCTIONS_BASE}/ml-api?action=${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(body),
    });

    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Error ML API (${res.status})`);
    return json;
  }

  async function mlCheckStatus() {
    try {
      const result = await mlApiCall('status');
      ml_connected = result.connected || false;
      ml_configured = result.has_credentials || false;
      ml_user = result.settings || null;
      ml_listings = result.listings || [];
    } catch (err) {
      console.warn('[ML] Status check failed:', err.message);
      ml_connected = false;
      ml_configured = false;
      ml_user = null;
      ml_listings = [];
    }
  }

  /* Connect to Mercado Libre — opens OAuth popup via ml-auth Edge Function */
  window.adminApp.mlConnect = async function () {
    try {
      showToast('Abriendo conexión con Mercado Libre...', 'info');
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (!session) throw new Error('No hay sesión activa');

      const res = await fetch(`${ML_FUNCTIONS_BASE}/ml-auth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Error al generar URL de autenticación');
      const authUrl = result.authUrl;

      /* Open popup for OAuth flow */
      const width = 800, height = 600;
      const left = (screen.width - width) / 2;
      const top = (screen.height - height) / 2;
      const popup = window.open(authUrl, 'ml_auth',
        `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`);

      /* Listen for message from ml-callback Edge Function */
      const handler = async (event) => {
        if (event.data?.type === 'ML_AUTH_SUCCESS') {
          window.removeEventListener('message', handler);
          if (popup && !popup.closed) popup.close();
          showToast('¡Cuenta de Mercado Libre conectada exitosamente!', 'success');
          ml_connected = true;
          ml_user = event.data.user || null;
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
      showToast('Error al iniciar conexión ML: ' + err.message, 'error');
    }
  };

  /* Disconnect from Mercado Libre */
  window.adminApp.mlDisconnect = async function () {
    if (!confirm('¿Desconectar la cuenta de Mercado Libre? Se perderán las credenciales de acceso.')) return;
    try {
      await mlApiCall('disconnect');
      ml_connected = false;
      ml_user = null;
      ml_listings = [];
      showToast('Cuenta de Mercado Libre desconectada', 'success');
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
      showToast('Publicando en Mercado Libre...', 'info');
      const result = await mlApiCall('publish', { property_id: propertyId });
      showToast('¡Propiedad publicada en Mercado Libre! ID: ' + (result.listing_id || ''), 'success');
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

  /* --- ML Config: get/save credentials from portal_settings --- */
  async function mlConfigGet() {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) throw new Error('No hay sesión activa');
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
    if (!session) throw new Error('No hay sesión activa');
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

  $('#btnBackToList')?.addEventListener('click', hideTasacionEditor);

  window.addEventListener('message', (e) => {
    /* Security: solo aceptar mensajes de origen propio (tasacion.html vive en el mismo origin) */
    if (e.origin !== window.location.origin) return;
    if (e.data?.type === 'tasaciones-back') hideTasacionEditor();
  });

  async function loadTasaciones() {
    const tbody = $('#tasacionesTableBody');
    if (!tbody) return;
    if (!currentUser || !window.supabaseClient) return;

    try {
      const { data, error } = await window.supabaseClient
        .from('tasaciones')
        .select('id, title, status, created_at')
        .order('created_at', { ascending: false });
      if (error) throw error;

      if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:40px; color:var(--text-dim);">No hay tasaciones registradas</td></tr>';
        return;
      }

      tbody.innerHTML = data.map(t => {
        const statusLabel = t.status === 'finalized' ? 'Finalizada' : 'Borrador';
        const statusClass = t.status === 'finalized' ? 'active' : 'pending';
        const date = t.created_at ? new Date(t.created_at).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
        return `<tr>
          <td style="font-weight:600; color:#fff;">${esc(t.title || 'Sin título')}</td>
          <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
          <td style="color:var(--text-muted); font-size:13px;">${date}</td>
          <td>
            <button class="icon-badge-btn" title="Abrir" data-open-tasacion="${esc(t.id)}" data-tasacion-title="${esc(t.title || '')}"><i class="fas fa-external-link-alt"></i></button>
            <button class="icon-badge-btn" title="Eliminar" data-del-tasacion="${esc(t.id)}"><i class="fas fa-trash" style="color:var(--danger);"></i></button>
          </td>
        </tr>`;
      }).join('');
    } catch (err) {
      console.error('loadTasaciones error:', err);
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:40px; color:var(--danger);">Error al cargar tasaciones</td></tr>';
    }
  }

  window.navigateToTasacion = function (id, title) {
    showTasacionEditor(id, title);
  };

  async function _deleteTasacion(id) {
    if (!confirm('¿Eliminar esta tasación permanentemente?')) return;
    try {
      const { error } = await window.supabaseClient.from('tasaciones').delete().eq('id', id);
      if (error) throw error;
      showToast('Tasación eliminada', 'success');
      loadTasaciones();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al eliminar: ' + err.message, 'error');
    }
  }
  window.deleteTasacion = _deleteTasacion;

  /* ------------------------------------------------
     Security: delegated handlers (sin onclick inline; datos externos viajan en data-* esc()'
     ------------------------------------------------ */
  $('#propertiesTableBody')?.addEventListener('click', (e) => {
    const upd = e.target.closest('[data-ml-update-prop]');
    if (upd) { window.adminApp.mlUpdateProperty(upd.dataset.mlUpdateProp, upd.dataset.mlListing || ''); return; }
    const rem = e.target.closest('[data-ml-remove]');
    if (rem) { window.adminApp.mlRemoveProperty(rem.dataset.mlListing || ''); return; }
    const pub = e.target.closest('[data-ml-publish]');
    if (pub) { window.adminApp.mlPublishProperty(pub.dataset.mlPublish); }
  });

  $('#imagePreviewGrid')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.preview-remove');
    if (btn) btn.closest('.image-preview-item')?.remove();
  });

  $('#tasacionesTableBody')?.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open-tasacion]');
    if (open) { window.navigateToTasacion(open.dataset.openTasacion, open.dataset.tasacionTitle || ''); return; }
    const del = e.target.closest('[data-del-tasacion]');
    if (del) _deleteTasacion(del.dataset.delTasacion);
  });

  async function createNewTasacion() {
    try {
      const userId = currentUser?.id;
      if (!userId) { showToast('No hay sesión activa', 'error'); return; }
      const { data, error } = await window.supabaseClient
        .from('tasaciones')
        .insert({ title: 'Nueva Tasación', status: 'draft', created_by: userId })
        .select('id')
        .single();
      if (error) throw error;
      showTasacionEditor(data.id, 'Nueva Tasación');
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al crear tasación: ' + err.message, 'error');
    }
  }

  $('#btnNewTasacion')?.addEventListener('click', createNewTasacion);

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
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.remove('is-open');
        document.body.style.overflow = '';
      }
    });
  });

  /* Close on Escape */
  document.addEventListener('keydown', (e) => {
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
    var s = String(val);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function downloadCSV(filename, rows, headers) {
    var csv = headers.map(escapeCSV).join(',') + '\n';
    rows.forEach(function(row) {
      csv += row.map(escapeCSV).join(',') + '\n';
    });
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  window.exportLeadsCSV = async function() {
    if (!window.supabaseClient) return;
    var { data, error } = await window.supabaseClient.from('leads').select('*').order('created_at', { ascending: false });
    if (error) { showToast('Error exportando: ' + error.message, 'error'); return; }
    var headers = ['ID', 'Nombre', 'Email', 'Teléfono', 'Mensaje', 'Propiedad', 'Estado', 'Fecha'];
    var rows = data.map(function(l) {
      return [l.id, l.name, l.email, l.phone, l.message, l.property_title, l.status, l.created_at];
    });
    var date = new Date().toISOString().slice(0, 10);
    downloadCSV('leads-' + date + '.csv', rows, headers);
    showToast('Leads exportados (' + rows.length + ')');
  };

  window.exportPropertiesCSV = async function() {
    if (!window.supabaseClient) return;
    var { data, error } = await window.supabaseClient.from('properties').select('*').order('created_at', { ascending: false });
    if (error) { showToast('Error exportando: ' + error.message, 'error'); return; }
    var headers = ['ID', 'Título', 'Tipo', 'Zona', 'Dirección', 'Precio USD', 'Dormitorios', 'Baños', 'm²', 'Estado', 'Publicada', 'Fecha'];
    var rows = data.map(function(p) {
      return [p.id, p.title, p.property_type, p.zone, p.address, p.price_usd, p.bedrooms, p.bathrooms, p.area_m2, p.status, p.published, p.created_at];
    });
    var date = new Date().toISOString().slice(0, 10);
    downloadCSV('propiedades-' + date + '.csv', rows, headers);
    showToast('Propiedades exportadas (' + rows.length + ')');
  };

  window.exportTasacionesCSV = async function() {
    if (!window.supabaseClient) return;
    var { data, error } = await window.supabaseClient.from('tasaciones').select('*').order('created_at', { ascending: false });
    if (error) { showToast('Error exportando: ' + error.message, 'error'); return; }
    var headers = ['ID', 'Título', 'Estado', 'Fecha creación', 'Última edición'];
    var rows = data.map(function(t) {
      return [t.id, t.title, t.status, t.created_at, t.updated_at];
    });
    var date = new Date().toISOString().slice(0, 10);
    downloadCSV('tasaciones-' + date + '.csv', rows, headers);
    showToast('Tasaciones exportadas (' + rows.length + ')');
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
    chip.addEventListener('click', () => {
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
          openModal('leadModal');
          break;
        case 'openVisitModal':
          editingVisitId = null;
          $('#visitForm')?.reset();
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
  console.log('[BH] CHECKPOINT - CHAT section');
  document.body.dataset.bhChatVarsStart = 'true';
  let _chatRealtimeChannel = null;
  let _chatCurrentConv = null;
  let _chatPlatformFilter = 'all';
  let _chatSearchTerm = '';
  let _chatUnreadTotal = 0;
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
    headerEl.style.display = 'none';
    composerEl.style.display = 'none';
    messagesEl.innerHTML = '<div class="chat-empty" style="text-align:center; padding:60px 20px; color:var(--text-dim); flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px;"><i class="fas fa-comments" style="font-size:48px; opacity:0.3;"></i><p>Selecciona una conversación para comenzar</p></div>';

    // Cargar cuentas para filtro
    const { data: accounts } = await window.supabaseClient
      .from('zernio_accounts')
      .select('zernio_account_id, platform, username, status')
      .eq('status', 'connected');

    // Eventos: búsqueda
    searchEl?.addEventListener('input', debounce(() => {
      _chatSearchTerm = searchEl.value.toLowerCase().trim();
      renderConversations();
    }, 150));

    // Eventos: filtros plataforma
    filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
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

    // Cargar conversaciones inicial
    await loadConversations();

    // Realtime
    setupRealtime();

    // Eventos composer
    composerTextarea?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn?.addEventListener('click', sendMessage);
    markReadBtn?.addEventListener('click', markReadCurrent);

    // Funciones auxiliares
    async function loadConversations() {
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
        console.error('loadConversations error:', err);
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
        item.addEventListener('click', () => openConversation(item.dataset.convId));
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
        console.error('loadMessages error:', err);
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

        // Reemplazar mensaje optimista por el real
        const tempEl = messagesEl.querySelector('[data-temp-id="' + 'temp_' + ')');
        // El mensaje real llegará via realtime; solo limpiamos
        composerTextarea.value = '';
      } catch (err) {
        showToast('Error enviando: ' + err.message, 'error');
        // Marcar error en burbuja temporal - usar DOM, no innerHTML
        const tempEl = messagesEl.querySelector('[data-temp-id]');
        if (tempEl) {
          const bubble = tempEl.querySelector('.chat-bubble div[style*="word-wrap"]') || tempEl.firstElementChild;
          if (bubble && bubble.textContent.includes('sending')) {
            bubble.textContent = bubble.textContent.replace('sending', 'failed');
          }
          const warnSpan = document.createElement('span');
          warnSpan.style.cssText = 'color:var(--danger); margin-left:6px;';
          warnSpan.textContent = '⚠';
          tempEl.appendChild(warnSpan);
        }
      }
    }

    async function markReadCurrent() {
      if (!_chatCurrentConv) return;
      await markRead(_chatCurrentConv.id);
    }

    async function markRead(convId) {
      try {
        const session = await window.supabaseClient.auth.getSession();
        await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/zernio-proxy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${(await window.supabaseClient.auth.getSession()).data.session?.access_token}` },
          body: JSON.stringify({ action: 'mark_read', conversationId: convId })
        });
        await window.supabaseClient.from('zernio_conversations').update({ unread_count: 0 }).eq('id', convId);
        loadConversations();
      } catch (err) {
        console.error('markRead error:', err);
      }
    }

    function appendMessage(m) {
      if (!messagesEl) return;
      const empty = messagesEl.querySelector('.chat-empty');
      if (empty) empty.remove();
      const isOut = m.direction === 'out';
      const time = m.occurred_at ? new Date(m.occurred_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
      const ticks = m.status === 'sent' ? '✓' : m.status === 'delivered' ? '✓✓' : m.status === 'read' ? '✓✓' : '⏳';
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
      if (status === 'read') return '✓✓';
      if (status === 'delivered') return '✓✓';
      if (status === 'sent') return '✓';
      return '⏳';
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

    function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

    function setupRealtime() {
      if (_chatRealtimeChannel) _chatRealtimeChannel.unsubscribe();
      _chatRealtimeChannel = window.supabaseClient.channel('zernio-chat')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'zernio_messages' }, payload => {
          const m = payload.new;
          if (!_chatCurrentConv || m.conversation_id !== _chatCurrentConv.id) {
            loadConversations(); // actualizar badge
            return;
          }
          // Mensaje de esta conversación
          // Evitar duplicados con optimista
          if (document.querySelector(`[data-temp-id="${m.id}"]`)) return;
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
  console.log('[BH] AFTER CHAT SECTION - about to define search/utility/init');

  /* Global search */
  let _searchCache = null;

  async function getSearchCache() {
    if (_searchCache) return _searchCache;
    try {
      const [props, leads, agents, owners] = await Promise.all([
        window.supabaseClient.from('properties').select('id, title, zone, address, price_usd, status').order('created_at', { ascending: false }).limit(200),
        window.supabaseClient.from('leads').select('id, full_name, email, phone, stage').order('created_at', { ascending: false }).limit(200),
        window.supabaseClient.from('agents').select('id, full_name, email, matricula').order('created_at', { ascending: false }).limit(100),
        window.supabaseClient.from('owners').select('id, full_name, email, phone').order('created_at', { ascending: false }).limit(100),
      ]);
      _searchCache = {
        properties: props.data || [],
        leads: leads.data || [],
        agents: agents.data || [],
        owners: owners.data || [],
      };
      return _searchCache;
    } catch (_) {
      return { properties: [], leads: [], agents: [], owners: [] };
    }
  }

  function invalidateSearchCache() { _searchCache = null; }

  /* ------------------------------------------------
     17. SIDEBAR BADGES
     ------------------------------------------------ */
  async function updateSidebarBadges() {
    if (!currentUser || !window.supabaseClient) return;
    try {
      const [props, leads, visits, owners, tasaciones] = await Promise.all([
        window.supabaseClient.from('properties').select('*', { count: 'exact', head: true }).eq('is_published', true),
        window.supabaseClient.from('leads').select('*', { count: 'exact', head: true }).not('stage', 'in', '(cerrado,perdido)'),
        window.supabaseClient.from('visits').select('*', { count: 'exact', head: true }).eq('status', 'pendiente'),
        window.supabaseClient.from('owners').select('*', { count: 'exact', head: true }),
        window.supabaseClient.from('tasaciones').select('*', { count: 'exact', head: true }),
      ]);

      const propsEl = $('#sideBadgeProps');
      const leadsEl = $('#sideBadgeLeads');
      const visitsEl = $('#sideBadgeVisits');
      const ownersEl = $('#sideBadgeOwners');
      const tasEl = $('#sideBadgeTasaciones');

      if (propsEl) propsEl.textContent = props.count || 0;
      if (leadsEl) leadsEl.textContent = (leads.count || 0) + ' Activos';
      if (visitsEl) visitsEl.textContent = (visits.count || 0) + ' Citas';
      if (ownersEl) ownersEl.textContent = (owners.count || 0) + ' Activos';
      if (tasEl) tasEl.textContent = tasaciones.count || 0;
    } catch (err) {
      console.error('Badge update error:', err);
    }
  }

  /* ------------------------------------------------
     18. UTILITY
     ------------------------------------------------ */
  function formatPrice(price) {
    if (!price) return '-';
    return _usdFormatter.format(price);
  }

  function formatNumber(num) {
    return _numFormatter.format(num);
  }

  /* ------------------------------------------------
     19. INIT
     ------------------------------------------------ */
  function startApp() {
    console.log('[BH] startApp() called, readyState:', document.readyState);

    // Deferred initialization - runs after DOM is ready
    const _origLoadProperties = loadProperties;
    loadProperties = function () { invalidateSearchCache(); return _origLoadProperties.apply(this, arguments); };

    $('#globalSearchInput')?.addEventListener('input', async (e) => {
      const q = e.target.value.toLowerCase().trim();
      const resultsContainer = $('#globalSearchResults');
      if (!resultsContainer) return;
      if (!q || q.length < 2) { resultsContainer.innerHTML = ''; resultsContainer.style.display = 'none'; return; }

      const cache = await getSearchCache();
      const results = [];

      const matches = (fields) => fields.some(f => f && f.toLowerCase().includes(q));

      for (const p of cache.properties) {
        if (!matches([p.title, p.zone, p.address])) continue;
        results.push({ icon: 'fas fa-home', text: p.title || 'Sin título', sub: [p.zone, p.address].filter(Boolean).join(', '), tab: 'tab-propiedades', color: 'var(--accent)' });
      }
      for (const l of cache.leads) {
        if (!matches([l.full_name, l.email, l.phone])) continue;
        results.push({ icon: 'fas fa-user', text: l.full_name || 'Sin nombre', sub: l.email || l.phone || '', tab: 'tab-leads', color: '#3B82F6' });
      }
      for (const a of cache.agents) {
        if (!matches([a.full_name, a.email, a.matricula])) continue;
        results.push({ icon: 'fas fa-id-badge', text: a.full_name || 'Sin nombre', sub: a.matricula || a.email || '', tab: 'tab-agentes', color: '#10B981' });
      }
      for (const o of cache.owners) {
        if (!matches([o.full_name, o.email, o.phone])) continue;
        results.push({ icon: 'fas fa-user-tie', text: o.full_name || 'Sin nombre', sub: o.email || o.phone || '', tab: 'tab-propietarios', color: '#F97316' });
      }

      if (!results.length) {
        resultsContainer.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-dim); font-size:13px;">Sin resultados para "' + esc(q) + '"</div>';
        resultsContainer.style.display = 'block';
        return;
      }

      resultsContainer.innerHTML = results.slice(0, 10).map(r => `
        <div class="gs-result" data-tab="${esc(r.tab)}" style="display:flex; align-items:center; gap:10px; padding:10px 14px; cursor:pointer; border-bottom:1px solid var(--border-subtle); transition:background 0.15s;">
          <i class="${esc(r.icon)}" style="font-size:14px; color:${r.color}; min-width:18px; text-align:center;"></i>
          <div style="flex:1; min-width:0;">
            <div style="color:#fff; font-size:13px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(r.text)}</div>
            <div style="color:var(--text-dim); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(r.sub)}</div>
          </div>
        </div>
      `).join('');
      resultsContainer.style.display = 'block';
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
        if (item.dataset.tab) navigateTo(item.dataset.tab);
        gsResults.style.display = 'none';
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
    })();

    initAuth();
    initCursorGlow();
  }
  console.log('[BH] Before if/else block, readyState:', document.readyState);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
  } else {
    startApp(); // DOM already ready
  }
  console.log('[BH] IIFE END REACHED');
})
();