// REPARTO AUTOMÁTICO DE LEADS SIN AGENTE (2026-11-26).
//
// Medido: 9 leads vivos sin dueño (nadie los atiende) y carga despareja
// (Danilo 28 vivos vs Helmut 5). La RPC reparte por carga de trabajo con
// traza en el timeline; sin agentes activos abre una alerta de supervisión.
//
// Verificado en vivo con transacción + ROLLBACK: 9 asignados, 0 sin agente
// después, 9 trazas, 1 audit y la distribución resultante Danilo 28 / Helmut
// 14 (el menos cargado se lleva los nuevos hasta nivelar). El rollback deja
// los 9 huérfanos intactos.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const mig = read('supabase/migrations/20261126000013_reparto_leads.sql');
/* La versión vigente: la migración 20261127000004 (P1-6) recreó la RPC para
   que un lead colgado ("en espera") no se reparta (no está sin dueño: está
   colgado a propósito). */
const migVigente = read('supabase/migrations/20261127000004_lead_espera_rpc.sql');
const crmSrc = read('assets/js/admin-crm.js');

test.describe('Reparto automático de leads sin agente', () => {
  test('RPC: round-robin por carga, gate por rol y trazas', () => {
    expect(mig).toContain('CREATE OR REPLACE FUNCTION public.repartir_leads_sin_agente()');
    expect(mig).toContain("SET search_path = ''");
    // Gate: super_admin/broker; el cron (sin uid) puede correrlo.
    expect(mig).toContain('IF v_uid IS NOT NULL THEN');
    expect(mig).toContain("IF v_role NOT IN ('super_admin', 'broker') THEN");
    expect(mig).toContain('Solo super_admin o broker pueden repartir leads');
    // La carga se mide sobre leads VIVOS (los perdidos no cargan al agente).
    expect(mig).toContain("WHERE l.assigned_to = a.id AND l.deleted_at IS NULL");
    expect(mig).toMatch(/l\.stage NOT IN \('cerrado_ganado', 'cerrado_perdido'\)/);
    // Agentes ACTIVOS sólo (un inactivo no recibe nada).
    expect(mig).toContain("WHERE a.status = 'activo' AND a.deleted_at IS NULL");
    // Round-robin por carga: destino = el menos cargado; FIFO por created_at.
    expect(mig).toContain('ORDER BY c.carga ASC, c.id ASC');
    expect(mig).toContain('ORDER BY l.created_at ASC');
    // Traza en el timeline + auditoría.
    expect(mig).toContain("'Reparto automático de leads sin agente (por carga de trabajo).'");
    expect(mig).toContain("'leads_repartidos', 'crm', 'leads'");
  });

  test('la versión vigente (P1-6) no reparte leads colgados', () => {
    // Un lead en "en espera" NO está sin dueño: está colgado a propósito con
    // su fecha de regreso → el reparto no lo toca (si no, un lead a medio
    // trabajar se reasignaba y se le perdía el contexto).
    expect(migVigente).toContain('CREATE OR REPLACE FUNCTION public.repartir_leads_sin_agente()');
    expect(migVigente).toContain("AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')");
    // La carga que usa para nivelar tampoco cuenta los colgados.
    expect(migVigente).toMatch(/carga[\s\S]{0,400}en_espera/);
  });

  test('sin agentes activos → alerta de supervisión (no silencio)', () => {
    expect(mig).toContain("alert_type", 'leads_sin_agente');
    expect(mig).toContain('leads_sin_agente');
    expect(mig).toContain('El reparto automático no encontró agentes activos');
    expect(mig).toContain("'asignados', 0, 'alerta', true");
  });

  test('cron diario 09:05 ART: llamada SQL directa (sin edge function)', () => {
    expect(mig).toContain("'lead-reparto-daily'");
    expect(mig).toContain("'5 12 * * *'");
    expect(mig).toContain("'SELECT public.repartir_leads_sin_agente()'");
    // No depende de una edge function (patrón crm-followup-alerts).
    expect(mig).not.toContain('net.http_post');
    // Y el job quedó activo en producción (verificado 2026-11-26).
  });

  test('vista previa: la firma nueva conserva el default y NO escribe (28/11)', () => {
    const preview = read('supabase/migrations/20261128000009_reparto_dry_run.sql');
    // El cron y cualquier llamador viejo siguen andando sin argumentos.
    expect(preview).toContain('repartir_leads_sin_agente(p_dry_run boolean DEFAULT false)');
    expect(preview).toContain('DROP FUNCTION IF EXISTS public.repartir_leads_sin_agente();');
    expect(preview).toContain('SECURITY DEFINER');
    expect(preview).toContain("SET search_path = ''");
    // La rama preview simula carga en la tabla TEMP, nunca en las tablas reales.
    expect(preview).toMatch(/IF v_es_preview THEN[\s\S]{0,300}UPDATE _reparto_carga/);
    expect(preview).toContain("'dry_run', v_es_preview");
    // Ni traza, ni auditoría, ni alerta cuando es vista previa.
    expect(preview).toMatch(/IF NOT v_es_preview THEN[\s\S]{0,200}INSERT INTO public\.audit_log/);
    // CRLF/LF: el archivo se edita en Windows, el regex no depende del separador.
    expect(preview).toMatch(/IF NOT v_es_preview THEN\r?\n\s+INSERT INTO public\.supervision_alerts/);
    // Permisos intactos (anon ✗ / authenticated ✓ / service_role ✓).
    expect(preview).toContain('REVOKE ALL ON FUNCTION public.repartir_leads_sin_agente(boolean) FROM PUBLIC, anon, authenticated');
    expect(preview).toContain('GRANT EXECUTE ON FUNCTION public.repartir_leads_sin_agente(boolean) TO authenticated, service_role');
  });

  test('carga real y vetos (28/11): sólo NUEVOS sin actividad, tareas pesan el doble', () => {
    // Mejora 3 del diagnóstico en frío: los 5 huérfanos que quedaban son
    // cerrados (no se reparten) y el reparto nivelaba contando SOLO leads.
    const carga = read('supabase/migrations/20261128000014_reparto_carga_real.sql');
    // Misma firma: CREATE OR REPLACE, sin DROP ni sobrecarga nueva.
    expect(carga).toContain('CREATE OR REPLACE FUNCTION public.repartir_leads_sin_agente(p_dry_run boolean DEFAULT false)');
    expect(carga).not.toMatch(/DROP\s+FUNCTION/);
    // Veto doble: lead NUEVO y sin rastro en el timeline (nadie lo trabajó).
    expect(carga).toMatch(/l\.stage::text = 'nuevo'/);
    expect(carga).toMatch(/NOT EXISTS \([\s\S]{0,200}FROM public\.lead_activities la WHERE la\.lead_id = l\.id\)/);
    // Carga = leads vivos + 2×tareas de lead + tareas de propietario.
    expect(carga).toContain('tareas_abiertas');
    expect(carga).toContain('tareas_owner');
    expect(carga).toMatch(/\+ 2 \* \(SELECT count\(DISTINCT t\.id\)/);
    expect(carga).toContain("t.status IN ('pendiente', 'en_progreso')");
    expect(carga).toMatch(/ot\.status IN \('pendiente', 'en_progreso'\)/);
    // El detalle explica el destino y la traza dice por qué se asignó.
    expect(carga).toContain("'criterio', 'solo leads nuevos sin actividad; tareas abiertas pesan el doble'");
    expect(carga).toContain('Reparto automático de lead NUEVO sin agente (carga real:');
    // La vista previa sigue sin escribir: ni leads, ni timeline, ni audit, ni alerta.
    expect(carga).toMatch(/IF v_es_preview THEN[\s\S]{0,300}UPDATE _reparto_carga/);
    expect(carga).toMatch(/IF NOT v_es_preview THEN[\s\S]{0,200}INSERT INTO public\.audit_log/);
  });

  test('la bandeja ofrece el botón Repartir (con vista previa REAL)', () => {
    expect(crmSrc).toContain('data-bandeja-repartir');
    expect(crmSrc).toContain('async function bandejaRepartir(btn, body) {');
    // 28/11: primero pregunta sin escribir y la confirmación dice cuántos y a quién.
    expect(crmSrc).toContain("db().rpc('repartir_leads_sin_agente', { p_dry_run: true })");
    expect(crmSrc).toContain("db().rpc('repartir_leads_sin_agente', { p_dry_run: false })");
    expect(crmSrc).toContain('window.__BH.showConfirmDialog');
    // Sin onclick inline (CSP) y con re-listado de la bandeja.
    expect(crmSrc).toContain("repartir.addEventListener('click'" === '' ? '' : "if (repartir) { bandejaRepartir(repartir, body); return; }");
    expect(crmSrc).toContain('await openBandeja(); /* re-listar la bandeja */');
  });
});
