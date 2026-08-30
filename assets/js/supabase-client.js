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

  window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
})();
