// Contrato código ↔ enum `lead_stage` (2026-11-08).
// Guards ESTÁTICOS. No tocan la BD ni la red.
//
// POR QUÉ: `lead_stage` es un ENUM de Postgres. Un filtro PostgREST con
// labels que no existen (.not('stage','in',...)) EXPLOTA en runtime con
// 22P02 "invalid input value for enum" y la llamada devuelve data:null —
// la consolidación de leads de ML llevaba ROTA desde su nacimiento por esto
// (constante con "cerrado_vendido"/"vendido"/"descartado", labels que nunca
// existieron; nadie lo vio porque el resto del flow seguía andando).
// Verificado empíricamente contra producción 2026-11-08.
//
// Labels REALES del enum (enum_range(lead_stage), verificado 2026-11-08):
//   nuevo, contactado, calificado, visita_agendada, visita_realizada,
//   negociacion, cerrado_ganado, cerrado_perdido
// Terminales: solo cerrado_ganado y cerrado_perdido.
// ⚠️ Si una migración futura agrega o cambia labels: actualizar ESTA lista y
//    también el enum en la DB.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LABELS_REALES = new Set([
  'nuevo', 'contactado', 'calificado', 'visita_agendada',
  'visita_realizada', 'negociacion', 'cerrado_ganado', 'cerrado_perdido',
]);
const TERMINALES = ['cerrado_ganado', 'cerrado_perdido'];

// Los archivos que consolidan leads con exclusión de stages terminales.
const ARCHIVOS = [
  'supabase/functions/ml-webhook/index.ts',      // ML_TERMINAL_STAGES_EXCL
  'supabase/functions/rela-callbacks/index.ts',  // RELA_TERMINAL_STAGES_EXCL
];

function labelsDeConstante(src, nombreConstante) {
  const re = new RegExp(`${nombreConstante}\\s*=\\s*'\\(([^)]*)\\)'`);
  const m = src.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

test.describe('enum lead_stage — labels usados por el código existen en la DB', () => {
  for (const archivo of ARCHIVOS) {
    const modulo = path.basename(path.dirname(archivo));

    test(`${modulo}: su _STAGES_EXCL sólo usa labels reales del enum`, () => {
      const src = fs.readFileSync(path.join(ROOT, archivo), 'utf8');
      const nombre = src.match(/const (\w+_STAGES_EXCL)\s*=/);
      expect(nombre, 'el archivo debe definir una constante *_STAGES_EXCL').toBeTruthy();
      const labels = labelsDeConstante(src, nombre[1]);
      expect(labels, `no se pudo parsear ${nombre[1]}`).not.toBeNull();
      const inventados = labels.filter((l) => !LABELS_REALES.has(l));
      // El bug caro: cada label inventado explota el filtro COMPLETO con 22P02
      // y la consolidación muere en silencio (data null, error nunca leído).
      expect(inventados, `labels de ${nombre[1]} que NO existen en lead_stage`).toEqual([]);
      for (const t of TERMINALES) {
        expect(labels, `${nombre[1]} debe excluir el stage terminal ${t}`).toContain(t);
      }
    });

    test(`${modulo}: la consolidación de leads NO ignora el error de la query`, () => {
      const src = fs.readFileSync(path.join(ROOT, archivo), 'utf8');
      const ini = src.indexOf('function findConsolidable');
      expect(ini, 'debe existir findConsolidable*Lead').toBeGreaterThan(-1);
      const fin = src.indexOf('}', src.indexOf('return data ?? null', ini));
      const bloque = src.slice(ini, fin + 1);
      expect(bloque, 'la query de consolidación debe destruturar { data, error }')
        .toMatch(/const \{ data, error \} = await supabase/);
      expect(bloque, 'debe registrar el error (console.error) antes de devolver null')
        .toMatch(/if \(error\)/);
    });
  }
});
