/* ============================================================
   BIENENHAUS PROPIEDADES — Admin Panel App
   ============================================================ */

(function () {
  'use strict';

  /* ------------------------------------------------
     0. STATE & REFS
     ------------------------------------------------ */
  let currentUser = null;
  let currentProfile = null;
  let currentSection = 'dashboard';
  let editingPropertyId = null;
  let editingAgentId = null;
  let editingOwnerId = null;

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  /* ------------------------------------------------
     1. AUTH
     ------------------------------------------------ */
  async function initAuth() {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (session) {
      currentUser = session.user;
      await loadProfile();
      showApp();
    } else {
      showLogin();
    }

    // Realtime session changes
    window.supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        currentUser = session.user;
        await loadProfile();
        showApp();
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
      currentProfile = { email: currentUser.email, role: 'admin', full_name: currentUser.email };
    }
  }

  function showLogin() {
    const loginScreen = $('#loginScreen');
    const adminLayout = $('.admin-layout');
    if (loginScreen) loginScreen.style.display = 'flex';
    if (adminLayout) adminLayout.style.display = 'none';
    document.body.classList.remove('is-loading');
  }

  function showApp() {
    const loginScreen = $('#loginScreen');
    const adminLayout = $('.admin-layout');
    if (loginScreen) loginScreen.style.display = 'none';
    if (adminLayout) adminLayout.style.display = 'flex';
    document.body.classList.remove('is-loading');
    updateUserInfo();
    loadDashboard();
  }

  function updateUserInfo() {
    const nameEl = $('#sidebarUserName');
    const roleEl = $('#sidebarUserRole');
    const avatarEl = $('#sidebarUserAvatar');
    if (nameEl) nameEl.textContent = currentProfile?.full_name || currentUser?.email || 'Admin';
    if (roleEl) roleEl.textContent = currentProfile?.role || 'Administrador';
    if (avatarEl) avatarEl.textContent = (currentProfile?.full_name || currentUser?.email || 'A')[0].toUpperCase();
  }

  // Login form
  $('#loginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#loginEmail')?.value?.trim();
    const password = $('#loginPassword')?.value;
    const errorEl = $('#loginError');
    const btn = $('#loginBtn');

    if (!email || !password) return;
    if (errorEl) errorEl.style.display = 'none';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-admin"></span> Ingresando...'; }

    try {
      const { error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err) {
      if (errorEl) { errorEl.textContent = err.message || 'Credenciales incorrectas'; errorEl.style.display = 'block'; }
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = 'Ingresar'; }
    }
  });

  // Logout
  $$('.sidebar-logout').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.supabaseClient.auth.signOut();
    });
  });

  /* ------------------------------------------------
     2. NAVIGATION
     ------------------------------------------------ */
  $$('.sidebar-link[data-section]').forEach(link => {
    link.addEventListener('click', () => {
      const section = link.dataset.section;
      navigateTo(section);
    });
  });

  function navigateTo(section) {
    currentSection = section;

    // Update sidebar active
    $$('.sidebar-link[data-section]').forEach(l => l.classList.toggle('active', l.dataset.section === section));

    // Update header title
    const titles = {
      dashboard: 'Dashboard',
      propiedades: 'Propiedades',
      crm: 'CRM Leads',
      agenda: 'Agenda Visitas',
      cms: 'CMS Editor',
      portales: 'Portales',
      agentes: 'Agentes',
      propietarios: 'Propietarios',
      usuarios: 'Usuarios',
      config: 'Configuración'
    };
    const titleEl = $('#pageTitle');
    if (titleEl) titleEl.textContent = titles[section] || section;

    // Show section
    $$('.section-view').forEach(v => v.classList.remove('active'));
    const target = $(`#section-${section}`);
    if (target) target.classList.add('active');

    // Load data
    const loaders = {
      dashboard: loadDashboard,
      propiedades: loadProperties,
      crm: loadCRM,
      agenda: loadVisits,
      cms: loadCMS,
      agentes: loadAgents,
      propietarios: loadOwners,
      usuarios: loadUsers,
    };
    if (loaders[section]) loaders[section]();

    // Close mobile sidebar
    $('.sidebar')?.classList.remove('is-open');
  }

  // Mobile menu
  $('#mobileMenuBtn')?.addEventListener('click', () => {
    $('.sidebar')?.classList.toggle('is-open');
  });

  /* ------------------------------------------------
     3. DASHBOARD
     ------------------------------------------------ */
  async function loadDashboard() {
    try {
      const [props, leads, visits, agents] = await Promise.all([
        window.supabaseClient.from('properties').select('*', { count: 'exact', head: true }),
        window.supabaseClient.from('leads').select('*', { count: 'exact', head: true }),
        window.supabaseClient.from('visits').select('*', { count: 'exact', head: true }),
        window.supabaseClient.from('agents').select('*', { count: 'exact', head: true }).eq('status', 'activo'),
      ]);

      setKPI('kpiProperties', props.count || 0);
      setKPI('kpiLeads', leads.count || 0);
      setKPI('kpiVisits', visits.count || 0);
      setKPI('kpiAgents', agents.count || 0);
    } catch (err) {
      console.error('Dashboard error:', err);
    }
  }

  function setKPI(id, value) {
    const el = $(`#${id}`);
    if (el) el.textContent = value.toLocaleString('es-AR');
  }

  /* ------------------------------------------------
     4. PROPERTIES CRUD
     ------------------------------------------------ */
  async function loadProperties() {
    const tbody = $('#propertiesTableBody');
    if (!tbody) return;

    try {
      const { data, error } = await window.supabaseClient
        .from('properties')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      if (!data?.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-tertiary);">No hay propiedades cargadas</td></tr>`;
        return;
      }

      tbody.innerHTML = data.map(p => `
        <tr>
          <td>
            <img class="table-thumb" src="${p.main_image || 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=200&q=60&fit=crop'}" alt="${p.title || ''}" />
          </td>
          <td>
            <div class="table-title">${p.title || 'Sin título'}</div>
            <div class="table-subtitle">${p.location || ''}</div>
          </td>
          <td>${formatPrice(p.price)}</td>
          <td>${p.property_type || '-'}</td>
          <td><span class="status-badge ${p.status || 'disponible'}">${p.status || 'disponible'}</span></td>
          <td><span class="status-badge ${p.is_published ? 'active' : 'pendiente'}">${p.is_published ? 'Publicada' : 'Borrador'}</span></td>
          <td>
            <div style="display:flex;gap:6px;">
              <button class="btn-action" title="Editar" onclick="window.adminApp.editProperty('${p.id}')"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteProperty('${p.id}')"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      console.error('Error loading properties:', err);
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--danger);">Error al cargar propiedades</td></tr>`;
    }
  }

  // Open create modal
  $('#btnCreateProperty')?.addEventListener('click', () => {
    editingPropertyId = null;
    resetPropertyForm();
    openModal('propertyModal');
  });

  function resetPropertyForm() {
    const form = $('#propertyForm');
    if (form) form.reset();
    const previews = $('#imagePreviewGrid');
    if (previews) previews.innerHTML = '';
    const title = $('#propertyModalTitle');
    if (title) title.textContent = 'Nueva Propiedad';
  }

  // Save property
  $('#propertyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#propertySaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-admin"></span> Guardando...'; }

    try {
      const formData = new FormData(e.target);
      const data = {
        title: formData.get('title') || '',
        description: formData.get('description') || '',
        price: parseFloat(formData.get('price')) || 0,
        property_type: formData.get('property_type') || '',
        operation: formData.get('operation') || 'venta',
        location: formData.get('location') || '',
        bedrooms: parseInt(formData.get('bedrooms')) || 0,
        bathrooms: parseInt(formData.get('bathrooms')) || 0,
        area_m2: parseFloat(formData.get('area_m2')) || 0,
        garages: parseInt(formData.get('garages')) || 0,
        status: formData.get('status') || 'disponible',
        is_published: formData.get('is_published') === 'on',
        is_featured: formData.get('is_featured') === 'on',
      };

      // Handle main image upload
      const mainImageFile = formData.get('main_image_file');
      if (mainImageFile && mainImageFile.size > 0) {
        data.main_image = await uploadToCloudinary(mainImageFile);
      }

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
    } catch (err) {
      console.error('Error saving property:', err);
      showToast('Error al guardar propiedad: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Propiedad'; }
    }
  });

  // Edit property
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
        form.elements.price.value = data.price || '';
        form.elements.property_type.value = data.property_type || '';
        form.elements.operation.value = data.operation || 'venta';
        form.elements.location.value = data.location || '';
        form.elements.bedrooms.value = data.bedrooms || '';
        form.elements.bathrooms.value = data.bathrooms || '';
        form.elements.area_m2.value = data.area_m2 || '';
        form.elements.garages.value = data.garages || '';
        form.elements.status.value = data.status || 'disponible';
        form.elements.is_published.checked = data.is_published || false;
        form.elements.is_featured.checked = data.is_featured || false;
      }

      const title = $('#propertyModalTitle');
      if (title) title.textContent = 'Editar Propiedad';
      openModal('propertyModal');
    } catch (err) {
      showToast('Error al cargar propiedad', 'error');
    }
  };

  // Delete property
  window.adminApp.deleteProperty = async function (id) {
    if (!confirm('¿Eliminar esta propiedad? Esta acción no se puede deshacer.')) return;
    try {
      const { error } = await window.supabaseClient.from('properties').delete().eq('id', id);
      if (error) throw error;
      showToast('Propiedad eliminada', 'success');
      loadProperties();
    } catch (err) {
      showToast('Error al eliminar: ' + err.message, 'error');
    }
  };

  /* ------------------------------------------------
     5. CLOUDINARY UPLOAD
     ------------------------------------------------ */
  async function uploadToCloudinary(file) {
    const url = `https://api.cloudinary.com/v1_1/${window.BH_CONFIG.CLOUDINARY.cloud_name}/image/upload`;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', window.BH_CONFIG.CLOUDINARY.upload_preset);
    formData.append('quality', 'auto');
    formData.append('fetch_format', 'auto');

    try {
      const response = await fetch(url, { method: 'POST', body: formData });
      if (!response.ok) throw new Error('Upload failed');
      const result = await response.json();
      return result.secure_url;
    } catch (err) {
      console.error('Cloudinary upload error:', err);
      throw err;
    }
  }

  /* ------------------------------------------------
     6. CRM — LEADS PIPELINE
     ------------------------------------------------ */
  async function loadCRM() {
    const containers = {
      nuevos: $('#pipeline-nuevos'),
      contactados: $('#pipeline-contactados'),
      negociacion: $('#pipeline-negociacion'),
      cerrados: $('#pipeline-cerrados'),
    };

    try {
      const { data, error } = await window.supabaseClient
        .from('leads')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      const groups = { nuevo: [], contactado: [], negociacion: [], cerrado: [] };
      (data || []).forEach(lead => {
        const stage = lead.status || 'nuevo';
        if (groups[stage]) groups[stage].push(lead);
      });

      Object.entries(groups).forEach(([stage, leads]) => {
        const container = containers[stage === 'nuevo' ? 'nuevos' : stage === 'contactado' ? 'contactados' : stage];
        if (!container) return;

        // Update count badge
        const countEl = container.closest('.pipeline-column')?.querySelector('.pipeline-column-count');
        if (countEl) countEl.textContent = leads.length;

        container.innerHTML = leads.map(l => `
          <div class="pipeline-card">
            <div class="pipeline-card-name">${l.nombre || 'Sin nombre'}</div>
            <div class="pipeline-card-prop">${l.tipo_propiedad || ''} ${l.presupuesto ? '- USD ' + l.presupuesto : ''}</div>
            <div class="pipeline-card-date">${new Date(l.created_at).toLocaleDateString('es-AR')}</div>
          </div>
        `).join('') || '<p style="text-align:center;color:var(--text-tertiary);font-size:12px;padding:20px;">Sin leads</p>';
      });
    } catch (err) {
      console.error('CRM error:', err);
    }
  }

  /* ------------------------------------------------
     7. VISITS / AGENDA
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
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--text-tertiary);">No hay visitas programadas</td></tr>`;
        return;
      }

      tbody.innerHTML = data.map(v => `
        <tr>
          <td class="table-title">${v.client_name || v.client_email || 'Sin cliente'}</td>
          <td>${v.property_title || v.property_id || '-'}</td>
          <td>${v.visit_date ? new Date(v.visit_date).toLocaleDateString('es-AR') : '-'}</td>
          <td><span class="status-badge ${v.status || 'pendiente'}">${v.status || 'pendiente'}</span></td>
          <td>
            <div style="display:flex;gap:6px;">
              <button class="btn-action" title="Editar"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteVisit('${v.id}')"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      console.error('Visits error:', err);
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--danger);">Error al cargar visitas</td></tr>`;
    }
  }

  window.adminApp.deleteVisit = async function (id) {
    if (!confirm('¿Eliminar esta visita?')) return;
    try {
      const { error } = await window.supabaseClient.from('visits').delete().eq('id', id);
      if (error) throw error;
      showToast('Visita eliminada', 'success');
      loadVisits();
    } catch (err) {
      showToast('Error al eliminar: ' + err.message, 'error');
    }
  };

  /* ------------------------------------------------
     8. CMS EDITOR
     ------------------------------------------------ */
  let cmsData = {};

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

      // Populate forms
      populateCMSFields();
    } catch (err) {
      console.error('CMS error:', err);
    }
  }

  function populateCMSFields() {
    const fieldMap = {
      'hero_title': 'cmsHeroTitle',
      'hero_subtitle': 'cmsHeroSubtitle',
      'hero_badge': 'cmsHeroBadge',
      'services_title': 'cmsServicesTitle',
      'services_subtitle': 'cmsServicesSubtitle',
      'team_title': 'cmsTeamTitle',
      'contact_title': 'cmsContactTitle',
      'contact_address': 'cmsContactAddress',
      'contact_phone': 'cmsContactPhone',
      'contact_email': 'cmsContactEmail',
      'footer_description': 'cmsFooterDesc',
    };

    Object.entries(fieldMap).forEach(([key, inputId]) => {
      const input = $(`#${inputId}`);
      const item = cmsData[key];
      if (input && item) {
        const content = item.content;
        input.value = (typeof content === 'object' && content?.text) ? content.text : (content || '');
      }
    });
  }

  // CMS tabs
  $$('.cms-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.cms-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $$('.cms-section').forEach(s => s.classList.remove('active'));
      const target = $(`#cms-${tab.dataset.tab}`);
      if (target) target.classList.add('active');
    });
  });

  // Save CMS
  $$('.cms-save-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const section = btn.dataset.section;
      await saveCMSSection(section);
    });
  });

  async function saveCMSSection(section) {
    try {
      const fields = $$(`#cms-${section} .cms-field`);
      for (const field of fields) {
        const key = field.dataset.key;
        const value = field.value;
        const existing = cmsData[key];

        if (existing) {
          const { error } = await window.supabaseClient
            .from('site_content')
            .update({ content: { text: value } })
            .eq('id', existing.id);
          if (error) throw error;
        } else {
          const { data, error } = await window.supabaseClient
            .from('site_content')
            .insert([{ section_key: key, content: { text: value } }])
            .select()
            .single();
          if (error) throw error;
          cmsData[key] = data;
        }
      }
      showToast(`Sección ${section} guardada`, 'success');
    } catch (err) {
      showToast('Error al guardar: ' + err.message, 'error');
    }
  }

  /* ------------------------------------------------
     9. AGENTS CRUD
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
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--text-tertiary);">No hay agentes cargados</td></tr>`;
        return;
      }

      tbody.innerHTML = data.map(a => `
        <tr>
          <td>
            <div style="display:flex;align-items:center;gap:10px;">
              <img class="table-thumb" style="border-radius:50%;width:36px;height:36px;" src="${a.photo_url || 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=100&q=60&fit=crop'}" alt="" />
              <div>
                <div class="table-title">${a.full_name || 'Sin nombre'}</div>
                <div class="table-subtitle">${a.email || ''}</div>
              </div>
            </div>
          </td>
          <td>${a.role || 'Agente'}</td>
          <td><span class="status-badge ${a.status || 'activo'}">${a.status || 'activo'}</span></td>
          <td>${a.phone || '-'}</td>
          <td>
            <div style="display:flex;gap:6px;">
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

  $('#btnCreateAgent')?.addEventListener('click', () => {
    editingAgentId = null;
    $('#agentForm')?.reset();
    const title = $('#agentModalTitle');
    if (title) title.textContent = 'Nuevo Agente';
    openModal('agentModal');
  });

  $('#agentForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#agentSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-admin"></span> Guardando...'; }

    try {
      const formData = new FormData(e.target);
      const data = {
        full_name: formData.get('full_name') || '',
        email: formData.get('email') || '',
        phone: formData.get('phone') || '',
        role: formData.get('role') || 'Agente',
        bio: formData.get('bio') || '',
        status: formData.get('status') || 'activo',
      };

      // Handle photo upload
      const photoFile = formData.get('photo_file');
      if (photoFile && photoFile.size > 0) {
        data.photo_url = await uploadToCloudinary(photoFile);
      }

      if (editingAgentId) {
        // Only update photo_url if new photo uploaded
        if (!data.photo_url) delete data.photo_url;
        const { error } = await window.supabaseClient
          .from('agents')
          .update(data)
          .eq('id', editingAgentId);
        if (error) throw error;
        showToast('Agente actualizado', 'success');
      } else {
        const { error } = await window.supabaseClient
          .from('agents')
          .insert([data]);
        if (error) throw error;
        showToast('Agente creado', 'success');
      }

      closeModal('agentModal');
      loadAgents();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Agente'; }
    }
  });

  window.adminApp.editAgent = async function (id) {
    try {
      const { data, error } = await window.supabaseClient
        .from('agents')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;

      editingAgentId = id;
      const form = $('#agentForm');
      if (form) {
        form.elements.full_name.value = data.full_name || '';
        form.elements.email.value = data.email || '';
        form.elements.phone.value = data.phone || '';
        form.elements.role.value = data.role || '';
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

  window.adminApp.deleteAgent = async function (id) {
    if (!confirm('¿Eliminar este agente?')) return;
    try {
      const { error } = await window.supabaseClient.from('agents').delete().eq('id', id);
      if (error) throw error;
      showToast('Agente eliminado', 'success');
      loadAgents();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  /* ------------------------------------------------
     10. OWNERS CRUD
     ------------------------------------------------ */
  async function loadOwners() {
    const tbody = $('#ownersTableBody');
    if (!tbody) return;

    try {
      const { data, error } = await window.supabaseClient
        .from('owners')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) throw error;

      if (!data?.length) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:40px;color:var(--text-tertiary);">No hay propietarios cargados</td></tr>`;
        return;
      }

      tbody.innerHTML = data.map(o => `
        <tr>
          <td class="table-title">${o.full_name || 'Sin nombre'}</td>
          <td>${o.email || '-'}</td>
          <td>${o.phone || '-'}</td>
          <td>
            <div style="display:flex;gap:6px;">
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

  $('#btnCreateOwner')?.addEventListener('click', () => {
    editingOwnerId = null;
    $('#ownerForm')?.reset();
    const title = $('#ownerModalTitle');
    if (title) title.textContent = 'Nuevo Propietario';
    openModal('ownerModal');
  });

  $('#ownerForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const formData = new FormData(e.target);
      const data = {
        full_name: formData.get('full_name') || '',
        email: formData.get('email') || '',
        phone: formData.get('phone') || '',
        notes: formData.get('notes') || '',
      };

      if (editingOwnerId) {
        const { error } = await window.supabaseClient
          .from('owners')
          .update(data)
          .eq('id', editingOwnerId);
        if (error) throw error;
        showToast('Propietario actualizado', 'success');
      } else {
        const { error } = await window.supabaseClient
          .from('owners')
          .insert([data]);
        if (error) throw error;
        showToast('Propietario creado', 'success');
      }

      closeModal('ownerModal');
      loadOwners();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });

  window.adminApp.editOwner = async function (id) {
    try {
      const { data, error } = await window.supabaseClient
        .from('owners')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;

      editingOwnerId = id;
      const form = $('#ownerForm');
      if (form) {
        form.elements.full_name.value = data.full_name || '';
        form.elements.email.value = data.email || '';
        form.elements.phone.value = data.phone || '';
        form.elements.notes.value = data.notes || '';
      }
      const title = $('#ownerModalTitle');
      if (title) title.textContent = 'Editar Propietario';
      openModal('ownerModal');
    } catch (err) {
      showToast('Error al cargar propietario', 'error');
    }
  };

  window.adminApp.deleteOwner = async function (id) {
    if (!confirm('¿Eliminar este propietario?')) return;
    try {
      const { error } = await window.supabaseClient.from('owners').delete().eq('id', id);
      if (error) throw error;
      showToast('Propietario eliminado', 'success');
      loadOwners();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  /* ------------------------------------------------
     11. USERS MANAGEMENT
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
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:40px;color:var(--text-tertiary);">No hay usuarios</td></tr>`;
        return;
      }

      tbody.innerHTML = data.map(u => `
        <tr>
          <td class="table-title">${u.full_name || u.email || 'Sin nombre'}</td>
          <td>${u.email || '-'}</td>
          <td><span class="status-badge ${u.role === 'admin' ? 'active' : 'pendiente'}">${u.role || '_usuario'}</span></td>
          <td>${u.created_at ? new Date(u.created_at).toLocaleDateString('es-AR') : '-'}</td>
        </tr>
      `).join('');
    } catch (err) {
      console.error('Users error:', err);
    }
  }

  /* ------------------------------------------------
     12. MODALS
     ------------------------------------------------ */
  function openModal(id) {
    const modal = $(`#${id}`);
    if (modal) { modal.classList.add('is-open'); document.body.style.overflow = 'hidden'; }
  }

  function closeModal(id) {
    const modal = $(`#${id}`);
    if (modal) { modal.classList.remove('is-open'); document.body.style.overflow = ''; }
  }

  // Close on backdrop click
  $$('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.remove('is-open');
        document.body.style.overflow = '';
      }
    });
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $$('.modal-overlay.is-open').forEach(m => {
        m.classList.remove('is-open');
        document.body.style.overflow = '';
      });
    }
  });

  // Close buttons
  $$('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.modal-overlay');
      if (modal) { modal.classList.remove('is-open'); document.body.style.overflow = ''; }
    });
  });

  /* ------------------------------------------------
     13. TOAST NOTIFICATIONS
     ------------------------------------------------ */
  function showToast(message, type = 'success') {
    const container = $('#toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <i class="fas ${type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'} toast-icon"></i>
      <span class="toast-text">${message}</span>
      <span class="toast-close" onclick="this.parentElement.remove()">✕</span>
    `;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  /* ------------------------------------------------
     14. UTILITY
     ------------------------------------------------ */
  function formatPrice(price) {
    if (!price) return '-';
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(price);
  }

  /* ------------------------------------------------
     15. INIT
     ------------------------------------------------ */
  document.addEventListener('DOMContentLoaded', initAuth);

})();
