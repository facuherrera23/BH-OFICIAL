// Tests unitarios del mapper RELA (módulo puro, sin I/O).
// Corre con: node --test tests/unit/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateForRela,
  mapPropertyToRela,
  hashPayload,
  makeCodigoAviso,
} from '../../supabase/functions/_shared/rela.mapper.ts';

const baseProperty = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  property_code: 'BH-1042',
  title: 'Departamento 3 ambientes en Palermo',
  description: 'Departamento amplio y luminoso con balcón al frente, cocina independiente y dos dormitorios con placard.',
  property_type: 'departamento',
  status: 'venta',
  zone: 'Palermo Chico',
  address: 'Av. Libertador 1200',
  price_usd: 250000,
  price_currency: 'USD',
  area_m2: 85,
  surface_covered: 80,
  surface_total: 90,
  rooms: 3,
  bedrooms: 2,
  bathrooms: 1,
  garage_spaces: 1,
  year_built: 2005,
  image_urls: ['https://res.cloudinary.com/bh/img1.jpg', 'https://res.cloudinary.com/bh/img2.jpg'],
  video_url: null,
};

const validConfig = {
  codigoInmobiliaria: 'BH-INMO-001',
  plan: 'SIMPLE',
  contactoNombre: 'Agente BH',
  contactoEmail: 'agente@bienenhaus.com.ar',
  contactoTelefono: '+541112345678',
  catalogMapping: {
    SUPERFICIE_TOTAL: 'T1', SUPERFICIE_CUBIERTA: 'T2', AMBIENTES: 'T3',
    DORMITORIOS: 'T4', BANOS: 'T5', GARAGE: 'T6',
  },
  tipoPropiedadMap: { departamento: { idTipo: '2', idSubTipo: '3' }, casa: { idTipo: '1' } },
  ubicacionMap: { 'palermo chico': 'V1-C-9999' },
};

test('validateForRela: propiedad completa no produce errores', () => {
  assert.deepEqual(validateForRela(baseProperty, validConfig), []);
});

test('validateForRela: descripción corta produce error útil en español', () => {
  const errs = validateForRela({ ...baseProperty, description: 'Corta' }, validConfig);
  assert.ok(errs.some((e) => e.includes('descripción')), 'debe mencionar la descripción');
});

test('validateForRela: sin mapeo de tipo de propiedad → error', () => {
  const errs = validateForRela({ ...baseProperty, property_type: 'quinta' }, validConfig);
  assert.ok(errs.some((e) => e.includes('quinta')));
});

test('validateForRela: zona sin mapeo → error con la zona mencionada', () => {
  const errs = validateForRela({ ...baseProperty, zone: 'Recoleta' }, validConfig);
  assert.ok(errs.some((e) => e.includes('Recoleta')));
});

test('validateForRela: precio 0 es error (WARN-0210)', () => {
  const errs = validateForRela({ ...baseProperty, price_usd: 0 }, validConfig);
  assert.ok(errs.some((e) => e.includes('precio')));
});

test('validateForRela: propiedad vendida no se puede publicar', () => {
  const errs = validateForRela({ ...baseProperty, status: 'vendido' }, validConfig);
  assert.ok(errs.some((e) => e.includes('vendido')));
});

test('validateForRela: sin fotos http → error', () => {
  const errs = validateForRela({ ...baseProperty, image_urls: [] }, validConfig);
  assert.ok(errs.some((e) => e.includes('fotos')));
});

test('mapPropertyToRela: payload completo y estructurado', () => {
  const payload = mapPropertyToRela(baseProperty, validConfig);
  assert.equal(payload.codigoAviso, 'BH-1042');
  assert.equal(payload.publicador.codigoInmobiliaria, 'BH-INMO-001');
  assert.equal(payload.publicacion.tipoDePublicacion, 'SIMPLE');
  assert.equal(payload.tipoDePropiedad.idTipo, '2');
  assert.equal(payload.tipoDePropiedad.idSubTipo, '3');
  assert.equal(payload.localizacion.idUbicacion, 'V1-C-9999');
  assert.equal(payload.precios.length, 1);
  assert.equal(payload.precios[0].operacion, 'VENTA');
  assert.equal(payload.precios[0].monto, '250000');
  assert.equal(payload.precios[0].moneda, 'USD');
  assert.equal(payload.multimedia.imagenes.length, 2);
  const byId = Object.fromEntries(payload.caracteristicas.map((c) => [c.id, c.valor]));
  assert.equal(byId['T1'], '90');  // superficie total
  assert.equal(byId['T2'], '80');  // cubierta
  assert.equal(byId['T3'], '3');   // ambientes
  assert.equal(byId['T4'], '2');   // dormitorios
  assert.equal(byId['T5'], '1');   // baños
  assert.equal(byId['T6'], '1');   // garage
});

test('mapPropertyToRela: superficie total cae a cubierta si falta (WARN-0215)', () => {
  const payload = mapPropertyToRela({ ...baseProperty, surface_total: null }, validConfig);
  const byId = Object.fromEntries(payload.caracteristicas.map((c) => [c.id, c.valor]));
  assert.equal(byId['T1'], '80');
});

test('mapPropertyToRela: alquiler mapea operación ALQUILER', () => {
  const payload = mapPropertyToRela({ ...baseProperty, status: 'alquiler' }, validConfig);
  assert.equal(payload.precios[0].operacion, 'ALQUILER');
});

test('mapPropertyToRela: más de 50 fotos se truncan a 50 (WARN-0211)', () => {
  const many = Array.from({ length: 60 }, (_, i) => `https://cdn.bh/i${i}.jpg`);
  const payload = mapPropertyToRela({ ...baseProperty, image_urls: many }, validConfig);
  assert.equal(payload.multimedia.imagenes.length, 50);
});

test('mapPropertyToRela: título largo se trunca a 80 chars', () => {
  const payload = mapPropertyToRela({ ...baseProperty, title: 'X'.repeat(120) }, validConfig);
  assert.equal(payload.titulo.length, 80);
});

test('mapPropertyToRela: urls no-http de fotos se descartan', () => {
  const payload = mapPropertyToRela({ ...baseProperty, image_urls: ['ftp://x/a.jpg', 'javascript:alert(1)', 'https://ok/img.jpg'] }, validConfig);
  assert.equal(payload.multimedia.imagenes.length, 1);
  assert.equal(payload.multimedia.imagenes[0].urlImagenOriginal, 'https://ok/img.jpg');
});

test('makeCodigoAviso: usa property_code, limita a 60, sin espacios', () => {
  assert.equal(makeCodigoAviso(baseProperty), 'BH-1042');
  assert.equal(makeCodigoAviso({ ...baseProperty, property_code: 'CODIGO CON ESPACIOS' }), 'CODIGO-CON-ESPACIOS');
  assert.equal(makeCodigoAviso({ ...baseProperty, property_code: 'X'.repeat(100) }).length, 60);
});

test('hashPayload: determinista e independiente del orden de claves', () => {
  const a = { b: 1, a: [1, 2], c: { z: 1, y: 2 } };
  const b = { c: { y: 2, z: 1 }, a: [1, 2], b: 1 };
  assert.equal(hashPayload(a), hashPayload(b));
  assert.notEqual(hashPayload(a), hashPayload({ ...a, b: 2 }));
});
