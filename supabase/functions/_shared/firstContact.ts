/**
 * SLA de primer contacto (2026-11-02) — compartido por TODOS los puntos de
 * entrada que crean leads sin intervención humana:
 *   ml-webhook, tasacion-submit, contact-submit, social-youtube-comments.
 *
 * Por qué existe: un lead que entra solo tiene el contacto EN LA MANO. Si
 * nadie lo atiende en minutos se enfría y se pierde. Medido en producción
 * (60 días): 43 leads ML → 0 contactados en <2 h, 26 después de 24 h, 24
 * perdidos. La causa: el lead nacía SIN PLAZO — 30 de 43 con
 * next_followup_at NULL (el motor de alertas los ignora por diseño), sin
 * lead_task y con un email como única señal.
 *
 * Qué hace: el lead nace con un PLAZO —
 *   · lead_tasks  → la Agenda lo muestra y el badge "tareas vencidas" se
 *     enciende en el panel,
 *   · next_followup_at → lo mira el cron crm_queue_followup_alerts (alerta
 *     de supervisión cuando se vence).
 * El título es ÚNICO ("Primer contacto") para todos los canales: el panel
 * cierra la tarea al registrar contacto buscando por el prefijo del título
 * (ver markLeadContacted en admin-crm.js). El canal queda en la description.
 *
 * Best-effort: si la tarea falla, el lead sigue existiendo y el endpoint no
 * se rompe (el error va al log, no a la respuesta del cliente).
 */

export const FIRST_CONTACT_MINUTES = 120;
export const FIRST_CONTACT_TASK_TITLE = 'Primer contacto';

/** next_followup_at = la tarea pendiente más próxima. Mismo criterio que
    syncLeadFollowup() del panel: TODAS las tareas pendientes, no solo las de
    tipo 'contact' (si no, el plazo del SLA puede quedar pisado por otra). */
export async function syncLeadNextFollowup(supabase: any, leadId: string): Promise<void> {
    const { data: pending } = await supabase
        .from('lead_tasks')
        .select('due_at')
        .eq('lead_id', leadId)
        .in('status', ['pendiente', 'en_progreso'])
        .not('due_at', 'is', null)
        .order('due_at', { ascending: true })
        .limit(1);
    const next = (pending && pending[0] && pending[0].due_at) || null;
    await supabase.from('leads').update({ next_followup_at: next }).eq('id', leadId);
}

/**
 * Crea (una sola vez) la tarea de primer contacto del lead.
 *
 * - Lead ya contactado (last_contacted_at seteado) → no crea: el SLA es del
 *   PRIMER contacto; las consultas nuevas quedan como notas en el timeline.
 * - Sin teléfono Y sin email → no crea (no hay a quién escribir; el lead
 *   anónimo arranca su reloj cuando llegue su identidad).
 * - Dedup: una sola tarea de primer contacto viva por lead. Se busca por
 *   prefijo del título ("Primer contacto%") para cubrir también las tareas
 *   creadas con el título por canal de la primera versión.
 */
export async function ensureFirstContactTask(
    supabase: any,
    leadId: string,
    opts?: { phone?: string | null; assignedTo?: string | null; channelLabel?: string },
): Promise<void> {
    try {
        const { data: lead } = await supabase
            .from('leads')
            .select('id, last_contacted_at, assigned_to, phone, whatsapp, email')
            .eq('id', leadId)
            .maybeSingle();
        if (!lead) return;
        if (lead.last_contacted_at) return; // ya hubo primer contacto

        const phone = opts?.phone || lead.whatsapp || lead.phone || null;
        const hasEmail = !!(lead.email || '').trim();
        if (!phone && !hasEmail) return; // sin a quién escribir

        const { data: existing } = await supabase
            .from('lead_tasks')
            .select('id')
            .eq('lead_id', leadId)
            .ilike('title', FIRST_CONTACT_TASK_TITLE + '%')
            .in('status', ['pendiente', 'en_progreso'])
            .limit(1);
        if (existing && existing.length) return; // ya hay un SLA vivo (dedup)

        const due = new Date(Date.now() + FIRST_CONTACT_MINUTES * 60_000).toISOString();
        const canal = opts?.channelLabel ? ` (canal: ${opts.channelLabel})` : '';
        const { error } = await supabase.from('lead_tasks').insert({
            lead_id: leadId,
            title: FIRST_CONTACT_TASK_TITLE,
            description: `Contactar antes de que se enfríe${canal}.`,
            type: 'contact',
            contact_type: phone ? 'whatsapp' : 'email',
            priority: 'alta',
            status: 'pendiente',
            due_at: due,
            remind_before_minutes: 30,
            assigned_to: opts?.assignedTo || lead.assigned_to || null,
        });
        if (error) {
            console.warn(JSON.stringify({ level: 'warn', fn: 'firstContact', lead_id: leadId, error: 'sla_task: ' + error.message }));
            return;
        }
        await syncLeadNextFollowup(supabase, leadId);
    } catch (err) {
        console.warn(JSON.stringify({ level: 'warn', fn: 'firstContact', lead_id: leadId, error: 'sla_task: ' + (err as Error).message }));
    }
}
