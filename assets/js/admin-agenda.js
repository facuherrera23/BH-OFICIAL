/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Modulo: Agenda y Visitas
   Extraido de admin-app.js (modularizacion). Helpers via window.__BH.
   ============================================================ */
(function () {
  'use strict';
  const { logError, on, validateForm, getAuthedClient, loadCRM, loadAgentSelect, loadPropertySelect, openModal, closeModal, showToast, invalidateSearchCache, updateSidebarBadges, VisitSchema } = window.__BH || {};

  /* ------------------------------------------------
     8. AGENDA
     ------------------------------------------------ */
  let calCurrentDate = new Date();
  let calEventsCache = [];
  let calViewMode = 'month'; // 'month' | 'week' | 'day'

  const AGENDA_TYPE_LABELS = {
    visita: 'Visita',
    llamada: 'Llamada',
    nota: 'Nota',
    email: 'Email',
    followup: 'Followup',
    tarea: 'Tarea',
    cambio: 'Cambio de estado',
    alerta: 'Alerta',
    comision: 'Comisión',
    documento: 'Documento',
    contacto: 'Contacto'
  };

  const ACTIVITY_TO_TYPE = {
    call: 'llamada',
    note: 'nota',
    email: 'email',
    visit: 'visita',
    followup: 'followup',
    status_change: 'cambio',
    task: 'tarea'
  };

  const TIMELINE_TO_TYPE = {
    note: 'nota',
    alert: 'alerta',
    commission: 'comision',
    document: 'documento',
    contact: 'contacto'
  };

  async function loadAgenda() {
    invalidateSearchCache();
    const client = await getAuthedClient();
    if (!client) return;

    const trashMode = ($('#calStatusFilter')?.value === 'eliminada');
    try {
      const since90 = new Date(Date.now() - 90 * 86400000).toISOString();
      let visitsQ = client
        .from('visits')
        .select('*, leads(id, full_name, stage), agents(id, full_name), properties(id, title, property_code)')
        .gte('visit_date', new Date(Date.now() - 180 * 86400000).toISOString())
        .lte('visit_date', new Date(Date.now() + 180 * 86400000).toISOString())
        .order('visit_date', { ascending: true });
      visitsQ = trashMode ? visitsQ.not('deleted_at', 'is', null) : visitsQ.is('deleted_at', null);
      const [visitsRes, actsRes, tasksRes, timelineRes] = await Promise.all([
        client
          .from('visits')
          .select('*, leads(id, full_name, stage), agents(id, full_name), properties(id, title, property_code)')
          .is('deleted_at', null)
          .gte('visit_date', new Date(Date.now() - 180 * 86400000).toISOString())
          .lte('visit_date', new Date(Date.now() + 180 * 86400000).toISOString())
          .order('visit_date', { ascending: true }),
        client
          .from('lead_activities')
          .select('*, leads(id, full_name, stage, assigned_to)')
          .gte('created_at', since90)
          .order('created_at', { ascending: false })
          .limit(1000),
        client
          .from('lead_tasks')
          .select('*, leads(id, full_name, stage, assigned_to)')
          .order('due_at', { ascending: true })
          .limit(500),
        client
          .from('owner_timeline_entries')
          .select('*, owners(id, full_name)')
          .gte('created_at', since90)
          .order('created_at', { ascending: false })
          .limit(1000)
      ]);
      if (visitsRes.error) throw visitsRes.error;
      if (actsRes.error) throw actsRes.error;
      if (tasksRes.error) throw tasksRes.error;
      if (timelineRes.error) throw timelineRes.error;

      const events = [];

      /* Visitas programadas */
      (visitsRes.data || []).forEach(v => {
        if (!v.visit_date) return;
        events.push({
          key: 'vis-' + v.id,
          type: 'visita',
          source: 'visits',
          entity: v.client_name || 'Visita',
          date: new Date(v.visit_date),
          title: v.client_name || 'Visita',
          subtitle: (v.properties?.title ? v.properties.title : '') +
            (v.leads?.full_name ? (v.properties?.title ? ' · ' : '') + v.leads.full_name : ''),
          status: v.status || 'pendiente',
          brokerId: v.agent_id || null,
          leadId: v.lead_id || null,
          onClick: trashMode
            ? async function () {
                if (!confirm('¿Restaurar esta visita eliminada?')) return;
                const rr = await window.supabaseClient.from('visits').update({ deleted_at: null }).eq('id', v.id);
                if (rr.error) { showToast('Error: ' + rr.error.message, 'error'); return; }
                showToast('Visita restaurada.', 'success');
                loadAgenda();
              }
            : function () { window.adminApp.editVisit(v.id); }
        });
      });

      /* Actividades de leads (sin estado de visita propio) */
      (actsRes.data || []).forEach(a => {
        const type = ACTIVITY_TO_TYPE[a.activity_type] || 'nota';
        events.push({
          key: 'act-' + a.id,
          type: type,
          source: 'lead_activities',
          entity: a.leads?.full_name || 'Lead',
          date: new Date(a.created_at),
          title: a.title || AGENDA_TYPE_LABELS[type],
          subtitle: (a.description || '') +
            (a.leads?.full_name ? (a.description ? ' · ' : '') + a.leads.full_name : ''),
          status: '',
          brokerId: a.leads?.assigned_to || null,
          leadId: a.lead_id || null,
          onClick: function () {
            if (a.lead_id && window.adminApp.editLead) window.adminApp.editLead(a.lead_id);
          }
        });
      });

      /* Tareas de leads (fecha = due_at) */
      (tasksRes.data || []).forEach(t => {
        if (!t.due_at) return;
        events.push({
          key: 'task-' + t.id,
          type: 'tarea',
          source: 'lead_tasks',
          entity: t.leads?.full_name || 'Tarea',
          date: new Date(t.due_at),
          title: t.title || 'Tarea',
          subtitle: ('Prioridad: ' + (t.priority || 'media')) +
            (t.leads?.full_name ? ' · ' + t.leads.full_name : ''),
          status: t.status || 'pendiente',
          brokerId: t.assigned_to || t.leads?.assigned_to || null,
          leadId: t.lead_id || null,
          onClick: function () {
            if (t.lead_id && window.adminApp.editLead) window.adminApp.editLead(t.lead_id);
          }
        });
      });

      /* Timeline de propietarios */
      (timelineRes.data || []).forEach(o => {
        const type = TIMELINE_TO_TYPE[o.type] || 'nota';
        events.push({
          key: 'own-' + o.id,
          type: type,
          source: 'owner_timeline_entries',
          entity: o.owners?.full_name || 'Propietario',
          date: new Date(o.created_at),
          title: (o.owners?.full_name || 'Propietario') + ' · ' + AGENDA_TYPE_LABELS[type],
          subtitle: o.text || '',
          status: '',
          brokerId: o.created_by || null,
          ownerId: o.owner_id || null,
          onClick: function () {
            if (o.owner_id && window.adminApp.editOwner) window.adminApp.editOwner(o.owner_id);
          }
        });
      });

      calEventsCache = events;
      renderAgenda();
      updateAgendaKpis(events);
    } catch (err) {
      logError('Agenda error:', err);
      showToast('Error al cargar la agenda', 'error');
    }
  }

  function updateAgendaKpis(events) {
    const visits = events.filter(e => e.type === 'visita');
    const now = new Date();
    const todayStr = agendaDayKey(now);
    const weekEnd = new Date(now); weekEnd.setDate(now.getDate() + (7 - now.getDay()));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const hoy = visits.filter(v => agendaDayKey(v.date) === todayStr && v.status !== 'cancelada').length;
    const semana = visits.filter(v => v.date >= now && v.date <= weekEnd && v.status !== 'cancelada').length;
    const sinConfirmar = visits.filter(v => v.date >= now && v.status === 'pendiente').length;
    const mesHechas = visits.filter(v => v.status === 'completada' && v.date >= monthStart).length;
    const vencidas = visits.filter(v => v.date < now && ['pendiente', 'confirmada', 'en_curso'].includes(v.status)).length;
    const cerradasMes = visits.filter(v => v.date >= monthStart && ['completada', 'cancelada'].includes(v.status));
    const asistencia = cerradasMes.length ? Math.round(cerradasMes.filter(v => v.status === 'completada').length / cerradasMes.length * 100) + '%' : '—';
    const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    set('#agendaKpiHoy', hoy);
    set('#agendaKpiSemana', semana);
    set('#agendaKpiSinConfirmar', sinConfirmar);
    set('#agendaKpiMes', mesHechas);
    set('#agendaKpiVencidas', vencidas);
    set('#agendaKpiAsistencia', asistencia);
  }

  /* ---------- Helpers de fecha ---------- */
  const AGENDA_MONTH_NAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const AGENDA_DOW_SHORT = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

  function agendaDayKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function agendaFilters() {
    return {
      status: $('#calStatusFilter')?.value || '',
      type: $('#calTypeFilter')?.value || '',
      broker: $('#calBrokerFilter')?.value || ''
    };
  }

  function agendaMatches(ev, f) {
    if (f.type && ev.type !== f.type) return false;
    if (f.broker && ev.brokerId !== f.broker) return false;
    if (f.status === 'eliminada') return ev.type === 'visita';
    if (f.status && (!ev.status || ev.status !== f.status)) return false;
    return true;
  }

  function agendaLabel() {
    if (calViewMode === 'day') {
      return AGENDA_MONTH_NAMES[calCurrentDate.getMonth()] + ' ' + calCurrentDate.getDate() + ', ' + calCurrentDate.getFullYear();
    }
    if (calViewMode === 'week') {
      const start = new Date(calCurrentDate);
      start.setDate(calCurrentDate.getDate() - ((calCurrentDate.getDay() + 6) % 7));
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      const sameMonth = start.getMonth() === end.getMonth();
      if (start.getFullYear() !== end.getFullYear()) {
        return start.getDate() + ' ' + AGENDA_MONTH_NAMES[start.getMonth()] + ' — ' + end.getDate() + ' ' + AGENDA_MONTH_NAMES[end.getMonth()] + ' ' + end.getFullYear();
      }
      return (sameMonth ? '' : AGENDA_MONTH_NAMES[start.getMonth()] + ' ') + start.getDate() + ' — ' + AGENDA_MONTH_NAMES[end.getMonth()] + ' ' + end.getDate() + ', ' + end.getFullYear();
    }
    return AGENDA_MONTH_NAMES[calCurrentDate.getMonth()] + ' ' + calCurrentDate.getFullYear();
  }

  function agendaEventEl(ev) {
    const timeStr = ev.date
      ? ev.date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
      : '';
    const tooltip = ev.subtitle ? ev.title + ' — ' + ev.subtitle : ev.title;
    const stCls = ev.status ? ' ev--' + ev.status : '';
    const overdue = ev.status && ev.status !== 'completada' && ev.status !== 'cancelada' && ev.date && ev.date.getTime() < Date.now();
    const odCls = overdue ? ' ev--vencida' : '';
    return '<div class="cal-event ev-' + ev.type + stCls + odCls + '" data-key="' + ev.key + '" title="' + esc(tooltip) + '">' +
      (timeStr ? '<span class="ag-event-time">' + esc(timeStr) + '</span> ' : '') +
      esc(ev.title) +
      '</div>';
  }

  /* ---------- Vista Mes ---------- */
  function renderMonthView() {
    const grid = $('#calendarGrid');
    if (!grid) return;
    const f = agendaFilters();
    const year = calCurrentDate.getFullYear();
    const month = calCurrentDate.getMonth();
    const today = new Date();
    const todayStr = agendaDayKey(today);

    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startDay = (firstDay.getDay() + 6) % 7;
    const prevMonthLastDay = new Date(year, month, 0).getDate();

    const eventsByDay = {};
    calEventsCache.forEach(ev => {
      if (!agendaMatches(ev, f)) return;
      const dk = agendaDayKey(ev.date);
      if (!eventsByDay[dk]) eventsByDay[dk] = [];
      eventsByDay[dk].push(ev);
    });
    Object.keys(eventsByDay).forEach(dk => {
      eventsByDay[dk].sort((a, b) => (a.date - b.date));
    });

    const monthEl = $('#calCurrentMonth');
    if (monthEl) monthEl.textContent = agendaLabel();

    let html = '';
    let dayCount = 1;
    let nextMonthDay = 1;

    for (let week = 0; week < 6; week++) {
      for (let dow = 0; dow < 7; dow++) {
        let isCurrentMonth = false;
        let dayNum = 0;
        let dateStr = '';

        if (week === 0 && dow < startDay) {
          dayNum = prevMonthLastDay - (startDay - dow - 1);
          const prevMonth = month === 0 ? 11 : month - 1;
          const prevYear = month === 0 ? year - 1 : year;
          dateStr = prevYear + '-' + String(prevMonth + 1).padStart(2, '0') + '-' + String(dayNum).padStart(2, '0');
        } else if (dayCount <= daysInMonth) {
          dayNum = dayCount++;
          dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(dayNum).padStart(2, '0');
          isCurrentMonth = true;
        } else {
          dayNum = nextMonthDay++;
          const nextMonth = month === 11 ? 0 : month + 1;
          const nextYear = month === 11 ? year + 1 : year;
          dateStr = nextYear + '-' + String(nextMonth + 1).padStart(2, '0') + '-' + String(dayNum).padStart(2, '0');
        }

        const isToday = dateStr === todayStr;
        const dayEvents = eventsByDay[dateStr] || [];
        const maxShow = 3;
        let eventsHtml = '';
        dayEvents.slice(0, maxShow).forEach(ev => {
          eventsHtml += agendaEventEl(ev);
        });
        if (dayEvents.length > maxShow) {
          eventsHtml += '<div class="cal-event-more" data-goto-date="' + dateStr + '">+' + (dayEvents.length - maxShow) + ' más</div>';
        }

        const otherMonthClass = isCurrentMonth ? '' : ' other-month';
        const todayClass = isCurrentMonth && isToday ? ' today' : '';

        html += '<div class="cal-day' + otherMonthClass + todayClass + '" data-date="' + dateStr + '" data-current-month="' + isCurrentMonth + '">' +
          '<div class="cal-day-number">' + dayNum + '</div>' +
          '<div class="cal-events">' + eventsHtml + '</div>' +
          '</div>';
      }
    }

    const gridEl = document.getElementById('calendarGrid');
    if (gridEl) {
      const headers = gridEl.querySelectorAll('.cal-day-header');
      gridEl.innerHTML = '';
      headers.forEach(h => gridEl.appendChild(h));
      gridEl.insertAdjacentHTML('beforeend', html);
    }
    bindAgendaClicks();
  }

  /* ---------- Vista Semana ---------- */
  function renderWeekView() {
    const container = $('#calendarWeekGrid');
    if (!container) return;
    const f = agendaFilters();
    const monthEl = $('#calCurrentMonth');
    if (monthEl) monthEl.textContent = agendaLabel();

    const start = new Date(calCurrentDate);
    start.setDate(calCurrentDate.getDate() - ((calCurrentDate.getDay() + 6) % 7));
    start.setHours(0, 0, 0, 0);

    const eventsByDay = {};
    calEventsCache.forEach(ev => {
      if (!agendaMatches(ev, f)) return;
      const dk = agendaDayKey(ev.date);
      if (!eventsByDay[dk]) eventsByDay[dk] = [];
      eventsByDay[dk].push(ev);
    });
    Object.keys(eventsByDay).forEach(dk => {
      eventsByDay[dk].sort((a, b) => (a.date - b.date));
    });

    const todayStr = agendaDayKey(new Date());
    let html = '';
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const dk = agendaDayKey(d);
      const isToday = dk === todayStr;
      let eventsHtml = '';
      (eventsByDay[dk] || []).forEach(ev => {
        eventsHtml += agendaEventEl(ev);
      });
      html +=
        '<div class="cal-week-col' + (isToday ? ' today' : '') + '" data-date="' + dk + '">' +
        '<div class="cal-week-day-head">' +
        '<span class="cal-week-dayname">' + AGENDA_DOW_SHORT[i] + '</span>' +
        '<span class="cal-week-daynum">' + d.getDate() + '</span>' +
        '</div>' +
        '<div class="cal-week-events">' + (eventsHtml || '<span class="cal-week-empty">—</span>') + '</div>' +
        '</div>';
    }
    container.innerHTML = html;
    bindAgendaClicks();
  }

  /* ---------- Vista Día ---------- */
  function renderDayView() {
    const container = $('#calendarDayView');
    if (!container) return;
    const f = agendaFilters();
    const monthEl = $('#calCurrentMonth');
    if (monthEl) monthEl.textContent = agendaLabel();

    const dk = agendaDayKey(calCurrentDate);
    const dayEvents = calEventsCache
      .filter(ev => agendaDayKey(ev.date) === dk && agendaMatches(ev, f))
      .sort((a, b) => (a.date - b.date));

    let html = '';
    if (!dayEvents.length) {
      html = '<div class="cal-day-empty">Sin eventos para este día'
        + ' <button type="button" class="btn-action" id="calDayEmptyAdd" style="margin-left:12px;"><i class="fas fa-plus"></i> Agendar visita aquí</button></div>';
    } else {
      const isToday = dk === agendaDayKey(new Date());
      let nowMarked = false;
      dayEvents.forEach(ev => {
        if (isToday && !nowMarked && ev.date.getTime() >= Date.now()) {
          html += '<div class="cal-day-now"><span>' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) + ' — ahora</span></div>';
          nowMarked = true;
        }
        const timeStr = ev.date
          ? ev.date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
          : '';
        html +=
          '<div class="cal-day-row" data-key="' + ev.key + '">' +
          '<div class="cal-day-row-time">' + esc(timeStr) + '</div>' +
          '<div class="cal-day-row-main">' +
          '<div class="cal-event ev-' + ev.type + '" data-key="' + ev.key + '">' + esc(ev.title) + '</div>' +
          (ev.subtitle ? '<div class="cal-day-row-sub">' + esc(ev.subtitle) + '</div>' : '') +
          '</div>' +
          '</div>';
      });
      if (isToday && !nowMarked) {
        html += '<div class="cal-day-now"><span>' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) + ' — día finalizado</span></div>';
      }
    }
    container.innerHTML = html;
    const addBtn = $('#calDayEmptyAdd');
    if (addBtn) addBtn.addEventListener('click', () => { if (window.adminApp.openVisitModal) window.adminApp.openVisitModal({ visit_date: calCurrentDate.toISOString() }); });
    bindAgendaClicks();
  }

  function renderAgenda() {
    if (calViewMode === 'week') renderWeekView();
    else if (calViewMode === 'day') renderDayView();
    else renderMonthView();
    updateViewSwitcher();
  }

  function updateViewSwitcher() {
    $('#calViewMonthBtn')?.classList.toggle('active', calViewMode === 'month');
    $('#calViewWeekBtn')?.classList.toggle('active', calViewMode === 'week');
    $('#calViewDayBtn')?.classList.toggle('active', calViewMode === 'day');
    const grid = $('#calendarGrid');
    const week = $('#calendarWeekGrid');
    const day = $('#calendarDayView');
    if (grid) grid.style.display = calViewMode === 'month' ? 'grid' : 'none';
    if (week) week.style.display = calViewMode === 'week' ? 'grid' : 'none';
    if (day) day.style.display = calViewMode === 'day' ? 'block' : 'none';
  }

  async function rescheduleVisitToDay(visitId, dateStr, oldDate) {
    if (!confirm('Mover la visita al ' + dateStr + '?')) return;
    try {
      const d = new Date(oldDate);
      const [y, m, dd] = dateStr.split('-').map(Number);
      const target = new Date(y, m - 1, dd, d.getHours(), d.getMinutes());
      const { error } = await window.supabaseClient.from('visits').update({ visit_date: target.toISOString() }).eq('id', visitId);
      if (error) throw error;
      if (ev.leadId) {
        try {
          await window.supabaseClient.from('lead_activities').insert([{
            lead_id: ev.leadId,
            activity_type: 'note',
            title: 'Visita reprogramada (arrastrar y soltar)',
            description: d.toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' → ' + target.toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
          }]);
        } catch (_) {}
      }
      showToast('Visita reprogramada al ' + target.toLocaleDateString('es-AR'), 'success');
      loadAgenda();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
  }

  function goToDayView(dateStr) {
    const parts = String(dateStr).split('-');
    if (parts.length !== 3) return;
    calCurrentDate = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    calViewMode = 'day';
    renderAgenda();
  }

  function calStep(dir) {
    if (calViewMode === 'day') calCurrentDate.setDate(calCurrentDate.getDate() + dir);
    else if (calViewMode === 'week') calCurrentDate.setDate(calCurrentDate.getDate() + 7 * dir);
    else calCurrentDate.setMonth(calCurrentDate.getMonth() + dir);
    renderAgenda();
  }

  function bindAgendaClicks() {
    /* Drag & drop: arrastrar una visita a otro día = reprogramar (conserva hora) */
    document.querySelectorAll('#calendarGrid .cal-event[data-key^="vis-"], #calendarWeekGrid .cal-event[data-key^="vis-"]').forEach(el => {
      el.draggable = true;
      el.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/plain', el.dataset.key);
        e.dataTransfer.effectAllowed = 'move';
      });
    });
    document.querySelectorAll('#calendarGrid .cal-day[data-date], #calendarWeekGrid .cal-week-col[data-date]').forEach(el => {
      el.addEventListener('dragover', function (e) {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('text/plain')) { e.preventDefault(); el.classList.add('cal-drop-target'); }
      });
      el.addEventListener('dragleave', function () { el.classList.remove('cal-drop-target'); });
      el.addEventListener('drop', async function (e) {
        e.preventDefault();
        el.classList.remove('cal-drop-target');
        const key = e.dataTransfer.getData('text/plain');
        const targetDate = el.getAttribute('data-date');
        if (!key || !key.startsWith('vis-') || !targetDate) return;
        const visitId = key.slice(4);
        const ev = calEventsCache.find(x => x.key === key);
        if (!ev) return;
        await rescheduleVisitToDay(visitId, targetDate, ev.date);
      });
    });

    document.querySelectorAll('#calendarGrid .cal-day[data-date]').forEach(el => {
      el.onclick = function (e) {
        if (e.target.closest('.cal-event, .cal-event-more')) return;
        goToDayView(el.getAttribute('data-date'));
      };
    });
    document.querySelectorAll('#calendarWeekGrid .cal-week-col[data-date]').forEach(el => {
      el.onclick = function (e) {
        if (e.target.closest('.cal-event')) return;
        goToDayView(el.getAttribute('data-date'));
      };
    });
    document.querySelectorAll('#calendarGrid .cal-event[data-key], #calendarWeekGrid .cal-event[data-key], #calendarDayView .cal-event[data-key], .cal-day-row[data-key]').forEach(el => {
      el.onclick = function (e) {
        e.stopPropagation();
        const key = el.getAttribute('data-key');
        const ev = calEventsCache.find(x => x.key === key);
        if (ev && ev.onClick) ev.onClick();
      };
    });
    document.querySelectorAll('#calendarGrid .cal-event-more[data-goto-date]').forEach(el => {
      el.onclick = function (e) {
        e.stopPropagation();
        goToDayView(el.getAttribute('data-goto-date'));
      };
    });
  }

  /* ---------- Handlers de cabecera ---------- */
  $('#calPrevMonth')?.addEventListener('click', function () { calStep(-1); });
  $('#calNextMonth')?.addEventListener('click', function () { calStep(1); });
  $('#calTodayBtn')?.addEventListener('click', function () {
    calCurrentDate = new Date();
    renderAgenda();
  });
  $('#calViewMonthBtn')?.addEventListener('click', function () {
    calViewMode = 'month';
    renderAgenda();
  });
  $('#calViewWeekBtn')?.addEventListener('click', function () {
    calViewMode = 'week';
    renderAgenda();
  });
  $('#calViewDayBtn')?.addEventListener('click', function () {
    calViewMode = 'day';
    renderAgenda();
  });
  $('#calStatusFilter')?.addEventListener('change', function () { renderAgenda(); });
  $('#calTypeFilter')?.addEventListener('change', function () { renderAgenda(); });
  $('#calBrokerFilter')?.addEventListener('change', function () { renderAgenda(); });

  /* Persistencia de filtros (sobrevive al cambio de pestaña/recarga) */
  ['calStatusFilter', 'calTypeFilter', 'calBrokerFilter'].forEach(id => {
    const el = $('#' + id);
    if (!el) return;
    const saved = localStorage.getItem('agenda:' + id);
    if (saved) { el.value = saved; }
    el.addEventListener('change', () => { localStorage.setItem('agenda:' + id, el.value); });
  });

  /* Compartir la agenda del día vía WhatsApp */
  $('#calShareDayBtn')?.addEventListener('click', function () {
    const dk = agendaDayKey(calCurrentDate);
    const dayEvents = calEventsCache
      .filter(ev => agendaDayKey(ev.date) === dk && ev.status !== 'cancelada' && ev.type === 'visita')
      .sort((a, b) => a.date - b.date);
    const fecha = calCurrentDate.toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: 'long' });
    let text = '📅 *Agenda ' + fecha + '*\n';
    if (!dayEvents.length) text += '\nSin visitas para este día.';
    else dayEvents.forEach(ev => {
      const t = ev.date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      text += '\n• ' + t + ' — ' + ev.title + (ev.subtitle ? ' · ' + ev.subtitle : '') + ' [' + ev.status + ']';
    });
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  });

  /* Reasignación masiva: mueve las visitas futuras de un broker a otro */
  window.adminApp.reassignBrokerVisits = async function (fromAgentId, toAgentId) {
    if (!fromAgentId || !toAgentId || fromAgentId === toAgentId) { showToast('Elegí brokers distintos.', 'warning'); return; }
    if (!confirm('¿Reasignar todas las visitas futuras de este broker al otro?')) return;
    try {
      const { error, count } = await window.supabaseClient
        .from('visits')
        .update({ agent_id: toAgentId })
        .eq('agent_id', fromAgentId)
        .is('deleted_at', null)
        .in('status', ['pendiente', 'confirmada'])
        .gte('visit_date', new Date().toISOString())
        .select('id');
      if (error) throw error;
      showToast('Reasignadas ' + (count ?? '?') + ' visitas futuras.', 'success');
      loadAgenda();
      updateSidebarBadges();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  };

  /* Imprimir la vista actual */
  $('#calPrintBtn')?.addEventListener('click', function () { window.print(); });

  /* KPIs clickeables: atajos de navegación */
  $('#agendaKpiHoy')?.closest('.crm-kpi')?.addEventListener('click', function () {
    calCurrentDate = new Date(); calViewMode = 'day'; renderAgenda();
  });
  $('#agendaKpiSemana')?.closest('.crm-kpi')?.addEventListener('click', function () {
    calCurrentDate = new Date(); calViewMode = 'week'; renderAgenda();
  });
  $('#agendaKpiSinConfirmar')?.closest('.crm-kpi')?.addEventListener('click', function () {
    const f = $('#calStatusFilter'); if (f) { f.value = 'pendiente'; localStorage.setItem('agenda:calStatusFilter', 'pendiente'); }
    renderAgenda();
  });
  $('#agendaKpiVencidas')?.closest('.crm-kpi')?.addEventListener('click', function () {
    const f = $('#calStatusFilter'); if (f) { f.value = 'pendiente'; localStorage.setItem('agenda:calStatusFilter', 'pendiente'); }
    calViewMode = 'day'; renderAgenda();
  });

  /* Navegación por teclado: ← → cambian el período, t vuelve a hoy (solo con la pestaña abierta) */
  document.addEventListener('keydown', function (e) {
    if (e.target.closest('input, textarea, select')) return;
    const agendaTab = $('#tab-agenda');
    if (!agendaTab || agendaTab.offsetParent === null) return;
    if (e.key === 'ArrowLeft') { calStep(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { calStep(1); e.preventDefault(); }
    else if (e.key === 't' || e.key === 'T') { calCurrentDate = new Date(); renderAgenda(); }
  });

  /* ---------- Filtro de brokers (solo calendario) ---------- */
  async function populateBrokerFilters() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('agents')
        .select('id, full_name')
        .eq('status', 'activo')
        .is('deleted_at', null)
        .order('full_name');
      if (error) throw error;
      const brokers = data || [];
      const calFilter = $('#calBrokerFilter');
      if (calFilter) {
        const current = calFilter.value;
        calFilter.innerHTML = '<option value="">Todos los brokers</option>';
        brokers.forEach(b => {
          const opt = document.createElement('option');
          opt.value = b.id;
          opt.textContent = b.full_name;
          calFilter.appendChild(opt);
        });
        if (current) calFilter.value = current;
      }
    } catch (_) { /* silent */ }
  }

  populateBrokerFilters();

  function visitRowHtml(v) {
    const dateStr = v.visit_date
      ? new Date(v.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '-';
    const lead = v.leads;
    const leadLink = lead
      ? `<button class="btn-action" style="font-size:10px; color:var(--accent);" title="Ver en CRM" onclick="event.stopPropagation(); window.adminApp.editLead('${lead.id}')">
           <i class="fas fa-user"></i> ${esc(lead.full_name)} <i class="fas fa-external-link-alt" style="font-size:9px; margin-left:2px;"></i>
         </button>`
      : '<span style="color:var(--text-dim); font-size:12px;">—</span>';

    let countdownHtml = '';
    if ((v.status === 'pendiente' || v.status === 'confirmada') && v.visit_date) {
      const diffMs = new Date(v.visit_date).getTime() - Date.now();
      if (diffMs > 0) {
        const diffH = diffMs / (1000 * 60 * 60);
        const diffM = diffMs / (1000 * 60);
        let label, color, bg;
        if (diffH < 1) { label = Math.round(diffM) + 'min'; color = '#ef4444'; bg = 'rgba(239,68,68,0.15)'; }
        else if (diffH < 24) { label = Math.round(diffH) + 'h'; color = '#FFB800'; bg = 'rgba(255,184,0,0.15)'; }
        else { label = Math.round(diffH / 24) + 'd'; color = 'var(--accent)'; bg = 'rgba(31,200,195,0.15)'; }
        countdownHtml = `<span class="nav-badge" style="font-size:10px; background:${bg}; color:${color}; margin-left:6px; padding:2px 6px; border-radius:8px;"><i class="fas fa-clock" style="margin-right:3px;"></i>${label}</span>`;
      }
    }

    /* Check-in / Check-out buttons for pending/confirmed visits */
    let checkinHtml = '';
    if ((v.status === 'pendiente' || v.status === 'confirmada') && !v.check_in) {
      checkinHtml = `<button class="btn-action" title="Marcar llegada" onclick="window.adminApp.checkinVisit('${v.id}')" style="background:rgba(0,200,120,0.15); color:var(--success);"><i class="fas fa-sign-in-alt"></i></button>`;
    } else if (v.check_in && !v.check_out) {
      checkinHtml = `<button class="btn-action" title="Marcar salida" onclick="window.adminApp.checkoutVisit('${v.id}')" style="background:rgba(31,200,195,0.15); color:var(--accent);"><i class="fas fa-sign-out-alt"></i></button>`;
    }

    /* Show check-in/out times if set */
    let checkinTimeHtml = '';
    if (v.check_in) {
      const ci = new Date(v.check_in).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      checkinTimeHtml = `<div style="font-size:11px; color:var(--success);"><i class="fas fa-sign-in-alt"></i> ${ci}</div>`;
    }
    if (v.check_out) {
      const co = new Date(v.check_out).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      checkinTimeHtml += `<div style="font-size:11px; color:var(--accent);"><i class="fas fa-sign-out-alt"></i> ${co}</div>`;
    }

    return `
      <tr>
        <td style="font-size:13px;">${dateStr}</td>
        <td style="font-size:13px; font-weight:500;">${esc(v.client_name || 'Sin cliente')}</td>
        <td style="font-size:13px; color:var(--text-dim);">${leadLink}</td>
        <td style="font-size:12px; color:var(--text-dim);">${v.properties?.title ? esc(v.properties.title) : '—'}</td>
        <td><span class="nav-badge" style="background:${v.status === 'confirmada' ? 'rgba(0,200,120,0.15)' : v.status === 'completada' ? 'rgba(31,200,195,0.15)' : 'rgba(255,184,0,0.15)'}; color:${v.status === 'confirmada' ? 'var(--success)' : v.status === 'completada' ? 'var(--accent)' : 'var(--warning)'}; font-size:11px;">${esc(v.status || 'pendiente')}</span>${countdownHtml}</td>
        <td style="font-size:12px; color:var(--text-dim);">${v.leads?.full_name ? esc(v.leads.full_name) : '—'}</td>
        <td>
          <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
            ${v.confirmation_token && v.client_email ? '<button class="btn-action" title="Copiar link de confirmacion" onclick="window.adminApp.copyVisitLink(\'${v.id}\')"><i class="fas fa-link"></i></button>' : ''}
            <button class="btn-action" title="Editar" onclick="window.adminApp.editVisit('${v.id}')"><i class="fas fa-pen"></i></button>
            ${checkinHtml}
            ${checkinTimeHtml}
            <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteVisit('${v.id}')"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>`;
  }

  

    // ============================================
    // GRANULAR REALTIME ROW UPDATES
    // (Las funciones upsert*/remove* están definidas más abajo, junto a sus
    //  builders HTML correspondientes. Este bloque se duplicaba por error.)
    // ============================================

    // Helper: extract row builders from existing load functions
    function buildLeadCardHtml(l) {
      const leadVisits = (window._visitsByLeadCache?.[l.id] || []);
      const upcomingVisit = leadVisits.find(v => v.status === 'pendiente' || v.status === 'confirmada');
      const hasFutureVisit = !!upcomingVisit;
      const showScheduleBtn = (l.stage === 'contactado' || l.stage === 'visita_agendada') && !hasFutureVisit;
      const budgetHtml = l.budget_usd ? '<div style="color:var(--accent); font-size:12px; font-weight:500;">USD ' + l.budget_usd.toLocaleString('es-AR') + '</div>' : '';
      const prefType = l.preferred_type ? l.preferred_type.charAt(0).toUpperCase() + l.preferred_type.slice(1) : '';
      const prefZone = l.preferred_zone ? '· ' + esc(l.preferred_zone) : '';
      const scoreVal = l.score || 0;
      const scoreColor = scoreVal >= 80 ? 'rgba(239,68,68,0.2)' : scoreVal >= 50 ? 'rgba(255,184,0,0.2)' : 'rgba(255,255,255,0.06)';
      const scoreTextColor = scoreVal >= 80 ? '#ef4444' : scoreVal >= 50 ? 'var(--warning)' : 'var(--text-dim)';
      let visitInfo = '';
      if (upcomingVisit) {
        const badgeColor = upcomingVisit.status === 'confirmada' ? 'rgba(0,200,120,0.2)' : 'rgba(255,184,0,0.2)';
        const badgeTextColor = upcomingVisit.status === 'confirmada' ? 'var(--success)' : 'var(--warning)';
        const visitDate = new Date(upcomingVisit.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        visitInfo = '<div style="margin-top:6px; padding:6px 8px; background:rgba(31,200,195,0.08); border-radius:4px; font-size:11px; color:var(--accent); display:flex; align-items:center; gap:6px;">' +
          '<i class="fas fa-calendar-day"></i>' +
          '<span>' + esc(visitDate) + '</span>' +
          '<span class="nav-badge" style="font-size:9px; background:' + badgeColor + '; color:' + badgeTextColor + ';">' + esc(upcomingVisit.status) + '</span>' +
          '</div>';
      }
      let scheduleBtn = '';
      if (showScheduleBtn) {
        scheduleBtn = '<button class="btn-action" data-open-visit data-lead-id="' + esc(l.id) + '" data-client-name="' + esc(l.full_name) + '" data-client-phone="' + esc(l.phone || l.whatsapp || '') + '" data-property-id="' + esc(l.property_id || '') + '" style="padding:4px 8px; font-size:10px; margin-top:8px; width:100%; background:rgba(31,200,195,0.15); color:var(--accent); border:1px solid var(--accent);">' +
          '<i class="fas fa-calendar-plus"></i> Agendar visita' +
          '</button>';
      }
      return `
        <div class="lead-card" data-lead-id="${l.id}" style="background:var(--surface-2); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:14px; margin-bottom:10px; cursor:pointer;" onclick="window.adminApp.editLead('${esc(l.id)}')">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <div style="font-weight:600; color:#fff; font-size:13px;">${esc(l.full_name || 'Sin nombre')}</div>
            <span class="nav-badge" style="font-size:10px; background:rgba(31,200,195,0.12); color:var(--accent); font-weight:600; padding:2px 6px; border-radius:10px;">${l.score || 0}</span>
          </div>
          <div style="color:var(--text-dim); font-size:11px; margin-bottom:6px;">${esc(l.preferred_type || '')}${l.preferred_zone ? ' · ' + esc(l.preferred_zone) : ''}</div>
          ${budgetHtml}
          ${visitInfo}
          ${scheduleBtn}
          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top:8px; border-top:1px solid var(--border-subtle);">
            <span style="color:var(--text-dim); font-size:10px;">${new Date(l.created_at).toLocaleDateString('es-AR')}</span>
            <div style="display:flex; gap:4px;">
              <button class="btn-action" style="padding:4px 6px; font-size:10px;" title="Editar" onclick="event.stopPropagation(); window.adminApp.editLead('${esc(l.id)}')"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" style="padding:4px 6px; font-size:10px;" title="Eliminar" onclick="event.stopPropagation(); window.adminApp.deleteLead('${esc(l.id)}')"><i class="fas fa-trash"></i></button>
            </div>
          </div>
        </div>`;
    }

    function buildPropertyRowHtml(p) {
      return `<tr data-id="${p.id}">
        <td style="font-weight:600; color:#fff;">${esc(p.title)}</td>
        <td>${esc(p.property_code || '')}</td>
        <td>${esc(p.zone)}</td>
        <td>${p.surface_total ? p.surface_total + ' m²' : '-'}</td>
        <td>${p.rooms || '-'}</td>
        <td style="font-weight:600; color:var(--accent);">${p.price_usd ? '$ ' + Number(p.price_usd).toLocaleString('es-AR') : '-'}</td>
        <td><span class="nav-badge" style="background:${p.status === 'venta' ? 'rgba(31,200,195,0.15)' : 'rgba(255,184,0,0.15)'}; color:${p.status === 'venta' ? 'var(--accent)' : 'var(--warning)'};">${esc(p.status || 'venta')}</span></td>
        <td style="color:${p.owner_id ? '#fff' : 'var(--text-dim)'};">${esc(p.owner_id ? '?' : '—')}</td>
        <td>
          <div style="display:flex; gap:4px; flex-wrap:wrap;">
            ${p.is_published ? '<span class="nav-badge" style="background:rgba(0,200,120,0.15); color:var(--success);">Publicada</span>' : '<span class="nav-badge" style="background:rgba(255,255,255,0.06); color:var(--text-dim);">Borrador</span>'}
            ${p.featured ? '<span class="nav-badge" style="background:rgba(255,184,0,0.15); color:var(--warning);"><i class="fas fa-star" style="margin-right:4px;"></i>Destacada</span>' : ''}
            ${p.is_retasada ? '<span class="nav-badge" style="background:rgba(139,92,246,0.15); color:#8b5cf6;"><i class="fas fa-tag" style="margin-right:4px;"></i>Retasada</span>' : ''}
            ${p.is_oportunidad ? '<span class="nav-badge" style="background:rgba(239,68,68,0.15); color:#ef4444;"><i class="fas fa-bolt" style="margin-right:4px;"></i>Oportunidad</span>' : ''}
            ${p.is_shared ? '<span class="nav-badge" style="background:rgba(6,182,212,0.15); color:#06b6d4;"><i class="fas fa-share-nodes" style="margin-right:4px;"></i>Compartido</span>' : ''}
            ${p.is_vendida ? '<span class="nav-badge" style="background:rgba(75,85,99,0.18); color:#4b5563;"><i class="fas fa-check-circle" style="margin-right:4px;"></i>Vendida</span>' : ''}
            ${p.is_reservada ? '<span class="nav-badge" style="background:rgba(234,179,8,0.18); color:#ca8a04;"><i class="fas fa-lock" style="margin-right:4px;"></i>Reservada</span>' : ''}

          </div>
        </td>
        <td>
          <div style="display:flex; gap:6px; align-items:center;">
            <button class="btn-action" title="Editar" onclick="window.adminApp.editProperty(\'${p.id}\')"><i class="fas fa-pen"></i></button>
            <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteProperty(\'${p.id}\')"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>`;
    }

    function buildAgentRowHtml(a) {
      return `<tr data-id="${a.id}">
        <td>
          <div style="display:flex; align-items:center; gap:10px;">
            <img style="width:36px; height:36px; border-radius:50%; object-fit:cover; border:1px solid var(--border-subtle);" src="${esc(a.photo_url || 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=100&q=60&fit=crop')}" alt="" />
            <div>
              <div style="font-weight:600; color:#fff; font-size:13px;">${esc(a.full_name || 'Sin nombre')}</div>
              <div style="color:var(--text-dim); font-size:11px;">${esc(a.email || '')}</div>
            </div>
          </td>
          <td>${esc(a.matricula || '-')}</td>
          <td>${(a.specialties && a.specialties.length) ? a.specialties.map(s => '<span class="nav-badge" style="background:rgba(16,185,129,0.12); color:#10b981; font-size:10px; margin-right:3px;">${esc(s)}</span>').join('') : '<span style="color:var(--text-dim);">—</span>'}</td>
          <td style="color:var(--accent);">${a.commission_rate != null ? esc(a.commission_rate + '%') : '3%'}</td>
          <td><span class="nav-badge" style="background:${a.status === 'activo' ? 'rgba(0,200,120,0.15)' : a.status === 'licencia' ? 'rgba(255,184,0,0.15)' : 'rgba(255,255,255,0.06)'}; color:${a.status === 'activo' ? 'var(--success)' : a.status === 'licencia' ? 'var(--warning)' : 'var(--text-dim)'}; font-size:11px;">${esc(a.status || 'activo')}</span></td>
          <td>${esc(a.phone || '-')}</td>
          <td>
            <div style="display:flex; gap:6px;">
              <button class="btn-action" title="Editar" onclick="window.adminApp.editAgent(\'${a.id}\')"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteAgent(\'${a.id}\')"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>`;
    }

    function ownerExpiryBadges(o) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const in30 = new Date(today.getTime() + 30 * 86400000);
      const badges = [];
      if (o.exclusive) {
        badges.push('<span class="nav-badge" style="background:rgba(31,200,195,0.12); color:var(--accent);"><i class="fas fa-star" style="margin-right:3px;"></i>Exclusivo</span>');
        if (o.exclusive_end) {
          const end = new Date(o.exclusive_end);
          if (end < today) badges.push('<span class="nav-badge" style="background:rgba(239,68,68,0.15); color:var(--danger);">Excl. vencida</span>');
          else if (end <= in30) badges.push('<span class="nav-badge" style="background:rgba(255,184,0,0.15); color:var(--warning);">Vence ' + end.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' }) + '</span>');
        }
      }
      if (o.dni_expiry && new Date(o.dni_expiry) <= in30) badges.push('<span class="nav-badge" style="background:rgba(239,68,68,0.12); color:var(--danger);">DNI por vencer</span>');
      if (o.cuit_expiry && new Date(o.cuit_expiry) <= in30) badges.push('<span class="nav-badge" style="background:rgba(239,68,68,0.12); color:var(--danger);">CUIT por vencer</span>');
      return badges.length ? '<div style="display:flex; gap:4px; flex-wrap:wrap; margin-top:4px;">' + badges.join('') + '</div>' : '';
    }

    function buildOwnerRowHtml(o) {
      const wa = window.BH_CRM && window.BH_CRM.waNumber ? window.BH_CRM.waNumber(o.phone) : null;
      return `<tr data-id="${o.id}">
        <td>
          <div style="display:flex; align-items:center; gap:8px;">
            <strong>${esc(o.full_name)}</strong>
            ${wa ? '<a class="crm-contact-btn crm-contact-btn--wa" href="https://wa.me/' + wa + '" target="_blank" rel="noopener" title="WhatsApp" style="width:26px; height:26px; padding:0; display:inline-flex; align-items:center; justify-content:center;"><i class="fab fa-whatsapp"></i></a>' : ''}
          </div>
          ${ownerExpiryBadges(o)}
        </td>
        <td>${esc(o.dni_cuit || '-')}</td>
        <td>${esc(o.email || '-')}</td>
        <td>${esc(o.phone || '-')}</td>
        <td>${esc(o.address || '-')}</td>
        <td>
          <div style="display:flex; gap:6px;">
            <button class="btn-action" title="Editar" onclick="window.adminApp.editOwner('${o.id}')"><i class="fas fa-pen"></i></button>
            <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteOwner('${o.id}')"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>`;
    }

    function tasAvatarColor(name) {
      const colors = ['#20B8AB', '#3b82f6', '#8C64DC', '#e67e22', '#39D98A', '#CC3535', '#FFB432', '#1abc9c', '#9b59b6', '#e74c3c'];
      let hash = 0;
      const s = String(name || '');
      for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
      return colors[Math.abs(hash) % colors.length];
    }

    function tasInitials(text) {
      const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return 'T';
      return parts.slice(0, 2).map(p => p.charAt(0)).join('').toUpperCase();
    }

    function buildTasacionRowHtml(t, extras) {
      const ownerName = (t.owners && t.owners.full_name) || (extras && extras.ownerName) || null;
      const propName = t.properties
        ? [t.properties.property_code || t.properties.code, t.properties.title].filter(Boolean).join(' · ')
        : ((extras && extras.propName) || null);
      const statusLabel = t.status === 'finalized' ? 'Finalizada' : 'Borrador';
      const statusClass = t.status === 'finalized' ? 'active' : 'pending';
      const date = t.created_at ? new Date(t.created_at).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
      const typeLabel = t.type === 'venta' ? 'Venta' : t.type === 'alquiler' ? 'Alquiler' : (t.type || '');
      const typeChip = typeLabel
        ? `<span class="crm-tipo-chip crm-tipo-chip--tas${t.type === 'alquiler' ? ' tas-chip--alquiler' : ''}">${esc(typeLabel)}</span>`
        : '';
      let valuation = t.valuation_usd;
      if (!valuation && t.data && typeof t.data === 'object') {
        valuation = t.data.valuation_usd || t.data.final_valuation || null;
      }
      const valuationStr = valuation ? 'US$ ' + Number(valuation).toLocaleString('es-AR') : '—';
      const avatarBase = ownerName || t.title || 'Tasacion';
      const meta = [ownerName, propName].filter(Boolean).map(x => esc(x)).join(' · ') || 'Sin vínculos en el CRM';
      return `<tr class="tas-row" data-id="${esc(t.id)}">
        <td><div class="crm-client-row"><span class="crm-client-avatar" style="background:${tasAvatarColor(avatarBase)}">${esc(tasInitials(avatarBase))}</span><div><strong>${esc(t.title || 'Sin título')}</strong>${typeChip}<div class="crm-meta">${meta}</div></div></div></td>
        <td><span class="tas-valor">${valuationStr}</span></td>
        <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
        <td><span class="tas-fecha">${date}</span></td>
        <td class="crm-td-actions">
          <button class="btn-action" title="Abrir" data-open-tasacion="${esc(t.id)}" data-tasacion-title="${esc(t.title || '')}"><i class="fas fa-external-link-alt"></i></button>
          <button class="btn-action" title="Exportar PDF" data-pdf-tasacion="${esc(t.id)}" data-tasacion-title="${esc(t.title || '')}"><i class="fas fa-file-pdf"></i></button>
          <button class="btn-action danger" title="Eliminar" data-del-tasacion="${esc(t.id)}"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }


    function upsertVisitRow(v) {
      const tbody = $('#visitsTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector('tr[data-id="' + v.id + '"]');
      const rowHtml = visitRowHtml(v);
      if (existing) {
        existing.outerHTML = rowHtml;
      } else {
        tbody.insertAdjacentHTML('afterbegin', rowHtml);
      }
    }

    function removeVisitRow(id) {
      const row = $('#visitsTableBody')?.querySelector('tr[data-id="' + id + '"]');
      if (row) row.remove();
    }

    function upsertPropertyRow(p) {
      const tbody = $('#propertiesTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector('tr[data-id="' + p.id + '"]');
      if (existing) {
        existing.outerHTML = buildPropertyRowHtml(p);
      } else {
        tbody.insertAdjacentHTML('afterbegin', buildPropertyRowHtml(p));
      }
    }

    function removePropertyRow(id) {
      const row = $('#propertiesTableBody')?.querySelector('tr[data-id="' + id + '"]');
      if (row) row.remove();
    }

    function upsertAgentRow(agent) {
      const tbody = $('#agentsTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector('tr[data-id="' + agent.id + '"]');
      if (existing) {
        existing.outerHTML = buildAgentRowHtml(agent);
      } else {
        tbody.insertAdjacentHTML('afterbegin', buildAgentRowHtml(agent));
      }
    }

    function removeAgentRow(id) {
      const row = $('#agentsTableBody')?.querySelector('tr[data-id="' + id + '"]');
      if (row) row.remove();
    }

    function upsertOwnerRow(owner) {
      const tbody = $('#ownersTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector('tr[data-id="' + owner.id + '"]');
      if (existing) {
        existing.outerHTML = buildOwnerRowHtml(owner);
      } else {
        tbody.insertAdjacentHTML('afterbegin', buildOwnerRowHtml(owner));
      }
    }

    function removeOwnerRow(id) {
      const row = $('#ownersTableBody')?.querySelector('tr[data-id="' + id + '"]');
      if (row) row.remove();
    }

    function upsertTasacionRow(t) {
      const tbody = $('#tasacionesTableBody');
      if (!tbody) return;
      const existing = tbody.querySelector('tr[data-id="' + t.id + '"]');
      if (existing) {
        existing.outerHTML = buildTasacionRowHtml(t);
      } else {
        tbody.insertAdjacentHTML('afterbegin', buildTasacionRowHtml(t));
      }
    }

    function removeTasacionRow(id) {
      const row = $('#tasacionesTableBody')?.querySelector('tr[data-id="' + id + '"]');
      if (row) row.remove();
    }

    // Lead card helper (for CRM kanban)
    function upsertLeadCard(lead) {
      const _stageCol = { nuevo:'nuevos', contactado:'contactados', calificado:'contactados', visita_agendada:'visita', visita_realizada:'visita', negociacion:'oferta', cerrado_ganado:'oferta', cerrado_perdido:'oferta' };
      const stage = lead.stage || 'nuevo';
      const container = document.querySelector('#cards-' + (_stageCol[stage] || 'nuevos'));
      if (!container) return;
      const existing = container.querySelector('[data-lead-id="' + lead.id + '"]');
      if (existing) {
        existing.outerHTML = buildLeadCardHtml(lead);
      } else {
        container.insertAdjacentHTML('afterbegin', buildLeadCardHtml(lead));
      }
    }

    function removeLeadCard(id) {
      document.querySelectorAll('.lead-card[data-lead-id]').forEach(el => {
        if (el.dataset.leadId === id) el.remove();
      });
    }

  /* Lead selector del modal de visitas */
  async function loadVisitLeadSelect(selectedId = null) {
    const sel = $('#visitLeadSelectEl');
    if (!sel || !window.supabaseClient) return;
    try {
      const { data } = await window.supabaseClient
        .from('leads')
        .select('id, full_name, stage')
        .is('deleted_at', null)
        .not('stage', 'in', '("cerrado_ganado","cerrado_perdido")')
        .order('full_name');
      sel.innerHTML = '<option value="">— Sin lead (visita espontánea) —</option>' +
        (data || []).map(l => `<option value="${l.id}">${esc(l.full_name)}</option>`).join('');
      if (selectedId) sel.value = selectedId;
    } catch (_) { /* silent */ }
  }

  async function loadLeadContextForVisit(leadId) {
    const box = $('#visitLeadHistory');
    if (!box) return;
    if (!leadId) { box.style.display = 'none'; box.innerHTML = ''; return; }
    try {
      const { data, error } = await window.supabaseClient
        .from('lead_activities')
        .select('title, description, created_at')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })
        .limit(4);
      if (error || !data || !data.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.innerHTML = '<div style="font-size:11px; color:var(--text-dim); margin-bottom:6px; text-transform:uppercase; letter-spacing:.5px;">Historial reciente del lead</div>' +
        data.map(a => {
          const dd = new Date(a.created_at).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
          return '<div style="padding:5px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:12px;">'
            + '<strong style="color:var(--text-secondary);">' + esc(a.title || 'Nota') + '</strong>'
            + (a.description ? ' <span style="color:var(--text-dim);">' + esc(String(a.description).slice(0, 90)) + (a.description.length > 90 ? '…' : '') + '</span>' : '')
            + ' <span style="color:var(--text-dim); float:right; font-size:11px;">' + dd + '</span></div>';
        }).join('');
      box.style.display = 'block';
    } catch (_) { box.style.display = 'none'; }
  }

  /* Create visit */
  on($('#btnNewVisit'), 'click', () => {
    editingVisitId = null;
    const copyBtn = $('#visitCopyLinkBtn');
    if (copyBtn) copyBtn.style.display = 'none';
    const cbox = $('#visitConflictBox');
    if (cbox) cbox.style.display = 'none';
    const slotsWrap = $('#visitSlotsWrap');
    if (slotsWrap) slotsWrap.style.display = 'none';
    $('#visitForm')?.reset();
    loadAgentSelect($('#visitBrokerSelect'));
    loadPropertySelect($('#visitPropertySelect'));
    loadVisitLeadSelect();
    document.querySelectorAll('.visit-dur-chip').forEach(b => b.classList.toggle('is-active', b.dataset.min === '60'));
    openModal('visitModal');
  });

  /* openVisitModal — llamado desde CRM con pre-llenado */
  window.adminApp.openVisitModal = function (prefill = {}) {
    editingVisitId = null;
    const form = $('#visitForm');
    if (form) form.reset();

    loadAgentSelect($('#visitBrokerSelect'));
    loadVisitLeadSelect(prefill.lead_id || null);

    /* Pre-llenar desde CRM */
    if (prefill.visit_date) {
      const d = new Date(prefill.visit_date);
      setVisitDateParts(d);

    }
    if (prefill.client_name) {
      const el = document.querySelector('#visitForm [name="client_name"]');
      if (el) el.value = prefill.client_name;
    }
    if (prefill.client_phone) {
      const el = document.querySelector('#visitForm [name="client_phone"]');
      if (el) el.value = prefill.client_phone;
    }
    if (prefill.client_email) {
      const el = document.querySelector('#visitForm [name="client_email"]');
      if (el) el.value = prefill.client_email;
    }
    if (prefill.duration_minutes) {
      const el = document.querySelector('#visitForm [name="duration_minutes"]');
      if (el) el.value = prefill.duration_minutes;
    }
    if (prefill.agent_id) {
      const el = document.querySelector('#visitForm [name="agent_id"]');
      if (el) el.value = prefill.agent_id;
    }
    if (prefill.property_id) {
      loadPropertySelect($('#visitPropertySelect'), prefill.property_id);
    } else {
      loadPropertySelect($('#visitPropertySelect'));
    }


    openModal('visitModal');
  };

  let _submittingVisit = false;

  function initVisitDateFields() {
    ['visitDateDay', 'visitDateTime'].forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.dataset.bound) { el.dataset.bound = '1'; el.addEventListener('change', syncVisitDateHidden); }
    });
  }

  function setVisitDateParts(d) {
    const dateEl = $('#visitDateDay');
    const timeEl = $('#visitDateTime');
    if (dateEl) dateEl.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (timeEl) timeEl.value = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    syncVisitDateHidden();
  }

  function syncVisitDateHidden() {
    const hidden = $('#visitForm') ? $('#visitForm').elements['visit_date'] : null;
    if (!hidden) return;
    const day = $('#visitDateDay')?.value;
    const time = $('#visitDateTime')?.value;
    hidden.value = (day && time) ? (day + 'T' + time) : '';
  }

  initVisitDateFields();

  /* Chips de duración: 1 click fija el campo */
  document.querySelectorAll('.visit-dur-chip').forEach(btn => {
    btn.addEventListener('click', function () {
      const input = $('#visitForm')?.elements['duration_minutes'];
      if (input) input.value = this.dataset.min;
      document.querySelectorAll('.visit-dur-chip').forEach(b => b.classList.toggle('is-active', b === this));
    });
  });

  /* Huecos del broker: al elegir broker+fecha, listar su agenda de ese día */
  async function refreshBrokerSlots() {
    const wrap = $('#visitSlotsWrap');
    const hint = $('#visitSlotsHint');
    if (!wrap || !hint) return;
    const agentId = $('#visitBrokerSelect')?.value;
    const dateVal = $('#visitDateDay')?.value;
    if (!agentId || !dateVal || !window.supabaseClient) { wrap.style.display = 'none'; return; }
    try {
      const dayStart = new Date(dateVal + 'T00:00:00');
      const dayEnd = new Date(dateVal + 'T23:59:59');
      const { data } = await window.supabaseClient.from('visits')
        .select('id, client_name, visit_date, duration_minutes')
        .eq('agent_id', agentId)
        .is('deleted_at', null)
        .in('status', ['pendiente', 'confirmada'])
        .gte('visit_date', dayStart.toISOString())
        .lte('visit_date', dayEnd.toISOString())
        .order('visit_date', { ascending: true });
      const busy = (data || []).filter(v => v.id !== editingVisitId);
      wrap.style.display = 'block';
      if (!busy.length) {
        hint.innerHTML = '<span style="color:var(--success);">✔ Broker libre todo el día.</span>';
        return;
      }
      const lines = busy.map(v => {
        const t = new Date(v.visit_date);
        const end = new Date(t.getTime() + (v.duration_minutes || 60) * 60000);
        const fmt = d => d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        return `<div>⏰ ${fmt(t)}–${fmt(end)} — ${esc(v.client_name || 'Visitante')}</div>`;
      }).join('');
      hint.innerHTML = '<strong style="color:var(--warning);">Ocupado:</strong>' + lines;
    } catch (_) { wrap.style.display = 'none'; }
  }
  $('#visitBrokerSelect')?.addEventListener('change', refreshBrokerSlots);
  $('#visitDateDay')?.addEventListener('change', refreshBrokerSlots);

  /* Google Calendar: link de "agregar evento" con los datos del modal */
  $('#visitGCalBtn')?.addEventListener('click', function () {
    const form = $('#visitForm');
    if (!form) return;
    const hidden = form.elements['visit_date'];
    syncVisitDateHidden();
    const raw = hidden && hidden.value;
    if (!raw) { showToast('Elegí fecha y hora primero.', 'warning'); return; }
    const start = new Date(raw);
    const durMin = parseInt(form.elements['duration_minutes']?.value || '60', 10) || 60;
    const end = new Date(start.getTime() + durMin * 60000);
    const fmtG = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const propSel = $('#visitPropertySelect');
    const propText = propSel && propSel.selectedIndex > 0 ? propSel.options[propSel.selectedIndex].text : '';
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: 'Visita: ' + (form.elements['client_name']?.value || 'Cliente'),
      details: (propText ? 'Propiedad: ' + propText + '\n' : '') + (form.elements['notes']?.value || ''),
      dates: fmtG(start) + '/' + fmtG(end),
    });
    window.open('https://calendar.google.com/calendar/render?' + params.toString(), '_blank', 'noopener');
  });

  /* Aviso si la visita está en el pasado */
  $('#visitForm')?.addEventListener('submit', function (e) {
    syncVisitDateHidden();
    const raw = e.target.elements['visit_date']?.value;
    if (raw && new Date(raw).getTime() < Date.now() - 60000) {
      if (!confirm('La visita está en el pasado. ¿Guardar igual?')) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
  }, true);

  on($('#visitForm'), 'submit', async (e) => {
    e.preventDefault();
    if (_submittingVisit) return;
    _submittingVisit = true;
    const btn = $('#visitSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const oldVisit = editingVisitId
        ? (await window.supabaseClient.from('visits').select('status, lead_id').eq('id', editingVisitId).single()).data
        : null;
      const oldStatus = oldVisit?.status ?? null;
      const oldLeadId = oldVisit?.lead_id ?? null;

      const formData = new FormData(e.target);
      
      // Zod validation
      const validated = validateForm(VisitSchema, formData);
      const data = {
        visit_date: validated.visit_date,
        status: validated.status,
        client_name: validated.client_name,
        client_phone: validated.client_phone,
        client_email: validated.client_email,
        notes: validated.notes,
        lead_id: validated.lead_id ?? null,
        property_id: validated.property_id,
        agent_id: validated.agent_id,
        duration_minutes: validated.duration_minutes,
      };

      /* Conflict detection: mismo broker O misma propiedad, horarios solapados */
      if ((data.agent_id || data.property_id) && data.visit_date && data.duration_minutes) {
        const visitStart = new Date(data.visit_date).getTime();
        const visitEnd = visitStart + data.duration_minutes * 60 * 1000;
        let cq = window.supabaseClient
          .from('visits')
          .select('id, client_name, visit_date, duration_minutes, agent_id, property_id')
          .in('status', ['pendiente', 'confirmada', 'en_curso'])
          .is('deleted_at', null)
          .neq('id', editingVisitId || '00000000-0000-0000-0000-000000000000');
        const parts = [];
        if (data.agent_id) parts.push('agent_id.eq.' + data.agent_id);
        if (data.property_id) parts.push('property_id.eq.' + data.property_id);
        cq = cq.or(parts.join(','));
        const { data: probConflicts } = await cq;
        const conflict = (probConflicts || []).find(c => {
          const cStart = new Date(c.visit_date).getTime();
          const cEnd = cStart + (c.duration_minutes || 60) * 60 * 1000;
          return visitStart < cEnd && visitEnd > cStart;
        });
        if (conflict) {
          const motivo = data.agent_id && conflict.agent_id === data.agent_id
            ? `el broker ya tiene una visita (${conflict.client_name || 'otra'})`
            : 'la propiedad ya tiene una visita';
          showToast(`Conflicto de agenda: ${motivo} en ese horario`, 'warning', 6000);
          const box = $('#visitConflictBox');
          if (box) {
            const cStart = new Date(conflict.visit_date);
            box.innerHTML = '⚠ ' + esc(motivo) + ' el ' + cStart.toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) +
              ' <button type="button" class="btn-action" style="margin-left:8px; padding:4px 10px; font-size:11px;" id="visitConflictOpen">Ver</button>';
            box.style.display = 'block';
            box.querySelector('#visitConflictOpen').onclick = (ev) => {
              ev.preventDefault();
              closeModal('visitModal');
              window.adminApp.editVisit(conflict.id);
            };
          }
          return;
        }
      }

      const newStatus = data.status;
      const newLeadId = data.lead_id;
      const leadIdChanged = oldLeadId !== newLeadId;

      if (editingVisitId) {
        await mutate('visits', async () => {
          const { error } = await window.supabaseClient.from('visits').update(data).eq('id', editingVisitId);
          if (error) throw error;
        });
        showToast('Visita actualizada', 'success');
      } else {
        /* Generate confirmation_token for new visit */
        const confirmation_token = crypto.randomUUID();
        const insertData = { ...data, confirmation_token };
        let inserted = null;
        await mutate('visits', async () => {
          const { data: insertedData, error } = await window.supabaseClient.from('visits').insert([insertData]).select('id').single();
          if (error) throw error;
          inserted = insertedData;
        });
        showToast('Visita agendada', 'success');
        if (inserted?.id && data.lead_id) {
          try {
            await window.supabaseClient.from('lead_activities').insert([{
              lead_id: data.lead_id,
              activity_type: 'note',
              title: 'Visita agendada desde el panel',
              description: new Date(data.visit_date).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
            }]);
          } catch (_) {}
        }
        /* Link de confirmación: siempre se copia; con email avisa, con teléfono ofrece WhatsApp */
        if (inserted?.id) {
          const confirmUrl = `${window.location.origin}/confirmar-visita.html?token=${confirmation_token}`;
          navigator.clipboard.writeText(confirmUrl).catch(() => {});
          const waPhone = (window.BH_CRM && window.BH_CRM.waNumber && window.BH_CRM.waNumber(data.client_phone)) || null;
          if (waPhone) {
            const wa = `https://wa.me/${waPhone}?text=` + encodeURIComponent(`Hola ${data.client_name}, te comparto el link para confirmar tu visita: ${confirmUrl}`);
            showToast('Link copiado. Abrir WhatsApp al cliente…', 'info', 6000);
            window.open(wa, '_blank', 'noopener');
          } else {
            showToast(`Link de confirmación copiado al portapapeles`, 'info', 8000);
          }
        }
      }

      /* Prompt: visita completada ? mover lead a Oferta */
      if (newStatus === 'completada' && oldStatus !== 'completada' && newLeadId) {
        try {
          const { data: leadData } = await window.supabaseClient
            .from('leads')
            .select('stage')
            .eq('id', newLeadId)
            .single();
          if (leadData && leadData.stage === 'visita_agendada') {
            const confirmMove = confirm('¿Mover el lead a "Negociación"?');
            if (confirmMove) {
              await window.supabaseClient
                .from('leads')
                .update({ stage: 'negociacion', updated_at: new Date().toISOString() })
                .eq('id', newLeadId);
              showToast('Lead movido a Negociación', 'success');
            }
          }
        } catch (_) {}
      }

      /* Si se asignó lead_id nuevo (era NULL) ? el trigger DB actualizará lead a "visita" */
      /* Si se quitó lead_id (era valor ? NULL) ? no hacemos nada en lead */

      closeModal('visitModal');
      loadAgenda();
      loadCRM(); // Refrescar CRM por si cambió stage
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      _submittingVisit = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Confirmar Cita'; }
    }
  });

  /* Extraido a assets/js/admin-supervision-panel.js (modularizacion) */

/* Edit visit */
  window.adminApp.copyVisitLink = async function (id) {
  try {
    const { data, error } = await window.supabaseClient
      .from('visits').select('confirmation_token, client_email').eq('id', id).single();
    if (error) throw error;
    if (!data?.confirmation_token) { showToast('Esta visita no tiene link de confirmación.', 'error'); return; }
    const url = `${window.location.origin}/confirmar-visita.html?token=${data.confirmation_token}`;
    try { await navigator.clipboard.writeText(url); showToast('Link copiado: ' + url, 'success', 6000); }
    catch (_) { window.prompt('Copiá este link:', url); }
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
};

window.adminApp.editVisit = async function (id) {
    try {
      const { data, error } = await window.supabaseClient
        .from('visits')
        .select('*, leads!left(id, full_name, stage, phone, whatsapp, property_id)')
        .eq('id', id)
        .single();
      if (error) throw error;

      editingVisitId = id;
      const form = $('#visitForm');
      const lead = data.leads;
      const copyBtn = $('#visitCopyLinkBtn');
      if (copyBtn) {
        copyBtn.style.display = data.confirmation_token ? 'inline-flex' : 'none';
        copyBtn.onclick = (e) => { e.preventDefault(); window.adminApp.copyVisitLink(id); };
      }

      if (form) {
        /* Cargar brokers en dropdown existente */
        await loadAgentSelect($('#visitBrokerSelect'), data.agent_id);
        await loadPropertySelect($('#visitPropertySelect'), data.property_id);

        if (data.visit_date) {
          const d = new Date(data.visit_date);
          setVisitDateParts(d);
        }
        form.elements.status.value = data.status || 'pendiente';
        form.elements.client_name.value = data.client_name || '';
        form.elements.client_phone.value = data.client_phone || '';
        form.elements.client_email.value = data.client_email || '';
        form.elements.duration_minutes.value = data.duration_minutes || 60;
        form.elements.agent_id.value = data.agent_id || '';
        form.elements.notes.value = data.notes || '';

        /* Selector de lead (estático en el modal) con auto-relleno */
        const leadSelect = $('#visitLeadSelectEl');
        await loadVisitLeadSelect(data.lead_id || null);

        if (leadSelect && !leadSelect.dataset.autofillBound) {
          leadSelect.dataset.autofillBound = '1';
          leadSelect.addEventListener('change', async (e) => {
            const selectedId = e.target.value;
            loadLeadContextForVisit(selectedId || null);
            if (!selectedId) return;
            try {
              const { data: leadData } = await window.supabaseClient
                .from('leads')
                .select('full_name, stage, phone, whatsapp, property_id')
                .eq('id', selectedId)
                .single();
              if (leadData) {
                if (!form.elements.client_name.value) form.elements.client_name.value = leadData.full_name || '';
                if (!form.elements.client_phone.value) form.elements.client_phone.value = leadData.phone || leadData.whatsapp || '';
                if (leadData.property_id && !form.elements.property_id.value) {
                  await loadPropertySelect($('#visitPropertySelect'), leadData.property_id);
                }
              }
            } catch (_) {}
          });
        }
        if (data.lead_id) { leadSelect.dispatchEvent(new Event('change')); }
      }

      openModal('visitModal');
    } catch (err) {
      logError('Error al cargar visita:', err);
      showToast('Error al cargar visita', 'error');
    }
  };

  /* Delete visit */
  window.adminApp.deleteVisit = async function (id) {
    if (!confirm('¿Eliminar esta visita? Queda en baja lógica (recuperable desde la DB).')) return;
    try {
      const { error } = await window.supabaseClient.from('visits').update({ deleted_at: new Date().toISOString(), status: 'cancelada' }).eq('id', id);
      if (error) throw error;
      showToast('Visita eliminada (baja lógica)', 'success');
      loadAgenda();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  /* Check-in / Check-out */
  window.adminApp.checkinVisit = async function (id) {
    try {
      const { error } = await window.supabaseClient
        .from('visits')
        .update({ check_in: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      showToast('Llegada registrada', 'success');
      loadAgenda();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.adminApp.checkoutVisit = async function (id) {
    try {
      const { error } = await window.supabaseClient
        .from('visits')
        .update({ check_out: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      showToast('Salida registrada', 'success');
      loadAgenda();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  /* Export ICS / CSV */
  function generateICS(visits) {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//BIENENHAUS//Agenda de Visitas//ES',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH'
    ];
    visits.forEach(v => {
      const dtStart = new Date(v.visit_date).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const dtEnd = new Date(new Date(v.visit_date).getTime() + (v.duration_minutes || 60) * 60 * 1000)
        .toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const uid = v.id + '@bienenhaus.com.ar';
      const summary = 'Visita: ' + (v.client_name || 'Sin cliente');
      const description = [
        'Cliente: ' + (v.client_name || 'Sin cliente'),
        'Teléfono: ' + (v.client_phone || '—'),
        'Email: ' + (v.client_email || '—'),
        'Broker: ' + (v.agents?.full_name || 'Por asignar'),
        'Estado: ' + (v.status || 'pendiente'),
        v.notes ? 'Notas: ' + v.notes : ''
      ].filter(Boolean).join('\\n');
      const location = v.property_id ? 'Propiedad asignada' : 'Por confirmar';
      lines.push(
        'BEGIN:VEVENT',
        'UID:' + uid,
        'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z',
        'DTSTART:' + dtStart,
        'DTEND:' + dtEnd,
        'SUMMARY:' + summary,
        'DESCRIPTION:' + description,
        'LOCATION:' + location,
        'STATUS:' + (v.status === 'confirmada' ? 'CONFIRMED' : v.status === 'cancelada' ? 'CANCELLED' : 'TENTATIVE'),
        'END:VEVENT'
      );
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  function generateCSV(visits) {
    const headers = ['Fecha', 'Hora', 'Cliente', 'Teléfono', 'Email', 'Broker', 'Estado', 'Propiedad', 'Lead', 'Notas', 'Check-in', 'Check-out'];
    const rows = visits.map(v => {
      const d = v.visit_date ? new Date(v.visit_date) : null;
      const fecha = d ? d.toLocaleDateString('es-AR') : '';
      const hora = d ? d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
      const checkin = v.check_in ? new Date(v.check_in).toLocaleTimeString('es-AR') : '';
      const checkout = v.check_out ? new Date(v.check_out).toLocaleTimeString('es-AR') : '';
      return [
        fecha,
        hora,
        v.client_name || '',
        v.client_phone || '',
        v.client_email || '',
        v.agents?.full_name || '',
        v.status || '',
        v.property_id ? 'Sí' : 'No',
        v.leads?.full_name || '',
        (v.notes || '').replace(/\n/g, ' '),
        checkin,
        checkout
      ].map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',');
    });
    return [headers.join(','), ...rows].join('\n');
  }

  window.adminApp.exportVisitsICS = async function() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('visits')
        .select('*, agents(full_name), leads(full_name)')
        .order('visit_date', { ascending: true });
      if (error) throw error;
      const ics = generateICS(data || []);
      const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'agenda-visitas-' + new Date().toISOString().slice(0,10) + '.ics';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Archivo .ics descargado', 'success');
    } catch (err) {
      showToast('Error exportando ICS: ' + err.message, 'error');
    }
  };

  window.adminApp.exportVisitsCSV = async function() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('visits')
        .select('*, agents(full_name), leads(full_name)')
        .order('visit_date', { ascending: true });
      if (error) throw error;
      const csv = generateCSV(data || []);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'agenda-visitas-' + new Date().toISOString().slice(0,10) + '.csv';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Archivo .csv descargado', 'success');
    } catch (err) {
      showToast('Error exportando CSV: ' + err.message, 'error');
    }
  };

  /* Event listeners for export buttons */
  $('#btnExportICS')?.addEventListener('click', window.adminApp.exportVisitsICS);
  $('#btnExportCSV')?.addEventListener('click', window.adminApp.exportVisitsCSV);


  window.__BH.loadAgenda = loadAgenda;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadAgenda')) Object.defineProperty(window, 'loadAgenda', { get: () => loadAgenda, set: (v) => { loadAgenda = v; }, configurable: true });
  window.__BH.upsertVisitRow = upsertVisitRow;
  if (!Object.prototype.hasOwnProperty.call(window, 'upsertVisitRow')) Object.defineProperty(window, 'upsertVisitRow', { get: () => upsertVisitRow, set: (v) => { upsertVisitRow = v; }, configurable: true });
  window.__BH.removeVisitRow = removeVisitRow;
  if (!Object.prototype.hasOwnProperty.call(window, 'removeVisitRow')) Object.defineProperty(window, 'removeVisitRow', { get: () => removeVisitRow, set: (v) => { removeVisitRow = v; }, configurable: true });
  window.__BH.upsertLeadCard = upsertLeadCard;
  if (!Object.prototype.hasOwnProperty.call(window, 'upsertLeadCard')) Object.defineProperty(window, 'upsertLeadCard', { get: () => upsertLeadCard, set: (v) => { upsertLeadCard = v; }, configurable: true });
  window.__BH.removeLeadCard = removeLeadCard;
  if (!Object.prototype.hasOwnProperty.call(window, 'removeLeadCard')) Object.defineProperty(window, 'removeLeadCard', { get: () => removeLeadCard, set: (v) => { removeLeadCard = v; }, configurable: true });
  window.__BH.populateBrokerFilters = populateBrokerFilters;
  if (!Object.prototype.hasOwnProperty.call(window, 'populateBrokerFilters')) Object.defineProperty(window, 'populateBrokerFilters', { get: () => populateBrokerFilters, set: (v) => { populateBrokerFilters = v; }, configurable: true });
  window.__BH.upsertPropertyRow = upsertPropertyRow;
  if (!Object.prototype.hasOwnProperty.call(window, 'upsertPropertyRow')) Object.defineProperty(window, 'upsertPropertyRow', { get: () => upsertPropertyRow, set: (v) => { upsertPropertyRow = v; }, configurable: true });
  window.__BH.removePropertyRow = removePropertyRow;
  if (!Object.prototype.hasOwnProperty.call(window, 'removePropertyRow')) Object.defineProperty(window, 'removePropertyRow', { get: () => removePropertyRow, set: (v) => { removePropertyRow = v; }, configurable: true });
  window.__BH.upsertAgentRow = upsertAgentRow;
  if (!Object.prototype.hasOwnProperty.call(window, 'upsertAgentRow')) Object.defineProperty(window, 'upsertAgentRow', { get: () => upsertAgentRow, set: (v) => { upsertAgentRow = v; }, configurable: true });
  window.__BH.removeAgentRow = removeAgentRow;
  if (!Object.prototype.hasOwnProperty.call(window, 'removeAgentRow')) Object.defineProperty(window, 'removeAgentRow', { get: () => removeAgentRow, set: (v) => { removeAgentRow = v; }, configurable: true });
  window.__BH.upsertOwnerRow = upsertOwnerRow;
  if (!Object.prototype.hasOwnProperty.call(window, 'upsertOwnerRow')) Object.defineProperty(window, 'upsertOwnerRow', { get: () => upsertOwnerRow, set: (v) => { upsertOwnerRow = v; }, configurable: true });
  window.__BH.removeOwnerRow = removeOwnerRow;
  if (!Object.prototype.hasOwnProperty.call(window, 'removeOwnerRow')) Object.defineProperty(window, 'removeOwnerRow', { get: () => removeOwnerRow, set: (v) => { removeOwnerRow = v; }, configurable: true });
  window.__BH.upsertTasacionRow = upsertTasacionRow;
  if (!Object.prototype.hasOwnProperty.call(window, 'upsertTasacionRow')) Object.defineProperty(window, 'upsertTasacionRow', { get: () => upsertTasacionRow, set: (v) => { upsertTasacionRow = v; }, configurable: true });
  window.__BH.removeTasacionRow = removeTasacionRow;
  if (!Object.prototype.hasOwnProperty.call(window, 'removeTasacionRow')) Object.defineProperty(window, 'removeTasacionRow', { get: () => removeTasacionRow, set: (v) => { removeTasacionRow = v; }, configurable: true });
})();
