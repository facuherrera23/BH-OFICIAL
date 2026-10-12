// ============================================================
// supervision-ml-anomaly — DEPRECADO (2026-10-12).
// La detección de anomalías opera por SQL directo: el cron
// supervision-anomalies-15min ejecuta detect_supervision_anomalies()
// cada 15 minutos (corriendo en verde). Este endpoint duplicaba esa
// lógica por HTTP sin ningún caller y con verify_jwt OFF.
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
      error: 'supervision-ml-anomaly deprecado: las anomalías las detecta el cron SQL supervision-anomalies-15min',
    }),
    { status: 410, headers: { 'Content-Type': 'application/json' } }
  );
});
