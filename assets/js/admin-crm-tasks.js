/**
 * admin-crm-tasks.js - Gestión de tareas para leads CRM
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
  var noteHtml = t.completed_note ? '<div class="crm-task-completed-note" style="margin-top:6px; padding:8px 12px; background:rgba(16,185,129,0.08); border-left:3px solid var(--success); border-radius:4px; font-size:12px; color:var(--success);">' +
    '<i class="fas fa-check-circle" style="margin-right:4px;"></i>' + esc(t.completed_note) + '</div>' : '';
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
      noteHtml +
    '</div>' +
    '<button class="btn-action danger crm-task-delete" aria-label="Eliminar"><i class="fas fa-trash"></i></button></div>';
}

function bindTaskCardEvents(panel) {
  panel.querySelectorAll('.crm-task-checkbox').forEach(function (cb) {
    cb.addEventListener('change', function () {
      var card = this.closest('.crm-task-card');
      if (!card) return;
      var checkbox = this;
      Promise.resolve(completeTask(card.dataset.taskId, card, panel)).then(function (done) {
        if (done === false) { checkbox.checked = false; checkbox.disabled = false; }
      });
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

// Completar una tarea exige escribir el resultado. La DB solo se actualiza cuando
// el usuario confirma; cancelar deja la tarea pendiente.
async function completeTask(taskId, cardEl, panel) {
  var cb = cardEl && cardEl.querySelector('.crm-task-checkbox');
  if (cb) { cb.checked = false; cb.disabled = false; }
  var titleEl = cardEl && (cardEl.querySelector('.crm-task-title') || cardEl.querySelector('.crm-tl-task-head strong'));
  var title = titleEl ? (titleEl.textContent || '') : '';
  var leadId = panel && panel.dataset ? panel.dataset.leadId : null;
  if (!cardEl) return false;
  return await showOutcome(cardEl, taskId, title, leadId);
}

var OUTCOMES = [
  { id: 'contactado', label: 'Contactó' },
  { id: 'sin_respuesta', label: 'Sin respuesta' },
  { id: 'reprogramar', label: 'Reprogramar' },
  { id: 'no_interesa', label: 'No interesa' }
];

// El formulario de resultado abre como modal centrado en pantalla (no inline en el
// panel), para que el usuario lo vea completo sin tener que hacer scroll.
function showOutcome(cardEl, taskId, taskTitle, leadId) {
  return new Promise(function (resolve) {
    var old = document.querySelector('.crm-outcome-overlay[data-task-id="' + taskId + '"]');
    if (old) old.remove();
    var overlay = document.createElement('div');
    overlay.className = 'crm-outcome-overlay';
    overlay.dataset.taskId = taskId;
    var box = document.createElement('div');
    box.className = 'crm-outcome crm-outcome--modal';
    box.innerHTML =
      '<div class="crm-outcome-label">Resultado de "' + esc(taskTitle) + '" (obligatorio):</div>' +
      '<div class="crm-outcome-chips">' +
        OUTCOMES.map(function (o) { return '<button type="button" class="crm-outcome-chip" data-outcome="' + o.label + '">' + o.label + '</button>'; }).join('') +
      '</div>' +
      '<textarea class="crm-field-input crm-outcome-note" rows="2" placeholder="Describí brevemente cómo salió la tarea"></textarea>' +
      '<div class="crm-outcome-actions">' +
        '<button type="button" class="btn-action btn-action-labeled crm-outcome-cancel">Cancelar</button>' +
        '<button type="button" class="btn-luxury-action crm-outcome-save"><i class="fas fa-check"></i> Guardar resultado</button>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function close(result) {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    }
    function onKey(e) { if (e.key === 'Escape') close(false); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(false); });

    var noteEl = box.querySelector('.crm-outcome-note');
    box.querySelectorAll('[data-outcome]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var label = this.dataset.outcome;
        noteEl.value = noteEl.value.trim() ? label + ': ' + noteEl.value.trim() : label;
        noteEl.focus();
      });
    });
    box.querySelector('.crm-outcome-cancel').addEventListener('click', function () { close(false); });
    box.querySelector('.crm-outcome-save').addEventListener('click', function () { finish(); });
    if (noteEl.focus) noteEl.focus();

    async function finish() {
      var text = noteEl.value.trim();
      if (!text) { toast('Escribí el resultado de la tarea.', 'error'); noteEl.focus(); return; }
      try {
        var r = await db().from('lead_tasks').update({ status: 'completada', completed_at: new Date().toISOString(), completed_note: text }).eq('id', taskId);
        if (r.error) throw new Error(r.error.message);
        if (leadId) {
          await db().from('lead_activities').insert([{
            lead_id: leadId,
            activity_type: 'note',
            title: '"' + taskTitle + '"',
            description: 'Resultado: ' + text
          }]);
          await db().from('leads').update({ last_contacted_at: new Date().toISOString() }).eq('id', leadId);
        }
      } catch (e) { toast('Error: ' + e.message, 'error'); return; }
      cardEl.classList.add('crm-task-card--done', 'crm-tl-task--done');
      var cb = cardEl.querySelector('.crm-task-checkbox');
      if (cb) { cb.checked = true; cb.disabled = true; }
      var chip = cardEl.querySelector('.crm-tl-status');
      if (chip) { chip.textContent = 'Completada'; chip.classList.add('crm-tl-status--done'); }
      var bodyEl = cardEl.querySelector('.crm-task-body') || cardEl.querySelector('.crm-interaction-body');
      if (bodyEl && !bodyEl.querySelector('.crm-task-completed-note') && !bodyEl.querySelector('.crm-tl-completed-note')) {
        var noteDiv = document.createElement('div');
        noteDiv.className = 'crm-tl-completed-note';
        noteDiv.innerHTML = '<i class="fas fa-check-circle" style="margin-right:4px;"></i>' + esc(text);
        var metaEl = bodyEl.querySelector('.crm-tl-task-meta');
        if (metaEl) bodyEl.insertBefore(noteDiv, metaEl);
        else bodyEl.appendChild(noteDiv);
      }
      toast('Resultado registrado. Tarea completada.', 'success');
      close(true);
    }
  });
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
    var r = await db().from('lead_tasks').select('*').eq('lead_id', leadId).order('completed_at', { ascending: false, nullsLast: true }).order('due_at', { ascending: true });
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
  if (t.indexOf('pasado manana') !== -1) days = 2;
  else if (/(^|\s)manana/.test(t) || /(^|\s)ma\u00f1ana/.test(t)) days = 1;
  else if (/(^|\s)hoy/.test(t)) days = 0;
  else if (t.indexOf('ma\u00f1ana') !== -1 || t.indexOf('manana') !== -1) days = 1;
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
  var title = text.replace(/^(hoy|ma\u00f1ana|manana|pasado ma\u00f1ana|pasado manana)\s*/i, '').replace(/\s*a?\s*las?\s*\d{1,2}[:h.]\d{0,2}\s*(am|pm)?\s*$/i, '').trim() || text;
  try {
    var r = await db().from('lead_tasks').insert([{
      lead_id: leadId,
      title: title,
      priority: 'media',
      status: 'pendiente',
      due_at: due ? due.toISOString() : null
    }]);
    if (r.error) throw new Error(r.error.message);
    toast(due ? ('Tarea: ' + title + ' · ' + due.toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) : 'Tarea creada.', 'success');
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
      '<div><span class="crm-side-field-label">Vence</span><input class="crm-field-input" id="crmTaskDue" type="datetime-local" step="600"></div>' +
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
  renderTaskCard: renderTaskCard,
  priorityLabels: TASK_PRIORITY_LABELS,
  statusLabels: TASK_STATUS_LABELS,
  priorityClass: taskPriorityClass
};
})();
