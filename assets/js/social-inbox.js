/* ============================================================
   BIENENHAUS PROPIEDADES — Consultas de redes (módulo CONTENIDO)
   ------------------------------------------------------------
   Bandeja de comentarios de Facebook e Instagram con creación de
   leads del CRM. Complementa (no duplica) a YouTube:

     · YouTube   → los comentarios se gestionan en el Studio
                   (botón Comentarios del canal — yt-comments.js).
     · Facebook  → webhook (social-webhook-meta, field feed) +
                   sync del Graph API + crear lead desde la bandeja +
                   responder/moderar (paridad con YouTube).
     · Instagram → webhook (field comments) + sync + crear lead +
                   responder/eliminar comentarios.
     · TikTok    → SIN API de comentarios (la Content Posting API es
                   solo publishing): los leads de TikTok llegan por
                   WhatsApp del caption → se cargan a mano en el CRM.

   Además: filtro por estado (nuevos/lead/descartados), realtime
   (INSERT en social_comments → badge + refresco), apertura del lead
   creado (window.BH_CRM.open) y chips de conexión en la caja del
   webhook. Los replies PROPIOS no ensucian la bandeja: el server los
   inserta como dismissed + metadata.self.

   La lógica de negocio vive en el server (social-comments): el
   cliente no escribe en leads ni en social_comments (RLS).

   Expone: window.BH_YT.socialInbox.open(gotoSubTab)
   ============================================================ */
(function () {
  'use strict';

  const NS = (window.BH_YT = window.BH_YT || {});
  const FN = 'social-comments';

  const PLAT_META = {
    facebook: { icon: 'fab fa-facebook-f', color: '#1877F2', label: 'Facebook' },
    instagram: { icon: 'fab fa-instagram', color: '#E1306C', label: 'Instagram' },
  };

  /* ---------- helpers ---------- */

  function esc(s) {
    const v = s == null ? '' : String(s);
    if (window.BHUtils && typeof window.BHUtils.esc === 'function') return window.BHUtils.esc(v);
    return v.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escAttr(s) {
    return esc(s);
  }
  function toast(msg, type) {
    /* Convención del módulo: los toasts del panel viven en __BH
       (showToast no existe como global en admin-app.js). */
    if (window.__BH && typeof window.__BH.showToast === 'function') {
      return window.__BH.showToast(msg, type);
    }
    if (typeof window.showToast === 'function') return window.showToast(msg, type);
    console.log('[social-inbox]', msg);
  }
  function initials(name) {
    const cm = NS.comments;
    if (cm && typeof cm.initials === 'function') return cm.initials(name);
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (p) {
      return p.charAt(0).toUpperCase();
    }).join('') || '?';
  }
  function timeAgo(iso) {
    const cm = NS.comments;
    if (cm && typeof cm.timeAgo === 'function') return cm.timeAgo(iso);
    const t = iso ? new Date(iso).getTime() : NaN;
    if (!isFinite(t)) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'hace instantes';
    if (s < 3600) return 'hace ' + Math.round(s / 60) + ' min';
    if (s < 86400) return 'hace ' + Math.round(s / 3600) + ' h';
    if (s < 86400 * 30) return 'hace ' + Math.round(s / 86400) + ' días';
    return new Date(t).toLocaleDateString('es-AR');
  }

  /* ---------- llamadas al server (requireAdmin + verify_jwt) ---------- */

  function call(action, payload) {
    const core = NS.core;
    if (!core || !core.api || typeof core.api.edgeCall !== 'function') {
      return Promise.reject(new Error('El módulo de contenido no está cargado — recargá la página.'));
    }
    return core.api.edgeCall(FN, Object.assign({ action: action }, payload || {}));
  }

  /* ---------- estado ---------- */

  const state = {
    rows: [],
    filter: 'all',         /* all | facebook | instagram */
    statusFilter: 'all',   /* all | new | lead | dismissed */
    gotoSubTab: null,
    webhookInfo: null,
    loading: false,
  };

  /* ---------- realtime + badge ----------
     Canal PROPIO (social_comments no está en setupCoreRealtime de
     admin-app.js): un .on() por tabla, guard si el cliente fake no
     tiene .channel (los tests unitarios del harness no montan realtime).
     El INSERT de un comentario nuevo refresca el badge y, si la
     bandeja está visible, recarga las filas. */

  let channel = null;

  function ensureRealtime() {
    if (channel) return;
    const sb = window.supabaseClient;
    if (!sb || typeof sb.channel !== 'function') return;
    channel = sb.channel('bh-social-inbox');
    channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'social_comments' }, function () {
      updateBadge();
      if (document.getElementById('socialInboxList')) loadRows();
    });
    channel.subscribe();
  }

  /** Cantidad de comentarios sin triagear (status='new') vía head-count.
      Sin count (fake/mocked) el badge queda oculto. */
  function updateBadge() {
    const sb = window.supabaseClient;
    if (!sb || typeof sb.from !== 'function') return;
    try {
      sb.from('social_comments').select('id', { count: 'exact', head: true }).eq('status', 'new')
        .then(function (res) {
          const n = res && typeof res.count === 'number' ? res.count : null;
          if (n == null) return;
          setBadge(n);
        }).catch(function () { /* best-effort */ });
    } catch (_) { /* best-effort */ }
  }

  function setBadge(n) {
    const tabBtn = document.querySelector('#contenidoSubTabs button[data-sub="leads"]');
    if (!tabBtn) return;
    let badge = tabBtn.querySelector('.yt-comments-badge');
    if (!n) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'yt-comments-badge';
      tabBtn.appendChild(badge);
    }
    badge.textContent = String(n);
  }

  /* ---------- render ---------- */

  function open(gotoSubTab) {
    state.gotoSubTab = typeof gotoSubTab === 'function' ? gotoSubTab : null;
    const wrap = document.getElementById('contenidoLeads');
    if (!wrap) return;
    wrap.innerHTML =
      '<div class="yt-block">' +
        '<div class="yt-block-head"><i class="fas fa-inbox"></i> Consultas de redes <span id="socialInboxCount" style="color:var(--text-dim);font-weight:400;"></span></div>' +
        '<div class="yt-hint" style="margin:-2px 0 14px;">Los comentarios de Facebook e Instagram que interactúan con tus publicaciones llegan acá; desde cada uno podés crear un lead del CRM. Los de YouTube se gestionan en el Studio.</div>' +
        /* Conexión del webhook (FB/IG — la MISMA app de Meta). */
        '<div id="socialWebhookBox" class="glass-panel" style="padding:16px 18px;margin-bottom:14px;"></div>' +
        /* Notas de las otras plataformas. */
        '<div class="yt-inline" style="margin-bottom:14px;gap:10px;align-items:stretch;">' +
          '<div class="glass-panel" style="padding:12px 16px;flex:1;min-width:200px;">' +
            '<div style="font-size:12.5px;font-weight:600;"><i class="fab fa-youtube" style="color:#FF0000;"></i> YouTube</div>' +
            '<div class="yt-hint" style="margin:4px 0 8px;">Los comentarios del canal (y sus leads) viven en el Studio.</div>' +
            '<button type="button" id="socialGoStudio" class="btn-luxury-action yt-btn--xs"><i class="fas fa-sliders"></i> Abrir Studio</button>' +
          '</div>' +
          '<div class="glass-panel" style="padding:12px 16px;flex:1;min-width:200px;">' +
            '<div style="font-size:12.5px;font-weight:600;"><i class="fab fa-tiktok"></i> TikTok</div>' +
            '<div class="yt-hint" style="margin:4px 0;">TikTok no expone comentarios por API (la Content Posting API es solo para publicar). Los leads de TikTok llegan por WhatsApp del caption del video y se cargan a mano en el CRM.</div>' +
          '</div>' +
        '</div>' +
        /* Toolbar: filtros + sincronizar. */
        '<div class="yt-inline" style="margin-bottom:12px;flex-wrap:wrap;">' +
          '<select id="socialInboxFilter" class="crm-field-input crm-field-input--select" style="width:auto;">' +
            '<option value="all">Todas las plataformas</option>' +
            '<option value="instagram">Instagram</option>' +
            '<option value="facebook">Facebook</option>' +
          '</select>' +
          '<select id="socialInboxState" class="crm-field-input crm-field-input--select" style="width:auto;">' +
            '<option value="all">Todos los estados</option>' +
            '<option value="new">Nuevos</option>' +
            '<option value="lead">Con lead</option>' +
            '<option value="dismissed">Descartados</option>' +
          '</select>' +
          '<button type="button" id="socialInboxSync" class="btn-luxury-action yt-btn--sm" title="Traer los comentarios de los posts publicados directo del Graph API (cubre lo que el webhook no entregó)"><i class="fas fa-arrows-rotate"></i> Sincronizar</button>' +
          '<button type="button" id="socialInboxRefresh" class="btn-luxury-action yt-btn--sm" title="Recargar la bandeja"><i class="fas fa-rotate"></i></button>' +
        '</div>' +
        '<div id="socialInboxList"><div class="yt-hint"><i class="fas fa-spinner fa-spin"></i> Cargando…</div></div>' +
      '</div>';

    /* Listeners (cero onclick inline — la CSP no tiene unsafe-inline). */
    const filterSel = document.getElementById('socialInboxFilter');
    if (filterSel) filterSel.addEventListener('change', function () {
      state.filter = this.value;
      renderList();
    });
    const stateSel = document.getElementById('socialInboxState');
    if (stateSel) stateSel.addEventListener('change', function () {
      state.statusFilter = this.value;
      renderList();
    });
    const syncBtn = document.getElementById('socialInboxSync');
    if (syncBtn) syncBtn.addEventListener('click', function () { doSync(syncBtn); });
    const refreshBtn = document.getElementById('socialInboxRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { loadRows(); });
    const goStudio = document.getElementById('socialGoStudio');
    if (goStudio) goStudio.addEventListener('click', function () {
      if (state.gotoSubTab) state.gotoSubTab('studio');
    });

    ensureRealtime();
    updateBadge();
    renderWebhookBox();
    loadRows();
  }

  /* Caja de conexión: callback URL + verify token para copiar al
     dashboard de Meta + botón de suscripción de cuentas. */
  function renderWebhookBox() {
    const box = document.getElementById('socialWebhookBox');
    if (!box) return;
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<div style="font-size:12.5px;font-weight:600;"><i class="fas fa-plug-circle-bolt"></i> Webhook de comentarios (Facebook + Instagram — la misma app de Meta)</div>' +
        '<div class="yt-spacer"></div>' +
        '<button type="button" id="socialSubscribeBtn" class="btn-luxury-action yt-btn--xs" title="Suscribir las cuentas conectadas al campo feed (FB) / comments (IG) — requiere pages_manage_metadata"><i class="fas fa-bell"></i> Suscribir cuentas</button>' +
      '</div>' +
      '<div id="socialWebhookData" class="yt-hint" style="margin-top:8px;"><i class="fas fa-spinner fa-spin"></i> Cargando datos del webhook…</div>';

    const subBtn = document.getElementById('socialSubscribeBtn');
    if (subBtn) subBtn.addEventListener('click', function () { doSubscribe(subBtn); });

    call('webhook_info', {}).then(function (info) {
      state.webhookInfo = info;
      const data = document.getElementById('socialWebhookData');
      if (!data) return;
      const accounts = Array.isArray(info.accounts) ? info.accounts : [];
      let chipsHtml;
      if (!accounts.length) {
        chipsHtml = '<div class="yt-hint">Sin cuentas de Facebook/Instagram conectadas todavía — conectalas desde <b>Cuentas</b>.</div>';
      } else {
        chipsHtml = '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
          '<span class="yt-hint" style="margin:0;">Cuentas:</span>' +
          accounts.map(function (a) {
            const meta = PLAT_META[a.platform];
            const active = a.status === 'active';
            const color = active ? '#48bb78' : 'var(--text-dim)';
            const icon = meta ? '<i class="' + meta.icon + '" style="margin-right:4px;"></i>' : '';
            const label = (meta ? meta.label : a.platform) + ' · ' + (a.name || '?');
            return '<span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;border:1px solid ' + color + '55;color:' + color + ';">' +
              icon + esc(label) + (active ? ' <i class="fas fa-link"></i>' : ' (desconectada)') + '</span>';
          }).join('') +
          '</div>';
      }
      data.innerHTML =
        '<div style="display:grid;gap:6px;">' +
          '<div><span style="color:var(--text-dim);">Callback URL (dashboard de Meta → Webhooks → Page e Instagram):</span> ' +
            '<code style="user-select:all;">' + esc(info.callback_url || '') + '</code> ' +
            '<button type="button" class="btn-luxury-action yt-btn--xs" data-copy="' + escAttr(info.callback_url || '') + '"><i class="fas fa-copy"></i></button></div>' +
          '<div><span style="color:var(--text-dim);">Verify token:</span> ' +
            '<code style="user-select:all;">' + esc(info.verify_token || '') + '</code> ' +
            '<button type="button" class="btn-luxury-action yt-btn--xs" data-copy="' + escAttr(info.verify_token || '') + '"><i class="fas fa-copy"></i></button></div>' +
          '<div class="yt-hint">Campos a suscribir: <b>feed</b> (object Page) y <b>comments</b> (object Instagram). Guía completa: docs/integrations/CONECTAR_INSTAGRAM_FACEBOOK.md.</div>' +
          chipsHtml +
        '</div>';
      data.querySelectorAll('[data-copy]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const v = btn.getAttribute('data-copy') || '';
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(v).then(function () { toast('Copiado al portapapeles.', 'success'); });
          }
        });
      });
    }).catch(function (err) {
      const data = document.getElementById('socialWebhookData');
      if (data) data.innerHTML = '<span style="color:#ff9f43;">' + esc(err.message || 'No se pudieron leer los datos del webhook.') + '</span>';
    });
  }

  function platformChip(plat) {
    const meta = PLAT_META[plat];
    if (!meta) return '';
    return '<span style="font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:2px 7px;border-radius:999px;border:1px solid ' + meta.color + '55;color:' + meta.color + ';">' +
      '<i class="' + meta.icon + '"></i> ' + meta.label + '</span>';
  }

  function statusChip(row) {
    if (row.status === 'lead') {
      return '<span style="font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:rgba(72,187,120,.15);color:#48bb78;">Lead creado</span>';
    }
    if (row.status === 'dismissed') {
      return '<span style="font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:2px 7px;border-radius:999px;border:1px solid var(--text-dim);color:var(--text-dim);">Descartado</span>';
    }
    return '<span style="font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:rgba(246,173,85,.15);color:#f6ad55;">Nuevo</span>';
  }

  function selfMarker(row) {
    const md = row.metadata || {};
    const parts = [];
    if (md.self) parts.push('<span style="font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:2px 7px;border-radius:999px;border:1px solid var(--text-dim);color:var(--text-dim);">Respuesta propia</span>');
    else if (md.replied_at) parts.push('<span style="font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:rgba(72,187,120,.12);color:#48bb78;"><i class="fas fa-reply"></i> Respondido</span>');
    return parts.join('');
  }

  function rowHtml(row) {
    const meta = PLAT_META[row.platform] || { icon: 'fas fa-comment', color: 'var(--text-dim)', label: row.platform };
    const prop = (row.properties && (row.properties.property_code || row.properties.title)) || null;
    const postUrl = (row.social_posts && row.social_posts.external_url) || null;
    const author = row.author_name || row.author_handle || meta.label + ' (anónimo)';
    const handle = row.author_handle && row.author_handle !== row.author_name
      ? ' <span style="color:var(--text-dim);">@' + esc(row.author_handle) + '</span>' : '';
    const md = row.metadata || {};
    const moderated = md.moderated === 'deleted';
    const actions = [];
    if (row.status === 'lead' && row.lead_id) {
      actions.push('<button type="button" class="btn-luxury-action yt-btn--xs" data-open-lead="' + escAttr(row.lead_id) + '" title="Abrir este lead en el CRM"><i class="fas fa-address-card"></i> Abrir lead</button>');
    }
    if (!moderated) {
      actions.push('<button type="button" class="btn-luxury-action yt-btn--xs" data-reply="' + escAttr(row.id) + '" title="Responder el comentario en ' + esc(meta.label) + '"><i class="fas fa-reply"></i> Responder</button>');
    }
    if (row.status !== 'lead') {
      actions.push('<button type="button" class="btn-luxury-action yt-btn--xs" data-lead="' + escAttr(row.id) + '" title="Crear un lead del CRM con este comentario (si el texto tiene email o teléfono, el lead los trae)"><i class="fas fa-user-plus"></i> Crear lead</button>');
      actions.push('<button type="button" class="btn-luxury-action yt-btn--xs" data-dismiss="' + escAttr(row.id) + '" title="Marcar como revisado (sin lead)"><i class="fas fa-check"></i> Descartar</button>');
    }
    if (!moderated) {
      const hidden = md.is_hidden === true;
      actions.push('<button type="button" class="btn-luxury-action yt-btn--xs" data-mod="' + escAttr(row.id) + '" data-op="' + (hidden ? 'unhide' : 'hide') + '" title="' + (hidden ? 'Mostrar el comentario (ya estaba oculto)' : 'Ocultar el comentario sin borrarlo') + '"><i class="fas fa-' + (hidden ? 'eye' : 'eye-slash') + '"></i> ' + (hidden ? 'Mostrar' : 'Ocultar') + '</button>');
      actions.push('<button type="button" class="btn-luxury-action yt-btn--xs" data-mod="' + escAttr(row.id) + '" data-op="delete" title="Eliminar el comentario de la red (la fila pasa a Descartado)"><i class="fas fa-trash"></i> Eliminar</button>');
    } else {
      actions.push('<span class="yt-comment-likes"><i class="fas fa-ban"></i> Eliminado de la red</span>');
    }
    const replyBox =
      '<div class="yt-comment-replybox" data-replybox="' + escAttr(row.id) + '" style="display:none;margin-top:8px;">' +
        '<textarea class="crm-field-input" data-replytext="' + escAttr(row.id) + '" rows="2" maxlength="2200" placeholder="Escribí una respuesta pública…"></textarea>' +
        '<div class="yt-inline" style="gap:8px;margin-top:6px;">' +
          '<button type="button" class="btn-luxury-action yt-btn--xs" data-send="' + escAttr(row.id) + '"><i class="fas fa-paper-plane"></i> Enviar</button>' +
          '<button type="button" class="btn-luxury-action yt-btn--xs" data-cancel-reply="' + escAttr(row.id) + '">Cancelar</button>' +
        '</div>' +
      '</div>';
    return '<div class="yt-comment" data-comment-row="' + escAttr(row.id) + '">' +
      '<div class="yt-comment-head">' +
        '<span class="yt-comment-avatar">' + esc(initials(author)) + '</span>' +
        '<span class="yt-comment-author">' + esc(author) + handle + '</span>' +
        platformChip(row.platform) +
        '<span class="yt-comment-time">' + esc(timeAgo(row.commented_at || row.created_at)) + '</span>' +
        statusChip(row) +
        selfMarker(row) +
      '</div>' +
      '<div class="yt-comment-text">' + esc(row.body || '(sin texto)') + '</div>' +
      '<div class="yt-inline" style="gap:10px;margin-top:6px;font-size:11px;color:var(--text-dim);">' +
        (prop ? '<span><i class="fas fa-house"></i> ' + esc(prop) + '</span>' : '<span><i class="fas fa-house"></i> Sin propiedad vinculada</span>') +
        (postUrl ? '<a href="' + escAttr(postUrl) + '" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i> Ver post</a>' : '') +
      '</div>' +
      '<div class="yt-comment-actions">' + actions.join(' ') + '</div>' +
      replyBox +
    '</div>';
  }

  function renderList() {
    const list = document.getElementById('socialInboxList');
    if (!list) return;
    const rows = state.rows.filter(function (r) {
      if (state.filter !== 'all' && r.platform !== state.filter) return false;
      if (state.statusFilter !== 'all' && r.status !== state.statusFilter) return false;
      return true;
    });
    const count = document.getElementById('socialInboxCount');
    if (count) count.textContent = '(' + rows.length + ')';

    if (state.loading) {
      list.innerHTML = '<div class="yt-hint"><i class="fas fa-spinner fa-spin"></i> Cargando…</div>';
      return;
    }
    if (!rows.length) {
      list.innerHTML =
        '<div class="empty-state">' +
          '<i class="fas fa-inbox"></i>' +
          '<div class="empty-state-title">Sin comentarios en este filtro</div>' +
          '<div style="max-width:420px;line-height:1.6;">Cuando alguien comente tus publicaciones de Facebook o Instagram va a aparecer acá. Primero configurá el webhook (arriba) y usá Sincronizar para traer los comentarios de los posts ya publicados.</div>' +
        '</div>';
      return;
    }
    list.innerHTML = '<div class="yt-comments">' + rows.map(rowHtml).join('') + '</div>';
    list.querySelectorAll('[data-lead]').forEach(function (btn) {
      btn.addEventListener('click', function () { createLead(btn, btn.getAttribute('data-lead')); });
    });
    list.querySelectorAll('[data-dismiss]').forEach(function (btn) {
      btn.addEventListener('click', function () { dismissRow(btn.getAttribute('data-dismiss')); });
    });
    list.querySelectorAll('[data-open-lead]').forEach(function (btn) {
      btn.addEventListener('click', function () { openLead(btn.getAttribute('data-open-lead')); });
    });
    list.querySelectorAll('[data-reply]').forEach(function (btn) {
      btn.addEventListener('click', function () { toggleReplyBox(btn.getAttribute('data-reply')); });
    });
    list.querySelectorAll('[data-cancel-reply]').forEach(function (btn) {
      btn.addEventListener('click', function () { toggleReplyBox(btn.getAttribute('data-cancel-reply'), true); });
    });
    list.querySelectorAll('[data-send]').forEach(function (btn) {
      btn.addEventListener('click', function () { sendReply(btn, btn.getAttribute('data-send')); });
    });
    list.querySelectorAll('[data-mod]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        moderateRow(btn.getAttribute('data-mod'), btn.getAttribute('data-op') || 'delete');
      });
    });
  }

  /* ---------- acciones ---------- */

  function loadRows() {
    state.loading = true;
    renderList();
    call('list', {}).then(function (res) {
      state.rows = res.rows || [];
      state.loading = false;
      renderList();
      updateBadge();
    }).catch(function (err) {
      state.rows = [];
      state.loading = false;
      renderList();
      toast(err.message || 'No se pudo cargar la bandeja.', 'error');
    });
  }

  function createLead(btn, commentId) {
    if (!btn) return;
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creando…';
    call('create_lead', { comment_id: commentId }).then(function (res) {
      if (res.duplicate) toast('Ya existe un lead para este comentario.', 'success');
      else toast('Lead creado en el CRM.', 'success');
      loadRows();
    }).catch(function (err) {
      btn.disabled = false;
      btn.innerHTML = html;
      toast(err.message || 'No se pudo crear el lead.', 'error');
    });
  }

  /* Abre el lead creado en el panel del CRM (window.BH_CRM.open). */
  function openLead(leadId) {
    if (!leadId) return;
    const crm = window.BH_CRM;
    if (crm && typeof crm.open === 'function') {
      try {
        crm.open(leadId);
        return;
      } catch (err) {
        toast('No se pudo abrir el lead: ' + (err.message || 'error'), 'error');
        return;
      }
    }
    toast('El CRM todavía no cargó — probá de nuevo en un segundo.', 'warning');
  }

  /* Muestra/oculta el replybox inline de una fila. */
  function toggleReplyBox(commentId, hide) {
    const box = document.querySelector('[data-replybox="' + commentId + '"]');
    if (!box) return;
    const show = hide ? false : box.style.display === 'none';
    /* Solo una caja abierta a la vez: cerrar las demás. */
    document.querySelectorAll('[data-replybox]').forEach(function (b) {
      if (b !== box) b.style.display = 'none';
    });
    box.style.display = show ? '' : 'none';
    if (show) {
      const ta = box.querySelector('textarea');
      if (ta) ta.focus();
    }
  }

  function sendReply(btn, commentId) {
    const ta = document.querySelector('[data-replytext="' + commentId + '"]');
    const message = ta ? String(ta.value || '').trim() : '';
    if (!message) {
      toast('Escribí la respuesta antes de enviar.', 'warning');
      if (ta) ta.focus();
      return;
    }
    if (!btn) return;
    const html = btn.innerHTML;
    btn.disabled = true;
    ta.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando…';
    call('reply', { comment_id: commentId, message: message }).then(function () {
      toast('Respuesta publicada.', 'success');
      toggleReplyBox(commentId, true);
      loadRows();
    }).catch(function (err) {
      btn.disabled = false;
      ta.disabled = false;
      btn.innerHTML = html;
      toast(err.message || 'No se pudo publicar la respuesta.', 'error');
    });
  }

  /* Moderar (eliminar / ocultar / mostrar) con confirmación del panel
     (window.__BH.showConfirmDialog — el confirm() nativo está prohibido
     en el módulo). */
  function moderateRow(commentId, op) {
    const titles = {
      delete: ['Eliminar comentario', 'El comentario se borra de la red y la fila pasa a Descartado. No se puede deshacer.'],
      hide: ['Ocultar comentario', 'El comentario queda oculto en la red (se puede volver a mostrar).'],
      unhide: ['Mostrar comentario', 'El comentario vuelve a ser visible en la red.'],
    };
    const t = titles[op] || titles.delete;
    const bh = window.__BH;
    if (!bh || typeof bh.showConfirmDialog !== 'function') {
      toast('El panel todavía no cargó los diálogos — probá de nuevo.', 'warning');
      return;
    }
    bh.showConfirmDialog({
      title: t[0],
      message: t[1],
      icon: op === 'delete' ? 'fas fa-trash' : 'fas fa-eye-slash',
      confirmText: op === 'delete' ? 'Eliminar' : (op === 'hide' ? 'Ocultar' : 'Mostrar'),
      danger: op === 'delete',
    }).then(function (ok) {
      if (!ok) return;
      call('moderate', { comment_id: commentId, op: op }).then(function () {
        toast(op === 'delete' ? 'Comentario eliminado.' : (op === 'hide' ? 'Comentario oculto.' : 'Comentario visible.'), 'success');
        loadRows();
      }).catch(function (err) {
        toast(err.message || 'No se pudo moderar el comentario.', 'error');
      });
    });
  }

  function dismissRow(commentId) {
    call('dismiss', { comment_id: commentId }).then(function () {
      loadRows();
    }).catch(function (err) {
      toast(err.message || 'No se pudo descartar.', 'error');
    });
  }

  function doSync(btn) {
    if (!btn) return;
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sincronizando…';
    const platforms = state.filter === 'facebook' ? ['facebook']
      : state.filter === 'instagram' ? ['instagram'] : ['facebook', 'instagram'];
    const jobs = platforms.map(function (p) {
      return call('sync', { platform: p }).then(function (res) {
        return { platform: p, res: res };
      }).catch(function (err) {
        return { platform: p, error: err.message || 'Error' };
      });
    });
    Promise.all(jobs).then(function (results) {
      btn.disabled = false;
      btn.innerHTML = html;
      const ok = [];
      const bad = [];
      results.forEach(function (r) {
        if (r.error) { bad.push(r.platform + ': ' + r.error); return; }
        const res = r.res || {};
        let msg = (res.posts || 0) + ' posts revisados · ' + (res.fetched || 0) + ' comentarios';
        if (res.self_skipped > 0) msg += ' · ' + res.self_skipped + ' propios ignorados';
        ok.push(r.platform + ': ' + msg);
        (res.errors || []).forEach(function (e) { bad.push(r.platform + ': ' + e); });
      });
      if (ok.length) toast(ok.join(' — '), 'success');
      if (bad.length) toast(bad.join(' — '), 'warning');
      loadRows();
    });
  }

  function doSubscribe(btn) {
    if (!btn) return;
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Suscribiendo…';
    const jobs = ['facebook', 'instagram'].map(function (p) {
      return call('subscribe', { platform: p }).then(function (res) {
        return { platform: p, results: res.results || [] };
      }).catch(function (err) {
        return { platform: p, error: err.message || 'Error' };
      });
    });
    Promise.all(jobs).then(function (results) {
      btn.disabled = false;
      btn.innerHTML = html;
      const msgs = [];
      results.forEach(function (r) {
        if (r.error) { msgs.push(r.platform + ': ' + r.error); return; }
        (r.results || []).forEach(function (s) {
          msgs.push(r.platform + ' → ' + (s.ok ? 'OK' : 'fallo') + (s.message ? ' (' + s.message + ')' : ''));
        });
      });
      toast(msgs.join(' — '), msgs.some(function (m) { return /fallo/.test(m); }) ? 'warning' : 'success');
    });
  }

  /* ---------- export ---------- */

  NS.socialInbox = {
    open: open,
    state: state,
    updateBadge: updateBadge,
  };
})();
