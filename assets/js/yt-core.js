/* ============================================================
   BIENENHAUS PROPIEDADES — Núcleo del módulo CONTENIDO (YouTube)
   ------------------------------------------------------------
   Punto ÚNICO de entrada para todos los submódulos del módulo
   (yt-seo-tools, yt-publish, yt-analytics, yt-comments, yt-ops,
   yt-integrations). Concentra lo que antes se reimplementaba en
   cada lado y que terminaba divergiendo:

     · api      → llamada a las Edge Functions (timeout, reintentos
                  con backoff, clasificación de errores en español,
                  detección de cuota agotada de Google).
     · state    → estado compartido (cuentas, canal, videos, cola).
     · bus      → eventos. Los módulos se AVISAN entre sí por bus en
                  vez de llamarse directamente: es lo que evita que
                  dos features se pisen (un módulo no depende del
                  orden de carga ni del estado interno de otro).
     · storage  → localStorage/sessionStorage con namespace.
     · remote   → app_settings compartido entre dispositivos (lo
                  escribe la Edge Function con service_role: el
                  cliente no puede escribir app_settings por RLS).
     · audit    → trazas en audit_log (también vía server).

   Expone: window.BH_YT.core
   ============================================================ */
(function () {
  'use strict';

  const NS = (window.BH_YT = window.BH_YT || {});

  const FN_BASE = ((window.BH_CONFIG && window.BH_CONFIG.SUPABASE_URL) || '') + '/functions/v1';
  const DEFAULT_TIMEOUT = 30000;
  const DEFAULT_RETRIES = 2;
  const STORAGE_PREFIX = 'bh_yt_';

  /* ============================================================
     UTILS — helpers puros (sin estado, sin DOM)
     ============================================================ */
  /* Tabla de escape HTML.
     Las entidades se arman con String.fromCharCode (y no como literales)
     para que ningún editor/encoding pueda corromperlas: el mismo criterio
     que usa el harness de tests del repo. */
  const ESC_MAP = {
    '&': String.fromCharCode(38) + 'amp;',
    '<': String.fromCharCode(38) + 'lt;',
    '>': String.fromCharCode(38) + 'gt;',
    '"': String.fromCharCode(38) + 'quot;',
    "'": String.fromCharCode(38) + '#39;',
  };

  const utils = {
    /** Escapa HTML. Escaping SIEMPRE antes de innerHTML (regla del repo). */
    esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return ESC_MAP[ch]; });
    },

    /** minúsculas + sin acentos: comparaciones insensibles. */
    norm(s) {
      return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    },

    /** Recorta a N caracteres y limpia caracteres de control. */
    clip(s, max) {
      return String(s == null ? '' : s)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ')
        .trim()
        .slice(0, max);
    },

    /** Número con separador de miles (es-AR). */
    fmtNum(n) {
      const v = Number(n || 0);
      return v.toLocaleString('es-AR');
    },

    /** ISO → valor de <input type="datetime-local"> (hora local del navegador). */
    toLocalInput(iso) {
      const d = iso ? new Date(iso) : null;
      if (!d || isNaN(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    },

    /** ISO → texto legible corto (fallback si el panel no formatea). */
    fmtDate(iso) {
      const d = iso ? new Date(iso) : null;
      if (!d || isNaN(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    },

    /** Debounce (no cancelable: devuelve la fn con .cancel()). */
    debounce(fn, ms) {
      let t = null;
      const wrapped = function () {
        const args = arguments;
        const self = this;
        clearTimeout(t);
        t = setTimeout(function () { fn.apply(self, args); }, ms);
      };
      wrapped.cancel = function () { clearTimeout(t); };
      return wrapped;
    },

    /** Descarga un texto como archivo local (sin backend). */
    downloadText(filename, text, mime) {
      const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    },

    /** Construye un CSV con BOM (Excel en español lo abre bien). */
    toCsv(rows) {
      return '\uFEFF' + rows.map(function (r) {
        return r.map(function (c) {
          return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"';
        }).join(';');
      }).join('\r\n');
    },
  };

  /* ============================================================
     BUS — eventos entre módulos (sin acoplamiento directo)
     ============================================================ */
  const listeners = Object.create(null);

  function on(evt, fn) {
    if (typeof fn !== 'function') return function () {};
    (listeners[evt] || (listeners[evt] = [])).push(fn);
    return function () { off(evt, fn); };
  }

  function off(evt, fn) {
    const arr = listeners[evt];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  function emit(evt, payload) {
    const arr = listeners[evt];
    if (!arr || !arr.length) return;
    /* Copia: un listener puede desuscribirse durante la emisión. */
    arr.slice().forEach(function (fn) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[BH_YT] listener de "' + evt + '" falló:', err);
      }
    });
  }

  /* ============================================================
     STATE — estado compartido del módulo
     ============================================================ */
  const state = {
    accounts: [],        // social_accounts (youtube)
    accountId: null,     // cuenta activa
    channel: null,       // datos del canal (subs, views, handle…)
    videos: [],          // inventario del canal
    canManage: false,    // ¿la conexión tiene youtube.force-ssl?
    total: 0,            // videos reales del canal
    truncated: false,    // el inventario está truncado
    history: [],         // social_posts (historial)
    queue: [],           // cola de publicación (#8)
    props: [],           // propiedades para vincular (#1)
  };

  function setState(patch) {
    Object.assign(state, patch || {});
    emit('state', state);
  }

  /* ============================================================
     API — Edge Functions
     ============================================================ */
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /** Backoff exponencial con jitter: 400ms, 1.2s, 3.6s… */
  function backoff(attempt) {
    const base = 400 * Math.pow(3, attempt);
    return base + Math.floor(Math.random() * 250);
  }

  async function authHeaders() {
    const client = window.supabaseClient;
    if (!client || !client.auth) throw new Error('No hay sesión activa');
    const { data, error } = await client.auth.getSession();
    if (error || !data || !data.session) throw new Error('No hay sesión activa — volvé a iniciar sesión');
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + data.session.access_token,
    };
  }

  /** Clasifica el error de la Edge Function / de Google. */
  function buildHttpError(status, json) {
    const raw = String((json && json.error) || ('HTTP ' + status));
    const err = new Error(raw);
    err.status = status;
    if (raw === 'needs_reconnect') err.code = 'needs_reconnect';
    else if (/quotaExceeded|dailyLimitExceeded|quota/i.test(raw)) err.code = 'quota';
    else if (/not found|no encontrada|no existe/i.test(raw) && status === 404) err.code = 'not_found';
    return err;
  }

  /**
   * Llamada a una Edge Function con timeout + reintentos.
   * - Reintenta errores de RED, 5xx y 429 (con backoff).
   * - NO reintenta 4xx (son deterministas: corregir y volver a intentar).
   * - Traduce el fallo a un mensaje en español que el dueño entienda.
   */
  async function edgeCall(fnName, body, opts) {
    opts = opts || {};
    const timeout = opts.timeout || DEFAULT_TIMEOUT;
    const retries = opts.retries != null ? opts.retries : DEFAULT_RETRIES;
    const headers = await authHeaders();

    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, timeout);
      let res = null;
      let netErr = null;
      try {
        res = await fetch(FN_BASE + '/' + fnName, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        netErr = err;
      } finally {
        clearTimeout(timer);
      }

      if (res) {
        const json = await res.json().catch(function () { return {}; });
        if (res.ok) return json;
        const err = buildHttpError(res.status, json);
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw err;
      }

      /* Fallo de red o timeout */
      const err = (netErr && netErr.name === 'AbortError')
        ? Object.assign(new Error('La consulta a YouTube tardó demasiado — revisá la conexión e intentá de nuevo.'), { code: 'timeout' })
        : Object.assign(new Error('No se pudo conectar con el servidor — revisá la conexión.'), { code: 'network' });
      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw err;
    }
    throw new Error('La consulta falló');
  }

  /** Llamada al backend del Studio (social-youtube-studio). */
  function studio(action, payload, opts) {
    return edgeCall('social-youtube-studio', Object.assign({ action }, payload || {}), opts);
  }

  /** Llamada al backend de publicación (social-publish-youtube). */
  function publish(action, payload, opts) {
    return edgeCall('social-publish-youtube', Object.assign({ action }, payload || {}), opts);
  }

  /* ============================================================
     STORAGE — local (navegador) y remoto (app_settings compartido)
     ============================================================ */
  function readJson(store, key, fallback) {
    try {
      const raw = store.getItem(STORAGE_PREFIX + key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(store, key, value) {
    try {
      store.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false; // almacenamiento lleno o bloqueado (modo privado)
    }
  }

  const storage = {
    get(key, fallback) { return readJson(window.localStorage, key, fallback); },
    set(key, value) { return writeJson(window.localStorage, key, value); },
    remove(key) { try { window.localStorage.removeItem(STORAGE_PREFIX + key); } catch (_) {} },
    /* sessionStorage: cache de una sesión (se pierde al cerrar la pestaña) */
    sessionGet(key, fallback) { return readJson(window.sessionStorage, key, fallback); },
    sessionSet(key, value) { return writeJson(window.sessionStorage, key, value); },
    sessionRemove(key) { try { window.sessionStorage.removeItem(STORAGE_PREFIX + key); } catch (_) {} },
  };

  /**
   * app_settings compartido entre dispositivos (lo escribe la Edge Function
   * con service_role — el cliente NO puede escribir app_settings por RLS).
   * Falla en silencio: si el server no está, la app sigue funcionando con
   * los valores por defecto.
   */
  const remote = {
    async get(key, fallback) {
      try {
        const res = await studio('settings_get', { key });
        return res && res.value !== undefined && res.value !== null ? res.value : fallback;
      } catch (_) {
        return fallback;
      }
    },
    async set(key, value) {
      try {
        await studio('settings_set', { key, value });
        return true;
      } catch (_) {
        return false;
      }
    },
  };

  /* ============================================================
     AUDIT — trazas en audit_log (vía server: RLS no permite al cliente)
     ============================================================ */
  async function audit(action, opts) {
    opts = opts || {};
    try {
      /* El server usa body.action para despachar y body.audit_action para el
         nombre real de la acción auditada (colisión evitada a propósito). */
      await studio('audit_log', {
        audit_action: action,
        module: opts.module || 'contenido',
        table_name: opts.tableName || opts.table_name || 'social_posts',
        record_id: opts.recordId || opts.record_id || null,
        status: opts.status || 'success',
        error_code: opts.errorCode || opts.error_code || null,
        metadata: opts.metadata || null,
      });
      return true;
    } catch (_) {
      /* La auditoría NUNCA bloquea la acción del dueño. */
      return false;
    }
  }

  /* ============================================================
     EXPORT
     ============================================================ */
  NS.core = {
    utils,
    state,
    setState,
    on,
    off,
    emit,
    api: { studio, publish, edgeCall },
    storage,
    remote,
    audit,
    FN_BASE,
  };
})();
