import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY') || '';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const PLATFORMS = new Set([
  'instagram',
  'facebook',
  'whatsapp',
  'telegram',
  'twitter',
  'bluesky',
  'reddit',
  'slack'
]);

const ALLOWED_ORIGINS = new Set([
  'https://bienenhaus.com.ar',
  'https://www.bienenhaus.com.ar',
  'http://localhost:8788',
  'http://127.0.0.1:8788'
]);

// ---------- Utilidades genéricas ----------

function log(level, entry) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    function: 'zernio-webhook-test',
    ...entry
  }));
}

function corsHeaders(req) {
  const origin = req.headers.get('origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-zernio-signature, x-zernio-event-id',
      vary: 'Origin'
    };
  }
  return {};
}

function respond(status, body, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      'content-type': 'application/json'
    }
  });
}

function optionsResponse(req) {
  return new Response('ok', {
    headers: {
      ...corsHeaders(req),
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-zernio-signature, x-zernio-event-id'
    }
  });
}

function timingSafeEqual(a, b) {
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getWebhookSecret() {
  const envSecret = Deno.env.get('ZERNIO_WEBHOOK_SECRET');
  if (envSecret) return envSecret;
  const { data } = await supabase
    .from('zernio_config')
    .select('value')
    .eq('key', 'webhook_secret')
    .maybeSingle();
  return data?.value?.secret || '';
}

function eventType(ev) {
  return String(ev.event || ev.type || '');
}

function eventData(ev) {
  return ev.data || ev.payload || {};
}

function str(v) {
  return v === undefined || v === null ? '' : String(v);
}

function normalizeTs(v) {
  const r = str(v);
  if (r) {
    const p = Date.parse(r);
    if (!isNaN(p)) return new Date(p).toISOString();
  }
  return new Date().toISOString();
}

function truncate(t, max = 120) {
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---------- Acceso a datos ----------

async function ensureAccount(accountId, platformHint) {
  if (!accountId) return false;

  const { data: existing } = await supabase
    .from('zernio_accounts')
    .select('zernio_account_id')
    .eq('zernio_account_id', accountId)
    .maybeSingle();
  if (existing) return true;

  const platform = typeof platformHint === 'string' && PLATFORMS.has(platformHint) ? platformHint : null;
  if (!platform) return false;

  const { error } = await supabase.from('zernio_accounts').insert({
    zernio_account_id: accountId,
    platform,
    username: '',
    status: 'connected'
  });
  return !error;
}

async function upsertConversation(convId, accountId, contactName, contactHandle) {
  const payload = { id: convId, account_id: accountId };
  if (contactName) payload.contact_name = contactName;
  if (contactHandle) payload.contact_handle = contactHandle;

  const { error } = await supabase.from('zernio_conversations').upsert(payload, { onConflict: 'id' });
  if (error) throw new Error('upsert_conversation: ' + error.message);
}

async function insertMessage(row) {
  const { error } = await supabase.from('zernio_messages').insert(row);
  if (!error) return 'inserted';
  if (error.code === '23505') return 'duplicate';
  throw new Error('insert_message: ' + error.message);
}

// ---------- Manejo de eventos ----------

async function handleEvent(type, ev) {
  const data = eventData(ev);
  const conv = data.conversation || {};
  const msg = data.message || {};
  const convId = str(conv.id || data.conversationId);
  const accountId = str(conv.accountId || data.accountId || msg.accountId);

  switch (type) {
    case 'conversation.started': {
      if (!convId || !accountId) {
        log('warn', { event: type, error: 'faltan ids', conv_id: convId, account_id: accountId });
        return;
      }
      if (!await ensureAccount(accountId, conv.platform || data.platform)) return;
      await upsertConversation(
        convId,
        accountId,
        str(conv.contactName || conv.name || data.contactName),
        str(conv.contactHandle || conv.handle || data.contactHandle)
      );
      log('info', { event: type, conv_id: convId });
      return;
    }

    case 'message.received': {
      if (!convId || !accountId) {
        log('warn', { event: type, error: 'faltan ids', conv_id: convId, account_id: accountId });
        return;
      }
      if (!await ensureAccount(accountId, conv.platform || data.platform)) return;
      await upsertConversation(
        convId,
        accountId,
        str(conv.contactName || conv.name || data.contactName),
        str(conv.contactHandle || conv.handle || data.contactHandle)
      );

      const body = str(msg.text || msg.body || data.text);
      const occurredAt = normalizeTs(msg.createdAt || msg.timestamp || data.createdAt || data.timestamp);

      const inserted = await insertMessage({
        conversation_id: convId,
        direction: 'in',
        platform_message_id: str(msg.id || msg.messageId) || null,
        body,
        attachment: msg.attachment || msg.attachments || null,
        status: 'received',
        zernio_event_id: str(ev.id) || null,
        occurred_at: occurredAt
      });

      if (inserted === 'inserted') {
        const { data: convRow } = await supabase
          .from('zernio_conversations')
          .select('unread_count')
          .eq('id', convId)
          .maybeSingle();

        await supabase
          .from('zernio_conversations')
          .update({
            unread_count: (convRow?.unread_count || 0) + 1,
            last_message_at: occurredAt,
            last_message_preview: truncate(body)
          })
          .eq('id', convId);

        log('info', { event: type, conv_id: convId, message_id: str(msg.id || msg.messageId) });
      } else {
        log('info', { event: type, conv_id: convId, dedup: true });
      }
      return;
    }

    case 'message.sent':
    case 'message.delivered':
    case 'message.read': {
      const status = type === 'message.sent' ? 'sent' : type === 'message.delivered' ? 'delivered' : 'read';
      const platformMessageId = str(msg.id || msg.messageId);

      if (platformMessageId) {
        await supabase
          .from('zernio_messages')
          .update({ status })
          .eq('platform_message_id', platformMessageId)
          .eq('direction', 'out');
        log('info', { event: type, platform_message_id: platformMessageId, status });
        return;
      }

      if (type === 'message.sent' && convId && accountId) {
        if (!await ensureAccount(accountId, conv.platform || data.platform)) return;
        await upsertConversation(
          convId,
          accountId,
          str(conv.contactName || data.contactName),
          str(conv.contactHandle || data.contactHandle)
        );
        await insertMessage({
          conversation_id: convId,
          direction: 'out',
          platform_message_id: null,
          body: str(msg.text || msg.body || data.text),
          attachment: msg.attachment || null,
          status: 'sent',
          zernio_event_id: str(ev.id) || null,
          occurred_at: normalizeTs(msg.createdAt || data.createdAt)
        });
        log('info', { event: type, conv_id: convId, inserted_fallback: true });
      }
      return;
    }

    case 'message.failed': {
      const platformMessageId = str(msg.id || msg.messageId);
      const errObj = msg.error || data.error || { title: 'Error desconocido' };

      if (platformMessageId) {
        await supabase
          .from('zernio_messages')
          .update({ status: 'failed', error: errObj })
          .eq('platform_message_id', platformMessageId)
          .eq('direction', 'out');
        log('warn', { event: type, platform_message_id: platformMessageId });
      }
      return;
    }

    case 'account.connected':
    case 'account.disconnected': {
      const acct = data.account || data;
      const accId = str(acct.id || acct.accountId || data.accountId);
      if (!accId) {
        log('warn', { event: type, error: 'account id ausente' });
        return;
      }

      const platformRaw = str(acct.platform || data.platform);
      const platform = PLATFORMS.has(platformRaw) ? platformRaw : null;

      if (!await ensureAccount(accId, platform)) {
        log('warn', { event: type, error: 'no se pudo asegurar cuenta', account_id: accId });
        return;
      }

      const update = {
        status: type === 'account.connected' ? 'connected' : 'disconnected',
        raw: acct,
        last_synced_at: new Date().toISOString()
      };
      const username = str(acct.username || acct.name);
      if (username) update.username = username;

      await supabase.from('zernio_accounts').update(update).eq('zernio_account_id', accId);
      log('info', { event: type, account_id: accId });
      return;
    }

    case 'webhook.test': {
      log('info', { event: type, detail: 'ping de prueba de Zernio (función de test)' });
      return;
    }

    default: {
      log('info', { event: type, detail: 'evento no manejado (ack silencioso)' });
    }
  }
}

// ---------- Entry point ----------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return optionsResponse(req);

  if (req.method !== 'POST') {
    return respond(405, { error: 'Method not allowed' }, req);
  }

  const rawBody = await req.text();
  if (rawBody.length > 1_000_000) {
    return respond(413, { error: 'Payload demasiado grande' }, req);
  }

  const secret = await getWebhookSecret();
  if (!secret) {
    return respond(503, { error: 'Servicio no configurado' }, req);
  }

  const signature = (req.headers.get('x-zernio-signature') || '').toLowerCase().trim();
  const computed = await hmacSha256Hex(secret, rawBody);

  if (!signature || !timingSafeEqual(signature, computed)) {
    return respond(401, { error: 'Firma inválida' }, req);
  }

  let ev;
  try {
    ev = JSON.parse(rawBody);
  } catch {
    return respond(400, { error: 'JSON inválido' }, req);
  }

  const type = eventType(ev);
  const eventId = str(ev.id) || req.headers.get('x-zernio-event-id') || '';

  if (!eventId || !type) {
    return respond(200, { ok: true, ignored: 'missing id/type' }, req);
  }

  const { error: dedupErr } = await supabase
    .from('zernio_webhook_events')
    .insert({ id: eventId, event: type, payload: ev });

  if (dedupErr) {
    if (dedupErr.code === '23505') {
      return respond(200, { ok: true, dedup: true }, req);
    }
    log('error', { operation: 'dedup_insert', event: type, error: dedupErr.message });
    return respond(500, { error: 'Error interno' }, req);
  }

  try {
    await handleEvent(type, ev);
  } catch (err) {
    log('error', { operation: 'handle', event: type, error: err.message });
  }

  return respond(200, { ok: true }, req);
});