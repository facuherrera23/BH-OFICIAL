/* ============================================================
   BIENENHAUS PROPIEDADES — Analítica del canal (módulo CONTENIDO)
   ------------------------------------------------------------
   Reportes de YouTube Analytics para tomar decisiones con datos:

     · Resumen    → vistas, minutos vistos, duración media,
                    suscriptores +/- , impresiones y CTR.
     · Evolución  → día a día (vistas, minutos, suscriptores).
     · Top videos → los 20 videos que más rindieron en el período.
     · Retención  → curva de retención (qué % del video ve la gente).
     · Tráfico   → de dónde llegan las vistas.
     · Audiencia  → edad y género de los espectadores.

   ⚠️ La analítica exige el scope `yt-analytics.readonly`. Las
   conexiones hechas ANTES de ese scope NO lo tienen → el server
   responde `needs_reconnect` y este módulo lo traduce a un aviso
   claro ("desconectá y volvé a conectar") en vez de romperse.

   El servidor (social-youtube-studio) es quien define las
   dimensiones y métricas de cada reporte: el cliente no puede
   inventar consultas a la API de Google.

   Expone: window.BH_YT.analytics
   ============================================================ */
(function () {
  'use strict';

  const NS = (window.BH_YT = window.BH_YT || {});
  const core = NS.core;
  const CACHE_TTL_MS = 5 * 60 * 1000;   // 5 min (los datos de Google no cambian por segundo)

  /* ---------- catálogo de reportes ---------- */
  const REPORTS = [
    { id: 'summary', label: 'Resumen', icon: 'fa-chart-simple' },
    { id: 'daily', label: 'Evolución', icon: 'fa-chart-line' },
    { id: 'top_videos', label: 'Top videos', icon: 'fa-ranking-star' },
    { id: 'retention', label: 'Retención', icon: 'fa-gauge-high' },
    { id: 'traffic', label: 'Tráfico', icon: 'fa-signpost' },
    { id: 'demographics', label: 'Audiencia', icon: 'fa-users' },
  ];

  /* Etiquetas legibles de las columnas de la API. */
  const LABELS = {
    views: 'Vistas',
    estimatedMinutesWatched: 'Minutos vistos',
    averageViewDuration: 'Duración media (s)',
    subscribersGained: 'Suscriptores +',
    subscribersLost: 'Suscriptores −',
    impressions: 'Impresiones',
    impressionsClickThroughRate: 'CTR (%)',
    video: 'Video',
    day: 'Fecha',
    trafficSource: 'Origen',
    ageGroup: 'Edad',
    gender: 'Género',
    viewerPercentage: '% de audiencia',
    elapsedVideoTimeRatio: 'Retención (%)',
  };

  /* Métricas que se muestran como porcentaje. */
  const PERCENT_KEYS = { impressionsClickThroughRate: 1, viewerPercentage: 1, elapsedVideoTimeRatio: 1 };
  /* Métricas que se muestran como minutos. */
  const MINUTES_KEYS = { estimatedMinutesWatched: 1 };

  function labelFor(key) {
    return LABELS[key] || key;
  }

  function isPercent(key) {
    return !!PERCENT_KEYS[key];
  }

  /** Formatea un valor de la API según su tipo. */
  function formatValue(key, value) {
    /* Las dimensiones son texto (origen, edad, género, fecha): se traducen
       ANTES de cualquier chequeo numérico. */
    if (key === 'trafficSource') return trafficLabel(value);
    if (key === 'ageGroup') return ageLabel(value);
    if (key === 'gender') return genderLabel(value);
    if (key === 'day') return dayLabel(value);
    if (key === 'video') return String(value ?? '');

    const n = Number(value);
    if (!isFinite(n)) return '—';
    if (isPercent(key)) return n.toFixed(2) + '%';
    if (MINUTES_KEYS[key]) {
      if (n >= 60) {
        const h = Math.floor(n / 60);
        const m = Math.round(n % 60);
        return h + ' h ' + String(m).padStart(2, '0') + ' min';
      }
      return Math.round(n) + ' min';
    }
    if (key === 'averageViewDuration') {
      const s = Math.round(n);
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }
    return new Intl.NumberFormat('es-AR').format(n);
  }

  function trafficLabel(value) {
    const map = {
      YOUTUBE_SEARCH: 'Búsqueda de YouTube',
      YOUTUBE_SUGGESTION: 'Sugeridas',
      YOUTUBE_BROADCAST: 'Repetido en otros canales',
      YOUTUBE_NOTIFICATION: 'Notificaciones',
      YOUTUBE_END_SCREEN: 'Pantalla final',
      YOUTUBE_WATCH_PAGE: 'Página del video',
      YOUTUBE_PROFILE: 'Página del canal',
      YOUTUBE_COMMENT: 'Comentarios',
      EXTERNAL: 'Webs externas',
      SOCIAL: 'Redes sociales',
      REFERRAL: 'Referidos',
      DISPLAY: 'Banners',
      OTHER: 'Otros',
    };
    return map[String(value)] || String(value);
  }

  function ageLabel(value) {
    const map = {
      AGE_RANGE_13_17: '13–17', AGE_RANGE_18_24: '18–24', AGE_RANGE_25_34: '25–34',
      AGE_RANGE_35_44: '35–44', AGE_RANGE_45_54: '45–54', AGE_RANGE_55_64: '55–64',
      AGE_RANGE_65_: '65+', AGE_RANGE_UNDETERMINED: 'Sin dato',
    };
    return map[String(value)] || String(value);
  }

  function genderLabel(value) {
    const map = { MALE: 'Hombres', FEMALE: 'Mujeres', OTHER: 'Otro', UNDETERMINED: 'Sin dato' };
    return map[String(value)] || String(value);
  }

  function dayLabel(value) {
    const d = new Date(String(value) + 'T00:00:00Z');
    if (!isNaN(d.getTime())) return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
    return String(value);
  }

  /* ---------- errores ---------- */

  /** ¿El fallo es "la conexión no tiene el scope de analítica"? */
  function isNeedsReconnect(err) {
    if (!err) return false;
    if (err.code === 'needs_reconnect') return true;
    const msg = String(err.message || '');
    return msg.indexOf('needs_reconnect') >= 0;
  }

  /* ---------- caché corta (sessionStorage) ---------- */

  function cacheKey(accountId, report, days, videoId) {
    return 'ana_' + accountId + '_' + report + '_' + (days || 28) + (videoId ? '_' + videoId : '');
  }

  function cacheRead(key) {
    if (!core || !core.storage) return null;
    try {
      const v = core.storage.sessionGet(key, null);
      if (!v || !v.at) return null;
      if (Date.now() - Number(v.at) > CACHE_TTL_MS) return null;
      return v.data || null;
    } catch (_) { return null; }
  }

  function cacheWrite(key, data) {
    if (!core || !core.storage) return;
    try { core.storage.sessionSet(key, { at: Date.now(), data: data }); } catch (_) {}
  }

  /* ---------- llamada ---------- */

  /**
   * Pide un reporte al server.
   * @param accountId  id de social_accounts
   * @param report     id del reporte (REPORTS)
   * @param opts       { days, videoId, force }
   */
  async function report(accountId, report, opts) {
    opts = opts || {};
    if (!core || !core.api || typeof core.api.studio !== 'function') {
      throw new Error('El módulo de analítica no está disponible — recargá la página.');
    }
    const days = Number(opts.days || 28);
    const key = cacheKey(accountId, report, days, opts.videoId);
    if (!opts.force) {
      const hit = cacheRead(key);
      if (hit) return hit;
    }
    const data = await core.api.studio('analytics_report', {
      account_id: accountId,
      report: report,
      days: days,
      video_id: opts.videoId || undefined,
    });
    cacheWrite(key, data);
    return data;
  }

  /** Suma una columna numérica de las filas (para totales y gráficos). */
  function sumColumn(rows, key) {
    if (!Array.isArray(rows)) return 0;
    let total = 0;
    rows.forEach(function (r) {
      const n = Number(r && r[key]);
      if (isFinite(n)) total += n;
    });
    return total;
  }

  NS.analytics = {
    REPORTS: REPORTS,
    LABELS: LABELS,
    report: report,
    labelFor: labelFor,
    formatValue: formatValue,
    isPercent: isPercent,
    isNeedsReconnect: isNeedsReconnect,
    sumColumn: sumColumn,
    /* Vacía la caché de reportes (botón "Actualizar" de la UI). */
    clearCache: function (accountId) {
      if (!core || !core.storage) return;
      try {
        const prefix = 'bh_yt_ana_';
        const keys = [];
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const k = window.sessionStorage.key(i);
          if (k && k.indexOf(prefix) === 0) keys.push(k);
        }
        keys.forEach(function (k) {
          if (!accountId || k.indexOf('bh_yt_ana_' + accountId + '_') === 0) {
            window.sessionStorage.removeItem(k);
          }
        });
      } catch (_) {}
    },
  };
})();
