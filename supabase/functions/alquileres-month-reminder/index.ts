// Recordatorio mensual del módulo "Administración de Alquileres" (Bloque 2.C).
//
// Cron los días 2 y 3 de cada mes (12:00 ART): si el mes ANTERIOR todavía no
// fue cerrado en el módulo (hist sin la clave 'YYYY-MM' del mes previo),
// envía un email al usuario del módulo para que no se atrase la
// administración. Dedupe por audit_log: un solo email por mes aunque el cron
// corra dos días.
//
// Auth: x-sync-secret (zernio_config key='sync_secret' — patrón
// supervision-digest/backup-snapshot, fix 20261015000004: las app.settings.*
// son NULL en este proyecto) o Authorization para disparo manual.
// verify_jwt OFF (está en NO_VERIFY de deploy.yml): el cron no manda JWT.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, jsonResponse, optionsResponse } from '../_shared/http.ts';

interface ReminderConfig {
  brevo_api_key?: string;
  brevo_sender_email?: string;
  brevo_sender_name?: string;
}

async function getConfig(supabase: ReturnType<typeof createClient>): Promise<ReminderConfig> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "integrations")
    .maybeSingle();

  const integrations = (data?.value || {}) as Record<string, string>;

  return {
    brevo_api_key: Deno.env.get("BREVO_API_KEY") || integrations.brevo_api_key,
    brevo_sender_email: Deno.env.get("BREVO_SENDER_EMAIL") || integrations.brevo_sender_email || "noreply@bienenhaus.com.ar",
    brevo_sender_name: Deno.env.get("BREVO_SENDER_NAME") || integrations.brevo_sender_name || "Bienenhaus Alquileres",
  };
}

async function sendBrevoEmail(
  config: ReminderConfig,
  to: string,
  subject: string,
  htmlContent: string,
  textContent: string
): Promise<{ success: boolean; error?: string }> {
  if (!config.brevo_api_key) {
    return { success: false, error: "Brevo API key not configured" };
  }
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": config.brevo_api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        sender: { email: config.brevo_sender_email, name: config.brevo_sender_name },
        to: [{ email: to }],
        subject,
        htmlContent,
        textContent,
      }),
    });
    if (!res.ok) {
      const result = await res.json().catch(() => ({}));
      return { success: false, error: `Brevo error: ${res.status} ${JSON.stringify(result)}` };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/* Mes anterior al actual, en ART (UTC-3), clave 'YYYY-MM' — el mismo formato
   de las claves de S.hist del módulo. */
function prevMonthYm(): { prevYm: string; prevLabel: string } {
  const nowArt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const prev = new Date(Date.UTC(nowArt.getUTCFullYear(), nowArt.getUTCMonth() - 1, 1));
  const y = prev.getUTCFullYear();
  const m = prev.getUTCMonth() + 1;
  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return { prevYm: `${y}-${String(m).padStart(2, '0')}`, prevLabel: `${MESES[m - 1]} ${y}` };
}

/* Inicio del mes actual en ART (para el dedupe de audit_log por mes). */
function currentMonthStartIso(): string {
  const nowArt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(nowArt.getUTCFullYear(), nowArt.getUTCMonth(), 1)).toISOString();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return optionsResponse(req);
  }
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, req);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  /* Mismo patrón de auth que supervision-digest (fix 20261015000004). */
  const syncSecret: string = await supabase
    .from("zernio_config")
    .select("value")
    .eq("key", "sync_secret")
    .maybeSingle()
    .then((r: any) => r.data?.value?.secret || "");
  const secretOk = !!syncSecret && req.headers.get("x-sync-secret") === syncSecret;
  const authHeader = req.headers.get("Authorization");
  if (!secretOk && !authHeader) {
    return jsonResponse(401, { error: 'Missing authorization' }, req);
  }

  try {
    const config = await getConfig(supabase);
    const { prevYm, prevLabel } = prevMonthYm();
    const monthStart = currentMonthStartIso();

    /* Usuarios con administración activa (props) a quienes falta cerrar el
       mes previo. Service role: atraviesa el RLS de alquileres_state. */
    const { data: rows, error: rowsErr } = await supabase
      .from("alquileres_state")
      .select("user_id, state, updated_at");
    if (rowsErr) throw rowsErr;

    const pendientes = (rows || []).filter((r: any) => {
      const st = r.state || {};
      if (!Array.isArray(st.props) || st.props.length === 0) return false;
      const hist = st.hist || {};
      return !hist[prevYm]; // el mes previo no fue cerrado
    });

    if (!pendientes.length) {
      return jsonResponse(200, { checked: (rows || []).length, pendientes: 0, reminded: 0, month: prevYm }, req);
    }

    /* Dedupe: un solo recordatorio por mes (el cron corre los días 2 y 3). */
    const { data: yaEnviados } = await supabase
      .from("audit_log")
      .select("user_id")
      .eq("action", "alq_month_reminder")
      .gte("created_at", monthStart);
    const yaSet = new Set((yaEnviados || []).map((a: any) => a.user_id));

    let reminded = 0;
    const detalles: Array<{ user_id: string; email?: string; ok: boolean; error?: string }> = [];

    for (const r of pendientes) {
      if (yaSet.has(r.user_id)) {
        detalles.push({ user_id: r.user_id, ok: false, error: 'ya notificado este mes' });
        continue;
      }

      let email = '';
      try {
        const { data: userData } = await supabase.auth.admin.getUserById(r.user_id);
        email = userData?.user?.email || '';
      } catch (_) { /* sin email → skip */ }
      if (!email) {
        detalles.push({ user_id: r.user_id, ok: false, error: 'sin email' });
        continue;
      }

      const propsN = Array.isArray(r.state?.props) ? r.state.props.length : 0;
      const dashboardUrl = "https://bienenhaus.com.ar/admin.html";
      const subject = `Bienenhaus — ¿Cerraste ${prevLabel}? (Administración de Alquileres)`;
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1b2a41;">
          <h2 style="margin:0 0 6px;">Administración de Alquileres</h2>
          <p style="margin:0 0 14px;color:#51607a;">Recordatorio automático del panel.</p>
          <p style="margin:0 0 10px;">El mes <b>${prevLabel}</b> todavía <b>no quedó cerrado</b> en el módulo
          (${propsN} propiedades bajo administración).</p>
          <p style="margin:0 0 16px;">Al cerrarlo quedan guardadas las órdenes, liquidaciones y la rendición
          del mes en el historial, y se genera un respaldo inmutable en la nube.</p>
          <p style="margin:0 0 22px;">
            <a href="${dashboardUrl}" style="background:#1FC8C3;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">Abrir el panel</a>
          </p>
          <p style="margin:0;color:#8E9BAE;font-size:12px;">Panel → Alquileres → "Cerrar mes y pasar al siguiente".</p>
        </div>`;
      const text = `¿Cerraste ${prevLabel}? El mes todavía no quedó cerrado en la Administración de Alquileres (${propsN} propiedades). Panel → Alquileres → "Cerrar mes y pasar al siguiente".`;

      const sent = await sendBrevoEmail(config, email, subject, html, text);

      await supabase.from("audit_log").insert({
        user_id: r.user_id,
        action: 'alq_month_reminder',
        module: 'alquileres',
        table_name: 'alquileres_state',
        status: sent.success ? 'success' : 'error',
        error_code: sent.success ? null : 'ALQ_REMINDER_SEND_FAIL',
        metadata: { prev_ym: prevYm, email, send_error: sent.error || null },
      });

      reminded++;
      detalles.push({ user_id: r.user_id, email, ok: sent.success, error: sent.error });
    }

    return jsonResponse(200, {
      checked: (rows || []).length,
      pendientes: pendientes.length,
      reminded,
      month: prevYm,
      detalles,
    }, req);
  } catch (e) {
    return jsonResponse(500, { error: String(e) }, req);
  }
});
