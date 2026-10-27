// ============================================================
// _shared/social.ts — Utilidades del módulo CONTENIDO.
//
// Compartido por las edge functions de todas las plataformas
// (youtube/facebook/instagram/tiktok) para que cada red nueva
// reutilice lo mismo:
//   - getSocialCredentials: client_id/secret desde app_settings
//     (clave social_{plataforma}) con fallback a env vars. Así el
//     dueño cambia credenciales sin redeploy.
//   - getSocialAccessToken: token de cuenta con refresh automático
//     (CAS como getMlAccessToken de ML) — desencripta con
//     _shared/crypto.ts, refresca si vence en <5 min y persiste el
//     nuevo access token. El refresh_token nunca se devuelve en
//     claro fuera de esta librería.
// ============================================================

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { encrypt, decrypt } from './crypto.ts';

export type SocialPlatform = 'youtube' | 'facebook' | 'instagram' | 'tiktok';

export interface SocialCredentials {
    clientId: string;
    clientSecret: string;
}

interface CredentialsRow {
    client_id?: string | null;
    clientSecret?: string | null;
    client_secret?: string | null;
}

/** Credenciales OAuth de la plataforma: app_settings social_{platform} → env. */
export async function getSocialCredentials(
    supabase: SupabaseClient,
    platform: SocialPlatform,
): Promise<SocialCredentials> {
    const { data } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', `social_${platform}`)
        .maybeSingle();
    const row = (data?.value ?? {}) as CredentialsRow;
    const clientId = row.client_id ?? Deno.env.get(`SOCIAL_${platform.toUpperCase()}_CLIENT_ID`) ?? '';
    const clientSecret = row.client_secret ?? row.clientSecret ??
        Deno.env.get(`SOCIAL_${platform.toUpperCase()}_CLIENT_SECRET`) ?? '';
    return { clientId, clientSecret };
}

interface AccountRow {
    id: string;
    platform: SocialPlatform;
    access_token_encrypted: string | null;
    access_token_iv: string | null;
    refresh_token_encrypted: string | null;
    refresh_token_iv: string | null;
    token_expires_at: string | null;
    status: string;
}

/**
 * Access token vigente de la cuenta (refresh si vence en <5 min).
 * CAS: si otra instancia refrescó primero, la UPDATE con WHERE sobre el
 * access_token viejo pierde y se relee el token nuevo (patrón ML).
 */
export async function getSocialAccessToken(
    supabase: SupabaseClient,
    accountId: string,
): Promise<string> {
    const { data: acc, error } = await supabase
        .from('social_accounts')
        .select('id, platform, access_token_encrypted, access_token_iv, refresh_token_encrypted, refresh_token_iv, token_expires_at, status')
        .eq('id', accountId)
        .maybeSingle() as { data: AccountRow | null; error: { message: string } | null };
    if (error || !acc) throw new Error('Cuenta social no encontrada');
    if (acc.status !== 'active') throw new Error(`Cuenta ${acc.platform} desconectada`);
    if (!acc.access_token_encrypted || !acc.access_token_iv) {
        throw new Error('Cuenta sin token guardado — reconectala');
    }

    let accessToken = await decrypt(acc.access_token_encrypted, acc.access_token_iv);
    const expiresAt = acc.token_expires_at ? new Date(acc.token_expires_at).getTime() : 0;
    const needsRefresh = expiresAt - Date.now() < 5 * 60_000;

    if (!needsRefresh) return accessToken;
    if (!acc.refresh_token_encrypted || !acc.refresh_token_iv) {
        throw new Error('Token vencido sin refresh_token — reconecta la cuenta');
    }

    const refreshToken = await decrypt(acc.refresh_token_encrypted, acc.refresh_token_iv);
    const { clientId, clientSecret } = await getSocialCredentials(supabase, acc.platform);
    const refreshed = await refreshOAuthToken(acc.platform, clientId, clientSecret, refreshToken);

    const enc = await encrypt(refreshed.accessToken);
    const { data: updated } = await supabase
        .from('social_accounts')
        .update({
            access_token_encrypted: enc.data,
            access_token_iv: enc.iv,
            token_expires_at: new Date(Date.now() + refreshed.expiresIn * 1000).toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq('id', accountId)
        .eq('access_token_iv', acc.access_token_iv) // CAS: solo si nadie refrescó antes
        .select('access_token_encrypted, access_token_iv')
        .maybeSingle();

    if (updated?.access_token_encrypted) {
        // Otra instancia ganó el refresh: usar su token
        accessToken = await decrypt(updated.access_token_encrypted, updated.access_token_iv);
    } else {
        accessToken = refreshed.accessToken;
    }
    return accessToken;
}

export interface RefreshedToken {
    accessToken: string;
    expiresIn: number;
}

/** Refresh del access token por plataforma (v1: Google/YouTube). */
export async function refreshOAuthToken(
    platform: SocialPlatform,
    clientId: string,
    clientSecret: string,
    refreshToken: string,
): Promise<RefreshedToken> {
    if (platform === 'youtube') {
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
            }),
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Google token refresh ${res.status}: ${body.slice(0, 200)}`);
        }
        const json = (await res.json()) as { access_token?: string; expires_in?: number };
        if (!json.access_token) throw new Error('Google refresh sin access_token');
        return { accessToken: json.access_token, expiresIn: json.expires_in ?? 3600 };
    }
    throw new Error(`Refresh para ${platform} aún no implementado`);
}
