/* ============================================================
   BIENENHAUS PROPIEDADES — Admin Panel App (Luxury v2)
   Matches admin.html luxury design system
   ============================================================ */

(function () {
  'use strict';

  /* ------------------------------------------------
     0. STATE & REFS
     ------------------------------------------------ */
  let currentUser = null;
  let currentProfile = null;
  let currentSection = 'tab-dashboard';
  let editingPropertyId = null;
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
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (session) {
        currentUser = session.user;
        showApp();
        loadProfile().then(updateUserInfo).catch(() => {});
      } else {
        showLogin();
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
    } catch (err) {
      console.error('Error loading profile:', err);
      currentProfile = { email: currentUser.email, role: 'super_admin', full_name: currentUser.email };
    }
  }

  function showLogin() {
    const loginScreen = $('#loginScreen');
    const appLayout = $('#appLayout');
    if (loginScreen) loginScreen.classList.remove('is-hidden');
    if (appLayout) appLayout.style.display = 'none';
    hidePreloader();
  }

  function showApp() {
    const loginScreen = $('#loginScreen');
    const appLayout = $('#appLayout');
    if (loginScreen) loginScreen.classList.add('is-hidden');
    if (appLayout) appLayout.style.display = 'flex';
    hidePreloader();
    updateUserInfo();
    updateSidebarBadges();
    mlCheckStatus().catch(() => {});
    navigateTo('tab-dashboard');
  }

  function hidePreloader() {
    document.body.classList.remove('is-loading');
    const preloader = $('#preloader');
    if (preloader) preloader.classList.add('is-hidden');
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
      'tab-sitio-web': loadCMS,
      'tab-agentes': loadAgents,
      'tab-propietarios': loadOwners,
      'tab-usuarios': loadUsers,
      'tab-portales': loadPortals,
    };
    if (loaders[section]) loaders[section]();

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
          <span style="color:var(--text-secondary); font-size:13px; min-width:120px;">${zone}</span>
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
          <div style="color:#fff; font-size:13px; font-weight:500;">${v.client_name || 'Sin cliente'}</div>
          <div style="color:var(--text-dim); font-size:11px;">${v.visit_date ? new Date(v.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'}</div>
        </div>
        <span class="nav-badge" style="background:${v.status === 'confirmada' ? 'rgba(0,200,120,0.15)' : 'rgba(255,184,0,0.15)'}; color:${v.status === 'confirmada' ? 'var(--success)' : 'var(--warning)'}; font-size:11px;">${v.status || 'pendiente'}</span>
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
          <div style="color:#fff; font-size:13px; font-weight:500;">${l.full_name || 'Sin nombre'}</div>
          <div style="color:var(--text-dim); font-size:11px;">${l.budget_usd ? 'USD ' + l.budget_usd.toLocaleString('es-AR') : 'Sin presupuesto'}</div>
        </div>
        <span class="nav-badge" style="background:${stageColors[l.stage] || 'rgba(255,255,255,0.1)'}; color:#fff; font-size:11px;">${l.stage || 'nuevo'}</span>
      </div>
    `).join('');
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
          <div style="color:#fff; font-size:13px; font-weight:500;">${a.full_name || 'Sin nombre'}</div>
          <div style="color:var(--text-dim); font-size:11px;">${a.matricula || 'S/M'}</div>
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
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--text-dim);">No hay propiedades cargadas</td></tr>';
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
          const mlStatusText = mlInfo.status === 'active' ? 'En ML' : mlInfo.status === 'paused' ? 'Pausado' : mlInfo.status || 'ML';
          mlBadge = `<span class="nav-badge status-pill ${mlInfo.status === 'active' ? 'active' : 'paused'}" style="font-size:10px; margin-left:4px;">${mlStatusText}</span>`;
          mlButtons = `
              <button class="btn-action" style="font-size:11px; color:#FFE600;" title="Actualizar en ML" onclick="window.adminApp.mlUpdateProperty('${p.id}','${mlInfo.ml_listing_id}')"><i class="fas fa-arrows-rotate"></i></button>
              <button class="btn-action danger" style="font-size:11px;" title="Quitar de ML" onclick="window.adminApp.mlRemoveProperty('${mlInfo.ml_listing_id}')"><i class="fas fa-link-slash"></i></button>`;
        } else if (ml_connected) {
          mlButtons = `<button class="btn-action" style="font-size:11px; color:#FFE600;" title="Publicar en ML" onclick="window.adminApp.mlPublishProperty('${p.id}')"><i class="fab fa-mercarto-libre"></i></button>`;
        }

        return `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:12px;">
              <img src="${thumb}" alt="${p.title || ''}" style="width:52px; height:52px; border-radius:var(--radius-sm); object-fit:cover; border:1px solid var(--border-subtle);" />
              <div>
                <div style="font-weight:600; color:#fff; font-size:13.5px;">${p.title || 'Sin título'}${mlBadge}</div>
                <div style="color:var(--text-dim); font-size:12px; margin-top:2px;"><i class="fas fa-location-dot" style="margin-right:4px;"></i>${loc || 'Sin ubicación'}</div>
              </div>
            </div>
          </td>
          <td style="font-size:13px;">${p.area_m2 ? p.area_m2 + ' m²' : '-'}</td>
          <td style="font-size:13px;">${p.rooms || '-'}</td>
          <td style="font-weight:600; color:var(--accent); font-size:13.5px;">${formatPrice(p.price_usd)}</td>
          <td><span class="nav-badge" style="background:${p.status === 'venta' ? 'rgba(31,200,195,0.15)' : 'rgba(255,184,0,0.15)'}; color:${p.status === 'venta' ? 'var(--accent)' : 'var(--warning)'}; font-size:11px;">${p.status || 'venta'}</span></td>
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
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--danger);">Error al cargar propiedades</td></tr>';
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
    const title = $('#propModalTitle');
    if (title) title.textContent = 'Nueva Propiedad';
  }

  /* Save property */
  let _submittingProperty = false;
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
      };

      /* Image uploads */
      const imageFiles = formData.getAll('image_files');
      const existingUrls = formData.getAll('existing_image_urls').filter(u => u);
      const newUrls = [];
      for (const file of imageFiles) {
        if (file && file.size > 0) {
          const url = await uploadToCloudinary(file);
          newUrls.push(url);
        }
      }
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

        const previews = $('#imagePreviewGrid');
        if (previews && data.image_urls?.length) {
          previews.innerHTML = data.image_urls.map(url => `
            <div class="image-preview-item" style="position:relative; width:80px; height:80px; border-radius:8px; overflow:hidden; border:1px solid var(--border-subtle);">
              <img src="${url}" alt="" style="width:100%; height:100%; object-fit:cover;" />
              <input type="hidden" name="existing_image_urls" value="${url}" />
              <button type="button" onclick="this.parentElement.remove()" style="position:absolute; top:4px; right:4px; width:20px; height:20px; border-radius:50%; background:rgba(0,0,0,0.7); color:#fff; border:none; cursor:pointer; font-size:10px; display:flex; align-items:center; justify-content:center;"><i class="fas fa-times"></i></button>
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
    const url = `https://api.cloudinary.com/v1_1/${window.BH_CONFIG.CLOUDINARY.cloud_name}/image/upload`;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', window.BH_CONFIG.CLOUDINARY.upload_preset);
    formData.append('quality', 'auto');
    formData.append('fetch_format', 'auto');

    const response = await fetch(url, { method: 'POST', body: formData });
    if (!response.ok) throw new Error('Upload failed');
    const result = await response.json();
    return result.secure_url;
  }

  /* ------------------------------------------------
     7. CRM — LEADS PIPELINE
     ------------------------------------------------ */
  async function loadCRM() {
    try {
      const { data, error } = await window.supabaseClient
        .from('leads')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      /* Group by stage */
      const groups = { nuevo: [], contactado: [], visita: [], oferta: [], cerrado: [], perdido: [] };
      (data || []).forEach(lead => {
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
        const container = $(`#${containerId}`);
        const badgeEl = $(`#${badge}`);
        const leads = stages.flatMap(s => groups[s] || []);

        if (badgeEl) badgeEl.textContent = leads.length;

        if (!container) return;
        if (!leads.length) {
          container.innerHTML = '<p style="text-align:center; color:var(--text-dim); font-size:12px; padding:24px 8px;">Sin prospectos</p>';
          return;
        }

        container.innerHTML = leads.map(l => `
          <div class="lead-card" style="background:var(--surface-2); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:14px; margin-bottom:10px; cursor:pointer;" onclick="window.adminApp.editLead('${l.id}')">
            <div style="font-weight:600; color:#fff; font-size:13px; margin-bottom:4px;">${l.full_name || 'Sin nombre'}</div>
            <div style="color:var(--text-dim); font-size:11px; margin-bottom:6px;">${l.preferred_type ? l.preferred_type.charAt(0).toUpperCase() + l.preferred_type.slice(1) : ''} ${l.preferred_zone ? '· ' + l.preferred_zone : ''}</div>
            ${l.budget_usd ? '<div style="color:var(--accent); font-size:12px; font-weight:500;">USD ' + l.budget_usd.toLocaleString('es-AR') + '</div>' : ''}
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top:8px; border-top:1px solid var(--border-subtle);">
              <span style="color:var(--text-dim); font-size:10px;">${new Date(l.created_at).toLocaleDateString('es-AR')}</span>
              <div style="display:flex; gap:4px;">
                <button class="btn-action" style="padding:4px 6px; font-size:10px;" title="Editar" onclick="event.stopPropagation(); window.adminApp.editLead('${l.id}')"><i class="fas fa-pen"></i></button>
                <button class="btn-action danger" style="padding:4px 6px; font-size:10px;" title="Eliminar" onclick="event.stopPropagation(); window.adminApp.deleteLead('${l.id}')"><i class="fas fa-trash"></i></button>
              </div>
            </div>
          </div>
        `).join('');
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
      const { data, error } = await window.supabaseClient.from('leads').select('*').eq('id', id).single();
      if (error) throw error;
      editingLeadId = id;
      const form = $('#leadForm');
      if (form) {
        form.elements.full_name.value = data.full_name || '';
        form.elements.phone.value = data.phone || '';
        form.elements.email.value = data.email || '';
        form.elements.budget_usd.value = data.budget_usd || '';
        form.elements.stage.value = data.stage || 'nuevo';
        form.elements.preferred_type.value = data.preferred_type || '';
        form.elements.preferred_zone.value = data.preferred_zone || '';
        form.elements.notes.value = data.notes || '';
      }
      openModal('leadModal');
    } catch (err) {
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

    try {
      const { data, error } = await window.supabaseClient
        .from('visits')
        .select('*')
        .order('visit_date', { ascending: true });

      if (error) throw error;

      if (!data?.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:40px; color:var(--text-dim);">No hay visitas programadas</td></tr>';
        return;
      }

      tbody.innerHTML = data.map(v => {
        const dateStr = v.visit_date
          ? new Date(v.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
          : '-';
        return `
        <tr>
          <td style="font-size:13px;">${dateStr}</td>
          <td style="font-size:13px; color:var(--text-dim);">-</td>
          <td style="font-size:13px; font-weight:500;">${v.client_name || 'Sin cliente'}</td>
          <td style="font-size:13px; color:var(--text-dim);">-</td>
          <td><span class="nav-badge" style="background:${v.status === 'confirmada' ? 'rgba(0,200,120,0.15)' : v.status === 'completada' ? 'rgba(31,200,195,0.15)' : 'rgba(255,184,0,0.15)'}; color:${v.status === 'confirmada' ? 'var(--success)' : v.status === 'completada' ? 'var(--accent)' : 'var(--warning)'}; font-size:11px;">${v.status || 'pendiente'}</span></td>
          <td>
            <div style="display:flex; gap:6px;">
              <button class="btn-action" title="Editar" onclick="window.adminApp.editVisit('${v.id}')"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteVisit('${v.id}')"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>`;
      }).join('');
    } catch (err) {
      console.error('Visits error:', err);
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:40px; color:var(--danger);">Error al cargar visitas</td></tr>';
    }
  }

  /* Create visit */
  $('#btnNewVisit')?.addEventListener('click', () => {
    editingVisitId = null;
    $('#visitForm')?.reset();
    openModal('visitModal');
  });

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
      const data = {
        visit_date: formData.get('visit_date') || null,
        status: formData.get('status') || 'pendiente',
        client_name: formData.get('client_name') || '',
        client_phone: formData.get('client_phone') || '',
        notes: formData.get('notes') || '',
      };

      if (editingVisitId) {
        const { error } = await window.supabaseClient.from('visits').update(data).eq('id', editingVisitId);
        if (error) throw error;
        showToast('Visita actualizada', 'success');
      } else {
        const { error } = await window.supabaseClient.from('visits').insert([data]);
        if (error) throw error;
        showToast('Visita agendada', 'success');
      }

      closeModal('visitModal');
      loadVisits();
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
      const { data, error } = await window.supabaseClient.from('visits').select('*').eq('id', id).single();
      if (error) throw error;
      editingVisitId = id;
      const form = $('#visitForm');
      if (form) {
        if (data.visit_date) {
          const d = new Date(data.visit_date);
          form.elements.visit_date.value = d.toISOString().slice(0, 16);
        }
        form.elements.status.value = data.status || 'pendiente';
        form.elements.client_name.value = data.client_name || '';
        form.elements.client_phone.value = data.client_phone || '';
        form.elements.notes.value = data.notes || '';
      }
      openModal('visitModal');
    } catch (err) {
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
    proc_title:    { section: 'process', path: 'title' },
    cont_wpp:      { section: 'contact', path: 'whatsapp' },
    cont_email:    { section: 'contact', path: 'email' },
    cont_phone:    { section: 'contact', path: 'phone' },
    cont_address:  { section: 'contact', path: 'address' },
    foot_wm:       { section: 'footer', path: 'copyright' },
    foot_cri:      { section: 'footer', path: 'matricula' },
    foot_cuit:     { section: 'footer', path: 'cuit' },
  };

  async function loadCMS() {
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
      heroBgPreview.innerHTML = '<img src="' + heroBgHidden.value + '" alt="Hero background" />';
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

      let savedCount = 0;
      for (const [sectionKey, newFields] of Object.entries(updatesBySection)) {
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
        savedCount++;
      }

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
      heroBgPreview.innerHTML = '<img src="' + url + '" alt="Hero background" /><span style="position:absolute;bottom:2px;right:2px;font-size:9px;background:rgba(0,0,0,.7);padding:2px 5px;border-radius:3px;">Cloudinary ✓</span>';
      heroBgPreview.style.position = 'relative';
      showToast('Imagen subida a Cloudinary', 'success');
    } catch (err) {
      console.error('Upload error:', err);
      heroBgPreview.innerHTML = '<i class="fas fa-cloud-arrow-up"></i><span>Error al subir</span>';
      showToast('Error al subir imagen: ' + err.message, 'error');
    }
  });

  /* ------------------------------------------------
     10. AGENTS CRUD
     ------------------------------------------------ */
  async function loadAgents() {
    const tbody = $('#agentsTableBody');
    if (!tbody) return;

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
              <img style="width:36px; height:36px; border-radius:50%; object-fit:cover; border:1px solid var(--border-subtle);" src="${a.photo_url || 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=100&q=60&fit=crop'}" alt="" />
              <div>
                <div style="font-weight:600; color:#fff; font-size:13px;">${a.full_name || 'Sin nombre'}</div>
                <div style="color:var(--text-dim); font-size:11px;">${a.email || ''}</div>
              </div>
            </div>
          </td>
          <td style="font-size:13px;">${a.matricula || '-'}</td>
          <td><span class="nav-badge" style="background:${a.status === 'activo' ? 'rgba(0,200,120,0.15)' : 'rgba(255,255,255,0.06)'}; color:${a.status === 'activo' ? 'var(--success)' : 'var(--text-dim)'}; font-size:11px;">${a.status || 'activo'}</span></td>
          <td style="font-size:13px;">${a.phone || '-'}</td>
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
  let _submittingAgent = false;
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
      _submittingProperty = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Inmueble'; }
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
              <div style="font-weight:600; color:#fff; font-size:13px;">${o.full_name || 'Sin nombre'}</div>
              <div style="color:var(--text-dim); font-size:11px;">${o.dni_cuit || 'S/DNI'}</div>
            </div>
          </td>
          <td>
            <div style="font-size:13px;">${o.phone || '-'}</div>
            <div style="color:var(--text-dim); font-size:11px;">${o.email || ''}</div>
          </td>
          <td><span class="nav-badge" style="background:${o.exclusive ? 'rgba(31,200,195,0.15)' : 'rgba(255,255,255,0.06)'}; color:${o.exclusive ? 'var(--accent)' : 'var(--text-dim)'}; font-size:11px;">${o.exclusive ? 'Exclusivo' : 'Normal'}</span></td>
          <td>
            <div style="font-size:12px; color:var(--text-dim);">${o.bank_name || '-'}</div>
            <div style="font-size:11px; color:var(--text-dim);">${o.cbu_cvu ? o.cbu_cvu.slice(0, 8) + '...' : ''}</div>
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
  let _submittingOwner = false;
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
      _submittingAgent = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Broker'; }
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
  async function loadUsers() {
    const tbody = $('#usersTableBody');
    if (!tbody) return;

    try {
      const { data, error } = await window.supabaseClient
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) throw error;

      if (!data?.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim);">No hay usuarios</td></tr>';
        return;
      }

      tbody.innerHTML = data.map(u => {
        const roleLabels = { super_admin: 'Super Admin', broker: 'Broker', agente: 'Agente' };
        return `
        <tr>
          <td style="font-weight:500; color:#fff; font-size:13px;">${u.full_name || u.email || 'Sin nombre'}</td>
          <td style="font-size:13px; color:var(--text-dim);">${u.email || '-'}</td>
          <td><span class="nav-badge" style="background:${u.role === 'super_admin' ? 'rgba(31,200,195,0.15)' : 'rgba(255,255,255,0.06)'}; color:${u.role === 'super_admin' ? 'var(--accent)' : 'var(--text-dim)'}; font-size:11px;">${roleLabels[u.role] || u.role || 'agente'}</span></td>
          <td><span class="nav-badge" style="background:${u.is_active !== false ? 'rgba(0,200,120,0.15)' : 'rgba(255,60,60,0.15)'}; color:${u.is_active !== false ? 'var(--success)' : 'var(--danger)'}; font-size:11px;">${u.is_active !== false ? 'Activo' : 'Inactivo'}</span></td>
          <td style="color:var(--text-dim); font-size:12px;">${u.created_at ? new Date(u.created_at).toLocaleDateString('es-AR') : '-'}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      console.error('Users error:', err);
    }
  }

  /* Create user (placeholder — needs Supabase admin invite) */
  $('#btnNewUser')?.addEventListener('click', () => {
    showToast('La creación de usuarios requiere configuración de Supabase Auth Admin', 'info');
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
          ? `<p style="color:var(--text-muted); font-size:11px; margin-top:6px;"><i class="fas fa-user" style="margin-right:4px;"></i>${ml_user.ml_nickname || ml_user.ml_email || ''}</p>`
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

    const res = await fetch(`${ML_FUNCTIONS_BASE}/ml-api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action, ...body }),
    });

    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Error ML API (${res.status})`);
    return json;
  }

  async function mlCheckStatus() {
    try {
      const result = await mlApiCall('status');
      ml_connected = result.connected || false;
      ml_user = result.settings || null;
      ml_listings = result.listings || [];
    } catch (err) {
      console.warn('[ML] Status check failed:', err.message);
      ml_connected = false;
      ml_user = null;
      ml_listings = [];
    }
    try {
      const config = await mlConfigGet();
      ml_configured = !!(config.ml_app_id && config.has_secret);
    } catch (_) {
      ml_configured = false;
    }
  }

  /* Connect to Mercado Libre — opens OAuth popup */
  window.adminApp.mlConnect = async function () {
    try {
      showToast('Abriendo conexión con Mercado Libre...', 'info');
      const result = await mlApiCall('auth');
      const authUrl = result.auth_url;

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

  const _origLoadProperties = loadProperties;
  loadProperties = function () { invalidateSearchCache(); return _origLoadProperties.apply(this, arguments); };

  $('#globalSearchInput')?.addEventListener('input', async (e) => {
    const q = e.target.value.toLowerCase().trim();
    const resultsContainer = $('#globalSearchResults');
    if (!resultsContainer) return;
    if (!q || q.length < 2) { resultsContainer.innerHTML = ''; resultsContainer.style.display = 'none'; return; }

    const cache = await getSearchCache();
    const results = [];

    cache.properties.filter(p => [p.title, p.zone, p.address].some(f => f && f.toLowerCase().includes(q))).forEach(p => {
      results.push({ icon: 'fas fa-home', text: p.title || 'Sin título', sub: [p.zone, p.address].filter(Boolean).join(', '), tab: 'tab-propiedades', color: 'var(--accent)' });
    });
    cache.leads.filter(l => [l.full_name, l.email, l.phone].some(f => f && f.toLowerCase().includes(q))).forEach(l => {
      results.push({ icon: 'fas fa-user', text: l.full_name || 'Sin nombre', sub: l.email || l.phone || '', tab: 'tab-leads', color: '#3B82F6' });
    });
    cache.agents.filter(a => [a.full_name, a.email, a.matricula].some(f => f && f.toLowerCase().includes(q))).forEach(a => {
      results.push({ icon: 'fas fa-id-badge', text: a.full_name || 'Sin nombre', sub: a.matricula || a.email || '', tab: 'tab-agentes', color: '#10B981' });
    });
    cache.owners.filter(o => [o.full_name, o.email, o.phone].some(f => f && f.toLowerCase().includes(q))).forEach(o => {
      results.push({ icon: 'fas fa-user-tie', text: o.full_name || 'Sin nombre', sub: o.email || o.phone || '', tab: 'tab-propietarios', color: '#F97316' });
    });

    if (!results.length) {
      resultsContainer.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-dim); font-size:13px;">Sin resultados para "' + q + '"</div>';
      resultsContainer.style.display = 'block';
      return;
    }

    resultsContainer.innerHTML = results.slice(0, 10).map(r => `
      <div style="display:flex; align-items:center; gap:10px; padding:10px 14px; cursor:pointer; border-bottom:1px solid var(--border-subtle); transition:background 0.15s;" onmouseenter="this.style.background='rgba(255,255,255,0.04)'" onmouseleave="this.style.style.background=''" onclick="navigateTo('${r.tab}'); document.getElementById('globalSearchResults').style.display='none'; document.getElementById('globalSearchInput').value='';">
        <i class="${r.icon}" style="font-size:14px; color:${r.color}; min-width:18px; text-align:center;"></i>
        <div style="flex:1; min-width:0;">
          <div style="color:#fff; font-size:13px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${r.text}</div>
          <div style="color:var(--text-dim); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${r.sub}</div>
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

  /* ------------------------------------------------
     17. SIDEBAR BADGES
     ------------------------------------------------ */
  async function updateSidebarBadges() {
    try {
      const [props, leads, visits, owners] = await Promise.all([
        window.supabaseClient.from('properties').select('*', { count: 'exact', head: true }).eq('is_published', true),
        window.supabaseClient.from('leads').select('*', { count: 'exact', head: true }).not('stage', 'in', '(cerrado,perdido)'),
        window.supabaseClient.from('visits').select('*', { count: 'exact', head: true }).eq('status', 'pendiente'),
        window.supabaseClient.from('owners').select('*', { count: 'exact', head: true }),
      ]);

      const propsEl = $('#sideBadgeProps');
      const leadsEl = $('#sideBadgeLeads');
      const visitsEl = $('#sideBadgeVisits');
      const ownersEl = $('#sideBadgeOwners');

      if (propsEl) propsEl.textContent = props.count || 0;
      if (leadsEl) leadsEl.textContent = (leads.count || 0) + ' Activos';
      if (visitsEl) visitsEl.textContent = (visits.count || 0) + ' Citas';
      if (ownersEl) ownersEl.textContent = (owners.count || 0) + ' Activos';
    } catch (err) {
      console.error('Badge update error:', err);
    }
  }

  /* ------------------------------------------------
     18. UTILITY
     ------------------------------------------------ */
  function formatPrice(price) {
    if (!price) return '-';
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(price);
  }

  function formatNumber(num) {
    return new Intl.NumberFormat('es-AR').format(num);
  }

  /* ------------------------------------------------
     19. INIT
     ------------------------------------------------ */
  document.addEventListener('DOMContentLoaded', () => {
    initAuth();
    initCursorGlow();
  });

})();
