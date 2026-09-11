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
      completeTask(card.dataset.taskId, card);
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

async function completeTask(taskId, cardEl) {
  try {
    var r = await db().from('lead_tasks').update({ status: 'completada', completed_at: new Date().toISOString() }).eq('id', taskId);
    if (r.error) throw new Error(r.error.message);
    if (cardEl) cardEl.classList.add('crm-task-card--done');
    var cb = cardEl && cardEl.querySelector('.crm-task-checkbox');
    if (cb) { cb.checked = true; cb.disabled = true; }
    toast('Tarea completada.', 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
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

function showTaskForm(leadId, taskId, panel) {
  var q = panel.querySelector('#crmQuickActionPanel');
  if (!q) return;
  var prioOpts = TASK_PRIORITIES.map(function (p) { return '<option value="' + p + '"' + (p === 'media' ? ' selected' : '') + '>' + TASK_PRIORITY_LABELS[p] + '</option>'; }).join('');
  q.innerHTML = '<div class="crm-quick-panel">' +
    '<span class="crm-quick-panel-label">Nueva tarea</span>' +
    '<input class="crm-field-input" id="crmTaskTitle" placeholder="Titulo *">' +
    '<textarea class="crm-field-input" id="crmTaskDesc" rows="2" placeholder="Descripcion (opcional)"></textarea>' +
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
    if (!title) { toast('El titulo es obligatorio.', 'error'); return; }
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
  completeTask: completeTask,
  deleteTask: deleteTask,
  priorityLabels: TASK_PRIORITY_LABELS,
  statusLabels: TASK_STATUS_LABELS,
  priorityClass: taskPriorityClass
};
})();
