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
          completada: { icon: 'fa-flag-checkered', class: 'success', label: 'Completada', badge: 'status-completada' },
          cancelada: { icon: 'fa-times-circle', class: 'danger', label: 'Cancelada', badge: 'status-cancelada' }
        };
        const s = statusMap[v.status] || statusMap.pendiente;
        icon.className = 'confirm-icon ' + s.class;
        icon.innerHTML = '<i class="fas ' + s.icon + '"></i>';
        badge.className = 'status-badge ' + s.badge;
        badge.textContent = s.label;

        if (v.status === 'confirmada' || v.status === 'completada') {
          title.textContent = 'Visita Confirmada ✓';
          subtitle.textContent = 'Tu visita está confirmada. Te esperamos.';
          actions.style.display = 'none';
        } else if (v.status === 'cancelada') {
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
          ? new Date(v.visit_date).toLocaleString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
          : '—';
        document.getElementById('detailDuration').textContent = v.duration_minutes ? v.duration_minutes + ' min' : '60 min';
        document.getElementById('detailBroker').textContent = v.agents?.full_name || 'Por asignar';
        document.getElementById('detailNotes').textContent = v.notes || '—';
        details.style.display = 'block';

        // WhatsApp link
        if (v.client_phone) {
          const msg = encodeURIComponent(`Hola, confirmo mi visita del ${new Date(v.visit_date).toLocaleDateString('es-AR')} a las ${new Date(v.visit_date).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}.`);
          btnWhatsApp.href = `https://wa.me/${v.client_phone.replace(/\D/g, '')}?text=${msg}`;
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
          if (!confirm('¿Cancelar esta visita?')) return;
          btnCancel.disabled = true;
          btnCancel.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cancelando...';
          try {
            const { data, error } = await supabaseClient
              .rpc('update_visit_status_by_token', { p_token: token, p_action: 'cancelar' });
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
