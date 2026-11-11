// Captación de leads desde redes (2026-11-11) — guards estáticos.
//
// POR QUÉ ESTE GUARD: el dueño pidió "traer leads de los 4 canales".
// Facebook/Instagram llegan por webhook de Meta + sync del Graph API
// (tabla social_comments + bandeja "Consultas" del módulo CONTENIDO);
// YouTube ya tenía su flujo (social-youtube-comments); TikTok NO expone
// comentarios por API (limitación documentada, no es un bug).
//
// Los errores caros de este módulo serían:
//   · webhook sin verificación de firma (cualquiera crea comentarios),
//   · crear leads AUTOMÁTICOS desde el webhook (patrón correcto:
//     admin-initiated con consent_at — los comentarios son chatter),
//   · la bandeja escribiendo directo en leads (RLS),
//   · deployar el webhook con verify_jwt ON (Meta no manda JWT → 401).
//
// Guard estático: lee el repo, NO toca la BD ni la red.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const migration = read('supabase/migrations/20261111000001_social_comments.sql');
const webhook = read('supabase/functions/social-webhook-meta/index.ts');
const server = read('supabase/functions/social-comments/index.ts');
const client = read('assets/js/social-inbox.js');
const orchestrator = read('assets/js/admin-contenido.js');
const deployYml = read('.github/workflows/deploy.yml');
const adminHtml = read('admin.html');
const rateLimit = read('supabase/functions/_shared/rate-limit.ts');

test.describe('Captación de leads desde redes — infraestructura', () => {
  test('migración social_comments: claim por external_id + RLS solo lectura', () => {
    expect(migration).toContain('create table if not exists public.social_comments');
    // Idempotencia: el webhook re-entrega y el sync re-pasa → UNIQUE.
    expect(migration).toMatch(/create unique index[\s\S]*social_comments_external_id_key[\s\S]*on public\.social_comments \(external_id\)/);
    // RLS: el panel lee (authenticated); escritura SOLO service_role.
    expect(migration).toMatch(/enable row level security/);
    expect(migration).toMatch(/for select\s+to authenticated/);
    // Sin policies de escritura para el cliente.
    expect(migration).not.toMatch(/for insert to authenticated/i);
    expect(migration).not.toMatch(/for update to authenticated/i);
    expect(migration).not.toMatch(/for delete to authenticated/i);
  });

  test('webhook Meta: firma HMAC verificada y challenge en texto plano', () => {
    // Firma X-Hub-Signature-256 con el app secret.
    expect(webhook).toContain("req.headers.get('x-hub-signature-256')");
    expect(webhook).toMatch(/hmacSha256Hex|HMAC/);
    // Comparación timing-safe (no === sobre hex).
    expect(webhook).toContain('timingSafeEqual');
    // Verificación GET: hub.challenge devuelto EN TEXTO PLANO.
    expect(webhook).toMatch(/hub\.challenge/);
    expect(webhook).toMatch(/text\/plain/);
    // Sin firma válida NO se procesa nada.
    expect(webhook).toMatch(/403, \{ error: 'Firma inválida' \}/);
    // Claim idempotente (no duplicar ante re-entrega de Meta).
    expect(webhook).toMatch(/onConflict: 'external_id'/);
    expect(webhook).toMatch(/ignoreDuplicates: true/);
    // El webhook NUNCA crea leads (admin-initiated desde la bandeja).
    expect(webhook).not.toMatch(/\.from\('leads'\)/);
    // Parseo de los dos formatos: Page feed (item comment) e IG comments.
    expect(webhook).toMatch(/'page'/);
    expect(webhook).toMatch(/item.*comment|'comment'/);
    expect(webhook).toMatch(/'instagram'/);
    expect(webhook).toMatch(/'comments'/);
  });

  test('webhook deployado con verify_jwt OFF (Meta no manda JWT)', () => {
    const noVerify = deployYml.match(/NO_VERIFY=\(([^)]*)\)/);
    expect(noVerify).toBeTruthy();
    expect(noVerify[1]).toMatch(/\bsocial-webhook-meta\b/);
    // Y social-comments con verify_jwt ON (el panel manda Bearer).
    expect(noVerify[1]).not.toMatch(/\bsocial-comments\b/);
    // Nunca excluido del deploy (trampa del EXCLUDED_FUNCTIONS 2026-10-26).
    const excluded = deployYml.match(/EXCLUDED_FUNCTIONS=\(([^)]*)\)/);
    expect(excluded[1]).not.toMatch(/social-webhook-meta/);
    expect(excluded[1]).not.toMatch(/social-comments/);
  });

  test('social-comments: bandeja + crear lead con patrón comment_lead', () => {
    expect(server).toMatch(/requireAdmin/);
    expect(server).toMatch(/'social-comments'/);
    // Las 8 acciones del contrato (ronda 2: + reply + moderate).
    for (const action of ['list', 'webhook_info', 'subscribe', 'sync', 'create_lead', 'reply', 'moderate', 'dismiss']) {
      expect(server).toMatch(new RegExp(`'${action}'`));
    }
    // El lead nace con consent_at (la persona pidió info públicamente).
    expect(server).toMatch(/consent_at/);
    // SLA de primer contacto compartido.
    expect(server).toMatch(/ensureFirstContactTask/);
    // Dedup por email/teléfono (60 días).
    expect(server).toMatch(/60 \* 86400000/);
    // Timeline del lead.
    expect(server).toMatch(/lead_activities/);
    // Auditoría con action por plataforma.
    expect(server).toMatch(/fb_comment_lead/);
    expect(server).toMatch(/ig_comment_lead/);
    // El origen del lead = la plataforma del comentario (source canónico,
    // NO labels inventados).
    expect(server).toMatch(/source: platform/);
    // El comentario queda linkeado al lead (status 'lead' + lead_id).
    expect(server).toMatch(/status: 'lead', lead_id/);
  });

  test('rate limit para las dos funciones nuevas', () => {
    expect(rateLimit).toMatch(/'social-comments':/);
    expect(rateLimit).toMatch(/'social-webhook-meta':/);
  });

  test('bandeja del panel: sin onclick inline, esc SIEMPRE, tab integrado', () => {
    // Cero onclick inline (CSP sin unsafe-inline).
    expect(client).not.toMatch(/onclick=/);
    // Texto del comentario SIEMPRE escapado (esc antes de innerHTML).
    expect(client).toMatch(/esc\(row\.body/);
    // Crear lead / descartar vía el server, no directo.
    expect(client).toMatch(/create_lead/);
    expect(client).toMatch(/dismiss/);
    // Sync para cubrir lo que el webhook no entregó.
    expect(client).toMatch(/'sync'/);
    // Limitación de TikTok documentada EN la UI (no prometer lo que la
    // API no da).
    expect(client).toMatch(/no expone comentarios por API|solo para publicar/i);
    // Orquestador: tab + contenedor + open lazy.
    expect(orchestrator).toMatch(/data-sub="leads"/);
    expect(orchestrator).toMatch(/contenidoLeads/);
    expect(orchestrator).toMatch(/socialInbox\.open/);
    // admin.html: el módulo carga ANTES del orquestador (orden de módulos).
    const inboxIdx = adminHtml.indexOf('assets/js/social-inbox.js');
    const orchIdx = adminHtml.indexOf('assets/js/admin-contenido.js');
    expect(inboxIdx).toBeGreaterThan(-1);
    expect(inboxIdx).toBeLessThan(orchIdx);
  });

  test('el lead de YouTube usa el origen canónico youtube', () => {
    const yt = read('supabase/functions/social-youtube-comments/index.ts');
    expect(yt).toMatch(/source: 'youtube'/);
    expect(yt).not.toMatch(/source: 'youtube_comment'/);
  });
});

test.describe('Ronda 2 — bandeja completa (responder/moderar/realtime/self-noise)', () => {
  const fbServer = read('supabase/functions/social-facebook/index.ts');
  const igServer = read('supabase/functions/social-instagram/index.ts');
  const ttServer = read('supabase/functions/social-tiktok/index.ts');
  const fbAuth = read('supabase/functions/social-auth-facebook/index.ts');
  const igAuth = read('supabase/functions/social-auth-instagram/index.ts');

  test('server: responder comentarios (FB /{id}/comments · IG /{id}/replies)', () => {
    expect(server).toMatch(/async function replyComment/);
    // FB: respuesta = comentario hijo; IG: endpoint de replies.
    expect(server).toMatch(/\/comments\?access_token=/);
    expect(server).toMatch(/\/replies\?access_token=/);
    // El token sale de la cuenta de la fila (page token FB / user token IG).
    expect(server).toMatch(/getSocialAccessToken\(supabase, row\.account_id\)/);
    // Marca "respondido" en la fila (best-effort) + auditoría.
    expect(server).toMatch(/replied_at/);
    expect(server).toMatch(/fb_comment_reply/);
    expect(server).toMatch(/ig_comment_reply/);
  });

  test('server: moderar (delete ambas redes · hide FB is_hidden / IG hide)', () => {
    expect(server).toMatch(/async function moderateComment/);
    // Solo ops conocidas (delete|hide|unhide) — nada libre.
    expect(server).toMatch(/\['delete', 'hide', 'unhide'\]/);
    expect(server).toMatch(/method = 'DELETE'/);
    expect(server).toMatch(/is_hidden=/);   // FB
    expect(server).toMatch(/hide=/);        // IG
    // Tras delete la fila sale de la triage con la traza.
    expect(server).toMatch(/moderated: 'deleted'/);
    expect(server).toMatch(/fb_comment_moderate/);
    expect(server).toMatch(/ig_comment_moderate/);
  });

  test('server: webhook_info expone el estado de las cuentas conectadas', () => {
    expect(server).toMatch(/\.from\('social_accounts'\)/);
    expect(server).toMatch(/accounts:/);
  });

  test('server: los replies PROPIOS se saltan en sync (self-noise)', () => {
    expect(server).toMatch(/const isSelf = /);
    expect(server).toMatch(/selfSkipped/);
    expect(server).toMatch(/self_skipped: selfSkipped/);
  });

  test('webhook: los comentarios propios llegan como dismissed + metadata.self', () => {
    expect(webhook).toMatch(/async function isSelfComment/);
    // Insert con estado según self (la fila existe, fuera de los "nuevos").
    expect(webhook).toMatch(/status: self \? 'dismissed' : 'new'/);
    expect(webhook).toMatch(/metadata: self \? \{ \.\.\.c\.metadata, self: true \} : c\.metadata/);
  });

  test('webhook: errores de insert quedan en audit_log (sin rastro perdido)', () => {
    expect(webhook).toMatch(/async function auditInsertError/);
    expect(webhook).toMatch(/meta_webhook_error/);
    expect(webhook).toMatch(/error_code/);
    // El user_id queda NULL (escritura del server) — el audit se envuelve
    // en try/catch para no tumbar la entrega de Meta.
    expect(webhook).toMatch(/catch \(_\) \{ \/\* best-effort: no tumba la entrega \*\/ \}/);
  });

  test('scopes OAuth nuevos para responder/moderar (reconectar cuentas viejas)', () => {
    expect(igAuth).toMatch(/instagram_manage_comments/);
    expect(fbAuth).toMatch(/pages_manage_engagement/);
  });

  test('cleanup de huérfanos en social-temp (prefijo propio, 24h, máx 20)', () => {
    for (const [name, src, prefix] of [['facebook', fbServer, 'fb_'], ['instagram', igServer, 'ig_'], ['tiktok', ttServer, 'tt_']]) {
      expect(src, `cleanup en ${name}`).toMatch(/async function cleanupTempOrphans/);
      expect(src, `llamada con prefijo en ${name}`).toMatch(new RegExp(`cleanupTempOrphans\\('${prefix}'\\)`));
    }
    // Ventana de 24h y tope por llamada (idéntico en los 3).
    expect(fbServer).toMatch(/24 \* 3600 \* 1000/);
    expect(fbServer).toMatch(/removed >= 20/);
  });

  test('cliente: responder/moderar/abrir lead + realtime + badge', () => {
    // Acciones nuevas vía el server.
    expect(client).toMatch(/call\('reply'/);
    expect(client).toMatch(/call\('moderate'/);
    // Moderación con el diálogo del panel (confirm() nativo prohibido).
    expect(client).toMatch(/showConfirmDialog/);
    expect(client).not.toMatch(/window\.confirm\(/);
    // Abrir el lead creado vía la API del CRM.
    expect(client).toMatch(/BH_CRM/);
    expect(client).toMatch(/crm\.open\(leadId\)/);
    // Realtime: canal propio con UN .on() por tabla (social_comments).
    expect(client).toMatch(/\.channel\('bh-social-inbox'\)/);
    expect(client).toMatch(/postgres_changes/);
    expect(client).toMatch(/table: 'social_comments'/);
    expect(client).toMatch(/channel\.subscribe\(\)/);
    // Badge del sub-tab Consultas (status='new' head-count).
    expect(client).toMatch(/yt-comments-badge/);
    expect(client).toMatch(/data-sub="leads"/);
    expect(client).toMatch(/count: 'exact', head: true/);
    // Filtro por estado.
    expect(client).toMatch(/socialInboxState/);
    for (const st of ['"new"', '"lead"', '"dismissed"']) {
      expect(client).toMatch(new RegExp(`<option value=${st}`));
    }
  });
});
