// ============================================================
// supervision-notifications — DEPRECADO (2026-10-12).
// Diseñado como push/email por alerta vía notification_preferences,
// pero esa tabla no tiene filas ni consumidor (y el destinatario de
// email estaba hardcodeado a una dirección inexistente). El canal
// elegido es el digest semanal (supervision-digest) a la casilla
// compartida de los dueños. Este endpoint quedó sin caller desde su
// creación. Responde 410 Gone ante cualquier caller residual.
// ============================================================

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': 'https://bienenhaus.com.ar',
        'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      },
    });
  }
  return new Response(
    JSON.stringify({
      error: 'supervision-notifications deprecado: el canal de notificaciones es el digest semanal (supervision-digest)',
    }),
    { status: 410, headers: { 'Content-Type': 'application/json' } }
  );
});
