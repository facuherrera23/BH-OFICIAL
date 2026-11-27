// ============================================================
// Traza de envíos del CRM (P0-4 — 2026-11-27).
//
// Hasta ahora NO existía ningún rastro de los envíos del CRM: `audit_log`
// registra cambios de DATOS, no emails. Consecuencia medida (27/11/2026):
// 14 alertas `crm_email_broken` abiertas del 24/9 al 10/10 (incidentes
// viejos que nadie cerraba) y CERO evidencia para saber si hoy el CRM avisa.
//
// `crm_envios` (tabla) + este helper = una fila por envío, con su resultado
// y su contexto (lead / agente / visita / tarea). La tabla tiene un trigger
// que mantiene la alerta `crm_email_broken` coherente: se abre con un error
// y se auto-resuelve con el primer envío OK.
//
// REGLA: la traza NUNCA puede romper el envío. Si el INSERT falla, se loguea
// y se sigue (el envío es lo importante).
// ============================================================

export type EnvioEstado = 'enviado' | 'error' | 'omitido';
export type EnvioCanal = 'email' | 'whatsapp';

export interface EnvioRegistro {
  /** Identificador del flujo: 'notify_new_lead' | 'lead_task_reminder' | 'visit_reminder' | 'commission' */
  origen: string;
  canal?: EnvioCanal;
  estado: EnvioEstado;
  destinatario?: string | null;
  asunto?: string | null;
  proveedor?: string | null;
  lead_id?: string | null;
  agente_id?: string | null;
  visita_id?: string | null;
  tarea_id?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Registra un envío en `crm_envios`.
 * @param supabase Cliente con service_role (la escritura está revocada para
 *                authenticated; service_role la saltea por bypassrls).
 * @returns true si la traza se guardó, false si falló (nunca lanza).
 */
export async function registrarEnvio(
  supabase: any,
  reg: EnvioRegistro,
): Promise<boolean> {
  try {
    const payload: Record<string, unknown> = {
      origen: reg.origen,
      canal: reg.canal ?? 'email',
      estado: reg.estado,
      destinatario: reg.destinatario ?? null,
      asunto: reg.asunto ?? null,
      proveedor: reg.proveedor ?? null,
      lead_id: reg.lead_id ?? null,
      agente_id: reg.agente_id ?? null,
      visita_id: reg.visita_id ?? null,
      tarea_id: reg.tarea_id ?? null,
      error: reg.error ?? null,
      metadata: reg.metadata ?? {},
    };
    const { error } = await supabase.from('crm_envios').insert(payload);
    if (error) {
      console.error('[crm_envios] no se pudo registrar el envío:', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[crm_envios] excepción al registrar el envío:', e);
    return false;
  }
}

/** Normaliza un email a minúsculas sin espacios (para deduplicar/reportes). */
export function normalizarDestinatario(v: string | null | undefined): string {
  return String(v ?? '').trim().toLowerCase();
}
