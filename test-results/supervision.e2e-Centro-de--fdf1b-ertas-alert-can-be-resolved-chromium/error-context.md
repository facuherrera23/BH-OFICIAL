# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: supervision.e2e.spec.ts >> Centro de Supervisión - Alertas >> alert_can_be_resolved
- Location: tests\supervision.e2e.spec.ts:270:7

# Error details

```
TypeError: Cannot read properties of null (reading 'access_token')
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
  250 |         'Authorization': `Bearer ${session.access_token}`,
  251 |         'Content-Type': 'application/json',
  252 |       },
  253 |       body: JSON.stringify({ alertId: alert.id, action: 'acknowledge' }),
  254 |     });
  255 | 
  256 |     expect(response.ok).toBeTruthy();
  257 | 
  258 |     const { data: updated } = await supabase
  259 |       .from('supervision_alerts')
  260 |       .select('*')
  261 |       .eq('id', alert.id)
  262 |       .single();
  263 | 
  264 |     expect(updated.status).toBe('acknowledged');
  265 |     expect(updated.acknowledged_by).toBeTruthy();
  266 | 
  267 |     await supabase.from('supervision_alerts').delete().eq('id', alert.id);
  268 |   });
  269 | 
  270 |   test('alert_can_be_resolved', async ({ superAdminPage, supabase }) => {
  271 |     const { data: alert } = await supabase
  272 |       .from('supervision_alerts')
  273 |       .insert({
  274 |         user_id: (await supabase.auth.getUser()).data.user?.id,
  275 |         module: 'test',
  276 |         severity: 'medium',
  277 |         alert_type: 'test_alert',
  278 |         title: 'Test Alert Resolve',
  279 |         description: 'Test',
  280 |         evidence: { test: true },
  281 |         status: 'acknowledged',
  282 |       })
  283 |       .select()
  284 |       .single();
  285 | 
  286 |     const { data: { session } } = await supabase.auth.getSession();
  287 |     const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/supervision-api/alert-action`, {
  288 |       method: 'POST',
  289 |       headers: {
> 290 |         'Authorization': `Bearer ${session.access_token}`,
      |                                            ^ TypeError: Cannot read properties of null (reading 'access_token')
  291 |         'Content-Type': 'application/json',
  292 |       },
  293 |       body: JSON.stringify({ alertId: alert.id, action: 'resolve' }),
  294 |     });
  295 | 
  296 |     expect(response.ok).toBeTruthy();
  297 | 
  298 |     const { data: updated } = await supabase
  299 |       .from('supervision_alerts')
  300 |       .select('*')
  301 |       .eq('id', alert.id)
  302 |       .single();
  303 | 
  304 |     expect(updated.status).toBe('resolved');
  305 |     expect(updated.resolved_by).toBeTruthy();
  306 | 
  307 |     await supabase.from('supervision_alerts').delete().eq('id', alert.id);
  308 |   });
  309 | 
  310 |   test('sensitive_fields_are_redacted', async ({ superAdminPage, supabase }) => {
  311 |     const { data: prop } = await supabase
  312 |       .from('properties')
  313 |       .insert({
  314 |         title: 'Test Redaction',
  315 |         price_usd: 100000,
  316 |         property_type: 'venta',
  317 |         zone: 'Test',
  318 |         status: 'publicada',
  319 |         is_published: true,
  320 |       })
  321 |       .select()
  322 |       .single();
  323 | 
  324 |     // Update with sensitive data in metadata
  325 |     await supabase
  326 |       .from('properties')
  327 |       .update({ title: 'Updated' })
  328 |       .eq('id', prop.id);
  329 | 
  330 |     const { data: audit } = await supabase
  331 |       .from('audit_log')
  332 |       .select('old_data, new_data')
  333 |       .eq('record_id', prop.id)
  334 |       .order('created_at', { ascending: false })
  335 |       .limit(1)
  336 |       .single();
  337 | 
  338 |     // Verify sensitive fields don't appear in audit
  339 |     const auditStr = JSON.stringify(audit);
  340 |     expect(auditStr).not.toContain('password');
  341 |     expect(auditStr).not.toContain('api_key');
  342 |     expect(auditStr).not.toContain('secret');
  343 |     expect(auditStr).not.toContain('token');
  344 | 
  345 |     await supabase.from('properties').delete().eq('id', prop.id);
  346 |   });
  347 | });
```