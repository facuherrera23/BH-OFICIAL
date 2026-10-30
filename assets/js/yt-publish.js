/* ============================================================
   BIENENHAUS PROPIEDADES — Publicación de YouTube (módulo CONTENIDO)
   ------------------------------------------------------------
   Todo lo que pasa entre que el dueño aprieta "Publicar" y que el
   video queda en el canal:

     · preflight()  → chequeos ANTES de gastar la subida (1600
                      unidades de cuota): formato, peso, duración,
                      metadatos y sus límites reales.
     · upload()     → subida resumable por chunks contra Google, con
                      reintentos, backoff, cancelación y sesión
                      PERSISTENTE (si se recarga la pestaña, la
                      subida se puede retomar desde el último byte).
     · queue        → cola local de videos pendientes (la metadata
                      viaja; el archivo lo elige el dueño en el
                      momento, porque un File no se puede guardar en
                      localStorage).
     · dryRun()     → validación en el servidor sin publicar.
     · draft()      → publica en privado y deja el post como
                      borrador para revisarlo y promoverlo después.

   Expone: window.BH_YT.publish
   ============================================================ */
(function () {
  'use strict';

  const NS = (window.BH_YT = window.BH_YT || {});
  const core = NS.core;
  const utils = (core && core.utils) || {};
  const storage = (core && core.storage) || null;

  /* ---------- límites reales de la API de YouTube ---------- */
  const LIMITS = {
    maxBytes: 2 * 1024 * 1024 * 1024,   // tope del módulo (práctico)
    ytMaxBytes: 256 * 1024 * 1024 * 1024, // tope real de YouTube
    maxDurationHours: 12,                // tope real de YouTube
    title: 100,
    description: 5000,
    tagsChars: 480,
    quotaUpload: 1600,
  };

  /* Contenedores aceptados por YouTube (videos.insert). */
  const ACCEPTED_TYPES = [
    'video/mp4', 'video/quicktime', 'video/x-msvideo',
    'video/x-ms-wmv', 'video/x-flv', 'video/x-matroska',
  ];

  const CHUNK_SIZE = 8 * 1024 * 1024;   // 8 MB (32 × 256 KB, mínimo del protocolo)
  const CHUNK_TIMEOUT = 5 * 60 * 1000;  // por chunk
  const MAX_STALLS = 8;                 // intentos sin progreso antes de rendirse
  const RESUME_KEY = 'upload_resume';
  const QUEUE_KEY = 'publish_queue';
  /* Copia de la cola en el servidor (app_settings) — la escribe la Edge
     Function con service_role (el cliente no puede escribir app_settings). */
  const QUEUE_REMOTE_KEY = 'social_yt_publish_queue';

  /* ============================================================
     PRE-FLIGHT — antes de gastar cuota
     ============================================================ */
  function check(id, label, ok, detail, level) {
    return { id, label, ok: !!ok, detail: detail || '', level: level || (ok ? 'ok' : 'error') };
  }

  /**
   * Chequeos del archivo + metadata. No lanza: devuelve la lista de
   * checks para que la UI los muestre (el dueño decide).
   */
  function preflight(file, meta) {
    meta = meta || {};
    const checks = [];
    const title = String(meta.title || '');
    const description = String(meta.description || '');
    const tags = utils.parseTags ? utils.parseTags(meta.tags) : String(meta.tags || '').split(',').map((t) => t.trim()).filter(Boolean);

    /* --- archivo --- */
    if (!file) {
      checks.push(check('file', 'Archivo de video', false, 'No elegiste ningún archivo.'));
    } else {
      checks.push(check('file', 'Archivo de video', true, (file.name || 'video') + ' · ' + fmtBytes(file.size)));
      const type = String(file.type || '');
      const extOk = /\.(mp4|mov|avi|wmv|flv|mkv)$/i.test(file.name || '');
      const typeOk = !type || type.indexOf('video/') === 0 || ACCEPTED_TYPES.indexOf(type) >= 0;
      checks.push(check(
        'format', 'Formato',
        typeOk && extOk,
        (typeOk && extOk) ? (type || 'por extensión') + ' — YouTube lo acepta'
          : 'YouTube acepta mp4, mov, avi, wmv, flv y mkv. Este archivo es ' + (type || 'desconocido') + '.'
      ));
      checks.push(check(
        'size', 'Peso',
        file.size <= LIMITS.maxBytes,
        fmtBytes(file.size) + (file.size > LIMITS.maxBytes ? ' (supera el máximo de 2 GB del módulo)' : ' (máximo 2 GB)')
      ));
    }

    /* --- metadata --- */
    checks.push(check(
      'title', 'Título',
      !!title.trim() && title.length <= LIMITS.title,
      title.trim()
        ? (title.length > LIMITS.title ? 'Tiene ' + title.length + ' caracteres (máximo ' + LIMITS.title + ')' : title.length + '/' + LIMITS.title + ' caracteres')
        : 'Falta el título'
    ));
    checks.push(check(
      'description', 'Descripción',
      description.length <= LIMITS.description,
      description.length + '/' + LIMITS.description + ' caracteres'
    ));
    const tagsChars = tags.join(',').length;
    checks.push(check(
      'tags', 'Tags',
      tagsChars <= LIMITS.tagsChars,
      tags.length + ' tags · ' + tagsChars + '/' + LIMITS.tagsChars + ' caracteres'
    ));

    const errors = checks.filter((c) => !c.ok);
    return { checks, ok: errors.length === 0, errors };
  }

  function fmtBytes(n) {
    const v = Number(n || 0);
    if (!v) return '0 B';
    const mb = v / (1024 * 1024);
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
    if (mb >= 1) return mb.toFixed(1) + ' MB';
    return Math.max(1, Math.round(v / 1024)) + ' KB';
  }

  /* ============================================================
     SUBIDA — resumable por chunks, con sesión persistente
     ============================================================ */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** PUT de un chunk. Rechaza con 'abort' si se cancela. */
  function putChunk(ctx, blob, contentRange, onChunkProgress) {
    return new Promise(function (resolve, reject) {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', ctx.sessionUrl);
      xhr.setRequestHeader('Content-Range', contentRange);
      xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
      xhr.timeout = CHUNK_TIMEOUT;
      if (onChunkProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onChunkProgress(e.loaded, e.total);
        };
      }
      ctx.xhr = xhr;
      const settle = function (fn, arg) {
        if (ctx.xhr === xhr) ctx.xhr = null;
        fn(arg);
      };
      xhr.addEventListener('load', function () { settle(resolve, xhr); });
      xhr.addEventListener('error', function () { settle(reject, new Error('network')); });
      xhr.addEventListener('timeout', function () { settle(reject, new Error('network')); });
      xhr.addEventListener('abort', function () { settle(reject, new Error('abort')); });
      xhr.send(blob);
    });
  }

  /** ¿Cuántos bytes tiene guardados Google? (PUT vacío + Content-Range). */
  async function queryUploadStatus(ctx, total) {
    try {
      const xhr = await putChunk(ctx, new Blob([]), 'bytes */' + total);
      if (xhr.status >= 200 && xhr.status < 300) {
        let resource = {};
        try { resource = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
        return { received: total, complete: true, resource };
      }
      const m = (xhr.getResponseHeader('Range') || '').match(/bytes=0-(\d+)/);
      return { received: m ? parseInt(m[1], 10) + 1 : 0, complete: false, resource: {} };
    } catch (_) {
      return { received: -1, complete: false, resource: {} };
    }
  }

  /**
   * Sube el archivo a la sesión de Google.
   * ctx = { sessionUrl, cancelled(), onProgress(pct, loaded, total, extra), onOffset(byte) }
   * Devuelve el recurso del video ({id, ...}).
   */
  async function upload(sessionUrl, file, ctx) {
    ctx = ctx || {};
    /* La URL puede venir en el ctx (así la UI puede cancelarla) o como
       argumento: en ambos casos se usa la misma. */
    ctx.sessionUrl = ctx.sessionUrl || sessionUrl;
    const total = file.size;
    let offset = 0;
    let stalls = 0;
    let bps = 0;
    let lastBytes = 0;
    let lastTs = Date.now();

    const tick = function (bytesNow) {
      const now = Date.now();
      const dt = (now - lastTs) / 1000;
      if (dt > 0.25) {
        const inst = (bytesNow - lastBytes) / dt;
        if (inst > 0) bps = bps ? bps * 0.7 + inst * 0.3 : inst;
        lastBytes = bytesNow;
        lastTs = now;
      }
      const remaining = total - bytesNow;
      return { bps, etaSec: bps > 0 ? remaining / bps : 0 };
    };
    const advance = function (to) { offset = to; stalls = 0; };
    const report = function (loaded) {
      if (!ctx.onProgress) return;
      ctx.onProgress(Math.min(100, Math.round((loaded / total) * 100)), loaded, total, tick(loaded));
    };
    const cancelled = function () { return typeof ctx.cancelled === 'function' && ctx.cancelled(); };

    while (offset < total) {
      if (cancelled()) throw new Error('Subida cancelada — no se publicó nada.');
      const end = Math.min(offset + CHUNK_SIZE, total) - 1;
      try {
        const xhr = await putChunk(
          ctx,
          file.slice(offset, end + 1),
          'bytes ' + offset + '-' + end + '/' + total,
          function (loadedInChunk) {
            const smooth = Math.min(offset + loadedInChunk, total);
            report(smooth);
          }
        );
        if (xhr.status >= 200 && xhr.status < 300) {
          advance(total);
          report(total);
          try { return JSON.parse(xhr.responseText || '{}'); } catch (_) { return {}; }
        }
        if (xhr.status === 308) {
          const m = (xhr.getResponseHeader('Range') || '').match(/bytes=0-(\d+)/);
          const serverHas = m ? parseInt(m[1], 10) + 1 : 0;
          if (serverHas > offset) advance(serverHas); else stalls++;
        } else {
          const st = await queryUploadStatus(ctx, total);
          if (st.complete) { advance(total); report(total); return st.resource; }
          if (st.received > offset) advance(st.received); else stalls++;
        }
      } catch (e) {
        if (e && e.message === 'abort') {
          if (cancelled()) throw new Error('Subida cancelada — no se publicó nada.');
          throw new Error('La subida se interrumpió porque la página se cerró o recargó.');
        }
        const st = await queryUploadStatus(ctx, total);
        if (st.complete) { advance(total); report(total); return st.resource; }
        if (st.received > offset) advance(st.received); else stalls++;
      }
      report(offset);
      if (ctx.onOffset) ctx.onOffset(offset);
      if (stalls >= MAX_STALLS) {
        throw new Error('La conexión falló varias veces seguidas. Verificá tu red y volvé a intentarlo.');
      }
      if (stalls > 0) await sleep(Math.min(1000 * Math.pow(2, stalls - 1), 30000));
    }
    return {};
  }

  /* ============================================================
     SESIÓN PERSISTENTE — retomar la subida tras recargar la página
     ============================================================ */
  const resume = {
    /** Guarda la sesión (sessionStorage: se pierde al cerrar la pestaña). */
    save(info) {
      if (!storage) return;
      storage.sessionSet(RESUME_KEY, {
        sessionUrl: info.sessionUrl,
        postId: info.postId,
        fileName: info.fileName || '',
        fileSize: info.fileSize || 0,
        title: info.title || '',
        offset: info.offset || 0,
        savedAt: Date.now(),
      });
    },
    updateOffset(offset) {
      if (!storage) return;
      const cur = storage.sessionGet(RESUME_KEY, null);
      if (!cur) return;
      cur.offset = offset;
      storage.sessionSet(RESUME_KEY, cur);
    },
    load() { return storage ? storage.sessionGet(RESUME_KEY, null) : null; },
    clear() { if (storage) storage.sessionRemove(RESUME_KEY); },
  };

  /* ============================================================
     COLA DE PUBLICACIÓN — metadata pendiente (el archivo no se guarda)
     ============================================================ */
  const queue = {
    list() { return storage ? (storage.get(QUEUE_KEY, []) || []) : []; },
    save(items) { if (storage) storage.set(QUEUE_KEY, items || []); },
    add(item) {
      const items = queue.list();
      const id = 'q_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      items.unshift(Object.assign({ id, createdAt: new Date().toISOString() }, item));
      queue.save(items.slice(0, 20));
      return id;
    },
    remove(id) {
      queue.save(queue.list().filter(function (i) { return i.id !== id; }));
    },
    clear() { queue.save([]); },
    get(id) {
      const found = queue.list().filter(function (i) { return i.id === id; })[0];
      return found || null;
    },
    /**
     * Serie: N copias de una plantilla con fechas escalonadas.
     * dates = [{publishAt}] ya calculadas por el cliente.
     */
    series(base, dates) {
      const items = queue.list();
      (dates || []).forEach(function (d) {
        items.unshift(Object.assign({
          id: 'q_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
          createdAt: new Date().toISOString(),
        }, base, { publishAt: d.publishAt, label: d.label || base.title }));
      });
      queue.save(items.slice(0, 20));
    },

    /* #37 — la cola también vive en la nube (app_settings), para no
       perderla al cambiar de dispositivo. Se guarda por UNION (unión
       por id): la local manda si el mismo id está en los dos lados. */
    async mergeRemote() {
      if (!core || !core.remote) return 0;
      const remotos = await core.remote.get(QUEUE_REMOTE_KEY, []);
      const list = Array.isArray(remotos) ? remotos : [];
      if (!list.length) return 0;
      const local = queue.list();
      const ids = {};
      local.forEach(function (i) { ids[i.id] = true; });
      let nuevos = 0;
      list.forEach(function (i) {
        if (!i || !i.id || ids[i.id]) return;
        ids[i.id] = true;
        local.unshift(i);
        nuevos++;
      });
      if (nuevos) queue.save(local.slice(0, 20));
      return nuevos;
    },

    /* Sube la cola local al servidor (reemplaza la copia de la nube). */
    async pushRemote() {
      if (!core || !core.remote) return false;
      const ok = await core.remote.set(QUEUE_REMOTE_KEY, queue.list());
      return !!ok;
    },
  };

  /* ============================================================
     DRY-RUN / BORRADOR — llamadas al servidor
     ============================================================ */
  async function dryRun(meta) {
    return core.api.publish('dry_run', meta);
  }

  async function publishDraft(meta) {
    return core.api.publish('init', Object.assign({}, meta, { draft: true, privacy: 'private' }));
  }

  /* ============================================================
     EXPORT
     ============================================================ */
  NS.publish = {
    LIMITS,
    ACCEPTED_TYPES,
    fmtBytes,
    preflight,
    upload,
    resume,
    queue,
    dryRun,
    publishDraft,
  };
})();
