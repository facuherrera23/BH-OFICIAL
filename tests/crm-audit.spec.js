// Guards de seguridad/estabilidad del CRM nuevo. Guardias estaticas,
// NUNCA contactan la BD.
const { test, expect } = require('@playwright/test');

test.describe('CRM — audit post-build (interconexiones)', () => {
  test('tipos de datos: visitas usan notes (no note); soft delete via deleted_at', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain("notes: txt || null");     // columna real de visits
    expect(js).not.toContain("note: txt || null"); // bug de property inexistente
    expect(js).toContain("deleted_at");            // soft delete obligatorio
    expect(js).toContain("'is', 'null'");          // sintaxis PostgREST correcta
  });

  test('RLS: ninguna lectura directa a super_admin desde el modulo', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).not.toContain('service_role');
    expect(js).not.toContain("from('profiles')"); // solo agents + leads + lead_* + properties + visits
  });

  test('kpi usa stage exacto (nuevo / cerrado_ganado / cerrado_perdido)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain("'cerrado_ganado'");
    expect(js).toContain("'cerrado_perdido'");
  });

  test('handler del nuevo lead no fue roto (btnNewLead existe en admin-app.js)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain("on($('#btnNewLead')");
    expect(js).toContain("LeadSchema");
  });

  test('agenda-source para nuevos leads no se rompe (visitas siguen abriendo modal)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain("openModal('visitModal')");
  });

  test('imports de supabase: window.supabaseClient se usa (no getAuthedClient duplicado)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain('function db() { return window.supabaseClient; }');
  });
});
