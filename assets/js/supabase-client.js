// ============================================
// BIENENHAUS PROPIEDADES - Supabase Client
// ============================================
// Uses the global `supabase` from CDN: https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2

(function () {
  'use strict';

  /* ------------------------------------------------
     DEBUG FLAG — false en producción, true solo en desarrollo
     ------------------------------------------------ */
  const DEBUG = false;

  function logError(...args) {
    if (DEBUG) console.error(...args);
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.BH_CONFIG;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    logError('[BH] Missing Supabase config. Check config.js');
    return;
  }

  // supabase is available globally from the CDN script
  if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
    logError('[BH] Supabase JS library not loaded. Check the CDN script tag.');
    return;
  }

  /* Timeout de red: sin esto, una query colgada (IO throttled o red caída)
     deja el panel en "Cargando…" indefinidamente. 10s es suficiente para
     las queries del panel y corta antes de que el request se acumule.
     No se pisa una signal que ya venga en options (abort manual). */
  const fetchWithTimeout = (url, options) => {
    const opts = Object.assign({}, options || {});
    if (!opts.signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(10000);
    }
    return fetch(url, opts);
  };

  window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'public' },
    global: {
      fetch: fetchWithTimeout
    },
    realtime: {
      /* Sin tope, ML puede disparar ráfagas de miles de eventos y el canal
         se satura. 10/s alcanza para refrescar el panel con debounce. */
      params: { eventsPerSecond: 10 }
    }
  });
})();
