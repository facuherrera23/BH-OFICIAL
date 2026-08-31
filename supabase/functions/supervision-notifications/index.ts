// ============================================================
// BIENENHAUS - Supervision Notifications
// Notificaciones push/email para alertas crÃ­ticas
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, jsonResponse, optionsResponse } from '../_shared/http.ts';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } }
);

// ConfiguraciÃ³n de notificaciones
const NOTIFICATION_CONFIG = {
    // Email (Brevo/SendGrid)
    brevoApiKey: Deno.env.get('BREVO_API_KEY'),
    brevoSenderEmail: Deno.env.get('BREVO_SENDER_EMAIL') ?? 'alertas@bienenhaus.com.ar',
    
    // Push (Web Push / Firebase)
    vapidPublicKey: Deno.env.get('VAPID_PUBLIC_KEY'),
    vapidPrivateKey: Deno.env.get('VAPID_PRIVATE_KEY'),
    
    // Slack webhook
    slackWebhookUrl: Deno.env.get('SLACK_WEBHOOK_URL'),
    
    // Config
    criticalChannels: ['email', 'slack', 'push'],
    highChannels: ['email', 'slack'],
    mediumChannels: ['slack'],
};

interface NotificationPayload {
    alertId: string;
    type: 'critical' | 'high' | 'medium' | 'low' | 'info';
    title: string;
    description: string;
    userId: string;
    module: string;
    evidence: Record<string, unknown>;
}

interface UserNotificationPrefs {
    userId: string;
    email: boolean;
    push: boolean;
    slack: boolean;
    criticalOnly: boolean;
}

async function getUserPreferences(userId: string): Promise<UserNotificationPrefs> {
    const { data } = await supabase
        .from('notification_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();
    
    return data ?? {
        userId,
        email: true,
        push: true,
        slack: false,
        criticalOnly: false,
    };
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
    const apiKey = NOTIFICATION_CONFIG.brevoApiKey;
    if (!apiKey) return false;
    
    try {
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                sender: { email: NOTIFICATION_CONFIG.brevoSenderEmail, name: 'Bienenhaus SupervisiÃ³n' },
                to: [{ email: to }],
                subject,
                htmlContent: html,
            }),
        });
        return response.ok;
    } catch (e) {
        console.error('Email send error:', e);
        return false;
    }
}

async function sendPushNotification(subscription: PushSubscription, payload: Record<string, unknown>): Promise<boolean> {
    // Implementar Web Push con VAPID
    // Por simplicidad, retorna true si hay configuraciÃ³n
    return !!NOTIFICATION_CONFIG.vapidPrivateKey;
}

async function sendSlackNotification(webhookUrl: string, message: string): Promise<boolean> {
    if (!webhookUrl) return false;
    
    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: message }),
        });
        return response.ok;
    } catch (e) {
        console.error('Slack send error:', e);
        return false;
    }
}

async function sendNotification(payload: NotificationPayload): Promise<void> {
    const { alertId, type, title, description, userId, module, evidence } = payload;
    
    // Obtener preferencias del super_admin (quien recibe las alertas)
    const prefs = await getUserPreferences(userId);
    if (prefs.criticalOnly && type !== 'critical') return;
    
    const channels = type === 'critical' ? NOTIFICATION_CONFIG.criticalChannels
                     : type === 'high' ? NOTIFICATION_CONFIG.highChannels
                     : type === 'medium' ? NOTIFICATION_CONFIG.mediumChannels
                     : [];
    
    const message = `ðŸš¨ *${type.toUpperCase()}: ${title}*\n${description}\nMÃ³dulo: ${module}\nEvidencia: ${JSON.stringify(evidence, null, 2)}`;
    
    const results = await Promise.allSettled([
        prefs.email ? sendEmail('superadmin@bienenhaus.com.ar', `[SUPERVISIÃ“N] ${type.toUpperCase()}: ${title}`, `
            <h2>${title}</h2>
            <p><strong>Severidad:</strong> ${type.toUpperCase()}</p>
            <p><strong>MÃ³dulo:</strong> ${module}</p>
            <p><strong>DescripciÃ³n:</strong> ${description}</p>
            <p><strong>Evidencia:</strong> <pre>${JSON.stringify(evidence, null, 2)}</pre></p>
            <p><a href="https://bienenhaus.com.ar/admin.html#tab-supervision">Ver en Centro de SupervisiÃ³n</a></p>
        `) : Promise.resolve(false),
        
        prefs.slack ? sendSlackNotification(NOTIFICATION_CONFIG.slackWebhookUrl, message) : Promise.resolve(false),
        
        // Push notifications would require subscription management
        // prefs.push ? sendPushNotification(subscription, { alertId, type, title }) : Promise.resolve(false)
    ]);
    
    // Log resultados
    console.log('Notification results:', results.map(r => r.status));
}

// Endpoint para probar notificaciones
async function handleTestNotification(req: Request): Promise<Response> {
    const body = await req.json();
    const { type = 'critical', title = 'Test Alert', description = 'Test notification', userId } = body;
    
    if (!userId) {
        return jsonResponse(400, { error: 'userId requerido' }, req);
    }
    
    await sendNotification({ alertId: 'test', type, title, description, userId, module: 'test', evidence: {} });
    
    return jsonResponse(200, { ok: true, message: 'Test notification sent' }, req);
}

// Endpoint para preferencias de notificaciÃ³n
async function handlePreferences(req: Request, method: string): Promise<Response> {
    const url = new URL(req.url);
    const userId = url.searchParams.get('user_id');
    
    if (!userId) return jsonResponse(400, { error: 'user_id requerido' }, req);
    
    if (method === 'GET') {
        const { data, error } = await supabase
            .from('notification_preferences')
            .select('*')
            .eq('user_id', userId)
            .single();
        
        if (error && error.code !== 'PGRST116') throw error;
        return jsonResponse(200, data ?? { userId, email: true, push: true, slack: false, criticalOnly: false }, req);
    }
    
    if (method === 'POST' || method === 'PATCH') {
        const body = await req.json();
        const { email, push, slack, criticalOnly } = body;
        
        const { data, error } = await supabase
            .from('notification_preferences')
            .upsert({ user_id: userId, email, push, slack, criticalOnly, updated_at: new Date().toISOString() })
            .select()
            .single();
        
        if (error) throw error;
        return jsonResponse(200, data, req);
    }
    
    return jsonResponse(405, { error: 'Method not allowed' }, req);
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    
    const url = new URL(req.url);
    const path = url.pathname.split('/').pop();
    
    try {
        // Verificar autenticaciÃ³n super_admin
        const auth = req.headers.get('authorization') ?? '';
        if (!auth.startsWith('Bearer ')) return jsonResponse(401, { error: 'No autorizado' }, req);
        
        const token = auth.slice(7);
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) return jsonResponse(401, { error: 'Token invÃ¡lido' }, req);
        
        const { data: profile } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', user.id)
            .single();
        
        if (!profile || profile.role !== 'super_admin') {
            return jsonResponse(403, { error: 'Solo super_admin' }, req);
        }
        
        switch (path) {
            case 'test':
                return handleTestNotification(req);
            case 'preferences':
                return handlePreferences(req, req.method);
            default:
                return jsonResponse(404, { error: 'Endpoint no encontrado' }, req);
        }
    } catch (error) {
        console.error('[supervision-notifications] Error:', error);
        return jsonResponse(500, { error: 'Error interno' }, req);
    }
});