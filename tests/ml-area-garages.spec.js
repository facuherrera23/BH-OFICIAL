// Lote 2 (ML) — guards estáticos de la unificación surface_*/area_*/garages.
// 2026-11-01: ml-publish y ml-sync leían SÓLO los campos legacy area_*/garages
// (que rellenan los import de ML) e ignoraban surface_*/garage_spaces (los
// campos vivos que edita el form del panel). Efectos reales en producción:
//  - items de ML con literal "1 m²" cuando no había ninguna superficie,
//  - PARKING_LOTS siempre "0" (garages 0/45 lleno vs garage_spaces 45/45),
//  - superficie ausente en ~22 propiedades del publish de la cola,
//  - el dato fresco del panel pisado por el legacy del import.
//
// decisión de alcance del dueño: NO se agrega `attributes` al update de la
// cola ml_sync_queue (94k jobs) — sólo la LECTURA se unifica. Si ese cambio
// se aprueba algún día, este archivo se actualiza en el mismo commit.
//
// Tests ESTÁTICOS: leen los archivos, no tocan la BD ni llaman a ML.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const FUNCTIONS = path.join(__dirname, '..', 'supabase', 'functions');

test.describe('Lote 2 ML — unificación de lecturas surface_*/area_*/garages', () => {
  const publishSrc = fs.readFileSync(path.join(FUNCTIONS, 'ml-publish', 'index.ts'), 'utf8');
  const syncSrc = fs.readFileSync(path.join(FUNCTIONS, 'ml-sync', 'index.ts'), 'utf8');

  test('ml-sync: el SELECT trae surface_*/garage_spaces y fetchProperty unifica con fallback', () => {
    // Columnas vivas en el SELECT (antes no estaban: el fix era invisible).
    expect(syncSrc).toContain('area_total, area_covered, surface_total, surface_covered,');
    expect(syncSrc).toContain('garages, garage_spaces,');
    // Prioridad surface_* (dato del panel) con fallback al legacy del import.
    expect(syncSrc).toContain('area_total: data.surface_total ?? data.area_total ?? null');
    expect(syncSrc).toContain('area_covered: data.surface_covered ?? data.area_covered ?? null');
    expect(syncSrc).toContain('garages: data.garages ?? data.garage_spaces ?? null');
    // Los guards del publish leen el valor unificado (no cambian: el fallback
    // ocurre aguas arriba en fetchProperty).
    expect(syncSrc).toContain("if (property.area_covered !== null)");
    expect(syncSrc).toContain("if (property.area_total !== null)");
    expect(syncSrc).toContain('if (property.garages !== null && property.garages > 0)');
  });

  test('ml-publish: surface_* gana al legacy y las cocheras leen garage_spaces', () => {
    // Prioridad surface_* (antes era area_* primero: el import pisaba el panel).
    expect(publishSrc).toContain('area_total: property.surface_total ?? property.area_total ?? null');
    expect(publishSrc).toContain('area_covered: property.surface_covered ?? property.area_covered ?? null');
    expect(publishSrc).not.toContain('property.area_total ?? property.surface_total');
    expect(publishSrc).not.toContain('property.area_covered ?? property.surface_covered');
    // Cocheras: garages (legacy) con fallback a garage_spaces (vivos).
    expect(publishSrc).toContain('garages: property.garages ?? property.garage_spaces ?? null');
    // La línea vieja sin fallback no puede volver.
    expect(publishSrc).not.toContain('garages: property.garages,\n');
  });

  test('ml-publish: se acabaron los datos ficticios ("1 m²" y cocheras "0")', () => {
    // El default ficticio de area: `${... ?? 1} m²` — jamás debe volver.
    expect(publishSrc).not.toContain('?? 1} m²');
    // PARKING_LOTS con el legacy `garages ?? 0` — jamás debe volver.
    expect(publishSrc).not.toContain('property.garages ?? 0');
    // Emisión condicional tipo ml-sync: se omite el atributo sin dato real.
    expect(publishSrc).toContain('if (coveredArea !== null)');
    expect(publishSrc).toContain('if (totalArea !== null)');
    expect(publishSrc).toContain("if (property.garages !== null)");
    expect(publishSrc).toContain("attributes.push({ id: 'PARKING_LOTS',");
  });

  test('ml-publish: los atributos obligatorios (ROOMS/BEDROOMS/FULL_BATHROOMS) siguen siempre presentes', () => {
    expect(publishSrc).toContain("{ id: 'ROOMS', value_name: String(property.rooms ?? property.bedrooms ?? 1) }");
    expect(publishSrc).toContain("{ id: 'BEDROOMS', value_name: String(property.bedrooms ?? 1) }");
    expect(publishSrc).toContain("{ id: 'FULL_BATHROOMS', value_name: String(fullBathrooms) }");
  });

  test('ml-publish: el camino manual del tab Propiedades sigue al mismo endpoint', () => {
    // admin-portales.js mapea publish/update/remove -> ml-publish directo.
    const portalesSrc = fs.readFileSync(
      path.join(__dirname, '..', 'assets', 'js', 'admin-portales.js'),
      'utf8',
    );
    expect(portalesSrc).toContain("'publish': 'ml-publish'");
    expect(portalesSrc).toContain("'update': 'ml-publish'");
    // ml-publish exige body.action (create | update | remove).
    expect(portalesSrc).toContain("action === 'publish' ? 'create' : action");
  });
});
