/**
 * admin-crm.js — CRM: gestión de leads (lista + panel lateral)
 * Dependencias: API (api.js), toast, confirmModal (admin.html)
 * Expone: window.initCrm
 */
(function () {

  const LEAD_STATUSES = [
    'nuevo','contactado','calificado','visita_agendada',
    'visita_realizada','negociacion','cerrado_ganado','cerrado_perdido','propietario'
  ];

  const STATUS_LABELS = {
    nuevo:'Nuevo', contactado:'Contactado', calificado:'Calificado',
    visita_agendada:'Visita Agendada', visita_realizada:'Visita Realizada',
    negociacion:'Negociación', cerrado_ganado:'Ganado', cerrado_perdido:'Perdido',
    propietario:'Propietario'
  };

  const ORIGINS = ['manual','contacto','tasacion','propiedad','whatsapp','referido','evento','web'];
  const TIPO_CLIENTE_OPTS = ['propietario','comprador','inversor'];

  const PRIORITY_LABELS = ['baja','media','alta'];

  let _leads = [];
  let _page = 1;
  let _totalPages = 1;
  let _agents = [];
  let _hasFollowupFilter = false;
  let _selectedLeadId = null;

  function $id(id) { return document.getElementById(id); }

  function esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('es-AR',{day:'2-digit',month:'short',year:'numeric'});
  }

  function fmtDateTime(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString('es-AR',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  }

  function fmtCurrency(n) {
    if (n == null || isNaN(n)) return '—';
    return 'USD ' + Number(n).toLocaleString('es-AR');
  }

  function fmtPercent(n) {
    if (n == null || isNaN(n)) return '—';
    return n + '%';
  }

  function isFollowupDue(d) {
    if (!d) return false;
    return new Date(d) <= new Date();
  }

  function getPriority(score) {
    if (score == null) return 'baja';
    if (score >= 70) return 'alta';
    if (score >= 40) return 'media';
    return 'baja';
  }

  function getPriorityLabel(p) {
    var m = {baja:'Baja',media:'Media',alta:'Alta'};
    return m[p]||'—';
  }

  async function init() {
    setupFilters();
    var nb = $id('newLeadBtn');
    if (nb) nb.addEventListener('click', showNewLeadModal);
    var rb = $id('refreshCrm');
    if (rb) rb.addEventListener('click', loadLeads);
    var s = $id('crmSearch');
    if (s) {
      var t;
      s.addEventListener('input', function () { clearTimeout(t); t = setTimeout(loadLeads,300); });
    }
    await loadAgents();
    await loadLeads();
  }

  function setupFilters() {
    var sf = $id('crmStatusFilter');
    if (sf) {
      sf.innerHTML = '<option value="">Todos los estados</option>' +
        LEAD_STATUSES.map(function (s) { return '<option value="' + s + '">' + esc(STATUS_LABELS[s]) + '</option>'; }).join('');
      sf.addEventListener('change', function () { _page = 1; loadLeads(); });
    }
    var of = $id('crmOriginFilter');
    if (of) {
      of.innerHTML = '<option value="">Todos los orígenes</option>' +
        ORIGINS.map(function (o) { return '<option value="' + o + '">' + o.charAt(0).toUpperCase() + o.slice(1) + '</option>'; }).join('');
      of.addEventListener('change', function () { _page = 1; loadLeads(); });
    }
    var tc = $id('crmTipoClienteFilter');
    if (tc) {
      tc.innerHTML = '<option value="">Todos los tipos</option>' +
        TIPO_CLIENTE_OPTS.map(function (t) { return '<option value="' + t + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>'; }).join('');
      tc.addEventListener('change', function () { _page = 1; loadLeads(); });
    }
    var af = $id('crmAgentFilter');
    if (af) af.addEventListener('change', function () { _page = 1; loadLeads(); });
    var fb = document.querySelector('.admin-filter-group');
    if (!fb) return;
    if ($id('crmFollowupFilter')) return;
    var lb = document.createElement('label');
    lb.className = 'acm-chip';
    lb.innerHTML = '<input type="checkbox" class="acm-chip-input" id="crmFollowupFilter"><span class="acm-chip-visual"><span class="acm-chip-box"><svg class="acm-chip-icon" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></span><span class="acm-chip-text">Solo con followup</span></span>';
    lb.querySelector('input').addEventListener('change', function (e) { _hasFollowupFilter = e.target.checked; _page = 1; loadLeads(); });
    fb.appendChild(lb);
  }

  async function loadAgents() {
    try {
      var d = await API.getCrmAgents();
      _agents = d.agents || [];
      var sel = $id('crmAgentFilter');
      if (!sel) return;
      sel.innerHTML = '<option value="">Todos los agentes</option>' +
        _agents.map(function (a) { return '<option value="' + a.id + '">' + esc(a.name) + '</option>'; }).join('');
    } catch (e) { console.warn('Error loading CRM agents:', e); }
  }

  async function loadLeads() {
    var c = $id('crmLeadList');
    if (!c) return;
    c.innerHTML = '<div class="loading-state">Cargando prospectos...</div>';
    closeDetailPanel();
    var p = { page: _page, per_page: 50 };
    var sv = $id('crmSearch');
    if (sv && (sv = sv.value.trim())) p.search = sv;
    var st = $id('crmStatusFilter');
    if (st && (st = st.value)) p.status = st;
    var or = $id('crmOriginFilter');
    if (or && (or = or.value)) p.origin = or;
    var tc = $id('crmTipoClienteFilter');
    if (tc && (tc = tc.value)) p.tipo_cliente = tc;
    var ag = $id('crmAgentFilter');
    if (ag && (ag = ag.value)) p.agent_id = ag;
    if (_hasFollowupFilter) p.has_followup = 'true';
    try {
      var d = await API.getLeads(p);
      _leads = d.leads || [];
      _totalPages = d.pages || 1;
      var sub = $id('crmSubtitle');
      if (sub) sub.textContent = d.total + ' prospectos';
      renderLeadList(c);
      updateCrmBadge(d.total);
      updateCrmKpis(_leads);
    } catch (e) { c.innerHTML = '<div class="loading-state">Error: ' + esc(e.message) + '</div>'; }
  }

  function getInitials(name) {
    if (!name) return '?';
    var parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length-1].charAt(0)).toUpperCase();
  }

  function getAvatarColor(name) {
    var colors = ['#20B8AB','#3b82f6','#8C64DC','#e67e22','#39D98A','#CC3535','#FFB432','#1abc9c','#9b59b6','#e74c3c'];
    var hash = 0;
    for (var i = 0; i < (name||'').length; i++) { hash = name.charCodeAt(i) + ((hash << 5) - hash); }
    return colors[Math.abs(hash) % colors.length];
  }

  function hasRecentActivity(lastContacted) {
    if (!lastContacted) return false;
    var days = (Date.now() - new Date(lastContacted).getTime()) / 86400000;
    return days < 7;
  }

  function renderLeadList(c) {
    if (!_leads.length) {
      c.innerHTML = '<div class="empty-state">No hay prospectos aún. Los contactos y solicitudes de tasación se convierten automáticamente.</div>';
      return;
    }
    var rows = '';
    for (var i = 0; i < _leads.length; i++) {
      var l = _leads[i];
      var inits = getInitials(l.name);
      var avColor = getAvatarColor(l.name);

      var sl = STATUS_LABELS[l.status] || l.status;
      var sb = '<span class="crm-status-badge crm-status-badge--' + l.status + '"><span class="crm-status-dot crm-status-dot--' + l.status + '"></span>' + sl + '</span>';

      var pr = getPriority(l.lead_score);
      var pc = pr === 'alta' ? 'priority--alta' : pr === 'media' ? 'priority--media' : 'priority--baja';
      var pb = '<span class="crm-priority ' + pc + '">' + getPriorityLabel(pr) + '</span>';

      var propThumb = '';
      var propName = '';
      if (l.properties && l.properties.length) {
        var p = l.properties[0];
        propName = esc(p.property_title || 'Prop #' + p.property_id);
        if (p.image) {
          propThumb = '<img class="crm-prop-thumb" src="' + esc(p.image) + '" alt="" loading="lazy">';
        } else {
          propThumb = '<span class="crm-prop-thumb crm-prop-thumb--empty">🏠</span>';
        }
      } else {
        propThumb = '<span class="crm-prop-thumb crm-prop-thumb--empty">—</span>';
        propName = '<span class="crm-prop-name-muted">Sin propiedad</span>';
      }

      var an = l.agent_name
        ? '<div class="crm-agent-row"><span class="crm-agent-avatar">' + getInitials(l.agent_name) + '</span><span class="crm-agent-name">' + esc(l.agent_name) + '</span></div>'
        : '<span class="crm-agent-name muted">—</span>';

      var recentDot = hasRecentActivity(l.last_contacted_at)
        ? '<span class="crm-activity-dot" title="Actividad reciente"></span>'
        : '';

      var la = l.last_contacted_at
        ? '<span class="crm-activity-date">' + fmtDate(l.last_contacted_at) + '</span>'
        : '<span class="crm-activity-date muted">—</span>';

      var na = l.next_followup_at
        ? '<span class="crm-next-action ' + (isFollowupDue(l.next_followup_at) ? 'next-action--due' : '') + '">' + fmtDate(l.next_followup_at) + '</span>'
        : '<span class="crm-next-action muted">—</span>';

      var cr = l.created_at ? fmtDate(l.created_at) : '—';

      rows += '<tr class="crm-row crm-row--status-' + l.status + (_selectedLeadId === l.id ? ' crm-row--selected' : '') + '" data-id="' + l.id + '">' +
        '<td class="crm-cell crm-cell--client">' +
          '<div class="crm-client-row">' +
            '<span class="crm-client-avatar" style="background:' + avColor + '">' + esc(inits) + '</span>' +
            '<div class="crm-client-info">' +
              '<strong>' + esc(l.name) + (l.tipo_cliente ? '<span class="crm-tipo-chip crm-tipo-chip--' + esc(l.tipo_cliente) + '">' + esc(l.tipo_cliente) + '</span>' : '') + '</strong>' +
              '<div class="crm-meta">' + esc(l.email||'') + (l.phone ? ' · ' + esc(l.phone) : '') + '</div>' +
            '</div>' +
          '</div>' +
        '</td>' +
        '<td class="crm-cell crm-cell--property">' +
          '<div class="crm-prop-row">' + propThumb + '<span class="crm-prop-name">' + propName + '</span></div>' +
        '</td>' +
        '<td class="crm-cell crm-cell--agent-c">' + an + '</td>' +
        '<td class="crm-cell crm-cell--status-c">' + sb + '</td>' +
        '<td class="crm-cell crm-cell--priority">' + pb + '</td>' +
        '<td class="crm-cell crm-cell--last-activity">' + recentDot + la + '</td>' +
        '<td class="crm-cell crm-cell--next-action">' + na + '</td>' +
        '<td class="crm-cell crm-cell--created">' + cr + '</td>' +
        '<td class="crm-cell crm-cell--actions-c">' +
        '<button class="btn btn-outline btn-xs crm-view-btn" data-action="viewLead" data-id="' + l.id + '">Ver detalle</button>' +
        '<button class="btn btn-ghost btn-xs crm-btn-danger" data-action="deleteLead" data-id="' + l.id + '" title="Eliminar">✕</button></td></tr>';
    }
    var pag = _totalPages > 1 ? buildPagination() : '';
    c.innerHTML = '<div class="crm-table-wrap"><table>' +
      '<thead><tr class="crm-header-row">' +
      '<th class="crm-col crm-col--client">Cliente</th>' +
      '<th class="crm-col crm-col--property">Propiedad</th>' +
      '<th class="crm-col crm-col--agent">Agente</th>' +
      '<th class="crm-col crm-col--status">Estado</th>' +
      '<th class="crm-col crm-col--priority">Prioridad</th>' +
      '<th class="crm-col crm-col--last-activity">Actividad</th>' +
      '<th class="crm-col crm-col--next-action">Próx. Acción</th>' +
      '<th class="crm-col crm-col--created">Creado</th>' +
      '<th class="crm-col crm-col--actions"></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' + pag;
    c.querySelectorAll('[data-action="viewLead"]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); openDetailPanel(+this.dataset.id); });
    });
    c.querySelectorAll('[data-action="deleteLead"]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); deleteLead(+this.dataset.id); });
    });
    c.querySelectorAll('[data-page]').forEach(function (b) {
      b.addEventListener('click', function () { _page = +this.dataset.page; loadLeads(); });
    });
    c.querySelectorAll('.crm-row').forEach(function (r) {
      r.addEventListener('click', function () { openDetailPanel(+this.dataset.id); });
    });
  }

  function buildPagination() {
    var h = '<div class="pagination">';
    if (_page > 1) h += '<button class="btn btn-ghost btn-xs" data-page="' + (_page-1) + '">‹ Anterior</button>';
    h += '<span class="pagination-info">Pág. ' + _page + ' de ' + _totalPages + '</span>';
    if (_page < _totalPages) h += '<button class="btn btn-ghost btn-xs" data-page="' + (_page+1) + '">Siguiente ›</button>';
    h += '</div>';
    return h;
  }

  /* ═══════════════════════════════════════════════════════════════
     SIDE PANEL
  ╔═══════════════════════════════════════════════════════════════════*/

  async function openDetailPanel(id) {
    _selectedLeadId = id;
    var panel = $id('crmSidePanel');
    if (!panel) return;

    var backdrop = $id('crmBackdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'crm-backdrop';
      backdrop.id = 'crmBackdrop';
      backdrop.addEventListener('click', closeDetailPanel);
      document.body.appendChild(backdrop);
    }
    backdrop.classList.add('open');

    var existing = panel.querySelector('.crm-side-body');
    if (existing) existing.innerHTML = '<div class="loading-state">Cargando...</div>';
    panel.classList.add('open');

    var lead, activities, properties;
    try {
      var results = await Promise.all([
        API.getLead(id),
        _req('GET','/api/crm/leads/'+id+'/activities').catch(function(){return [];}),
        _req('GET','/api/crm/leads/'+id+'/properties').catch(function(){return [];})
      ]);
      lead = results[0]; activities = results[1]; properties = results[2];
    } catch (e) {
      toast('Error al cargar prospecto: '+e.message,'error');
      return;
    }
    if (Array.isArray(lead.properties)) properties = lead.properties;

    if (!panel.querySelector('.crm-side-body')) {
      panel.innerHTML =
        '<div class="crm-side-header">' +
          '<div class="crm-side-header-info">' +
            '<span class="crm-status-dot crm-status-dot--' + lead.status + '"></span>' +
            '<h3 class="crm-side-title">' + esc(lead.name) + '</h3>' +
          '</div>' +
          '<button class="crm-side-close">✕</button>' +
        '</div>' +
        '<div class="crm-side-body"></div>';
      panel.querySelector('.crm-side-close').addEventListener('click', closeDetailPanel);
    } else {
      var hdr = panel.querySelector('.crm-side-header');
      hdr.innerHTML =
        '<div class="crm-side-header-info">' +
          '<span class="crm-status-dot crm-status-dot--' + lead.status + '"></span>' +
          '<h3 class="crm-side-title">' + esc(lead.name) + '</h3>' +
        '</div>' +
        '<button class="crm-side-close">✕</button>';
      panel.querySelector('.crm-side-close').addEventListener('click', closeDetailPanel);
    }

    renderSideBody(panel, lead, activities, properties);
    panel.dataset.leadId = lead.id;
  }

  function closeDetailPanel() {
    _selectedLeadId = null;
    var panel = $id('crmSidePanel');
    if (panel) {
      panel.classList.remove('open');
      var body = panel.querySelector('.crm-side-body');
      if (body) body.innerHTML = '';
      var hdr = panel.querySelector('.crm-side-header');
      if (hdr) hdr.innerHTML = '';
    }
    var backdrop = $id('crmBackdrop');
    if (backdrop) backdrop.classList.remove('open');
    var rows = document.querySelectorAll('.crm-row--selected');
    for (var i = 0; i < rows.length; i++) rows[i].classList.remove('crm-row--selected');
  }

  function renderSideBody(panel, lead, activities, properties) {
    var body = panel.querySelector('.crm-side-body');
    if (!body) return;

    var sopts = LEAD_STATUSES.map(function(s){return'<option value="'+s+'"'+(lead.status===s?' selected':'')+'>'+STATUS_LABELS[s]+'</option>';}).join('');
    var aopts = _agents.map(function(a){return'<option value="'+a.id+'"'+(lead.agent_id===a.id?' selected':'')+'>'+esc(a.name)+'</option>';}).join('');
    var oopts = ORIGINS.map(function(o){return'<option value="'+o+'"'+(lead.origin===o?' selected':'')+'>'+o.charAt(0).toUpperCase()+o.slice(1)+'</option>';}).join('');

    var tcOpts = TIPO_CLIENTE_OPTS.map(function(t){return'<option value="'+t+'"'+(lead.tipo_cliente===t?' selected':'')+'>'+t.charAt(0).toUpperCase()+t.slice(1)+'</option>';}).join('');

    var ph = !properties||!properties.length
      ? '<div class="crm-side-field-value">Sin propiedades vinculadas</div>'
      : properties.map(function(p){return'<div class="crm-prop-item">'+
        '<span>'+esc(p.property_title||'Propiedad #'+(p.property_id||p.id))+'</span>'+
        '<button class="btn btn-ghost btn-xs crm-btn-danger" data-action="removeProp" data-prop-id="'+(p.id||p.property_id)+'">✕</button></div>';}).join('');

    function sec(t){return'<div class="crm-side-section"><h4 class="crm-side-section-title">'+t+'</h4><div class="crm-side-fields">';}
    function es(){return'</div></div>';}
    function fl(lbl,id,type,val){
      var inp = type==='number'
        ? '<input class="field-input" id="'+id+'" type="number" value="'+(val!=null?val:'')+'">'
        : '<input class="field-input" id="'+id+'" type="'+type+'" value="'+esc(val||'')+'">';
      return '<div class="crm-side-field"><span class="crm-side-field-label">'+lbl+'</span>'+inp+'</div>';
    }

    body.innerHTML =
      sec('Información')+
        fl('Nombre','crmDtlName','text',lead.name)+
        fl('Email','crmDtlEmail','email',lead.email)+
        '<div class="crm-side-field-row">'+
        fl('Teléfono','crmDtlPhone','text',lead.phone)+
        fl('WhatsApp','crmDtlWhatsapp','text',lead.whatsapp)+'</div>'+
        '<div class="crm-side-field"><span class="crm-side-field-label">Contacto preferido</span>'+
        '<select class="field-input field-input--select" id="crmDtlPrefContact">'+
        '<option value="">—</option><option value="phone"'+(lead.preferred_contact_method==='phone'?' selected':'')+'>Teléfono</option>'+
        '<option value="whatsapp"'+(lead.preferred_contact_method==='whatsapp'?' selected':'')+'>WhatsApp</option>'+
        '<option value="email"'+(lead.preferred_contact_method==='email'?' selected':'')+'>Email</option></select></div>'+
        '<div class="crm-side-field-row">'+
        '<div class="crm-side-field"><span class="crm-side-field-label">Origen</span><select class="field-input field-input--select" id="crmDtlOrigin">'+oopts+'</select></div>'+
        '<div class="crm-side-field"><span class="crm-side-field-label">Tipo cliente</span><select class="field-input field-input--select" id="crmDtlTipoCliente"><option value="">—</option>'+tcOpts+'</select></div></div>'+
        '<div class="crm-side-field-row">'+
        '<div class="crm-side-field"><span class="crm-side-field-label">Agente</span><select class="field-input field-input--select" id="crmDtlAgent"><option value="">Sin agente</option>'+aopts+'</select></div>'+
        '<div class="crm-side-field"><span class="crm-side-field-label">Score</span><input class="field-input" id="crmDtlScore" type="number" value="'+(lead.lead_score!=null?lead.lead_score:'')+'"></div></div>'+
        '<div class="crm-side-field"><span class="crm-side-field-label">Estado</span><select class="field-input field-input--select" id="crmDtlStatus">'+sopts+'</select></div>'+
      es()+

      sec('Propiedades relacionadas')+
        '<div id="crmDtlPropsWrap">'+ph+
        '<div class="crm-prop-add">'+
        '<input class="field-input" id="crmDtlPropSearch" placeholder="Buscar propiedad...">'+
        '<button class="btn btn-ghost btn-sm" id="crmDtlAddProp">+</button></div></div>'+
      es()+

      sec('Presupuesto')+
        '<div class="crm-side-field-row">'+
        fl('Mín (USD)','crmDtlBudgetMin','number',lead.budget_min)+
        fl('Máx (USD)','crmDtlBudgetMax','number',lead.budget_max)+'</div>'+
        fl('Valor estimado (USD)','crmDtlEstValue','number',lead.estimated_value)+
      es()+

      sec('Tracking')+
        fl('UTM Source','crmDtlUtmSource','text',lead.utm_source)+
        fl('UTM Campaign','crmDtlUtmCampaign','text',lead.utm_campaign)+
      es()+

      sec('Actividad reciente')+
        '<div class="crm-timeline">'+buildTimelineHTML(activities)+'</div>'+
      es()+

      sec('Notas')+
        '<textarea class="field-input" id="crmDtlNotes" rows="3">'+esc(lead.notes||'')+'</textarea>'+
      es()+

      sec('Tareas')+
        '<div id="crmTasksPanel"><div class="loading-state">Cargando tareas...</div></div>'+
        '<button class="btn btn-ghost btn-xs crm-new-task-btn" id="crmNewTaskBtn">+ Nueva tarea</button>'+
      es()+

      sec('Acciones rápidas')+
        '<div class="crm-quick-actions">'+
        '<button class="btn btn-ghost btn-sm" data-action="logCall">📞 Llamada</button>'+
        '<button class="btn btn-ghost btn-sm" data-action="addNoteInline">📝 Nota</button>'+
        '<button class="btn btn-ghost btn-sm" data-action="scheduleVisit">📅 Visita</button>'+
        '<button class="btn btn-ghost btn-sm" data-action="scheduleFollowup">⏰ Followup</button></div>'+
        '<div id="crmQuickActionPanel"></div>'+
      es();

    bindQuickActions(body, lead);
    bindPropertyHandlers(body, lead);
    CrmTasks.loadLeadTasks(lead.id, body);
    body.querySelector('#crmNewTaskBtn')?.addEventListener('click', function(){CrmTasks.showTaskForm(lead.id, null, body);});
    bindSideSave(lead.id, body);
  }

  function buildTimelineHTML(acts) {
    if (!acts||!acts.length) return '<div class="crm-timeline-empty">Sin actividad registrada.</div>';
    var dots = {call:'call',note:'note',email:'email',visit:'visit',followup:'followup',status_change:'status_change'};
    return acts.map(function(a){
      var dc = dots[a.activity_type]||'note';
      return '<div class="crm-interaction"><span class="crm-interaction-dot crm-interaction-dot--'+dc+'"></span><div class="crm-interaction-body">'+
        '<strong>'+esc(a.title||a.activity_type||'')+'</strong>'+
        '<div class="crm-interaction-text">'+esc(a.description||'')+'</div>'+
        '<div class="crm-interaction-date">'+fmtDateTime(a.created_at)+(a.created_by?' · '+esc(a.created_by):'')+'</div></div></div>';
    }).join('');
  }

  function bindSideSave(leadId, body) {
    var btn = document.createElement('div');
    btn.className = 'crm-side-save';
    btn.innerHTML = '<button class="btn btn-primary btn-full" id="crmSideSaveBtn">Guardar cambios</button>';
    body.appendChild(btn);
    body.querySelector('#crmSideSaveBtn')?.addEventListener('click', async function(){
      var d = collectSideFormData(body);
      if (!d.name) { toast('El nombre es obligatorio.','error'); return; }
      try {
        await API.updateLead(leadId, d);
        toast('Prospecto actualizado.','success');
        await loadLeads();
        _selectedLeadId = leadId;
      } catch(e) { toast('Error: '+e.message,'error'); }
    });
  }

  function collectSideFormData(body) {
    function v(id) { var el = body.querySelector('#'+id); return el ? el.value.trim()||null : null; }
    function n(id) { var val = v(id); return val&&val!==''&&!isNaN(val) ? parseFloat(val) : null; }
    return {
      name: v('crmDtlName'),
      email: v('crmDtlEmail'),
      phone: v('crmDtlPhone'),
      whatsapp: v('crmDtlWhatsapp'),
      preferred_contact_method: v('crmDtlPrefContact'),
      status: v('crmDtlStatus'),
      origin: v('crmDtlOrigin'),
      tipo_cliente: v('crmDtlTipoCliente'),
      agent_id: v('crmDtlAgent') ? parseInt(v('crmDtlAgent')) : null,
      budget_min: n('crmDtlBudgetMin'),
      budget_max: n('crmDtlBudgetMax'),
      estimated_value: n('crmDtlEstValue'),
      lead_score: v('crmDtlScore') ? parseInt(v('crmDtlScore')) : null,
      utm_source: v('crmDtlUtmSource'),
      utm_campaign: v('crmDtlUtmCampaign'),
      notes: v('crmDtlNotes')
    };
  }

  /* ── Quick actions ──────────────────────────────────────────── */
  function bindQuickActions(body, lead) {
    var p = body.querySelector('#crmQuickActionPanel');
    if (!p) return;

    var actions = [
      {sel:'[data-action="logCall"]', build:function(){
        p.innerHTML = '<div class="crm-quick-panel">'+
          '<span class="crm-quick-panel-label">Registrar llamada</span>'+
          '<input class="field-input" id="crmQaCallDesc" placeholder="Descripción...">'+
          '<div class="crm-quick-panel-actions">'+
          '<button class="btn btn-primary btn-sm" id="crmQaCallSave">Guardar</button>'+
          '<button class="btn btn-ghost btn-sm" id="crmQaCallCancel">Cancelar</button></div></div>';
        body.querySelector('#crmQaCallSave')?.addEventListener('click',async function(){
          var d = body.querySelector('#crmQaCallDesc').value;
          if (!d||!d.trim()) { toast('Ingresá una descripción.','warn'); return; }
          try {
            await _req('POST','/api/crm/leads/'+lead.id+'/activities',{activity_type:'call',description:d.trim(),title:'Llamada telefónica'});
            toast('Llamada registrada.','success'); p.innerHTML='';
            var acts = await _req('GET','/api/crm/leads/'+lead.id+'/activities').catch(function(){return[];});
            var tl = body.querySelector('.crm-timeline'); if (tl) tl.innerHTML = buildTimelineHTML(acts);
          } catch(e) { toast('Error: '+e.message,'error'); }
        });
        body.querySelector('#crmQaCallCancel')?.addEventListener('click',function(){p.innerHTML='';});
      }},
      {sel:'[data-action="addNoteInline"]', build:function(){
        p.innerHTML = '<div class="crm-quick-panel">'+
          '<span class="crm-quick-panel-label">Agregar nota</span>'+
          '<textarea class="field-input" id="crmQaNoteText" rows="2" placeholder="Escribí una nota..."></textarea>'+
          '<div class="crm-quick-panel-actions">'+
          '<button class="btn btn-primary btn-sm" id="crmQaNoteSave">Guardar</button>'+
          '<button class="btn btn-ghost btn-sm" id="crmQaNoteCancel">Cancelar</button></div></div>';
        body.querySelector('#crmQaNoteSave')?.addEventListener('click',async function(){
          var t = body.querySelector('#crmQaNoteText').value;
          if (!t||!t.trim()) { toast('Escribí una nota.','warn'); return; }
          try {
            await API.addLeadNote(lead.id,{note:t.trim()});
            toast('Nota agregada.','success'); p.innerHTML='';
            var acts = await _req('GET','/api/crm/leads/'+lead.id+'/activities').catch(function(){return[];});
            var tl = body.querySelector('.crm-timeline'); if (tl) tl.innerHTML = buildTimelineHTML(acts);
          } catch(e) { toast('Error: '+e.message,'error'); }
        });
        body.querySelector('#crmQaNoteCancel')?.addEventListener('click',function(){p.innerHTML='';});
      }},
      {sel:'[data-action="scheduleVisit"]', build:function(){
        p.innerHTML = '<div class="crm-quick-panel">'+
          '<span class="crm-quick-panel-label">Agendar visita</span>'+
          '<input class="field-input" id="crmQaVisitDate" type="datetime-local">'+
          '<input class="field-input" id="crmQaVisitAddress" placeholder="Dirección...">'+
          '<textarea class="field-input" id="crmQaVisitNotes" rows="2" placeholder="Notas..."></textarea>'+
          '<div class="crm-quick-panel-actions">'+
          '<button class="btn btn-primary btn-sm" id="crmQaVisitSave">Guardar</button>'+
          '<button class="btn btn-ghost btn-sm" id="crmQaVisitCancel">Cancelar</button></div></div>';
        body.querySelector('#crmQaVisitSave')?.addEventListener('click',async function(){
          var dt = body.querySelector('#crmQaVisitDate').value;
          if (!dt) { toast('Seleccioná fecha y hora.','warn'); return; }
          try {
            await _req('POST','/api/crm/leads/'+lead.id+'/visits',{
              scheduled_at:dt,address:body.querySelector('#crmQaVisitAddress').value.trim()||'',
              notes:body.querySelector('#crmQaVisitNotes').value.trim()||''
            });
            toast('Visita agendada.','success'); p.innerHTML='';
          } catch(e) { toast('Error: '+e.message,'error'); }
        });
        body.querySelector('#crmQaVisitCancel')?.addEventListener('click',function(){p.innerHTML='';});
      }},
      {sel:'[data-action="scheduleFollowup"]', build:function(){
        p.innerHTML = '<div class="crm-quick-panel">'+
          '<span class="crm-quick-panel-label">Programar followup</span>'+
          '<input class="field-input" id="crmQaFupDate" type="datetime-local">'+
          '<textarea class="field-input" id="crmQaFupText" rows="2" placeholder="Notas..."></textarea>'+
          '<div class="crm-quick-panel-actions">'+
          '<button class="btn btn-primary btn-sm" id="crmQaFupSave">Guardar</button>'+
          '<button class="btn btn-ghost btn-sm" id="crmQaFupCancel">Cancelar</button></div></div>';
        body.querySelector('#crmQaFupSave')?.addEventListener('click',async function(){
          var dt = body.querySelector('#crmQaFupDate').value;
          if (!dt) { toast('Seleccioná fecha y hora.','warn'); return; }
          try {
            await API.updateLead(lead.id,{next_followup_at:dt});
            await _req('POST','/api/crm/leads/'+lead.id+'/activities',{
              activity_type:'followup',title:'Followup programado',
              description:body.querySelector('#crmQaFupText').value.trim()||''
            });
            toast('Followup programado.','success'); p.innerHTML='';
          } catch(e) { toast('Error: '+e.message,'error'); }
        });
        body.querySelector('#crmQaFupCancel')?.addEventListener('click',function(){p.innerHTML='';});
      }}
    ];

    for (var i = 0; i < actions.length; i++) {
      var btn = body.querySelector(actions[i].sel);
      if (btn) btn.addEventListener('click', actions[i].build);
    }
  }

  function renderPropsWrap(container, props, lead, body) {
    var ph = !props||!props.length
      ? '<div class="crm-side-field-value">Sin propiedades vinculadas</div>'
      : props.map(function(p){return'<div class="crm-prop-item">'+
        '<span>'+esc(p.property_title||'Propiedad #'+(p.property_id||p.id))+'</span>'+
        '<button class="btn btn-ghost btn-xs crm-btn-danger" data-action="removeProp" data-prop-id="'+(p.id||p.property_id)+'">✕</button></div>';}).join('');
    container.innerHTML = ph + '<div class="crm-prop-add">'+
      '<input class="field-input" id="crmDtlPropSearch" placeholder="Buscar propiedad...">'+
      '<button class="btn btn-ghost btn-sm" id="crmDtlAddProp">+</button></div>';
    bindPropertyHandlers(body, lead);
  }

  function linkProperty(leadId, propertyId, body) {
    _req('POST','/api/crm/leads/'+leadId+'/properties',{property_id:propertyId}).then(function(){
      toast('Propiedad agregada.','success');
      var inp = body.querySelector('#crmDtlPropSearch');
      if (inp) inp.value = '';
      var dd = body.querySelector('.crm-prop-results');
      if (dd) dd.remove();
      _req('GET','/api/crm/leads/'+leadId+'/properties').then(function(props){
        var wrap = body.querySelector('#crmDtlPropsWrap');
        if (wrap) renderPropsWrap(wrap, props||[], {id:leadId}, body);
      }).catch(function(){});
    }).catch(function(e){ toast('Error: '+e.message,'error'); });
  }

  function showPropResults(body, results, leadId) {
    var existing = body.querySelector('.crm-prop-results');
    if (existing) existing.remove();
    var inp = body.querySelector('#crmDtlPropSearch');
    if (!inp) return;
    if (!results||!results.length) return;
    var wrap = document.createElement('div'); wrap.className = 'crm-prop-results';
    results.forEach(function(p){
      var btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-xs crm-prop-result-btn';
      btn.textContent = esc(p.title||'Propiedad #'+p.id)+' — '+fmtCurrency(p.price);
      btn.addEventListener('click',function(e){
        e.stopPropagation();
        linkProperty(leadId, p.id, body);
      });
      wrap.appendChild(btn);
    });
    inp.parentNode.appendChild(wrap);
  }

  function bindPropertyHandlers(body, lead) {
    body.querySelectorAll('[data-action="removeProp"]').forEach(function(b){
      b.addEventListener('click',async function(e){
        e.stopPropagation();
        try {
          await _req('DELETE','/api/crm/leads/'+lead.id+'/properties/'+this.dataset.propId);
          var it = this.closest('.crm-prop-item'); if (it) it.remove();
          toast('Propiedad removida.','success');
        } catch(e) { toast('Error: '+e.message,'error'); }
      });
    });

    var inp = body.querySelector('#crmDtlPropSearch');
    var btn = body.querySelector('#crmDtlAddProp');

    if (inp) {
      var _srchTimer;
      inp.addEventListener('input', function(){
        var val = this.value.trim();
        var dd = body.querySelector('.crm-prop-results');
        if (!val || val.length < 2) {
          if (val.length < 2 && dd) dd.remove();
          return;
        }
        var pid = parseInt(val);
        if (!isNaN(pid)) {
          if (dd) dd.remove();
          return;
        }
        clearTimeout(_srchTimer);
        _srchTimer = setTimeout(function(){
          API.getProperties({search:val,per_page:8}).then(function(res){
            if (res && res.properties) showPropResults(body, res.properties, lead.id);
          }).catch(function(){});
        }, 300);
      });
    }

    if (btn) {
      btn.addEventListener('click',function(){
        if (!inp) return;
        var val = inp.value.trim();
        if (!val) { toast('Ingresá un ID o nombre de propiedad.','warn'); return; }
        var pid = parseInt(val);
        if (!isNaN(pid)) {
          linkProperty(lead.id, pid, body);
        } else {
          API.getProperties({search:val,per_page:5}).then(function(res){
            if (!res||!res.properties||!res.properties.length) { toast('No se encontraron propiedades.','warn'); return; }
            showPropResults(body, res.properties, lead.id);
          }).catch(function(e){ toast('Error al buscar: '+e.message,'error'); });
        }
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     NEW LEAD MODAL (sin cambios)
  ╔═══════════════════════════════════════════════════════════════════*/

  function showNewLeadModal() {
    var aopts = _agents.map(function(a){return'<option value="'+a.id+'">'+esc(a.name)+'</option>';}).join('');
    var sopts = LEAD_STATUSES.map(function(s){return'<option value="'+s+'"'+(s==='nuevo'?' selected':'')+'>'+STATUS_LABELS[s]+'</option>';}).join('');
    var oopts = ORIGINS.map(function(o){return'<option value="'+o+'"'+(o==='manual'?' selected':'')+'>'+o.charAt(0).toUpperCase()+o.slice(1)+'</option>';}).join('');
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = '<div class="modal crm-new-modal">'+
      '<div class="modal-header"><h3>+ Nuevo prospecto</h3><button class="modal-close">✕</button></div>'+
      '<div class="modal-body"><div class="crm-form">'+
      '<div class="crm-form-row"><label>Nombre *</label><input class="field-input" id="crmNewName" required></div>'+
      '<div class="crm-form-row"><label>Email</label><input class="field-input" id="crmNewEmail" type="email"></div>'+
      '<div class="crm-form-row"><label>Teléfono</label><input class="field-input" id="crmNewPhone"></div>'+
      '<div class="crm-form-row"><label>WhatsApp</label><input class="field-input" id="crmNewWhatsapp"></div>'+
      '<div class="crm-form-row"><label>Contacto preferido</label>'+
      '<select class="field-input field-input--select" id="crmNewPrefContact">'+
      '<option value="">—</option><option value="phone">Teléfono</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option></select></div>'+
      '<div class="crm-form-inline"><div><label>Estado</label><select class="field-input field-input--select" id="crmNewStatus">'+sopts+'</select></div>'+
      '<div><label>Agente</label><select class="field-input field-input--select" id="crmNewAgent"><option value="">Sin agente</option>'+aopts+'</select></div></div>'+
      '<div class="crm-form-inline"><div><label>Origen</label><select class="field-input field-input--select" id="crmNewOrigin">'+oopts+'</select></div>'+
      '<div><label>Valor estimado (USD)</label><input class="field-input" id="crmNewEstValue" type="number"></div></div>'+
      '<div class="crm-form-row"><label>Notas</label><textarea class="field-input" id="crmNewNotes" rows="3"></textarea></div></div></div>'+
      '<div class="modal-footer"><button class="btn btn-secondary modal-cancel">Cancelar</button><button class="btn btn-primary modal-save">Crear prospecto</button></div></div>';
    document.body.appendChild(backdrop);
    var close=function(){backdrop.remove();};
    backdrop.querySelector('.modal-close')?.addEventListener('click',close);
    backdrop.querySelector('.modal-cancel')?.addEventListener('click',close);
    backdrop.addEventListener('click',function(e){if(e.target===backdrop)close();});
    backdrop.querySelector('.modal-save')?.addEventListener('click',async function(){
      function g(id){var el=$id(id);return el?el.value:null;}
      var data = {
        name: g('crmNewName')?.trim(),
        email: g('crmNewEmail')?.trim()||null,
        phone: g('crmNewPhone')?.trim()||null,
        whatsapp: g('crmNewWhatsapp')?.trim()||null,
        preferred_contact_method: g('crmNewPrefContact')||null,
        status: g('crmNewStatus')||'nuevo',
        agent_id: g('crmNewAgent')?parseInt(g('crmNewAgent')):null,
        origin: g('crmNewOrigin')||'manual',
        estimated_value: g('crmNewEstValue')?parseFloat(g('crmNewEstValue')):null,
        notes: g('crmNewNotes')?.trim()||null
      };
      if (!data.name) { toast('El nombre es obligatorio.','error'); return; }
      try { await API.createLead(data); toast('Prospecto creado.','success'); close(); await loadLeads(); }
      catch(e) { toast('Error: '+e.message,'error'); }
    });
  }

  async function deleteLead(id) {
    if (!(await confirmModal('¿Eliminar este prospecto? Se perderán todos los datos asociados.'))) return;
    try { await API.deleteLead(id); toast('Prospecto eliminado.','success'); closeDetailPanel(); await loadLeads(); }
    catch(e) { toast('Error: '+e.message,'error'); }
  }

  function updateCrmKpis(leads) {
    var total = leads.length;
    var nuevo = 0, ganados = 0, perdidos = 0, pendientes = 0;
    for (var i = 0; i < total; i++) {
      var s = leads[i].status;
      if (s === 'nuevo') nuevo++;
      else if (s === 'cerrado_ganado') ganados++;
      else if (s === 'cerrado_perdido') perdidos++;
      else pendientes++;
    }
    var el = $id('crmKpiTotal'); if (el) el.textContent = total;
    el = $id('crmKpiNuevo'); if (el) el.textContent = nuevo;
    el = $id('crmKpiGanados'); if (el) el.textContent = ganados;
    el = $id('crmKpiPerdidos'); if (el) el.textContent = perdidos;
  }

  function updateCrmBadge(count) {
    var b = $id('sidebarCrmCount');
    if (b) { b.textContent = count||''; b.style.display = count ? '' : 'none'; }
  }

  window._crmAgents = _agents;
  window.initCrm = init;
})();
