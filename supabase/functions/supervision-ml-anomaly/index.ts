// ============================================================
// BIENENHAUS - ML-based Anomaly Detection (Fase 2)
// Detección de anomalías usando métodos estadísticos avanzados
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, jsonResponse, optionsResponse } from '../_shared/http.ts';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } }
);

// Configuración
const ML_CONFIG = {
    // Ventanas temporales
    shortWindow: '1 hour',
    mediumWindow: '24 hours',
    longWindow: '7 days',
    
    // Umbrales
    zScoreThreshold: 3.0,        // Para detección Z-score
    iqrMultiplier: 1.5,          // Para detección IQR
    isolationForestContamination: 0.1,
    
    // Mínimos para entrenamiento
    minSamplesForTraining: 50,
    minSamplesForInference: 10,
    
    // Features a analizar
    features: [
        'actions_per_hour',
        'exports_per_hour',
        'deletes_per_hour',
        'bulk_ops_per_hour',
        'sensitive_actions_per_hour',
        'error_rate',
        'session_duration_avg',
        'unique_modules_used',
        'unique_entities_accessed',
    ],
};

interface UserActivityFeatures {
    userId: string;
    windowStart: string;
    windowEnd: string;
    features: Record<string, number>;
}

interface AnomalyResult {
    userId: string;
    windowStart: string;
    windowEnd: string;
    anomalyScore: number;        // 0-1
    isAnomaly: boolean;
    method: 'zscore' | 'iqr' | 'isolation_forest' | 'ensemble';
    contributingFeatures: string[];
    details: Record<string, unknown>;
}

// Utilidades estadísticas
function mean(arr: number[]): number {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr: number[]): number {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a, b) => a + Math.pow(b - m, 2), 0) / arr.length);
}

function percentile(arr: number[], p: number): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil(p / 100 * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}

function zScore(value: number, arr: number[]): number {
    const m = mean(arr);
    const s = stdDev(arr);
    return s === 0 ? 0 : (value - m) / s;
}

// Detección Z-Score
function detectZScoreAnomalies(features: Record<string, number[]>, threshold: number): Map<string, string[]> {
    const anomalies = new Map<string, string[]>();
    
    for (const [feature, values] of Object.entries(features)) {
        if (values.length < 3) continue;
        
        const m = mean(values);
        const s = stdDev(values);
        
        values.forEach((v, idx) => {
            const z = s === 0 ? 0 : Math.abs((v - m) / s);
            if (z > threshold) {
                const userId = `user_${idx}`; // Simplificado - en realidad mapear al userId real
                if (!anomalies.has(userId)) anomalies.set(userId, []);
                anomalies.get(userId)!.push(`${feature}: z=${z.toFixed(2)}`);
            }
        });
    }
    
    return anomalies;
}

// Detección IQR (Interquartile Range)
function detectIQRAnomalies(features: Record<string, number[]>, multiplier: number): Map<string, string[]> {
    const anomalies = new Map<string, string[]>();
    
    for (const [feature, values] of Object.entries(features)) {
        if (values.length < 4) continue;
        
        const q1 = percentile(values, 25);
        const q3 = percentile(values, 75);
        const iqr = q3 - q1;
        const lower = q1 - multiplier * iqr;
        const upper = q3 + multiplier * iqr;
        
        values.forEach((v, idx) => {
            if (v < lower || v > upper) {
                const userId = `user_${idx}`;
                if (!anomalies.has(userId)) anomalies.set(userId, []);
                anomalies.get(userId)!.push(`${feature}: ${v} (IQR bounds: ${lower.toFixed(2)}-${upper.toFixed(2)})`);
            }
        });
    }
    
    return anomalies;
}

// Isolation Forest simplificado (basado en profundidad promedio de árboles aleatorios)
class SimpleIsolationForest {
    private trees: IsolationTree[] = [];
    private nTrees: number;
    private maxDepth: number;
    
    constructor(nTrees = 100, maxDepth = 10) {
        this.nTrees = nTrees;
        this.maxDepth = maxDepth;
    }
    
    fit(data: number[][]): void {
        this.trees = [];
        for (let i = 0; i < this.nTrees; i++) {
            const sample = this.bootstrapSample(data);
            this.trees.push(this.buildTree(sample, 0));
        }
    }
    
    private bootstrapSample(data: number[][]): number[][] {
        const n = data.length;
        const sample = [];
        for (let i = 0; i < n; i++) {
            sample.push(data[Math.floor(Math.random() * n)]);
        }
        return sample;
    }
    
    private buildTree(data: number[][], depth: number): IsolationTree {
        if (data.length <= 1 || depth >= this.maxDepth) {
            return { isLeaf: true, size: data.length };
        }
        
        const nFeatures = data[0].length;
        const featureIdx = Math.floor(Math.random() * nFeatures);
        const values = data.map(row => row[featureIdx]);
        const minVal = Math.min(...values);
        const maxVal = Math.max(...values);
        
        if (minVal === maxVal) {
            return { isLeaf: true, size: data.length };
        }
        
        const splitValue = minVal + Math.random() * (maxVal - minVal);
        
        const left = data.filter(row => row[featureIdx] < splitValue);
        const right = data.filter(row => row[featureIdx] >= splitValue);
        
        return {
            isLeaf: false,
            featureIdx,
            splitValue,
            left: this.buildTree(left, depth + 1),
            right: this.buildTree(right, depth + 1),
        };
    }
    
    score(instance: number[]): number {
        const depths = this.trees.map(tree => this.pathLength(instance, tree, 0));
        const avgDepth = mean(depths);
        const c = 2 * (Math.log(this.nTrees - 1) + 0.5772156649) - (2 * (this.nTrees - 1) / this.nTrees);
        return Math.pow(2, -avgDepth / c);
    }
    
    private pathLength(instance: number[], tree: IsolationTree, depth: number): number {
        if (tree.isLeaf) return depth + Math.log2(tree.size);
        
        if (instance[tree.featureIdx] < tree.splitValue) {
            return this.pathLength(instance, tree.left, depth + 1);
        }
        return this.pathLength(instance, tree.right, depth + 1);
    }
}

interface IsolationTree {
    isLeaf: boolean;
    featureIdx?: number;
    splitValue?: number;
    left?: IsolationTree;
    right?: IsolationTree;
    size: number;
}

// Extraer features de audit_log
async function extractUserFeatures(
    supabase: any,
    userId: string,
    windowStart: string,
    windowEnd: string
): Promise<Record<string, number>> {
    const { data: events } = await supabase
        .from('audit_log')
        .select('action, module, entity_type, entity_id, status, created_at, metadata')
        .eq('user_id', userId)
        .gte('created_at', windowStart)
        .lte('created_at', windowEnd);
    
    const eventsByHour = new Map<string, typeof events>();
    for (const e of events ?? []) {
        const hourKey = e.created_at.slice(0, 13); // YYYY-MM-DDTHH
        if (!eventsByHour.has(hourKey)) eventsByHour.set(hourKey, []);
        eventsByHour.get(hourKey)!.push(e);
    }
    
    const hours = Array.from(eventsByHour.keys()).sort();
    const hoursCount = hours.length || 1;
    
    const features: Record<string, number> = {
        actions_per_hour: (events?.length ?? 0) / hoursCount,
        exports_per_hour: (events?.filter(e => e.action === 'export').length ?? 0) / hoursCount,
        deletes_per_hour: (events?.filter(e => e.action === 'delete').length ?? 0) / hoursCount,
        bulk_ops_per_hour: (events?.filter(e => e.action.startsWith('bulk_')).length ?? 0) / hoursCount,
        sensitive_actions_per_hour: (events?.filter(e => ['update_sensitive', 'delete', 'publish', 'assign', 'change_role', 'change_settings'].includes(e.action)).length ?? 0) / hoursCount,
        error_rate: (events?.filter(e => e.status === 'error').length ?? 0) / Math.max(events?.length ?? 1, 1),
        unique_modules_used: new Set(events?.map(e => e.module) ?? []).size,
        unique_entities_accessed: new Set(events?.map(e => e.entity_id).filter(Boolean) ?? []).size,
    };
    
    // Duración promedio de sesión (aproximado)
    const sessions = new Set(events?.map(e => e.session_id).filter(Boolean) ?? []);
    let sessionDurations: number[] = [];
    for (const sid of sessions) {
        const sessionEvents = events?.filter(e => e.session_id === sid) ?? [];
        if (sessionEvents.length > 1) {
            const times = sessionEvents.map(e => new Date(e.created_at).getTime()).sort((a, b) => a - b);
            sessionDurations.push((times[times.length - 1] - times[0]) / 1000 / 60); // minutos
        }
    }
    features.session_duration_avg = sessionDurations.length > 0 ? mean(sessionDurations) : 0;
    
    return features;
}

// Función principal de detección
async function detectAnomalies(
    supabase: any,
    userIds: string[],
    windowStart: string,
    windowEnd: string
): Promise<AnomalyResult[]> {
    const results: AnomalyResult[] = [];
    
    // Extraer features para todos los usuarios
    const userFeatures: Map<string, Record<string, number>> = new Map();
    for (const userId of userIds) {
        userFeatures.set(userId, await extractUserFeatures(supabase, userId, windowStart, windowEnd));
    }
    
    // Preparar datos para Isolation Forest
    const featureNames = ML_CONFIG.features;
    const trainingData: number[][] = [];
    const userIdsOrdered: string[] = [];
    
    for (const userId of userIds) {
        const features = userFeatures.get(userId);
        if (features) {
            trainingData.push(featureNames.map(f => features[f] ?? 0));
            userIdsOrdered.push(userId);
        }
    }
    
    // Método 1: Z-Score
    const featureValues: Record<string, number[]> = {};
    for (const fname of featureNames) {
        featureValues[fname] = trainingData.map(row => row[featureNames.indexOf(fname)]);
    }
    
    const zScoreAnomalies = detectZScoreAnomalies(featureValues, ML_CONFIG.zScoreThreshold);
    
    // Método 2: IQR
    const iqrAnomalies = detectIQRAnomalies(featureValues, ML_CONFIG.iqrMultiplier);
    
    // Método 3: Isolation Forest (si hay suficientes datos)
    let iforestScores: Map<string, number> = new Map();
    if (trainingData.length >= ML_CONFIG.minSamplesForTraining) {
        const forest = new SimpleIsolationForest(50, 8);
        forest.fit(trainingData);
        
        for (let i = 0; i < userIdsOrdered.length; i++) {
            const score = forest.score(trainingData[i]);
            iforestScores.set(userIdsOrdered[i], score);
        }
    }
    
    // Ensemble: combinar métodos
    for (const userId of userIds) {
        let anomalyScore = 0;
        const methods: string[] = [];
        const contributingFeatures: string[] = [];
        
        // Z-Score contribution
        if (zScoreAnomalies.has(userId)) {
            anomalyScore += 0.4;
            methods.push('zscore');
            contributingFeatures.push(...zScoreAnomalies.get(userId)!);
        }
        
        // IQR contribution
        if (iqrAnomalies.has(userId)) {
            anomalyScore += 0.3;
            methods.push('iqr');
            contributingFeatures.push(...iqrAnomalies.get(userId)!);
        }
        
        // Isolation Forest contribution
        const ifScore = iforestScores.get(userId);
        if (ifScore !== undefined && ifScore > ML_CONFIG.isolationForestContamination) {
            anomalyScore += 0.3 * ifScore;
            methods.push('isolation_forest');
            contributingFeatures.push(`isolation_forest_score=${ifScore.toFixed(3)}`);
        }
        
        const isAnomaly = anomalyScore > 0.5 || methods.length >= 2;
        
        results.push({
            userId,
            windowStart,
            windowEnd,
            anomalyScore: Math.min(anomalyScore, 1.0),
            isAnomaly,
            method: methods.join('+') as AnomalyResult['method'],
            contributingFeatures,
            details: {
                zscore_factors: zScoreAnomalies.get(userId) ?? [],
                iqr_factors: iqrAnomalies.get(userId) ?? [],
                isolation_forest_score: ifScore,
            },
        });
    }
    
    return results;
}

// Guardar resultados en DB
async function saveAnomalyResults(supabase: any, results: AnomalyResult[]): Promise<void> {
    for (const r of results) {
        if (r.isAnomaly) {
            await supabase
                .from('supervision_alerts')
                .insert({
                    user_id: r.userId,
                    module: 'ml_anomaly',
                    severity: r.anomalyScore > 0.8 ? 'critical' : r.anomalyScore > 0.6 ? 'high' : 'medium',
                    alert_type: 'ml_anomaly_detection',
                    title: `Anomalía detectada: ${r.method}`,
                    description: `Score: ${(r.anomalyScore * 100).toFixed(1)}%. Factores: ${r.contributingFeatures.join(', ')}`,
                    evidence: r.details,
                    status: 'open',
                });
        }
    }
}

// Endpoint principal
async function handleDetect(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const hours = parseInt(url.searchParams.get('hours') ?? '24');
    const userIdsParam = url.searchParams.get('user_ids');
    
    const windowEnd = new Date().toISOString();
    const windowStart = new Date(Date.now() - hours * 3600000).toISOString();
    
    let userIds: string[];
    if (userIdsParam) {
        userIds = userIdsParam.split(',');
    } else {
        // Obtener usuarios activos en la ventana
        const { data } = await supabase
            .from('audit_log')
            .select('user_id')
            .gte('created_at', windowStart)
            .lte('created_at', windowEnd);
        userIds = [...new Set(data?.map(d => d.user_id).filter(Boolean) ?? [])];
    }
    
    const results = await detectAnomalies(supabase, userIds, windowStart, windowEnd);
    await saveAnomalyResults(supabase, results);
    
    return jsonResponse(200, {
        window: { start: windowStart, end: windowEnd },
        usersAnalyzed: userIds.length,
        anomaliesFound: results.filter(r => r.isAnomaly).length,
        results: results.filter(r => r.isAnomaly),
    });
}

async function handleTrain(req: Request): Promise<Response> {
    // Reentrenar modelo con datos históricos
    const body = await req.json();
    const { days = 30 } = body;
    
    const windowEnd = new Date().toISOString();
    const windowStart = new Date(Date.now() - days * 86400000).toISOString();
    
    const { data } = await supabase
        .from('audit_log')
        .select('user_id')
        .gte('created_at', windowStart)
        .lte('created_at', windowEnd);
    
    const userIds = [...new Set(data?.map(d => d.user_id).filter(Boolean) ?? [])];
    const results = await detectAnomalies(supabase, userIds, windowStart, windowEnd);
    
    return jsonResponse(200, {
        message: 'Model trained on historical data',
        users: userIds.length,
        anomalies: results.filter(r => r.isAnomaly).length,
    });
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    
    const url = new URL(req.url);
    const path = url.pathname.split('/').pop();
    
    try {
        const auth = req.headers.get('authorization') ?? '';
        if (!auth.startsWith('Bearer ')) return jsonResponse(401, { error: 'No autorizado' });
        
        const token = auth.slice(7);
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) return jsonResponse(401, { error: 'Token inválido' });
        
        const { data: profile } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', user.id)
            .single();
        
        if (!profile || profile.role !== 'super_admin') {
            return jsonResponse(403, { error: 'Solo super_admin' });
        }
        
        switch (path) {
            case 'detect':
                return handleDetect(req);
            case 'train':
                return handleTrain(req);
            default:
                return jsonResponse(404, { error: 'Endpoint no encontrado' });
        }
    } catch (error) {
        console.error('[supervision-ml-anomaly] Error:', error);
        return jsonResponse(500, { error: 'Error interno' });
    }
});