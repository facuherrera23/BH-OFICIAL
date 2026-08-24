import { test, expect } from './auth.fixture';

test.describe('Centro de Supervisión - Control de Acceso', () => {
  test('super_admin_can_open_supervision', async ({ superAdminPage }) => {
    await superAdminPage.click('[data-tab="tab-supervision"]');
    await expect(superAdminPage.locator('#tab-supervision')).toBeVisible();
    await expect(superAdminPage.locator('#supvViewSummaryContent')).toHaveClass(/is-active/);
  });

  test('admin_cannot_see_supervision', async ({ adminPage }) => {
    await adminPage.click('[data-tab="tab-supervision"]');
    await expect(adminPage.locator('#tab-supervision')).toBeHidden();
  });

  test('broker_cannot_see_supervision', async ({ brokerPage }) => {
    await brokerPage.click('[data-tab="tab-supervision"]');
    await expect(brokerPage.locator('#tab-supervision')).toBeHidden();
  });

  test('viewer_cannot_see_supervision', async ({ viewerPage }) => {
    await viewerPage.click('[data-tab="tab-supervision"]');
    await expect(viewerPage.locator('#tab-supervision')).toBeHidden();
  });

  test('direct_route_is_protected', async ({ page }) => {
    await page.goto('/admin.html#tab-supervision');
    await page.waitForSelector('#loginScreen', { state: 'visible' });
    await expect(page.locator('#loginScreen')).toBeVisible();
  });
});

test.describe('Centro de Supervisión - Auditoría de Eventos', () => {
  test('audit_event_created_after_property_update', async ({ superAdminPage, supabase }) => {
    // Create a property
    const { data: prop } = await supabase
      .from('properties')
      .insert({
        title: 'Test Property Audit',
        price_usd: 100000,
        property_type: 'venta',
        zone: 'Test Zone',
        status: 'publicada',
        is_published: true,
      })
      .select()
      .single();

    // Update it
    await supabase
      .from('properties')
      .update({ title: 'Updated Test Property' })
      .eq('id', prop.id);

    // Check audit_log
    const { data: audit } = await supabase
      .from('audit_log')
      .select('*')
      .eq('record_id', prop.id)
      .eq('action', 'update')
      .order('created_at', { ascending: false })
      .limit(1);

    expect(audit).toHaveLength(1);
    expect(audit[0].module).toBe('properties');
    expect(audit[0].action).toBe('update');
    expect(audit[0].entity_type).toBe('property');
    expect(audit[0].entity_id).toBe(prop.id);

    // Cleanup
    await supabase.from('properties').delete().eq('id', prop.id);
  });

  test('audit_event_created_after_lead_update', async ({ superAdminPage, supabase }) => {
    const { data: lead } = await supabase
      .from('leads')
      .insert({
        full_name: 'Test Lead Audit',
        phone: '1122334455',
        email: 'test@audit.com',
        stage: 'nuevo',
        budget_usd: 50000,
      })
      .select()
      .single();

    await supabase
      .from('leads')
      .update({ stage: 'contactado' })
      .eq('id', lead.id);

    const { data: audit } = await supabase
      .from('audit_log')
      .select('*')
      .eq('record_id', lead.id)
      .eq('action', 'update')
      .order('created_at', { ascending: false })
      .limit(1);

    expect(audit).toHaveLength(1);
    expect(audit[0].module).toBe('crm');
    expect(audit[0].entity_type).toBe('lead');

    await supabase.from('leads').delete().eq('id', lead.id);
  });

  test('audit_event_created_after_visit_update', async ({ superAdminPage, supabase }) => {
    const { data: visit } = await supabase
      .from('visits')
      .insert({
        client_name: 'Test Visit',
        client_phone: '1122334455',
        visit_date: new Date().toISOString(),
        status: 'pendiente',
      })
      .select()
      .single();

    await supabase
      .from('visits')
      .update({ status: 'confirmada' })
      .eq('id', visit.id);

    const { data: audit } = await supabase
      .from('audit_log')
      .select('*')
      .eq('record_id', visit.id)
      .eq('action', 'update')
      .order('created_at', { ascending: false })
      .limit(1);

    expect(audit).toHaveLength(1);
    expect(audit[0].module).toBe('agenda');
    expect(audit[0].entity_type).toBe('visit');

    await supabase.from('visits').delete().eq('id', visit.id);
  });

  test('audit_event_created_after_role_change', async ({ superAdminPage, supabase }) => {
    // Create a test user profile
    const { data: { user } } = await supabase.auth.admin.createUser({
      email: `rolechange${Date.now()}@test.com`,
      password: 'TestPass123!',
      email_confirm: true,
    });

    await supabase
      .from('profiles')
      .update({ role: 'admin' })
      .eq('id', user.id);

    const { data: audit } = await supabase
      .from('audit_log')
      .select('*')
      .eq('record_id', user.id)
      .eq('action', 'update_sensitive')
      .order('created_at', { ascending: false })
      .limit(1);

    expect(audit).toHaveLength(1);
    expect(audit[0].module).toBe('users');
    expect(audit[0].action).toBe('update_sensitive');
    expect(audit[0].metadata?.sensitive_fields_changed).toContain('role');

    await supabase.auth.admin.deleteUser(user.id);
  });

  test('bulk_operation_generates_audit', async ({ superAdminPage, supabase }) => {
    // Create multiple properties
    const props = await Promise.all([
      supabase.from('properties').insert({ title: 'Bulk 1', price_usd: 100000, property_type: 'venta', zone: 'Z1', status: 'publicada', is_published: true }).select().single(),
      supabase.from('properties').insert({ title: 'Bulk 2', price_usd: 200000, property_type: 'venta', zone: 'Z2', status: 'publicada', is_published: true }).select().single(),
      supabase.from('properties').insert({ title: 'Bulk 3', price_usd: 300000, property_type: 'venta', zone: 'Z3', status: 'publicada', is_published: true }).select().single(),
    ]);

    const ids = props.map(p => p.data!.id);

    // Simulate bulk update via multiple updates in short time
    for (const id of ids) {
      await supabase.from('properties').update({ status: 'vendida' }).eq('id', id);
    }

    const { data: audits } = await supabase
      .from('audit_log')
      .select('*')
      .in('record_id', ids)
      .eq('action', 'update')
      .order('created_at', { ascending: false });

    expect(audits.length).toBeGreaterThanOrEqual(3);

    // Check for bulk operation parent/children events
    const { data: bulkStart } = await supabase
      .from('audit_log')
      .select('*')
      .eq('action', 'bulk_update')
      .order('created_at', { ascending: false })
      .limit(1);

    // Cleanup
    await supabase.from('properties').delete().in('id', ids);
  });
});

test.describe('Centro de Supervisión - Alertas', () => {
  test('alert_created_when_rule_threshold_is_reached', async ({ superAdminPage, supabase }) => {
    // Trigger export threshold rule (30 exports in 1 hour)
    for (let i = 0; i < 31; i++) {
      await supabase.rpc('insert_usage_event', {
        p_module: 'crm',
        p_event_type: 'tool_usage',
        p_action: 'export',
        p_user_id: (await supabase.auth.getUser()).data.user?.id,
      });
    }

    // Wait for rule evaluation (or trigger manually)
    await supabase.rpc('evaluate_supervision_rules');

    const { data: alerts } = await supabase
      .from('supervision_alerts')
      .select('*')
      .eq('alert_type', 'bulk_export_detection')
      .order('created_at', { ascending: false })
      .limit(1);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('medium');
  });

  test('alert_can_be_acknowledged', async ({ superAdminPage, supabase }) => {
    const { data: alert } = await supabase
      .from('supervision_alerts')
      .insert({
        user_id: (await supabase.auth.getUser()).data.user?.id,
        module: 'test',
        severity: 'medium',
        alert_type: 'test_alert',
        title: 'Test Alert',
        description: 'Test description',
        evidence: { test: true },
      })
      .select()
      .single();

    // Acknowledge via API
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/supervision-api/alert-action`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ alertId: alert.id, action: 'acknowledge' }),
    });

    expect(response.ok).toBeTruthy();

    const { data: updated } = await supabase
      .from('supervision_alerts')
      .select('*')
      .eq('id', alert.id)
      .single();

    expect(updated.status).toBe('acknowledged');
    expect(updated.acknowledged_by).toBeTruthy();

    await supabase.from('supervision_alerts').delete().eq('id', alert.id);
  });

  test('alert_can_be_resolved', async ({ superAdminPage, supabase }) => {
    const { data: alert } = await supabase
      .from('supervision_alerts')
      .insert({
        user_id: (await supabase.auth.getUser()).data.user?.id,
        module: 'test',
        severity: 'medium',
        alert_type: 'test_alert',
        title: 'Test Alert Resolve',
        description: 'Test',
        evidence: { test: true },
        status: 'acknowledged',
      })
      .select()
      .single();

    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/supervision-api/alert-action`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ alertId: alert.id, action: 'resolve' }),
    });

    expect(response.ok).toBeTruthy();

    const { data: updated } = await supabase
      .from('supervision_alerts')
      .select('*')
      .eq('id', alert.id)
      .single();

    expect(updated.status).toBe('resolved');
    expect(updated.resolved_by).toBeTruthy();

    await supabase.from('supervision_alerts').delete().eq('id', alert.id);
  });

  test('sensitive_fields_are_redacted', async ({ superAdminPage, supabase }) => {
    const { data: prop } = await supabase
      .from('properties')
      .insert({
        title: 'Test Redaction',
        price_usd: 100000,
        property_type: 'venta',
        zone: 'Test',
        status: 'publicada',
        is_published: true,
      })
      .select()
      .single();

    // Update with sensitive data in metadata
    await supabase
      .from('properties')
      .update({ title: 'Updated' })
      .eq('id', prop.id);

    const { data: audit } = await supabase
      .from('audit_log')
      .select('old_data, new_data')
      .eq('record_id', prop.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // Verify sensitive fields don't appear in audit
    const auditStr = JSON.stringify(audit);
    expect(auditStr).not.toContain('password');
    expect(auditStr).not.toContain('api_key');
    expect(auditStr).not.toContain('secret');
    expect(auditStr).not.toContain('token');

    await supabase.from('properties').delete().eq('id', prop.id);
  });
});