// ============================================================
// supervision-notify — DEPRECADO (2026-10-12).
// Canal de notificaciones elegido: el digest semanal
// (supervision-digest, cron supervision-digest-weekly) a la casilla
// compartida de los dueños — un email por semana con todo el resumen.
// Este endpoint real-time por alerta nunca operó: el disparo SQL
// fallaba con URL NULL (current_setting) y fue retirado del motor
// (registro histórico: supervision_notify_failed 2026-08-29).
// Responde 410 Gone ante cualquier caller residual.
// ============================================================

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': 'https://bienenhaus.com.ar',
        'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }
  return new Response(
    JSON.stringify({
      error: 'supervision-notify deprecado: el canal de notificaciones es el digest semanal (supervision-digest)',
    }),
    { status: 410, headers: { 'Content-Type': 'application/json' } }
  );
});
