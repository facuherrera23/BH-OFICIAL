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
    expect(shared).toContain("return d ? '549' + d : '';");
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
});
