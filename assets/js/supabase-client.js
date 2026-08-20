// ============================================
// BIENENHAUS PROPIEDADES - Supabase Client
// ============================================
// Uses the global `supabase` from CDN: https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2

(function () {
  'use strict';

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.BH_CONFIG;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('[BH] Missing Supabase config. Check config.js');
    return;
  }

  // supabase is available globally from the CDN script
  if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
    console.error('[BH] Supabase JS library not loaded. Check the CDN script tag.');
    return;
  }

  window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
})();
