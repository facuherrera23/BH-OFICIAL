// Lote 4 (ML) — guards estáticos de los fixes de publicación del 2026-11-01.
// 3 bugs reales del ciclo Publicar/Actualizar/Quitar del tab Propiedades:
//  - Quitar un item sin activar: el DELETE terminaba 405 method_not_allowed y
//    el panel recibía un 500 con el JSON crudo de ML que hasta mentía 'closed'
//    (removal de FH-P0023 TEST en el E2E del 31/10: respuesta ilegible).
//    Ahora closeMlItem consulta el estado real a ML y el remove path responde
//    409 accionable registrándolo en ml_listings + property_ml_meta.
//  - Errores de validación de ML (400) mezclaban causas fatales con warnings
//    benignos: desaparecían 300+ chars de ruido en un toast truncado.
//    summarizeMlError extrae sólo las causas type error/invalid.
//  - upsertListing (update path) escribía property_ml_meta mínima: status,
//    price y permalink dependían del eco ml-sync/webhook, que puede no llegar
//    jamás en silencio (7 zombies del caso DA-P0008, 2026-10-24).
// Tests ESTÁTICOS: leen los archivos, no tocan la BD ni llaman a ML.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const FUNCTIONS = path.join(__dirname, '..', 'supabase', 'functions');

test.describe('Lote 4 ML — quitar sin activar, errores legibles y meta completa', () => {
  const publishSrc = fs.readFileSync(path.join(FUNCTIONS, 'ml-publish', 'index.ts'), 'utf8');

  test('ml-publish: closeMlItem consulta el estado real y lanza el error codificado', () => {
    // GET best-effort del estado real (lección DA-P0008: el estado guardado
    // al crear/update vale solo hasta el próximo evento de ML).
    expect(publishSrc).toContain(
      'async function fetchItemStatus(accessToken: string, itemId: string): Promise<string>',
    );
    // El DELETE fallido (no 404) termina en el error codificado que lee el
    // remove path, no en un throw de texto crudo.
    expect(publishSrc).toContain('close_blocked_unactivated:${realStatus}:${friendly}');
    // Item inexistente (404) conserva el status en el mensaje para que el
    // remove path haga el clean-close de siempre (regex 404/not found).
    expect(publishSrc).toContain(
      "summarizeMlError('ML deleteItem failed', delRes.status, delText)",
    );
  });

  test('ml-publish: el remove path responde 409 legible y registra el estado real', () => {
    expect(publishSrc).toContain("msg.startsWith('close_blocked_unactivated:')");
    expect(publishSrc).toContain("code: 'ML_ITEM_NOT_ACTIVATED',");
    expect(publishSrc).toContain('return respond(409, {');
    expect(publishSrc).toContain('error: friendly,');
    // El estado real queda en las dos tablas (misma historia, caso DA-P0001).
    expect(publishSrc).toContain(
      "metadata: { event: 'publish_close_blocked', ml_status: realStatus },",
    );
    // El clean-close por item inexistente sigue vivo (no se confundieron caminos).
    expect(publishSrc).toContain('if (!/404|not found/i.test(msg)) throw err;');
  });

  test('ml-publish: los errores de ML llegan como causas fatales, no JSON crudo', () => {
    expect(publishSrc).toContain(
      'function summarizeMlError(prefix: string, status: number, text: string): string',
    );
    // Usado en TODOS los throws HTTP del archivo.
    expect(publishSrc).toContain("summarizeMlError('ML createItem failed', res.status, text)");
    expect(publishSrc).toContain("summarizeMlError('ML updateItem failed', res.status, text)");
    expect(publishSrc).toContain(
      "summarizeMlError('ML setDescription failed', res.status, text)",
    );
    expect(publishSrc).toContain("summarizeMlError('ML closeItem failed', putRes.status, putText)");
    expect(publishSrc).not.toContain('slice(0, 300)');
    // Fatales por type (error/invalid mata la operación) unidas con "; ".
    expect(publishSrc).toContain("c.type === 'error' || c.type === 'invalid'");
    expect(publishSrc).toContain("fatal.join('; ')");
  });

  test('ml-publish: upsertListing escribe property_ml_meta completa en el update path', () => {
    // Ya no queda la meta mínima que dependía del eco de ml-sync/webhook.
    expect(publishSrc).toContain('permalink: args.permalink,');
    expect(publishSrc).toContain('price: args.price,');
    expect(publishSrc).toContain("last_sync_status: 'success',");
    expect(publishSrc).toContain("{ onConflict: 'property_id' },");
    // La meta mínima vieja (solo propiedad+item+updated_at) no puede volver:
    // el upsert lleva también status del item.
    expect(publishSrc).toContain('\n            status: args.mlStatus,');
  });
});
