// Tests unitarios del mapeo del formulario de La Voz (scripts/lavoz-mapping.mjs).
// Corre con: npm run test:unit
//
// El formulario real de La Voz se descubrió con el navegador (login humano),
// pero el mapeo se mantiene por PALABRAS CLAVE porque el wizard cambia
// (labels, ids y pasos). Estos tests fijan ese contrato.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPOS,
  DEFAULTS,
  OPCIONES,
  RE_PUBLICAR,
  RE_SIGUIENTE,
  elegirControl,
  esTextoTerminos,
  idControl,
  indiceOpcion,
  normalizar,
  planDefaults,
  planLlenado,
  textoDeControl,
  tieneBloqueante,
} from '../../scripts/lavoz-mapping.mjs';

/* Forma de los controles (la misma que devuelve el script en runtime). */
const controls = [
  { tag: 'input', type: 'text', id: 'titulo', name: 'titulo', label: 'Título del aviso', placeholder: 'Ej: casa en el centro', visible: true },
  { tag: 'textarea', type: '', id: 'descripcion', name: 'descripcion', label: 'Descripción', placeholder: 'Contá de la propiedad', visible: true },
  { tag: 'select', type: 'select-one', id: 'tipo_inmueble', name: 'tipo', label: 'Tipo de inmueble', visible: true,
    options: [{ value: '1', text: 'Casas' }, { value: '2', text: 'Departamentos' }, { value: '3', text: 'Terrenos y Lotes' }] },
  { tag: 'select', type: 'select-one', id: 'operacion', name: 'operacion', label: 'Operación', visible: true,
    options: [{ value: 'v', text: 'Venta' }, { value: 'a', text: 'Alquiler' }] },
  { tag: 'select', type: 'select-one', id: 'ciudad', name: 'ciudad', label: 'Ciudad', visible: true,
    options: [{ value: 'co', text: 'Córdoba' }, { value: 'vcp', text: 'Villa Carlos Paz' }] },
  { tag: 'select', type: 'select-one', id: 'barrio', name: 'barrio', label: 'Barrio / Zona', visible: true,
    options: [{ value: 'ob', text: 'Obrero' }] },
  { tag: 'input', type: 'text', id: 'precio', name: 'precio', label: 'Precio', visible: true },
  { tag: 'input', type: 'text', id: 'superficie', name: 'superficie', label: 'Superficie total (m²)', visible: true },
  { tag: 'input', type: 'number', id: 'dormitorios', name: 'dormitorios', label: 'Dormitorios', visible: true },
  { tag: 'input', type: 'number', id: 'banos', name: 'banos', label: 'Baños', visible: true },
  { tag: 'input', type: 'number', id: 'cocheras', name: 'cocheras', label: 'Cocheras', visible: true },
  { tag: 'input', type: 'file', id: 'fotos', name: 'fotos', label: 'Fotos', visible: true },
  // Un campo oculto (el wizard lo reutiliza en otro paso): NO debe elegido.
  { tag: 'input', type: 'text', id: 'precio_oculto', name: 'precio_oculto', label: 'Precio (oculto)', visible: false },
];

const payload = {
  titulo: 'Casa 4 Dormitorios en Obrero',
  descripcion: 'Casa luminosa con patio.',
  subrubro_label: 'Casas',
  operacion_label: 'Venta',
  ciudad_label: 'Córdoba',
  barrio_label: 'Obrero',
  precio: 115000,
  superficie_total: 299,
  superficie_cubierta: 259,
  bedrooms: 4,
  bathrooms: null,
  cocheras: 1,
  antiguedad: null,
  expensas: null,
  num_manzana: '53',
  num_lote: '6',
};

test('normalizar: minúsculas, sin tildes, espacios colapsados', () => {
  assert.equal(normalizar('  Título   del AVISO '), 'titulo del aviso');
  assert.equal(normalizar('Superficie (m²)'), 'superficie (m2)');
  assert.equal(normalizar(null), '');
});

test('textoDeControl: junta label, placeholder, name e id', () => {
  assert.match(textoDeControl(controls[0]), /título del aviso/);
  assert.match(textoDeControl(controls[0]), /titulo/);
});

test('elegirControl: encuentra el control por el label del formulario', () => {
  const campo = (key) => CAMPOS.find((c) => c.key === key);
  assert.equal(elegirControl(controls, campo('titulo'))?.id, 'titulo');
  assert.equal(elegirControl(controls, campo('descripcion'))?.id, 'descripcion');
  assert.equal(elegirControl(controls, campo('tipo'))?.id, 'tipo_inmueble');
  assert.equal(elegirControl(controls, campo('operacion'))?.id, 'operacion');
  assert.equal(elegirControl(controls, campo('ciudad'))?.id, 'ciudad');
  assert.equal(elegirControl(controls, campo('barrio'))?.id, 'barrio');
  assert.equal(elegirControl(controls, campo('precio'))?.id, 'precio');
  assert.equal(elegirControl(controls, campo('bedrooms'))?.id, 'dormitorios');
  assert.equal(elegirControl(controls, campo('bathrooms'))?.id, 'banos');
  assert.equal(elegirControl(controls, campo('cocheras'))?.id, 'cocheras');
});

test('elegirControl: NUNCA elige un control oculto (el wizard reutiliza ids)', () => {
  const campo = CAMPOS.find((c) => c.key === 'precio');
  const hit = elegirControl(controls, campo);
  assert.equal(hit.id, 'precio');
  assert.notEqual(hit.id, 'precio_oculto');
});

test('elegirControl: cae al placeholder cuando no hay label', () => {
  const sinLabel = [{ tag: 'input', type: 'text', id: 'x1', name: 'x1', label: '', placeholder: 'Precio en pesos', visible: true }];
  const campo = CAMPOS.find((c) => c.key === 'precio');
  assert.equal(elegirControl(sinLabel, campo)?.id, 'x1');
});

test('elegirControl: si no hay nada que coincida, devuelve null (no inventa)', () => {
  const vacios = [];
  const campo = CAMPOS.find((c) => c.key === 'titulo');
  assert.equal(elegirControl(vacios, campo), null);
});

test('indiceOpcion: exacto, parcial y sin opción', () => {
  const opts = ['Casas', 'Departamentos', 'Terrenos y Lotes'];
  assert.equal(indiceOpcion(opts, 'Casas'), 0);
  assert.equal(indiceOpcion(opts, 'departamentos'), 1);
  assert.equal(indiceOpcion(opts, 'Terrenos'), 2);
  assert.equal(indiceOpcion(opts, 'Galpon'), -1);
  assert.equal(indiceOpcion(opts, ''), -1);
});

test('indiceOpcion: acepta objetos {text}', () => {
  const opts = [{ value: '1', text: 'Casas' }, { value: '2', text: 'Departamentos' }];
  assert.equal(indiceOpcion(opts, 'Departamentos'), 1);
});

test('planLlenado: saltea los campos sin valor (null) y los que no matchean', () => {
  const plan = planLlenado(controls, payload);
  const keys = plan.map((p) => p.key);
  // Baños/antigüedad/expensas son null en este aviso → no se llenan.
  assert.ok(!keys.includes('bathrooms'));
  assert.ok(!keys.includes('antiguedad'));
  assert.ok(!keys.includes('expensas'));
  // La operación NO va en el plan: en el formulario real son botones
  // ("Venta · Alquileres · ..."), no un <select>. La marca `solo_boton`.
  assert.ok(!keys.includes('operacion'));
  // Los que tienen valor Y control matchean.
  for (const k of ['titulo', 'descripcion', 'tipo', 'ciudad', 'barrio', 'precio', 'bedrooms', 'cocheras']) {
    assert.ok(keys.includes(k), 'falta ' + k);
  }
  // El plan trae el control elegido y el valor a cargar.
  const titulo = plan.find((p) => p.key === 'titulo');
  assert.equal(titulo.control.id, 'titulo');
  assert.equal(titulo.valor, payload.titulo);
  assert.equal(titulo.campo.key, 'titulo');
});

test('planLlenado: matchea por el `name` EXACTO de La Voz (field_aviso_*)', () => {
  // El formulario real usa ids semánticos: es la vía más confiable.
  const reales = [
    { tag: 'input', type: 'number', id: 'field_aviso_superficie_total', name: 'field_aviso_superficie_total', label: 'Superficie total m2 *', visible: true },
    { tag: 'input', type: 'number', id: 'field_aviso_superficie_cubierta', name: 'field_aviso_superficie_cubierta', label: 'Superficie cubierta m2', visible: true },
    { tag: 'input', type: 'text', id: 'field_aviso_num_lote', name: 'field_aviso_num_lote', label: 'Número de lote', visible: true },
    { tag: 'input', type: 'text', id: 'field_aviso_titulo', name: 'field_aviso_titulo', label: 'Título', visible: true },
  ];
  const plan = planLlenado(reales, payload);
  const sup = plan.find((p) => p.key === 'superficie_total');
  assert.ok(sup, 'no matcheó la superficie total');
  assert.equal(sup.control.name, 'field_aviso_superficie_total');
  assert.equal(sup.valor, payload.superficie_total);
  const lote = plan.find((p) => p.key === 'num_lote');
  assert.ok(lote, 'no matcheó el número de lote');
  assert.equal(lote.control.name, 'field_aviso_num_lote');
});

test('elegirControl: los combos de Base UI cuentan como select', () => {
  // La Voz NO usa <select>: usa comboboxes (role=combobox) con popup.
  const combos = [
    { tag: 'combo', type: 'combobox', id: 'base-ui-_r_9_', name: null, label: 'Categoría *', labels: ['Categoría *'], visible: true, value: 'Seleccionar...' },
    { tag: 'combo', type: 'combobox', id: 'base-ui-_r_a_', name: null, label: 'Ciudad *', labels: ['Ciudad *'], visible: true, value: 'Seleccionar...' },
  ];
  const tipo = elegirControl(combos, CAMPOS.find((c) => c.key === 'tipo'));
  assert.ok(tipo, 'no eligió el combo de categoría');
  assert.equal(tipo.id, 'base-ui-_r_9_');
  const ciudad = elegirControl(combos, CAMPOS.find((c) => c.key === 'ciudad'));
  assert.equal(ciudad?.id, 'base-ui-_r_a_');
});

test('planLlenado: un formulario sin ese campo no rompe el plan', () => {
  const soloTitulo = controls.filter((c) => c.id === 'titulo');
  const plan = planLlenado(soloTitulo, payload);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].key, 'titulo');
});

test('OPCIONES: el tipo de vendedor se elige como "Inmobiliaria"', () => {
  const op = OPCIONES.find((o) => o.key === 'tipo_vendedor');
  assert.equal(op.valor(), 'Inmobiliaria');
});

test('los regex de botones distinguen "continuar" de "publicar"', () => {
  assert.ok(RE_SIGUIENTE.test('Continuar'));
  assert.ok(RE_SIGUIENTE.test('Siguiente'));
  assert.ok(!RE_SIGUIENTE.test('Publicar aviso'));
  assert.ok(RE_PUBLICAR.test('Publicar aviso'));
  assert.ok(RE_PUBLICAR.test('Guardar'));
  assert.ok(!RE_PUBLICAR.test('Continuar'));
});

/* ================================================================
   EXCLUSIONES Y DEFAULTS: los selects que La Voz exige y que el
   formulario rotula con labels parecidos (Tipo vs Tipo de barrio,
   Ciudad vs Provincia).
   ================================================================ */

const controlsPortal = [
  { tag: 'select', type: 'select-one', id: 'tipo_inmueble', name: 'tipo', label: 'Tipo de inmueble', visible: true,
    options: [{ value: '1', text: 'Casas' }] },
  { tag: 'select', type: 'select-one', id: 'tipo_barrio', name: 'tipo_barrio', label: 'Tipo de barrio', visible: true,
    options: [{ value: 'a', text: 'Abierto' }, { value: 's', text: 'Con Seguridad' }] },
  { tag: 'select', type: 'select-one', id: 'provincia', name: 'provincia', label: 'Provincia', visible: true,
    options: [{ value: 'c', text: 'Córdoba' }] },
  { tag: 'select', type: 'select-one', id: 'ciudad', name: 'ciudad', label: 'Ciudad', visible: true,
    options: [{ value: 'co', text: 'Córdoba' }] },
  { tag: 'select', type: 'select-one', id: 'barrio', name: 'barrio', label: 'Barrio / Zona', visible: true,
    options: [{ value: 'ob', text: 'Obrero' }] },
  { tag: 'select', type: 'select-one', id: 'tipo_vendedor', name: 'tipo_vendedor', label: 'Tipo de vendedor', visible: true,
    options: [{ value: 'i', text: 'Inmobiliaria' }, { value: 'p', text: 'Particular' }] },
  { tag: 'select', type: 'select-one', id: 'duracion', name: 'duracion', label: 'Duración del aviso', visible: true,
    options: [{ value: '10', text: '10 días' }, { value: '30', text: '30 días' }] },
];

test('elegirControl: "tipo" NO se come el select "Tipo de barrio"', () => {
  const campo = CAMPOS.find((c) => c.key === 'tipo');
  assert.equal(elegirControl(controlsPortal, campo)?.id, 'tipo_inmueble');
});

test('elegirControl: "barrio" NO se come el select "Tipo de barrio"', () => {
  const campo = CAMPOS.find((c) => c.key === 'barrio');
  assert.equal(elegirControl(controlsPortal, campo)?.id, 'barrio');
});

test('elegirControl: "ciudad" NO se come el select "Provincia"', () => {
  const campo = CAMPOS.find((c) => c.key === 'ciudad');
  assert.equal(elegirControl(controlsPortal, campo)?.id, 'ciudad');
});

test('planDefaults: completa provincia, tipo de barrio, vendedor y duración', () => {
  const plan = planDefaults(controlsPortal, { ...payload, dias_publicacion: 30 }, []);
  const byKey = Object.fromEntries(plan.map((p) => [p.key, p]));
  assert.equal(byKey.provincia.control.id, 'provincia');
  assert.equal(byKey.provincia.valor, 'Córdoba');
  assert.equal(byKey.tipo_barrio.control.id, 'tipo_barrio');
  assert.equal(byKey.tipo_barrio.valor, 'Abierto');
  assert.equal(byKey.tipo_vendedor.control.id, 'tipo_vendedor');
  assert.equal(byKey.tipo_vendedor.valor, 'Inmobiliaria');
  assert.equal(byKey.duracion.control.id, 'duracion');
  assert.equal(byKey.duracion.valor, 30);
});

test('planDefaults: NO pisa un control ya reclamado por un campo del aviso', () => {
  const plan = planLlenado(controlsPortal, payload);
  const claimed = plan.map((p) => idControl(p.control));
  assert.ok(claimed.includes('ciudad'));
  const defaults = planDefaults(controlsPortal, { ...payload, dias_publicacion: 30 }, claimed);
  const ids = defaults.map((p) => idControl(p.control));
  assert.ok(!ids.includes('ciudad'));
  assert.ok(!ids.includes('tipo_inmueble'));
});

test('planDefaults: sin defaults aplicables devuelve un plan vacío', () => {
  const plan = planDefaults([], payload, []);
  assert.equal(plan.length, 0);
});

test('DEFAULTS: el tipo de vendedor por defecto es Inmobiliaria', () => {
  const def = DEFAULTS.find((d) => d.key === 'tipo_vendedor');
  assert.equal(def.valor(), 'Inmobiliaria');
});

test('esTextoTerminos: detecta la casilla de condiciones y NO el Turnstile', () => {
  assert.ok(esTextoTerminos('Acepto los términos y condiciones'));
  assert.ok(esTextoTerminos('He leído y acepto los Términos'));
  assert.ok(!esTextoTerminos('No soy un robot'));
  assert.ok(!esTextoTerminos(''));
  assert.ok(!esTextoTerminos('Tipo de inmueble'));
});

test('tieneBloqueante: detecta los 3 avisos que impiden publicar', () => {
  assert.ok(tieneBloqueante({ avisos: ['Falta la operación (venta/alquiler): no se puede publicar sin ella.'] }));
  assert.ok(tieneBloqueante({ avisos: ['Falta el precio'] }));
  assert.ok(tieneBloqueante({ avisos: ['El tipo "quinta" no tiene subrubro mapeado en La Voz.'] }));
  // Un aviso normal no bloquea.
  assert.ok(!tieneBloqueante({ avisos: ['La zona "X" no tiene barrio equivalente en La Voz.'] }));
  assert.ok(!tieneBloqueante({ avisos: [] }));
  assert.ok(!tieneBloqueante(null));
});
