/* ============================================================
   BIENENHAUS PROPIEDADES — Consultas de redes (módulo CONTENIDO)
   ------------------------------------------------------------
   Bandeja de comentarios de Facebook e Instagram con creación de
   leads del CRM. Complementa (no duplica) a YouTube:

     · YouTube   → los comentarios se gestionan en el Studio
                   (botón Comentarios del canal — yt-comments.js).
     · Facebook  → webhook (social-webhook-meta, field feed) +
                   sync del Graph API + crear lead desde la bandeja.
     · Instagram → webhook (field comments) + sync + crear lead.
     · TikTok    → SIN API de comentarios (la Content Posting API es
                   solo publishing): los leads de TikTok llegan por
                   WhatsApp del caption → se cargan a mano en el CRM.

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
    if (typeof window.showToast === 'function') window.showToast(msg, type);
    else console.log('[social-inbox]', msg);
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
    filter: 'all',   /* all | facebook | instagram */
    gotoSubTab: null,
    webhookInfo: null,
    loading: false,
  };

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
        /* Toolbar: filtro + sincronizar. */
        '<div class="yt-inline" style="margin-bottom:12px;">' +
          '<select id="socialInboxFilter" class="crm-field-input crm-field-input--select" style="width:auto;">' +
            '<option value="all">Todas las plataformas</option>' +
            '<option value="instagram">Instagram</option>' +
            '<option value="facebook">Facebook</option>' +
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
    const syncBtn = document.getElementById('socialInboxSync');
    if (syncBtn) syncBtn.addEventListener('click', function () { doSync(syncBtn); });
    const refreshBtn = document.getElementById('socialInboxRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { loadRows(); });
    const goStudio = document.getElementById('socialGoStudio');
    if (goStudio) goStudio.addEventListener('click', function () {
      if (state.gotoSubTab) state.gotoSubTab('studio');
    });

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
      data.innerHTML =
        '<div style="display:grid;gap:6px;">' +
          '<div><span style="color:var(--text-dim);">Callback URL (dashboard de Meta → Webhooks → Page e Instagram):</span> ' +
            '<code style="user-select:all;">' + esc(info.callback_url || '') + '</code> ' +
            '<button type="button" class="btn-luxury-action yt-btn--xs" data-copy="' + escAttr(info.callback_url || '') + '"><i class="fas fa-copy"></i></button></div>' +
          '<div><span style="color:var(--text-dim);">Verify token:</span> ' +
            '<code style="user-select:all;">' + esc(info.verify_token || '') + '</code> ' +
            '<button type="button" class="btn-luxury-action yt-btn--xs" data-copy="' + escAttr(info.verify_token || '') + '"><i class="fas fa-copy"></i></button></div>' +
          '<div class="yt-hint">Campos a suscribir: <b>feed</b> (object Page) y <b>comments</b> (object Instagram). Guía completa: docs/integrations/CONECTAR_INSTAGRAM_FACEBOOK.md.</div>' +
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

  function rowHtml(row) {
    const meta = PLAT_META[row.platform] || { icon: 'fas fa-comment', color: 'var(--text-dim)', label: row.platform };
    const prop = (row.properties && (row.properties.property_code || row.properties.title)) || null;
    const postUrl = (row.social_posts && row.social_posts.external_url) || null;
    const author = row.author_name || row.author_handle || meta.label + ' (anónimo)';
    const handle = row.author_handle && row.author_handle !== row.author_name
      ? ' <span style="color:var(--text-dim);">@' + esc(row.author_handle) + '</span>' : '';
    const actions = row.status === 'lead'
      ? '<span class="yt-comment-likes"><i class="fas fa-user-check"></i> El lead ya está en el CRM</span>'
      : '<button type="button" class="btn-luxury-action yt-btn--xs" data-lead="' + escAttr(row.id) + '" title="Crear un lead del CRM con este comentario (si el texto tiene email o teléfono, el lead los trae)"><i class="fas fa-user-plus"></i> Crear lead</button>' +
        '<button type="button" class="btn-luxury-action yt-btn--xs" data-dismiss="' + escAttr(row.id) + '" title="Marcar como revisado (sin lead)"><i class="fas fa-check"></i> Descartar</button>';
    return '<div class="yt-comment" data-comment-row="' + escAttr(row.id) + '">' +
      '<div class="yt-comment-head">' +
        '<span class="yt-comment-avatar">' + esc(initials(author)) + '</span>' +
        '<span class="yt-comment-author">' + esc(author) + handle + '</span>' +
        platformChip(row.platform) +
        '<span class="yt-comment-time">' + esc(timeAgo(row.commented_at || row.created_at)) + '</span>' +
        statusChip(row) +
      '</div>' +
      '<div class="yt-comment-text">' + esc(row.body || '(sin texto)') + '</div>' +
      '<div class="yt-inline" style="gap:10px;margin-top:6px;font-size:11px;color:var(--text-dim);">' +
        (prop ? '<span><i class="fas fa-house"></i> ' + esc(prop) + '</span>' : '<span><i class="fas fa-house"></i> Sin propiedad vinculada</span>') +
        (postUrl ? '<a href="' + escAttr(postUrl) + '" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i> Ver post</a>' : '') +
      '</div>' +
      '<div class="yt-comment-actions">' + actions + '</div>' +
    '</div>';
  }

  function renderList() {
    const list = document.getElementById('socialInboxList');
    if (!list) return;
    const rows = state.filter === 'all' ? state.rows : state.rows.filter(function (r) { return r.platform === state.filter; });
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
          '<div class="empty-state-title">Todavía no hay comentarios de redes</div>' +
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
  }

  /* ---------- acciones ---------- */

  function loadRows() {
    state.loading = true;
    renderList();
    call('list', {}).then(function (res) {
      state.rows = res.rows || [];
      state.loading = false;
      renderList();
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
        const msg = (res.posts || 0) + ' posts revisados · ' + (res.fetched || 0) + ' comentarios';
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

  NS.socialInbox = { open: open, state: state };
})();
