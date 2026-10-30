/* ============================================================
   BIENENHAUS PROPIEDADES — Operaciones del canal (módulo CONTENIDO)
   ------------------------------------------------------------
   Herramientas para que el dueño sepa si el canal está sano y
   pueda recuperar lo que falló, sin entrar a YouTube Studio:

     · #29  Semáforo de salud del canal: conexión, permisos,
             inventario, publicaciones fallidas y días sin
             publicar. Si algo está mal, queda una alerta en
             audit_log (una vez por día, no spam).
     · #49  Reintento de publicaciones fallidas: el video vuelve
             al formulario con su metadata (no hay que reescribirlo).
     · #40  Historial de acciones del módulo: las últimas trazas
             de audit_log con module='contenido'.

   Expone: window.BH_YT.ops
   ============================================================ */
(function () {
  'use strict';

  const NS = (window.BH_YT = window.BH_YT || {});
  const core = NS.core;
  const FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
  const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';
  const ALERT_FLAG = 'health_alert_day';

  /* ============================================================
     #29 — Semáforo de salud
     ============================================================ */

  /**
   * Evalúa el estado del canal. Función PURA (sin red): recibe el
   * estado y devuelve los chequeos. Así se puede testear y también
   * usar desde otra pantalla.
   *
   * @param input { account, channel, videos, history, canManage, now }
   * @returns { level, checks: [{ id, label, level, detail }] }
   */
  function health(input) {
    input = input || {};
    const account = input.account || {};
    const channel = input.channel || {};
    const videos = Array.isArray(input.videos) ? input.videos : [];
    const history = Array.isArray(input.history) ? input.history : [];
    const now = input.now ? new Date(input.now).getTime() : Date.now();
    const scope = String(account.scope || '');
    const checks = [];

    /* 1) La conexión está viva */
    if (account.status === 'active') {
      checks.push({ id: 'connection', level: 'ok', label: 'Conexión activa', detail: account.display_name || 'Canal de YouTube' });
    } else if (account.status === 'expired') {
      checks.push({ id: 'connection', level: 'error', label: 'La conexión venció', detail: 'Reconectá la cuenta de YouTube desde Cuentas (el refresh token expiró).' });
    } else {
      checks.push({ id: 'connection', level: 'error', label: 'Canal desconectado', detail: 'No hay una cuenta de YouTube activa.' });
    }

    /* 2) Permiso de administración (youtube.force-ssl) */
    if (input.canManage) {
      checks.push({ id: 'manage', level: 'ok', label: 'Edición habilitada', detail: 'Podés editar, borrar, programar y moderar.' });
    } else {
      checks.push({
        id: 'manage', level: 'warning', label: 'Modo solo lectura',
        detail: 'Las conexiones viejas no tienen youtube.force-ssl: editar/borrar/programar/moderar está deshabilitado hasta reconectar.',
      });
    }

    /* 3) Permiso de analítica (yt-analytics.readonly) */
    if (scope.indexOf(ANALYTICS_SCOPE) >= 0) {
      checks.push({ id: 'analytics', level: 'ok', label: 'Analítica habilitada', detail: 'Los reportes del canal están disponibles.' });
    } else {
      checks.push({
        id: 'analytics', level: 'warning', label: 'Analítica pendiente de permiso',
        detail: 'Los reportes de YouTube Analytics piden yt-analytics.readonly: reconectá la cuenta para verlos.',
      });
    }

    /* 4) El inventario del canal se pudo leer */
    if (!channel.id) {
      checks.push({ id: 'inventory', level: 'warning', label: 'Inventario sin leer', detail: 'No se pudo leer el canal todavía.' });
    } else if (videos.length === 0) {
      checks.push({ id: 'inventory', level: 'warning', label: 'El canal no tiene videos', detail: 'El inventario volvió vacío.' });
    } else {
      checks.push({ id: 'inventory', level: 'ok', label: 'Inventario leído', detail: videos.length + ' video(s) en el panel.' });
    }

    /* 5) Publicaciones fallidas */
    const failed = history.filter(function (p) { return p && p.status === 'failed'; });
    if (failed.length) {
      checks.push({
        id: 'failed', level: 'warning', label: failed.length + ' publicación(es) fallida(s)',
        detail: 'Se pueden reintentar desde el historial sin reescribir la metadata.',
      });
    } else {
      checks.push({ id: 'failed', level: 'ok', label: 'Sin publicaciones fallidas', detail: 'Todo lo publicado quedó en pie.' });
    }

    /* 6) Días sin publicar */
    const lastPublish = videos.reduce(function (acc, v) {
      const t = v && v.published_at ? new Date(v.published_at).getTime() : 0;
      return t > acc ? t : acc;
    }, 0);
    const days = lastPublish ? Math.floor((now - lastPublish) / 86400000) : null;
    if (days === null) {
      checks.push({ id: 'cadence', level: 'ok', label: 'Sin publicaciones todavía', detail: 'El canal todavía no tiene videos públicos.' });
    } else if (days > 30) {
      checks.push({ id: 'cadence', level: 'warning', label: 'Hace ' + days + ' días que no se publica', detail: 'El canal está parado: conviene subir un video nuevo.' });
    } else {
      checks.push({ id: 'cadence', level: 'ok', label: 'Publicación reciente', detail: 'El último video salió hace ' + days + ' día(s).' });
    }

    let level = 'ok';
    if (checks.some(function (c) { return c.level === 'error'; })) level = 'error';
    else if (checks.some(function (c) { return c.level === 'warning'; })) level = 'warning';
    return { level: level, checks: checks };
  }

  /* Registra la alerta de salud en audit_log (una vez por día).
     Best-effort: si falla, el semáforo sigue visible. El flag de "ya
     avisado" se escribe SOLO si la traza se guardó de verdad: si el
     server falló, el próximo panel lo reintenta (mejor una alerta
     repetida que una perdida). */
  async function alertOnce(result, accountId) {
    if (!core || !core.audit) return false;
    if (!result || result.level === 'ok') return false;
    const today = new Date().toISOString().slice(0, 10);
    let yaAvisado = false;
    try { yaAvisado = localStorage.getItem('bh_yt_' + ALERT_FLAG) === today; } catch (_) {}
    if (yaAvisado) return false;
    let guardado = false;
    try {
      guardado = await core.audit('yt_health_alert', {
        recordId: null,
        metadata: {
          account_id: accountId || null,
          level: result.level,
          problems: result.checks.filter(function (c) { return c.level !== 'ok'; })
            .map(function (c) { return c.id + ': ' + c.label; }),
        },
      });
    } catch (_) { guardado = false; }
    if (!guardado) return false;
    try { localStorage.setItem('bh_yt_' + ALERT_FLAG, today); } catch (_) {}
    return true;
  }

  /* ============================================================
     #49 — Reintento de publicaciones fallidas
     ============================================================ */

  /* ============================================================
     #49 — Publicaciones fallidas
     ------------------------------------------------------------
     El reintento (cargar la metadata en el formulario) ya lo hace
     el orquestador (prefillFromPost). Acá solo se leen los posts
     fallidos, que el semáforo necesita.
     ============================================================ */

  /**
   * Publicaciones fallidas de YouTube (desde la DB, no del historial en
   * memoria: el semáforo de salud puede abrirse sin la pestaña Historial).
   */
  async function loadFailedPosts(limit) {
    const client = await getClient();
    if (!client) return [];
    const { data, error } = await client
      .from('social_posts')
      .select('id, platform, status, content, published_at, created_at, external_url, error, property_id')
      .eq('platform', 'youtube')
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 20, 1), 50));
    if (error) return [];
    return data || [];
  }

  /* ============================================================
     #40 — Historial de acciones del módulo
     ============================================================ */

  /**
   * Últimas acciones registradas del módulo CONTENIDO (audit_log).
   * El cliente puede leer audit_log (RLS lo permite para el panel).
   */
  async function loadAuditTrail(limit) {
    const client = await getClient();
    if (!client) return [];
    const { data, error } = await client
      .from('audit_log')
      .select('id, action, module, status, error_code, created_at, metadata')
      .eq('module', 'contenido')
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 20, 5), 100));
    if (error) return [];
    return data || [];
  }

  async function getClient() {
    try {
      if (window.__BH && typeof window.__BH.getAuthedClient === 'function') {
        return await window.__BH.getAuthedClient();
      }
      return window.supabaseClient || null;
    } catch (_) { return null; }
  }

  NS.ops = {
    health: health,
    alertOnce: alertOnce,
    loadFailedPosts: loadFailedPosts,
    loadAuditTrail: loadAuditTrail,
    FORCE_SSL_SCOPE: FORCE_SSL_SCOPE,
    ANALYTICS_SCOPE: ANALYTICS_SCOPE,
  };
})();
