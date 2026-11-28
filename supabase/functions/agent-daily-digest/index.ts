// ============================================================
// agent-daily-digest — Resumen diario para agentes (2026-11-28)
// ============================================================
// "Mi día" (P1-8) responde en el CRM: ¿qué hago ahora? — las 3 acciones
// más urgentes, en orden, con los conteos aparte. PERO hay que abrir el
// panel para verlo. Este cron lo lleva al mail a las 08:00 ART.
//
// Diseño:
//  · Cron pg_cron → net.http_post con x-sync-secret (zernio_config), igual
//    que lead-tasks-reminder / alquileres-month-reminder. verify_jwt OFF →
//    la función DEBE estar en NO_VERIFY de deploy.yml.
//  · Un destinatario por AGENTE ACTIVO (agents.status='activo', sin borrar)
//    con profile activo y email (profile.email, fallback agents.email).
//  · El top 3 NO se recalcula acá: se llama a la RPC `mi_dia(p_user_id)`,
//    la MISMA que abre el botón del CRM. Si mañana cambia la urgencia,
//    el mail cambia solo (cero duplicación de reglas de negocio).
//  · Dedupe por día en `crm_envios` (origen='agent_daily_digest', estado
//    'enviado', agente_id, fecha ART). Un fallo SÍ se reintenta el mismo día;
//    un 'enviado' no se duplica. `force:true` (con secret) permite reenviar.
//  · `dry_run:true` (con secret) calcula TODO contra producción y NO envía
//    ni escribe traza. Es el camino de verificación seguro.
//  · La traza usa `_shared/envios.ts` → un error dispara la alerta
//    `crm_email_broken` existente (la red de seguridad del P0-4).
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { registrarEnvio } from '../_shared/envios.ts';

interface Config {
  brevo_api_key?: string;
  brevo_sender_email?: string;
  brevo_sender_name?: string;
  dashboard_url?: string;
}

interface MiDiaItem {
  tipo?: string;
  titulo?: string;
  detalle?: string;
  nombre?: string;
  telefono?: string | null;
  fecha?: unknown;
  lead_id?: string;
}

interface MiDiaPayload {
  ok?: boolean;
  error?: string;
  agente?: string | null;
  items?: MiDiaItem[];
  conteos?: Record<string, number>;
  total?: number;
}

/** Agenda de los próximos días: la calcula la RPC, NO se reimplementa acá. */
interface AgendaItem {
  tipo?: string;
  fecha?: unknown;
  nombre?: string | null;
  telefono?: string | null;
  titulo?: string;
  detalle?: string;
}

interface AgendaPayload {
  ok?: boolean;
  error?: string;
  visitas?: AgendaItem[];
  tareas?: AgendaItem[];
  conteos?: Record<string, number>;
  dias?: number;
}

interface Agente {
  id: string;
  full_name: string;
  email: string | null;
  profile_id: string | null;
}

interface Perfil {
  id: string;
  email: string | null;
  is_active: boolean | null;
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[c] ?? c;
  });
}

function telHref(v: unknown): string {
  return String(v ?? '').replace(/[^\d+]/g, '');
}

/** Fecha de hoy en ART en formato YYYY-MM-DD (la DB y el mail hablan ART). */
function fechaArt(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function fmtFecha(iso: unknown): string {
  if (!iso) return '';
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function getConfig(supabase: any): Promise<Config> {
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'integrations')
    .maybeSingle();
  const integrations = (data?.value || {}) as Record<string, string>;

  return {
    brevo_api_key: Deno.env.get('BREVO_API_KEY') || integrations.brevo_api_key,
    brevo_sender_email:
      Deno.env.get('BREVO_SENDER_EMAIL') || integrations.brevo_sender_email || 'noreply@bienenhaus.com.ar',
    brevo_sender_name:
      Deno.env.get('BREVO_SENDER_NAME') || integrations.brevo_sender_name || 'Bienenhaus CRM',
    dashboard_url: Deno.env.get('DASHBOARD_URL') || 'https://bienenhaus.com.ar/admin.html',
  };
}

async function sendBrevoEmail(
  config: Config,
  to: string,
  subject: string,
  html: string,
  text: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!config.brevo_api_key) return { success: false, error: 'Brevo API key not configured' };
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': config.brevo_api_key,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: config.brevo_sender_email, name: config.brevo_sender_name },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return { success: false, error: `Brevo error: ${res.status} ${err.slice(0, 300)}` };
    }
    const result = await res.json().catch(() => ({}));
    return { success: true, messageId: result?.messageId };
  } catch (err) {
    return { success: false, error: `Brevo exception: ${(err as Error).message}` };
  }
}

const CONTEO_LBL: Record<string, string> = {
  visitas: 'visitas hoy',
  visitas_semana: 'visitas esta semana',
  esperas: 'en espera',
  seguimientos: 'seguimientos vencidos',
  tareas: 'tareas vencidas',
  sin_contacto: 'sin contacto',
};

function buildContent(
  payload: MiDiaPayload,
  agenda: AgendaPayload,
  nombre: string,
  fecha: string,
  url: string,
) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const conteos = payload.conteos || {};
  const total = Number(payload.total ?? items.length ?? 0);

  const resumenPartes = Object.entries(conteos)
    .filter(([k, v]) => CONTEO_LBL[k] && Number(v) > 0)
    .map(([k, v]) => `${Number(v)} ${CONTEO_LBL[k]}`);
  const resumen = resumenPartes.length ? resumenPartes.join(' · ') : 'Nada pendiente por ahora';

  let itemRowsHtml = '';
  if (items.length) {
    itemRowsHtml = items
      .map((it, i) => {
        const tel = it.telefono ? String(it.telefono) : '';
        const telLink = telHref(tel);
        const fechaTxt = fmtFecha(it.fecha);
        return `
        <tr>
          <td style="width:34px;vertical-align:top;padding:14px 0;border-bottom:1px solid #eee;">
            <span style="display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;border-radius:50%;background:#1FC8C3;color:#062b2a;font-weight:800;font-size:12px;">${i + 1}</span>
          </td>
          <td style="padding:14px 0;border-bottom:1px solid #eee;">
            <div style="font-size:15px;font-weight:700;color:#111;">${esc(it.titulo || it.tipo || 'Acción pendiente')}</div>
            ${it.nombre ? `<div style="margin-top:3px;font-size:13px;color:#444;">${esc(it.nombre)}</div>` : ''}
            ${it.detalle ? `<div style="margin-top:3px;font-size:12px;color:#777;">${esc(it.detalle)}</div>` : ''}
            ${fechaTxt ? `<div style="margin-top:3px;font-size:12px;color:#777;">${esc(fechaTxt)}</div>` : ''}
          </td>
          <td style="padding:14px 0 14px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">
            ${telLink ? `<a href="tel:${esc(telLink)}" style="font-size:13px;font-weight:700;color:#0f766e;text-decoration:none;">${esc(tel)}</a>` : ''}
          </td>
        </tr>`;
      })
      .join('');
  } else {
    itemRowsHtml = `
        <tr><td style="padding:22px 0;text-align:center;color:#0f766e;font-weight:700;font-size:14px;">
          ✅ Todo al día: no hay acciones urgentes para hoy.
        </td></tr>`;
  }

  /* Agenda: la trae mi_dia_agenda (mismo alcance por rol que mi_dia). Si no
     hay nada, se dice en claro: un bloque vacío parece un bug del cron. */
  const agendaItems: AgendaItem[] = [
    ...(Array.isArray(agenda.visitas) ? agenda.visitas : []),
    ...(Array.isArray(agenda.tareas) ? agenda.tareas : []),
  ];
  const agendaHtml = agendaItems.length
    ? agendaItems
        .map((a) => {
          const when = fmtFecha(a.fecha);
          return `
        <div style="padding:8px 0;border-bottom:1px solid #f1f1f1;">
          <div style="font-size:13px;font-weight:700;color:#222;">${esc(a.titulo || a.tipo || 'Pendiente')}</div>
          ${a.nombre ? `<div style="margin-top:2px;font-size:12px;color:#555;">${esc(a.nombre)}</div>` : ''}
          ${a.detalle || when ? `<div style="margin-top:2px;font-size:11px;color:#888;">${esc([when, a.detalle].filter(Boolean).join(' · '))}</div>` : ''}
        </div>`;
        })
        .join('')
    : '<div style="padding:8px 0;font-size:12px;color:#777;">Sin visitas ni tareas en los próximos 3 días.</div>';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f4;">
  <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <div style="background:#0b1a1c;padding:22px 24px;text-align:center;">
      <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,.75);">BIENENHAUS CRM</div>
      <div style="margin-top:6px;font-size:22px;font-weight:800;color:#fff;">Tu día de hoy</div>
      <div style="margin-top:4px;font-size:12px;color:#1FC8C3;">${esc(fecha)} · ${esc(nombre || 'Agente')}</div>
    </div>
    <div style="padding:26px 24px 8px;">
      <p style="margin:0 0 14px;font-size:14px;color:#444;">
        Estas son las <strong>3 acciones más urgentes</strong> de tu panel. No hace falta abrir la bandeja completa para empezar.
      </p>
      <table style="width:100%;border-collapse:collapse;">${itemRowsHtml}</table>
      <p style="margin:18px 0 0;font-size:12px;color:#777;">
        <strong>Pendiente además:</strong> ${esc(resumen)}.
      </p>
      <div style="margin-top:18px;border-top:1px solid #eee;padding-top:14px;">
        <div style="font-size:13px;font-weight:800;color:#111;margin-bottom:4px;">Agenda · próximos 3 días</div>
        ${agendaHtml}
      </div>
    </div>
    <div style="padding:22px 24px 28px;text-align:center;">
      <a href="${esc(url)}" style="display:inline-block;background:#1FC8C3;color:#062b2a;padding:13px 26px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Abrir el CRM</a>
    </div>
    <div style="background:#fafafa;padding:14px 24px;text-align:center;border-top:1px solid #eee;">
      <p style="margin:0;font-size:11px;color:#888;">
        Resumen automático de "Mi día" · ${esc(fecha)} · Bienenhaus Propiedades<br>
        Los datos se guardan solos: no hace falta cerrar el mes ni marcar nada desde este mail.
      </p>
    </div>
  </div>
</body>
</html>`;

  const textLines = items.length
    ? items.map((it, i) => {
        const tel = it.telefono ? ` · ${it.telefono}` : '';
        const when = fmtFecha(it.fecha);
        return `${i + 1}. ${it.titulo || it.tipo || 'Acción pendiente'}${it.nombre ? ` — ${it.nombre}` : ''}${tel}${when ? ` (${when})` : ''}${it.detalle ? `\n   ${it.detalle}` : ''}`;
      })
    : ['Todo al día: no hay acciones urgentes para hoy.'];

  const agendaTexto = agendaItems.length
    ? `\n\nAgenda · próximos 3 días:\n${agendaItems
        .map((a) => {
          const when = fmtFecha(a.fecha);
          return `- ${a.titulo || a.tipo || 'Pendiente'}${a.nombre ? ` — ${a.nombre}` : ''}${when ? ` (${when})` : ''}${a.detalle ? ` · ${a.detalle}` : ''}`;
        })
        .join('\n')}`
    : '\n\nAgenda · próximos 3 días: sin visitas ni tareas.';

  const text = `BIENENHAUS CRM — Tu día de hoy\n${'='.repeat(36)}\n${fecha} · ${nombre || 'Agente'}\n\n${textLines.join('\n')}\n\nPendiente además: ${resumen}.${agendaTexto}\n\nAbrir el CRM: ${url}\n\n---\nResumen automático de "Mi día" · Bienenhaus Propiedades\n`;

  const subject = `${items.length || 0} acción${items.length === 1 ? '' : 'es'} · ${total} pendiente${total === 1 ? '' : 's'}`;
  return { html, text, subject };
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  /* Auth del cron: x-sync-secret (mismo secret de zernio_config que usan
     backup-snapshot, owner-tasks-reminder y lead-tasks-reminder). */
  const syncSecret = await supabase
    .from('zernio_config')
    .select('value')
    .eq('key', 'sync_secret')
    .maybeSingle()
    .then((r: { data?: { value?: { secret?: string } } | null }) => r.data?.value?.secret || '');
  if (!syncSecret || req.headers.get('x-sync-secret') !== syncSecret) {
    return json(401, { error: 'No autorizado' });
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw) as Record<string, unknown>;
  } catch (_) {
    body = {};
  }
  const dryRun = body.dry_run === true;
  const force = body.force === true;

  try {
    const ahora = new Date();
    const fecha = fechaArt(ahora);
    /* Media noche ART en UTC (Argentina no tiene DST desde 2019). */
    const desde = new Date(`${fecha}T00:00:00-03:00`).toISOString();

    /* Un solo query de dedupe para todos los agentes (crm_envios es chica y
       tiene índice por origen/created_at). Sólo 'enviado' bloquea: un fallo
       se reintenta el mismo día sin generar correo duplicado. */
    const { data: enviadosHoy, error: dedupeErr } = await supabase
      .from('crm_envios')
      .select('agente_id')
      .eq('origen', 'agent_daily_digest')
      .eq('estado', 'enviado')
      .gte('created_at', desde);
    if (dedupeErr) console.error('agent-daily-digest: dedupe error', dedupeErr.message);
    const yaEnviados = new Set((enviadosHoy || []).map((r: { agente_id: string | null }) => r.agente_id));

    const { data: agentes, error: agentesErr } = await supabase
      .from('agents')
      .select('id, full_name, email, profile_id, status, deleted_at')
      .eq('status', 'activo')
      .is('deleted_at', null);
    if (agentesErr) throw new Error(`query agentes: ${agentesErr.message}`);

    const lista: Agente[] = agentes || [];
    const profileIds = lista.map((a) => a.profile_id).filter((id): id is string => !!id);
    const perfiles: Perfil[] = profileIds.length
      ? (await supabase.from('profiles').select('id, email, is_active').in('id', profileIds)).data || []
      : [];
    const prefs: Array<{ user_id: string; email: boolean | null }> = profileIds.length
      ? (await supabase.from('notification_preferences').select('user_id, email').in('user_id', profileIds)).data || []
      : [];

    const config = await getConfig(supabase);
    const detalle: Array<Record<string, unknown>> = [];
    let enviados = 0;
    let fallidos = 0;
    let omitidos = 0;

    for (const ag of lista) {
      const perfil = perfiles.find((p) => p.id === ag.profile_id);
      const email = String(perfil?.email || ag.email || '').trim().toLowerCase();

      const omitir = (motivo: string) => {
        omitidos += 1;
        detalle.push({ agente: ag.full_name, motivo });
      };

      if (!perfil || perfil.is_active === false) {
        omitir('perfil inactivo o sin vincular');
        continue;
      }
      if (!email) {
        omitir('sin email');
        continue;
      }
      if (prefs.some((p) => p.user_id === perfil.id && p.email === false)) {
        omitir('opt-out de email');
        continue;
      }
      if (!force && yaEnviados.has(ag.id)) {
        omitir('ya enviado hoy');
        continue;
      }

      let payload: MiDiaPayload;
      try {
        const { data, error } = await supabase.rpc('mi_dia', { p_user_id: perfil.id });
        if (error) throw new Error(error.message);
        payload = (data || {}) as MiDiaPayload;
        if (payload.error) throw new Error(String(payload.error));
      } catch (err) {
        fallidos += 1;
        const msg = (err as Error).message || String(err);
        console.error(`agent-daily-digest: mi_dia falló para ${ag.full_name}`, msg);
        detalle.push({ agente: ag.full_name, motivo: 'mi_dia falló', error: msg.slice(0, 200) });
        if (!dryRun) {
          await registrarEnvio(supabase, {
            origen: 'agent_daily_digest',
            canal: 'email',
            estado: 'error',
            destinatario: email,
            asunto: '[Bienenhaus CRM] Resumen diario',
            proveedor: 'brevo',
            agente_id: ag.id,
            error: msg.slice(0, 900),
            metadata: { fecha },
          });
        }
        continue;
      }

      const items = Array.isArray(payload.items) ? payload.items : [];
      const conteos = payload.conteos || {};
      const total = Number(payload.total ?? items.length ?? 0);
      const nombre = String(payload.agente || ag.full_name || 'Agente');

      /* La agenda (visitas + tareas de los próximos 3 días) la calcula la RPC:
         acá no se reimplementan filtros ni reglas de visibilidad. Un fallo de
         la RPC degrada el bloque, NUNCA frena el top 3 (ya verificado en prod). */
      let agenda: AgendaPayload = {};
      try {
        const { data: agendaData, error: agendaErr } = await supabase.rpc('mi_dia_agenda', {
          p_user_id: perfil.id,
          p_dias: 3,
        });
        if (agendaErr) throw new Error(agendaErr.message);
        agenda = (agendaData || {}) as AgendaPayload;
        if (agenda.error) throw new Error(String(agenda.error));
      } catch (err) {
        const msg = (err as Error).message || String(err);
        console.error(`agent-daily-digest: mi_dia_agenda falló para ${ag.full_name}`, msg);
        agenda = {};
      }

      const { html, text, subject: resumenSubject } = buildContent(payload, agenda, nombre, fecha, config.dashboard_url || '');
      const subject = `[Bienenhaus CRM] Tu día ${fecha} — ${resumenSubject}`;
      const agendaConteos = agenda.conteos || {};

      if (dryRun) {
        detalle.push({
          agente: nombre,
          email,
          items: items.map((it) => ({ tipo: it.tipo, titulo: it.titulo, lead_id: it.lead_id })),
          conteos,
          total,
          agenda: agendaConteos,
          modo: 'dry_run (sin envío)',
        });
        continue;
      }

      const resultado = await sendBrevoEmail(config, email, subject, html, text);
      await registrarEnvio(supabase, {
        origen: 'agent_daily_digest',
        canal: 'email',
        estado: resultado.success ? 'enviado' : 'error',
        destinatario: email,
        asunto: subject,
        proveedor: 'brevo',
        agente_id: ag.id,
        error: resultado.error || null,
        metadata: {
          fecha,
          total,
          conteos,
          items: items.map((it) => ({ tipo: it.tipo, titulo: it.titulo, lead_id: it.lead_id })),
          agenda: agendaConteos,
          message_id: resultado.messageId || null,
        },
      });

      if (resultado.success) {
        enviados += 1;
        detalle.push({ agente: nombre, estado: 'enviado', total });
      } else {
        fallidos += 1;
        console.error(`agent-daily-digest: envío falló para ${ag.full_name}`, resultado.error);
        detalle.push({ agente: nombre, estado: 'error', error: resultado.error?.slice(0, 200) });
      }
    }

    return json(200, {
      ok: true,
      fecha,
      dry_run: dryRun,
      agentes_activos: lista.length,
      enviados,
      fallidos,
      omitidos,
      detalle,
    });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    console.error('agent-daily-digest error:', msg);
    return json(500, { error: msg });
  }
});
