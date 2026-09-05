/**
 * admin-crm-tasks.js — Task management for CRM leads
 * Expone: window.CrmTasks
 */
(function () {

  var TASK_PRIORITIES = ['baja','media','alta','urgente'];
  var TASK_PRIORITY_LABELS = {baja:'Baja',media:'Media',alta:'Alta',urgente:'Urgente'};
  var TASK_STATUS_LABELS = {pendiente:'Pendiente',en_progreso:'En progreso',completada:'Completada',cancelada:'Cancelada'};

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

  function isFollowupDue(d) {
    if (!d) return false;
    return new Date(d) <= new Date();
  }

  function taskPriorityClass(p) {
    var m = {baja:'task-priority--baja',media:'task-priority--media',alta:'task-priority--alta',urgente:'task-priority--urgente'};
    return m[p]||'task-priority--media';
  }

  function taskStatusClass(s) {
    var m = {pendiente:'task-status--pendiente',en_progreso:'task-status--progreso',completada:'task-status--completada',cancelada:'task-status--cancelada'};
    return m[s]||'task-status--pendiente';
  }

  function renderTaskCard(t) {
    var isDone = t.status === 'completada' || t.status === 'cancelada';
    var checked = t.status === 'completada' ? ' checked' : '';
    var disabled = isDone ? ' disabled' : '';
    var dueStr = t.due_at ? fmtDate(t.due_at) : '';
    var assignedStr = t.assigned_to_name ? esc(t.assigned_to_name) : '';
    var priorityLabel = TASK_PRIORITY_LABELS[t.priority]||'Media';
    var statusLabel = TASK_STATUS_LABELS[t.status]||t.status;
    return '<div class="crm-task-card'+(isDone?' task-card--done':'')+'" data-task-id="'+t.id+'" data-task-priority="'+(t.priority||'media')+'" data-task-assigned="'+(t.assigned_to_id||'')+'" data-task-due="'+(t.due_at||'')+'" data-task-desc="'+esc(t.description||'')+'" role="listitem">'+
      '<label class="acm-chip'+(disabled ? ' acm-chip--disabled' : '')+'">'+
      '<input type="checkbox" class="acm-chip-input crm-task-checkbox"'+checked+disabled+'>'+
      '<span class="acm-chip-visual"><span class="acm-chip-box"><svg class="acm-chip-icon" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></span><span class="acm-chip-text"></span></span>'+
      '</label>'+
      '<div class="crm-task-body">'+
      '<div class="crm-task-title">'+esc(t.title)+'</div>'+
      '<div class="crm-task-meta">'+
      '<span class="crm-task-priority '+taskPriorityClass(t.priority)+'">'+priorityLabel+'</span>'+
      '<span class="crm-task-status '+taskStatusClass(t.status)+'">'+statusLabel+'</span>'+
      (dueStr ? '<span class="crm-task-due'+(isFollowupDue(t.due_at)&&!isDone?' task-due--overdue':'')+'">'+dueStr+'</span>' : '')+
      (assignedStr ? '<span class="crm-task-assigned">'+esc(assignedStr)+'</span>' : '')+
      '</div>'+
      '</div>'+
      '<div class="crm-task-actions">'+
      (!isDone ? '<button class="btn btn-ghost btn-xs task-edit-btn" aria-label="Editar tarea">✎</button>' : '')+
      '<button class="btn btn-ghost btn-xs task-delete-btn" aria-label="Eliminar tarea">✕</button>'+
      '</div></div>';
  }

  function bindTaskCardEvents(panel, leadId, modal) {
    panel.querySelectorAll('.crm-task-checkbox').forEach(function(cb){
      cb.addEventListener('change',function(){
        var card = this.closest('.crm-task-card');
        if (!card) return;
        completeTask(parseInt(card.dataset.taskId), card);
      });
    });
    panel.querySelectorAll('.task-edit-btn').forEach(function(btn){
      btn.addEventListener('click',function(e){
        e.stopPropagation();
        var card = this.closest('.crm-task-card');
        if (!card) return;
        showTaskForm(leadId, parseInt(card.dataset.taskId), modal);
      });
    });
    panel.querySelectorAll('.task-delete-btn').forEach(function(btn){
      btn.addEventListener('click',function(e){
        e.stopPropagation();
        var card = this.closest('.crm-task-card');
        if (!card) return;
        deleteTask(parseInt(card.dataset.taskId), card);
      });
    });
  }

  async function completeTask(taskId, cardEl) {
    if (!cardEl) return;
    try {
      await _req('PATCH','/api/crm/tasks/'+taskId+'/complete');
      cardEl.classList.add('task-card--done');
      var cb = cardEl.querySelector('.crm-task-checkbox');
      if (cb) { cb.checked = true; cb.disabled = true; }
      var statusEl = cardEl.querySelector('.crm-task-status');
      if (statusEl) { statusEl.textContent = 'Completada'; statusEl.className = 'crm-task-status task-status--completada'; }
      var editBtn = cardEl.querySelector('.task-edit-btn');
      if (editBtn) editBtn.remove();
      toast('Tarea completada.','success');
    } catch(e) { toast('Error: '+e.message,'error'); }
  }

  async function deleteTask(taskId, cardEl) {
    if (!(await confirmModal('¿Eliminar esta tarea?'))) return;
    try {
      await _req('DELETE','/api/crm/tasks/'+taskId);
      if (cardEl) cardEl.remove();
      toast('Tarea eliminada.','success');
    } catch(e) { toast('Error: '+e.message,'error'); }
  }

  async function loadLeadTasks(leadId, modal) {
    var panel = modal.querySelector('#crmTasksPanel');
    if (!panel) return;
    panel.innerHTML = '<div class="loading-state">Cargando tareas...</div>';
    try {
      var d = await _req('GET','/api/crm/tasks?lead_id='+leadId);
      var tasks = d.tasks || [];
      if (!tasks.length) {
        panel.innerHTML = '<div class="crm-timeline-empty">Sin tareas aún. Creá la primera tarea para este prospecto.</div>';
        return;
      }
      var h = '<div class="crm-task-list" role="list">';
      for (var i = 0; i < tasks.length; i++) h += renderTaskCard(tasks[i]);
      h += '</div>';
      panel.innerHTML = h;
      bindTaskCardEvents(panel, leadId, modal);
    } catch (e) {
      panel.innerHTML = '<div class="crm-timeline-empty">Error al cargar tareas: '+esc(e.message)+'</div>';
    }
  }

  function _getTaskCardData(modal, taskId) {
    var card = modal.querySelector('.crm-task-card[data-task-id="'+taskId+'"]');
    if (!card) return { title:'', desc:'', priority:'media', assigned:'', due:'' };
    return {
      title: card.querySelector('.crm-task-title').textContent||'',
      desc: card.dataset.taskDesc||'',
      priority: card.dataset.taskPriority||'media',
      assigned: card.dataset.taskAssigned||'',
      due: card.dataset.taskDue||'',
    };
  }

  function _selOpt(opts, val) {
    if (!val) return opts;
    return opts.replace(new RegExp('"'+val+'"','g'),'"'+val+'" selected');
  }

  function showTaskForm(leadId, taskId, modal) {
    var panel = modal.querySelector('#crmQuickActionPanel');
    if (!panel) return;
    var isEdit = !!taskId;

    var priorityOpts = '';
    for (var i = 0; i < TASK_PRIORITIES.length; i++) {
      var p = TASK_PRIORITIES[i];
      priorityOpts += '<option value="'+p+'">'+TASK_PRIORITY_LABELS[p]+'</option>';
    }

    var pre = isEdit ? _getTaskCardData(modal, taskId) : { title:'', desc:'', priority:'media', assigned:'', due:'' };

    panel.innerHTML = '<div class="crm-quick-panel">'+
      '<span class="crm-quick-panel-label">'+(isEdit?'Editar tarea':'Nueva tarea')+'</span>'+
      '<input class="field-input" id="crmTaskTitle" placeholder="Título *" value="'+esc(pre.title)+'">'+
      '<textarea class="field-input" id="crmTaskDesc" rows="2" placeholder="Descripción (opcional)">'+esc(pre.desc)+'</textarea>'+
      '<div class="crm-field-row">'+
      '<div><span class="crm-field-label">Prioridad</span>'+
      '<select class="field-input field-input--select" id="crmTaskPriority">'+_selOpt(priorityOpts,pre.priority)+'</select></div>'+
      '<div><span class="crm-field-label">Asignado a</span>'+
      '<select class="field-input field-input--select" id="crmTaskAssigned"></select></div></div>'+
      '<span class="crm-field-label">Vence</span>'+
      '<input class="field-input" id="crmTaskDue" type="datetime-local" value="'+pre.due+'">'+
      '<div class="crm-quick-panel-actions">'+
      '<button class="btn btn-primary btn-sm" id="crmTaskSave">'+(isEdit?'Guardar cambios':'Crear tarea')+'</button>'+
      '<button class="btn btn-ghost btn-sm" id="crmTaskCancel">Cancelar</button></div></div>';

    var agents = window._crmAgents || [];
    var agentSel = modal.querySelector('#crmTaskAssigned');
    if (agentSel) {
      var opts = '<option value="">Sin agente</option>';
      for (var i = 0; i < agents.length; i++) {
        opts += '<option value="'+agents[i].id+'"'+(agents[i].id==parseInt(pre.assigned)?' selected':'')+'>'+esc(agents[i].name)+'</option>';
      }
      agentSel.innerHTML = opts;
    }

    async function onSave() {
      var btn = modal.querySelector('#crmTaskSave');
      btn.disabled = true;
      btn.textContent = 'Guardando...';
      var title = modal.querySelector('#crmTaskTitle').value.trim();
      if (!title) { toast('El título es obligatorio.','warn'); btn.disabled=false; btn.textContent=isEdit?'Guardar cambios':'Crear tarea'; return; }
      var data = {
        title: title,
        description: modal.querySelector('#crmTaskDesc').value.trim()||undefined,
        priority: (modal.querySelector('#crmTaskPriority')||{}).value||'media',
        assigned_to_id: parseInt((modal.querySelector('#crmTaskAssigned')||{}).value)||null,
        due_at: (modal.querySelector('#crmTaskDue')||{}).value||null,
      };
      if (!isEdit) data.lead_id = leadId;
      try {
        if (isEdit) {
          await _req('PATCH','/api/crm/tasks/'+taskId,data);
          toast('Tarea actualizada.','success');
        } else {
          await _req('POST','/api/crm/tasks',data);
          toast('Tarea creada.','success');
        }
        panel.innerHTML = '';
        await loadLeadTasks(leadId, modal);
        var acts = await _req('GET','/api/crm/leads/'+leadId+'/activities').catch(function(){return[];});
        var tl = modal.querySelector('.crm-timeline');
        if (tl) {
          var dots = {call:'call',note:'note',email:'email',visit:'visit',followup:'followup',status_change:'status_change'};
          tl.innerHTML = (acts||[]).map(function(a){
            var dc = dots[a.activity_type]||'note';
            return '<div class="crm-interaction"><span class="crm-interaction-dot crm-interaction-dot--'+dc+'"></span><div class="crm-interaction-body">'+
              '<strong>'+esc(a.title||a.activity_type||'')+'</strong>'+
              '<div class="crm-interaction-text">'+esc(a.description||'')+'</div>'+
              '<div class="crm-interaction-date">'+(a.created_at?fmtDate(a.created_at):'')+(a.created_by?' · '+esc(a.created_by):'')+'</div></div></div>';
          }).join('') || '<div class="crm-timeline-empty">Sin actividad registrada.</div>';
        }
      } catch(e) { toast('Error: '+e.message,'error'); btn.disabled=false; btn.textContent=isEdit?'Guardar cambios':'Crear tarea'; }
    }

    modal.querySelector('#crmTaskSave')?.addEventListener('click', onSave);
    modal.querySelector('#crmTaskCancel')?.addEventListener('click',function(){panel.innerHTML='';});
    var titleInp = modal.querySelector('#crmTaskTitle');
    if (titleInp) setTimeout(function(){titleInp.focus();},100);
  }

  window.CrmTasks = {
    loadLeadTasks: loadLeadTasks,
    showTaskForm: showTaskForm,
    completeTask: completeTask,
    deleteTask: deleteTask,
  };
})();
