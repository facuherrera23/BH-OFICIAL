// Circuito "Iniciar tasación" desde el CRM (2026-11-02): los leads
// source='tasacion' esperan que un agente realice el análisis. El botón del
// panel del lead abre tasacion.html?lead=<uuid> y el wizard precarga los
// datos. Guards ESTÁTICOS (sin BD ni red): los comportamientos finos del
// wizard ya los cubren tests/pages.spec.js (fake session + moneda).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { trackConsoleErrors } = require('./helpers/console');

const ROOT = path.join(__dirname, '..');
const pageSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'pages', 'tasacion-page.js'), 'utf8');
const crmSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-crm.js'), 'utf8');

test.describe('tasación desde lead — estáticos', () => {
  test('tasacion-page.js: LEAD_ID + prefill con guard (solo agente y sin ?id=)', () => {
    expect(pageSrc).toContain("const LEAD_ID = urlParams.get('lead');");
    expect(pageSrc).toContain('function prefillTasacionFromLead(lead){');
    // El parser usa el template fijo que escribe tasacion-submit.
    expect(pageSrc).toContain('Solicitud de tasación web — ');
    // No pisa la edición de una tasación existente (?id= manda).
    expect(pageSrc).toContain('if (LEAD_ID && !TASACION_ID) {');
    // Lectura del lead embarca las columnas que el prefill usa (regla schema real).
    expect(pageSrc).toContain(".select('full_name, phone, whatsapp, notes, source')");
  });

  test('tasacion-page.js: la tasación creada queda vinculada y trazada', () => {
    // tasaciones no tiene columna lead_id (verificado contra information_schema)
    // — el vínculo vive en el JSONB data.lead_id, solo en el insert path.
    expect(pageSrc).toContain('if (LEAD_ID && !TASACION_ID) formData.lead_id = LEAD_ID;');
    expect(pageSrc).toContain("title: 'Tasación creada: ' + (title || 'sin título'),");
  });

  test('admin-crm.js: botón solo para leads source tasacion, por listener (CSP-safe)', () => {
    expect(crmSrc).toContain('id="crmTasacionBtn"');
    expect(crmSrc).toContain("lead.source === 'tasacion'");
    expect(crmSrc).toContain("'/tasacion.html?lead='");
    expect(crmSrc).toContain("encodeURIComponent(String(lead.id || ''))");
    // Sin onclick inline (la CSP del admin no tiene unsafe-inline).
    const section = crmSrc.slice(crmSrc.indexOf('id="crmTasacionBtn"') - 600, crmSrc.indexOf('id="crmTasacionBtn"') + 300);
    expect(section).not.toContain('onclick=');
  });

  test('behavioral: ?lead= prefilla el wizard desde un lead mockeado (REST mock)', async ({ page }) => {
    // Fake agent session idéntica a tests/pages.spec.js (session plano +
    // JWT con exp a futuro: el cliente parsea el JWT en getSession()).
    const exp = Math.floor(Date.now() / 1000) + 90 * 86400;
    const payload = Buffer.from(JSON.stringify({
      sub: '00000000-0000-0000-0000-000000000000', role: 'authenticated', aud: 'authenticated', exp,
    })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await page.addInitScript(([key, value]) => {
      window.localStorage.setItem(key, value);
    }, ['sb-rnldqiwwzhjnurkguihu-auth-token', JSON.stringify({
      access_token: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.fake-signature`,
      token_type: 'bearer',
      expires_in: 7776000,
      expires_at: exp,
      refresh_token: 'fake-refresh-token',
      user: { id: '00000000-0000-0000-0000-000000000000', aud: 'authenticated', role: 'authenticated' },
    })]);

    const LEAD_UUID = '11111111-1111-1111-1111-111111111111';
    await page.route('**/rest/v1/leads*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Content-Profile': 'public' },
        body: JSON.stringify([{
          full_name: 'Ana Prueba',
          phone: '+54 9 351 9998888',
          whatsapp: '+54 9 351 9998888',
          notes: 'Solicitud de tasación web — Av Fake 789, Barrio Centro, Córdoba (Casa · Alquilar · sup. aprox. 120 m2)\nEl propietario pide que un agente realice la tasación.',
          source: 'tasacion',
        }]),
      });
    });

    await page.goto('/tasacion.html?lead=' + LEAD_UUID);
    const console = trackConsoleErrors(page);
    // Modo agente: el wizard está vivo.
    await expect(page.locator('#formFieldset')).toBeVisible();
    // Prefill: nombre/teléfono del lead + dirección parseada del template.
    await expect(page.locator('#f_solicitante')).toHaveValue('Ana Prueba');
    await expect(page.locator('#f_telefono')).toHaveValue('+54 9 351 9998888');
    await expect(page.locator('#f_direccion')).toHaveValue('Av Fake 789, Barrio Centro, Córdoba');
    // El "Alquilar" del paréntesis manda al destino.
    await expect(page.locator('#f_destino')).toHaveValue('Alquiler');
    expect(console.pageErrors).toEqual([]);
    console.assertClean();
  });

  test('behavioral: al guardar, la tasación nueva queda vinculada al lead (data.lead_id) y traza en el historial', async ({ page }) => {
    const exp = Math.floor(Date.now() / 1000) + 90 * 86400;
    const payload = Buffer.from(JSON.stringify({
      sub: '00000000-0000-0000-0000-000000000000', role: 'authenticated', aud: 'authenticated', exp,
    })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await page.addInitScript(([key, value]) => {
      window.localStorage.setItem(key, value);
    }, ['sb-rnldqiwwzhjnurkguihu-auth-token', JSON.stringify({
      access_token: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.fake-signature`,
      token_type: 'bearer',
      expires_in: 7776000,
      expires_at: exp,
      refresh_token: 'fake-refresh-token',
      user: { id: '00000000-0000-0000-0000-000000000000', aud: 'authenticated', role: 'authenticated' },
    })]);

    const LEAD_UUID = '11111111-1111-1111-1111-111111111111';
    const tasacionesPosts = [];
    const actividadPosts = [];
    await page.route('**/rest/v1/leads*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          full_name: 'Ana Prueba',
          phone: '+54 9 351 9998888',
          whatsapp: '+54 9 351 9998888',
          notes: 'Solicitud de tasación web — Av Fake 789, Barrio Centro, Córdoba (Casa · Alquilar)',
          source: 'tasacion',
        }]),
      });
    });
    await page.route('**/rest/v1/lead_activities*', async (route) => {
      actividadPosts.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
    });
    await page.route('**/rest/v1/tasaciones*', async (route) => {
      if (route.request().method() === 'POST') {
        tasacionesPosts.push(route.request().postDataJSON());
        // OJO: el wizard inserta con .select('id').single() → PostgREST
        // responde un OBJETO (Accept: application/vnd.pgrst.object+json),
        // no un array. Con array, data.id queda undefined y el bloque de
        // traza no se ejecuta (el mock mentía).
        await route.fulfill({
          status: 201,
          contentType: 'application/vnd.pgrst.object+json',
          body: JSON.stringify({ id: '22222222-2222-2222-2222-222222222222' }),
        });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
    });

    await page.goto('/tasacion.html?lead=' + LEAD_UUID);
    const console = trackConsoleErrors(page);
    await expect(page.locator('#formFieldset')).toBeVisible();
    await page.locator('#btnSave').click();
    await expect(page.locator('#lastSaved')).toContainText('Guardado');
    expect(tasacionesPosts).toHaveLength(1);
    expect(tasacionesPosts[0].data.lead_id).toBe(LEAD_UUID);
    expect(tasacionesPosts[0].status).toBe('draft');
    expect(actividadPosts).toHaveLength(1);
    // OJO: postDataJSON() del insert devuelve el ARRAY de filas — la fila es [0][0].
    expect(actividadPosts[0][0].lead_id).toBe(LEAD_UUID);
    expect(actividadPosts[0][0].title).toContain('Tasación creada:');
    expect(console.pageErrors).toEqual([]);
    console.assertClean();
  });
});
