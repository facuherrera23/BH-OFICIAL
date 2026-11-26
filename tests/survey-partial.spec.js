// Encuesta de visita — respuestas parciales + link archivado (2026-11-25).
// Guards ESTÁTICOS: no tocan la BD ni la red.
//
// POR QUÉ: con 0 encuestas finalizadas pero 2 con respuestas reales, el CRM
// mostraba "Enviada" y no ofrecía "Ver respuestas"; el visitante podía seguir
// escribiendo en una encuesta archivada por "Reiniciar" porque los RPC por
// token no miraban archived_at. Ninguno de los dos se ve en tests de texto
// genérico: hace falta fijar el contrato.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const MIGRATION = 'supabase/migrations/20261125000001_survey_archived_link.sql';
const CRM = 'assets/js/admin-crm.js';
const PROPS = 'assets/js/admin-propiedades.js';
const CSS = 'assets/css/admin.css';

test.describe('encuestas — link archivado cerrado en los RPC por token', () => {
  const sql = read(MIGRATION);

  test('la migración redefine los DOS RPC por token', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.survey_get_by_token(p_token text)');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.survey_submit_by_token(p_token text, p_answers jsonb, p_finalize boolean DEFAULT false)');
  });

  test('survey_get_by_token devuelve available:false para una encuesta archivada', () => {
    const [_, getFn] = sql.split('CREATE OR REPLACE FUNCTION public.survey_get_by_token');
    const body = getFn.split('CREATE OR REPLACE FUNCTION public.survey_submit_by_token')[0];
    expect(body).toMatch(/IF rec\.archived_at IS NOT NULL THEN\s*RETURN jsonb_build_object\('available', false\);/);
  });

  test('survey_submit_by_token rechaza la escritura ANTES del UPDATE', () => {
    const submit = sql.split('CREATE OR REPLACE FUNCTION public.survey_submit_by_token')[1];
    expect(submit).toMatch(/IF rec\.archived_at IS NOT NULL THEN\s*RETURN jsonb_build_object\('ok', false, 'error', 'encuesta archivada'\);/);
    expect(submit.indexOf('rec.archived_at IS NOT NULL')).toBeLessThan(submit.indexOf('UPDATE public.visit_surveys'));
  });

  test('la migración es aditiva: no borra filas ni tablas', () => {
    const sinComentarios = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sinComentarios).not.toMatch(/\b(DELETE|TRUNCATE|DROP)\b/i);
  });

  test('ambas funciones conservan SECURITY DEFINER y search_path fijo', () => {
    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(sql.match(/SET search_path = ''/g)).toHaveLength(2);
  });
});

test.describe('encuestas — parciales visibles para el agente', () => {
  const crm = read(CRM);
  const props = read(PROPS);
  const css = read(CSS);

  test('el CRM trae updated_at y answers para clasificar el parcial', () => {
    const select = crm.match(/function getLeadSurveys\(id\)[\s\S]*?\.select\('([^']+)'\)/);
    expect(select).toBeTruthy();
    expect(select[1]).toContain('answers');
    expect(select[1]).toContain('updated_at');
    expect(crm).toContain('function surveyAnswerCount(s)');
  });

  test('el chip del lead distingue "Parcial (N)" de "Enviada"', () => {
    expect(crm).toContain("sv.finalized ? 'done' : (svCount ? 'partial' : 'sent')");
    expect(crm).toContain(">Parcial (' + svCount + ')");
    expect(crm).toContain("svState === 'done' || svState === 'partial'");
  });

  test('el diálogo "Ver lo cargado" avisa que el visitante no envió', () => {
    expect(crm).toContain('Ver lo cargado (respuesta parcial)');
    expect(crm).toContain("s && !s.finalized && surveyAnswerCount(s)");
    expect(crm).toContain('no apretó "Enviar"');
  });

  test('la ficha de propiedad muestra el badge parcial y la fecha del último guardado', () => {
    expect(props).toContain("s.submitted_at || s.updated_at || s.created_at");
    expect(props).toContain('survey-status--partial');
    expect(props).toContain("Parcial (' + nAnswers + ')");
    expect(props).toContain('created_at, updated_at, archived_at,');
  });

  test('el CSS del badge parcial existe', () => {
    expect(css).toContain('.survey-status--partial{');
  });
});
