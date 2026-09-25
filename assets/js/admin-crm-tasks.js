/**
 * admin-crm-tasks.js - Task management for CRM leads
 * Expone window.CrmTasks
 */
(function () {
'use strict';

var TASK_PRIORITIES = ['baja','media','alta','urgente'];
var TASK_PRIORITY_LABELS = { baja:'Baja', media:'Media', alta:'Alta', urgente:'Urgente' };
var TASK_STATUS_LABELS = { pendiente:'Pendiente', en_progreso:'En progreso', completada:'Completada', cancelada:'Cancelada' };

function esc(s) {
  if (window.BHUtils && typeof window.BHUtils.esc === 'function') return window.BHUtils.esc(s);
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('es-AR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }); } catch (e) { return ''; }
}
function isFollowupDue(d) { return d ? new Date(d) <= new Date() : false; }
function toast(msg, type) {
  var t = document.getElementById('toastMsg');
  var txt = document.getElementById('toastText');
  if (!t || !txt) return;
  txt.textContent = msg;
  t.classList.remove('is-error','is-success');
  if (type === 'error') t.classList.add('is-error');
  if (type === 'success') t.classList.add('is-success');
  t.classList.add('is-visible');
  clearTimeout(window.__crmToastTimer);
  window.__crmToastTimer = setTimeout(function () { t.classList.remove('is-visible'); }, 3500);
}
function db() { return window.supabaseClient; }

function taskPriorityClass(p) {
  var m = { baja:'crm-task-priority--baja', media:'crm-task-priority--media', alta:'crm-task-priority--alta', urgente:'crm-task-priority--urgente' };
  return m[p] || m.media;
}
function taskStatusClass(s) {
  var m = { pendiente:'crm-task-status--pendiente', en_progreso:'crm-task-status--progreso', completada:'crm-task-status--completada', cancelada:'crm-task-status--cancelada' };
  return m[s] || m.pendiente;
}

function renderTaskCard(t) {
  var isDone = t.status === 'completada' || t.status === 'cancelada';
  var checked = t.status === 'completada' ? ' checked' : '';
  var disabled = isDone ? ' disabled' : '';
  var dueStr = t.due_at ? fmtDate(t.due_at) : '';
  return '<div class="crm-task-card' + (isDone ? ' crm-task-card--done' : '') + '" data-task-id="' + t.id + '">' +
    '<label class="crm-task-check">' +
      '<input type="checkbox" class="crm-task-checkbox"' + checked + disabled + '>' +
      '<span class="crm-task-check-visual"></span></label>' +
    '<div class="crm-task-body">' +
      '<div class="crm-task-title">' + esc(t.title) + '</div>' +
      (t.description ? '<div class="crm-task-desc">' + esc(t.description) + '</div>' : '') +
      '<div class="crm-task-meta">' +
        '<span class="crm-task-priority ' + taskPriorityClass(t.priority) + '">' + (TASK_PRIORITY_LABELS[t.priority] || 'Media') + '</span>' +
        (dueStr ? '<span class="crm-task-due' + (isFollowupDue(t.due_at) && !isDone ? ' crm-task-due--overdue' : '') + '">' + dueStr + '</span>' : '') +
      '</div>' +
    '</div>' +
    '<button class="btn-action danger crm-task-delete" aria-label="Eliminar"><i class="fas fa-trash"></i></button></div>';
}

function bindTaskCardEvents(panel) {
  panel.querySelectorAll('.crm-task-checkbox').forEach(function (cb) {
    cb.addEventListener('change', function () {
      var card = this.closest('.crm-task-card');
      if (!card) return;
      completeTask(card.dataset.taskId, card, panel);
    });
  });
  panel.querySelectorAll('.crm-task-delete').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var card = this.closest('.crm-task-card');
      if (!card) return;
      if (!confirm('Eliminar esta tarea?')) return;
      deleteTask(card.dataset.taskId, card);
    });
  });
}

async function completeTask(taskId, cardEl, panel) {
  try {
    var r = await db().from('lead_tasks').update({ status: 'completada', completed_at: new Date().toISOString() }).eq('id', taskId);
    if (r.error) throw new Error(r.error.message);
    if (cardEl) cardEl.classList.add('crm-task-card--done');
    var cb = cardEl && cardEl.querySelector('.crm-task-checkbox');
    if (cb) { cb.checked = true; cb.disabled = true; }
    toast('Tarea completada.', 'success');
    var titleEl = cardEl && (cardEl.querySelector('.crm-task-title') || cardEl.querySelector('.crm-tl-task-head strong'));
    var title = titleEl ? (titleEl.textContent || '') : '';
    var leadId = panel && panel.dataset ? panel.dataset.leadId : null;
    if (cardEl && leadId) showOutcome(cardEl, taskId, title, leadId);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

var OUTCOMES = [
  { id: 'contactado', label: 'Contactó' },
  { id: 'sin_respuesta', label: 'Sin respuesta' },
  { id: 'reprogramar', label: 'Reprogramar' },
  { id: 'no_interesa', label: 'No interesa' }
];

function showOutcome(cardEl, taskId, taskTitle, leadId) {
  var old = cardEl.parentElement.querySelector('.crm-outcome[data-task-id="' + taskId + '"]');
  if (old) old.remove();
  var box = document.createElement('div');
  box.className = 'crm-outcome';
  box.dataset.taskId = taskId;
  box.innerHTML =
    '<div class="crm-outcome-label">Resultado de “' + esc(taskTitle) + '”:</div>' +
    '<div class="crm-outcome-chips">' +
      OUTCOMES.map(function (o) { return '<button type="button" class="crm-outcome-chip" data-outcome="' + o.id + '">' + o.label + '</button>'; }).join('') +
      '<button type="button" class="crm-outcome-chip crm-outcome-chip--ghost" data-outcome="__otro">Otro…</button>' +
    '</div>' +
    '<div class="crm-outcome-next" style="display:none;">' +
      '<input type="text" class="crm-field-input crm-outcome-next-input" placeholder="Siguiente acción (opcional): ej. “Llamar mañana 10:00”">' +
      '<button type="button" class="btn-action crm-outcome-next-add" title="Crear siguiente tarea"><i class="fas fa-plus"></i></button>' +
    '</div>';
  cardEl.parentElement.insertBefore(box, cardEl.nextSibling);

  async function finish(text) {
    try {
      var desc = 'Resultado: ' + text;
      await db().from('lead_activities').insert([{
        lead_id: leadId,
        activity_type: 'note',
        title: '✓ ' + taskTitle,
        description: desc
      }]);
      // Contacto real registrado: actualizar timeline
      if (text.indexOf('Sin respuesta') !== 0) {
        await db().from('leads').update({ last_contacted_at: new Date().toISOString() }).eq('id', leadId);
      }
    } catch (e) { console.warn('[tasks] outcome log:', e.message); }
    var nextInp = box.querySelector('.crm-outcome-next-input');
    if (nextInp && nextInp.value.trim() && window.CrmTasks && window.CrmTasks.createQuick) {
      await window.CrmTasks.createQuick(leadId, nextInp.value.trim());
    }
    toast('Resultado registrado.', 'success');
    box.remove();
  }

  box.querySelectorAll('[data-outcome]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = this.dataset.outcome;
      if (id === '__otro') {
        var input = prompt('Resultado de la tarea:', '');
        if (input === null) return;
        finish(input.trim() || 'Otro');
      } else {
        finish(OUTCOMES.filter(function (o) { return o.id === id; })[0].label);
      }
    });
  });
  var nextWrap = box.querySelector('.crm-outcome-next');
  if (nextWrap) {
    nextWrap.style.display = 'flex';
    box.querySelector('.crm-outcome-next-add').addEventListener('click', function () {
      var inp = box.querySelector('.crm-outcome-next-input');
      if (inp && inp.value.trim() && window.CrmTasks && window.CrmTasks.createQuick) {
        window.CrmTasks.createQuick(leadId, inp.value.trim());
        inp.value = '';
      }
    });
  }
}

async function deleteTask(taskId, cardEl) {
  try {
    var r = await db().from('lead_tasks').delete().eq('id', taskId);
    if (r.error) throw new Error(r.error.message);
    if (cardEl) cardEl.remove();
    toast('Tarea eliminada.', 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function loadLeadTasks(leadId, panel) {
  var wrap = panel.querySelector('#crmTasksPanel');
  if (!wrap) return;
  wrap.innerHTML = '<div class="crm-loading">Cargando tareas...</div>';
  try {
    var r = await db().from('lead_tasks').select('*').eq('lead_id', leadId).order('due_at', { ascending: true });
    if (r.error) throw new Error(r.error.message);
    var tasks = r.data || [];
    if (!tasks.length) {
      wrap.innerHTML = '<div class="crm-timeline-empty">Sin tareas aun.</div>';
      return;
    }
    wrap.innerHTML = '<div class="crm-task-list">' + tasks.map(renderTaskCard).join('') + '</div>';
    bindTaskCardEvents(wrap);
  } catch (e) {
    wrap.innerHTML = '<div class="crm-timeline-empty">Error: ' + esc(e.message) + '</div>';
  }
}

function parseQuickDate(text) {
  var now = new Date();
  var date = null;
  var t = ' ' + text.toLowerCase() + ' ';
  var days = 0;
  if (t.indexOf('pasado mañana') !== -1 || t.indexOf('pasado manana') !== -1) days = 2;
  else if (/(^|\s)mañana/.test(t) || /(^|\s)manana/.test(t)) days = 1;
  else if (/(^|\s)hoy/.test(t)) days = 0;
  else if (t.indexOf('mañana') !== -1 || t.indexOf('manana') !== -1) days = 1;
  var hasDayWord = days > 0 || /(^|\s)hoy/.test(t);
  var timeMatch = t.match(/(\d{1,2})[:h.](\d{2})/) || t.match(/(^|\s)(\d{1,2})(?=\s*(am|pm)?(\s|$))/) ;
  var h = null, m = 0;
  if (timeMatch) {
    h = parseInt(timeMatch[1] || timeMatch[2], 10);
    m = parseInt(timeMatch[2] || '0', 10) || 0;
    if (h != null && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      if (!hasDayWord && (h < now.getHours() || (h === now.getHours() && m <= now.getMinutes()))) days = 1;
      date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, m, 0, 0);
    } else { h = null; }
  }
  if (!date && hasDayWord) {
    date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 9, 0, 0, 0);
    if (days === 0) date = new Date(now.getTime() + 3600000);
  }
  return date;
}

async function createQuick(leadId, rawText) {
  var text = String(rawText || '').trim();
  if (!text) { toast('Escribí la tarea.', 'error'); return null; }
  var due = parseQuickDate(text);
  var title = text.replace(/^(hoy|mañana|manana|pasado mañana|pasado manana)\s*/i, '').replace(/\s*a?\s*las?\s*\d{1,2}[:h.]\d{0,2}\s*(am|pm)?\s*$/i, '').trim() || text;
  try {
    var r = await db().from('lead_tasks').insert([{
      lead_id: leadId,
      title: title,
      priority: 'media',
      status: 'pendiente',
      due_at: due ? due.toISOString() : null
    }]);
    if (r.error) throw new Error(r.error.message);
    toast(due ? ('Tarea: ' + title + ' — ' + due.toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) : 'Tarea creada.', 'success');
    return true;
  } catch (e) { toast('Error: ' + e.message, 'error'); return null; }
}

function showTaskForm(leadId, taskId, panel) {
  var q = panel.querySelector('#crmQuickActionPanel');
  if (!q) return;
  var prioOpts = TASK_PRIORITIES.map(function (p) { return '<option value="' + p + '"' + (p === 'media' ? ' selected' : '') + '>' + TASK_PRIORITY_LABELS[p] + '</option>'; }).join('');
  q.innerHTML = '<div class="crm-quick-panel">' +
    '<span class="crm-quick-panel-label">Nueva tarea</span>' +
    '<input class="crm-field-input" id="crmTaskTitle" placeholder="Título *">' +
    '<textarea class="crm-field-input" id="crmTaskDesc" rows="2" placeholder="Descripción (opcional)"></textarea>' +
    '<div class="crm-side-field-row">' +
      '<div><span class="crm-side-field-label">Prioridad</span><select class="crm-field-input" id="crmTaskPriority">' + prioOpts + '</select></div>' +
      '<div><span class="crm-side-field-label">Vence</span><input class="crm-field-input" id="crmTaskDue" type="datetime-local"></div>' +
    '</div>' +
    '<div class="crm-quick-panel-actions">' +
      '<button class="btn-luxury-action" id="crmTaskSave">Crear tarea</button>' +
      '<button class="btn-action" id="crmTaskCancel">Cancelar</button></div></div>';
  q.querySelector('#crmTaskCancel').addEventListener('click', function () { q.innerHTML = ''; });
  q.querySelector('#crmTaskSave').addEventListener('click', async function () {
    var title = (q.querySelector('#crmTaskTitle') || {}).value.trim();
    if (!title) { toast('El título es obligatorio.', 'error'); return; }
    var data = {
      lead_id: leadId,
      title: title,
      description: (q.querySelector('#crmTaskDesc') || {}).value.trim() || null,
      priority: (q.querySelector('#crmTaskPriority') || {}).value || 'media',
      status: 'pendiente',
      due_at: (q.querySelector('#crmTaskDue') || {}).value || null
    };
    try {
      var r = await db().from('lead_tasks').insert([data]);
      if (r.error) throw new Error(r.error.message);
      toast('Tarea creada.', 'success');
      q.innerHTML = '';
      if (leadId && window.BH_CRM && typeof window.BH_CRM.refresh === 'function') {
        window.BH_CRM.refresh();
        window.BH_CRM.open(leadId);
      } else {
        await loadLeadTasks(leadId, panel);
      }
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  });
}

window.CrmTasks = {
  loadLeadTasks: loadLeadTasks,
  showTaskForm: showTaskForm,
  createQuick: createQuick,
  completeTask: completeTask,
  deleteTask: deleteTask,
  priorityLabels: TASK_PRIORITY_LABELS,
  statusLabels: TASK_STATUS_LABELS,
  priorityClass: taskPriorityClass
};
})();
