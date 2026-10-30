/* ============================================================
   BIENENHAUS PROPIEDADES — Comentarios del canal (módulo CONTENIDO)
   ------------------------------------------------------------
   Lo que el dueño puede hacer con los comentarios de YouTube,
   sin salirse del panel:

     · Ver los comentarios de un video (y sus respuestas).
     · Responder, dar like y moderar (retener/aprobar) — esto
       exige youtube.force-ssl (si no, el server lo dice claro).
     · Crear un LEAD del CRM desde un comentario: si la persona
       escribió un teléfono o un email, el lead lo trae; si ya
       existe, no se duplica (el server deduplica).
     · Una bandeja con los comentarios recientes del canal y un
       contador de "nuevos" desde la última visita.

   Toda la lógica de negocio vive en el server
   (supabase/functions/social-youtube-comments): el cliente no
   escribe en leads ni en audit_log (RLS).

   Expone: window.BH_YT.comments
   ============================================================ */
(function () {
  'use strict';

  const NS = (window.BH_YT = window.BH_YT || {});
  const core = NS.core;
  const FN = 'social-youtube-comments';
  const SEEN_KEY = 'comments_seen';

  /* ---------- llamadas al server ---------- */

  function call(action, payload) {
    if (!core || !core.api || typeof core.api.edgeCall !== 'function') {
      return Promise.reject(new Error('El módulo de comentarios no está disponible.'));
    }
    return core.api.edgeCall(FN, Object.assign({ action: action }, payload || {}));
  }

  /** Comentarios de un video (con sus respuestas). */
  function list(accountId, videoId) {
    return call('comments_list', { account_id: accountId, video_id: videoId });
  }

  /** Bandeja: comentarios recientes de TODOS los videos del canal. */
  function inbox(accountId, channelId) {
    return call('comments_inbox', { account_id: accountId, channel_id: channelId });
  }

  /** Responder un comentario (parentId = id del comentario de primer nivel). */
  function reply(accountId, videoId, parentId, text) {
    return call('comment_reply', {
      account_id: accountId,
      video_id: videoId,
      parent_id: parentId,
      text: text,
    });
  }

  /** Dar like (like=true) o quitarlo (like=false). */
  function heart(accountId, commentId, like) {
    return call('comment_heart', {
      account_id: accountId,
      comment_id: commentId,
      like: like !== false,
    });
  }

  /** Retener (held) o aprobar (approved) un comentario. */
  function moderate(accountId, commentId, status) {
    return call('comment_moderate', {
      account_id: accountId,
      comment_id: commentId,
      status: status === 'approved' ? 'approved' : 'held',
    });
  }

  /** Crear (o deduplicar) un lead del CRM desde un comentario. */
  function createLead(accountId, videoId, comment) {
    return call('comment_lead', {
      account_id: accountId,
      video_id: videoId,
      comment_id: (comment && comment.id) || '',
      author: (comment && comment.author) || '',
      text: (comment && comment.text) || '',
    });
  }

  /* ---------- bandeja local (lo que el dueño ya vio) ---------- */

  function lastSeen() {
    if (!core || !core.storage) return 0;
    const v = core.storage.get(SEEN_KEY, 0);
    const n = Number(v || 0);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function markSeen(ts) {
    if (!core || !core.storage) return;
    core.storage.set(SEEN_KEY, Number(ts || Date.now()));
  }

  /**
   * Cuántos comentarios hay "nuevos" (posteriores a la última visita).
   * Si nunca se abrió la bandeja, se cuentan todos los de las últimas
   * 24 h (si no, el primer día sería un avisos gigante).
   */
  function unreadCount(threads) {
    const list = Array.isArray(threads) ? threads : [];
    const seen = lastSeen();
    const floor = seen || (Date.now() - 24 * 3600 * 1000);
    let n = 0;
    list.forEach(function (t) {
      if (!t || !t.publishedAt) return;
      const ts = new Date(t.publishedAt).getTime();
      if (isFinite(ts) && ts > floor) n++;
    });
    return n;
  }

  /* ---------- helpers de presentación ---------- */

  /** Texto relativo ("hace 2 h") para la lista de comentarios. */
  function timeAgo(iso) {
    const t = iso ? new Date(iso).getTime() : NaN;
    if (!isFinite(t)) return '';
    const min = Math.round((Date.now() - t) / 60000);
    if (min < 1) return 'recién';
    if (min < 60) return 'hace ' + min + ' min';
    const h = Math.round(min / 60);
    if (h < 24) return 'hace ' + h + ' h';
    const d = Math.round(h / 24);
    if (d < 30) return 'hace ' + d + ' d';
    return new Date(iso).toLocaleDateString('es-AR');
  }

  /** Iniciales para el avatar de texto (sin imágenes externas). */
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const a = parts[0][0] || '';
    const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (a + b).toUpperCase();
  }

  NS.comments = {
    list,
    inbox,
    reply,
    heart,
    moderate,
    createLead,
    lastSeen,
    markSeen,
    unreadCount,
    timeAgo,
    initials,
  };
})();
