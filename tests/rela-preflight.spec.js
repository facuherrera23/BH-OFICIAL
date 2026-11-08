// RELA / ZonaProp — preflight y separación "bloqueado" vs "no publicable"
// (2026-11-07).
// Guards ESTÁTICOS: edge function + mapper + panel + RPC. No tocan la BD ni
// la red.
//
// POR QUÉ: el panel decía "18 bloqueados" cuando el problema real eran 5
// avisos (3 zonas sin mapear). Las otras 13 filas BLOCKED eran de propiedades
// YA VENDIDAS: no son bloqueos (nunca se publican), son propiedades fuera de
// la cola. Además, un dry-run sobre una propiedad vendida pisaba a BLOCKED
// una fila que podía estar PUBLISHED (se perdía el estado de un aviso vivo).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'supabase', 'functions', 'rela-proxy', 'index.ts');
const MAPPER = path.join(ROOT, 'supabase', 'functions', '_shared', 'rela.mapper.ts');
const MIG = path.join(ROOT, 'supabase', 'migrations', '20261107000001_rela_preflight_no_publicables.sql');
const PORTALES = path.join(ROOT, 'assets', 'js', 'admin-portales.js');

const fnSrc = fs.readFileSync(FN, 'utf8');
const mapperSrc = fs.readFileSync(MAPPER, 'utf8');
const migSrc = fs.readFileSync(MIG, 'utf8');
const portalesSrc = fs.readFileSync(PORTALES, 'utf8');

test.describe('RELA — preflight de avisos', () => {
  test('la edge function tiene la acción preflight (sólo lectura)', () => {
    expect(fnSrc).toContain("action === 'preflight'");
    // Clasifica en los 3 grupos honestos.
    expect(fnSrc).toContain('no_publicables');
    expect(fnSrc).toContain('zonas_sin_mapeo');
    // NO debe publicar ni llamar a RELA en el preflight.
    const bloque = fnSrc.slice(fnSrc.indexOf("action === 'preflight'"), fnSrc.indexOf("action === 'config_get'"));
    expect(bloque).not.toContain("client.request(");
    expect(bloque).not.toContain("from('rela_listings').upsert");
  });

  test('una propiedad vendida NO genera fila BLOCKED', () => {
    expect(fnSrc).toContain('function esPublicable');
    expect(fnSrc).toContain('no_publicable: true');
    // El guard de publicable va ANTES del upsert a BLOCKED.
    const iGuard = fnSrc.indexOf('if (!esPublicable(property))');
    const iUpsert = fnSrc.indexOf("status: 'BLOCKED', last_error:");
    expect(iGuard).toBeGreaterThan(-1);
    expect(iUpsert).toBeGreaterThan(-1);
    expect(iGuard).toBeLessThan(iUpsert);
  });

  test('un aviso PUBLISHED nunca se pisa a BLOCKED', () => {
    expect(fnSrc).toContain("actual?.status === 'PUBLISHED'");
    // Y se avisa explícitamente en vez de tocar el estado.
    expect(fnSrc).toContain('published: true');
  });

  test('el mapper canónico tiene la misma regla (drift guard)', () => {
    expect(mapperSrc).toContain('export function esPublicable');
    expect(mapperSrc).toContain('export function preflightRela');
    // Las dos copias (inline en la fn + _shared) usan el MISMO criterio.
    expect(fnSrc).toContain("return p.status === 'venta' || p.status === 'alquiler';");
    expect(mapperSrc).toContain("return p.status === 'venta' || p.status === 'alquiler';");
  });

  test('la RPC separa bloqueados de no publicables', () => {
    expect(migSrc).toContain('CREATE OR REPLACE FUNCTION public.rela_portal_status()');
    expect(migSrc).toContain('not_publishable');
    expect(migSrc).toContain("p.status IN ('venta', 'alquiler')");
    // Idempotente y sin permisos cambiados.
    expect(migSrc).not.toMatch(/DELETE\s+FROM/i);
    expect(migSrc).not.toMatch(/DROP\s+FUNCTION/i);
    expect(migSrc).toContain('GRANT EXECUTE ON FUNCTION public.rela_portal_status() TO authenticated;');
  });

  test('el panel tiene el botón "Validar todos" y muestra el reporte', () => {
    expect(portalesSrc).toContain('data-action="relaPreflight"');
    expect(portalesSrc).toContain('window.adminApp.relaPreflight');
    expect(portalesSrc).toContain("relaApiCall('preflight')");
    // Muestra el desglose y las zonas pendientes.
    expect(portalesSrc).toContain('zonas_sin_mapeo');
    expect(portalesSrc).toContain('listos');
    expect(portalesSrc).toContain('bloqueados');
    // Y el tile de propiedades vendidas (fuera de cola).
    expect(portalesSrc).toContain('not_publishable');
  });
});
