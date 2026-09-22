// CRM rondas 2-4: guards de regresión de las mejoras (sin login: son estructurales).
const { test, expect } = require('@playwright/test');

test.describe('CRM — mejoras (rondas 2-4)', () => {
  test('la landing envía el contacto a contact-submit (nunca insert directo) y captura UTM', async ({ request }) => {
    const js = await (await request.get('/assets/js/landing-app.js')).text();
    expect(js).toContain('/functions/v1/contact-submit');
    const contactBlock = js.split('11. CONTACT FORM')[1] || '';
    expect(contactBlock).not.toContain(".from('leads').insert");
    const newsletterBlock = js.split('13. NEWSLETTER')[1] || '';
    expect(newsletterBlock).not.toContain(".from('leads').insert");
    expect(js).toContain("kind: 'newsletter'");
    expect(js).toContain('utm_source');
    expect(js).toContain('utm_campaign');
  });

  test('index.html tiene honeypot funcional en el formulario de contacto', async ({ request }) => {
    const html = await (await request.get('/index.html')).text();
    expect(html).toContain('name="website"');
    expect(html).toContain('tabindex="-1"');
  });

  test('admin-crm.js: contacto rápido, plantillas con link de ficha y papelera', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain('crm-contact-btn');
    expect(js).toContain('crmMsgTemplate');
    expect(js).toContain('compartir_ficha');
    expect(js).toContain("'/fichas/'");
    expect(js).toContain('crmTrashToggle');
    expect(js).toContain('restoreLead');
    expect(js).toContain('crmAssignMe');
  });

  test('admin-crm.js: normalización telefónica AR (00, 54, 549, 0, 9, 15) y tel sin 9', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain('normalizeArPhone');
    expect(js).toContain('AR_MOBILE_AREAS');
    expect(js).toContain("indexOf('549')");
    expect(js).toContain("indexOf('15')");
    // wa.me siempre con 9; tel: nunca con 9:
    expect(js).toContain("return '549' + d;");
    expect(js).toContain("return '54' + d;");
  });

  test('admin-crm.js: paginación y orden server-side, sin fetch masivo', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain('SERVER_SORT_COLUMNS');
    expect(js).toContain('.range(');
    expect(js).not.toContain('var start = (_page - 1) * PAGE_SIZE');
  });

  test("admin-crm.js: agendar visita no degrada etapas avanzadas", async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    const visitBlock = js.split("d.type === 'visit'")[1] || '';
    expect(visitBlock).toContain("'nuevo', 'contactado', 'calificado'");
  });

  test('admin-app.js: exportLeadsCSV usa columnas reales y respeta filtros', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    const fn = js.split('window.exportLeadsCSV')[1] || '';
    expect(fn).toContain('full_name');
    expect(fn).toContain('crmSearch');
    expect(fn).not.toContain('l.property_title');
    // BOM para Excel vive en downloadCSV:
    expect(js).toContain("'\\uFEFF'");
  });

  test('admin-app.js: chat enlaza conversaciones con leads existentes', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('renderChatLeadBanner');
    expect(js).toContain('chatLeadBanner');
  });

  test('admin.css: reglas mobile del CRM presentes', async ({ request }) => {
    const css = await (await request.get('/assets/css/admin.css')).text();
    const mobile = css.split('@media (max-width: 768px)').pop() || '';
    expect(mobile).toContain('.crm-table');
    expect(mobile).toContain('.crm-side-panel');
  });
});
