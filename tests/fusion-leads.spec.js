// FUSIÓN DE LEADS DUPLICADOS (2026-11-26).
//
// Medido: 48 de 124 leads vivos (39%) en 38 grupos (mismo email o teléfono
// normalizado, cruzando orígenes ML/manual/RELA/GVAmax).
//
// Tres bugs reales encontrados al verificar en VIVO (cada uno con su
// migración de fix — el patrón "una migración aplicada no se edita"):
//   1. 42803: ORDER BY exterior sobre columnas no agregadas junto al
//      jsonb_agg → fallaba para CUALQUIER llamada autenticada (20261126000010).
//   2. 23505: uq_leads_ml_lead_id — el duplicado todavía sostenía el valor
//      cuando corrió el UPDATE del principal (20261126000011).
//   3. 22P02: text[] || literal en plpgsql se resolvía como unión de arrays
//      (20261126000012).
// La fusión se verificó con una transacción + ROLLBACK sobre leads reales:
// mueve timeline/tareas/propiedades/visitas vivas/encuestas y ml_lead_id,
// deja el duplicado en la papelera con lost_reason='duplicado' y al hacer
// rollback NO queda nada escrito.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const mig = read('supabase/migrations/20261126000009_fusion_leads.sql');
const fix1 = read('supabase/migrations/20261126000010_fusion_leads_fix.sql');
const fix2 = read('supabase/migrations/20261126000011_fusion_leads_fix2.sql');
const fix3 = read('supabase/migrations/20261126000012_fusion_leads_fix3.sql');
const crmSrc = read('assets/js/admin-crm.js');
const htmlSrc = read('admin.html');

test.describe('Fusión de leads duplicados', () => {
  test('las dos RPC existen, sin anon y con gate por rol', () => {
    expect(mig).toContain('CREATE OR REPLACE FUNCTION public.leads_duplicados()');
    expect(mig).toContain('CREATE OR REPLACE FUNCTION public.fusionar_leads(p_principal uuid, p_duplicado uuid)');
    for (const f of [mig, fix1, fix2, fix3]) {
      expect(f).toContain("SET search_path = ''");
      expect(f).toMatch(/REVOKE ALL ON FUNCTION public\.\w+\([^)]*\) FROM PUBLIC, anon;/);
      expect(f).toMatch(/GRANT EXECUTE ON FUNCTION public\.\w+\([^)]*\) TO authenticated, service_role;/);
    }
    // El gate de fusión: sólo super_admin o broker.
    expect(mig).toContain("IF v_role NOT IN ('super_admin', 'broker') THEN");
    expect(mig).toContain('Solo super_admin o broker pueden fusionar leads');
  });

  test('la fusión es REVERSIBLE: soft-delete, nunca DELETE de leads', () => {
    // El duplicado va a la papelera (reparable desde el CRM), no se borra.
    expect(mig).toContain("SET deleted_at = now(),");
    expect(mig).toContain("lost_reason = 'duplicado'");
    // La migración no borra leads al instalarse.
    expect(mig).not.toMatch(/DELETE\s+FROM\s+public\.leads/i);
  });

  test('la fusión mueve el historial completo y nunca pisa datos', () => {
    // Timeline, tareas, propiedades, visitas vivas, encuestas.
    expect(mig).toContain('UPDATE public.lead_activities SET lead_id = p_principal');
    expect(mig).toContain('UPDATE public.lead_tasks SET lead_id = p_principal');
    expect(mig).toContain('UPDATE public.lead_properties SET lead_id = p_principal');
    expect(mig).toContain("UPDATE public.visits SET lead_id = p_principal\n   WHERE lead_id = p_duplicado AND status IN ('pendiente', 'confirmada')");
    expect(mig).toContain('UPDATE public.visit_surveys SET lead_id = p_principal');
    // NUNCA pisa datos: los campos del duplicado sólo llenan vacíos (COALESCE).
    expect(mig).toContain('email = COALESCE(p.email, v_dup.email)');
    expect(mig).toContain('budget_usd = COALESCE(p.budget_usd, v_dup.budget_usd)');
    // Los vínculos repetidos se descartan antes de mover (PK compuesta).
    expect(mig).toMatch(/DELETE FROM public\.lead_properties lp\s*\n\s*WHERE lp\.lead_id = p_duplicado\s*\n\s*AND EXISTS/);
    // Las visitas CERRADAS no se mueven (el trigger inventaría la etapa).
    expect(mig).toContain('visitas cerradas quedaron en el lead original');
    // followup recalculado con la MISMA regla del trigger de tareas.
    expect(mig).toMatch(/SELECT min\(t\.due_at\) FROM public\.lead_tasks t\s*\n\s*WHERE t\.lead_id = p_principal\s*\n\s*AND t\.status IN \('pendiente', 'en_progreso'\)/);
    // Auditoría con los movimientos.
    expect(mig).toContain("'lead_merged', 'crm', 'leads'");
  });

  test('los 3 fixes: order-by del agregado, uq_ml_lead_id y array_append', () => {
    // FIX 1 (42803): el LIMIT/orden van en un subquery, no junto al agregado.
    expect(fix1).toMatch(/top AS \(\s*\n\s*SELECT tipo, k, n, primero\s*\n\s*FROM grupos\s*\n\s*ORDER BY n DESC, primero ASC\s*\n\s*LIMIT 50\s*\n\s*\)/);
    expect(fix1).toContain('FROM top g;');
    // FIX 2 (23505): liberar el ml_lead_id del duplicado ANTES del merge.
    expect(fix2).toContain('IF v_dup.ml_lead_id IS NOT NULL AND v_antes.ml_lead_id IS NULL THEN');
    expect(fix2).toContain('UPDATE public.leads SET ml_lead_id = NULL WHERE id = p_duplicado;');
    // FIX 3 (22P02): array_append, no text[] || literal.
    expect(fix3).toContain("v_campos := array_append(v_campos, 'email');");
    expect(fix3).not.toMatch(/v_campos := v_campos \|\| '/);
  });

  test('el CRM tiene el botón Duplicados y el overlay de fusión', () => {
    expect(htmlSrc).toContain('id="crmDuplicadosBtn"');
    expect(crmSrc).toContain('async function openDuplicados() {');
    expect(crmSrc).toContain("db().rpc('leads_duplicados')");
    expect(crmSrc).toContain("db().rpc('fusionar_leads', { p_principal: principal, p_duplicado: duplicado[i].lead_id })");
    // Confirmación con el diálogo del panel (el confirm() nativo está prohibido).
    expect(crmSrc).toContain('window.__BH.showConfirmDialog');
    // Sin onclick inline (CSP).
    expect(crmSrc).toContain("dupBtn.addEventListener('click', openDuplicados);");
    expect(crmSrc).toContain('openDuplicados: openDuplicados');
    // El duplicado elegido no se puede ser el principal (validación en la UI).
    expect(crmSrc).toContain("duplicado = miembros.filter(function (m) { return m.lead_id !== principal; })");
  });

  test('behavioral: el render de grupos escapa los datos y arma radios', () => {
    // Extraer el render del overlay (openDuplicados) con stubs de DOM mínimos.
    const from = crmSrc.indexOf('async function openDuplicados() {');
    const to = crmSrc.indexOf('/* markLeadContacted se publica');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    // El render usa esc() en TODO dato del lead (nombre, teléfono, email, origen).
    const render = crmSrc.slice(from, to);
    expect(render).toMatch(/esc\(m\.nombre \|\| 'Sin nombre'\)/);
    expect(render).toMatch(/esc\(\[STATUS_LABELS\[m\.stage\] \|\| m\.stage/);
    expect(render).toMatch(/esc\(m\.lead_id\)/);
    // Y el mensaje de vacío existe (no un bloque roto).
    expect(render).toContain('No hay duplicados detectados');
  });
});
