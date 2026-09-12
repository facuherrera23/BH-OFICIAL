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
var TIPO_CLIENTE_OPTS = ['propietario','comprador','inversor','inquilino'];
var OPERATION_OPTS = ['compra','venta','alquiler'];

var PAGE_SIZE = 25;
var _page = 1, _totalPages = 1, _totalRows = 0;
var _sortKey = 'created', _sortDir = 'desc';
var DEFAULT_SORT_DIR = { created: 'desc', cliente: 'asc', propiedad: 'asc', estado: 'asc', prioridad: 'desc', actividad: 'desc', prox: 'asc' };
var _ownerSortKey = 'prox', _ownerSortDir = 'asc';
var OWNER_DEFAULT_SORT_DIR = { propietario: 'asc', dni: 'asc', propiedades: 'desc', agente: 'asc', tareas: 'desc', exclusivo: 'asc', prox: 'asc' };
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
var _ownerSearch = '';
var _ownerFiltered = [];

function $id(id) { return document.getElementById(id); }
function esc(s) {
  if (window.BHUtils && typeof window.BHUtils.esc === 'function') return window.BHUtils.esc(s);
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function safeCssUrl(u) {
  if (window.BHUtils && typeof window.BHUtils.safeCssUrl === 'function') return window.BHUtils.safeCssUrl(u);
  return '';
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

/* -- Orden de la tabla de leads -- */
function nextActionEffectiveDate(l) {
  var rec = _nextActions[l.id];
  if (rec && rec.kind === 'task' && rec.due) return new Date(rec.due).getTime();
  if (l.next_followup_at) return new Date(l.next_followup_at).getTime();
  return null;
}
function sortValueFor(l, key) {
  if (key === 'cliente') return { v: (l.full_name || '').toLowerCase() };
  if (key === 'propiedad') {
    var p = l.props && l.props[0];
    return { v: p && (p.property_code || p.property_title) ? (p.property_code || p.property_title).toLowerCase() : null };
  }
  if (key === 'estado') {
    var idx = LEAD_STATUSES.indexOf(normalizeStage(l.stage || 'nuevo'));
    return { v: idx < 0 ? LEAD_STATUSES.length : idx };
  }
  if (key === 'prioridad') {
    return { v: ({ baja: 0, media: 1, alta: 2 }[getPriority(l.lead_score)] || 0) };
  }
  if (key === 'actividad') return { v: l.last_contacted_at ? new Date(l.last_contacted_at).getTime() : null };
  if (key === 'prox') return { v: nextActionEffectiveDate(l) };
  return { v: l.created_at ? new Date(l.created_at).getTime() : null };
}
function applySort() {
  var dir = _sortDir === 'asc' ? 1 : -1;
  var key = _sortKey;
  _leads.sort(function (a, b) {
    var sa = sortValueFor(a, key), sb = sortValueFor(b, key);
    if (sa.v == null && sb.v == null) return 0;
    if (sa.v == null) return 1;
    if (sb.v == null) return -1;
    var cmp;
    if (typeof sa.v === 'number') cmp = sa.v - sb.v;
    else cmp = sa.v < sb.v ? -1 : sa.v > sb.v ? 1 : 0;
    if (cmp === 0 && key === 'prioridad') {
      var na = a.lead_score || 0, nb = b.lead_score || 0;
      cmp = na - nb;
    }
    return cmp * dir;
  });
}

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
  var tp = $id('crmTipoOperacionFilter'); if (tp && tp.value) q = q.eq('operation_type', tp.value);
  var ag = $id('crmAgentFilter'); if (ag && ag.value) q = q.eq('assigned_to', ag.value);
  if (_hasFollowupFilter) q = q.not('next_followup_at', 'is', 'null');
  return q.is('deleted_at', null);
}


function ownerPendingTasks(o) {
  return (_ownerTasks[o.id] || []).filter(function (tk) { return tk.status !== 'completada' && tk.status !== 'cancelada'; });
}
function ownerNextTask(o) {
  var withDue = ownerPendingTasks(o).filter(function (tk) { return !!tk.due_date; });
  if (!withDue.length) return null;
  withDue.sort(function (a, b) { return new Date(a.due_date).getTime() - new Date(b.due_date).getTime(); });
  return withDue[0];
}
function fmtTaskTimeLeft(iso) {
  var diff = new Date(iso).getTime() - Date.now();
  var abs = Math.abs(diff);
  var days = Math.floor(abs / 86400000);
  var hours = Math.floor((abs % 86400000) / 3600000);
  var mins = Math.floor((abs % 3600000) / 60000);
  var human = days > 0 ? days + 'd ' + hours + 'h' : hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
  if (diff < 0) return { text: 'Vencida hace ' + human, overdue: true };
  if (diff < 24 * 3600000) return { text: 'Vence hoy · ' + human, soon: true };
  return { text: 'Vence en ' + human, soon: false };
}
function openOwnerTasksList(tasks) {
  return (tasks || []).filter(function (tk) { return tk.status !== 'completada' && tk.status !== 'cancelada'; });
}
function ownerAgentNames(o) {
  var ps = _ownerProps[o.id] || [];
  var agentIds = [];
  ps.forEach(function (p) { if (p.agent_id && agentIds.indexOf(p.agent_id) < 0) agentIds.push(p.agent_id); });
  return agentIds.map(function (aid) { return (_agentMapById[aid] || '').toLowerCase(); }).join(' ');
}
function ownerSortValueFor(o, key) {
  if (key === 'propietario') return { v: (o.full_name || '').toLowerCase() };
  if (key === 'dni') return { v: (o.dni_cuit || '').toLowerCase() };
  if (key === 'propiedades') return { v: (_ownerProps[o.id] || []).length };
  if (key === 'agente') return { v: ownerAgentNames(o) || null };
  if (key === 'tareas') return { v: ownerPendingTasks(o).length };
  if (key === 'exclusivo') return { v: o.exclusive_end ? new Date(o.exclusive_end).getTime() : null };
  if (key === 'prox') { var nt = ownerNextTask(o); return { v: nt ? new Date(nt.due_date).getTime() : null }; }
  return { v: o.created_at ? new Date(o.created_at).getTime() : null };
}
function applyOwnerSort() {
  var dir = _ownerSortDir === 'asc' ? 1 : -1;
  var key = _ownerSortKey;
  _owners.sort(function (a, b) {
    var sa = ownerSortValueFor(a, key), sb = ownerSortValueFor(b, key);
    if (sa.v == null && sb.v == null) return 0;
    if (sa.v == null) return 1;
    if (sb.v == null) return -1;
    var cmp;
    if (typeof sa.v === 'number') cmp = sa.v - sb.v;
    else cmp = sa.v < sb.v ? -1 : sa.v > sb.v ? 1 : 0;
    return cmp * dir;
  });
}

async function loadOwners() {
  var c = $id('crmLeadList');
  if (!c) return;
  c.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim);">Cargando propietarios...</div>';
  closeDetailPanel();
  try {
var r = await db().from('owners').select('id, full_name, email, phone, preferred_contact, exclusive, exclusive_start, exclusive_end, dni_cuit, address, notes, documents, commission_sale, commission_rent, commission_split, contract_notes, created_at').is('deleted_at', null);
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
    _ownerProps = {};
    if (ids.length) {
      var CH = 50, pJobs = [], tJobs = [], k;
      for (k = 0; k < ids.length; k += CH) {
        var chunk = ids.slice(k, k + CH);
        pJobs.push(db().from('properties').select('id, title, property_code, price_usd, status, owner_id, agent_id').in('owner_id', chunk).then(function (r) { return r.data || []; }, function () { return []; }));
        tJobs.push(db().from('owner_tasks').select('owner_id, id, type, description, status, priority, due_date').in('owner_id', chunk).then(function (r) { return r.data || []; }, function () { return []; }));
      }
      var pAll = await Promise.all(pJobs);
      var tAll = await Promise.all(tJobs);
      pAll.forEach(function (rows) {
        (rows || []).forEach(function (p) {
          if (!_ownerProps[p.owner_id]) _ownerProps[p.owner_id] = [];
          _ownerProps[p.owner_id].push(p);
        });
      });
      tAll.forEach(function (rows) {
        (rows || []).forEach(function (tk) {
          if (!_ownerTasks[tk.owner_id]) _ownerTasks[tk.owner_id] = [];
          _ownerTasks[tk.owner_id].push(tk);
        });
      });
    }
applyOwnerSort();
    renderOwnerList(c);
    updateOwnerKpis();
    var sub = $id('crmSubtitle');
    if (sub) sub.textContent = _totalRows + (_ownerSearch.trim() ? ' propietarios (filtro)' : ' propietarios');
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
function ownerSearchText(o) {
  var q = _ownerSearch.trim().toLowerCase();
  if (!q) return true;
  var hay = [o.full_name, o.dni_cuit, o.email, o.phone, o.address].join(' ').toLowerCase();
  var ps = _ownerProps[o.id] || [];
  ps.forEach(function (p) { hay += ' ' + (p.title || '') + ' ' + (p.property_code || ''); });
  hay += ' ' + ownerAgentNames(o);
  return hay.indexOf(q) !== -1;
}
function renderOwnerList(c) {
  _ownerFiltered = _owners.filter(ownerSearchText);
  if (!_ownerFiltered.length) {
    c.innerHTML = _owners.length
      ? '<div style="padding:40px;text-align:center;color:var(--text-dim);">Sin propietarios que coincidan con la búsqueda.</div>'
      : '<div style="padding:40px;text-align:center;color:var(--text-dim);">Sin propietarios cargados.</div>';
    return;
  }
  var sortArrow = function (k) {
    return _ownerSortKey === k ? '<span class="crm-sort-ind">' + (_ownerSortDir === 'asc' ? '\u25B2' : '\u25BC') + '</span>' : '';
  };
  _totalRows = _ownerFiltered.length;
  _totalPages = Math.max(1, Math.ceil(_ownerFiltered.length / PAGE_SIZE));
  var rows = '';
  var start = (_page - 1) * PAGE_SIZE;
  var end = Math.min(start + PAGE_SIZE, _ownerFiltered.length);
  for (var i = start; i < end; i++) {
    var o = _ownerFiltered[i];
    var inits = getInitials(o.full_name);
    var avColor = getAvatarColor(o.full_name);
    var tareas = ownerPendingTasks(o);
    var actionClass = tareas.length ? 'crm-activity-dot' : '';
    var contactMetrics = [];
    if (o.email) contactMetrics.push(o.email);
    if (o.phone) contactMetrics.push(o.phone);
    var tareaCell;
    if (tareas.length) {
      var vencidas = tareas.filter(function (tk) { return tk.due_date && new Date(tk.due_date).getTime() < Date.now(); }).length;
      var tip = tareas.map(function (tk) { return (tk.type || 'Tarea') + (tk.due_date ? ' - vence ' + fmtDate(tk.due_date) : ''); }).join(' | ');
      var cls = vencidas ? 'crm-priority crm-priority--alta' : 'crm-priority crm-priority--media';
      tareaCell = '<span class="' + cls + '" style="cursor:pointer;" title="' + esc(tip) + '" data-action="viewOwnerTasks" data-id="' + o.id + '">' + tareas.length + ' pendiente' + (tareas.length > 1 ? 's' : '') + (vencidas ? ' <span style="color:var(--danger);font-weight:800;">(' + vencidas + ' venc.)</span>' : '') + '</span>';
    } else {
      tareaCell = '<span class="crm-muted">—</span>';
    }
    var nextTask = ownerNextTask(o);
    var proxCell;
    if (nextTask) {
      var tl = fmtTaskTimeLeft(nextTask.due_date);
      var chipColor = tl.overdue ? 'var(--danger)' : (tl.soon ? 'var(--warning)' : 'var(--accent)');
      var desc = nextTask.description || nextTask.title || nextTask.type || 'Tarea';
      proxCell = '<div style="font-size:12px;color:var(--text-main);font-weight:500;">' + esc(desc.length > 42 ? desc.slice(0, 42) + '…' : desc) + '</div>' +
        '<div style="font-size:11px;font-weight:600;color:' + chipColor + ';margin-top:2px;"><i class="fas fa-clock" style="font-size:10px;margin-right:4px;"></i>' + tl.text + '</div>';
    } else {
      proxCell = '<span class="crm-muted">—</span>';
    }
    rows += '<tr class="crm-row" data-id="' + o.id + '" data-kind="owner">' +
      '<td><div class="crm-client-row"><span class="crm-client-avatar" style="background:' + avColor + '">' + inits + '</span><div><strong>' + esc(o.full_name) + '</strong>' + (o.exclusive ? '<span class="crm-tipo-chip crm-tipo-chip--estado">EXCLUSIVO</span>' : '') + '<div class="crm-meta">' + esc(contactMetrics.join(' · ')) + '</div></div></div></td>' +
      '<td>' + (o.dni_cuit ? '<code style="font-size:11px;color:var(--text-secondary);">' + esc(o.dni_cuit) + '</code>' : '<span class="crm-muted">—</span>') + '</td>' +
      '<td>' + renderOwnerPropsCell(o.id) + '</td>' +
      '<td>' + renderOwnerAgentCell(o.id) + '</td>' +
      '<td>' + tareaCell + '</td>' +
      '<td>' + (o.exclusive && o.exclusive_end ? fmtDate(o.exclusive_end) : '<span class="crm-muted">—</span>') + '</td>' +
      '<td>' + proxCell + '</td>' +
      '<td class="crm-td-actions">' +
        '<button class="btn-action" data-action="viewOwner" data-id="' + o.id + '" title="Ver detalle"><i class="fas fa-eye"></i></button>' +
        '<button class="btn-action crm-icon-action" data-action="addOwnerNote" data-id="' + o.id + '" title="Agregar nota"><i class="fas fa-sticky-note"></i></button>' +
        '<button class="btn-action crm-icon-action" data-action="genOwnerToken" data-id="' + o.id + '" title="Generar token portal"><i class="fas fa-key"></i></button>' +
        '<button class="btn-action" data-action="editOwner" data-id="' + o.id + '" title="Editar"><i class="fas fa-pen"></i></button>' +
        '<button class="btn-action danger" data-action="deleteOwner" data-id="' + o.id + '" title="Eliminar"><i class="fas fa-trash"></i></button>' +
      '</td>' +
    '</tr>';
  }
  c.innerHTML =
    '<div class="crm-table-wrap luxury-table-wrap"><table class="luxury-table crm-table">' +
      '<thead><tr>' +
        '<th class="crm-th-sort" data-sort="propietario">Propietario' + sortArrow('propietario') + '</th>' +
        '<th class="crm-th-sort" data-sort="dni">DNI/CUIT' + sortArrow('dni') + '</th>' +
        '<th class="crm-th-sort" data-sort="propiedades">Propiedades' + sortArrow('propiedades') + '</th>' +
        '<th class="crm-th-sort" data-sort="agente">Agente asignado' + sortArrow('agente') + '</th>' +
        '<th class="crm-th-sort" data-sort="tareas">Tareas pendientes' + sortArrow('tareas') + '</th>' +
        '<th class="crm-th-sort" data-sort="exclusivo">Exclusivo hasta' + sortArrow('exclusivo') + '</th>' +
        '<th class="crm-th-sort" data-sort="prox">Próx. tarea' + sortArrow('prox') + '</th><th></th>' +
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
  c.querySelectorAll('[data-action="genOwnerToken"]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (window.adminCrmToken && window.adminCrmToken.open) window.adminCrmToken.open(this.dataset.id);
    });
  });
  c.querySelectorAll('[data-action="editOwner"]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (window.adminApp && window.adminApp.editOwner) window.adminApp.editOwner(this.dataset.id);
    });
  });
  c.querySelectorAll('[data-action="deleteOwner"]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (window.adminApp && window.adminApp.deleteOwner) window.adminApp.deleteOwner(this.dataset.id);
    });
  });
  c.querySelectorAll('[data-action="viewOwnerTasks"]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      openOwnerPanel(this.dataset.id);
    });
  });
  c.querySelectorAll('th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = this.dataset.sort;
      if (_ownerSortKey === k) _ownerSortDir = _ownerSortDir === 'asc' ? 'desc' : 'asc';
      else { _ownerSortKey = k; _ownerSortDir = OWNER_DEFAULT_SORT_DIR[k] || 'asc'; }
      applyOwnerSort();
      renderOwnerList(c);
    });
  });
  c.querySelectorAll('[data-page]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      _page = parseInt(this.dataset.page, 10) || 1;
      renderOwnerList(c);
    });
  });
}

async function loadLeads() {
  var c = $id('crmLeadList');
  if (!c) return;
  c.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim);">Cargando prospectos...</div>';
  closeDetailPanel();
  try {
    var countRes = await applyBaseFilters(
      db().from('leads').select('id', { count: 'exact', head: true }));
    _totalRows = (countRes && countRes.count) || 0;

    var q = applyBaseFilters(db().from('leads').select('id, full_name, email, phone, whatsapp, stage, source, tipo_cliente, operation_type, lead_score, assigned_to, property_id, next_followup_at, last_contacted_at, created_at'));
    var r = await q;
    if (r.error) { throw new Error(r.error.message); }
    _leads = r.data || [];
    _totalPages = Math.max(1, Math.ceil(_leads.length / PAGE_SIZE));

/* Enriquecer: agente + propiedad (campo directo + join lead_properties) */
    _agents.forEach(function (a) { _agentMapById[a.id] = a.full_name; });
    var leadIds = _leads.map(function (x) { return x.id; });
    var propIds = {};
    _leads.forEach(function (l) { if (l.property_id) propIds[l.property_id] = true; });
    var linkByLead = {};
    if (leadIds.length) {
      try {
        var lpRes = await db().from('lead_properties').select('lead_id, property_id').in('lead_id', leadIds);
        (lpRes.data || []).forEach(function (lp) {
          if (!lp || !lp.property_id) return;
          if (!linkByLead[lp.lead_id]) linkByLead[lp.lead_id] = [];
          if (linkByLead[lp.lead_id].indexOf(lp.property_id) === -1) linkByLead[lp.lead_id].push(lp.property_id);
          propIds[lp.property_id] = true;
        });
      } catch (e) {}
    }
    var props = {};
    var ids = Object.keys(propIds);
    if (ids.length) {
      var pr = await db().from('properties').select('id, title, property_code, image_urls').in('id', ids);
      (pr.data || []).forEach(function (p) { props[p.id] = p; });
    }
    var visitsByLead = {}, tasksByLead = {};
    if (leadIds.length) {
      try {
        var vRes = await db().from('visits').select('lead_id, visit_date, status').in('lead_id', leadIds);
        (vRes.data || []).forEach(function (v) { if (!visitsByLead[v.lead_id]) visitsByLead[v.lead_id] = []; visitsByLead[v.lead_id].push(v); });
        var tRes = await db().from('lead_tasks').select('lead_id, status, due_at, title').in('lead_id', leadIds);
        (tRes.data || []).forEach(function (tk) { if (!tasksByLead[tk.lead_id]) tasksByLead[tk.lead_id] = []; tasksByLead[tk.lead_id].push(tk); });
      } catch (e) {}
    }
    _nextActions = {};
_leads.forEach(function (l) {
      l.agent_name = _agentMapById[l.assigned_to] || null;
      var pIds = [];
      if (l.property_id) pIds.push(l.property_id);
      (linkByLead[l.id] || []).forEach(function (pid) { if (pIds.indexOf(pid) === -1) pIds.push(pid); });
      l.props = pIds
        .filter(function (pid) { return props[pid]; })
        .map(function (pid) { return { property_id: pid, property_code: props[pid].property_code || null, property_title: props[pid].title, image: (props[pid].image_urls || [])[0] || null }; });
    });
    _nextActions = {};
    _leads.forEach(function (l) {
      _nextActions[l.id] = recommendedNextAction(l, visitsByLead[l.id] || [], tasksByLead[l.id] || []);
    });
    applySort();
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

function setKpiLabels(labels) {
  var els = document.querySelectorAll('.crm-kpis .crm-kpi-label');
  for (var i = 0; i < els.length && i < labels.length; i++) els[i].textContent = labels[i];
}

function updateOwnerKpis() {
  var total = _owners.length;
  var exclusivos = 0;
  var vencidas = 0;
  var props = 0;
  _owners.forEach(function (o) {
    if (o.exclusive) exclusivos++;
    props += (_ownerProps[o.id] || []).length;
    ownerPendingTasks(o).forEach(function (tk) {
      if (tk.due_date && new Date(tk.due_date).getTime() < Date.now()) vencidas++;
    });
  });
  setKpiLabels(['Propietarios', 'Exclusivos', 'Vencidas', 'Propiedades']);
  var el;
  el = $id('crmKpiTotal'); if (el) el.textContent = total;
  el = $id('crmKpiNuevo'); if (el) el.textContent = exclusivos;
  el = $id('crmKpiGanados'); if (el) el.textContent = vencidas;
  el = $id('crmKpiPerdidos'); if (el) el.textContent = props;
}

async function updateKpis() {
  try {
    setKpiLabels(['Total', 'Nuevos', 'Ganados', 'Perdidos']);
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
  var start = (_page - 1) * PAGE_SIZE;
  var end = Math.min(start + PAGE_SIZE, _leads.length);
  for (var i = start; i < end; i++) {
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
      var code = p.property_code || ('PROP-' + String(p.property_id).slice(0, 6)).toUpperCase();
      propCell = '<div class="crm-prop-row">' + thumb + '<div class="crm-prop-info"><span class="crm-prop-code crm-prop-code--sm" title="' + esc(p.property_title || 'Propiedad') + '">' + esc(code) + '</span><span class="crm-prop-name">' + esc(p.property_title || 'Propiedad') + '</span></div></div>';
    } else {
      propCell = '<span class="crm-prop-name crm-muted">Sin propiedad</span>';
    }
    var agentCell = l.agent_name
      ? '<div class="crm-agent-row"><span class="crm-agent-avatar">' + getInitials(l.agent_name) + '</span><span>' + esc(l.agent_name) + '</span></div>'
      : '<span class="crm-muted">&#8212;</span>';
    var actDot = hasRecentActivity(l.last_contacted_at) ? '<span class="crm-activity-dot"></span> ' : '';
    var actTxt = l.last_contacted_at ? fmtDate(l.last_contacted_at) : '&#8212;';
    var rec = _nextActions[l.id];
    var nextTxt;
    if (rec && rec.kind === 'task') {
      var taskDate = rec.due ? fmtDate(rec.due) : null;
      nextTxt = '<span class="crm-next-action' + (rec.due && isFollowupDue(rec.due) ? ' crm-next-action--due' : '') + '" title="' + esc(rec.label) + '">' + (taskDate || 'Tarea') + '</span>';
    } else if (l.next_followup_at) {
      nextTxt = '<span class="crm-next-action' + (isFollowupDue(l.next_followup_at) ? ' crm-next-action--due' : '') + '" title="' + (rec ? esc(rec.label) : 'Próx. acción programada') + '">' + fmtDate(l.next_followup_at) + '</span>';
    } else if (rec && rec.kind === 'recommend') {
      nextTxt = '<span class="crm-next-action crm-next-action--recommend" title="' + esc(rec.label) + '">Recomendar la próxima tarea</span>';
    } else if (rec && rec.kind === 'assign') {
      nextTxt = '<span class="crm-next-action crm-next-action--assign" title="Asignar una tarea pendiente a este lead">Asignar próxima tarea</span>';
    } else {
      nextTxt = '<span class="crm-muted">&#8212;</span>';
    }
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
  var sortArrow = function (k) {
    return _sortKey === k ? '<span class="crm-sort-ind">' + (_sortDir === 'asc' ? '\u25B2' : '\u25BC') + '</span>' : '';
  };
  c.innerHTML =
    '<div class="crm-table-wrap luxury-table-wrap"><table class="luxury-table crm-table">' +
      '<thead><tr>' +
        '<th class="crm-th-sort" data-sort="cliente">Cliente' + sortArrow('cliente') + '</th>' +
        '<th class="crm-th-sort" data-sort="propiedad">Propiedad' + sortArrow('propiedad') + '</th>' +
        '<th>Agente</th>' +
        '<th class="crm-th-sort" data-sort="estado">Estado' + sortArrow('estado') + '</th>' +
        '<th class="crm-th-sort" data-sort="prioridad">Prioridad' + sortArrow('prioridad') + '</th>' +
        '<th class="crm-th-sort" data-sort="actividad">Actividad' + sortArrow('actividad') + '</th>' +
        '<th class="crm-th-sort" data-sort="prox">Prox. Accion' + sortArrow('prox') + '</th>' +
        '<th class="crm-th-sort" data-sort="created">Creado' + sortArrow('created') + '</th><th></th>' +
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
  c.querySelectorAll('th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = this.dataset.sort;
      if (_sortKey === k) _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
      else { _sortKey = k; _sortDir = DEFAULT_SORT_DIR[k] || 'asc'; }
      _page = 1;
      loadLeads();
    });
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
      '<div class="crm-qa-row">' +
        '<div class="crm-qa-btn-wrap">' +
          '<button class="crm-qa-btn" id="crmQaTaskBtn" aria-label="Follow up"><i class="fas fa-clock"></i><span class="crm-qa-tip">Follow up</span></button>' +
          '<div class="crm-qa-submenu" id="crmQaTaskMenu">' +
            '<button class="crm-qa-menu-item" data-action="logCall"><i class="fas fa-phone"></i> Llamada</button>' +
            '<button class="crm-qa-menu-item" data-action="addNoteInline"><i class="fas fa-sticky-note"></i> Nota</button>' +
          '</div>' +
        '</div>' +
        '<button class="crm-qa-btn" data-action="scheduleVisit" aria-label="Agendar visita"><i class="fas fa-calendar-check"></i><span class="crm-qa-tip">Visita</span></button>' +
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
  bindQaMenu(panel);
  bindAgendaActions(panel, lead.id);
  bindTlTaskActions(panel, lead.id);
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
    
    '<div class="crm-side-section"><h4 class="crm-side-section-title">Historial</h4>' +
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
      b.className = 'crm-prop-result-btn';
      b.type = 'button';
      var imgUrl = (p.image_urls && p.image_urls[0]) ? safeCssUrl(p.image_urls[0]) : '';
      var thumb = imgUrl
        ? '<span class="crm-prop-result-thumb" style="background-image:url(' + imgUrl + ')"></span>'
        : '<span class="crm-prop-result-thumb"><i class="fas fa-home"></i></span>';
      b.innerHTML = thumb +
        '<span class="crm-prop-result-text">' +
          '<span class="crm-prop-result-code">' + esc(p.property_code || '—') + '</span>' +
          '<span class="crm-prop-result-title">' + esc(p.title || 'Propiedad') + '</span>' +
        '</span>';
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
      db().from('properties').select('id, title, property_code, image_urls').ilike('title', '%' + val.replace(/[%_]/g, ' ') + '%').limit(8)
        .then(function (r) { renderResults(r.data || []); })
        .catch(function () {});
    }, 300);
  });
  btn.addEventListener('click', async function () {
    var val = inp.value.trim();
    if (!val) { toast('Ingresa un titulo.', 'error'); return; }
    var r = await db().from('properties').select('id, title, property_code, image_urls').ilike('title', '%' + val.replace(/[%_]/g, ' ') + '%').limit(5);
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
    await db().from('lead_activities').insert([{ lead_id: leadId, activity_type: 'note', title: 'Propiedad vinculada' }]).then(function () {}, function () {});
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

/* -- Quick actions -- */
function bindQuickActions(lead, panel) {
  var p = panel.querySelector('#crmQuickActionPanel');
  if (!p) return;
  var defs = [
    { sel: '[data-action="logCall"]', label: 'Registrar llamada', type: 'call', hasDate: true, placeholder: 'Descripcion...', actTitle: 'Llamada telefonica' },
    { sel: '[data-action="addNoteInline"]', label: 'Agregar nota', type: 'note', hasDate: true, placeholder: 'Escribi una nota...', actTitle: 'Nota' },
    { sel: '[data-action="scheduleVisit"]', label: 'Agendar visita', type: 'visit', hasDate: true, placeholder: 'Notas para la visita...', actTitle: 'Visita agendada' },
    { sel: '[data-action="markLost"]', label: 'Marcar perdido', type: 'lost', hasDate: false, placeholder: 'Motivo del rechazo (opcional)...', actTitle: 'Perdido / Rechazado' }]

  defs.forEach(function (d) {
    var btn = panel.querySelector(d.sel);
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (d.type === 'task') {
        if (window.CrmTasks && window.CrmTasks.showTaskForm) window.CrmTasks.showTaskForm(lead.id, null, panel);
        return;
      }
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
          if (d.type === 'call' || d.type === 'note') {
            var tIns = await db().from('lead_tasks').insert([{
              lead_id: lead.id,
              title: d.actTitle,
              description: txt || null,
              priority: 'media',
              status: 'pendiente',
              due_at: new Date(dt).toISOString()
            }]);
            if (tIns.error) throw new Error(tIns.error.message);
            await db().from('leads').update({ last_contacted_at: new Date().toISOString(), next_followup_at: new Date(dt).toISOString() }).eq('id', lead.id);
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
            await db().from('leads').update({ last_contacted_at: new Date().toISOString(), next_followup_at: new Date(dt).toISOString() }).eq('id', lead.id);
          }
          toast(d.label + ' guardado.', 'success');
          p.innerHTML = '';
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
    _searchTimer = setTimeout(function () {
      _page = 1;
      if (_viewMode === 'owners') {
        _ownerSearch = search.value;
        var c = $id('crmLeadList');
        if (c) renderOwnerList(c);
      } else {
        loadLeads();
      }
    }, 350);
  });
  ['crmStatusFilter', 'crmOriginFilter', 'crmTipoOperacionFilter', 'crmAgentFilter'].forEach(function (id) {
    var el = $id(id);
    if (el) el.addEventListener('change', function () { _page = 1; loadLeads(); });
  });
  var orSel = $id('crmOriginFilter');
  if (orSel && !orSel.dataset.filled) {
    orSel.dataset.filled = '1';
    orSel.innerHTML = '<option value="">Todos los origenes</option>' +
      ORIGINS.map(function (o) { return '<option value="' + o + '">' + (ORIGIN_LABELS[o] || o) + '</option>'; }).join('');
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
    _ownerSearch = '';
    var sr = $id('crmSearch');
    if (sr) sr.value = '';
    _page = 1;
    _syncHeader();
    if (_viewMode === 'owners') loadOwners(); else loadLeads();
  });
  var ownerBtn = $id('btnNewOwnerCrm');
  if (ownerBtn && !ownerBtn.dataset.crmBound) {
    ownerBtn.dataset.crmBound = '1';
    ownerBtn.addEventListener('click', function () {
      var nb = document.getElementById('btnNewOwner');
      if (nb) nb.click();
      else {
        var chip = document.querySelector('.quick-action-chip[data-action="openOwnerModal"]');
        if (chip) chip.click();
      }
    });
  }
}
function _syncHeader() {
  var ownersMode = _viewMode === 'owners';
  var btn = $id('crmModeToggle');
  var newLead = $id('btnNewLead');
  var newOwnerCrm = $id('btnNewOwnerCrm');
  var titleEl = $id('crmTitle');
  var searchEl = $id('crmSearch');
  var leadOnly = ['crmStatusFilter', 'crmOriginFilter', 'crmTipoOperacionFilter', 'crmAgentFilter', 'crmFollowupWrap'];
  if (btn) {
    btn.innerHTML = ownersMode
      ? '<i class="fas fa-users"></i> Leads'
      : '<i class="fas fa-user-tie"></i> Propietarios';
  }
  if (newLead) newLead.style.display = ownersMode ? 'none' : '';
  if (newOwnerCrm) newOwnerCrm.style.display = ownersMode ? '' : 'none';
  var tokenCrm = $id('btnGenerateTokenCrm');
  if (tokenCrm) tokenCrm.style.display = ownersMode ? '' : 'none';
  if (searchEl) searchEl.placeholder = ownersMode ? 'Buscar propietario, CUIT o inmueble...' : 'Buscar nombre, email o teléfono...';
  leadOnly.forEach(function (id) {
    var el = $id(id);
    if (el) el.style.display = ownersMode ? 'none' : '';
  });
  if (titleEl) {
    titleEl.textContent = ownersMode ? 'Propietarios y Asignaciones' : 'Leads & CRM';
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
        '<div class="crm-side-section"><h4 class="crm-side-section-title">Tareas pendientes (' + openOwnerTasksList(tasks).length + ')</h4>' +
          '<div class="crm-side-fields">' +
            (openOwnerTasksList(tasks).length
              ? openOwnerTasksList(tasks).map(function (tk) {
                  return '<div class="crm-prop-item" style="flex-direction:column;align-items:flex-start;gap:4px;">' +
                    '<strong style="font-size:13px;color:#fff;">' + esc(tk.type || 'Tarea') + '</strong>' +
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
          type: title.trim(),
          description: desc.trim() || ' ',
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

/* --- Generación de token portal desde CRM (en modo propietarios) --- */
(function () {
  var modal = $id('ownerTokenModal');
  if (!modal) return;
  var _lastToken = null;
  var _lastOwnerId = null;
  var _lastDays = null;

  function open(ownerId) {
    populateTokenOwnerSelect(ownerId || null);
    var res = $id('tokenResult');
    if (res) res.style.display = 'none';
    var d = $id('tokenDays');
    if (d) d.value = '30';
    if (modal) { modal.classList.add('is-open'); document.body.style.overflow = 'hidden'; }
  }

  function close() { if (modal) { modal.classList.remove('is-open'); document.body.style.overflow = ''; } }

  async function populateTokenOwnerSelect(preId) {
    var sel = $id('tokenOwnerSelect');
    if (!sel) return;
    if (!_owners || !_owners.length) await loadOwners();
    sel.innerHTML = '<option value="">— Seleccionar propietario —</option>' +
      (_owners || []).map(function (o) {
        return '<option value="' + esc(String(o.id)) + '"' + (preId === o.id ? ' selected' : '') + '>' + esc(o.full_name) + (o.phone ? ' · ' + esc(o.phone) : '') + '</option>';
      }).join('');
  }

  function generate(days) {
    var rnd = crypto.getRandomValues(new Uint8Array(5));
    var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    var out = '';
    for (var i = 0; i < 5; i++) out += chars[rnd[i] % chars.length];
    return out;
  }

  async function onGenerate() {
    var sel = $id('tokenOwnerSelect');
    var d = $id('tokenDays');
    var ownerId = sel && sel.value;
    var days = parseInt(d && d.value, 10);
    if (!ownerId) { toast('Seleccioná un propietario', 'error'); return; }
    if (!days || days < 1) { toast('Ingresá una duración válida', 'error'); return; }

    var btn = $id('btnCreateToken');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generando...'; }
    try {
      var token = generate(days);
      var expiresAt = new Date(Date.now() + days * 86400000).toISOString();
      var sess = await db().auth.getSession();
      var uid = sess && sess.data && sess.data.session && sess.data.session.user ? sess.data.session.user.id : null;
      var res = await db().from('owner_portal_tokens').upsert([{
        owner_id: ownerId,
        token: token,
        scopes: ['read_properties', 'read_commissions', 'read_documents'],
        expires_at: expiresAt,
        created_by: uid
      }], { onConflict: 'owner_id' });
      if (res.error) throw res.error;

      _lastToken = token; _lastOwnerId = ownerId; _lastDays = days;
      var out = $id('tokenResult');
      var codeEl = $id('tokenResultCode');
      var linkEl = $id('tokenResultLink');
      var link = location.origin + '/portal-propietario.html?token=' + encodeURIComponent(token);
      if (codeEl) codeEl.textContent = token;
      if (linkEl) linkEl.textContent = link;
      if (out) out.style.display = 'block';
      toast('Token generado: ' + token, 'success');
    } catch (e) {
      toast('Error: ' + (e && e.message ? e.message : 'no se pudo generar'), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-key"></i> Generar & asignar'; }
    }
  }

  function bind() {
    var closeBtn = modal.querySelector('[data-action="closeTokenModal"]');
    if (closeBtn) closeBtn.addEventListener('click', close);
    var createBtn = $id('btnCreateToken');
    if (createBtn) createBtn.addEventListener('click', onGenerate);
    var ct = $id('btnCopyToken');
    if (ct) ct.addEventListener('click', function () {
      if (!_lastToken) return;
      navigator.clipboard.writeText(_lastToken).then(function(){ toast('Código copiado', 'success'); });
    });
    var cl = $id('btnCopyLink');
    if (cl) cl.addEventListener('click', function () {
      if (!_lastToken) return;
      var link = location.origin + '/portal-propietario.html?token=' + encodeURIComponent(_lastToken);
      navigator.clipboard.writeText(link).then(function(){ toast('Link copiado', 'success'); });
    });
    var headerBtn = $id('btnGenerateTokenCrm');
    if (headerBtn && !headerBtn.dataset.bound) {
      headerBtn.dataset.bound = '1';
      headerBtn.addEventListener('click', function () { open(null); });
    }
  }

  window.adminCrmToken = { open: open, close: close };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
window.initCrm = init;

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

var __qaMenuDocBound = false;

function bindQaMenu(panel) {
  var btn = panel.querySelector('#crmQaTaskBtn');
  var menu = panel.querySelector('#crmQaTaskMenu');
  if (!btn || !menu) return;
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  menu.querySelectorAll('.crm-qa-menu-item').forEach(function (item) {
    item.addEventListener('click', function () { menu.classList.remove('open'); });
  });
  if (!__qaMenuDocBound) {
    __qaMenuDocBound = true;
    document.addEventListener('click', function (e) {
      var open = document.querySelector('#crmQaTaskMenu');
      if (open && open.classList.contains('open') && !open.contains(e.target) && e.target.id !== 'crmQaTaskBtn') {
        open.classList.remove('open');
      }
    });
  }
}

/* -- Acciones de tareas dentro del timeline unificado -- */
async function doCompleteTlTask(item, leadId, panel) {
  var taskId = item.getAttribute('data-task-id');
  if (!taskId || !window.CrmTasks || !window.CrmTasks.completeTask) return;
  try {
    await window.CrmTasks.completeTask(taskId, item);
    item.classList.add('crm-tl-task--done');
    var chip = item.querySelector('.crm-tl-status');
    if (chip) { chip.textContent = 'Completada'; chip.classList.add('crm-tl-status--done'); }
    await loadLeads();
  } catch (e) { console.warn('[crm] complete task:', e.message); }
}

async function doDeleteTlTask(item, leadId, panel) {
  var taskId = item.getAttribute('data-task-id');
  if (!taskId || !window.CrmTasks || !window.CrmTasks.deleteTask) return;
  if (!confirm('Eliminar esta tarea?')) return;
  try {
    await window.CrmTasks.deleteTask(taskId, item);
    await loadLeads();
  } catch (e) { console.warn('[crm] delete task:', e.message); }
}

function bindTlTaskActions(panel, leadId) {
  panel.querySelectorAll('.crm-tl-task').forEach(function (item) {
    var cb = item.querySelector('.crm-task-checkbox');
    if (cb && !cb.dataset.crmTaskBound) {
      cb.dataset.crmTaskBound = '1';
      cb.addEventListener('change', function () { doCompleteTlTask(item, leadId, panel); });
    }
    var del = item.querySelector('.crm-tl-task-del');
    if (del && !del.dataset.crmTaskBound) {
      del.dataset.crmTaskBound = '1';
      del.addEventListener('click', function (e) { e.stopPropagation(); doDeleteTlTask(item, leadId, panel); });
    }
  });
}

/* ============================================================
   LÍNEA DE TIEMPO UNIFICADA -- actividades + visitas + tareas
   "Lo que está pasando" en un solo feed cronológico.
   ============================================================ */
function buildUnifiedTimeline(activities, visits, tasks) {
  var taskStatusLbl = (window.CrmTasks && window.CrmTasks.statusLabels) || { pendiente: 'Pendiente', en_progreso: 'En progreso', completada: 'Completada', cancelada: 'Cancelada' };
  var taskPrioLbl = (window.CrmTasks && window.CrmTasks.priorityLabels) || { baja: 'Baja', media: 'Media', alta: 'Alta', urgente: 'Urgente' };
  function prioClass(p) {
    var m = { baja: 'crm-task-priority--baja', media: 'crm-task-priority--media', alta: 'crm-task-priority--alta', urgente: 'crm-task-priority--urgente' };
    return m[p] || m.media;
  }
  var items = [];
  (activities || []).forEach(function (a) {
    /* las visitas ya se renderizan desde la tabla visits; la actividad 'visit' (Visita agendada) duplicaria cada visita */
    if (a.activity_type === 'visit') return;
    items.push({
      _ts: a.created_at,
      html: '<div class="crm-interaction">' +
        '<span class="crm-interaction-dot ' + (a.activity_type === 'status_change' ? 'crm-dot--status' : 'crm-dot--' + (a.activity_type || 'note')) + '"></span>' +
        '<div class="crm-interaction-body">' +
          '<strong>' + esc(a.title || a.activity_type || '') + '</strong>' +
          (a.description ? '<div class="crm-interaction-text">' + esc(a.description) + '</div>' : '') +
          '<div class="crm-interaction-date">' + fmtDateTime(a.created_at) + '</div>' +
        '</div></div>'
    });
  });
  (visits || []).forEach(function (v) {
    var st = v.status || 'pendiente';
    var dt = new Date(v.visit_date).getTime();
    var isPast = !isNaN(dt) && dt < Date.now();
    var vencida = isPast && (st === 'pendiente' || st === 'confirmada');
    var actions = '';
    if (st === 'pendiente') actions += '<button class="crm-visit-btn" data-visit-action="confirm" data-visit-id="' + v.id + '" style="color:var(--success);"><i class="fas fa-check"></i></button>';
    if (st === 'pendiente' || st === 'confirmada') {
      actions += '<button class="crm-visit-btn" data-visit-action="reschedule" data-visit-id="' + v.id + '" style="color:var(--warning);"><i class="fas fa-clock"></i></button>';
      actions += '<button class="crm-visit-btn" data-visit-action="cancel" data-visit-id="' + v.id + '" style="color:var(--danger);"><i class="fas fa-times"></i></button>';
      actions += '<button class="crm-visit-btn" data-visit-action="complete" data-visit-id="' + v.id + '" style="color:var(--accent);"><i class="fas fa-check-double"></i></button>';
    }
    items.push({
      _ts: v.visit_date,
      html: '<div class="crm-interaction crm-tl-visit">' +
        '<span class="crm-interaction-dot crm-dot--visit"></span>' +
        '<div class="crm-interaction-body">' +
          '<strong>Visita: ' + (VISIT_STATUS_LABELS[st] || st) + (vencida ? ' <span class="crm-tl-vencida">(vencida)</span>' : '') + '</strong>' +
          (v.notes ? '<div class="crm-interaction-text">' + esc(v.notes) + '</div>' : '') +
          '<div class="crm-interaction-date">' + fmtDateTime(v.visit_date) + '</div>' +
          (actions ? '<div class="crm-tl-inline-actions">' + actions + '</div>' : '') +
        '</div></div>'
    });
  });
  (tasks || []).forEach(function (t) {
    var isDone = t.status === 'completada' || t.status === 'cancelada';
    var checked = t.status === 'completada' ? ' checked' : '';
    var disabled = isDone ? ' disabled' : '';
    var dueStr = t.due_at ? fmtDateTime(t.due_at) : '';
    var overdue = t.due_at && !isDone && new Date(t.due_at).getTime() < Date.now();
    var stl = t.status === 'completada' ? 'Completada' : t.status === 'cancelada' ? 'Cancelada' : (taskStatusLbl[t.status] || t.status || 'Pendiente');
    items.push({
      _ts: t.created_at || t.due_at,
      html: '<div class="crm-interaction crm-tl-task' + (isDone ? ' crm-tl-task--done' : '') + '" data-task-id="' + t.id + '">' +
        '<span class="crm-interaction-dot crm-dot--task"></span>' +
        '<div class="crm-interaction-body">' +
          '<div class="crm-tl-task-head">' +
            '<strong>' + esc(t.title || 'Tarea') + '</strong>' +
            '<span class="crm-tl-task-actions">' +
              '<label class="crm-task-check" title="Completar tarea"><input type="checkbox" class="crm-task-checkbox"' + checked + disabled + '><span class="crm-task-check-visual"></span></label>' +
              '<button class="crm-tl-task-del" aria-label="Eliminar tarea"><i class="fas fa-trash"></i></button>' +
            '</span>' +
          '</div>' +
          (t.description ? '<div class="crm-interaction-text">' + esc(t.description) + '</div>' : '') +
          '<div class="crm-tl-task-meta">' +
            '<span class="crm-task-priority ' + prioClass(t.priority) + '">' + (taskPrioLbl[t.priority] || 'Media') + '</span>' +
            (dueStr ? '<span class="crm-task-due' + (overdue ? ' crm-task-due--overdue' : '') + '">' + dueStr + '</span>' : '') +
            '<span class="crm-tl-status' + (t.status === 'completada' ? ' crm-tl-status--done' : '') + '">' + stl + '</span>' +
          '</div>' +
          '<div class="crm-interaction-date">' + fmtDateTime(t.created_at) + '</div>' +
        '</div></div>'
    });
  });
  items.sort(function (a, b) { return new Date(b._ts) - new Date(a._ts); });
  if (!items.length) return '<div class="crm-timeline-empty">Sin actividad registrada.</div>';
  return items.map(function (it) { return it.html; }).join('');
}

/* próxima acción: prioriza la tarea pendiente más próxima; si no hay, recomendar Followup */
function recommendedNextAction(lead, visits, tasks) {
  var pending = (tasks || []).filter(function (t) { return t.status === 'pendiente' || t.status === 'en_progreso'; });
  if (pending.length) {
    pending.sort(function (a, b) {
      var da = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      var db = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      return da - db;
    });
    var t = pending[0];
    return { kind: 'task', due: t.due_at || null, label: (t.title || 'Tarea') + (t.due_at ? ' · ' + fmtDate(t.due_at) : '') };
  }
  if (!lead.last_contacted_at) return { kind: 'recommend', label: 'Sin contacto aún. Sugerencia: llamada o WhatsApp.' };
  var days = Math.floor((Date.now() - new Date(lead.last_contacted_at).getTime()) / 86400000);
  if (days >= 7) return { kind: 'recommend', label: 'Sin contacto desde hace ' + days + ' días. Considerar followup.' };
  return { kind: 'assign', label: 'Asignar próxima tarea' };
}
})();
