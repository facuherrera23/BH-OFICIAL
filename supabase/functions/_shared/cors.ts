// CORS headers estándar para Edge Functions.
// Patrón idéntico al CORS_HEADERS de manage-users/index.ts.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};