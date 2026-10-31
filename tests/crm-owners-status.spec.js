// Propietario desactivado (owners.status) — guards de regresión.
// 2026-10-30: un propietario que vendió su única propiedad y ya no tiene
// contacto se marca INACTIVO (no se elimina): conserva TODO su historial
// (datos + propiedad vendida) pero sale de la cartera operativa.
//
// Estos tests son ESTÁTICOS: no tocan la BD ni escriben nada.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const MIG_DIR = path.join(__dirname, '..', 'supabase', 'migrations');

test.describe('CRM — propietario desactivado (owners.status)', () => {
  test('migración: columna status + CHECK + trigger de revocación de tokens', () => {
    const files = fs.readdirSync(MIG_DIR).filter(f => f.includes('owner_status'));
    expect(files.length).toBeGreaterThan(0);
    const sql = fs.readFileSync(path.join(MIG_DIR, files[files.length - 1]), 'utf8');

    // Columnas (aditivas, con default 'activo' → 0 filas alteradas).
    expect(sql).toContain("status text NOT NULL DEFAULT 'activo'");
    expect(sql).toContain('status_reason text');
    expect(sql).toContain('status_changed_at timestamptz');
    expect(sql).toContain("CHECK (status IN ('activo','inactivo'))");
    // No es destructiva: sin DELETE/TRUNCATE/DROP de datos.
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);

    // Trigger: desactivar revoca el token del portal.
    expect(sql).toContain('revoke_owner_tokens_on_deactivate');
    expect(sql).toContain('trg_owners_revoke_tokens_on_deactivate');
    expect(sql).toContain('owner_portal_tokens');
    // El portal deja de validar el token de un owner inactivo.
    expect(sql).toContain("v_owner_status = 'inactivo'");
    // El badge del sidebar cuenta solo owners activos.
    expect(sql).toContain("status = 'activo'");
  });

  test('admin-crm.js: lee el estado, filtra por estado y pinta el chip + acciones', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();

    // Select con las columnas nuevas.
    expect(js).toContain('status, status_reason, status_changed_at');
    // Filtro de estado comercial (activos / inactivos / todos).
    expect(js).toContain("_ownerStatusFilter = 'activos'");
    expect(js).toContain("_ownerStatusFilter === 'inactivos'");
    expect(js).toContain("_ownerStatusFilter === 'todos'");
    // Chip DESACTIVADO en la fila.
    expect(js).toContain('DESACTIVADO');
    // Botones de desactivar / reactivar (solo super_admin).
    expect(js).toContain('data-action="deactivateOwner"');
    expect(js).toContain('data-action="reactivateOwner"');
    expect(js).toContain("role === 'super_admin'");
    // Delega en el engine del padrón.
    expect(js).toContain('window.adminApp.setOwnerStatus');
    // KPIs y alertas: solo propietarios activos.
    expect(js).toContain("updateOwnerKpis");
    expect(js).toContain("eq('status', 'activo')");
    expect(js).toContain("eq('status', 'inactivo')");
    // KPI "Desactivados" + filtro por estado en la barra.
    expect(js).toContain('Desactivados');
    expect(js).toContain('crmOwnerStatusFilter');
  });

  test('admin-crm.js: los KPIs de leads usan los 8 slots (los 2 muertos se rellenan)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain("'Tareas vencidas', 'Vencen en 24h'");
    expect(js).toContain("'Tareas pendientes', 'Propiedades'");
    // Los 3 filtros KPI que eran fantasma ahora tienen rama.
    expect(js).toContain("_kpiFilter === 'conversion'");
    expect(js).toContain("_kpiFilter === 'tasksPending'");
    expect(js).toContain("_kpiFilter === 'properties'");
    // setKpiLabels scoped a la fila del CRM (no pisa la de tasaciones).
    expect(js).toContain("#tab-leads .crm-kpis");
  });

  test('admin-propietarios.js: setOwnerStatus con motivo obligatorio + timeline + expediente', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-propietarios.js')).text();

    expect(js).toContain('window.adminApp.setOwnerStatus');
    // Motivo obligatorio: si no hay texto, no se desactiva.
    expect(js).toContain('ownerStatusReason');
    expect(js).toContain('Ingresá el motivo de la desactivación');
    // Estado + motivo + fecha en la DB.
    expect(js).toContain('status_reason');
    expect(js).toContain('status_changed_at');
    // Traza en el timeline del expediente.
    expect(js).toContain("type: 'status'");
    expect(js).toContain("owner_timeline_entries");
    // Icono propio del tipo 'status'.
    expect(js).toContain("status: 'fa-user-slash'");
    // Solo super_admin (RLS owners UPDATE).
    expect(js).toContain("profile.role !== 'super_admin'");
    // Despublicar propiedades es opt-in (nunca automático).
    expect(js).toContain('ownerStatusUnpublish');
    // NO borra al propietario: el payload del update nunca toca deleted_at.
    const payload = js.match(/const payload = \{[^}]*\}/);
    expect(payload).not.toBeNull();
    expect(payload[0]).toContain('status');
    expect(payload[0]).not.toContain('deleted_at');
  });

  test('admin.html: selector de estado + modal de desactivación', async ({ request }) => {
    const html = await (await request.get('/admin.html')).text();
    expect(html).toContain('id="crmOwnerStatusFilter"');
    expect(html).toContain('<option value="activos">');
    expect(html).toContain('<option value="inactivos">');
    expect(html).toContain('<option value="todos">');
    expect(html).toContain('id="ownerStatusModal"');
    expect(html).toContain('id="ownerStatusReason"');
    expect(html).toContain('id="ownerStatusUnpublish"');
    expect(html).toContain('id="ownerStatusConfirm"');
  });

  test('admin-app.js: el selector de propietario marca los inactivos', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    const fn = js.split('async function refreshOwnerSelect')[1] || '';
    expect(fn).toContain('status');
    expect(fn).toContain('(inactivo)');
  });

  test('edge functions: los propietarios inactivos no reciben avisos', () => {
    const root = path.join(__dirname, '..', 'supabase', 'functions');

    const reminder = fs.readFileSync(path.join(root, 'owner-tasks-reminder', 'index.ts'), 'utf8');
    expect(reminder).toContain(".eq(\"status\", \"inactivo\")");
    expect(reminder).toContain('inactiveOwnerIds');

    const renewals = fs.readFileSync(path.join(root, 'cron_exclusivity_renewals', 'index.ts'), 'utf8');
    expect(renewals).toContain('.eq("status", "activo")');

    const expiry = fs.readFileSync(path.join(root, 'exclusive-expiry-alert', 'index.ts'), 'utf8');
    expect(expiry).toContain(".eq('status', 'activo')");

    // La comisión de una venta vieja se liquida igual: NO se filtra.
    const commission = fs.readFileSync(path.join(root, 'trigger_commission_on_close', 'index.ts'), 'utf8');
    expect(commission).not.toContain("status', 'activo'");
    expect(commission).not.toContain('status", "activo"');
  });
});
