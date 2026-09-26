/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Modulo: Supervision (tablero, alertas, reglas, auditoria)
   Extraido de admin-app.js (modularizacion). Helpers via window.__BH.
   ============================================================ */
(function () {
  'use strict';
  const { logError, on, navigateTo, setKPI, openModal, closeModal, downloadCSV, showToast, esc } = window.__BH || {};

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
    // react-doctor-disable-next-line supabase-client-owned-authz-field -- patrón intencional del CRM (ADR 003): RLS valida la fila
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


  window.__BH.loadSupervision = loadSupervision;
  window.__BH.loadAnomaliesTable = loadAnomaliesTable;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadSupervision')) Object.defineProperty(window, 'loadSupervision', { get: () => loadSupervision, set: (v) => { loadSupervision = v; }, configurable: true });
  if (!Object.prototype.hasOwnProperty.call(window, 'loadAnomaliesTable')) Object.defineProperty(window, 'loadAnomaliesTable', { get: () => loadAnomaliesTable, set: (v) => { loadAnomaliesTable = v; }, configurable: true });


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

})();
