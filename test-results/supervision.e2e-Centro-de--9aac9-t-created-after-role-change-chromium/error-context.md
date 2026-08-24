# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: supervision.e2e.spec.ts >> Centro de Supervisión - Auditoría de Eventos >> audit_event_created_after_role_change
- Location: tests\supervision.e2e.spec.ts:138:7

# Error details

```
TypeError: Cannot read properties of null (reading 'id')
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e3]:
    - generic [ref=e4]: BIENENHAUS
    - generic [ref=e5]: ACCESO ADMINISTRATIVO & CRM
    - generic [ref=e6]: Invalid login credentials
    - generic [ref=e7]:
      - generic [ref=e8]:
        - generic [ref=e9]: Correo Corporativo
        - generic [ref=e10]:
          - generic: 
          - textbox "admin@bienenhaus.com.ar" [ref=e11]: superadmin@test.com
      - generic [ref=e12]:
        - generic [ref=e13]: Contraseña de Seguridad
        - generic [ref=e14]:
          - generic: 
          - textbox "••••••••" [ref=e15]: TestPass123!
      - generic [ref=e16]:
        - generic [ref=e17] [cursor=pointer]:
          - checkbox "Recordar credenciales" [checked] [ref=e18]
          - text: Recordar credenciales
        - link "← Volver al sitio" [ref=e19] [cursor=pointer]:
          - /url: index.html
      - button "Ingresar al Panel " [ref=e20] [cursor=pointer]:
        - generic [ref=e21]: Ingresar al Panel
        - generic [ref=e22]: 
  - text:                     +                      +  Sin registros Sin registros Sin registros Sin registros          %                 +                       +
  - option "Seleccionar..." [selected]
  - option "Casa"
  - option "Departamento"
  - option "Terreno"
  - option "Local"
  - option "Oficina"
  - option "Galpón"
  - option "Quinta"
  - option "Otro"
  - option "Venta" [selected]
  - option "Alquiler"
  - option "1. Nuevo" [selected]
  - option "2. Contactado"
  - option "3. Visita Agendada"
  - option "4. Oferta / Cierre"
  - option "Sin preferencia" [selected]
  - option "Casa"
  - option "Departamento"
  - option "Terreno"
  - option "Local"
  - option "Oficina"
  - option "Pendiente" [selected]
  - option "Confirmada"
  - option "Completada"
  - option "Cancelada"
  - option "Activo" [selected]
  - option "Inactivo"
  - option "WhatsApp" [selected]
  - option "Teléfono"
  - option "Email"
  - option "Agente" [selected]
  - option "Broker"
  - option "Super Admin"
  - option "Agente" [selected]
  - option "Broker"
  - option "Super Admin"
  - option "Activo" [selected]
  - option "Inactivo"
  - generic [ref=e23]:
    - generic [ref=e24]: 
    - generic [ref=e25]: Operación exitosa.
  - text: 
```

# Test source

```ts
  49  |     await supabase
  50  |       .from('properties')
  51  |       .update({ title: 'Updated Test Property' })
  52  |       .eq('id', prop.id);
  53  | 
  54  |     // Check audit_log
  55  |     const { data: audit } = await supabase
  56  |       .from('audit_log')
  57  |       .select('*')
  58  |       .eq('record_id', prop.id)
  59  |       .eq('action', 'update')
  60  |       .order('created_at', { ascending: false })
  61  |       .limit(1);
  62  | 
  63  |     expect(audit).toHaveLength(1);
  64  |     expect(audit[0].module).toBe('properties');
  65  |     expect(audit[0].action).toBe('update');
  66  |     expect(audit[0].entity_type).toBe('property');
  67  |     expect(audit[0].entity_id).toBe(prop.id);
  68  | 
  69  |     // Cleanup
  70  |     await supabase.from('properties').delete().eq('id', prop.id);
  71  |   });
  72  | 
  73  |   test('audit_event_created_after_lead_update', async ({ superAdminPage, supabase }) => {
  74  |     const { data: lead } = await supabase
  75  |       .from('leads')
  76  |       .insert({
  77  |         full_name: 'Test Lead Audit',
  78  |         phone: '1122334455',
  79  |         email: 'test@audit.com',
  80  |         stage: 'nuevo',
  81  |         budget_usd: 50000,
  82  |       })
  83  |       .select()
  84  |       .single();
  85  | 
  86  |     await supabase
  87  |       .from('leads')
  88  |       .update({ stage: 'contactado' })
  89  |       .eq('id', lead.id);
  90  | 
  91  |     const { data: audit } = await supabase
  92  |       .from('audit_log')
  93  |       .select('*')
  94  |       .eq('record_id', lead.id)
  95  |       .eq('action', 'update')
  96  |       .order('created_at', { ascending: false })
  97  |       .limit(1);
  98  | 
  99  |     expect(audit).toHaveLength(1);
  100 |     expect(audit[0].module).toBe('crm');
  101 |     expect(audit[0].entity_type).toBe('lead');
  102 | 
  103 |     await supabase.from('leads').delete().eq('id', lead.id);
  104 |   });
  105 | 
  106 |   test('audit_event_created_after_visit_update', async ({ superAdminPage, supabase }) => {
  107 |     const { data: visit } = await supabase
  108 |       .from('visits')
  109 |       .insert({
  110 |         client_name: 'Test Visit',
  111 |         client_phone: '1122334455',
  112 |         visit_date: new Date().toISOString(),
  113 |         status: 'pendiente',
  114 |       })
  115 |       .select()
  116 |       .single();
  117 | 
  118 |     await supabase
  119 |       .from('visits')
  120 |       .update({ status: 'confirmada' })
  121 |       .eq('id', visit.id);
  122 | 
  123 |     const { data: audit } = await supabase
  124 |       .from('audit_log')
  125 |       .select('*')
  126 |       .eq('record_id', visit.id)
  127 |       .eq('action', 'update')
  128 |       .order('created_at', { ascending: false })
  129 |       .limit(1);
  130 | 
  131 |     expect(audit).toHaveLength(1);
  132 |     expect(audit[0].module).toBe('agenda');
  133 |     expect(audit[0].entity_type).toBe('visit');
  134 | 
  135 |     await supabase.from('visits').delete().eq('id', visit.id);
  136 |   });
  137 | 
  138 |   test('audit_event_created_after_role_change', async ({ superAdminPage, supabase }) => {
  139 |     // Create a test user profile
  140 |     const { data: { user } } = await supabase.auth.admin.createUser({
  141 |       email: `rolechange${Date.now()}@test.com`,
  142 |       password: 'TestPass123!',
  143 |       email_confirm: true,
  144 |     });
  145 | 
  146 |     await supabase
  147 |       .from('profiles')
  148 |       .update({ role: 'admin' })
> 149 |       .eq('id', user.id);
      |                      ^ TypeError: Cannot read properties of null (reading 'id')
  150 | 
  151 |     const { data: audit } = await supabase
  152 |       .from('audit_log')
  153 |       .select('*')
  154 |       .eq('record_id', user.id)
  155 |       .eq('action', 'update_sensitive')
  156 |       .order('created_at', { ascending: false })
  157 |       .limit(1);
  158 | 
  159 |     expect(audit).toHaveLength(1);
  160 |     expect(audit[0].module).toBe('users');
  161 |     expect(audit[0].action).toBe('update_sensitive');
  162 |     expect(audit[0].metadata?.sensitive_fields_changed).toContain('role');
  163 | 
  164 |     await supabase.auth.admin.deleteUser(user.id);
  165 |   });
  166 | 
  167 |   test('bulk_operation_generates_audit', async ({ superAdminPage, supabase }) => {
  168 |     // Create multiple properties
  169 |     const props = await Promise.all([
  170 |       supabase.from('properties').insert({ title: 'Bulk 1', price_usd: 100000, property_type: 'venta', zone: 'Z1', status: 'publicada', is_published: true }).select().single(),
  171 |       supabase.from('properties').insert({ title: 'Bulk 2', price_usd: 200000, property_type: 'venta', zone: 'Z2', status: 'publicada', is_published: true }).select().single(),
  172 |       supabase.from('properties').insert({ title: 'Bulk 3', price_usd: 300000, property_type: 'venta', zone: 'Z3', status: 'publicada', is_published: true }).select().single(),
  173 |     ]);
  174 | 
  175 |     const ids = props.map(p => p.data!.id);
  176 | 
  177 |     // Simulate bulk update via multiple updates in short time
  178 |     for (const id of ids) {
  179 |       await supabase.from('properties').update({ status: 'vendida' }).eq('id', id);
  180 |     }
  181 | 
  182 |     const { data: audits } = await supabase
  183 |       .from('audit_log')
  184 |       .select('*')
  185 |       .in('record_id', ids)
  186 |       .eq('action', 'update')
  187 |       .order('created_at', { ascending: false });
  188 | 
  189 |     expect(audits.length).toBeGreaterThanOrEqual(3);
  190 | 
  191 |     // Check for bulk operation parent/children events
  192 |     const { data: bulkStart } = await supabase
  193 |       .from('audit_log')
  194 |       .select('*')
  195 |       .eq('action', 'bulk_update')
  196 |       .order('created_at', { ascending: false })
  197 |       .limit(1);
  198 | 
  199 |     // Cleanup
  200 |     await supabase.from('properties').delete().in('id', ids);
  201 |   });
  202 | });
  203 | 
  204 | test.describe('Centro de Supervisión - Alertas', () => {
  205 |   test('alert_created_when_rule_threshold_is_reached', async ({ superAdminPage, supabase }) => {
  206 |     // Trigger export threshold rule (30 exports in 1 hour)
  207 |     for (let i = 0; i < 31; i++) {
  208 |       await supabase.rpc('insert_usage_event', {
  209 |         p_module: 'crm',
  210 |         p_event_type: 'tool_usage',
  211 |         p_action: 'export',
  212 |         p_user_id: (await supabase.auth.getUser()).data.user?.id,
  213 |       });
  214 |     }
  215 | 
  216 |     // Wait for rule evaluation (or trigger manually)
  217 |     await supabase.rpc('evaluate_supervision_rules');
  218 | 
  219 |     const { data: alerts } = await supabase
  220 |       .from('supervision_alerts')
  221 |       .select('*')
  222 |       .eq('alert_type', 'bulk_export_detection')
  223 |       .order('created_at', { ascending: false })
  224 |       .limit(1);
  225 | 
  226 |     expect(alerts).toHaveLength(1);
  227 |     expect(alerts[0].severity).toBe('medium');
  228 |   });
  229 | 
  230 |   test('alert_can_be_acknowledged', async ({ superAdminPage, supabase }) => {
  231 |     const { data: alert } = await supabase
  232 |       .from('supervision_alerts')
  233 |       .insert({
  234 |         user_id: (await supabase.auth.getUser()).data.user?.id,
  235 |         module: 'test',
  236 |         severity: 'medium',
  237 |         alert_type: 'test_alert',
  238 |         title: 'Test Alert',
  239 |         description: 'Test description',
  240 |         evidence: { test: true },
  241 |       })
  242 |       .select()
  243 |       .single();
  244 | 
  245 |     // Acknowledge via API
  246 |     const { data: { session } } = await supabase.auth.getSession();
  247 |     const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/supervision-api/alert-action`, {
  248 |       method: 'POST',
  249 |       headers: {
```