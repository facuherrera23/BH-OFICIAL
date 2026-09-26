/* ============================================================
   admin-supervision.js — Centro de Supervisión (autocontenido)
   Equipo · Actividad Global · Detalle por empleado
   ============================================================ */

(function () {
  'use strict';

  var PAGE_SIZE = 30;
  var ONLINE_MS = 15 * 60 * 1000;

  var ROLE_META = {
    super_admin: { label: 'Super Admin', color: '#EF4444' },
    broker:      { label: 'Broker',       color: '#FACC15' },
    agente:      { label: 'Agente',       color: '#1FC8C3' }
  };

  var MODULE_META = {
    properties:  { icon: 'fa-home',       color: '#1FC8C3', label: 'propiedad'    },
    crm:         { icon: 'fa-user-plus',  color: '#3B82F6', label: 'lead'         },
    portales:    { icon: 'fa-store',      color: '#FACC15', label: 'publicación'  },
    tasaciones:  { icon: 'fa-calculator', color: '#10B981', label: 'tasación'     },
    agenda:      { icon: 'fa-calendar',   color: '#8B5CF6', label: 'visita'       },
    owners:      { icon: 'fa-key',        color: '#E67E22', label: 'propietario'  },
    cms:         { icon: 'fa-globe',      color: '#06B6D4', label: 'sitio web'    },
    brokers:     { icon: 'fa-user-tie',   color: '#F472B6', label: 'agente'       },
    users:       { icon: 'fa-user-shield',color: '#EF4444', label: 'usuario'      },
    chat:        { icon: 'fa-comments',   color: '#25D366', label: 'chat'         },
    config:      { icon: 'fa-cog',        color: '#6B7280', label: 'config'       },
    rela:        { icon: 'fa-building',   color: '#FB923C', label: 'RELA'         },
    supervision: { icon: 'fa-shield-alt', color: '#94A3B8', label: 'sistema'      }
  };

  var ACTION_VERBS = {
    insert:          'Creó',
    create:          'Creó',
    update:          'Editó',
    delete:          'Eliminó',
    remove:          'Eliminó',
    update_sensitive:'Modificó (sensible)',
    ml_publish:      'Publicó en ML',
    rela_publish:    'Publicó en RELA',
    rela_catalogs_sync: 'Sincronizó catálogos RELA',
    message_received:'Recibió mensaje de',
    anomaly_detected:'Anomalía detectada en',
    supervision_notify_failed: 'Falló notificación de',
    test:            'Prueba en'
  };

  var _view = 'team';
  var _profiles = [];
  var _profilesById = {};
  var _currentUserId = null;
  var _currentUserName = null;
  var _currentUserRole = null;
  var _currentUserEmail = null;
  var _detPage = 0;
  var _feedPage = 0;
  var _detModuleFilter = '';
  var _detSearch = '';
  var _quickFilter = null;
  var _humansOnly = true;
  var _autoRefreshTimer = null;
  var _bound = false;
  var _boardCache = null;
  var _feedCache = [];

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function $(id) { return document.getElementById(id); }
  function db() { return window.supabaseClient; }

  function initials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).slice(0, 2).map(function(w) { return w.charAt(0); }).join('').toUpperCase();
  }

  function timeAgo(iso) {
    if (!iso) return 'Nunca';
    var diff = Date.now() - new Date(iso).getTime();
    if (diff < 0) return 'Ahora';
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Ahora';
    if (mins < 60) return 'hace ' + mins + ' min';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return 'hace ' + hrs + 'h';
    var days = Math.floor(hrs / 24);
    return 'hace ' + days + ' día' + (days > 1 ? 's' : '');
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDateHeader(iso) {
    var d = new Date(iso);
    var today = new Date(); today.setHours(0,0,0,0);
    var thatDay = new Date(d); thatDay.setHours(0,0,0,0);
    var diffDays = Math.round((today - thatDay) / 86400000);
    var label = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
    if (diffDays === 0) return 'Hoy — ' + label;
    if (diffDays === 1) return 'Ayer — ' + label;
    return label;
  }

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function todayStart() {
    var d = new Date(); d.setHours(0, 0, 0, 0); return d;
  }

  function computeActiveMs(timestamps) {
    if (!timestamps.length) return 0;
    if (timestamps.length < 2) return 5 * 60 * 1000;
    var sorted = timestamps.slice().sort();
    var ms = 0;
    for (var i = 1; i < sorted.length; i++) {
      var gap = new Date(sorted[i]) - new Date(sorted[i - 1]);
      if (gap <= 30 * 60 * 1000) ms += gap;
    }
    return ms + 5 * 60 * 1000;
  }

  function fmtMinutes(ms) {
    if (ms < 60 * 1000) return '<1 min';
    var m = Math.round(ms / 60000);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    var rest = m % 60;
    return rest ? h + 'h ' + rest + 'm' : h + ' h';
  }

  function showErr(containerId, err) {
    var el = $(containerId);
    if (el) el.innerHTML = '<div class="sup-act-empty" style="color:var(--danger);"><i class="fas fa-exclamation-triangle"></i>Error: ' + esc(err.message || 'desconocido') + '</div>';
  }

  function setLoading(containerId, text) {
    var el = $(containerId);
    if (el) el.innerHTML = '<div class="sup-act-empty"><i class="fas fa-spinner fa-spin"></i>' + esc(text || 'Cargando...') + '</div>';
  }

  async function fetchProfiles() {
    var res = await db().from('profiles').select('id, full_name, email, role, is_active').eq('is_active', true).order('full_name');
    if (res.error) throw res.error;
    return res.data || [];
  }

  async function fetchLastActivity(userIds) {
    if (!userIds.length) return {};
    var res = await db().from('audit_log').select('user_id, created_at').in('user_id', userIds).order('created_at', { ascending: false }).limit(1000);
    if (res.error) return {};
    var map = {};
    (res.data || []).forEach(function(r) { if (!map[r.user_id]) map[r.user_id] = r.created_at; });
    return map;
  }

  function renderInactiveToday(profiles, stats) {
    var el = $('supInactiveBanner');
    if (!el) return;
    var inactive = profiles.filter(function(p) { return !stats[p.id] || !stats[p.id].total; });
    if (!inactive.length) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.innerHTML = '<i class="fas fa-user-clock" style="color:var(--warning);"></i>' +
      '<div style="flex:1;"><span style="color:#fff; font-weight:600;">Sin actividad hoy:</span> ' +
      '<span style="color:var(--text-muted); font-size:13px;">' + inactive.map(function(p) { return esc(p.full_name); }).join(', ') + '</span></div>';
  }

  async function fetchTodayStats() {
    var res = await db().from('audit_log').select('user_id, role_snapshot, module, status, action, created_at').gte('created_at', todayStart().toISOString()).neq('module', 'supervision').limit(2000);
    if (res.error) throw res.error;
    var stats = {};
    (res.data || []).forEach(function(a) {
      if (!a.user_id) return;
      if (!stats[a.user_id]) stats[a.user_id] = { props: 0, leads: 0, ml: 0, other: 0, errors: 0, deletes: 0, total: 0, first: a.created_at, last: a.created_at, _times: [] };
      var s = stats[a.user_id];
      s.total++;
      s._times.push(a.created_at);
      if (a.created_at < s.first) s.first = a.created_at;
      if (a.created_at > s.last) s.last = a.created_at;
      if (a.status && a.status !== 'success' && a.status !== 'ok') s.errors++;
      if (a.action === 'delete') s.deletes++;
      if (a.module === 'properties') s.props++;
      else if (a.module === 'crm') s.leads++;
      else if (a.module === 'portales' || a.module === 'rela') s.ml++;
      else s.other++;
    });
    return stats;
  }

  function renderDeletesBanner(stats) {
    var el = $('supDeletesBanner');
    if (!el) return;
    var withDeletes = Object.keys(stats).filter(function(uid) { return stats[uid].deletes > 0; });
    if (!withDeletes.length) { el.style.display = 'none'; return; }
    var total = withDeletes.reduce(function(s, uid) { return s + stats[uid].deletes; }, 0);
    el.style.display = 'flex';
    el.innerHTML = '<i class="fas fa-exclamation-triangle" style="color:var(--danger);"></i>' +
      '<div style="flex:1;"><strong style="color:#fff;">' + total + ' eliminación' + (total > 1 ? 'es' : '') + ' hoy</strong> ' +
      '<span style="color:var(--text-dim); font-size:12px;">— ' + withDeletes.map(function(uid) {
        var p = _profilesById[uid];
        return (p ? p.full_name : 'Sistema') + ' (' + stats[uid].deletes + ')';
      }).join(', ') + '</span></div>' +
      '<button type="button" class="status-pill pending" id="supDeletesViewBtn" style="padding:5px 12px; font-size:11px; cursor:pointer;">Ver detalle</button>';
    var btn = $('supDeletesViewBtn');
    if (btn) btn.addEventListener('click', function() {
      showView('feed');
      _feedPage = 0;
      _quickFilter = { kind: 'delete' };
      var tabC = $('supQuickDeletes');
      if (tabC) tabC.classList.add('is-active', 'danger');
      loadFeed();
    });
  }

  async function fetchRecentErrors() {
    var since = new Date(Date.now() - 7 * 86400000);
    var res = await db().from('audit_log').select('id', { count: 'exact', head: true }).gte('created_at', since.toISOString()).not('status', 'in', '("success","ok")');
    return res.count || 0;
  }

  async function fetchLatestEvent() {
    var res = await db().from('audit_log').select('user_id, action, module, entity_label, created_at').neq('module', 'supervision').order('created_at', { ascending: false }).limit(1);
    return (res.data && res.data[0]) || null;
  }

  async function fetchAlerts(status, severity) {
    var q = db().from('supervision_alerts')
      .select('id, user_id, module, severity, alert_type, title, description, evidence, status, created_at, acknowledged_by, acknowledged_at, resolved_by, resolved_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (status) q = q.eq('status', status);
    if (severity) q = q.eq('severity', severity);
    var res = await q;
    if (res.error) throw res.error;
    return res.data || [];
  }

  async function updateAlertStatus(id, newStatus) {
    var fn = window.supabaseClient && window.supabaseClient.auth && window.supabaseClient.auth.getSession
      ? function() { return window.supabaseClient.auth.getSession(); } : null;
    var uid = null;
    if (fn) {
      try { var s = await fn(); uid = s && s.data && s.data.session && s.data.session.user ? s.data.session.user.id : null; } catch (_) {}
    }
    var patch = { status: newStatus, updated_at: new Date().toISOString() };
    if (newStatus === 'acknowledged') patch.acknowledged_by = uid;
    if (newStatus === 'resolved') patch.resolved_by = uid;
    if (newStatus === 'dismissed') patch.dismissed_by = uid;
    var res = await db().from('supervision_alerts').update(patch).eq('id', id);
    if (res.error) throw res.error;
  }

  async function fetchEntityHistory(entityLabel) {
    var res = await db().from('audit_log')
      .select('id, user_id, action, module, entity_label, entity_type, changed_fields, metadata, status, created_at')
      .eq('entity_label', entityLabel)
      .neq('module', 'supervision')
      .order('created_at', { ascending: false })
      .limit(100);
    if (res.error) throw res.error;
    return res.data || [];
  }

  async function fetchUserActivity(userId, page) {
    var from = page * PAGE_SIZE;
    var to = from + PAGE_SIZE - 1;
    var q = db().from('audit_log')
      .select('id, action, module, entity_label, entity_type, changed_fields, metadata, status, created_at, table_name, record_id')
      .eq('user_id', userId)
      .neq('module', 'supervision')
      .order('created_at', { ascending: false });
    if (_detModuleFilter) q = q.eq('module', _detModuleFilter);
    if (_detSearch) q = q.ilike('entity_label', '%' + _detSearch + '%');
    var res = await q.range(from, to);
    if (res.error) throw res.error;
    return res.data || [];
  }

  async function fetchUserSummary(userId) {
    var dayStart = todayStart();
    var twoWeeksAgo = new Date(dayStart.getTime() - 13 * 86400000);
    var res = await db().from('audit_log').select('module, status, created_at').eq('user_id', userId).neq('module', 'supervision').gte('created_at', twoWeeksAgo.toISOString()).order('created_at', { ascending: false }).limit(1000);
    if (res.error) throw res.error;
    var rows = res.data || [];
    var todayRows = rows.filter(function(r) { return new Date(r.created_at) >= dayStart; });
    var thisWeekStart = new Date(dayStart.getTime() - 6 * 86400000);
    var thisWeek = rows.filter(function(r) { return new Date(r.created_at) >= thisWeekStart; });
    var lastWeek = rows.filter(function(r) { var t = new Date(r.created_at); return t >= twoWeeksAgo && t < thisWeekStart; });
    return {
      today: todayRows.length,
      week: thisWeek.length,
      lastWeek: lastWeek.length,
      errors: rows.filter(function(r) { return r.status && r.status !== 'success' && r.status !== 'ok'; }).length
    };
  }

  async function fetchWeekComparison() {
    var since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - 13);
    var res = await db().from('audit_log').select('user_id, module, created_at').not('user_id', 'is', null).neq('module', 'supervision').gte('created_at', since.toISOString()).limit(3000);
    if (res.error) return [];
    var rows = res.data || [];
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var weekStart = new Date(today.getTime() - 6 * 86400000);
    var byUser = {};
    _profiles.forEach(function(p) {
      byUser[p.id] = { id: p.id, name: p.full_name, role: p.role, thisWeek: 0, lastWeek: 0, modules: {}, weekTimes: [] };
    });
    rows.forEach(function(r) {
      var u = byUser[r.user_id];
      if (!u) return;
      if (new Date(r.created_at) >= weekStart) {
        u.thisWeek++;
        u.modules[r.module] = (u.modules[r.module] || 0) + 1;
        u.weekTimes.push(r.created_at);
      } else {
        u.lastWeek++;
      }
    });
    return Object.keys(byUser).map(function(k) {
      var u = byUser[k];
      u.activeMs = computeActiveMs(u.weekTimes);
      delete u.weekTimes;
      return u;
    }).sort(function(a, b) { return b.thisWeek - a.thisWeek; });
  }

  async function fetchErrors() {
    var since = new Date(Date.now() - 30 * 86400000);
    var res = await db().from('audit_log')
      .select('id, user_id, role_snapshot, action, module, entity_label, table_name, record_id, status, error_code, metadata, created_at')
      .not('status', 'in', '("success","ok")')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(200);
    if (res.error) throw res.error;
    return res.data || [];
  }

  async function fetchTopEntities() {
    var since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - 6);
    var res = await db().from('audit_log').select('entity_label, entity_type, module, created_at').not('entity_label', 'is', null).neq('module', 'supervision').gte('created_at', since.toISOString()).limit(2000);
    if (res.error) return [];
    var byKey = {};
    (res.data || []).forEach(function(r) {
      var label = r.entity_label;
      if (label && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(label)) label = (MODULE_META[r.module] || {}).label || 'registro';
      var key = r.module + '|' + label;
      if (!byKey[key]) byKey[key] = { label: label, module: r.module, count: 0, last: r.created_at };
      byKey[key].count++;
      if (r.created_at > byKey[key].last) byKey[key].last = r.created_at;
    });
    return Object.keys(byKey).map(function(k) { return byKey[k]; }).sort(function(a, b) { return b.count - a.count; }).slice(0, 5);
  }

  async function fetchDayCount(offsetDays) {
    var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offsetDays);
    var next = new Date(d.getTime() + 86400000);
    var res = await db().from('audit_log').select('id', { count: 'exact', head: true }).neq('module', 'supervision').gte('created_at', d.toISOString()).lt('created_at', next.toISOString());
    return res.count || 0;
  }

  function copyDailySummary() {
    if (!_boardCache) return;
    var now = new Date();
    var lines = [
      'REPORTE DE ACTIVIDAD — ' + now.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase(),
      'Generado: ' + now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
      ''
    ];
    var sorted = _profiles.slice().sort(function(a, b) {
      return (_boardCache.stats[b.id] || { total: 0 }).total - (_boardCache.stats[a.id] || { total: 0 }).total;
    });
    sorted.forEach(function(p) {
      var st = _boardCache.stats[p.id] || { props: 0, leads: 0, ml: 0, other: 0, errors: 0, total: 0 };
      var last = _boardCache.lastAct[p.id];
      var window_ = (st.first && st.last)
        ? ' [' + fmtTime(st.first) + ' – ' + fmtTime(st.last) + ']'
        : '';
      var parts = [];
      if (st.props) parts.push(st.props + ' prop.');
      if (st.leads) parts.push(st.leads + ' leads');
      if (st.ml) parts.push(st.ml + ' portales');
      if (st.other) parts.push(st.other + ' otros');
      if (st.errors) parts.push(st.errors + ' ERRORES');
      var detail = parts.length ? parts.join(' · ') : 'sin actividad';
      lines.push('• ' + p.full_name + window_ + ': ' + detail);
    });
    lines.push('');
    lines.push('Total equipo: ' + sorted.reduce(function(s, p) { return s + (_boardCache.stats[p.id] || { total: 0 }).total; }, 0) + ' acciones');
    lines.push('— Centro de Supervisión · Bienenhaus Propiedades');

    var text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        var btn = $('supCopySummaryBtn');
        if (btn) {
          var orig = btn.innerHTML;
          btn.innerHTML = '<i class="fas fa-check"></i> ¡Copiado!';
          btn.style.color = '#10B981';
          setTimeout(function() { btn.innerHTML = orig; btn.style.color = ''; }, 2500);
        }
      });
    }
  }

  async function fetchAuditDetail(id) {
    var res = await db().from('audit_log')
      .select('old_data, new_data, changed_fields, ip, user_agent, table_name, record_id, metadata')
      .eq('id', id)
      .single();
    if (res.error) throw res.error;
    return res.data;
  }

  async function fetchUser7Day(userId) {
    var since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - 13);
    var res = await db().from('audit_log').select('created_at').eq('user_id', userId).neq('module', 'supervision').gte('created_at', since.toISOString()).limit(1000);
    if (res.error) return { days: [], hours: [] };
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - i));
      days.push({ label: d.toLocaleDateString('es-AR', { weekday: 'short' }).replace('.', ''), count: 0, ymd: d.toDateString() });
    }
    var hourBuckets = [];
    for (var h = 0; h < 24; h += 4) {
      hourBuckets.push({ from: h, to: h + 4, label: String(h).padStart(2, '0') + 'h', count: 0 });
    }
    (res.data || []).forEach(function(r) {
      var dt = new Date(r.created_at);
      var key = dt.toDateString();
      var day = days.find(function(d) { return d.ymd === key; });
      if (day) day.count++;
      var hr = dt.getHours();
      var bucket = hourBuckets.find(function(b) { return hr >= b.from && hr < b.to; });
      if (bucket) bucket.count++;
    });
    return { days: days, hours: hourBuckets };
  }

  async function fetchGlobalFeed(page) {
    var from = page * PAGE_SIZE;
    var to = from + PAGE_SIZE - 1;
    var q = db().from('audit_log')
      .select('id, user_id, role_snapshot, action, module, entity_label, entity_type, changed_fields, metadata, status, created_at')
      .neq('module', 'supervision')
      .order('created_at', { ascending: false });

    if (_humansOnly) q = q.not('role_snapshot', 'is', null);
    if (_quickFilter && _quickFilter.kind === 'delete') q = q.eq('action', 'delete');
    if (_quickFilter && _quickFilter.kind === 'sensitive') q = q.in('action', ['update_sensitive', 'delete', 'anomaly_detected']);
    if (_quickFilter && _quickFilter.kind === 'errors') q = q.not('status', 'in', '("success","ok")');
    if (_quickFilter && _quickFilter.kind === 'price') q = q.or('changed_fields.cs.["price"],changed_fields.cs.["price_usd"]');

    var userId = $('supFeedUserFilter') ? $('supFeedUserFilter').value : '';
    var module = $('supFeedModuleFilter') ? $('supFeedModuleFilter').value : '';
    var action = $('supFeedActionFilter') ? $('supFeedActionFilter').value : '';
    var status = $('supFeedStatusFilter') ? $('supFeedStatusFilter').value : '';
    var fromDt = $('supFeedFrom') ? $('supFeedFrom').value : '';
    var toDt = $('supFeedTo') ? $('supFeedTo').value : '';
    var search = $('supFeedSearch') ? $('supFeedSearch').value.trim() : '';

    if (userId) q = q.eq('user_id', userId);
    if (module) q = q.eq('module', module);
    if (action) q = q.eq('action', action);
    if (status) q = q.eq('status', status);
    if (fromDt) q = q.gte('created_at', new Date(fromDt + 'T00:00:00').toISOString());
    if (toDt) q = q.lte('created_at', new Date(toDt + 'T23:59:59').toISOString());
    if (search) q = q.ilike('entity_label', '%' + search + '%');

    var res = await q.range(from, to);
    if (res.error) throw res.error;
    return res.data || [];
  }

  function downloadCSV(filename, rows) {
    if (!rows.length) return;
    var header = Object.keys(rows[0]);
    var csv = [header.join(';')].concat(rows.map(function(r) {
      return header.map(function(k) {
        var v = r[k];
        if (v === null || v === undefined) return '';
        v = String(v).replace(/"/g, '""').replace(/\n/g, ' ');
        return '"' + v + '"';
      }).join(';');
    })).join('\r\n');
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    var blobUrl = URL.createObjectURL(blob);
    a.href = blobUrl;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(blobUrl);
  }

  function activityToCsvRows(entries) {
    return entries.map(function(e) {
      var p = _profilesById[e.user_id];
      return {
        fecha: fmtDateTime(e.created_at),
        usuario: (p && p.full_name) || e.user_id || 'sistema',
        accion: ACTION_VERBS[e.action] || e.action,
        modulo: e.module,
        entidad: e.entity_label || '',
        campos_modificados: (e.changed_fields || []).join(', '),
        estado: e.status || ''
      };
    });
  }

  function showEntityHistory(entityLabel, moduleName) {
    var existing = $('supEntityModal');
    if (existing) existing.remove();
    var meta = MODULE_META[moduleName] || { icon: 'fa-circle', color: '#1FC8C3', label: moduleName };
    var modal = document.createElement('div');
    modal.id = 'supEntityModal';
    modal.style.cssText = 'position:fixed; inset:0; z-index:9999; display:flex; align-items:flex-start; justify-content:center; padding:40px 20px; background:rgba(0,0,0,0.72); overflow-y:auto;';
    modal.innerHTML =
      '<div style="background:#111827; border:1px solid var(--border-subtle); border-radius:18px; width:100%; max-width:700px; padding:0; overflow:hidden; margin:auto;">' +
        '<div style="display:flex; align-items:center; gap:14px; padding:20px 24px; border-bottom:1px solid var(--border-subtle); background:rgba(255,255,255,0.02);">' +
          '<div class="sup-act-icon" style="width:40px; height:40px; flex-shrink:0; background:' + meta.color + '18; color:' + meta.color + '; border:1px solid ' + meta.color + '44;"><i class="fas ' + meta.icon + '"></i></div>' +
          '<div style="flex:1;">' +
            '<div style="font-family:var(--font-heading); font-size:17px; color:#fff; font-weight:700;">' + esc(entityLabel) + '</div>' +
            '<div style="font-size:10.5px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.6px; margin-top:2px;">' + esc(meta.label) + ' · historial completo</div>' +
          '</div>' +
          '<button type="button" id="supEntityClose" style="background:none; border:none; color:var(--text-muted); cursor:pointer; padding:8px;"><i class="fas fa-times"></i></button>' +
        '</div>' +
        '<div id="supEntityBody" style="max-height:520px; overflow-y:auto; padding:16px 24px;">' +
          '<div class="sup-act-empty"><i class="fas fa-spinner fa-spin"></i>Cargando historial...</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    var body = $('supEntityBody');
    $('supEntityClose').addEventListener('click', function() { modal.remove(); });
    modal.addEventListener('click', function(ev) { if (ev.target === modal) modal.remove(); });
    var esc2 = esc;
    fetchEntityHistory(entityLabel).then(function(entries) {
      if (!entries.length) {
        body.innerHTML = '<div class="sup-act-empty"><i class="fas fa-inbox"></i>Sin historial</div>';
        return;
      }
      body.innerHTML = entries.map(function(e) {
        var m = MODULE_META[e.module] || { icon: 'fa-circle', color: '#6B7280' };
        var verb = ACTION_VERBS[e.action] || e.action;
        var p = _profilesById[e.user_id];
        var who = (p && p.full_name) || 'Sistema';
        var failed = e.status && e.status !== 'success' && e.status !== 'ok';
        var changes = (e.changed_fields && e.changed_fields.length) ? e.changed_fields.filter(function(c) { return c !== 'updated_at'; }).join(', ') : '';
        return '<div style="display:flex; gap:12px; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.04); font-size:12.5px;">' +
          '<div style="color:var(--text-dim); min-width:100px; font-family:ui-monospace,monospace; white-space:nowrap;">' + fmtTime(e.created_at) + '<br><span style="font-size:10px;">' + new Date(e.created_at).toLocaleDateString('es-AR') + '</span></div>' +
          '<div style="flex:1;">' +
            '<span style="color:' + m.color + '; font-weight:600;">' + esc2(verb) + '</span> ' +
            (changes ? '<code style="font-size:10.5px; background:rgba(31,200,195,0.06); padding:1px 6px; border-radius:4px; color:var(--accent);">' + esc2(changes) + '</code> ' : '') +
            (failed ? ' <span style="color:var(--danger); font-size:10px; text-transform:uppercase; font-weight:700;">' + esc2(e.status) + '</span>' : '') +
            '<div style="color:var(--text-dim); font-size:11px; margin-top:3px;">' + esc2(who) + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }).catch(function(err) {
      body.innerHTML = '<div class="sup-act-empty" style="color:var(--danger);"><i class="fas fa-exclamation-triangle"></i>' + esc(err.message) + '</div>';
    });
  }

  function renderKpis(todayStats, errorCount, latest, perUser) {
    var todayWithDelta = perUser.totalToday;
    var deltaNote = '';
    if (perUser.yesterday > 0) {
      var deltaToday = todayWithDelta - perUser.yesterday;
      var pct = Math.round((deltaToday / perUser.yesterday) * 100);
      if (pct !== 0) deltaNote = (pct > 0 ? '+' + pct : String(pct)) + '% vs ayer';
    }
    setText('supKpiToday', String(todayWithDelta));
    setText('supKpiTodaySub', deltaNote || 'en todo el sistema');
    setText('supKpiActive', String(perUser.activeUsers));
    setText('supKpiActiveSub', 'de ' + _profiles.length + ' miembros');
    setText('supKpiErrors', String(errorCount));
    setText('supKpiErrorsSub', errorCount > 0 ? 'revisar actividad' : 'todo en orden');
    if (latest) {
      var p = _profilesById[latest.user_id];
      setText('supKpiLast', timeAgo(latest.created_at));
      setText('supKpiLastSub', ((p && p.full_name) || 'Sistema') + ' · ' + (ACTION_VERBS[latest.action] || latest.action));
    } else {
      setText('supKpiLast', '—');
    }
  }

  function setText(id, txt) {
    var el = $(id);
    if (el) el.textContent = txt;
  }

  function renderTeamBoard(profiles, lastActivity, stats, roleFilter) {
    var grid = $('supTeamGrid');
    if (!grid) return;

    var list = roleFilter ? profiles.filter(function(p) { return p.role === roleFilter; }) : profiles;

    if (!list.length) {
      grid.innerHTML = '<div style="text-align:center;padding:60px;grid-column:1/-1;color:var(--text-dim);"><i class="fas fa-user-slash" style="font-size:32px;margin-bottom:10px;"></i><div>No hay usuarios con ese rol</div></div>';
      return;
    }

    var now = Date.now();
    grid.innerHTML = list.map(function(p) {
      var meta = ROLE_META[p.role] || { label: p.role, color: '#6B7280' };
      var st = stats[p.id] || { props: 0, leads: 0, ml: 0, other: 0, errors: 0, total: 0 };
      var last = lastActivity[p.id];
      var online = last && (now - new Date(last).getTime()) < ONLINE_MS;
      var lastTxt = online ? '<span style="color:#10B981;font-weight:600;">En línea ahora</span>' : 'Última vez: ' + timeAgo(last);
      var errBadge = st.errors > 0 ? '<div style="font-size:10px;color:var(--danger);margin-top:6px;"><i class="fas fa-exclamation-circle"></i> ' + st.errors + ' error' + (st.errors > 1 ? 'es' : '') + ' hoy</div>' : '';

      var digitalDay = '';
      if (st.total > 0 && st.first && st.last) {
        var t1 = fmtTime(st.first);
        var t2 = fmtTime(st.last);
        var activeMs = computeActiveMs(st._times || []);
        digitalDay = '<div style="font-size:10px;color:var(--text-dim);margin-top:8px;"><i class="fas fa-clock"></i> Hoy: ' + t1 + (t1 !== t2 ? ' – ' + t2 : '') +
          (activeMs > 0 ? ' <span style="color:var(--accent); margin-left:4px;">' + fmtMinutes(activeMs) + ' activo</span>' : '') + '</div>';
      }

      return '<div class="sup-team-card" data-uid="' + esc(p.id) + '" role="button" tabindex="0" style="cursor:pointer;' + (st.errors > 0 ? ' border-left:3px solid var(--danger);' : '') + '">' +
        '<div class="stc-status ' + (online ? 'online' : 'offline') + '" title="' + (online ? 'En línea' : 'Desconectado') + '"></div>' +
        '<div class="stc-header">' +
          '<div class="stc-avatar" style="background:' + meta.color + '22;color:' + meta.color + ';border:1px solid ' + meta.color + '44;">' + esc(initials(p.full_name)) + '</div>' +
          '<div><div class="stc-name">' + esc(p.full_name) + '</div>' +
          '<div class="stc-role">' + esc(meta.label) + '</div></div>' +
        '</div>' +
        '<div class="stc-last">' + lastTxt + '</div>' +
        '<div class="stc-stats">' +
          '<div class="stc-stat"><div class="stc-stat-num" style="color:#1FC8C3;">' + st.props + '</div><div class="stc-stat-label">Props</div></div>' +
          '<div class="stc-stat"><div class="stc-stat-num" style="color:#3B82F6;">' + st.leads + '</div><div class="stc-stat-label">Leads</div></div>' +
          '<div class="stc-stat"><div class="stc-stat-num" style="color:#FACC15;">' + st.ml + '</div><div class="stc-stat-label">Portales</div></div>' +
          '<div class="stc-stat"><div class="stc-stat-num" style="color:#8B5CF6;">' + st.total + '</div><div class="stc-stat-label">Total hoy</div></div>' +
        '</div>' + digitalDay + errBadge + '</div>';
    }).join('');

    grid.querySelectorAll('.sup-team-card').forEach(function(card) {
      card.addEventListener('click', function() {
        var uid = card.dataset.uid;
        var p = _profilesById[uid];
        if (p) openDetail(uid, p.full_name, p.role, p.email);
      });
    });
  }

  function renderDetailHeader(name, role, email) {
    var meta = ROLE_META[role] || { label: role, color: '#6B7280' };
    var el = $('supEmployeeHeader');
    if (!el) return;
    el.innerHTML =
      '<div style="width:60px;height:60px;border-radius:50%;background:' + meta.color + '22;color:' + meta.color + ';display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;border:2px solid ' + meta.color + '44;flex-shrink:0;">' + esc(initials(name)) + '</div>' +
      '<div style="flex:1;"><div style="font-family:var(--font-heading);font-size:22px;color:#fff;font-weight:700;">' + esc(name) + '</div>' +
      '<div style="font-size:12px;color:' + meta.color + ';text-transform:uppercase;letter-spacing:1px;margin-top:4px;">' + esc(meta.label) + '</div>' +
      (email ? '<div style="font-size:12px;color:var(--text-dim);margin-top:4px;">' + esc(email) + '</div>' : '') + '</div>';
  }

  function renderEmployeeStats(sum) {
    var el = $('supEmployeeStats');
    if (!el) return;
    var delta = sum.week - sum.lastWeek;
    var deltaTxt = delta === 0 ? 'sin cambio' : (delta > 0 ? '+' + delta + ' vs semana anterior' : delta + ' vs semana anterior');
    var deltaColor = delta === 0 ? 'var(--text-dim)' : (delta > 0 ? '#10B981' : '#EF4444');
    el.innerHTML =
      '<div class="sup-kpi"><div class="sup-kpi-label">Hoy</div><div class="sup-kpi-num" style="color:#1FC8C3;">' + sum.today + '</div><div class="sup-kpi-sub">acciones</div></div>' +
      '<div class="sup-kpi"><div class="sup-kpi-label">Esta semana</div><div class="sup-kpi-num" style="color:#fff;">' + sum.week + '</div><div class="sup-kpi-sub" style="color:' + deltaColor + ';">' + esc(deltaTxt) + '</div></div>' +
      '<div class="sup-kpi"><div class="sup-kpi-label">Semana anterior</div><div class="sup-kpi-num" style="color:#8B5CF6;">' + sum.lastWeek + '</div><div class="sup-kpi-sub">para comparar</div></div>' +
      '<div class="sup-kpi"><div class="sup-kpi-label">Errores (14d)</div><div class="sup-kpi-num" style="color:' + (sum.errors ? '#EF4444' : '#10B981') + ';">' + sum.errors + '</div><div class="sup-kpi-sub">' + (sum.errors ? 'requieren atención' : 'sin errores') + '</div></div>';
  }

  function buildRow(e, showUser) {
    var meta = MODULE_META[e.module] || { icon: 'fa-circle', color: '#6B7280', label: e.module };
    var verb = ACTION_VERBS[e.action] || e.action;
    var rawLabel = e.entity_label;
    if (rawLabel && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawLabel)) rawLabel = null;
    var entity = rawLabel || meta.label;
    var failed = e.status && e.status !== 'success' && e.status !== 'ok';
    var status = failed ? ' <span class="sup-act-chip" style="background:rgba(239,68,68,0.15);color:var(--danger);">' + esc(e.status) + '</span>' : '';
    var changes = (e.changed_fields && e.changed_fields.length)
      ? ' <span class="sup-act-chip" style="background:rgba(255,184,0,0.12);color:var(--warning);">' + e.changed_fields.length + ' cambio' + (e.changed_fields.length > 1 ? 's' : '') + '</span>' : '';
    var ml = (e.metadata && e.metadata.permalink)
      ? ' <a href="' + esc(e.metadata.permalink) + '" target="_blank" rel="noopener" style="color:#FACC15;font-size:11px;text-decoration:underline;">Ver ML</a>' : '';
    var userLine = '';
    if (showUser) {
      var p = _profilesById[e.user_id];
      userLine = '<span class="sup-act-user">' + esc((p && p.full_name) || 'Sistema') + '</span>';
    }
    return '<div class="sup-act-row' + (failed ? ' sup-act-row-failed' : '') + '" data-aid="' + esc(e.id) + '" data-entity="' + esc(entity) + '" data-module="' + esc(e.module) + '">' +
      '<div class="sup-act-time">' + fmtTime(e.created_at) + '</div>' +
      '<div class="sup-act-icon" style="background:' + meta.color + '18;color:' + meta.color + ';border:1px solid ' + meta.color + '33;"><i class="fas ' + meta.icon + '"></i></div>' +
      '<div class="sup-act-text">' + userLine + '<strong style="color:#fff;">' + esc(verb) + '</strong> <span class="sup-act-ent" style="color:' + meta.color + ';font-weight:600; cursor:pointer; text-decoration:underline; text-decoration-style:dotted; text-underline-offset:2px;" title="Ver historial completo">' + esc(entity) + '</span>' + status + changes + ml + (e.id ? '<span class="sup-expand-hint"><i class="fas fa-chevron-down"></i> cambios</span>' : '') + '</div>' +
    '</div>';
  }

  function fmtDiffVal(v) {
    if (v === null || v === undefined || v === '') return '<em style="opacity:.6;">vacío</em>';
    if (typeof v === 'object') return esc(JSON.stringify(v)).substring(0, 120);
    return esc(String(v)).substring(0, 150);
  }

  function renderDetailPanel(d) {
    var fields = d.changed_fields || [];
    var oldD = d.old_data || {};
    var newD = d.new_data || {};
    var rows = '';
    fields.forEach(function(f) {
      if (f === 'updated_at') return;
      rows += '<tr><td class="sup-diff-field">' + esc(f) + '</td>' +
        '<td class="sup-diff-old">' + fmtDiffVal(oldD[f]) + '</td>' +
        '<td class="sup-diff-arrow"><i class="fas fa-arrow-right"></i></td>' +
        '<td class="sup-diff-new">' + fmtDiffVal(newD[f]) + '</td></tr>';
    });
    var meta = '';
    if (d.metadata && typeof d.metadata === 'object') {
      var mKeys = Object.keys(d.metadata);
      if (mKeys.length) {
        meta = '<div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">' +
          mKeys.map(function(k) {
            var v = d.metadata[k];
            if (v === null || v === undefined) v = '—';
            else if (typeof v === 'object') v = JSON.stringify(v);
            return '<span style="font-size:10.5px; background:rgba(255,255,255,0.04); padding:3px 8px; border-radius:6px; color:var(--text-dim);"><strong style="color:#fff;">' + esc(k) + ':</strong> ' + esc(String(v).substring(0, 60)) + '</span>';
          }).join('') +
        '</div>';
      }
    }
    var tech = '<div style="margin-top:10px; font-size:10.5px; color:var(--text-dim); display:flex; gap:14px; flex-wrap:wrap;">' +
      (d.table_name ? '<span>Tabla: <code>' + esc(d.table_name) + '</code></span>' : '') +
      (d.record_id ? '<span>Registro: <code>' + esc(String(d.record_id).substring(0, 18)) + '…</code></span>' : '') +
      (d.ip ? '<span>IP: <code>' + esc(d.ip) + '</code></span>' : '') +
      '</div>' + meta;
    if (!rows && !tech) return '<div style="padding:8px 0; color:var(--text-dim); font-size:11px;">Sin detalle adicional registrado.</div>';
    return (rows ? '<table class="sup-diff-table"><tbody>' + rows + '</tbody></table>' : '') + tech;
  }

  function toggleDetail(rowEl, container) {
    var next = rowEl.nextElementSibling;
    if (next && next.classList.contains('sup-diff')) {
      next.remove();
      rowEl.classList.remove('expanded');
      return;
    }
    var aid = rowEl.dataset.aid;
    if (!aid) return;
    var holder = document.createElement('div');
    holder.className = 'sup-diff';
    holder.innerHTML = '<div style="color:var(--text-dim); font-size:11px; padding:6px 0;"><i class="fas fa-spinner fa-spin"></i> Cargando detalle...</div>';
    rowEl.after(holder);
    fetchAuditDetail(aid).then(function(d) {
      holder.innerHTML = renderDetailPanel(d);
    }).catch(function(err) {
      holder.innerHTML = '<div style="color:var(--danger); font-size:11px;">Error: ' + esc(err.message) + '</div>';
    });
  }

  function renderDayChart(days) {
    var el = $('supEmployeeChart');
    if (!el) return;
    var max = Math.max(1, Math.max.apply(null, days.map(function(d) { return d.count; })));
    el.innerHTML = days.map(function(d) {
      var pct = Math.round((d.count / max) * 100);
      return '<div class="sup-chart-bar" title="' + esc(d.label) + ': ' + d.count + ' acciones">' +
        '<div class="sup-chart-num">' + (d.count || '') + '</div>' +
        '<div class="sup-chart-fill" style="height:' + Math.max(4, pct) + '%;"></div>' +
        '<div class="sup-chart-day">' + esc(d.label) + '</div>' +
      '</div>';
    }).join('');
  }

  function renderHourChart(buckets) {
    var el = $('supHourChart');
    if (!el) return;
    var max = Math.max(1, Math.max.apply(null, buckets.map(function(b) { return b.count; })));
    el.innerHTML = buckets.map(function(b) {
      var pct = Math.round((b.count / max) * 100);
      return '<div class="sup-chart-bar" title="' + b.label + ': ' + b.count + ' acciones">' +
        '<div class="sup-chart-num">' + (b.count || '') + '</div>' +
        '<div class="sup-chart-fill" style="height:' + Math.max(4, pct) + '%; background:linear-gradient(180deg, rgba(139,92,246,0.85), rgba(139,92,246,0.25));"></div>' +
        '<div class="sup-chart-day">' + esc(b.label) + '</div>' +
      '</div>';
    }).join('');
  }

  var SEVERITY_META = {
    critical: { color: '#EF4444', label: 'Crítica' },
    high:     { color: '#F97316', label: 'Alta' },
    medium:   { color: '#FACC15', label: 'Media' },
    low:      { color: '#6B7280', label: 'Baja' }
  };

  function renderWeekComparison(weekData) {
    var el = $('supWeekComparison');
    if (!el) return;
    if (!weekData.length) { el.innerHTML = '<div style="color:var(--text-dim); font-size:12px;">Sin datos de la última semana.</div>'; return; }
    var max = Math.max.apply(null, weekData.map(function(u) { return u.thisWeek; })) || 1;
    el.innerHTML = weekData.map(function(u) {
      var pct = Math.round((u.thisWeek / max) * 100);
      var trend = '';
      if (u.thisWeek > u.lastWeek) trend = '<span style="color:#10B981; font-size:10px;">▲ +' + (u.thisWeek - u.lastWeek) + '</span>';
      else if (u.thisWeek < u.lastWeek) trend = '<span style="color:#EF4444; font-size:10px;">▼ -' + (u.lastWeek - u.thisWeek) + '</span>';
      else trend = '<span style="color:var(--text-dim); font-size:10px;">=</span>';
      var topModule = Object.keys(u.modules).sort(function(a, b) { return u.modules[b] - u.modules[a]; })[0];
      var topModuleLabel = topModule ? (MODULE_META[topModule] || { label: topModule }).label : '—';
      return '<div style="display:flex; align-items:center; gap:12px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.04);">' +
        '<div style="min-width:140px; font-size:12.5px; color:#fff; font-weight:600;">' + esc(u.name) + '</div>' +
        '<div style="flex:1; background:rgba(255,255,255,0.04); border-radius:4px; height:8px; overflow:hidden;"><div style="height:100%; width:' + pct + '%; background:linear-gradient(90deg, rgba(31,200,195,0.6), rgba(31,200,195,0.3)); border-radius:4px; transition:width .4s;"></div></div>' +
        '<div style="min-width:60px; text-align:right; font-size:12px; color:#fff; font-weight:700;">' + u.thisWeek + ' acciones</div>' +
        '<div style="min-width:70px; text-align:right;">' + trend + '</div>' +
        '<div style="min-width:90px; font-size:10.5px; color:var(--text-dim); text-align:right;">' + esc(topModuleLabel) + '</div>' +
        '<div style="min-width:80px; font-size:10.5px; color:var(--accent); text-align:right;" title="Tiempo estimado activo esta semana (ventanas de ≤30 min entre acciones)">' + (u.thisWeek > 0 ? '≈ ' + fmtMinutes(u.activeMs) : '—') + '</div>' +
      '</div>';
    }).join('');
  }

  function renderTopEntities(entities) {
    var el = $('supTopEntities');
    if (!el) return;
    if (!entities.length) { el.innerHTML = '<div style="color:var(--text-dim); font-size:12px;">Sin datos últimos 7 días.</div>'; return; }
    el.innerHTML = entities.map(function(e, i) {
      var meta = MODULE_META[e.module] || { icon: 'fa-circle', color: '#6B7280' };
      return '<div style="display:flex; align-items:center; gap:12px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.04);">' +
        '<div style="width:22px; height:22px; border-radius:6px; background:' + meta.color + '22; color:' + meta.color + '; font-size:10px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0;">' + (i+1) + '</div>' +
        '<div class="sup-act-icon" style="width:26px; height:26px; font-size:11px; background:' + meta.color + '18; color:' + meta.color + '; border:1px solid ' + meta.color + '33; flex-shrink:0;"><i class="fas ' + meta.icon + '"></i></div>' +
        '<div style="flex:1; font-size:12.5px; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(e.label) + '</div>' +
        '<div style="font-size:11px; color:var(--text-dim);">' + e.count + ' acciones</div>' +
      '</div>';
    }).join('');
  }

  function renderSummaryPanels() {
    Promise.all([fetchWeekComparison(), fetchTopEntities()]).then(function(res) {
      renderWeekComparison(res[0]);
      renderTopEntities(res[1]);
    }).catch(function(err) { console.error('[sup] panels:', err); });
  }

  function renderErrors(events) {
    var el = $('supErrorsList');
    if (!el) return;
    if (!events.length) {
      el.innerHTML = '<div class="sup-act-empty" style="background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:16px;"><i class="fas fa-check-circle" style="color:#10B981;"></i>Sin errores en los últimos 30 días</div>';
      setText('supErrorsCount', '');
      return;
    }
    var critCount = events.filter(function(e) { return e.status === 'critical'; }).length;
    setText('supErrorsCount', events.length + ' evento' + (events.length !== 1 ? 's' : '') + ' con error (30d)' + (critCount ? ' · ' + critCount + ' críticos' : ''));
    el.innerHTML = events.map(function(e) {
      var m = MODULE_META[e.module] || { icon: 'fa-circle', color: '#6B7280', label: e.module || '—' };
      var verb = ACTION_VERBS[e.action] || e.action;
      var p = _profilesById[e.user_id];
      var who = (p && p.full_name) || (e.role_snapshot ? 'Sistema (' + e.role_snapshot + ')' : 'Sistema');
      var crit = e.status === 'critical';
      var mKeys = (e.metadata && typeof e.metadata === 'object') ? Object.keys(e.metadata) : [];
      var metaHtml = mKeys.length
        ? '<div class="sup-err-meta" style="display:none; margin-top:8px; gap:6px; flex-wrap:wrap;">' +
          mKeys.map(function(k) {
            var v = e.metadata[k];
            if (v === null || v === undefined) v = '—';
            else if (typeof v === 'object') v = JSON.stringify(v);
            return '<span style="font-size:10.5px; background:rgba(255,255,255,0.04); padding:3px 8px; border-radius:6px; color:var(--text-dim);"><strong style="color:#fff;">' + esc(k) + ':</strong> ' + esc(String(v).substring(0, 60)) + '</span>';
          }).join('') + '</div>'
        : '';
      return '<div class="sup-err-row" style="background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-left:4px solid ' + (crit ? '#EF4444' : '#F97316') + '; border-radius:12px; padding:14px 18px; cursor:' + (mKeys.length ? 'pointer' : 'default') + ';">' +
        '<div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">' +
          '<span style="font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; padding:3px 8px; border-radius:6px; background:' + (crit ? 'rgba(239,68,68,0.15)' : 'rgba(249,115,22,0.12)') + '; color:' + (crit ? '#EF4444' : '#F97316') + ';">' + esc(e.status) + '</span>' +
          '<div class="sup-act-icon" style="width:26px; height:26px; font-size:11px; background:' + m.color + '18; color:' + m.color + '; border:1px solid ' + m.color + '33;"><i class="fas ' + m.icon + '"></i></div>' +
          '<div style="flex:1; font-size:13px; color:#fff;"><strong>' + esc(verb) + '</strong>' + (verb.indexOf(' en ') === -1 ? ' en ' + esc(m.label) : '') +
            (e.entity_label ? ' · <span style="color:' + m.color + ';">' + esc(e.entity_label) + '</span>' : '') +
            (e.table_name ? ' <span style="font-size:11px; color:var(--text-dim);">(tabla ' + esc(e.table_name) + ')</span>' : '') +
          '</div>' +
          '<div style="font-size:11.5px; color:var(--text-dim); white-space:nowrap;">' + esc(who) + '</div>' +
          '<div style="font-size:11.5px; color:var(--text-dim); font-family:ui-monospace,monospace; white-space:nowrap;">' + fmtDateTime(e.created_at) + '</div>' +
          (mKeys.length ? '<i class="fas fa-chevron-down" style="color:var(--text-dim); font-size:11px;"></i>' : '') +
        '</div>' + metaHtml + '</div>';
    }).join('');

    el.querySelectorAll('.sup-err-row').forEach(function(row) {
      row.addEventListener('click', function() {
        var meta = row.querySelector('.sup-err-meta');
        if (!meta) return;
        var open = meta.style.display !== 'none';
        meta.style.display = open ? 'none' : 'flex';
      });
    });
  }

  async function loadErrors() {
    var el = $('supErrorsList');
    if (el) el.innerHTML = '<div class="sup-act-empty" style="background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:16px;"><i class="fas fa-spinner fa-spin"></i>Cargando errores...</div>';
    try {
      renderErrors(await fetchErrors());
    } catch (err) {
      console.error('[sup] errors:', err);
      if (el) el.innerHTML = '<div class="sup-act-empty" style="color:var(--danger);"><i class="fas fa-exclamation-triangle"></i>Error: ' + esc(err.message) + '</div>';
    }
  }

  function renderAlerts(alerts) {
    var el = $('supAlertsList');
    if (!el) return;
    if (!alerts.length) {
      el.innerHTML = '<div class="sup-act-empty" style="background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:16px;"><i class="fas fa-check-circle" style="color:#10B981;"></i>No hay alertas en ese estado</div>';
      return;
    }
    el.innerHTML = alerts.map(function(a) {
      var meta = SEVERITY_META[a.severity] || SEVERITY_META.medium;
      var p = _profilesById[a.user_id];
      var actor = p ? p.full_name : 'Sistema';
      var moduleLabel = (MODULE_META[a.module] || {}).label || a.module || '—';
      var evidence = '';
      if (a.evidence && typeof a.evidence === 'object') {
        var keys = Object.keys(a.evidence);
        if (keys.length) {
          evidence = '<div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">' +
            keys.slice(0, 4).map(function(k) {
              var v = a.evidence[k];
              if (typeof v === 'object') v = JSON.stringify(v);
              return '<span style="font-size:10.5px; background:rgba(255,255,255,0.04); padding:3px 8px; border-radius:6px; color:var(--text-dim);"><strong style="color:#fff;">' + esc(k) + ':</strong> ' + esc(String(v).substring(0, 50)) + '</span>';
            }).join('') +
          '</div>';
        }
      }
      return '<div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-left:4px solid ' + meta.color + '; border-radius:12px; padding:18px 20px;">' +
        '<div style="display:flex; gap:12px; align-items:flex-start; justify-content:space-between; flex-wrap:wrap;">' +
          '<div style="flex:1; min-width:0;">' +
            '<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">' +
              '<span style="font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; padding:3px 8px; border-radius:6px; background:' + meta.color + '22; color:' + meta.color + ';">' + meta.label + '</span>' +
              '<span style="font-size:11px; color:var(--text-dim);">' + esc(moduleLabel) + '</span>' +
              '<span style="font-size:11px; color:var(--text-dim);">·</span>' +
              '<span style="font-size:11px; color:var(--text-dim);">' + timeAgo(a.created_at) + '</span>' +
              (a.user_id ? '<span style="font-size:11px; color:var(--text-dim);">· ' + esc(actor) + '</span>' : '') +
            '</div>' +
            '<div style="font-size:14px; font-weight:600; color:#fff; margin-bottom:4px;">' + esc(a.title) + '</div>' +
            (a.description ? '<div style="font-size:12.5px; color:var(--text-secondary); line-height:1.5;">' + esc(a.description) + '</div>' : '') +
            evidence +
          '</div>' +
          (a.status === 'open' ? '<div style="display:flex; gap:8px; flex-shrink:0;">' +
            '<button type="button" class="status-pill active sup-alert-act" data-aid="' + esc(a.id) + '" data-act="acknowledged" style="padding:6px 12px; font-size:11px; cursor:pointer;"><i class="fas fa-check"></i> Reconocer</button>' +
            '<button type="button" class="status-pill pending sup-alert-act" data-aid="' + esc(a.id) + '" data-act="resolved" style="padding:6px 12px; font-size:11px; cursor:pointer;"><i class="fas fa-check-double"></i> Resolver</button>' +
          '</div>' : '<span style="font-size:11px; color:' + meta.color + '; font-weight:600; text-transform:uppercase;">' + esc(a.status) + '</span>') +
        '</div></div>';
    }).join('');
    setText('supAlertsCount', alerts.length + ' alerta' + (alerts.length !== 1 ? 's' : ''));
  }

  function renderFeedEntries(containerId, entries, append, showUser) {
    var el = $(containerId);
    if (!el) return;

    if (!entries.length && !append) {
      el.innerHTML = '<div class="sup-act-empty"><i class="fas fa-inbox"></i>Sin actividad con esos filtros</div>';
      return;
    }

    var groups = {};
    var order = [];
    entries.forEach(function(e) {
      var key = fmtDateHeader(e.created_at);
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(e);
    });

    var html = '';
    order.forEach(function(dateKey) {
      html += '<div class="sup-act-date-sep">' + esc(dateKey) + '</div>';
      groups[dateKey].forEach(function(e) { html += buildRow(e, showUser); });
    });

    if (append) el.insertAdjacentHTML('beforeend', html);
    else el.innerHTML = html;
  }

  function showView(name) {
    _view = name;
    var team = $('supTeamBoard');
    var feed = $('supGlobalFeedView');
    var detail = $('supEmployeeDetail');
    var alerts = $('supAlertsView');
    var errors = $('supErrorsView');
    if (team) team.style.display = name === 'team' ? 'block' : 'none';
    if (feed) feed.style.display = name === 'feed' ? 'block' : 'none';
    if (detail) detail.style.display = name === 'detail' ? 'block' : 'none';
    if (alerts) alerts.style.display = name === 'alerts' ? 'block' : 'none';
    if (errors) errors.style.display = name === 'errors' ? 'block' : 'none';
    var tabTeam = $('supTabTeam');
    var tabFeed = $('supTabFeed');
    var tabAlerts = $('supTabAlerts');
    var tabErrors = $('supTabErrors');
    if (tabTeam) tabTeam.classList.toggle('is-active', name === 'team' || name === 'detail');
    if (tabFeed) tabFeed.classList.toggle('is-active', name === 'feed');
    if (tabAlerts) tabAlerts.classList.toggle('is-active', name === 'alerts');
    if (tabErrors) tabErrors.classList.toggle('is-active', name === 'errors');
  }

  function openDetail(uid, uname, urole, uemail) {
    _currentUserId = uid;
    _currentUserName = uname;
    _currentUserRole = urole;
    _currentUserEmail = uemail;
    _detPage = 0;
    _detModuleFilter = '';
    _detSearch = '';
    var mf = $('supActivityModuleFilter');
    if (mf) mf.value = '';
    var ds = $('supDetailSearch');
    if (ds) ds.value = '';
    showView('detail');
    renderDetailHeader(uname, urole, uemail);
    var statsEl = $('supEmployeeStats');
    if (statsEl) statsEl.innerHTML = '<div class="sup-kpi"><div class="sup-kpi-label">Cargando</div><div class="sup-kpi-num">…</div></div>';
    setLoading('supEmployeeActivity');
      fetchUserSummary(uid).then(renderEmployeeStats).catch(function() {});
      fetchUser7Day(uid).then(function(d) { renderDayChart(d.days); renderHourChart(d.hours); }).catch(function() {});
    loadDetailActivity().catch(function(err) { console.error('[sup] detail:', err); showErr('supEmployeeActivity', err); });
  }

  async function loadDetailActivity() {
    var entries = await fetchUserActivity(_currentUserId, _detPage);
    renderFeedEntries('supEmployeeActivity', entries, _detPage > 0, false);
    var more = $('supEmployeeLoadMore');
    if (more) more.style.display = entries.length === PAGE_SIZE ? 'inline-flex' : 'none';
  }

  async function loadBoard() {
    var grid = $('supTeamGrid');
    if (!grid) return;
    grid.innerHTML = '<div style="text-align:center;padding:60px;grid-column:1/-1;color:var(--accent);"><i class="fas fa-spinner fa-spin" style="font-size:28px;margin-bottom:10px;"></i><div>Cargando equipo...</div></div>';

    try {
      if (!db()) throw new Error('Sin conexión con Supabase');
      if (!_profiles.length) {
        _profiles = await fetchProfiles();
        _profilesById = {};
        _profiles.forEach(function(p) { _profilesById[p.id] = p; });
        var feedUserFilter = $('supFeedUserFilter');
        if (feedUserFilter && feedUserFilter.options.length <= 1) {
          _profiles.forEach(function(p) {
            var opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.full_name;
            feedUserFilter.appendChild(opt);
          });
        }
      }
      var userIds = _profiles.map(function(p) { return p.id; });
      var results = await Promise.all([
        fetchLastActivity(userIds),
        fetchTodayStats(),
        fetchRecentErrors(),
        fetchLatestEvent(),
        fetchDayCount(-1)
      ]);
      var lastAct = results[0];
      var stats = results[1];
      var errCount = results[2];
      var latest = results[3];
      var yesterdayCount = results[4];

      var totalToday = 0;
      var activeUsers = 0;
      Object.keys(stats).forEach(function(uid) {
        totalToday += stats[uid].total;
        if (stats[uid].total > 0) activeUsers++;
      });

      renderKpis(stats, errCount, latest, { totalToday: totalToday, activeUsers: activeUsers, yesterday: yesterdayCount });
      renderDeletesBanner(stats);
      renderInactiveToday(_profiles, stats);

      var roleFilter = $('supRoleFilter') ? $('supRoleFilter').value : '';
      _boardCache = { profiles: _profiles, lastAct: lastAct, stats: stats };
      renderTeamBoard(_profiles, lastAct, stats, roleFilter);
      renderSummaryPanels();
    } catch (err) {
      console.error('[sup] loadBoard:', err);
      showErr('supTeamGrid', err);
    }
  }

  async function loadFeed() {
    setLoading('supGlobalFeed');
    try {
      var entries = await fetchGlobalFeed(_feedPage);
      _feedCache = _feedPage === 0 ? entries : _feedCache.concat(entries);
      renderFeedEntries('supGlobalFeed', entries, _feedPage > 0, true);
      setText('supFeedCount', _feedCache.length + ' evento' + (_feedCache.length !== 1 ? 's' : '') + ' cargados');
      var more = $('supFeedLoadMore');
      if (more) more.style.display = entries.length === PAGE_SIZE ? 'inline-flex' : 'none';
    } catch (err) {
      console.error('[sup] feed:', err);
      showErr('supGlobalFeed', err);
    }
  }

  function exportBoard() {
    if (!_boardCache) return;
    var rows = _profiles.map(function(p) {
      var st = _boardCache.stats[p.id] || { props: 0, leads: 0, ml: 0, other: 0, errors: 0, total: 0 };
      var last = _boardCache.lastAct[p.id];
      return {
        nombre: p.full_name,
        email: p.email || '',
        rol: (ROLE_META[p.role] || {}).label || p.role,
        ultima_actividad: last ? fmtDateTime(last) : 'Nunca',
        propiedades_hoy: st.props,
        leads_hoy: st.leads,
        portales_hoy: st.ml,
        total_hoy: st.total,
        errores_hoy: st.errors
      };
    });
    downloadCSV('equipo-supervision-' + new Date().toISOString().slice(0, 10) + '.csv', rows);
  }

  function exportFeed() {
    downloadCSV('actividad-global-' + new Date().toISOString().slice(0, 10) + '.csv', activityToCsvRows(_feedCache));
  }

  function exportUserActivity() {
    var container = $('supEmployeeActivity');
    if (!container) return;
    db().from('audit_log')
      .select('id, user_id, action, module, entity_label, entity_type, changed_fields, metadata, status, created_at')
      .eq('user_id', _currentUserId)
      .neq('module', 'supervision')
      .order('created_at', { ascending: false })
      .limit(1000)
      .then(function(res) {
        if (res.error) return;
        var safeName = (_currentUserName || 'usuario').replace(/\s+/g, '-').toLowerCase();
        downloadCSV('actividad-' + safeName + '-' + new Date().toISOString().slice(0, 10) + '.csv', activityToCsvRows(res.data || []));
      });
  }

  async function loadAlerts() {
    var el = $('supAlertsList');
    if (el) el.innerHTML = '<div class="sup-act-empty" style="background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:16px;"><i class="fas fa-spinner fa-spin"></i>Cargando alertas...</div>';
    try {
      var status = $('supAlertStatusFilter') ? $('supAlertStatusFilter').value : 'open';
      var severity = $('supAlertSeverityFilter') ? $('supAlertSeverityFilter').value : '';
      var alerts = await fetchAlerts(status, severity);
      renderAlerts(alerts);
    } catch (err) {
      console.error('[sup] alerts:', err);
      if (el) el.innerHTML = '<div class="sup-act-empty" style="color:var(--danger);"><i class="fas fa-exclamation-triangle"></i>Error: ' + esc(err.message) + '</div>';
    }
  }

  async function refreshAlertsBadge() {
    try {
      var res = await db().from('supervision_alerts').select('id', { count: 'exact', head: true }).eq('status', 'open');
      var n = res.count || 0;
      var badge = $('supAlertsBadge');
      if (badge) {
        if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.style.display = ''; }
        else badge.style.display = 'none';
      }
      var side = $('sideBadgeSupervision');
      if (side) {
        if (n > 0) { side.textContent = n > 99 ? '99+' : String(n); side.style.display = ''; }
        else side.style.display = 'none';
      }
    } catch (_) {}
  }

  async function refreshErrorsBadge() {
    try {
      var n = await fetchRecentErrors();
      var badge = $('supErrorsBadge');
      if (!badge) return;
      if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.style.display = ''; }
      else badge.style.display = 'none';
    } catch (_) {}
  }

  function bind() {
    if (_bound) return;
    _bound = true;

    var tabTeam = $('supTabTeam');
    if (tabTeam) tabTeam.addEventListener('click', function() {
      showView('team');
      loadBoard();
    });

    var tabFeed = $('supTabFeed');
    if (tabFeed) tabFeed.addEventListener('click', function() {
      showView('feed');
      _feedPage = 0;
      loadFeed();
    });

    var refresh = $('supRefreshBtn');
    if (refresh) refresh.addEventListener('click', function() { _profiles = []; loadBoard(); });

    var roleFilter = $('supRoleFilter');
    if (roleFilter) roleFilter.addEventListener('change', function() {
      if (_boardCache) renderTeamBoard(_boardCache.profiles, _boardCache.lastAct, _boardCache.stats, this.value);
    });

    var exportBtn = $('supExportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportBoard);

    var copyBtn = $('supCopySummaryBtn');
    if (copyBtn) copyBtn.addEventListener('click', copyDailySummary);

    var back = $('supBackToTeamBtn');
    if (back) back.addEventListener('click', function() {
      _currentUserId = null;
      showView('team');
    });

    var detModule = $('supActivityModuleFilter');
    if (detModule) detModule.addEventListener('change', function() {
      _detModuleFilter = this.value;
      _detPage = 0;
      if (_currentUserId) loadDetailActivity().catch(function(err) { showErr('supEmployeeActivity', err); });
    });

    var detMore = $('supEmployeeLoadMore');
    if (detMore) detMore.addEventListener('click', function() {
      _detPage++;
      if (_currentUserId) loadDetailActivity().catch(function(err) { showErr('supEmployeeActivity', err); });
    });

    var feedApply = $('supFeedApplyBtn');
    if (feedApply) feedApply.addEventListener('click', function() {
      _feedPage = 0;
      loadFeed();
    });

    var feedSearch = $('supFeedSearch');
    if (feedSearch) feedSearch.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter') { _feedPage = 0; loadFeed(); }
    });

    var feedMore = $('supFeedLoadMore');
    if (feedMore) feedMore.addEventListener('click', function() {
      _feedPage++;
      loadFeed();
    });

    var feedExport = $('supFeedExportBtn');
    if (feedExport) feedExport.addEventListener('click', exportFeed);

    var userExport = $('supExportUserActivityBtn');
    if (userExport) userExport.addEventListener('click', exportUserActivity);

    var detSearch = $('supDetailSearch');
    if (detSearch) detSearch.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter') {
        _detSearch = this.value.trim();
        _detPage = 0;
        if (_currentUserId) loadDetailActivity().catch(function(err) { showErr('supEmployeeActivity', err); });
      }
    });

    ['supGlobalFeed', 'supEmployeeActivity'].forEach(function(cid) {
      var c = $(cid);
      if (!c) return;
      c.addEventListener('click', function(ev) {
        var ent = ev.target.closest('.sup-act-ent');
        if (ent) {
          ev.stopPropagation();
          var row = ent.closest('.sup-act-row');
          if (row && row.dataset.entity) showEntityHistory(row.dataset.entity, row.dataset.module);
          return;
        }
        var row = ev.target.closest('.sup-act-row');
        if (row && row.dataset.aid) toggleDetail(row, c);
      });
    });

    var quickMap = { supQuickAll: null, supQuickDeletes: 'delete', supQuickPrices: 'price', supQuickSensitive: 'sensitive', supQuickErrors: 'errors' };
    Object.keys(quickMap).forEach(function(id) {
      var chip = $(id);
      if (!chip) return;
      chip.addEventListener('click', function() {
        var kind = quickMap[id];
        _quickFilter = kind ? { kind: kind } : null;
        Object.keys(quickMap).forEach(function(otherId) {
          var other = $(otherId);
          if (other) {
            other.classList.toggle('is-active', otherId === id && kind !== null);
            other.classList.toggle('danger', (kind === 'errors' || kind === 'delete') && otherId === id);
          }
        });
        _feedPage = 0;
        loadFeed();
      });
    });

    var autoToggle = $('supAutoRefreshToggle');
    if (autoToggle) autoToggle.addEventListener('click', function() {
      var on = this.classList.toggle('on');
      this.setAttribute('aria-checked', on ? 'true' : 'false');
      if (_autoRefreshTimer) { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null; }
      if (on) {
        _autoRefreshTimer = setInterval(function() {
          if (_view === 'team') loadBoard();
          else if (_view === 'feed') loadFeed();
          else if (_view === 'errors') loadErrors();
        }, 60000);
      }
    });

    var humansToggle = $('supFeedHumansOnly');
    if (humansToggle) humansToggle.addEventListener('click', function() {
      var on = this.classList.toggle('is-active');
      _humansOnly = on;
      _feedPage = 0;
      loadFeed();
    });

    var tabAlerts = $('supTabAlerts');
    if (tabAlerts) tabAlerts.addEventListener('click', function() {
      showView('alerts');
      loadAlerts();
    });

    var tabErrors = $('supTabErrors');
    if (tabErrors) tabErrors.addEventListener('click', function() {
      showView('errors');
      loadErrors();
    });

    var errorsRefresh = $('supErrorsRefreshBtn');
    if (errorsRefresh) errorsRefresh.addEventListener('click', loadErrors);

    var alertStatus = $('supAlertStatusFilter');
    if (alertStatus) alertStatus.addEventListener('change', loadAlerts);

    var alertSeverity = $('supAlertSeverityFilter');
    if (alertSeverity) alertSeverity.addEventListener('change', loadAlerts);

    document.addEventListener('click', function(ev) {
      var btn = ev.target.closest('.sup-alert-act');
      if (!btn) return;
      var aid = btn.getAttribute('data-aid');
      var act = btn.getAttribute('data-act');
      btn.disabled = true;
      btn.style.opacity = '0.5';
      updateAlertStatus(aid, act).then(function() {
        loadAlerts();
        refreshAlertsBadge();
      }).catch(function(err) {
        console.error('[sup] updateAlert:', err);
        btn.disabled = false;
        btn.style.opacity = '1';
      });
    });
  }

  window.adminSupervision = {
    load: async function() {
      if (!db()) {
        var grid = $('supTeamGrid');
        if (grid) grid.innerHTML = '<div style="text-align:center;padding:40px;grid-column:1/-1;color:var(--danger);"><i class="fas fa-wifi" style="font-size:24px;margin-bottom:8px;"></i><div>Sin conexión con Supabase</div></div>';
        return;
      }
      bind();
      refreshAlertsBadge();
      refreshErrorsBadge();
      if (_view === 'feed') {
        loadFeed();
      } else if (_view === 'alerts') {
        loadAlerts();
      } else if (_view === 'errors') {
        loadErrors();
      } else if (_view === 'detail' && _currentUserId) {
        loadDetailActivity().catch(console.error);
      } else {
        showView('team');
        await loadBoard();
      }
    }
  };

  function initBadge() {
    if (!db()) { setTimeout(initBadge, 400); return; }
    refreshAlertsBadge();
    refreshErrorsBadge();
    setInterval(function() { refreshAlertsBadge(); refreshErrorsBadge(); }, 120000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBadge);
  else setTimeout(initBadge, 1200);

})();
