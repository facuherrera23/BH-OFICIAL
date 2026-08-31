/* ============================================================
   RELA API Client (Deno / Edge Functions)
   API: Open RELA — Grupo QuintoAndar
   Documentado en https://open-classifieds.notion.site/arg/rela/

   Endpoints usados (documentados):
   - POST /v1/application/login?grant_type=client_credentials&client_id&client_secret
   - GET  /v1/inmobiliarias
   - GET  /v1/inmobiliarias/{codigo}/disponibilidad
   - PUT  /v1/inmobiliarias/{codigo}/avisos/{codigoAviso}   (upsert)
   - GET  /v1/inmobiliarias/{codigo}/avisos/{codigoAviso}   (*la doc lista "PUT" en
         la sección 2.5 ítem 2 pero es claramente consulta; se usa GET.
         REQUIRES_CONFIRMATION: la doc lo tipó ambiguo)
   - DELETE /v1/inmobiliarias/{codigo}/avisos/{codigoAviso} (offline)
   - PUT  /v1/inmobiliarias/{codigo}/avisos/{codigoAviso}/asociar/{idAviso}
   - GET  /v1/ubicaciones | /v1/ubicaciones/{id}
   - GET  /v1/tipopropiedades | /v1/tipopropiedades/{id}/subtipos | /{id}/caracteristicas
   - GET  /v1/publicacion/planes | /v1/operaciones | /v1/monedas
   - PUT  /v1/configuracion/callbacks | GET /v1/configuracion/callbacks

   REQUIRES_CONFIRMATION (no documentados explícitamente, quedan como
   constantes configurables y marcados en docs/integrations/RELA.md):
   - Resumen de avisos online (análogo al GET /v1/inmobiliarias/{c}/desarrollos/online/resumen)
   - Endpoints de suscripción/baja de eventos de callback
   - Endpoint de calidad de aviso / inmobiliaria
   - Endpoint de contactos (polling de leads)
   ============================================================ */

import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

export interface RelaEnvConfig {
  baseUrl: string;
  role: string; // 'zp' para Argentina
  clientId: string;
  clientSecret: string;
}

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // re-obtener 5 min antes de expirar
const RETRY_DELAYS_MS = [1000, 3000, 9000];
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class RelaError extends Error {
  status: number;
  body: unknown;
  retryable: boolean;
  constructor(message: string, status: number, body: unknown, retryable: boolean) {
    super(message);
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

export class RelaClient {
  private supabase: SupabaseClient;
  private cfg: RelaEnvConfig;
  private correlationId: string;

  constructor(supabase: SupabaseClient, cfg: RelaEnvConfig, correlationId?: string) {
    this.supabase = supabase;
    this.cfg = cfg;
    this.correlationId = correlationId ?? crypto.randomUUID();
  }

  private get tokenUrl(): string {
    const q = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    return `${this.cfg.baseUrl}/v1/application/login?${q.toString()}`;
  }

  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const { data } = await this.supabase
        .from('rela_tokens')
        .select('access_token, expires_at')
        .eq('id', true)
        .maybeSingle();
      if (data && new Date(data.expires_at).getTime() - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
        return data.access_token as string;
      }
    }

    const startedAt = Date.now();
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'User-Agent': this.userAgent() },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.access_token) {
      throw new RelaError(
        `RELA login falló (${res.status})`,
        res.status,
        body,
        RETRYABLE_STATUSES.has(res.status),
      );
    }
    const expiresInSec = Number(body.expires_in ?? 0);
    const expiresAt = expiresInSec > 0
      ? new Date(Date.now() + expiresInSec * 1000)
      : new Date(Date.now() + 24 * 3600 * 1000); // fallback 24h si no informa

    await this.supabase.from('rela_tokens').upsert({
      id: true,
      access_token: body.access_token,
      expires_at: expiresAt.toISOString(),
      obtained_at: new Date().toISOString(),
    });
    await this.supabase
      .from('rela_config')
      .update({ last_auth_at: new Date().toISOString(), last_error: null })
      .eq('id', true);

    console.log(JSON.stringify({
      module: 'rela', action: 'token_obtained', correlationId: this.correlationId,
      durationMs: Date.now() - startedAt, expiresAt,
    }));
    return body.access_token as string;
  }

  private userAgent(): string {
    return 'BienenhausCRM/1.0 (contacto@bienenhaus.com.ar)';
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { attempt?: number; retryOnAuth?: boolean },
  ): Promise<T> {
    const attempt = opts?.attempt ?? 0;
    const token = await this.getToken(opts?.retryOnAuth === true);
    const startedAt = Date.now();

    // Sandbox AR (api-zp-…): los endpoints bajo /v1/inmobiliarias/{codigo}/…
    // rechazan el Bearer header con invalid_token; funciona el query param
    // documentado en la doc vieja (?access_token=). Se envían ambos.
    const sep = path.includes('?') ? '&' : '?';
    const url = path.startsWith('/v1/inmobiliarias/')
      ? `${this.cfg.baseUrl}${path}${sep}access_token=${encodeURIComponent(token)}`
      : `${this.cfg.baseUrl}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        return this.request(method, path, body, { attempt: attempt + 1 });
      }
      throw new RelaError(`RELA red: ${(err as Error).message}`, 0, null, true);
    }

    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }

    console.log(JSON.stringify({
      module: 'rela', action: 'api_call', correlationId: this.correlationId,
      method, path, status: res.status, durationMs: Date.now() - startedAt, attempt,
    }));

    if (res.status === 401 && attempt === 0 && !opts?.retryOnAuth) {
      return this.request(method, path, body, { attempt: 1, retryOnAuth: true });
    }

    if (!res.ok) {
      const retryable = RETRYABLE_STATUSES.has(res.status);
      if (retryable && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        return this.request(method, path, body, { attempt: attempt + 1 });
      }
      throw new RelaError(
        `RELA ${method} ${path} → ${res.status}`,
        res.status, parsed, retryable,
      );
    }
    return parsed as T;
  }

  // ---------- Wrapper semánticos (endpoints documentados) ----------

  listInmobiliarias<T = unknown>() { return this.request<T>('GET', '/v1/inmobiliarias'); }

  getDisponibilidad<T = unknown>(codigoInmobiliaria: string) {
    return this.request<T>('GET', `/v1/inmobiliarias/${enc(codigoInmobiliaria)}/disponibilidad`);
  }

  upsertAviso<T = unknown>(codigoInmobiliaria: string, codigoAviso: string, payload: unknown) {
    return this.request<T>(
      'PUT',
      `/v1/inmobiliarias/${enc(codigoInmobiliaria)}/avisos/${enc(codigoAviso)}`,
      payload,
    );
  }

  getAviso<T = unknown>(codigoInmobiliaria: string, codigoAviso: string) {
    return this.request<T>('GET', `/v1/inmobiliarias/${enc(codigoInmobiliaria)}/avisos/${enc(codigoAviso)}`);
  }

  deleteAviso<T = unknown>(codigoInmobiliaria: string, codigoAviso: string) {
    return this.request<T>('DELETE', `/v1/inmobiliarias/${enc(codigoInmobiliaria)}/avisos/${enc(codigoAviso)}`);
  }

  asociarAviso<T = unknown>(codigoInmobiliaria: string, codigoAviso: string, idAviso: number | string) {
    return this.request<T>(
      'PUT',
      `/v1/inmobiliarias/${enc(codigoInmobiliaria)}/avisos/${enc(codigoAviso)}/asociar/${enc(String(idAviso))}`,
    );
  }

  getUbicaciones<T = unknown>(parentId?: string) {
    return this.request<T>('GET', parentId ? `/v1/ubicaciones/${enc(parentId)}` : '/v1/ubicaciones');
  }

  getTipoPropiedades<T = unknown>() { return this.request<T>('GET', '/v1/tipopropiedades'); }
  getTipoPropiedadSubtipos<T = unknown>(id: string) {
    return this.request<T>('GET', `/v1/tipopropiedades/${enc(id)}/subtipos`);
  }
  getTipoPropiedadCaracteristicas<T = unknown>(id: string) {
    return this.request<T>('GET', `/v1/tipopropiedades/${enc(id)}/caracteristicas`);
  }

  getPlanes<T = unknown>() { return this.request<T>('GET', '/v1/publicacion/planes'); }
  getOperaciones<T = unknown>() { return this.request<T>('GET', '/v1/operaciones'); }
  getMonedas<T = unknown>() { return this.request<T>('GET', '/v1/monedas'); }

  getCallbacksConfig<T = unknown>() { return this.request<T>('GET', '/v1/configuracion/callbacks'); }
  setCallbacksConfig<T = unknown>(config: {
    url: string;
    authorizationHeaderKey?: string;
    authorizationHeaderValue?: string;
    lenguajeCallbackBody?: 'ES' | 'EN' | 'PT';
  }) {
    return this.request<T>('PUT', '/v1/configuracion/callbacks', config);
  }
}

export function makeRelaClient(
  supabaseUrl: string,
  serviceRoleKey: string,
  env: RelaEnvConfig,
  correlationId?: string,
): RelaClient {
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  return new RelaClient(supabase, env, correlationId);
}

function enc(s: string): string { return encodeURIComponent(s); }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

export function loadRelaEnv(): RelaEnvConfig | null {
  const clientId = Deno.env.get('RELA_CLIENT_ID');
  const clientSecret = Deno.env.get('RELA_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  return {
    baseUrl: Deno.env.get('RELA_BASE_URL') || 'https://api-zp-sandbox-open.navent.com',
    role: Deno.env.get('RELA_ROLE') || 'zp',
    clientId,
    clientSecret,
  };
}
