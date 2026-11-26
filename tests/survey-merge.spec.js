// Encuesta de visita — merge de respuestas parciales + nota en el lead (2026-11-25).
// Guards ESTÁTICOS: no tocan la BD ni la red.
//
// POR QUÉ: el submit hacía `answers = v_clean` (replace full-set). Un autoguardado
// posterior con menos campos borraba lo ya cargado. Además, los parciales no
// dejaban ninguna nota en lead_activities: por eso había 0 notas con 7 encuestas.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const MIGRATION = 'supabase/migrations/20261125000002_survey_merge_partial_note.sql';
const FIX = 'supabase/migrations/20261125000003_survey_merge_count_fix.sql';
const README = 'README.md';

test.describe('encuestas — merge anti-pisón y nota de parcial', () => {
  const sql = read(MIGRATION);

  test('la migración redefine survey_submit_by_token', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.survey_submit_by_token(p_token text, p_answers jsonb, p_finalize boolean DEFAULT false)');
  });

  test('YA NO reemplaza answers: hace merge con lo guardado', () => {
    expect(sql).not.toMatch(/SET\s+answers\s*=\s*v_clean\b/);
    expect(sql).toContain('IF jsonb_typeof(rec.answers) = \'object\' THEN');
    expect(sql).toContain('v_merged := v_base || v_clean;');
    expect(sql).toContain('SET answers = v_merged,');
  });

  test('conserva el bloqueo FOR UPDATE y el guard de archivada antes del UPDATE', () => {
    expect(sql).toContain('LIMIT 1 FOR UPDATE');
    expect(sql).toMatch(/IF rec\.archived_at IS NOT NULL THEN\s*RETURN jsonb_build_object\('ok', false, 'error', 'encuesta archivada'\);/);
    expect(sql.indexOf('rec.archived_at IS NOT NULL')).toBeLessThan(sql.indexOf('UPDATE public.visit_surveys'));
  });

  test('mantiene SECURITY DEFINER, search_path fijo y sin sentencias destructivas', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path = ''");
    const sinComentarios = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sinComentarios).not.toMatch(/\b(DELETE|TRUNCATE|DROP|REVOKE)\b/i);
  });

  test('la nota de parcial se crea UNA vez y no cuando se finaliza', () => {
    expect(sql).toContain('IF NOT p_finalize AND v_incoming > 0 AND NOT EXISTS (');
    expect(sql).toContain('v_incoming := (SELECT count(*) FROM jsonb_object_keys(v_clean));');
    expect(sql).not.toMatch(/jsonb_object_length/);
    expect(sql).toContain("title LIKE 'Encuesta de visita recibida (parcial)%'");
    expect(sql).toContain("description LIKE '%' || rec.id::text || '%'");
    expect(sql).toContain('Autoguardado: el visitante todavía no apretó "Enviar". Encuesta ');
  });

  test('la nota final sigue existiendo y ambas usan el merge completo', () => {
    expect(sql).toContain("'Encuesta de visita recibida' || CASE WHEN p.property_code IS NOT NULL");
    expect(sql).toContain("v_desc := 'General: ' || coalesce(v_merged->>'general', '—')");
    expect(sql.match(/INSERT INTO public\.lead_activities/g)).toHaveLength(2);
  });

  test('el RPC devuelve cuántas respuestas quedaron y si creó la nota', () => {
    expect(sql).toContain("'answer_count', v_count");
    expect(sql).toContain("'partial_note', v_note");
  });
});

test.describe('encuestas — correctiva del conteo de respuestas', () => {
  const fix = read(FIX);

  const sinComentarios = (s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  test('0002 ya no usa jsonb_object_length (no existe en este Postgres)', () => {
    expect(sinComentarios(read(MIGRATION))).not.toMatch(/jsonb_object_length/);
  });

  test('la correctiva redefine el mismo RPC con count(jsonb_object_keys)', () => {
    expect(fix).toContain('CREATE OR REPLACE FUNCTION public.survey_submit_by_token(p_token text, p_answers jsonb, p_finalize boolean DEFAULT false)');
    expect(sinComentarios(fix)).not.toMatch(/jsonb_object_length/);
    expect(fix).toContain('v_incoming := (SELECT count(*) FROM jsonb_object_keys(v_clean));');
    expect(fix).toContain('v_count := (SELECT count(*) FROM jsonb_object_keys(v_merged));');
    expect(fix.indexOf('CREATE OR REPLACE FUNCTION')).toBeLessThan(fix.indexOf('AS $function$'));
  });
});

test.describe('encuestas — documentación del contrato', () => {
  const readme = read(README);

  test('README explica el merge y la nota de parcial', () => {
    expect(readme).toContain('merge server-side');
    expect(readme).toContain('Encuesta de visita recibida (parcial)');
  });
});
