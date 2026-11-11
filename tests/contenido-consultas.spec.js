// Tests BEHAVIORALES de la bandeja "Consultas" de redes (módulo CONTENIDO).
//
// Monte el módulo REAL (social-inbox.js + orquestador) con el harness de
// yt-harness y mockea el backend `social-comments` con page.route para
// ejercitar el flujo completo de la ronda 2 (2026-11-11):
//
//   · filtros por plataforma Y por estado (new/lead/dismissed),
//   · crear lead → la fila pasa a "Con lead" con botón Abrir lead,
//   · abrir el lead con window.BH_CRM.open (API del CRM),
//   · responder inline → POST action=reply al server,
//   · eliminar/ocultar con showConfirmDialog (confirm() nativo prohibido),
//   · badge del sub-tab (head-count de status='new'),
//   · realtime: INSERT en social_comments refresca bandeja y badge.
//
// No toca producción ni la BD: el server local (8788) solo sirve assets.
const { test, expect } = require('@playwright/test');

const { boot } = require('./helpers/yt-harness');

/* Filas iniciales de la bandeja (cada test las clona). */
function baseRows() {
  return [
    {
      id: 'c1', platform: 'facebook', external_id: 'fb-c1', external_post_id: '123_456',
      social_post_id: null, property_id: null, account_id: 'acc-fb',
      author_name: 'Laura Gómez', author_handle: null, body: '¿Precio? Escribanme a laura@mail.com',
      parent_external_id: null, permalink: null, like_count: 1, status: 'new', lead_id: null,
      commented_at: '2026-11-10T15:00:00Z', created_at: '2026-11-10T15:00:00Z', metadata: {},
      social_posts: { external_url: 'https://facebook.com/p/1' }, properties: { property_code: 'ML-0001', title: 'Casa en Nueva Córdoba' },
    },
    {
      id: 'c2', platform: 'instagram', external_id: 'ig-c2', external_post_id: 'ig789',
      social_post_id: null, property_id: null, account_id: 'acc-ig',
      author_name: 'Martín Pérez', author_handle: 'martin.pz', body: 'Hola! Queda disponible?',
      parent_external_id: null, permalink: null, like_count: 0, status: 'new', lead_id: null,
      commented_at: '2026-11-10T18:00:00Z', created_at: '2026-11-10T18:00:00Z', metadata: {},
      social_posts: null, properties: null,
    },
    {
      id: 'c3', platform: 'facebook', external_id: 'fb-c3', external_post_id: '123_999',
      social_post_id: null, property_id: null, account_id: 'acc-fb',
      author_name: 'Ana Ruiz', author_handle: null, body: 'Ya hablé por WhatsApp, gracias',
      parent_external_id: null, permalink: null, like_count: 2, status: 'dismissed',
      lead_id: null, commented_at: '2026-11-09T10:00:00Z', created_at: '2026-11-09T10:00:00Z',
      metadata: {}, social_posts: null, properties: null,
    },
  ];
}

/** Estado mutable del server mock + route para social-comments. */
async function mockSocialComments(page) {
  const state = { rows: baseRows(), replyCalls: 0, moderateCalls: [], leadCalls: 0 };
  await page.route('**/functions/v1/social-comments', async (route) => {
    const body = route.request().postDataJSON() || {};
    let payload = {};
    switch (body.action) {
      case 'list':
        payload = { rows: state.rows };
        break;
      case 'webhook_info':
        payload = {
          callback_url: 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/social-webhook-meta',
          verify_token: 'tok-abc123',
          fields: { facebook: 'feed', instagram: 'comments' },
          accounts: [
            { platform: 'facebook', name: 'Bienenhaus Propiedades', status: 'active' },
            { platform: 'instagram', name: 'bienenhaus.ar', status: 'active' },
          ],
        };
        break;
      case 'create_lead': {
        const row = state.rows.find((r) => r.id === body.comment_id);
        if (row) { row.status = 'lead'; row.lead_id = 'lead-' + row.id; }
        state.leadCalls++;
        payload = { ok: true, duplicate: false, lead_id: row ? row.lead_id : null };
        break;
      }
      case 'reply': {
        const row = state.rows.find((r) => r.id === body.comment_id);
        if (row) row.metadata = Object.assign({}, row.metadata, { replied_at: '2026-11-11T12:00:00Z' });
        state.replyCalls++;
        payload = { ok: true };
        break;
      }
      case 'moderate': {
        const row = state.rows.find((r) => r.id === body.comment_id);
        if (row && body.op === 'delete') {
          row.status = 'dismissed';
          row.metadata = Object.assign({}, row.metadata, { moderated: 'deleted' });
        }
        if (row && body.op === 'hide') {
          row.metadata = Object.assign({}, row.metadata, { is_hidden: true });
        }
        state.moderateCalls.push(body.op);
        payload = { ok: true };
        break;
      }
      case 'dismiss': {
        const row = state.rows.find((r) => r.id === body.comment_id);
        if (row) row.status = 'dismissed';
        payload = { ok: true };
        break;
      }
      case 'sync':
        payload = { accounts: 1, posts: 1, fetched: 2, self_skipped: 1, errors: [] };
        break;
      default:
        payload = { error: 'Acción desconocida' };
    }
    return route.fulfill({
      status: payload.error ? 400 : 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
  return state;
}

test.describe('Contenido — bandeja Consultas (ronda 2)', () => {
  test('la bandeja abre con filtros por plataforma y estado, y muestra las filas', async ({ page }) => {
    await boot(page);
    await mockSocialComments(page);
    await page.click('#contenidoSubTabs button[data-sub="leads"]');
    await expect(page.locator('#socialInboxFilter')).toHaveCount(1);
    await expect(page.locator('#socialInboxState')).toHaveCount(1);
    await expect(page.locator('#socialInboxList .yt-comment')).toHaveCount(3);
    await expect(page.locator('#socialInboxCount')).toContainText('(3)');
    // Chips de conexión en la caja del webhook.
    await expect(page.locator('#socialWebhookData')).toContainText('Bienenhaus Propiedades');
    await expect(page.locator('#socialWebhookData')).toContainText('bienenhaus.ar');
  });

  test('el filtro de estado solo muestra las filas de ese estado', async ({ page }) => {
    await boot(page);
    await mockSocialComments(page);
    await page.click('#contenidoSubTabs button[data-sub="leads"]');
    await expect(page.locator('#socialInboxList .yt-comment')).toHaveCount(3);
    await page.selectOption('#socialInboxState', 'new');
    await expect(page.locator('#socialInboxList .yt-comment')).toHaveCount(2);
    await expect(page.locator('#socialInboxCount')).toContainText('(2)');
    await page.selectOption('#socialInboxState', 'dismissed');
    await expect(page.locator('#socialInboxList .yt-comment')).toHaveCount(1);
    // Combinado con plataforma: FB descartadas (1), IG descartadas (0).
    await page.selectOption('#socialInboxFilter', 'instagram');
    await expect(page.locator('#socialInboxList .empty-state')).toHaveCount(1);
  });

  test('crear lead pasa la fila a "Abrir lead" y BH_CRM.open la abre', async ({ page }) => {
    await boot(page);
    const state = await mockSocialComments(page);
    await page.evaluate(() => {
      window.__OPENED_LEADS = [];
      window.BH_CRM = { open: (id) => { window.__OPENED_LEADS.push(id); } };
    });
    await page.click('#contenidoSubTabs button[data-sub="leads"]');
    await expect(page.locator('#socialInboxList .yt-comment')).toHaveCount(3);
    await page.click('[data-comment-row="c1"] [data-lead]');
    await expect(page.locator('[data-comment-row="c1"]')).toContainText('Abrir lead');
    expect(state.leadCalls).toBe(1);
    await page.click('[data-comment-row="c1"] [data-open-lead]');
    const opened = await page.evaluate(() => window.__OPENED_LEADS);
    expect(opened).toEqual(['lead-c1']);
  });

  test('responder manda action=reply con el texto y marca "Respondido"', async ({ page }) => {
    await boot(page);
    const state = await mockSocialComments(page);
    await page.click('#contenidoSubTabs button[data-sub="leads"]');
    // El replybox empieza oculto.
    const box = page.locator('[data-replybox="c1"]');
    await expect(box).toBeHidden();
    await page.click('[data-comment-row="c1"] [data-reply]');
    await expect(box).toBeVisible();
    await page.fill('[data-replytext="c1"]', 'Hola Laura, te contacto hoy!');
    await page.click('[data-replybox="c1"] [data-send]');
    // La fila se re-renderiza con el marker.
    await expect(page.locator('[data-comment-row="c1"]')).toContainText('Respondido');
    expect(state.replyCalls).toBe(1);
    // El server mock solo marca replied_at si recibió el reply → el body viajó.
    expect(state.rows[0].metadata.replied_at).toBeTruthy();
  });

  test('eliminar pide confirmación, y solo al aceptar manda moderate/delete', async ({ page }) => {
    await boot(page);
    const state = await mockSocialComments(page);
    await page.click('#contenidoSubTabs button[data-sub="leads"]');
    // ACEPTA (showConfirmDialog del panel — grabado en __CONFIRM_CALLS).
    await page.click('[data-comment-row="c2"] [data-op="delete"]');
    const confirms = await page.evaluate(() => window.__CONFIRM_CALLS);
    expect(confirms.some((c) => c.indexOf('Eliminar comentario') >= 0)).toBe(true);
    await expect(page.locator('[data-comment-row="c2"]')).toContainText('Eliminado de la red');
    expect(state.moderateCalls).toEqual(['delete']);
    expect(state.rows[1].metadata.moderated).toBe('deleted');
  });

  test('cancelar la confirmación NO manda moderate', async ({ page }) => {
    await boot(page);
    const state = await mockSocialComments(page);
    await page.evaluate(() => { window.__CONFIRM = false; });
    await page.click('#contenidoSubTabs button[data-sub="leads"]');
    await page.click('[data-comment-row="c2"] [data-op="delete"]');
    expect(state.moderateCalls).toEqual([]);
    await expect(page.locator('#socialInboxList .yt-comment')).toHaveCount(3);
  });

  test('el badge del sub-tab refleja el head-count de status=new', async ({ page }) => {
    await boot(page);
    await mockSocialComments(page);
    await page.evaluate(() => { window.__COUNTS = { social_comments: 3 }; });
    await page.click('#contenidoSubTabs button[data-sub="leads"]');
    const badge = page.locator('#contenidoSubTabs button[data-sub="leads"] .yt-comments-badge');
    await expect(badge).toHaveText('3');
    // Sin pendientes → el badge desaparece (loadRows refresca el badge).
    await page.evaluate(() => { window.__COUNTS = { social_comments: 0 }; });
    await page.click('#socialInboxRefresh');
    await expect(badge).toHaveCount(0);
  });

  test('realtime: un INSERT en social_comments refresca bandeja y badge', async ({ page }) => {
    await boot(page);
    const state = await mockSocialComments(page);
    await page.evaluate(() => { window.__COUNTS = { social_comments: 1 }; });
    await page.click('#contenidoSubTabs button[data-sub="leads"]');
    // El módulo se suscribió a social_comments por postgres_changes.
    const on = await page.evaluate(() => window.__REALTIME_ON);
    expect(on).toEqual([{ channel: 'bh-social-inbox', table: 'social_comments', event: 'INSERT' }]);
    // Simula el evento de la DB: un comentario nuevo llega desde Meta.
    state.rows.unshift({
      id: 'c4', platform: 'instagram', external_id: 'ig-c4', external_post_id: 'ig000',
      social_post_id: null, property_id: null, account_id: 'acc-ig',
      author_name: 'Nueva Consulta', author_handle: 'nueva', body: 'Interesa!',
      parent_external_id: null, permalink: null, like_count: 0, status: 'new', lead_id: null,
      commented_at: '2026-11-11T12:00:00Z', created_at: '2026-11-11T12:00:00Z', metadata: {},
      social_posts: null, properties: null,
    });
    await page.evaluate(() => {
      window.__COUNTS = { social_comments: 2 };
      const h = (window.__REALTIME_HANDLERS || []).find((x) => x.table === 'social_comments');
      if (h && typeof h.cb === 'function') h.cb();
    });
    await expect(page.locator('#socialInboxList .yt-comment')).toHaveCount(4);
    await expect(page.locator('#contenidoSubTabs button[data-sub="leads"] .yt-comments-badge')).toHaveText('2');
  });

  test('sync reporta los comentarios propios ignorados', async ({ page }) => {
    await boot(page);
    await mockSocialComments(page);
    await page.click('#contenidoSubTabs button[data-sub="leads"]');
    await page.click('#socialInboxSync');
    // El toast del panel muestra el contador de self-noise del server.
    await expect.poll(async () => {
      const toasts = await page.evaluate(() => window.__TOASTS);
      return toasts.some((t) => t.indexOf('propios ignorados') >= 0);
    }).toBe(true);
  });
});
