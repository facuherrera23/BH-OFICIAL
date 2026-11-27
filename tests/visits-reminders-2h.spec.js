// RECORDATORIO 2H DE VISITA (2026-11-26).
//
// El bug medido: la ventana 2h existía SOLO en una edge function huérfana
// (supabase/functions/visits-reminders, con 0 llamadores: el cron
// visits-reminders llama a visits-process-reminders) → reminder_2h_sent_at
// era 0 en las 8 visitas de producción. Sólo salía el email de 24h y además
// SOLO si el visitante dejó email.
//
// Ahora processReminders() (el que corre cada 15 min) maneja las DOS ventanas:
//   24h → email al cliente con link de confirmación (igual que antes).
//   2h  → email al cliente; y si NO dejó email pero sí teléfono, aviso al
//         AGENTE con el WhatsApp pre-cargado (wa.me, normalización AR igual
//         a la del CRM) — el puente para que la visita no se caiga.
// La función huérfana se eliminó del repo (su lógica vive en _shared/visits.ts).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const shared = read('supabase/functions/_shared/visits.ts');
const runner = read('supabase/functions/visits-process-reminders/index.ts');

test.describe('Recordatorio 2h de visita', () => {
  test('processReminders maneja las DOS ventanas con sus flags', () => {
    for (const flag of ['reminder_24h_sent_at', 'reminder_2h_sent_at']) {
      expect(shared).toContain("'" + flag + "'");
    }
    // Dos ventanas con los horizontes correctos (24h y 2h).
    expect(shared).toContain("new Date(now + 24 * 60 * 60 * 1000).toISOString()");
    expect(shared).toContain("new Date(now + 2 * 60 * 60 * 1000).toISOString()");
    // Sólo visitas vivas y futuras.
    expect(shared).toContain(".in('status', ['pendiente', 'confirmada'])");
    expect(shared).toContain(".is('deleted_at', null)");
    // La marca es INMEDIATA por envío (no batch al final).
    expect(shared).toMatch(/if \(await mark\(visit\.id\)\) sent\+\+; else failed\+\+;/);
    // El resultado incluye los 2h (el cron lo devuelve y queda visible en logs).
    expect(shared).toContain('sent2h: r2.sent');
    expect(shared).toMatch(/export interface RemindersResult \{[\s\S]*?sent2h: number;/);
  });

  test('2h sin email del cliente → aviso al AGENTE con WhatsApp pre-cargado', () => {
    expect(shared).toContain('buildReminder2hAgenteEmail(visit');
    expect(shared).toContain('wa.me/');
    // Normalización AR real (espejo de normalizeArPhone + waNumber del CRM):
    // sin esto el wa.me salía sin country code y el clic no abría el chat.
    expect(shared).toContain('function waDigitsAr(phone: string): string {');
    expect(shared).toContain("if (d.startsWith('549')) d = d.slice(3);");
    // Espejo EXACTO del CRM: el "15" de celulares y el largo válido.
    expect(shared).toContain("if (rest.startsWith('15')) rest = rest.slice(2);");
    expect(shared).toContain("if (d.length < 8 || d.length > 12) return '';");
    expect(shared).toContain("return '549' + d;");
    // El asunto del aviso al agente lo dice en claro.
    expect(shared).toContain('avisale a ');
    // El cliente sin email es EL MOTIVO del aviso al agente (explicitado).
    expect(shared).toContain('no dejó email');
  });

  test('visitas sin email ni teléfono se MARCAN (no reintentan infinito)', () => {
    expect(shared).toContain('// Nada que enviar (sin email y — en 2h — sin teléfono/agente): se');
    expect(shared).toMatch(/await mark\(visit\.id\);\s*\n\s*skipped\+\+;/);
  });

  test('la función huérfana fue eliminada y el runner sigue llamando al shared', () => {
    expect(fs.existsSync(path.join(ROOT, 'supabase', 'functions', 'visits-reminders')), 'la carpeta visits-reminders debe estar borrada del repo').toBe(false);
    // El cron sigue apuntando a visits-process-reminders (el mapa del guard
    // lo documenta: caller = cron visits-reminders).
    expect(read('tests/functions-deploy.spec.js')).toContain("{ fn: 'visits-process-reminders', caller: 'cron visits-reminders' }");
    // Y el runner es el que ejecuta processReminders (sin duplicar lógica).
    expect(runner).toContain("import { processReminders } from '../_shared/visits.ts';");
    expect(runner).toContain('await processReminders()');
    // Sin residuos de la lógica vieja duplicada en el shared.
    expect((shared.match(/const visitJobs/g) || []).length).toBe(0);
  });

  // ── Auditoría 2026-11-27 (producción): dos defectos reales del camino 2h ──
  test('la ventana 24h NO toma las visitas que ya entran en la ventana 2h', () => {
    // Sin este filtro, una visita agendada para dentro de 2h recibía DOS
    // emails contradictorios ("tu visita de mañana" + "es en ~2 horas").
    expect(shared).toContain('const cutoff2h = now + 2 * 60 * 60 * 1000;');
    expect(shared).toContain("kind === '24h'");
    expect(shared).toContain('new Date(v.visit_date).getTime() > cutoff2h');
    // Y el email de 24h ya no afirma "mañana" (puede ser HOY).
    expect(shared).not.toContain('tu visita de mañana');
    expect(shared).not.toContain('programada mañana');
    expect(shared).toContain('Recordatorio: tu visita programada en BIENENHAUS');
  });

  test('el email 2h al cliente conserva el link de confirmar/cancelar', () => {
    // La visita de última hora ya no recibe el email de 24h → el link de
    // confirmación tiene que estar también en el email de 2h.
    expect(shared).toContain('buildReminder2hEmail(visit, confirmUrl)');
    expect(shared).toContain("function buildReminder2hEmail(visit: any, confirmUrl?: string | null)");
    expect(shared).toContain('Confirmá desde este link: ');
    expect(shared).toContain('confirmar-visita.html?token=');
  });

  test('behavioral: waDigitsAr es espejo EXACTO del normalizeArPhone del CRM', () => {
    const from = shared.indexOf('function waDigitsAr(');
    expect(from).toBeGreaterThan(-1);
    // Se evalúa el código REAL (con las anotaciones de tipos removidas).
    const src = shared
      .slice(from)
      .replace('function waDigitsAr(phone: string): string {', 'function waDigitsAr(phone) {')
      .replace('function buildReminder2hEmail(visit: any, confirmUrl?: string | null): { html: string; text: string } {', 'function buildReminder2hEmail(visit, confirmUrl) {')
      .replace('function buildReminder2hAgenteEmail(visit: any, agenteNombre: string): { html: string; text: string } {', 'function buildReminder2hAgenteEmail(visit, agenteNombre) {')
      .replace('const AR_MOBILE_AREAS: Record<string, number> =', 'const AR_MOBILE_AREAS =');
    const sandbox = { fmtDateTimeAR: (iso) => 'fecha ' + iso };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);

    // Mismos casos que el CRM (assets/js/admin-crm.js → normalizeArPhone).
    expect(sandbox.waDigitsAr('3513 96-5289')).toBe('5493513965289');
    expect(sandbox.waDigitsAr('5493513965289')).toBe('5493513965289');
    expect(sandbox.waDigitsAr('54 9 3513-96-5289')).toBe('5493513965289');
    expect(sandbox.waDigitsAr('0 3513 96 5289')).toBe('5493513965289');
    expect(sandbox.waDigitsAr('9 3513 96 5289')).toBe('5493513965289');
    // El marcador móvil doméstico "15": sin esto el wa.me apuntaba mal.
    expect(sandbox.waDigitsAr('15 3513-96-5289')).toBe('5493513965289');
    expect(sandbox.waDigitsAr('11 15 3513-96-5289')).toBe('549113513965289');
    // Teléfono incompleto → SIN link (espejo del null del CRM).
    expect(sandbox.waDigitsAr('3516')).toBe('');
    expect(sandbox.waDigitsAr('')).toBe('');
  });

  test('behavioral: el email del agente lleva el wa.me y el del cliente el link', () => {
    const from = shared.indexOf('function waDigitsAr(');
    const src = shared
      .slice(from)
      .replace('function waDigitsAr(phone: string): string {', 'function waDigitsAr(phone) {')
      .replace('function buildReminder2hEmail(visit: any, confirmUrl?: string | null): { html: string; text: string } {', 'function buildReminder2hEmail(visit, confirmUrl) {')
      .replace('function buildReminder2hAgenteEmail(visit: any, agenteNombre: string): { html: string; text: string } {', 'function buildReminder2hAgenteEmail(visit, agenteNombre) {')
      .replace('const AR_MOBILE_AREAS: Record<string, number> =', 'const AR_MOBILE_AREAS =');
    const sandbox = { fmtDateTimeAR: (iso) => 'fecha ' + iso };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);

    const visita = {
      client_name: 'Olga Ponssa',
      client_phone: '15 3513-96-5289',
      visit_date: '2026-11-27T15:00:00Z',
      property: { title: 'Casa en Villa Azalay', property_code: 'DA-P0001' },
    };

    // Al cliente: el link de confirmar aparece y el texto NO dice "mañana".
    const cliente = sandbox.buildReminder2hEmail(visita, 'https://bienenhaus.com.ar/confirmar-visita.html?token=tok-1');
    expect(cliente.html).toContain('confirmar-visita.html?token=tok-1');
    expect(cliente.text).toContain('Confirmá desde este link:');
    expect(cliente.html).not.toContain('mañana');

    // Al agente: wa.me con el número ya normalizado y el mensaje pre-cargado.
    const agente = sandbox.buildReminder2hAgenteEmail(visita, 'Danilo Arbo');
    expect(agente.html).toContain('https://wa.me/5493513965289');
    expect(agente.html).toContain('Enviar WhatsApp pre-cargado');
    expect(agente.text).toContain('wa.me/5493513965289');
    expect(agente.html).toContain('no dejó email');
  });
});
