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

    let accessToken: string;
    try {
        accessToken = await decrypt(acc.access_token_encrypted, acc.access_token_iv);
    } catch (_) {
        /* AUDIT 2026-10-27: el error crudo de GCM ("Tag length overflows
           ciphertext") no le dice nada al usuario — la acción es reconectar. */
        throw new Error('La conexión de la cuenta está dañada — desconectala y volvé a conectarla.');
    }
    const expiresAt = acc.token_expires_at ? new Date(acc.token_expires_at).getTime() : 0;
    const needsRefresh = expiresAt - Date.now() < 5 * 60_000;

    if (!needsRefresh) return accessToken;
    if (!acc.refresh_token_encrypted || !acc.refresh_token_iv) {
        throw new Error('Token vencido sin refresh_token — reconecta la cuenta');
    }

    const refreshToken = await decrypt(acc.refresh_token_encrypted, acc.refresh_token_iv);
    const { clientId, clientSecret } = await getSocialCredentials(supabase, acc.platform);

    let refreshed: RefreshedToken;
    try {
        refreshed = await refreshOAuthToken(acc.platform, clientId, clientSecret, refreshToken);
    } catch (err) {
        /* Rotación (TikTok): si otra instancia refrescó primero, el refresh
           remoto de ESTA falla con invalid_grant (el refresh viejo ya se
           gastó) — pero la fila ya tiene el access token nuevo. Releer antes
           de rendirse: si hay token fresco, usarlo. */
        const { data: again } = await supabase
            .from('social_accounts')
            .select('access_token_encrypted, access_token_iv, token_expires_at')
            .eq('id', accountId)
            .maybeSingle() as { data: { access_token_encrypted: string | null; access_token_iv: string | null; token_expires_at: string | null } | null };
        if (again?.access_token_encrypted && again.access_token_iv) {
            const expAgain = again.token_expires_at ? new Date(again.token_expires_at).getTime() : 0;
            if (expAgain - Date.now() > 60_000) {
                try {
                    return await decrypt(again.access_token_encrypted, again.access_token_iv);
                } catch (_) { /* fila dañada — sigue el error original */ }
            }
        }
        throw err;
    }

    const enc = await encrypt(refreshed.accessToken);
    const update: Record<string, unknown> = {
        access_token_encrypted: enc.data,
        access_token_iv: enc.iv,
        token_expires_at: new Date(Date.now() + refreshed.expiresIn * 1000).toISOString(),
        updated_at: new Date().toISOString(),
    };
    if (refreshed.refreshToken) {
        /* Rotación TikTok: persistir el refresh NUEVO (el viejo ya no sirve).
           El CAS de abajo asegura que solo gane quien refrescó con el access
           token vigente al leer. */
        const encRef = await encrypt(refreshed.refreshToken);
        update.refresh_token_encrypted = encRef.data;
        update.refresh_token_iv = encRef.iv;
    }
    const { data: updated } = await supabase
        .from('social_accounts')
        .update(update)
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
    /** Rotación (TikTok): un refresh exitoso devuelve un refresh_token NUEVO
        que reemplaza al anterior — el viejo se invalida al instante. Si no
        viene, el refresh token es estable (Google/YouTube). */
    refreshToken?: string;
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
    if (platform === 'tiktok') {
        /* TikTok: access token 2h, refresh token 180 días ROTATIVO — cada
           refresh devuelve un refresh_token nuevo que invalida el anterior.
           El caller (getSocialAccessToken) persiste el nuevo. */
        const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_key: clientId,
                client_secret: clientSecret,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }),
        });
        const json = await res.json().catch(() => ({})) as {
            access_token?: string;
            expires_in?: number;
            refresh_token?: string;
            error?: string;
            error_description?: string;
        };
        if (!res.ok || !json.access_token) {
            const desc = json.error_description || json.error || `HTTP ${res.status}`;
            throw new Error(`TikTok token refresh: ${desc.slice(0, 200)}`);
        }
        return {
            accessToken: json.access_token,
            expiresIn: json.expires_in ?? 7200,
            refreshToken: json.refresh_token,
        };
    }
    throw new Error(`Refresh para ${platform} aún no implementado`);
}
