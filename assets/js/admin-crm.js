/* ============================================================
   BIENENHAUS - Admin CRM Module
   Vista de tabla + panel lateral para leads (reemplaza Kanban).
   - window.supabaseClient (RLS via supabaseClient auth session)
   - window.BHUtils.esc para escapar todo contenido no confiable
   - Toast minimo propio (usa #toastMsg/#toastText existentes)
   ============================================================ */
(function () {
'use strict';

var LEAD_STATUSES = ['nuevo','contactado','calificado','visita_agendada','visita_realizada','negociacion','cerrado_ganado','cerrado_perdido'];
var STATUS_LABELS = {
  nuevo: 'Nuevo', contactado: 'Contactado', calificado: 'Calificado',
  visita_agendada: 'Visita agendada', visita_realizada: 'Visita realizada',
  negociacion: 'Negociacion', cerrado_ganado: 'Ganado', cerrado_perdido: 'Perdido',
  visita: 'Visita agendada', oferta: 'Negociacion', cerrado: 'Ganado', perdido: 'Perdido'
};
var LEGACY_STAGE_MAP = { visita: 'visita_agendada', oferta: 'negociacion', cerrado: 'cerrado_ganado', perdido: 'cerrado_perdido' };
var ORIGINS = ['manual','landing','ml','chat','referido','tasacion','walkin','contacto','propiedad','whatsapp','web'];
var ORIGIN_LABELS = { manual:'Manual', landing:'Landing', ml:'Mercado Libre', chat:'Chat', referido:'Referido', tasacion:'Tasacion', walkin:'Walk-in', contacto:'Contacto', propiedad:'Propiedad', whatsapp:'WhatsApp', web:'Web' };
var TIPO_CLIENTE_OPTS = ['propietario','comprador','inversor'];
var OPERATION_OPTS = ['compra','venta','alquiler'];

var PAGE_SIZE = 25;
var _page = 1, _totalPages = 1, _totalRows = 0;
var _leads = [];
var _agents = [];
var _selectedLeadId = null;
var _hasFollowupFilter = false;
var _searchTimer = null;
var __initialized = false;
var _viewMode = 'leads';
var _owners = [];
var _ownerTasks = {};
var _agentMapById = {};
var _ownerProps = {};
var _nextActions = {};

function $id(id) { return document.getElementById(id); }
function esc(s) {
  if (window.BHUtils && typeof window.BHUtils.esc === 'function') return window.BHUtils.esc(s);
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtDate(d) {
  if (!d) return null;
  try { return new Date(d).toLocaleDateString('es-AR', { day:'2-digit', month:'short', year:'numeric' }); } catch (e) { return null; }
}
function fmtDateTime(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleString('es-AR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }); } catch (e) { return ''; }
}
function fmtCurrency(v) {
  var n = Number(v);
  if (!isFinite(n)) return '-';
  return n.toLocaleString('es-AR');
}
function toast(msg, type) {
  var t = $id('toastMsg');
  var txt = $id('toastText');
  if (!t || !txt) { try { console.log('[crm]', msg); } catch (e) {} return; }
  txt.textContent = msg;
  t.classList.remove('is-error', 'is-success');
  if (type === 'error') t.classList.add('is-error');
  else if (type === 'success') t.classList.add('is-success');
  t.classList.add('is-visible');
  clearTimeout(window.__crmToastTimer);
  window.__crmToastTimer = setTimeout(function(){ t.classList.remove('is-visible'); }, 3500);
}
function getInitials(name) {
  if (!name) return '?';
  var parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}
function getAvatarColor(name) {
  var colors = ['#20B8AB','#3b82f6','#8C64DC','#e67e22','#39D98A','#CC3535','#FFB432','#1abc9c','#9b59b6','#e74c3c'];
  var hash = 0;
  for (var i = 0; i < String(name || '').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}
function getPriority(score) {
  if (score == null) return 'baja';
  if (score >= 70) return 'alta';
  if (score >= 40) return 'media';
  return 'baja';
}
function getPriorityLabel(p) { return p === 'alta' ? 'Alta' : p === 'media' ? 'Media' : 'Baja'; }
function isFollowupDue(d) { if (!d) return false; return new Date(d) <= new Date(); }
function hasRecentActivity(d) {
  if (!d) return false;
  return (Date.now() - new Date(d).getTime()) / 86400000 < 7;
}
function normalizeStage(s) { return LEGACY_STAGE_MAP[s] || s; }

/* -- Data access (Supabase directo, RLS via sesion) -- */
function db() { return window.supabaseClient; }

async function loadAgents() {
  try {
    var r = await db().from('agents').select('id, full_name').eq('status', 'activo').is('deleted_at', null).order('full_name');
    _agents = (r && r.data) || [];
    window._crmAgents = _agents;
    var sel = $id('crmAgentFilter');
    if (sel) sel.innerHTML = '<option value="">Todos los agentes</option>' +
      _agents.map(function (a) { return '<option value="' + a.id + '">' + esc(a.full_name) + '</option>'; }).join('');
  } catch (e) { console.warn('[crm] loadAgents:', e.message); }
}

function applyBaseFilters(q) {
  var sv = $id('crmSearch'); if (sv && sv.value.trim()) {
    var s = sv.value.trim().replace(/[%_]/g, ' ');
    q = q.or('full_name.ilike.%' + s + '%,email.ilike.%' + s + '%,phone.ilike.%' + s + '%');
  }
  var st = $id('crmStatusFilter'); if (st && st.value) q = q.eq('stage', st.value);
  var or = $id('crmOriginFilter'); if (or && or.value) q = q.eq('source', or.value);
  var tc = $id('crmTipoClienteFilter'); if (tc && tc.value) q = q.eq('tipo_cliente', tc.value);
  var tp = $id('crmTipoOperacionFilter'); if (tp && tp.value) q = q.eq('operation_type', tp.value);
  var ag = $id('crmAgentFilter'); if (ag && ag.value) q = q.eq('assigned_to', ag.value);
  if (_hasFollowupFilter) q = q.not('next_followup_at', 'is', 'null');
  return q.is('deleted_at', null);
}


async function loadOwners() {
  var c = $id('crmLeadList');
  if (!c) return;
  c.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim);">Cargando propietarios...</div>';
  closeDetailPanel();
  try {
    var r = await db().from('owners').select('id, full_name, email, phone, preferred_contact, exclusive, exclusive_start, exclusive_end, dni_cuit, address, notes, documents, commission_sale, commission_rent, commission_split, contract_notes, created_at').order('full_name', { ascending: true });
    if (r.error) throw new Error(r.error.message);
    _owners = r.data || [];
    /* cargar agentes (mapa) */
    var aRes = await db().from('agents').select('id, full_name');
    _agents = (aRes.data || []);
    _agents.forEach(function(x){ _agentMapById[x.id] = x.full_name; });
    window._crmAgents = _agents;
    // cargar tareas pendientes por owner (no excluidos)
    var ids = _owners.map(function (o) { return o.id; });
    _ownerTasks = {};
    if (ids.length) {
      var tRes = await db().from('owner_tasks').select('owner_id, id, title, description, status, priority, due_date').in('owner_id', ids);
    var pRes = await db().from('properties').select('id, title, property_code, price_usd, status, owner_id, agent_id').in('owner_id', ids);
    (pRes.data || []).forEach(function (p) {
      if (!_ownerProps[p.owner_id]) _ownerProps[p.owner_id] = [];
      _ownerProps[p.owner_id].push(p);
    });
      (tRes.data || []).forEach(function (tk) {
        if (!_ownerTasks[tk.owner_id]) _ownerTasks[tk.owner_id] = [];
        _ownerTasks[tk.owner_id].push(tk);
      });
    }
    renderOwnerList(c);
  } catch (e) {
    c.innerHTML = '<div style="padding:40px;text-align:center;color:var(--danger);">Error: ' + esc(e.message) + '</div>';
  }
}


function renderOwnerPropsCell(ownerId) {
  var ps = _ownerProps[ownerId] || [];
  if (!ps.length) return '<span class="crm-muted">—</span>';
  return ps.slice(0, 3).map(function (p) {
    var code = esc(p.property_code || ('PROP-' + String(p.id).slice(0, 6)).toUpperCase());
    var title = esc(p.title || '');
    var price = p.price_usd ? ('U$S ' + Number(p.price_usd).toLocaleString('es-AR')) : '';
    var status = esc(p.status || '');
    var tip = title + (price ? ' — ' + price : '') + (status ? ' (' + status + ')' : '');
    return '<span class="crm-prop-code" title="' + esc(tip) + '">' + code + '</span>';
  }).join('<span style="display:inline-block;width:4px;"></span>') + (ps.length > 3 ? '<span class="crm-prop-code crm-prop-code--muted" title="+">+' + (ps.length - 3) + '</span>' : '');
}


function renderOwnerAgentCell(ownerId) {
  var ps = _ownerProps[ownerId] || [];
  var agentIds = [];
  ps.forEach(function (p) { if (p.agent_id && agentIds.indexOf(p.agent_id) < 0) agentIds.push(p.agent_id); });
  if (!agentIds.length) return '<span class="crm-muted">—</span>';
  return agentIds.map(function (aid) {
    var nm = _agentMapById[aid] || 'Agente';
    return '<div class="crm-agent-row"><span class="crm-agent-avatar">' + getInitials(nm) + '</span><span style="font-size:12px;">' + esc(nm) + '</span></div>';
  }).join('');
}

/* -- Tabla Owners -- */
function renderOwnerList(c) {
  if (!_owners.length) {
    c.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim);">Sin propietarios cargados.</div>';
    return;
  }
  var rows = '';
  for (var i = 0; i < _owners.length; i++) {
    var o = _owners[i];
    var inits = getInitials(o.full_name);
    var avColor = getAvatarColor(o.full_name);
    var tareas = (_ownerTasks[o.id] || []).filter(function (tk) { return tk.status !== 'completada' && tk.status !== 'cancelada'; });
    var actionClass = tareas.length ? 'crm-activity-dot' : '';
    var contactMetrics = [];
    if (o.email) contactMetrics.push(o.email);
    if (o.phone) contactMetrics.push(o.phone);
    rows += '<tr class="crm-row" data-id="' + o.id + '" data-kind="owner">' +
      '<td><div class="crm-client-row"><span class="crm-client-avatar" style="background:' + avColor + '">' + inits + '</span><div><strong>' + esc(o.full_name) + '</strong>' + (o.exclusive ? '<span class="crm-tipo-chip crm-tipo-chip--estado">EXCLUSIVO</span>' : '') + '<div class="crm-meta">' + esc(contactMetrics.join(' · ')) + '</div></div></div></td>' +
      '<td>' + (o.dni_cuit ? '<code style="font-size:11px;color:var(--text-secondary);">' + esc(o.dni_cuit) + '</code>' : '<span class="crm-muted">—</span>') + '</td>' +
      '<td>' + renderOwnerPropsCell(o.id) + '</td>' +
      '<td>' + renderOwnerAgentCell(o.id) + '</td>' +
      '<td>' + (tareas.length ? '<span class="crm-priority crm-priority--media">' + tareas.length + ' pendientes</span>' : '<span class="crm-muted">—</span>') + '</td>' +
      '<td>' + (o.exclusive && o.exclusive_end ? fmtDate(o.exclusive_end) : '<span class="crm-muted">—</span>') + '</td>' +
      '<td>' + (o.created_at ? fmtDate(o.created_at) : '—') + '</td>' +
      '<td class="crm-td-actions">' +
        '<button class="btn-action" data-action="viewOwner" data-id="' + o.id + '" title="Ver detalle"><i class="fas fa-eye"></i></button>' +
        '<button class="btn-action crm-icon-action" data-action="addOwnerNote" data-id="' + o.id + '" title="Agregar nota"><i class="fas fa-sticky-note"></i></button>' +
      '</td>' +
    '</tr>';
  }
  c.innerHTML =
    '<div class="crm-table-wrap luxury-table-wrap"><table class="luxury-table crm-table">' +
      '<thead><tr>' +
        '<th>Propietario</th><th>DNI/CUIT</th><th>Propiedades</th><th>Agente asignado</th><th>Tareas pendientes</th><th>Exclusivo hasta</th><th>Creado</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' + buildPagination();
  c.querySelectorAll('.crm-row').forEach(function (r) {
    r.addEventListener('click', function () { openOwnerPanel(this.dataset.id); });
  });
  c.querySelectorAll('[data-action="viewOwner"],[data-action="addOwnerNote"]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      openOwnerPanel(this.dataset.id);
    });
  });
}

async function loadLeads() {
  var c = $id('crmLeadList');
  if (!c) return;
  c.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim);">Cargando prospectos...</div>';
  closeDetailPanel();
  try {
    var from = (_page - 1) * PAGE_SIZE;
    var to = from + PAGE_SIZE - 1;
    var countRes = await applyBaseFilters(
      db().from('leads').select('id', { count: 'exact', head: true }));
    _totalRows = (countRes && countRes.count) || 0;
    _totalPages = Math.max(1, Math.ceil(_totalRows / PAGE_SIZE));

    var q = applyBaseFilters(db().from('leads').select('id, full_name, email, phone, whatsapp, stage, source, tipo_cliente, operation_type, lead_score, assigned_to, property_id, next_followup_at, last_contacted_at, created_at')
      .order('created_at', { ascending: false }).range(from, to));
    var r = await q;
    if (r.error) { throw new Error(r.error.message); }
    _leads = r.data || [];

    /* Enriquecer: agente + propiedad */
    _agents.forEach(function (a) { _agentMapById[a.id] = a.full_name; });
    var propIds = {};
    _leads.forEach(function (l) { if (l.property_id) propIds[l.property_id] = true; });
    var props = {};
    var ids = Object.keys(propIds);
    if (ids.length) {
      var pr = await db().from('properties').select('id, title, image_urls').in('id', ids);
      (pr.data || []).forEach(function (p) { props[p.id] = p; });
    }
    var leadIds = _leads.map(function (x) { return x.id; });
    var visitsByLead = {}, tasksByLead = {};
    if (leadIds.length) {
      try {
        var vRes = await db().from('visits').select('lead_id, visit_date, status').in('lead_id', leadIds);
        (vRes.data || []).forEach(function (v) { if (!visitsByLead[v.lead_id]) visitsByLead[v.lead_id] = []; visitsByLead[v.lead_id].push(v); });
        var tRes = await db().from('lead_tasks').select('lead_id, status, due_at').in('lead_id', leadIds);
        (tRes.data || []).forEach(function (tk) { if (!tasksByLead[tk.lead_id]) tasksByLead[tk.lead_id] = []; tasksByLead[tk.lead_id].push(tk); });
      } catch (e) {}
    }
    _nextActions = {};
    _leads.forEach(function (l) {
      l.agent_name = _agentMapById[l.assigned_to] || null;
      l.props = l.property_id && props[l.property_id]
        ? [{ property_id: l.property_id, property_title: props[l.property_id].title, image: (props[l.property_id].image_urls || [])[0] || null }]
        : [];
    });

    _nextActions = {};
    _leads.forEach(function (l) {
      _nextActions[l.id] = recommendedNextAction(l, visitsByLead[l.id] || [], tasksByLead[l.id] || []);
    });
    renderLeadList(c);
    updateKpis();
    var sub = $id('crmSubtitle');
    if (sub) sub.textContent = _totalRows + ' prospectos';
    var badge = $id('sideBadgeLeads');
    if (badge) badge.textContent = _totalRows + ' Activos';
  } catch (e) {
    c.innerHTML = '<div style="padding:40px;text-align:center;color:var(--danger);">Error: ' + esc(e.message) + '</div>';
  }
}

async function updateKpis() {
  try {
    var stages = ['nuevo', 'cerrado_ganado', 'cerrado_perdido'];
    var out = { total: _totalRows, nuevo: 0, ganados: 0, perdidos: 0 };
    await Promise.all(stages.map(function (s) {
      return db().from('leads').select('id', { count: 'exact', head: true }).eq('stage', s).is('deleted_at', null)
        .then(function (r) {
          if (s === 'nuevo') out.nuevo = r.count || 0;
          else if (s === 'cerrado_ganado') out.ganados = r.count || 0;
          else out.perdidos = r.count || 0;
        });
    }));
    var el;
    el = $id('crmKpiTotal'); if (el) el.textContent = out.total;
    el = $id('crmKpiNuevo'); if (el) el.textContent = out.nuevo;
    el = $id('crmKpiGanados'); if (el) el.textContent = out.ganados;
    el = $id('crmKpiPerdidos'); if (el) el.textContent = out.perdidos;
  } catch (e) { console.warn('[crm] kpis:', e.message); }
}

/* -- Tabla -- */
function renderLeadList(c) {
  if (!_leads.length) {
    c.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim);">No hay prospectos con esos filtros.</div>';
    return;
  }
  var rows = '';
  for (var i = 0; i < _leads.length; i++) {
    var l = _leads[i];
    var stage = normalizeStage(l.stage || 'nuevo');
    var inits = getInitials(l.full_name);
    var avColor = getAvatarColor(l.full_name);
    var sb = '<span class="crm-status-badge crm-status-badge--' + stage + '"><span class="crm-status-dot crm-status-dot--' + stage + '"></span>' + (STATUS_LABELS[stage] || stage) + '</span>';
    var pr = getPriority(l.lead_score);
    var pb = '<span class="crm-priority crm-priority--' + pr + '">' + getPriorityLabel(pr) + '</span>';
    var propCell;
    if (l.props && l.props.length) {
      var p = l.props[0];
      var thumb = p.image
        ? '<img class="crm-prop-thumb" src="' + esc(p.image) + '" alt="" loading="lazy">'
        : '<span class="crm-prop-thumb crm-prop-thumb--empty"><i class="fas fa-house-chimney"></i></span>';
      propCell = '<div class="crm-prop-row">' + thumb + '<span class="crm-prop-name">' + esc(p.property_title || 'Propiedad') + '</span></div>';
    } else {
      propCell = '<span class="crm-prop-name crm-muted">Sin propiedad</span>';
    }
    var agentCell = l.agent_name
      ? '<div class="crm-agent-row"><span class="crm-agent-avatar">' + getInitials(l.agent_name) + '</span><span>' + esc(l.agent_name) + '</span></div>'
      : '<span class="crm-muted">&#8212;</span>';
    var actDot = hasRecentActivity(l.last_contacted_at) ? '<span class="crm-activity-dot"></span> ' : '';
    var actTxt = l.last_contacted_at ? fmtDate(l.last_contacted_at) : '&#8212;';
    var rec = _nextActions[l.id];
    var nextTxt = l.next_followup_at
      ? '<span class="crm-next-action' + (isFollowupDue(l.next_followup_at) ? ' crm-next-action--due' : '') + '" title="' + (rec ? esc(rec) : 'Próx. acción programada') + '">' + fmtDate(l.next_followup_at) + '</span>'
      : (rec ? '<span class="crm-next-action crm-next-action--due" title="' + esc(rec) + '">⚠</span>' : '<span class="crm-muted">&#8212;</span>');
    var createdTxt = l.created_at ? fmtDate(l.created_at) : '&#8212;';
    var tipoChip = l.tipo_cliente ? '<span class="crm-tipo-chip crm-tipo-chip--' + esc(l.tipo_cliente) + '">' + esc(l.tipo_cliente) + '</span>' : '';
    rows +=
      '<tr class="crm-row" data-id="' + l.id + '">' +
        '<td><div class="crm-client-row"><span class="crm-client-avatar" style="background:' + avColor + '">' + inits + '</span><div><strong>' + esc(l.full_name) + '</strong>' + tipoChip + '<div class="crm-meta">' + esc(l.email || '') + (l.phone ? ' &middot; ' + esc(l.phone) : '') + '</div></div></div></td>' +
        '<td>' + propCell + '</td>' +
        '<td>' + agentCell + '</td>' +
        '<td>' + sb + '</td>' +
        '<td>' + pb + '</td>' +
        '<td>' + actDot + (actTxt) + '</td>' +
        '<td>' + nextTxt + '</td>' +
        '<td>' + createdTxt + '</td>' +
        '<td class="crm-td-actions">' +
          '<button class="btn-action" data-action="viewLead" data-id="' + l.id + '" title="Ver detalle"><i class="fas fa-eye"></i></button>' +
          '<button class="btn-action" data-action="editLead" data-id="' + l.id + '" title="Editar"><i class="fas fa-pen"></i></button>' +
          '<button class="btn-action danger" data-action="deleteLead" data-id="' + l.id + '" title="Eliminar"><i class="fas fa-trash"></i></button>' +
        '</td>' +
      '</tr>';
  }
  c.innerHTML =
    '<div class="crm-table-wrap luxury-table-wrap"><table class="luxury-table crm-table">' +
      '<thead><tr>' +
        '<th>Cliente</th><th>Propiedad</th><th>Agente</th><th>Estado</th><th>Prioridad</th>' +
        '<th>Actividad</th><th>Prox. Accion</th><th>Creado</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' + buildPagination();
  bindListHandlers(c);
}

function buildPagination() {
  var h = '<div class="crm-pagination">';
  if (_page > 1) h += '<button class="btn-action" data-page="' + (_page - 1) + '"><i class="fas fa-chevron-left"></i> Anterior</button>';
  h += '<span class="crm-pag-info">Pagina ' + _page + ' de ' + _totalPages + ' (' + _totalRows + ')</span>';
  if (_page < _totalPages) h += '<button class="btn-action" data-page="' + (_page + 1) + '">Siguiente <i class="fas fa-chevron-right"></i></button>';
  return h + '</div>';
}

function bindListHandlers(c) {
  c.querySelectorAll('.crm-row').forEach(function (r) {
    r.addEventListener('click', function () { openDetailPanel(this.dataset.id); });
  });
  c.querySelectorAll('[data-action="viewLead"],[data-action="editLead"],[data-action="deleteLead"]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var id = this.dataset.id;
      if (this.dataset.action === 'deleteLead') deleteLead(id);
      else openDetailPanel(id);
    });
  });
  c.querySelectorAll('[data-page]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.stopPropagation(); _page = parseInt(this.dataset.page, 10) || 1; loadLeads(); });
  });
}


function getLeadTasks(id) {
  return db().from('lead_tasks').select('*').eq('lead_id', id).order('created_at', { ascending: false }).limit(50)
    .then(function (r) { return r.data || []; }).catch(function () { return []; });
}

function getLeadVisits(id) {
  return db().from('visits').select('id, visit_date, status, client_name, client_phone, client_email, property_id, notes, agent_id').eq('lead_id', id).order('visit_date', { ascending: false }).limit(20)
    .then(function (r) { return r.data || []; }).catch(function () { return []; });
}

/* -- Panel lateral -- */
function getLeadFull(id) {
  return db().from('leads').select('*').eq('id', id).single();
}
function getLeadActivities(id) {
  return db().from('lead_activities').select('*').eq('lead_id', id).order('created_at', { ascending: false }).limit(50)
    .then(function (r) { return r.data || []; }).catch(function () { return []; });
}
function getLeadProps(id) {
  return db().from('lead_properties').select('property_id').eq('lead_id', id)
    .then(function (r) {
      var ids = (r.data || []).map(function (x) { return x.property_id; });
      if (!ids.length) return [];
      return db().from('properties').select('id, title, price_usd').in('id', ids)
        .then(function (pr) {
          return (pr.data || []).map(function (p) { return { property_id: p.id, property_title: p.title, price_usd: p.price_usd }; });
        });
    }).catch(function () { return []; });
}

function openDetailPanel(id) {
  /* fix de stacking/clipping: el panel vive dentro de #tab-leads, que está dentro de un contenedor con overflow.
     position:fixed quedaría restringido a ese padre (se ve cortado y los clics no escucha). Lo movemos a <body>. */
  var _panelNode = $id('crmSidePanel');
  if (_panelNode && _panelNode.parentNode !== document.body) { document.body.appendChild(_panelNode); }

  _selectedLeadId = id;
  var panel = $id('crmSidePanel');
  if (!panel) return;
  var backdrop = $id('crmBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'crm-backdrop'; backdrop.id = 'crmBackdrop';
    backdrop.addEventListener('click', closeDetailPanel);
    document.body.appendChild(backdrop);
  }
  panel.innerHTML = '<div class="crm-side-header"><h3>Cargando...</h3></div><div class="crm-side-body"><div style="padding:20px;text-align:center;color:var(--text-dim);">Cargando prospecto...</div></div>';
  backdrop.classList.add('open');
  panel.classList.add('open');

  Promise.all([getLeadFull(id), getLeadActivities(id), getLeadProps(id), getLeadVisits(id), getLeadTasks(id)])
    .then(function (results) {
      var leadRes = results[0];
      if (leadRes.error) throw new Error(leadRes.error.message);
      var lead = leadRes.data;
      if (!lead) throw new Error('Prospecto no encontrado');
      var activities = results[1] || [];
      var props = results[2] || [];
      var visits = results[3] || [];
      var tasks = results[4] || [];
      if (!props.length && lead.property_id) {
        /* fallback a property_id directo */
        return db().from('properties').select('id, title').eq('id', lead.property_id).single()
          .then(function (pr) {
            if (pr.data) props = [{ property_id: pr.data.id, property_title: pr.data.title }];
            renderSide(panel, lead, activities, props, visits, tasks); return null;
          });
      }
      renderSide(panel, lead, activities, props, visits, tasks);
      return null;
    })
    .catch(function (e) { toast('Error al cargar prospecto: ' + e.message, 'error'); closeDetailPanel(); });
}

function closeDetailPanel() {
  _selectedLeadId = null;
  var panel = $id('crmSidePanel');
  if (panel) panel.classList.remove('open');
  var backdrop = $id('crmBackdrop');
  if (backdrop) backdrop.classList.remove('open');
  document.querySelectorAll('.crm-row--selected').forEach(function (r) { r.classList.remove('crm-row--selected'); });
}

function renderSide(panel, lead, activities, props, visits, tasks) {
  var stage = normalizeStage(lead.stage || 'nuevo');
  var sopts = LEAD_STATUSES.map(function (s) { return '<option value="' + s + '"' + (stage === s ? ' selected' : '') + '>' + STATUS_LABELS[s] + '</option>'; }).join('');
  var aopts = _agents.map(function (a) { return '<option value="' + a.id + '"' + (lead.assigned_to === a.id ? ' selected' : '') + '>' + esc(a.full_name) + '</option>'; }).join('');
  var oopts = ORIGINS.map(function (o) { return '<option value="' + o + '"' + (lead.source === o ? ' selected' : '') + '>' + (ORIGIN_LABELS[o] || o) + '</option>'; }).join('');
  var tcOpts = TIPO_CLIENTE_OPTS.map(function (t) { return '<option value="' + t + '"' + (lead.tipo_cliente === t ? ' selected' : '') + '>' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>'; }).join('');
  var tpOpts = OPERATION_OPTS.map(function (t) { return '<option value="' + t + '"' + (lead.operation_type === t ? ' selected' : '') + '>' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>'; }).join('');

  var ph = !props || !props.length
    ? '<div class="crm-side-field-value">Sin propiedades vinculadas</div>'
    : props.map(function (p) {
        return '<div class="crm-prop-item"><span>' + esc(p.property_title || 'Propiedad') + '</span>' +
          '<button class="btn-action danger" data-action="removeProp" data-prop-id="' + p.property_id + '" title="Quitar"><i class="fas fa-times"></i></button></div>';
      }).join('');

  panel.innerHTML =
    '<div class="crm-side-header">' +
      '<div class="crm-side-header-info"><span class="crm-status-dot crm-status-dot--' + stage + '"></span><h3 class="crm-side-title">' + esc(lead.full_name) + '</h3></div>' +
      '<button class="crm-side-close" aria-label="Cerrar"><i class="fas fa-times"></i></button>' +
    '</div>' +
    '<div class="crm-side-body">' +
      sideBodyHtml(lead, sopts, aopts, oopts, tcOpts, tpOpts, ph, buildUnifiedTimeline(activities, visits, tasks)) +
      agendaSectionHtml(visits) +
      '<div id="crmTasksPanel"><div class="loading-state">Cargando tareas...</div></div>' +
      '<button class="btn-action crm-new-task-btn" id="crmNewTaskBtn">+ Nueva tarea</button>' +
      '<div class="crm-qa-row">' +
        '<button class="crm-qa-btn" data-action="logCall" aria-label="Registrar llamada"><i class="fas fa-phone"></i><span class="crm-qa-tip">Llamada</span></button>' +
        '<button class="crm-qa-btn" data-action="addNoteInline" aria-label="Agregar nota"><i class="fas fa-sticky-note"></i><span class="crm-qa-tip">Nota</span></button>' +
        '<button class="crm-qa-btn" data-action="scheduleVisit" aria-label="Agendar visita"><i class="fas fa-calendar"></i><span class="crm-qa-tip">Visita</span></button>' +
        '<button class="crm-qa-btn" data-action="scheduleFollowup" aria-label="Programar followup"><i class="fas fa-clock"></i><span class="crm-qa-tip">Followup</span></button>' +
        '<button class="crm-qa-btn crm-qa-btn--danger" data-action="markLost" aria-label="Marcar como perdido"><i class="fas fa-ban"></i><span class="crm-qa-tip">Perdido</span></button>' +
      '</div>' +
      '<div id="crmQuickActionPanel"></div>' +
      '<div class="crm-side-save"><button class="btn-luxury-action" id="crmSideSaveBtn" style="width:100%;">Guardar cambios</button></div>' +
    '</div>';
  panel.dataset.leadId = lead.id;
  panel.querySelector('.crm-side-close').addEventListener('click', closeDetailPanel);
  panel.querySelectorAll('[data-action="removeProp"]').forEach(function (b) {
    b.addEventListener('click', function () { unlinkProperty(lead.id, this.dataset.propId, panel); });
  });
  bindSideSave(lead, panel);
  bindQuickActions(lead, panel); bindPropSearch(panel, lead.id);
  window.CrmTasks.loadLeadTasks(lead.id, panel);
  bindAgendaActions(panel, lead.id);
  var ntBtn = panel.querySelector('#crmNewTaskBtn');
  if (ntBtn) ntBtn.addEventListener('click', function () { window.CrmTasks.showTaskForm(lead.id, null, panel); });
}

function sideBodyHtml(lead, sopts, aopts, oopts, tcOpts, tpOpts, ph, timelineHtml) {
  return '' +
    '<div class="crm-side-section"><h4 class="crm-side-section-title">Informacion</h4>' +
      '<div class="crm-side-fields">' +
        sideField('Nombre', 'crmDtlName', 'text', lead.full_name) +
        sideField('Email', 'crmDtlEmail', 'email', lead.email) +
        '<div class="crm-side-field-row">' +
          sideField('Telefono', 'crmDtlPhone', 'text', lead.phone) +
          sideField('WhatsApp', 'crmDtlWhatsapp', 'text', lead.whatsapp) +
        '</div>' +
        '<div class="crm-side-field"><span class="crm-side-field-label">Contacto preferido</span>' +
          '<select class="crm-field-input crm-field-input--select" id="crmDtlPrefContact">' +
          '<option value="">&#8212;</option>' +
          '<option value="phone"' + (lead.preferred_contact_method === 'phone' ? ' selected' : '') + '>Telefono</option>' +
          '<option value="whatsapp"' + (lead.preferred_contact_method === 'whatsapp' ? ' selected' : '') + '>WhatsApp</option>' +
          '<option value="email"' + (lead.preferred_contact_method === 'email' ? ' selected' : '') + '>Email</option></select></div>' +
        '<div class="crm-side-field-row">' +
          '<div class="crm-side-field"><span class="crm-side-field-label">Origen</span><select class="crm-field-input crm-field-input--select" id="crmDtlOrigin">' + oopts + '</select></div>' +
          '<div class="crm-side-field"><span class="crm-side-field-label">Tipo cliente</span><select class="crm-field-input crm-field-input--select" id="crmDtlTipoCliente"><option value="">&#8212;</option>' + tcOpts + '</select></div></div>' +
        '<div class="crm-side-field-row">' +
          '<div class="crm-side-field"><span class="crm-side-field-label">Tipo operacion</span><select class="crm-field-input crm-field-input--select" id="crmDtlTipoOp"><option value="">&#8212;</option>' + tpOpts + '</select></div>' +
          '<div class="crm-side-field"><span class="crm-side-field-label">Agente</span><select class="crm-field-input crm-field-input--select" id="crmDtlAgent"><option value="">Sin agente</option>' + aopts + '</select></div></div>' +
        '<div class="crm-side-field"><span class="crm-side-field-label">Estado</span><select class="crm-field-input crm-field-input--select" id="crmDtlStatus">' + sopts + '</select></div>' +
      '</div></div>' +
    '<div class="crm-side-section"><h4 class="crm-side-section-title">Propiedades relacionadas</h4>' +
      '<div class="crm-side-fields"><div id="crmDtlPropsWrap">' + ph +
        '<div class="crm-prop-add">' +
          '<input class="crm-field-input" id="crmDtlPropSearch" placeholder="Buscar propiedad por titulo...">' +
          '<button class="btn-action" id="crmDtlAddProp"><i class="fas fa-plus"></i></button></div>' +
        '</div></div></div>' +
    '<div class="crm-side-section"><h4 class="crm-side-section-title">Presupuesto</h4>' +
      '<div class="crm-side-fields">' +
        sideField('USD', 'crmDtlBudget', 'number', lead.budget_usd) +
        sideField('Valor estimado (USD)', 'crmDtlEstValue', 'number', lead.estimated_value) +
      '</div></div>' +
    
    '<div class="crm-side-section"><h4 class="crm-side-section-title">Actividad reciente</h4>' +
      '<div class="crm-timeline">' + (timelineHtml || buildTimelineHTML([])) + '</div></div>' +
    '<div class="crm-side-section"><h4 class="crm-side-section-title">Notas</h4>' +
      '<div class="crm-side-fields">' +
        '<textarea class="crm-field-input" id="crmDtlNotes" rows="3">' + esc(lead.notes || '') + '</textarea>' +
      '</div></div>';
}
function sideField(label, id, type, val) {
  var v = (val !== null && val !== undefined) ? String(val) : '';
  return '<div class="crm-side-field"><span class="crm-side-field-label">' + label + '</span>' +
    (type === 'number'
      ? '<input class="crm-field-input" id="' + id + '" type="number" value="' + v + '">'
      : '<input class="crm-field-input" id="' + id + '" type="' + type + '" value="' + esc(v) + '">') + '</div>';
}
function buildTimelineHTML_hardcoded() { return ''; }

function buildTimelineHTML(acts) {
  if (!acts || !acts.length) return '<div class="crm-timeline-empty">Sin actividad registrada.</div>';
  var cls = { call: 'crm-dot-call', note: 'crm-dot-note', email: 'crm-dot-email', visit: 'crm-dot-visit', followup: 'crm-dot-fup', status_change: 'crm-dot-status' };
  return acts.map(function (a) {
    var dc = cls[a.activity_type] || cls.note;
    return '<div class="crm-interaction"><span class="crm-interaction-dot ' + dc + '"></span><div class="crm-interaction-body">' +
      '<strong>' + esc(a.title || a.activity_type || '') + '</strong>' +
      '<div class="crm-interaction-text">' + esc(a.description || '') + '</div>' +
      '<div class="crm-interaction-date">' + fmtDateTime(a.created_at) + '</div></div></div>';
  }).join('');
}


function bindSideSave(lead, panel) {
  var btn = panel.querySelector('#crmSideSaveBtn');
  if (!btn) return;
  btn.addEventListener('click', async function () {
    var d = collectSideForm(panel);
    if (!d.full_name) { toast('El nombre es obligatorio.', 'error'); return; }
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';
    try {
      var r = await db().from('leads').update(d).eq('id', lead.id);
      if (r.error) { throw new Error(r.error.message); }
      toast('Prospecto actualizado.', 'success');
      _selectedLeadId = lead.id;
      await loadLeads();
      panel.querySelector('.crm-side-title').textContent = d.full_name;
    } catch (e) {
      toast('Error: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Guardar cambios';
    }
  });
  /* cambio de etapa registra actividad */
  var stSel = panel.querySelector('#crmDtlStatus');
  if (stSel) {
    var originalStage = lead.stage || 'nuevo';
    stSel.addEventListener('change', async function () {
      var newStage = this.value;
      if (newStage === normalizeStage(originalStage)) return;
      try {
        await db().from('lead_activities').insert([{
          lead_id: lead.id,
          activity_type: 'status_change',
          title: 'Cambio de estado: ' + (STATUS_LABELS[normalizeStage(originalStage)] || originalStage) + ' -> ' + (STATUS_LABELS[normalizeStage(newStage)] || newStage)
        }]);
        await db().from('leads').update({ last_contacted_at: new Date().toISOString() }).eq('id', lead.id);
        originalStage = newStage;
      } catch (e) { console.warn('[crm] log status_change:', e.message); }
    });
  }
}

function collectSideForm(panel) {
  function v(id) { var el = panel.querySelector('#' + id); return el ? (el.value.trim() || null) : null; }
  function n(id) { var val = v(id); return val && !isNaN(val) ? parseFloat(val) : null; }
  return {
    full_name: v('crmDtlName'),
    email: v('crmDtlEmail'),
    phone: v('crmDtlPhone'),
    whatsapp: v('crmDtlWhatsapp'),
    preferred_contact_method: v('crmDtlPrefContact'),
    stage: v('crmDtlStatus'),
    source: v('crmDtlOrigin'),
    tipo_cliente: v('crmDtlTipoCliente'),
    operation_type: v('crmDtlTipoOp'),
    assigned_to: v('crmDtlAgent') || null,
    budget_usd: n('crmDtlBudget'),
    estimated_value: n('crmDtlEstValue'),
    notes: v('crmDtlNotes')
  };
}

async function deleteLead(id) {
  if (!confirm('Eliminar este prospecto? Se marcara como baja logica.')) return;
  try {
    var r = await db().from('leads').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (r.error) throw new Error(r.error.message);
    toast('Prospecto eliminado.', 'success');
    closeDetailPanel();
    await loadLeads();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

/* -- Propiedades vinculadas -- */
async function unlinkProperty(leadId, propertyId, panel) {
  try {
    var r = await db().from('lead_properties').delete().eq('lead_id', leadId).eq('property_id', propertyId);
    if (r.error) throw new Error(r.error.message);
    toast('Propiedad removida.', 'success');
    var props = await getLeadProps(leadId);
    rerenderProps(panel, leadId, props);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

function rerenderProps(panel, leadId, props) {
  var wrap = panel.querySelector('#crmDtlPropsWrap');
  if (!wrap) return;
  var ph = !props || !props.length
    ? '<div class="crm-side-field-value">Sin propiedades vinculadas</div>'
    : props.map(function (p) {
        return '<div class="crm-prop-item"><span>' + esc(p.property_title || 'Propiedad') + '</span>' +
          '<button class="btn-action danger" data-action="removeProp" data-prop-id="' + p.property_id + '" title="Quitar"><i class="fas fa-times"></i></button></div>';
      }).join('');
  wrap.innerHTML = ph +
    '<div class="crm-prop-add">' +
      '<input class="crm-field-input" id="crmDtlPropSearch" placeholder="Buscar propiedad por titulo...">' +
      '<button class="btn-action" id="crmDtlAddProp"><i class="fas fa-plus"></i></button></div>';
  wrap.querySelectorAll('[data-action="removeProp"]').forEach(function (b) {
    b.addEventListener('click', function () { unlinkProperty(leadId, this.dataset.propId, panel); });
  });
  bindPropSearch(panel, leadId);
}

function bindPropSearch(panel, leadId) {
  var btn = panel.querySelector('#crmDtlAddProp');
  var inp = panel.querySelector('#crmDtlPropSearch');
  if (!btn || !inp) return;
  function renderResults(list) {
    var existing = panel.querySelector('.crm-prop-results');
    if (existing) existing.remove();
    if (!list.length) return;
    var wrap = document.createElement('div');
    wrap.className = 'crm-prop-results';
    list.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'btn-action crm-prop-result-btn';
      b.textContent = p.title || 'Propiedad';
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        linkProperty(leadId, p.id, panel);
      });
      wrap.appendChild(b);
    });
    inp.parentNode.appendChild(wrap);
  }
  var timer;
  inp.addEventListener('input', function () {
    var val = this.value.trim();
    clearTimeout(timer);
    var dd = panel.querySelector('.crm-prop-results');
    if (dd) dd.remove();
    if (val.length < 2) return;
    timer = setTimeout(function () {
      db().from('properties').select('id, title').ilike('title', '%' + val.replace(/[%_]/g, ' ') + '%').limit(8)
        .then(function (r) { renderResults(r.data || []); })
        .catch(function () {});
    }, 300);
  });
  btn.addEventListener('click', async function () {
    var val = inp.value.trim();
    if (!val) { toast('Ingresa un titulo.', 'error'); return; }
    var r = await db().from('properties').select('id, title').ilike('title', '%' + val.replace(/[%_]/g, ' ') + '%').limit(5);
    if (!r.data || !r.data.length) { toast('No se encontraron propiedades.', 'error'); return; }
    renderResults(r.data);
  });
}

async function linkProperty(leadId, propertyId, panel) {
  try {
    var r = await db().from('lead_properties').insert([{ lead_id: leadId, property_id: propertyId }]);
    if (r.error) throw new Error(r.error.message);
    toast('Propiedad agregada.', 'success');
    var dd = panel.querySelector('.crm-prop-results'); if (dd) dd.remove();
    var inp = panel.querySelector('#crmDtlPropSearch'); if (inp) inp.value = '';
    var props = await getLeadProps(leadId);
    rerenderProps(panel, leadId, props);
    await db().from('lead_activities').insert([{ lead_id: leadId, activity_type: 'note', title: 'Propiedad vinculada' }]).catch(function () {});
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

/* -- Quick actions -- */
function bindQuickActions(lead, panel) {
  var p = panel.querySelector('#crmQuickActionPanel');
  if (!p) return;
  var defs = [
    { sel: '[data-action="logCall"]', label: 'Registrar llamada', type: 'call', hasDate: false, placeholder: 'Descripcion...', actTitle: 'Llamada telefonica' },
    { sel: '[data-action="addNoteInline"]', label: 'Agregar nota', type: 'note', hasDate: false, placeholder: 'Escribi una nota...', actTitle: 'Nota' },
    { sel: '[data-action="scheduleVisit"]', label: 'Agendar visita', type: 'visit', hasDate: true, placeholder: 'Notas para la visita...', actTitle: 'Visita agendada' },
    { sel: '[data-action="scheduleFollowup"]', label: 'Programar followup', type: 'followup', hasDate: true, placeholder: 'Notas del followup...', actTitle: 'Followup programado' }
    , { sel: '[data-action="markLost"]', label: 'Marcar perdido', type: 'lost', hasDate: false, placeholder: 'Motivo del rechazo (opcional)...', actTitle: 'Perdido / Rechazado' }]

  defs.forEach(function (d) {
    var btn = panel.querySelector(d.sel);
    if (!btn) return;
    btn.addEventListener('click', function () {
      p.innerHTML = '<div class="crm-quick-panel">' +
        '<span class="crm-quick-panel-label">' + d.label + '</span>' +
        (d.hasDate ? '<input class="crm-field-input" id="crmQaDate" type="datetime-local">' : '') +
        '<textarea class="crm-field-input" id="crmQaText" rows="2" placeholder="' + d.placeholder + '"></textarea>' +
        '<div class="crm-quick-panel-actions">' +
          '<button class="btn-luxury-action" id="crmQaSave">Guardar</button>' +
          '<button class="btn-action" id="crmQaCancel">Cancelar</button>' +
        '</div></div>';
      p.querySelector('#crmQaCancel').addEventListener('click', function () { p.innerHTML = ''; });
      p.querySelector('#crmQaSave').addEventListener('click', async function () {
        var txt = (p.querySelector('#crmQaText') || {}).value || '';
        var dtEl = p.querySelector('#crmQaDate');
        var dt = dtEl ? dtEl.value : null;
        if (d.hasDate && !dt) { toast('Selecciona fecha y hora.', 'error'); return; }
        try {
          if (d.type === 'lost') {
            await db().from('leads').update({ stage: 'cerrado_perdido', last_contacted_at: new Date().toISOString() }).eq('id', lead.id);
            if (txt.trim()) {
              await db().from('lead_activities').insert([{ lead_id: lead.id, activity_type: 'note', title: 'Motivo del rechazo', description: txt.trim() }]);
            }
            toast('Marcado como perdido.', 'success');
            p.innerHTML = '';
            closeDetailPanel();
            await loadLeads();
            return;
          }
          var row = { lead_id: lead.id, activity_type: d.type, title: d.actTitle, description: txt || null };
          if (d.type === 'visit') row.activity_type = 'visit';
          if (d.type === 'followup') row.activity_type = 'followup';
          if (d.type === 'call') row.activity_type = 'call';
          var ins = await db().from('lead_activities').insert([row]);
          if (ins.error) throw new Error(ins.error.message);
          if (d.type === 'followup') {
            await db().from('leads').update({ next_followup_at: dt }).eq('id', lead.id);
          } else if (d.type === 'visit') {
            /* Solo registrar si hay propiedad: la tabla visits exige property_id NOT NULL */
            var lprops = await getLeadProps(lead.id);
            var propId = lprops.length ? lprops[0].property_id : lead.property_id;
            if (!propId) {
              toast('Vinculá una propiedad primero.', 'error');
              return;
            }
            await db().from('leads').update({ stage: 'visita_agendada' }).eq('id', lead.id);
            await db().from('visits').insert([{
              property_id: propId,
              client_name: lead.full_name || '',
              client_phone: lead.phone || null,
              client_email: lead.email || null,
              visit_date: new Date(dt).toISOString(),
              status: 'pendiente',
              lead_id: lead.id,
              notes: txt || null
            }]);
            await db().from('leads').update({ last_contacted_at: new Date().toISOString(), next_followup_at: dt }).eq('id', lead.id);
} else {
            await db().from('leads').update({ last_contacted_at: new Date().toISOString() }).eq('id', lead.id);
          }
          toast(d.label + ' guardado.', 'success');
          p.innerHTML = '';
          var acts = await getLeadActivities(lead.id);
          var tl = panel.querySelector('.crm-timeline');
          if (tl) tl.innerHTML = buildTimelineHTML(acts);
          await loadLeads();
          _selectedLeadId = lead.id;
          openDetailPanel(lead.id);
        } catch (e) { toast('Error: ' + e.message, 'error'); }
      });
    });
  });
}

/* -- Init -- */
function init() {
  if (__initialized) { loadLeads(); return; }
  __initialized = true;
  var btn = $id('btnNewLead');
  if (btn && !btn.dataset.crmBound) { btn.dataset.crmBound = '1'; /* el modal existente hace submit a loadCRM */ }
  var search = $id('crmSearch');
  if (search) search.addEventListener('input', function () {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(function () { _page = 1; loadLeads(); }, 350);
  });
  ['crmStatusFilter', 'crmOriginFilter', 'crmTipoClienteFilter', 'crmTipoOperacionFilter', 'crmAgentFilter'].forEach(function (id) {
    var el = $id(id);
    if (el) el.addEventListener('change', function () { _page = 1; loadLeads(); });
  });
  var orSel = $id('crmOriginFilter');
  if (orSel && !orSel.dataset.filled) {
    orSel.dataset.filled = '1';
    orSel.innerHTML = '<option value="">Todos los origenes</option>' +
      ORIGINS.map(function (o) { return '<option value="' + o + '">' + (ORIGIN_LABELS[o] || o) + '</option>'; }).join('');
  }
  var tcSel = $id('crmTipoClienteFilter');
  if (tcSel && !tcSel.dataset.filled) {
    tcSel.dataset.filled = '1';
    tcSel.innerHTML = '<option value="">Todos los tipos</option>' +
      TIPO_CLIENTE_OPTS.map(function (t) { return '<option value="' + t + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>'; }).join('');
  }
  var tpSel = $id('crmTipoOperacionFilter');
  if (tpSel && !tpSel.dataset.filled) {
    tpSel.dataset.filled = '1';
    tpSel.innerHTML = '<option value="">Todos</option>' +
      OPERATION_OPTS.map(function (t) { return '<option value="' + t + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>'; }).join('');
  }
  if (!$id('crmFollowupFilter') && $id('crmFollowupWrap')) {
    var wrap = $id('crmFollowupWrap');
    wrap.innerHTML = '<label class="crm-followup-chip">' +
      '<input type="checkbox" id="crmFollowupFilter">' +
      '<span>Solo con followup</span></label>';
  }
  var fup = $id('crmFollowupFilter');
  if (fup && !fup.dataset.bound) {
    fup.dataset.bound = '1';
    fup.addEventListener('change', function () { _hasFollowupFilter = !!this.checked; _page = 1; loadLeads(); });
  }
  var stSel = $id('crmStatusFilter');
  if (stSel && !stSel.dataset.filled) {
    stSel.dataset.filled = '1';
    stSel.innerHTML = '<option value="">Todos los estados</option>' +
      LEAD_STATUSES.map(function (s) { return '<option value="' + s + '">' + STATUS_LABELS[s] + '</option>'; }).join('');
  }
  _bindViewModeToggle();
  loadAgents().then(function () { return loadLeads(); });
}



/* -- Modo Lead vs Propietario -- */
function _bindViewModeToggle() {
  var btn = $id('crmModeToggle');
  if (!btn || btn.dataset.crmBound) return;
  btn.dataset.crmBound = '1';
  btn.addEventListener('click', function () {
    _viewMode = _viewMode === 'leads' ? 'owners' : 'leads';
    console.log('CRM mode:', _viewMode);
    _syncHeader();
    if (_viewMode === 'owners') loadOwners(); else loadLeads();
  });
}
function _syncHeader() {
  var btn = $id('crmModeToggle');
  var newLead = $id('btnNewLead');
  var titleEl = $id('crmTitle');
  if (btn) {
    btn.innerHTML = _viewMode === 'leads'
      ? '<i class="fas fa-user-tie"></i> Propietarios'
      : '<i class="fas fa-users"></i> Leads';
  }
  if (newLead) {
    newLead.style.display = _viewMode === 'leads' ? '' : 'none';
  }
  if (titleEl) {
    titleEl.textContent = _viewMode === 'leads' ? 'Leads & CRM' : 'Propietarios y Asignaciones';
  }
}

/* -- Panel lateral de propietario -- */
function openOwnerPanel(ownerId) {
  _selectedLeadId = null;
  var panel = $id('crmSidePanel');
  if (!panel) return;
  if (panel.parentNode !== document.body) document.body.appendChild(panel);
  var backdrop = $id('crmBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'crm-backdrop'; backdrop.id = 'crmBackdrop';
    backdrop.addEventListener('click', closeDetailPanel);
    document.body.appendChild(backdrop);
  }
  panel.innerHTML = '<div class="crm-side-header"><h3>Cargando...</h3></div><div class="crm-side-body"></div>';
  backdrop.classList.add('open');
  panel.classList.add('open');
  Promise.all([
    db().from('owners').select('*').eq('id', ownerId).single(),
    db().from('owner_tasks').select('*').eq('owner_id', ownerId).order('due_date', { ascending: true }),
    db().from('properties').select('id, title, status, price_usd, image_urls').eq('owner_id', ownerId).order('title')
  ]).then(function (res) {
    var owner = res[0].data;
    var tasks = res[1].data || [];
    var props = res[2].data || [];
    if (!owner) throw new Error('Propietario no encontrado');
    panel.innerHTML =
      '<div class="crm-side-header">' +
        '<div class="crm-side-header-info"><span class="crm-status-dot crm-status-dot--propietario"></span><h3 class="crm-side-title">' + esc(owner.full_name) + '</h3></div>' +
        '<button class="crm-side-close" aria-label="Cerrar"><i class="fas fa-times"></i></button>' +
      '</div>' +
      '<div class="crm-side-body">' +
        // info
        '<div class="crm-side-section"><h4 class="crm-side-section-title">Información</h4>' +
          '<div class="crm-side-fields">' +
            '<div class="crm-side-field"><span class="crm-side-field-label">Contacto preferido</span><div class="crm-side-field-value">' + esc(owner.preferred_contact || '—') + '</div></div>' +
            '<div class="crm-side-field"><span class="crm-side-field-label">Email</span><div class="crm-side-field-value">' + esc(owner.email || '—') + '</div></div>' +
            '<div class="crm-side-field"><span class="crm-side-field-label">Teléfono</span><div class="crm-side-field-value">' + esc(owner.phone || '—') + '</div></div>' +
            '<div class="crm-side-field"><span class="crm-side-field-label">DNI/CUIT</span><div class="crm-side-field-value">' + esc(owner.dni_cuit || '—') + '</div></div>' +
            '<div class="crm-side-field"><span class="crm-side-field-label">Dirección</span><div class="crm-side-field-value">' + esc(owner.address || '—') + '</div></div>' +
            '<div class="crm-side-field"><span class="crm-side-field-label">Exclusividad</span><div class="crm-side-field-value">' + (owner.exclusive ?
              (owner.exclusive_start ? 'Desde ' + fmtDate(owner.exclusive_start) : '') + (owner.exclusive_end ? ' hasta ' + fmtDate(owner.exclusive_end) : '') :
              'No exclusivo') + '</div></div>' +
          '</div></div>' +
        // propiedades
        '<div class="crm-side-section"><h4 class="crm-side-section-title">Propiedades (' + props.length + ')</h4>' +
          '<div class="crm-side-fields">' +
            (props.length
              ? props.map(function (p) { return '<div class="crm-prop-item"><span>' + esc(p.title || 'Sin título') + '</span><span style="margin-left:8px;color:var(--text-dim);font-size:11px;text-transform:uppercase;"><' + (p.status || 'sm') + '></span></div>'; }).join('')
              : '<div class="crm-side-field-value">Sin propiedades asignadas</div>') +
          '</div></div>' +
        // tareas
        '<div class="crm-side-section"><h4 class="crm-side-section-title">Tareas pendientes (' + tasks.filter(function(tk){ return tk.status === 'pendiente'; }).length + ')</h4>' +
          '<div class="crm-side-fields">' +
            (tasks.filter(function(tk){return tk.status !== 'completada' && tk.status !== 'cancelada'; }).length
              ? tasks.filter(function(tk){return tk.status !== 'completada' && tk.status !== 'cancelada'; }).map(function (tk) {
                  return '<div class="crm-prop-item" style="flex-direction:column;align-items:flex-start;gap:4px;">' +
                    '<strong style="font-size:13px;color:#fff;">' + esc(tk.title) + '</strong>' +
                    '<div style="font-size:12px;color:var(--text-secondary);">' + esc(tk.description || '') + '</div>' +
                    '<div style="font-size:11px;color:var(--text-dim);">' + (tk.due_date ? fmtDateTime(tk.due_date) : 'sin fecha') + ' · ' + esc(tk.priority) + '</div>' +
                    '<button class="btn-action" style="margin-top:6px;font-size:11px;" data-action="completeOwnerTask" data-task-id="' + tk.id + '"><i class="fas fa-check"></i> Completar</button>' +
                  '</div>';
                }).join('')
              : '<div class="crm-timeline-empty">Sin tareas pendientes.</div>') +
          '</div></div>' +
        // nueva tarea
        '<div class="crm-side-section"><h4 class="crm-side-section-title">Nueva tarea</h4>' +
          '<div class="crm-side-fields">' +
            '<input class="crm-field-input" id="crmOwnerTaskTitle" placeholder="Título *">' +
            '<textarea class="crm-field-input" id="crmOwnerTaskDesc" rows="2" placeholder="Descripción (opcional)"></textarea>' +
            '<input class="crm-field-input" type="datetime-local" id="crmOwnerTaskDue">' +
            '<select class="crm-field-input" id="crmOwnerTaskPriority">' +
              '<option value="baja">Baja</option>' +
              '<option value="media" selected>Media</option>' +
              '<option value="alta">Alta</option>' +
              '<option value="urgente">Urgente</option>' +
            '</select>' +
            '<button class="btn-luxury-action" id="crmOwnerTaskSave" style="width:100%;margin-top:4px;">+ Agregar tarea</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    panel.querySelector('.crm-side-close').addEventListener('click', closeDetailPanel);
    panel.querySelectorAll('[data-action="completeOwnerTask"]').forEach(function (b) {
      b.addEventListener('click', async function (e) {
        e.stopPropagation();
        var taskId = this.dataset.taskId;
        try {
          var rr = await db().from('owner_tasks').update({ status: 'completada' }).eq('id', taskId);
          if (rr.error) throw rr.error;
          toast('Tarea completada.', 'success');
          closeDetailPanel();
          openOwnerPanel(ownerId);
        } catch (err) { toast('Error: ' + err.message, 'error'); }
      });
    });
    var saveBtn = panel.querySelector('#crmOwnerTaskSave');
    if (saveBtn) saveBtn.addEventListener('click', async function () {
      var title = (panel.querySelector('#crmOwnerTaskTitle') || {}).value || '';
      var desc = (panel.querySelector('#crmOwnerTaskDesc') || {}).value || '';
      var due = (panel.querySelector('#crmOwnerTaskDue') || {}).value || '';
      var prio = (panel.querySelector('#crmOwnerTaskPriority') || {}).value || 'media';
      if (!title.trim()) { toast('El título es obligatorio.', 'error'); return; }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Guardando...';
      try {
        var rr = await db().from('owner_tasks').insert([{
          owner_id: ownerId,
          title: title.trim(),
          description: desc.trim() || null,
          due_date: due || new Date().toISOString(),
          priority: prio,
          status: 'pendiente'
        }]);
        if (rr.error) throw rr.error;
        toast('Tarea agregada.', 'success');
        saveBtn.disabled = false;
        saveBtn.textContent = '+ Agregar tarea';
        openOwnerPanel(ownerId);
      } catch (err) {
        toast('Error: ' + err.message, 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = '+ Agregar tarea';
      }
    });
  }).catch(function (e) { toast('Error: ' + e.message, 'error'); closeDetailPanel(); });
}

/* ctypes */

window.BH_CRM = { init: init, refresh: loadLeads, close: closeDetailPanel, open: openDetailPanel, refreshOwners: loadOwners };
window.initCrm = init;
})();

/* -- Agenda de Visitas dentro del panel lateral -- */
function agendaSectionHtml(visits) {
  var rows = '';
  if (visits && visits.length) {
    rows = visits.map(function (v) {
      var dt = v.visit_date ? fmtDateTime(v.visit_date) : 'Sin fecha';
      var st = v.status || 'pendiente';
      var isPast = v.visit_date && new Date(v.visit_date) < new Date();
      var cls = st === 'confirmada' ? 'crm-visit--confirmed' : st === 'completada' ? 'crm-visit--done' : st === 'cancelada' ? 'crm-visit--cancelled' : (isPast ? 'crm-visit--overdue' : '');
      var actions = '';
      if (st === 'pendiente') actions += '<button class="crm-visit-btn" data-visit-action="confirm" data-visit-id="' + v.id + '" style="color:var(--success);"><i class="fas fa-check"></i></button>';
      if (st === 'pendiente' || st === 'confirmada') {
        actions += '<button class="crm-visit-btn" data-visit-action="reschedule" data-visit-id="' + v.id + '" style="color:var(--warning);"><i class="fas fa-clock"></i></button>';
        actions += '<button class="crm-visit-btn" data-visit-action="cancel" data-visit-id="' + v.id + '" style="color:var(--danger);"><i class="fas fa-times"></i></button>';
        actions += '<button class="crm-visit-btn" data-visit-action="complete" data-visit-id="' + v.id + '" style="color:var(--accent);"><i class="fas fa-check-double"></i></button>';
      }
      return '<div class="crm-visit-item ' + cls + '">' +
        '<div class="crm-visit-info">' +
          '<div class="crm-visit-date">' + dt + '</div>' +
          '<div class="crm-visit-status">' + (VISIT_STATUS_LABELS[st] || st) + '</div>' +
        '</div>' +
        '<div class="crm-visit-actions">' + actions + '</div>' +
      '</div>';
    }).join('');
  } else {
    rows = '<div class="crm-timeline-empty">Sin visitas agendadas.</div>';
  }
  return '<div class="crm-side-section"><h4 class="crm-side-section-title">Agenda</h4>' +
    '<div class="crm-side-fields"><div class="crm-visit-list">' + rows + '</div></div></div>';
}

var VISIT_STATUS_LABELS = { pendiente: 'Pendiente', confirmada: 'Confirmada', completada: 'Completada', cancelada: 'Cancelada' };

async function updateVisitStatus(visitId, newStatus, leadId, panel) {
  try {
    var patch = { status: newStatus };
    if (newStatus === 'completada') { patch.check_out = new Date().toISOString(); patch.confirmed_at = new Date().toISOString(); }
    if (newStatus === 'confirmada') patch.confirmed_at = new Date().toISOString();
    var r = await db().from('visits').update(patch).eq('id', visitId);
    if (r.error) throw new Error(r.error.message);
    if (newStatus === 'completada') { try { await db().from('leads').update({ stage: 'visita_realizada' }).eq('id', leadId); } catch (e) { console.warn('[crm] stage after visita:', e.message); } }
    toast('Visita ' + (VISIT_STATUS_LABELS[newStatus] || newStatus).toLowerCase() + '.', 'success');
    closeDetailPanel();
    openDetailPanel(leadId);
    await loadLeads();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function rescheduleVisit(visitId, leadId, panel) {
  var input = prompt('Nueva fecha y hora (YYYY-MM-DDTHH:mm):');
  if (!input) return;
  try {
    var r = await db().from('visits').update({ visit_date: new Date(input).toISOString(), status: 'pendiente' }).eq('id', visitId);
    if (r.error) throw new Error(r.error.message);
    toast('Visita reprogramada.', 'success');
    closeDetailPanel(); openDetailPanel(leadId);
    await loadLeads();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

function bindAgendaActions(panel, leadId) {
  panel.querySelectorAll('[data-visit-action]').forEach(function (b) {
    b.addEventListener('click', function () {
      var vid = this.dataset.visitId;
      var act = this.dataset.visitAction;
      if (act === 'confirm') updateVisitStatus(vid, 'confirmada', leadId, panel);
      else if (act === 'complete') updateVisitStatus(vid, 'completada', leadId, panel);
      else if (act === 'cancel') { if (confirm('Cancelar esta visita?')) updateVisitStatus(vid, 'cancelada', leadId, panel); }
      else if (act === 'reschedule') rescheduleVisit(vid, leadId, panel);
    });
  });
}

/* ============================================================
   LÍNEA DE TIEMPO UNIFICADA -- actividades + visitas + tareas
   "Lo que está pasando" en un solo feed cronológico.
   ============================================================ */
function buildUnifiedTimeline(activities, visits, tasks) {
  var items = [];
  (activities || []).forEach(function (a) {
    items.push({
      _ts: a.created_at, kind: 'activity',
      title: a.title || a.activity_type, text: a.description || '',
      dot: 'crm-dot--' + (a.activity_type === 'status_change' ? 'status' : (a.activity_type || 'note'))
    });
  });
  (visits || []).forEach(function (v) {
    items.push({
      _ts: v.visit_date, kind: 'visit',
      title: 'Visita ' + (v.status || 'pendiente'),
      text: v.client_name ? ('para ' + v.client_name) : '',
      dot: 'crm-dot--visit',
      isFuture: new Date(v.visit_date).getTime() > Date.now()
    });
  });
  (tasks || []).forEach(function (t) {
    var label = t.status === 'completada' ? 'Tarea completada' : (t.status === 'cancelada' ? 'Tarea cancelada' : 'Tarea ' + (t.status || 'pendiente'));
    items.push({
      _ts: t.created_at, kind: 'task',
      title: label + ': ' + (t.title || ''),
      text: t.description || '',
      dot: 'crm-dot--task'
    });
  });
  items.sort(function (a, b) { return new Date(b._ts) - new Date(a._ts); });
  if (!items.length) return '<div class="crm-timeline-empty">Sin actividad registrada.</div>';
  return items.map(function (it) {
    return '<div class="crm-interaction"><span class="crm-interaction-dot ' + it.dot + '"></span><div class="crm-interaction-body">' +
      '<strong>' + esc(it.title) + '</strong>' +
      (it.text ? '<div class="crm-interaction-text">' + esc(it.text) + '</div>' : '') +
      '<div class="crm-interaction-date">' + fmtDateTime(it._ts) + '</div></div></div>';
  }).join('');
}

/* sugerencia de next-action: si no hay nada pendiente, recomendar Followup */
function recommendedNextAction(lead, visits, tasks) {
  var hasPendingTask = (tasks || []).some(function (t) { return t.status === 'pendiente' || t.status === 'en_progreso'; });
  var hasFutureVisit = (visits || []).some(function (v) { return new Date(v.visit_date).getTime() > Date.now() && v.status !== 'cancelada'; });
  if (hasPendingTask) return null;
  if (hasFutureVisit) return null;
  if (!lead.last_contacted_at) return 'Sin contacto aún. Sugerencia: llamada o WhatsApp.';
  var days = Math.floor((Date.now() - new Date(lead.last_contacted_at).getTime()) / 86400000);
  if (days >= 7) return 'Sin contacto desde hace ' + days + ' días. Considerar followup.';
  return null;
}
