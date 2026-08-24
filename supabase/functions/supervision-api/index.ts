// ============================================================
// BIENENHAUS - Supervision API
// Centro de Supervisión super_admin: consultas de auditoría, alertas, métricas
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, jsonResponse, optionsResponse } from '../_shared/http.ts';
import { withRateLimit, RATE_LIMIT_CONFIG } from '../_shared/rate-limit.ts';
import type { SupabaseClient } from 'npm/@supabase/supabase-js@2';

RATE_LIMIT_CONFIG['supervision-api'] = { requests: 60, windowMs: 60_000 };

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } }
);

/**
 * Verifica que el usuario autenticado tenga rol super_admin en profiles
 */
async function requireSuperAdmin(req: Request, supabase: SupabaseClient): Promise<string | null> {
    const auth = req.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return null;
    const token = auth.slice(7);

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;

    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('role, is_active')
        .eq('id', data.user.id)
        .limit(1)
        .single();

    if (profileError || !profile) return null;
    if (profile.is_active === false) return null;
    if (profile.role !== 'super_admin') return null;

    return token;
}

interface QueryParams {
    // Filtros comunes
    userId?: string;
    module?: string;
    action?: string;
    entityType?: string;
    entityId?: string;
    status?: string;
    severity?: string;
    alertType?: string;
    alertStatus?: string;
    dateFrom?: string;
    dateTo?: string;
    // Paginación
    page?: number;
    limit?: number;
    // Orden
    orderBy?: string;
    orderDir?: 'asc' | 'desc';
}

async function parseQueryParams(url: URL): Promise<QueryParams> {
    const params: QueryParams = {};
    
    const userId = url.searchParams.get('user_id');
    if (userId) params.userId = userId;
    
    const module = url.searchParams.get('module');
    if (module) params.module = module;
    
    const action = url.searchParams.get('action');
    if (action) params.action = action;
    
    const entityType = url.searchParams.get('entity_type');
    if (entityType) params.entityType = entityType;
    
    const entityId = url.searchParams.get('entity_id');
    if (entityId) params.entityId = entityId;
    
    const status = url.searchParams.get('status');
    if (status) params.status = status;
    
    const severity = url.searchParams.get('severity');
    if (severity) params.severity = severity;
    
    const alertType = url.searchParams.get('alert_type');
    if (alertType) params.alertType = alertType;
    
    const alertStatus = url.searchParams.get('alert_status');
    if (alertStatus) params.alertStatus = alertStatus;
    
    const dateFrom = url.searchParams.get('date_from');
    if (dateFrom) params.dateFrom = dateFrom;
    
    const dateTo = url.searchParams.get('date_to');
    if (dateTo) params.dateTo = dateTo;
    
    const page = url.searchParams.get('page');
    if (page) params.page = parseInt(page, 10);
    
    const limit = url.searchParams.get('limit');
    if (limit) params.limit = Math.min(parseInt(limit, 10), 100);
    
    const orderBy = url.searchParams.get('order_by');
    if (orderBy) params.orderBy = orderBy;
    
    const orderDir = url.searchParams.get('order_dir');
    if (orderDir) params.orderDir = orderDir as 'asc' | 'desc';
    
    return params;
}

function buildAuditQuery(supabase: SupabaseClient, params: QueryParams) {
    let query = supabase
        .from('audit_log')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });
    
    if (params.userId) query = query.eq('user_id', params.userId);
    if (params.module) query = query.eq('module', params.module);
    if (params.action) query = query.eq('action', params.action);
    if (params.entityType) query = query.eq('entity_type', params.entityType);
    if (params.entityId) query = query.eq('entity_id', params.entityId);
    if (params.status) query = query.eq('status', params.status);
    if (params.dateFrom) query = query.gte('created_at', params.dateFrom);
    if (params.dateTo) query = query.lte('created_at', params.dateTo);
    
    const orderBy = params.orderBy ?? 'created_at';
    const orderDir = params.orderDir ?? 'desc';
    query = query.order(orderBy, { ascending: orderDir === 'asc' });
    
    const page = params.page ?? 1;
    const limit = params.limit ?? 50;
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);
    
    return query;
}

function buildUsageQuery(supabase: SupabaseClient, params: QueryParams) {
    let query = supabase
        .from('usage_events')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });
    
    if (params.userId) query = query.eq('user_id', params.userId);
    if (params.module) query = query.eq('module', params.module);
    if (params.action) query = query.eq('action', params.action);
    if (params.entityType) query = query.eq('entity_type', params.entityType);
    if (params.entityId) query = query.eq('entity_id', params.entityId);
    if (params.status) query = query.eq('status', params.status);
    if (params.dateFrom) query = query.gte('created_at', params.dateFrom);
    if (params.dateTo) query = query.lte('created_at', params.dateTo);
    
    const orderBy = params.orderBy ?? 'created_at';
    const orderDir = params.orderDir ?? 'desc';
    query = query.order(orderBy, { ascending: orderDir === 'asc' });
    
    const page = params.page ?? 1;
    const limit = params.limit ?? 50;
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);
    
    return query;
}

function buildAlertsQuery(supabase: SupabaseClient, params: QueryParams) {
    let query = supabase
        .from('supervision_alerts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });
    
    if (params.userId) query = query.eq('user_id', params.userId);
    if (params.module) query = query.eq('module', params.module);
    if (params.severity) query = query.eq('severity', params.severity);
    if (params.alertType) query = query.eq('alert_type', params.alertType);
    if (params.alertStatus) query = query.eq('status', params.alertStatus);
    if (params.dateFrom) query = query.gte('created_at', params.dateFrom);
    if (params.dateTo) query = query.lte('created_at', params.dateTo);
    
    const orderBy = params.orderBy ?? 'created_at';
    const orderDir = params.orderDir ?? 'desc';
    query = query.order(orderBy, { ascending: orderDir === 'asc' });
    
    const page = params.page ?? 1;
    const limit = params.limit ?? 50;
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);
    
    return query;
}

function buildRulesQuery(supabase: SupabaseClient, params: QueryParams) {
    let query = supabase
        .from('supervision_rules')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });
    
    if (params.module) query = query.eq('module', params.module);
    if (params.alertStatus) query = query.eq('enabled', params.alertStatus === 'enabled');
    
    const page = params.page ?? 1;
    const limit = params.limit ?? 50;
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);
    
    return query;
}

async function handleAuditLogs(req: Request, params: QueryParams) {
    const query = buildAuditQuery(supabase, params);
    const { data, error, count } = await query;
    
    if (error) throw error;
    
    return jsonResponse(200, {
        data: data ?? [],
        pagination: {
            page: params.page ?? 1,
            limit: params.limit ?? 50,
            total: count ?? 0,
            totalPages: Math.ceil((count ?? 0) / (params.limit ?? 50))
        }
    }, req);
}

async function handleUsageEvents(req: Request, params: QueryParams) {
    const query = buildUsageQuery(supabase, params);
    const { data, error, count } = await query;
    
    if (error) throw error;
    
    return jsonResponse(200, {
        data: data ?? [],
        pagination: {
            page: params.page ?? 1,
            limit: params.limit ?? 50,
            total: count ?? 0,
            totalPages: Math.ceil((count ?? 0) / (params.limit ?? 50))
        }
    }, req);
}

async function handleAlerts(req: Request, params: QueryParams) {
    const query = buildAlertsQuery(supabase, params);
    const { data, error, count } = await query;
    
    if (error) throw error;
    
    return jsonResponse(200, {
        data: data ?? [],
        pagination: {
            page: params.page ?? 1,
            limit: params.limit ?? 50,
            total: count ?? 0,
            totalPages: Math.ceil((count ?? 0) / (params.limit ?? 50))
        }
    }, req);
}

async function handleRules(req: Request, params: QueryParams) {
    const query = buildRulesQuery(supabase, params);
    const { data, error, count } = await query;
    
    if (error) throw error;
    
    return jsonResponse(200, {
        data: data ?? [],
        pagination: {
            page: params.page ?? 1,
            limit: params.limit ?? 50,
            total: count ?? 0,
            totalPages: Math.ceil((count ?? 0) / (params.limit ?? 50))
        }
    }, req);
}

async function handleSummary(req: Request) {
    // KPIs del dashboard de supervisión
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    
    const summaryQueries = [
        supabase.from('audit_log')
            .select('user_id', { count: 'exact', head: true })
            .gte('created_at', dayStart)
            .then(r => ({ count: r.count ?? 0 })),
        supabase.from('audit_log')
            .select('*', { count: 'exact', head: true })
            .gte('created_at', dayStart)
            .then(r => ({ count: r.count ?? 0 })),
        supabase.from('audit_log')
            .select('*', { count: 'exact', head: true })
            .gte('created_at', dayStart)
            .in('action', ['update_sensitive', 'delete', 'export', 'bulk_create', 'bulk_update', 'bulk_delete', 'bulk_publish', 'bulk_delete'])
            .then(r => ({ count: r.count ?? 0 })),
        supabase.from('audit_log')
            .select('*', { count: 'exact', head: true })
            .gte('created_at', dayStart)
            .eq('status', 'error')
            .then(r => ({ count: r.count ?? 0 })),
        supabase.from('supervision_alerts')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'open')
            .then(r => ({ count: r.count ?? 0 })),
        supabase.from('supervision_alerts')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'open')
            .eq('severity', 'critical')
            .then(r => ({ count: r.count ?? 0 }))
    ];
    
    const [
        { count: activeUsersToday },
        { count: actionsToday },
        { count: sensitiveActionsToday },
        { count: errorsToday },
        { count: openAlerts },
        { count: criticalAlerts }
    ] = await Promise.all(summaryQueries);
    
    // Actividad reciente y alertas recientes en paralelo
    const [recentActivityRes, recentAlertsRes] = await Promise.all([
        supabase
            .from('audit_log')
            .select('created_at, user_id, module, action, entity_label, status')
            .order('created_at', { ascending: false })
            .limit(10),
        supabase
            .from('supervision_alerts')
            .select('created_at, user_id, module, severity, alert_type, title, status')
            .eq('status', 'open')
            .order('created_at', { ascending: false })
            .limit(5)
    ]);
    
    const { data: recentActivity } = recentActivityRes;
    const { data: recentAlerts } = recentAlertsRes;
    
    // Enriquecer con nombres de usuario
    const userIds = new Set<string>();
    (recentActivity ?? []).forEach(a => a.user_id && userIds.add(a.user_id));
    (recentAlerts ?? []).forEach(a => a.user_id && userIds.add(a.user_id));
    
    const userNames = new Map<string, string>();
    if (userIds.size > 0) {
        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, full_name, email')
            .in('id', Array.from(userIds));
        profiles?.forEach(p => userNames.set(p.id, p.full_name || p.email));
    }
    
    const enrichUser = (id: string | null) => 
        id ? (userNames.get(id) ?? id.slice(0, 8)) : 'Sistema';
    
const reqForResponse: Request | null = null;
    return jsonResponse(200, {
        kpis: {
            activeUsersToday: activeUsersToday ?? 0,
            actionsToday: actionsToday ?? 0,
            sensitiveActionsToday: sensitiveActionsToday ?? 0,
            errorsToday: errorsToday ?? 0,
            openAlerts: openAlerts ?? 0,
            criticalAlerts: criticalAlerts ?? 0
        },
        recentActivity: (recentActivity ?? []).map(a => ({
            time: a.created_at,
            user: enrichUser(a.user_id),
            module: a.module,
            action: a.action,
            entity: a.entity_label,
            status: a.status
        })),
        recentAlerts: (recentAlerts ?? []).map(a => ({
            time: a.created_at,
            user: enrichUser(a.user_id),
            module: a.module,
            severity: a.severity,
            type: a.alert_type,
            title: a.title,
            status: a.status
        }))
    }, reqForResponse);
}

async function handleLiveActivity(req: Request, url: URL) {
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 100);
    const modules = req.url.split('modules=')[1]?.split(',') ?? [];
    
    let query = supabase
        .from('audit_log')
        .select('created_at, user_id, module, action, entity_label, status, entity_type, entity_id')
        .order('created_at', { ascending: false })
        .limit(limit);
    
    if (modules.length > 0) {
        // Filtrar por módulos si se proporcionan
        // Supabase no soporta .in() directamente en este cliente, usar filtro
    }
    
    const { data, error } = await query;
    if (error) throw error;
    
    const userIds = new Set<string>();
    (data ?? []).forEach(a => a.user_id && userIds.add(a.user_id));
    
    const userNames = new Map<string, string>();
    if (userIds.size > 0) {
        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, full_name, email')
            .in('id', Array.from(userIds));
        profiles?.forEach(p => userNames.set(p.id, p.full_name || p.email));
    }
    
    const enrichUser = (id: string | null) => 
        id ? (userNames.get(id) ?? id.slice(0, 8)) : 'Sistema';
    
    return jsonResponse(200, {
        data: (data ?? []).map(a => ({
            time: a.created_at,
            user: enrichUser(a.user_id),
            module: a.module,
            action: a.action,
            entity: a.entity_label,
            entityType: a.entity_type,
            entityId: a.entity_id,
            status: a.status
        }))
    }, null as any);
}

async function handleAlertAction(req: Request, action: 'acknowledge' | 'resolve' | 'dismiss') {
    const body = await req.json();
    const { alertId } = body;
    
    if (!alertId) {
        return jsonResponse(400, { error: 'Falta alertId' }, null as any);
    }
    
    const authHeader = req.headers.get('authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const { data: { user } } = await supabase.auth.getUser(token);
    
    if (!user) {
        return jsonResponse(401, { error: 'No autorizado' }, null as any);
    }
    
    const updateData: Record<string, unknown> = { 
        status: action === 'acknowledge' ? 'acknowledged' : action === 'resolve' ? 'resolved' : 'dismissed'
    };
    
    if (action === 'acknowledge') {
        updateData.acknowledged_by = user.id;
        updateData.acknowledged_at = new Date().toISOString();
    } else if (action === 'resolve') {
        updateData.resolved_by = user.id;
        updateData.resolved_at = new Date().toISOString();
    } else {
        updateData.dismissed_by = user.id;
        updateData.dismissed_at = new Date().toISOString();
    }
    
    const { error } = await supabase
        .from('supervision_alerts')
        .update(updateData)
        .eq('id', alertId);
    
    if (error) throw error;
    
    // Auditar la acción sobre la alerta
    // (aquí se podría llamar a insert_audit_log via RPC)
    
    return jsonResponse(200, { ok: true, action }, null as any);
}

async function handleRules(req: Request, method: string) {
    if (method === 'GET') {
        const url = new URL(req.url);
        const params = await parseQueryParams(url);
        return handleRules(req, params);
    }
    
    if (method === 'POST') {
        const body = await req.json();
        const { name, description, module, action, event_type, condition, severity, enabled, cooldown_minutes } = body;
        
        if (!name || !condition || !severity) {
            return jsonResponse(400, { error: 'Faltan campos obligatorios: name, condition, severity' }, null as any);
        }
        
        const { data, error } = await supabase
            .from('supervision_rules')
            .insert({
                name,
                description,
                module,
                action,
                event_type: event_type,
                condition,
                severity,
                enabled: enabled ?? true,
                cooldown_minutes: cooldown_minutes ?? 60
            })
            .select()
            .single();
        
        if (error) throw error;
        return jsonResponse(201, data, null as any);
    }
    
    if (method === 'PATCH') {
        const body = await req.json();
        const { id, ...updates } = body;
        
        if (!id) {
            return jsonResponse(400, { error: 'Falta id' }, null as any);
        }
        
        const { data, error } = await supabase
            .from('supervision_rules')
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select()
            .single();
        
        if (error) throw error;
        return jsonResponse(200, data, null as any);
    }
    
    if (method === 'DELETE') {
        const url = new URL(req.url);
        const id = url.searchParams.get('id');
        
        if (!id) {
            return jsonResponse(400, { error: 'Falta id' }, null as any);
        }
        
        const { error } = await supabase
            .from('supervision_rules')
            .delete()
            .eq('id', id);
        
        if (error) throw error;
        return jsonResponse(200, { ok: true }, null as any);
    }
    
    return jsonResponse(405, { error: 'Method not allowed' }, null as any);
}

async function handleExport(req: Request) {
    const url = new URL(req.url);
    const type = url.searchParams.get('type') ?? 'audit';
    const format = url.searchParams.get('format') ?? 'csv';
    
    // Auditar la exportación
    // (aquí se llamaría a insert_audit_log via RPC)
    
    let query;
    if (type === 'audit') {
        query = supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(10000);
    } else if (type === 'usage') {
        query = supabase.from('usage_events').select('*').order('created_at', { ascending: false }).limit(10000);
    } else if (type === 'alerts') {
        query = supabase.from('supervision_alerts').select('*').order('created_at', { ascending: false }).limit(10000);
    } else {
        return jsonResponse(400, { error: 'Tipo inválido' }, null as any);
    }
    
    const { data, error } = await query;
    if (error) throw error;
    
    if (format === 'csv') {
        if (!data || data.length === 0) {
            return jsonResponse(200, 'No data', null as any);
        }
        const headers = Object.keys(data[0]);
        const csv = [
            headers.join(','),
            ...data.map(row => headers.map(h => {
                const val = row[h];
                if (val === null || val === undefined) return '';
                const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
                return `"${str.replace(/"/g, '""')}"`;
            }).join(','))
        ].join('\n');
        
        return new Response(csv, {
            status: 200,
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="${type}_export_${new Date().toISOString().slice(0,10)}.csv"`
            }
        });
    }
    
    return jsonResponse(200, { data }, null as any);
}

async function handleEventDetail(req: Request, url: URL) {
    const eventId = url.searchParams.get('event_id');
    const type = url.searchParams.get('type') ?? 'audit';
    
    if (!eventId) {
        return jsonResponse(400, { error: 'Falta event_id' }, null as any);
    }
    
    let table = 'audit_log';
    if (type === 'usage') table = 'usage_events';
    else if (type === 'alert') table = 'supervision_alerts';
    
    const { data, error } = await supabase
        .from(table)
        .select('*')
        .eq('id', eventId)
        .single();
    
    if (error) throw error;
    
    // Si es audit_log y tiene changed_fields, obtener before/after
    if (type === 'audit' && data?.old_data && data?.new_data) {
        return jsonResponse(200, {
            event: data,
            changes: {
                old: data.old_data,
                new: data.new_data,
                changed_fields: data.changed_fields
            }
        }, null as any);
    }
    
    return jsonResponse(200, { event: data }, null as any);
}

async function handleUserActivity(req: Request, url: URL) {
    const userId = url.searchParams.get('user_id');
    const days = parseInt(url.searchParams.get('days') ?? '30', 10);
    
    if (!userId) {
        return jsonResponse(400, { error: 'Falta user_id' }, null as any);
    }
    
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);
    
    const [
        { data: auditData },
        { data: usageData },
        { data: alertsData }
    ] = await Promise.all([
        supabase.from('audit_log')
            .select('*')
            .eq('user_id', userId)
            .gte('created_at', dateFrom.toISOString())
            .order('created_at', { ascending: false })
            .limit(200),
        supabase.from('usage_events')
            .select('*')
            .eq('user_id', userId)
            .gte('created_at', dateFrom.toISOString())
            .order('created_at', { ascending: false })
            .limit(200),
        supabase.from('supervision_alerts')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(50)
    ]);
    
    // Agregados
    const auditDataTyped = (data as any[]) ?? [];
    const activityByModule: Record<string, number> = {};
    const activityByAction: Record<string, number> = {};
    const activityByStatus: Record<string, number> = {};
    
    auditDataTyped.forEach(a => {
        activityByModule[a.module] = (activityByModule[a.module] || 0) + 1;
        activityByAction[a.action] = (activityByAction[a.action] || 0) + 1;
        activityByStatus[a.status] = (activityByStatus[a.status] || 0) + 1;
    });
    
    return jsonResponse(200, {
        userId,
        periodDays: days,
        summary: {
            totalActions: auditDataTyped.length,
            totalUsageEvents: (usageData ?? []).length,
            totalAlerts: (alertsData ?? []).length,
            activityByModule,
            activityByAction,
            activityByStatus
        },
        auditLog: auditDataTyped.slice(0, 100),
        usageEvents: (usageData ?? []).slice(0, 100),
        alerts: (alertsData ?? []).slice(0, 50)
    }, null as any);
}

async function handleModuleActivity(req: Request) {
    const days = parseInt(new URL(req.url).searchParams.get('days') ?? '7', 10);
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);
    
    const { data, error } = await supabase
        .from('audit_log')
        .select('module, action, status, user_id, created_at')
        .gte('created_at', dateFrom.toISOString())
        .order('created_at', { ascending: false })
        .limit(5000);
    
    if (error) throw error;
    
    const moduleStats: Record<string, {
        total: number;
        byAction: Record<string, number>;
        byStatus: Record<string, number>;
        users: Set<string>;
    }> = {};
    
    (data ?? []).forEach(a => {
        if (!moduleStats[a.module]) {
            moduleStats[a.module] = { total: 0, byAction: {}, byStatus: {}, users: new Set() };
        }
        moduleStats[a.module].total++;
        moduleStats[a.module].byAction[a.action] = (moduleStats[a.module].byAction[a.action] || 0) + 1;
        moduleStats[a.module].byStatus[a.status] = (moduleStats[a.module].byStatus[a.status] || 0) + 1;
        moduleStats[a.module].users.add(a.user_id);
    });
    
    const result = Object.entries(moduleStats).map(([module, stats]) => ({
        module,
        total: stats.total,
        byAction: stats.byAction,
        byStatus: stats.byStatus,
        uniqueUsers: stats.users.size
    })).sort((a, b) => b.total - a.total);
    
    return jsonResponse(200, { periodDays: days, modules: result }, null as any);
}

async function handleVerifyIntegrity(req: Request) {
    try {
        const url = new URL(req.url);
        const userId = url.searchParams.get('user_id');
        const startDate = url.searchParams.get('date_from');
        const endDate = url.searchParams.get('date_to');
        const limit = parseInt(url.searchParams.get('limit') ?? '1000', 10);
        
        let query = supabase
            .from('audit_log')
            .select('id, user_id, module, action, entity_type, entity_id, created_at, event_hash, previous_hash')
            .order('user_id, created_at', { ascending: true })
            .limit(limit);
        
        if (userId) query = query.eq('user_id', userId);
        if (startDate) query = query.gte('created_at', startDate);
        if (endDate) query = query.lte('created_at', endDate);
        
        const { data, error } = await query;
        if (error) throw error;
        
        const results = [];
        let matched = 0;
        let total = 0;
        
        // Group by user_id to verify chains
        const byUser = new Map<string, typeof data>();
        (data ?? []).forEach(row => {
            const uid = row.user_id ?? 'system';
            if (!byUser.has(uid)) byUser.set(uid, []);
            byUser.get(uid)!.push(row);
        });
        
        for (const [uid, events] of byUser) {
            let previousHash: string | null = null;
            for (const event of events) {
                total++;
                const expectedHash = calculateEventHash(
                    event.id,
                    event.user_id,
                    event.action,
                    event.module,
                    event.entity_type,
                    event.entity_id,
                    event.old_data,
                    event.new_data,
                    previousHash
                );
                
                const matches = event.event_hash === expectedHash;
                if (matches) matched++;
                
                results.push({
                    id: event.id,
                    user_id: event.user_id,
                    module: event.module,
                    action: event.action,
                    created_at: event.created_at,
                    expected_hash: expectedHash,
                    actual_hash: event.event_hash,
                    matches,
                    previous_hash: event.previous_hash,
                    user: uid,
                    time: event.created_at,
                    module: event.module,
                });
                
                previousHash = event.event_hash;
            }
        }
        
        return jsonResponse(200, {
            total,
            matched,
            percentage: total > 0 ? ((matched / total) * 100).toFixed(1) : 100,
            details: results,
        }, null as any);
    } catch (error) {
        console.error('[handleVerifyIntegrity] Error:', error);
        return jsonResponse(500, { error: 'Error al verificar integridad' }, null as any);
    }
}

function calculateEventHash(
    id: string,
    user_id: string | null,
    action: string,
    module: string,
    entity_type: string | null,
    entity_id: string | null,
    old_data: any,
    new_data: any,
    previous_hash: string | null
): string {
    const input = [
        id,
        user_id ?? 'null',
        action,
        module,
        entity_type ?? 'null',
        entity_id ?? 'null',
        JSON.stringify(old_data ?? null),
        JSON.stringify(new_data ?? null),
        previous_hash ?? 'genesis',
    ].join('|');
    
    // Use crypto.subtle.digest for SHA-256
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    
    const rateLimitResponse = await withRateLimit('supervision-api', async () => null, req);
    if (rateLimitResponse) return rateLimitResponse;
    
    // Verificar super_admin usando profiles table (consistente con RLS policies)
    const token = await requireSuperAdmin(req, supabase);
    if (!token) {
        return jsonResponse(403, { error: 'Solo super_admin puede acceder al Centro de Supervisión' }, req);
    }
    
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const endpoint = pathParts[pathParts.length - 1] ?? 'summary';
    
    try {
        const params = await parseQueryParams(url);
        
        switch (endpoint) {
            case 'audit':
                return handleAuditLogs(req, await parseQueryParams(url));
            case 'usage':
                return handleUsageEvents(req, await parseQueryParams(url));
            case 'alerts':
                return handleAlerts(req, await parseQueryParams(url));
            case 'rules':
                return handleRules(req, req.method);
            case 'summary':
                return handleSummary(req);
            case 'live':
                return handleLiveActivity(req, new URL(req.url));
            case 'alert-action':
                if (req.method === 'POST') {
                    const body = await req.json();
                    return handleAlertAction(req, body.action);
                }
                return jsonResponse(405, { error: 'Method not allowed' }, req);
            case 'export':
                return handleExport(req);
            case 'detail':
                return handleEventDetail(req, new URL(req.url));
            case 'user':
                return handleUserActivity(req, new URL(req.url));
            case 'modules':
                return handleModuleActivity(req);
            case 'verify-integrity':
                return handleVerifyIntegrity(req);
            case 'summary':
                return handleSummary(req);
            default:
                return handleSummary(req);
        }
    } catch (error) {
        console.error('[supervision-api] Error:', error);
        return jsonResponse(500, { error: 'Error interno del servidor' }, req);
    }
});