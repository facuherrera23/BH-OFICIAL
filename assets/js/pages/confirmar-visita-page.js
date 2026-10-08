    (async function() {
      const token = new URLSearchParams(window.location.search).get('token');
      if (!token) {
        showError('Token inválido');
        return;
      }

      if (!window.BH_CONFIG?.SUPABASE_URL || !window.BH_CONFIG?.SUPABASE_ANON_KEY) {
        showError('Configuración no disponible');
        return;
      }

      const { createClient } = supabase;
      const supabaseClient = createClient(window.BH_CONFIG.SUPABASE_URL, window.BH_CONFIG.SUPABASE_ANON_KEY);

      try {
        const { data, error } = await supabaseClient
          .rpc('get_visit_by_token', { p_token: token });

        if (error || !data) {
          showError('Visita no encontrada o enlace expirado');
          return;
        }

        renderVisit(data);
        maybeRenderSurvey(data);

      } catch (err) {
        console.error(err);
        showError('Error al cargar la visita');
      }

      function renderVisit(v) {
        const icon = document.getElementById('confirmIcon');
        const title = document.getElementById('confirmTitle');
        const subtitle = document.getElementById('confirmSubtitle');
        const badge = document.getElementById('statusBadge');
        const details = document.getElementById('visitDetails');
        const actions = document.getElementById('actionButtons');
        const btnConfirm = document.getElementById('btnConfirm');
        const btnCancel = document.getElementById('btnCancel');
        const btnWhatsApp = document.getElementById('btnWhatsApp');

        // Status styling
        const statusMap = {
          pendiente: { icon: 'fa-clock', class: 'pending', label: 'Pendiente', badge: 'status-pendiente' },
          confirmada: { icon: 'fa-check-circle', class: 'success', label: 'Confirmada', badge: 'status-confirmada' },
          en_curso: { icon: 'fa-door-open', class: 'success', label: 'En curso', badge: 'status-confirmada' },
          completada: { icon: 'fa-flag-checkered', class: 'success', label: 'Completada', badge: 'status-completada' },
          no_show: { icon: 'fa-user-xmark', class: 'danger', label: 'No asistió', badge: 'status-cancelada' },
          cancelada: { icon: 'fa-times-circle', class: 'danger', label: 'Cancelada', badge: 'status-cancelada' }
        };
        const isCheckinMode = new URLSearchParams(window.location.search).get('mode') === 'checkin';
        const s = statusMap[v.status] || statusMap.pendiente;
        icon.className = 'confirm-icon ' + s.class;
        icon.innerHTML = '<i class="fas ' + s.icon + '"></i>';
        badge.className = 'status-badge ' + s.badge;
        badge.textContent = s.label;

        if (isCheckinMode) {
          if (v.status === 'cancelada' || v.status === 'completada' || v.status === 'no_show') {
            title.textContent = 'Visita cerrada';
            subtitle.textContent = 'Esta visita ya fue cancelada o completada.';
            actions.style.display = 'none';
          } else {
            title.textContent = 'Registrar llegada';
            subtitle.textContent = v.status === 'en_curso' ? 'La llegada ya fue registrada. ¡Éxitos con la visita!' : 'Tocá el botón al llegar a la propiedad.';
            actions.style.display = 'flex';
            btnConfirm.innerHTML = '<i class="fas fa-location-dot"></i> Registrar mi llegada';
            btnConfirm.onclick = async () => {
              btnConfirm.disabled = true;
              btnConfirm.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Registrando...';
              try {
                const { data, error } = await supabaseClient
                  .rpc('update_visit_status_by_token', { p_token: token, p_action: 'checkin' });
                if (error) throw error;
                if (!data?.ok) throw new Error(data?.error || 'No se pudo registrar la llegada');
                title.textContent = '¡Llegada registrada!';
                subtitle.textContent = 'El horario de inicio quedó guardado.';
                actions.style.display = 'none';
                badge.className = 'status-badge status-confirmada';
                badge.textContent = 'En curso';
              } catch (err) {
                showToast('Error: ' + err.message, 'error');
                btnConfirm.disabled = false;
                btnConfirm.innerHTML = '<i class="fas fa-location-dot"></i> Registrar mi llegada';
              }
            };
            btnCancel.style.display = 'none';
          }
          document.getElementById('detailClient').textContent = v.client_name || '—';
          document.getElementById('detailDate').textContent = v.visit_date
            ? new Date(v.visit_date).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
            : '—';
          document.getElementById('detailDuration').textContent = v.duration_minutes ? v.duration_minutes + ' min' : '60 min';
          document.getElementById('detailBroker').textContent = v.agents?.full_name || 'Por asignar';
          if (v.property && v.property.title) {
            const prow2 = document.getElementById('detailPropertyRow');
            const pel2 = document.getElementById('detailProperty');
            if (pel2) pel2.textContent = v.property.title + (v.property.address ? ' (' + v.property.address + ')' : '');
            if (prow2) prow2.style.display = '';
          }
          document.getElementById('detailNotes').textContent = v.notes || '—';
          document.getElementById('visitDetails').style.display = 'block';
          const btnWa2 = document.getElementById('btnWhatsApp');
          if (btnWa2) btnWa2.style.display = 'none';
          return;
        }

        if (v.status === 'confirmada' || v.status === 'completada' || v.status === 'en_curso') {
          title.textContent = 'Visita Confirmada ✓';
          subtitle.textContent = 'Tu visita está confirmada. Te esperamos.';
          actions.style.display = 'none';
        } else if (v.status === 'cancelada' || v.status === 'no_show') {
          title.textContent = 'Visita Cancelada';
          subtitle.textContent = 'Esta visita ha sido cancelada.';
          actions.style.display = 'none';
        } else {
          title.textContent = 'Confirmar tu Visita';
          subtitle.textContent = 'Por favor confirma o cancela tu asistencia.';
          actions.style.display = 'flex';
        }

        // Fill details
        document.getElementById('detailClient').textContent = v.client_name || '—';
        document.getElementById('detailDate').textContent = v.visit_date
          ? new Date(v.visit_date).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
          : '—';
        document.getElementById('detailDuration').textContent = v.duration_minutes ? v.duration_minutes + ' min' : '60 min';
        document.getElementById('detailBroker').textContent = v.agents?.full_name || 'Por asignar';
        if (v.property && v.property.title) {
          const prow = document.getElementById('detailPropertyRow');
          const pel = document.getElementById('detailProperty');
          if (pel) pel.textContent = v.property.title + (v.property.zone ? ' · ' + v.property.zone : '') + (v.property.address ? ' (' + v.property.address + ')' : '');
          if (prow) prow.style.display = '';
        }
        document.getElementById('detailNotes').textContent = v.notes || '—';
        details.style.display = 'block';

        // WhatsApp al agente/casa central (nunca al propio cliente que ya abrió el link)
        const waPhone = (v.agents && v.agents.phone) || v.broker_phone || null;
        if (waPhone) {
          const msg = encodeURIComponent(`Hola, te escribo por la visita del ${new Date(v.visit_date).toLocaleDateString('es-AR')} a las ${new Date(v.visit_date).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}.`);
          btnWhatsApp.href = `https://wa.me/${String(waPhone).replace(/\D/g, '')}?text=${msg}`;
        } else {
          btnWhatsApp.style.display = 'none';
        }

        // Confirm action
        btnConfirm.onclick = async () => {
          btnConfirm.disabled = true;
          btnConfirm.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Confirmando...';
          try {
            const { data, error } = await supabaseClient
              .rpc('update_visit_status_by_token', { p_token: token, p_action: 'confirmar' });
            if (error) throw error;
            if (!data?.ok) throw new Error(data?.error || 'No se pudo confirmar la visita');
            showToast('Visita confirmada correctamente', 'success');
            setTimeout(() => window.location.reload(), 1500);
          } catch (err) {
            showToast('Error: ' + err.message, 'error');
            btnConfirm.disabled = false;
            btnConfirm.innerHTML = '<i class="fas fa-check"></i> Confirmar Visita';
          }
        };

        // Cancel action
        btnCancel.onclick = async () => {
          const reason = prompt('Contanos por qué cancelás (opcional):');
          if (reason === null) return;
          if (!confirm('¿Cancelar esta visita?')) return;
          btnCancel.disabled = true;
          btnCancel.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cancelando...';
          try {
            const { data, error } = await supabaseClient
              .rpc('update_visit_status_by_token', { p_token: token, p_action: 'cancelar', p_reason: reason.trim() || null });
            if (error) throw error;
            if (!data?.ok) throw new Error(data?.error || 'No se pudo cancelar la visita');
            showToast('Visita cancelada', 'success');
            setTimeout(() => window.location.reload(), 1500);
          } catch (err) {
            showToast('Error: ' + err.message, 'error');
            btnCancel.disabled = false;
            btnCancel.innerHTML = '<i class="fas fa-times"></i> Cancelar';
          }
        };
      }

      /* ── Encuesta HOJA DE VISITA (digitalización del formulario, pedido 2026-10-08) ──
       Vive en este mismo link: aparece cuando la visita está completada (o pasó su fecha).
       Autoguardado continuo: si el visitante se va sin tocar Guardar, lo respondido queda igual. */
    const SURVEY_SCORES = [
      ['ubicacion', 'Ubicación'],
      ['tamano', 'Tamaño'],
      ['distribucion', 'Distribución'],
      ['calidad', 'Calidad'],
      ['precio', 'Precio'],
      ['conservacion', 'Conservación'],
      ['general', 'Valoración general']
    ];
    const SURVEY_TEXTS = [
      ['mas_gusto', '¿Qué fue lo que MÁS te gustó de la propiedad?'],
      ['menos_gusto', '¿Qué fue lo que MENOS te gustó de la propiedad?'],
      ['por_que', 'Si querés, contanos por qué (o por qué no) la comprarías']
    ];

    async function maybeRenderSurvey(v) {
      const section = document.getElementById('surveySection');
      if (!section) return;
      if (new URLSearchParams(window.location.search).get('mode') === 'checkin') return;
      let st = null;
      try {
        const { data, error } = await supabaseClient.rpc('get_visit_survey_by_token', { p_token: token });
        if (error) throw error;
        st = data;
      } catch (err) { console.error(err); return; }
      if (!st || !st.available) return;
      if (st.survey && st.survey.finalized) { renderSurveyThanks(st.survey.answers || {}); return; }
      renderSurveyForm(st.survey ? (st.survey.answers || {}) : {}, v);
    }

    let sqAnswers = {};
    let sqSaveTimer = null;
    let sqSaving = false;
    let sqPendingFinal = false;
    let sqDirty = false;

    function sqScheduleSave() {
      sqDirty = true;
      clearTimeout(sqSaveTimer);
      sqSaveTimer = setTimeout(() => sqSave(false), 700);
    }

    function sqSetAutosave(msg) {
      const el = document.getElementById('sqAutosave');
      if (el) el.textContent = msg;
    }

    async function sqSave(finalize) {
      if (sqSaving) { if (finalize) sqPendingFinal = true; return; }
      sqSaving = true;
      sqSetAutosave('Guardando…');
      try {
        const { data, error } = await supabaseClient.rpc('submit_visit_survey_by_token', {
          p_token: token, p_answers: sqAnswers, p_finalize: finalize
        });
        if (error) throw error;
        if (data && data.ok === false) {
          if (data.finalized) { sqDirty = false; renderSurveyThanks(sqAnswers); return; }
          throw new Error(data.error || 'No se pudo guardar');
        }
        sqDirty = false;
        sqSetAutosave('✓ Guardado');
        if (finalize) { renderSurveyThanks(sqAnswers); return; }
      } catch (err) {
        console.error(err);
        sqSetAutosave('⚠ Sin conexión — se guarda apenas toqués algo');
        window.addEventListener('online', function retry() {
          window.removeEventListener('online', retry);
          if (sqDirty) sqSave(false);
        });
      } finally {
        sqSaving = false;
        if (sqPendingFinal) { sqPendingFinal = false; sqSave(true); }
      }
    }

    /* Si cierra la pestaña a mitad, lo último escrito igual llega al server */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && sqDirty && !sqSaving) sqSave(false);
    });

    function sqPillsRow(key, label, isWide) {
      let pills = '';
      if (isWide) {
        pills = '<button type="button" class="sq-pill pill-wide pill-si" data-key="' + key + '" data-val="si">Sí, la compraría</button>' +
                '<button type="button" class="sq-pill pill-wide pill-no" data-key="' + key + '" data-val="no">No</button>';
      } else {
        for (let n = 1; n <= 10; n++) {
          pills += '<button type="button" class="sq-pill" data-key="' + key + '" data-val="' + n + '">' + n + '</button>';
        }
      }
      return '<div class="survey-q"><span class="sq-label">' + label + '</span><div class="sq-pills" data-row="' + key + '">' + pills + '</div></div>';
    }

    function sqTextRow(key, label) {
      return '<div class="survey-q"><span class="sq-label">' + label + '</span>' +
        '<textarea class="sq-text" data-text="' + key + '" maxlength="1000"></textarea></div>';
    }

    function sqMarkActive() {
      document.querySelectorAll('#surveySection .sq-pill').forEach(p => {
        const val = sqAnswers[p.dataset.key];
        p.classList.toggle('is-active', String(val) === p.dataset.val);
      });
    }

    function renderSurveyForm(saved, v) {
      sqAnswers = {};
      Object.keys(saved).forEach(k => { if (saved[k] !== null && saved[k] !== '') sqAnswers[k] = saved[k]; });

      const card = document.getElementById('confirmCard');
      const icon = document.getElementById('confirmIcon');
      const title = document.getElementById('confirmTitle');
      const subtitle = document.getElementById('confirmSubtitle');
      const actions = document.getElementById('actionButtons');
      const section = document.getElementById('surveySection');
      if (!card || !section) return;

      card.classList.add('survey-mode');
      icon.className = 'confirm-icon pending';
      icon.innerHTML = '<i class="fas fa-star"></i>';
      title.textContent = 'Hola' + (v.client_name ? ' ' + v.client_name.trim().split(' ')[0] : '') + '! ¿Cómo estuvo tu visita?';
      subtitle.textContent = 'Esta evaluación nos ayuda a mejorar y brindar un mejor servicio.';
      if (actions) actions.style.display = 'none';

      let html = '<div class="survey-welcome">Puntuá de 1 a 10 — tardás menos de un minuto.</div>';
      SURVEY_SCORES.forEach(([key, label], i) => {
        html += sqPillsRow(key, (i + 1) + '. ' + label, false);
      });
      html += sqPillsRow('compraria', (SURVEY_SCORES.length + 1) + '. ¿Compraría este inmueble?', true);
      SURVEY_TEXTS.forEach(([key, label]) => { html += sqTextRow(key, label); });
      html += '<div class="sq-autosave" id="sqAutosave"></div>' +
        '<button type="button" class="btn-luxury-action btn-confirm" id="btnSaveSurvey"><i class="fas fa-check"></i> Guardar</button>';
      section.innerHTML = html;
      section.style.display = 'block';

      document.querySelectorAll('#surveySection .sq-pill').forEach(p => {
        p.addEventListener('click', () => {
          sqAnswers[p.dataset.key] = p.dataset.val;
          sqMarkActive();
          sqScheduleSave();
        });
      });
      document.querySelectorAll('#surveySection .sq-text').forEach(t => {
        if (sqAnswers[t.dataset.text]) t.value = sqAnswers[t.dataset.text];
        let tt = null;
        t.addEventListener('input', () => {
          sqAnswers[t.dataset.text] = t.value;
          clearTimeout(tt);
          tt = setTimeout(sqScheduleSave, 400);
        });
      });
      sqMarkActive();

      document.getElementById('btnSaveSurvey').addEventListener('click', function () {
        this.disabled = true;
        this.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando…';
        sqSave(true);
      });
    }

    function renderSurveyThanks(answers) {
      const card = document.getElementById('confirmCard');
      const icon = document.getElementById('confirmIcon');
      const title = document.getElementById('confirmTitle');
      const subtitle = document.getElementById('confirmSubtitle');
      const section = document.getElementById('surveySection');
      const thanks = document.getElementById('surveyThanks');
      if (!card || !thanks) return;

      card.classList.add('survey-mode');
      icon.className = 'confirm-icon success';
      icon.innerHTML = '<i class="fas fa-check-circle"></i>';
      title.textContent = '¡Gracias por responder!';
      subtitle.textContent = 'Tu evaluación de la visita ya quedó registrada.';
      if (section) section.style.display = 'none';
      sqDirty = false;

      let grid = '';
      SURVEY_SCORES.forEach(([key, label]) => {
        if (answers[key] !== undefined && answers[key] !== null) {
          grid += '<div class="t-score"><div class="ts-v">' + answers[key] + '</div><div class="ts-l">' + label + '</div></div>';
        }
      });
      if (answers.compraria) {
        grid += '<div class="t-score"><div class="ts-v">' + (answers.compraria === 'si' ? '✓' : '✗') + '</div><div class="ts-l">Compraría</div></div>';
      }
      thanks.innerHTML = grid ? '<div class="t-score-grid">' + grid + '</div>' : '';
      thanks.style.display = 'block';
    }

    function showError(msg) {
        document.getElementById('confirmTitle').textContent = 'Error';
        document.getElementById('confirmSubtitle').textContent = msg;
        document.getElementById('confirmIcon').className = 'confirm-icon danger';
        document.getElementById('confirmIcon').innerHTML = '<i class="fas fa-exclamation-triangle"></i>';
        document.getElementById('statusBadge').style.display = 'none';
      }

      function showToast(msg, type) {
        const toast = document.createElement('div');
        toast.style.cssText = 'position:fixed; bottom:24px; right:24px; padding:14px 24px; border-radius:12px; font-weight:600; z-index:9999; animation:slideUp 0.3s ease; background:' + (type === 'success' ? 'rgba(0,200,120,0.95)' : 'rgba(239,68,68,0.95)') + '; color:#fff;';
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.animation = 'slideUp 0.3s ease reverse'; setTimeout(() => toast.remove(), 300); }, 3000);
      }
    })();
