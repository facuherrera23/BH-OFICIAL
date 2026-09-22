// Agenda/Visitas — guards de regresión (rondas 1-5).
const { test, expect } = require('@playwright/test');

test.describe('Agenda/Visitas — estructura del módulo', () => {
  test('modal de visita usa input date (con año) y selector de lead', async ({ request }) => {
    const html = await (await request.get('/admin.html')).text();
    expect(html).toContain('id="visitDateDay"');
    expect(html).toContain('type="date"');
    expect(html).toContain('id="visitDateTime"');
    expect(html).toContain('id="visitLeadSelectEl"');
    expect(html).toContain('id="visitCopyLinkBtn"');
    expect(html).toContain('id="visitGCalBtn"');
    // KPI strip con asistencia:
    expect(html).toContain('id="agendaKpiAsistencia"');
    expect(html).toContain('id="agendaKpiVencidas"');
  });

  test('la agenda carga visitas excluyendo eliminadas y con ventana temporal', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain("is('deleted_at', null)");
    expect(js).toContain('loadLeadContextForVisit');
    expect(js).toContain('refreshBrokerSlots');
    expect(js).toContain('calShareDayBtn');
  });

  test('confirmar-visita incluye la propiedad en el detalle', async ({ request }) => {
    const html = await (await request.get('/confirmar-visita.html')).text();
    expect(html).toContain('id="detailPropertyRow"');
    const js = await (await request.get('/assets/js/pages/confirmar-visita-page.js')).text();
    expect(js).toContain('p_reason');
    expect(js).toContain('America/Argentina/Buenos_Aires');
  });

  test('admin-crm tiene acciones completas de visitas (confirmar/progreso/completar/cancelar)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain("'en_curso'");
    expect(js).toContain('data-visit-action="start"');
    expect(js).toContain('data-visit-action="complete"');
    expect(js).toContain('data-visit-action="cancel"');
    expect(js).toContain('data-visit-action="duplicate"');
    expect(js).toContain('data-visit-action="reschedule"');
  });

  test('visitas: drag&drop reprogramación presente', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('rescheduleVisitToDay');
    expect(js).toContain('dataTransfer');
  });
});
