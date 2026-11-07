// Tests unitarios del mapper de Clasificados La Voz (módulo puro, sin I/O).
// Corre con: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLavozPayload,
  buildLavozFicha,
  resizeFoto,
  norm,
  numPos,
  parseManzanaLote,
  OPERACION_BOTON,
  MAX_FOTOS,
  type LavozConfig,
} from '../../supabase/functions/_shared/lavoz.mapper.ts';

/* Mapeos reales medidos contra el portal (2026-11-04). */
const cfg: LavozConfig = {
  dias_publicacion: 30,
  tipo_map: {
    departamento: { subrubro: 'departamentos', label: 'Departamentos' },
    casa: { subrubro: 'casas', label: 'Casas' },
    terreno: { subrubro: 'terrenos-y-lotes', label: 'Terrenos y Lotes' },
  },
  ubicacion_map: {
    'nueva cordoba': { ciudad: 'cordoba', barrio: 'nueva-cordoba', label: 'Nueva Córdoba' },
    centro: { ciudad: 'cordoba', barrio: 'centro', label: 'Centro' },
    'villa carlos paz': { ciudad: 'villa-carlos-paz', barrio: null, label: 'Villa Carlos Paz' },
  },
  contacto: { email: 'bienenhaus.propiedades@gmail.com' },
};

const foto = (n: number) =>
  `https://res.cloudinary.com/jpyigjrh/image/upload/f_auto,q_auto/v179190456${n}/bienenhaus/properties/foto${n}.jpg`;

const baseProperty = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  property_code: 'DA-P0018',
  title: 'Casa con dos dormitorios y patio',
  description: 'CasaLuminosa con cocina independiente, patio y garage.',
  property_type: 'casa',
  listing_type: 'venta',
  zone: 'Nueva Cordoba',
  locality: 'Córdoba',
  address: 'Av.richedieu 1234',
  price_usd: '115000.00',
  price_currency: 'USD',
  area_m2: '259.00',
  surface_covered: '259.00',
  surface_total: '299.00',
  rooms: 4,
  bedrooms: 2,
  bathrooms: 1,
  garage_spaces: 1,
  year_built: 1995,
  maintenance_fee: null,
  image_urls: [foto(1), foto(2), foto(3)],
  video_url: null,
};

test('buildLavozPayload: la PORTADA (primera foto) va primero y reescalada', () => {
  const p = buildLavozPayload(baseProperty, cfg);
  assert.equal(p.fotos.length, 3);
  // La primera foto es la del sistema (índice 0 de image_urls), reescalada.
  assert.match(p.fotos[0], /w_1200,h_900,c_limit,f_jpg,q_80/);
  assert.match(p.fotos[0], /foto1\.jpg$/);
  assert.match(p.fotos[1], /foto2\.jpg$/);
  assert.equal(p.fotos_count, 3);
});

test('buildLavozPayload: la zona se resuelve al barrio de La Voz', () => {
  const p = buildLavozPayload(baseProperty, cfg);
  assert.equal(p.barrio, 'nueva-cordoba');
  assert.equal(p.ciudad, 'cordoba');
  assert.equal(p.ciudad_label, 'Córdoba');
  assert.equal(p.barrio_label, 'Nueva Córdoba');
  assert.equal(p.sin_equivalencia, false);
  assert.equal(p.ubicacion_label, 'Nueva Córdoba, Córdoba');
});

test('buildLavozPayload: sin equivalencia de barrio avisa y deja la zona en el texto', () => {
  const p = buildLavozPayload({ ...baseProperty, zone: 'El Cedron' }, cfg);
  assert.equal(p.sin_equivalencia, true);
  assert.equal(p.barrio, null);
  assert.equal(p.barrio_label, 'El Cedron');
  assert.ok(p.avisos.some((a) => /no tiene barrio equivalente/.test(a)));
});

test('buildLavozPayload: si no hay barrio usa la ciudad mapeada', () => {
  const p = buildLavozPayload({ ...baseProperty, zone: '', locality: 'Villa Carlos Paz' }, cfg);
  assert.equal(p.ciudad, 'villa-carlos-paz');
  assert.equal(p.ciudad_label, 'Villa Carlos Paz');
  assert.equal(p.sin_equivalencia, false);
});

test('buildLavozPayload: precio y moneda', () => {
  const p = buildLavozPayload(baseProperty, cfg);
  assert.equal(p.precio, 115000);
  assert.equal(p.moneda, 'USD');
});

test('buildLavozPayload: el título lleva el barrio adelante si no lo menciona', () => {
  const p = buildLavozPayload(baseProperty, cfg);
  assert.equal(p.titulo, 'Nueva Córdoba — Casa con dos dormitorios y patio');
});

test('buildLavozPayload: si el título ya menciona el barrio no se duplica', () => {
  const p = buildLavozPayload({ ...baseProperty, title: 'Casa en Nueva Córdoba' }, cfg);
  assert.equal(p.titulo, 'Casa en Nueva Córdoba');
});

test('buildLavozPayload: más de 25 fotos se truncan a 25', () => {
  const muchas = Array.from({ length: 40 }, (_, i) => foto(i + 1));
  const p = buildLavozPayload({ ...baseProperty, image_urls: muchas }, cfg);
  assert.equal(p.fotos.length, MAX_FOTOS);
  assert.ok(p.avisos.some((a) => /40 fotos/.test(a) && /25/.test(a)));
});

test('buildLavozPayload: los avisos bloqueantes (operación, precio, subrubro)', () => {
  const sinOperacion = buildLavozPayload({ ...baseProperty, listing_type: null }, cfg);
  assert.ok(sinOperacion.avisos.some((a) => /Falta la operación/.test(a)));

  const sinPrecio = buildLavozPayload({ ...baseProperty, price_usd: null }, cfg);
  assert.ok(sinPrecio.avisos.some((a) => /Falta el precio/.test(a)));

  const tipoDesconocido = buildLavozPayload({ ...baseProperty, property_type: 'quinta' }, cfg);
  assert.ok(tipoDesconocido.avisos.some((a) => /no tiene subrubro mapeado/.test(a)));
  assert.equal(tipoDesconocido.subrubro, '');
});

test('buildLavozPayload: sin listing_type, la operación sale del estado comercial', () => {
  // 9 propiedades publicadas tienen listing_type NULL pero status = venta/alquiler.
  const venta = buildLavozPayload({ ...baseProperty, listing_type: null, status: 'venta' }, cfg);
  assert.equal(venta.operacion, 'venta');
  assert.equal(venta.operacion_label, 'Venta');
  assert.ok(!venta.avisos.some((a) => /Falta la operación/.test(a)));

  const alquiler = buildLavozPayload({ ...baseProperty, listing_type: null, status: 'alquiler' }, cfg);
  assert.equal(alquiler.operacion, 'alquiler');
  assert.equal(alquiler.operacion_label, 'Alquiler');
  assert.ok(!alquiler.avisos.some((a) => /Falta la operación/.test(a)));
});

test('buildLavozPayload: estados no publicables NO cuentan como operación', () => {
  for (const status of ['vendido', 'alquilado', 'pausado']) {
    const p = buildLavozPayload({ ...baseProperty, listing_type: null, status }, cfg);
    assert.equal(p.operacion, null, status);
    assert.ok(p.avisos.some((a) => /Falta la operación/.test(a)), status);
  }
});

test('buildLavozPayload: listing_type manda sobre el estado comercial', () => {
  const p = buildLavozPayload({ ...baseProperty, listing_type: 'alquiler', status: 'venta' }, cfg);
  assert.equal(p.operacion, 'alquiler');
  assert.equal(p.operacion_label, 'Alquiler');
});

test('buildLavozPayload: medidas numéricas (strings y ceros = no aplica)', () => {
  const p = buildLavozPayload(baseProperty, cfg);
  assert.equal(p.superficie_total, 299);
  assert.equal(p.superficie_cubierta, 259);
  assert.equal(p.bedrooms, 2);
  assert.equal(p.bathrooms, 1);
  assert.equal(p.cocheras, 1);
  assert.equal(p.antiguedad, 1995);

  // 0 = "no aplica" (terrenos/galpones) → null, no 0.
  const sinDormitorios = buildLavozPayload({ ...baseProperty, bedrooms: 0, rooms: 0 }, cfg);
  assert.equal(sinDormitorios.bedrooms, null);
});

test('buildLavozPayload: el contacto se agrega al final de la descripción', () => {
  const p = buildLavozPayload(baseProperty, cfg);
  assert.ok(/Consultas: bienenhaus\.propiedades@gmail\.com/.test(p.descripcion));

  const conWa = buildLavozPayload(baseProperty, {
    ...cfg,
    contacto: { whatsapp: '3511111111', mostrar_whatsapp: true, email: 'a@b.com' },
  });
  assert.ok(/Consultas: WhatsApp 3511111111/.test(conWa.descripcion));
});

test('buildLavozPayload: sin descripción arma una mínima y avisa', () => {
  const p = buildLavozPayload({ ...baseProperty, description: '' }, cfg);
  assert.ok(p.descripcion.length > 0);
  assert.ok(p.avisos.some((a) => /no tiene descripción/.test(a)));
});

test('buildLavozFicha: texto listo para copiar y pegar', () => {
  const p = buildLavozPayload(baseProperty, cfg);
  const ficha = buildLavozFicha(p);
  assert.ok(ficha.includes('PUBLICACIÓN · CLASIFICADOS LA VOZ'));
  assert.ok(ficha.includes('Propiedad interna: DA-P0018'));
  assert.ok(ficha.includes('Nueva Córdoba — Casa con dos dormitorios y patio'));
  assert.ok(ficha.includes('Fotos a subir: 3 (la primera es la PORTADA)'));
  assert.ok(ficha.includes('https://bienenhaus.com.ar/fichas/DA-P0018.html'));
  assert.ok(ficha.includes('--- DESCRIPCIÓN (copiar) ---'));
  assert.ok(ficha.includes(p.descripcion));
});

test('resizeFoto: fuerza JPG y saca f_auto/q_auto', () => {
  const out = resizeFoto('https://res.cloudinary.com/jpyigjrh/image/upload/f_auto,q_auto/v1791904563/x.jpg');
  assert.ok(out.includes('f_jpg'));
  assert.ok(out.includes('q_80'));
  assert.ok(!out.includes('f_auto'));
  assert.ok(!out.includes('q_auto'));
  assert.ok(!out.includes(',,'));
});

test('resizeFoto: URLs que no son de Cloudinary no se tocan', () => {
  const url = 'https://example.com/foto.jpg';
  assert.equal(resizeFoto(url), url);
});

test('norm y numPos: helpers de normalización', () => {
  assert.equal(norm('  Nueva   CÓRDOBA '), 'nueva cordoba');
  assert.equal(numPos('259.00'), 259);
  assert.equal(numPos(0), null);
  assert.equal(numPos(''), null);
});

test('OPERACION_BOTON: el texto EXACTO del botón de operación del portal', () => {
  // El formulario real usa botones, no <select>: "Alquileres" (plural).
  assert.equal(OPERACION_BOTON.venta, 'Venta');
  assert.equal(OPERACION_BOTON.alquiler, 'Alquileres');
  assert.equal(OPERACION_BOTON.alquileres_temporarios, 'Alquileres Temporarios');
  assert.equal(OPERACION_BOTON.compra, 'Compra');
  const p = buildLavozPayload({ ...baseProperty, listing_type: 'alquiler' }, cfg);
  assert.equal(p.operacion_boton, 'Alquileres');
});

test('parseManzanaLote: saca manzana y lote de la dirección', () => {
  assert.deepEqual(parseManzanaLote('Manzana 53 Lote 6'), { manzana: '53', lote: '6' });
  assert.deepEqual(parseManzanaLote('manzana 12, lote 4'), { manzana: '12', lote: '4' });
  assert.deepEqual(parseManzanaLote('Manzana N° 7'), { manzana: '7', lote: null });
  assert.deepEqual(parseManzanaLote('Ocaña 319'), { manzana: null, lote: null });
  assert.deepEqual(parseManzanaLote(null), { manzana: null, lote: null });
});

test('buildLavozPayload: la manzana y el lote van al payload (los pide La Voz)', () => {
  const p = buildLavozPayload(
    { ...baseProperty, property_type: 'terreno', address: 'Manzana 53 Lote 6' },
    cfg,
  );
  assert.equal(p.num_manzana, '53');
  assert.equal(p.num_lote, '6');
});
