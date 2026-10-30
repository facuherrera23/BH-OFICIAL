// ============================================================
// Tests de COMENTARIOS del canal (módulo CONTENIDO / YouTube)
// ------------------------------------------------------------
// Cubre el módulo cliente (assets/js/yt-comments.js), la edge
// function social-youtube-comments (a través del harness) y la
// UI: bandeja del canal, comentarios del video, responder,
// like, moderar y creación de lead desde un comentario.
// ============================================================
const { test, expect } = require('@playwright/test');
const { boot, VIDEO } = require('./helpers/yt-harness');

const COMMENT = {
  id: 'cm-1',
  videoId: 'vid-1',
  text: 'Hola, ¿la casa tiene pileta? Mi teléfono es 3514445555',
  author: 'Marta Gomez',
  likes: 3,
  replyCount: 1,
  publishedAt: new Date(Date.now() - 3600000).toISOString(),
  replies: [
    { id: 'cm-1-r1', text: 'Sí, tiene pileta', author: 'Bienenhaus', likes: 1, publishedAt: new Date(Date.now() - 1800000).toISOString() },
  ],
};

test.describe('BH_YT.comments — módulo de comentarios', () => {
  test('las acciones llaman a la edge function con la action correcta', async ({ page }) => {
    const h = await boot(page);
    await page.evaluate(async () => {
      const cm = window.BH_YT.comments;
      await cm.list('acc-1', 'vid-1');
      await cm.inbox('acc-1', 'ch-1');
      await cm.reply('acc-1', 'vid-1', 'cm-1', 'Gracias!');
      await cm.heart('acc-1', 'cm-1', true);
      await cm.moderate('acc-1', 'cm-1', 'held');
      await cm.createLead('acc-1', 'vid-1', { id: 'cm-1', author: 'Marta', text: 'mi mail es a@b.com' });
    });
    const actions = h.requests.filter((r) => r.fn === 'comments').map((r) => r.body.action);
    expect(actions).toEqual([
      'comments_list', 'comments_inbox', 'comment_reply',
      'comment_heart', 'comment_moderate', 'comment_lead',
    ]);
    const reply = h.requests.find((r) => r.fn === 'comments' && r.body.action === 'comment_reply');
    expect(reply.body.parent_id).toBe('cm-1');
    expect(reply.body.text).toBe('Gracias!');
    const lead = h.requests.find((r) => r.fn === 'comments' && r.body.action === 'comment_lead');
    expect(lead.body.comment_id).toBe('cm-1');
    expect(lead.body.video_id).toBe('vid-1');
  });

  test('el contador de nuevos usa la última visita (y 24 h si nunca se abrió)', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const cm = window.BH_YT.comments;
      const now = Date.now();
      const viejo = { publishedAt: new Date(now - 48 * 3600000).toISOString() };
      const nuevo = { publishedAt: new Date(now - 3600000).toISOString() };
      const sinAbrir = cm.unreadCount([viejo, nuevo]);
      cm.markSeen(now - 7200000); // hace 2 h
      const conPiso = cm.unreadCount([viejo, nuevo]);
      cm.markSeen(now); // se acaba de ver
      const visto = cm.unreadCount([viejo, nuevo]);
      return { sinAbrir, conPiso, visto };
    });
    expect(r.sinAbrir).toBe(1); // el viejo no cuenta (más de 24 h)
    expect(r.conPiso).toBe(1);  // el nuevo sigue sin verse
    expect(r.visto).toBe(0);    // ya se vio todo
  });

  test('timeAgo y initials dan textos legibles', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const cm = window.BH_YT.comments;
      return {
        recien: cm.timeAgo(new Date().toISOString()),
        horas: cm.timeAgo(new Date(Date.now() - 3 * 3600000).toISOString()),
        inic: cm.initials('Marta Gomez'),
        vacio: cm.initials(''),
      };
    });
    expect(r.recien).toBe('recién');
    expect(r.horas).toContain('h');
    expect(r.inic).toBe('MG');
    expect(r.vacio).toBe('?');
  });
});

test.describe('Comentarios en el Studio', () => {
  test('el header tiene el botón de comentarios con contador', async ({ page }) => {
    await boot(page, { comments: [COMMENT] });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#studioCommentsBtn')).toHaveCount(1);
    await expect.poll(() => page.locator('#ytCommentsBadge').textContent()).toBe('1');
  });

  test('la bandeja lista los comentarios del canal', async ({ page }) => {
    await boot(page, { comments: [COMMENT] });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('#studioCommentsBtn');
    await expect(page.locator('#ytCommentsInbox')).toBeVisible();
    await expect(page.locator('#ytCommentsInbox')).toContainText('Marta Gomez');
    await expect(page.locator('#ytCommentsInbox .yt-comment')).toHaveCount(1);
  });

  test('crear lead desde un comentario avisa y no duplica', async ({ page }) => {
    const h = await boot(page, { comments: [COMMENT] });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('#studioCommentsBtn');
    await expect(page.locator('#ytCommentsInbox .yt-comment')).toHaveCount(1);
    await page.click('#ytCommentsInbox [data-cm-lead]');
    await expect.poll(() => h.calls.comment_lead).toBe(1);
    const call = h.requests.find((r) => r.fn === 'comments' && r.body.action === 'comment_lead');
    expect(call.body.comment_id).toBe('cm-1');
    expect(call.body.author).toBe('Marta Gomez');
    /* El toast se emite cuando llega la respuesta: se espera con poll. */
    await expect.poll(() => page.evaluate(() => window.__TOASTS.some((t) => t.indexOf('Lead creado') >= 0))).toBe(true);
  });

  test('si el lead ya existe, avisa que no se duplicó', async ({ page }) => {
    await boot(page, { comments: [COMMENT], commentLeadDuplicate: true });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('#studioCommentsBtn');
    await page.click('#ytCommentsInbox [data-cm-lead]');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.some((t) => t.indexOf('no se duplicó') >= 0))).toBe(true);
  });

  test('el modal del video carga los comentarios del video', async ({ page }) => {
    await boot(page, { comments: [COMMENT] });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('[data-studio-detail]');
    await expect(page.locator('#steComments')).toHaveCount(1);
    await page.click('#steCommentsLoad');
    await expect(page.locator('#steComments .yt-comment')).toHaveCount(1);
    await expect(page.locator('#steComments')).toContainText('Marta Gomez');
    /* Las respuestas del canal se ven anidadas. */
    await expect(page.locator('#steComments .yt-comment-reply')).toHaveCount(1);
  });

  test('responder abre el box y manda la respuesta al server', async ({ page }) => {
    const h = await boot(page, { comments: [COMMENT] });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('[data-studio-detail]');
    await page.click('#steCommentsLoad');
    await page.click('#steComments [data-cm-reply]');
    await expect(page.locator('#steComments [data-replybox="cm-1"]')).toBeVisible();
    await page.fill('#steComments [data-replybox="cm-1"] textarea', '¡Gracias Marta!');
    await page.click('#steComments [data-cm-send]');
    await expect.poll(() => h.calls.comment_reply).toBe(1);
    const call = h.requests.find((r) => r.fn === 'comments' && r.body.action === 'comment_reply');
    expect(call.body.text).toBe('¡Gracias Marta!');
    expect(call.body.parent_id).toBe('cm-1');
  });

  test('cancelar la respuesta la cierra y no manda nada', async ({ page }) => {
    const h = await boot(page, { comments: [COMMENT] });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('[data-studio-detail]');
    await page.click('#steCommentsLoad');
    await page.click('#steComments [data-cm-reply]');
    await page.fill('#steComments [data-replybox="cm-1"] textarea', 'texto');
    await page.click('#steComments [data-cm-cancel]');
    await expect(page.locator('#steComments [data-replybox="cm-1"]')).toBeHidden();
    expect(h.calls.comment_reply).toBe(0);
  });

  test('sin permiso de administración no hay botones de like ni moderar', async ({ page }) => {
    await boot(page, { comments: [COMMENT], canManage: false });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('[data-studio-detail]');
    await page.click('#steCommentsLoad');
    await expect(page.locator('#steComments [data-cm-heart]')).toHaveCount(0);
    await expect(page.locator('#steComments [data-cm-hold]')).toHaveCount(0);
    /* pero sí se puede responder (es lectura + escritura de la cuenta… no:
       responder exige force-ssl → el server lo bloquea). Por eso el botón
       de responder se muestra siempre y el server avisa si no puede. */
    await expect(page.locator('#steComments [data-cm-reply]')).toHaveCount(1);
  });

  test('con permiso aparecen like y moderar, y moderar llama al server', async ({ page }) => {
    const h = await boot(page, { comments: [COMMENT], canManage: true });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('[data-studio-detail]');
    await page.click('#steCommentsLoad');
    await expect(page.locator('#steComments [data-cm-heart]')).toHaveCount(1);
    await page.click('#steComments [data-cm-heart]');
    await expect.poll(() => h.calls.comment_heart).toBe(1);
    await page.click('#steComments [data-cm-hold]');
    await expect.poll(() => h.calls.comment_moderate).toBe(1);
    const call = h.requests.find((r) => r.fn === 'comments' && r.body.action === 'comment_moderate');
    expect(call.body.status).toBe('held');
  });

  test('si la bandeja falla, el Studio sigue vivo', async ({ page }) => {
    await boot(page);
    await page.route('**/functions/v1/social-youtube-comments', (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'needs_reconnect' }) }));
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('#studioCommentsBtn');
    await expect(page.locator('#ytCommentsInbox')).toContainText('needs_reconnect');
    /* El inventario del canal sigue en su lugar. */
    await expect(page.locator('#studioVideos .yt-video-card')).toHaveCount(1);
  });
});
