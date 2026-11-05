// ============================================================
// lavez-mapping.mjs — mapeo puro: campos del aviso ↔ controles del formulario
// ============================================================
// Módulo SIN I/O (lo usa scripts/lavoz-publisher.mjs y los tests unitarios
// tests/unit/lavoz-mapping.test.mts).
//
// El formulario de La Voz cambia (wizard de varios pasos, labels que
// varían) → el mapeo es por PALABRAS CLAVE, con degradación:
//   1) keyword exacto en label/placeholder/name/id
//   2) keyword parcial
//   3) (en runtime) select por texto de la opción
// ============================================================

/** Campos del aviso → keywords del formulario + valor a cargar. */
export const CAMPOS = [
  { key: 'titulo', valor: (p) => p.titulo, keywords: ['titulo', 'título', 'titular', 'encabezado', 'nombre del aviso', 'subject'], tag: 'input' },
  { key: 'descripcion', valor: (p) => p.descripcion, keywords: ['descripcion', 'descripción', 'detalle', 'texto del aviso', 'body', 'comentarios'], tag: 'textarea' },
  { key: 'precio', valor: (p) => (p.precio ?? null), keywords: ['precio', 'valor', 'importe', 'price'], tag: 'input' },
  { key: 'superficie_total', valor: (p) => p.superficie_total, keywords: ['superficie total', 'superficie', 'metros', 'm2', 'm²', 'superficie del terreno', 'dimensions'], tag: 'input' },
  { key: 'superficie_cubierta', valor: (p) => p.superficie_cubierta, keywords: ['superficie cubierta', 'cubierta', 'superficie construida'], tag: 'input' },
  { key: 'bedrooms', valor: (p) => p.bedrooms, keywords: ['dormitorio', 'dormitorios', 'dorm'], tag: 'input' },
  { key: 'bathrooms', valor: (p) => p.bathrooms, keywords: ['baño', 'bano', 'baños', 'bath'], tag: 'input' },
  { key: 'cocheras', valor: (p) => p.cocheras, keywords: ['cochera', 'cocheras', 'garaje', 'estacionamiento'], tag: 'input' },
  { key: 'antiguedad', valor: (p) => p.antiguedad, keywords: ['antiguedad', 'antigüedad', 'años de antiguedad', 'fecha de construccion', 'fecha de construcción'], tag: 'input' },
  { key: 'expensas', valor: (p) => p.expensas, keywords: ['expensa', 'expensas', 'cuota de administracion', 'administración'], tag: 'input' },
  { key: 'operacion', valor: (p) => p.operacion_label || p.operacion, keywords: ['operacion', 'operación', 'modalidad', 'transaccion', 'transacción'], tag: 'select' },
  { key: 'tipo', valor: (p) => p.subrubro_label || p.subrubro, keywords: ['tipo de inmueble', 'tipo', 'subrubro', 'categoria', 'categoría', 'inmueble'], tag: 'select' },
  { key: 'ciudad', valor: (p) => p.ciudad_label || p.ciudad, keywords: ['ciudad', 'localidad', 'municipio', 'provincia'], tag: 'select' },
  { key: 'barrio', valor: (p) => p.barrio_label, keywords: ['barrio', 'zona', 'barrio / zona'], tag: 'select' },
];

/** Opciones que se eligen por texto (radio/checkbox): tipo de vendedor, etc. */
export const OPCIONES = [
  { key: 'tipo_vendedor', valor: () => 'Inmobiliaria', keywords: ['tipo de vendedor', 'tipo de anunciante', 'vendedor', 'publicante'] },
  { key: 'operacion_radio', valor: (p) => p.operacion_label || p.operacion, keywords: ['operacion', 'operación', 'modalidad'] },
];

/** Normaliza para comparar: minúsculas, sin tildes, espacios colapsados. */
export function normalizar(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/²/g, '2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Texto por el que se busca un control (label + placeholder + name + id). */
export function textoDeControl(c) {
  return `${c.label || ''} ${c.placeholder || ''} ${c.ariaLabel || ''} ${c.name || ''} ${c.id || ''}`.toLowerCase();
}

/**
 * Elige el control que corresponde a un campo.
 * Sólo controles visibles (el wizard reutiliza ids entre pasos).
 */
export function elegirControl(controls, campo) {
  const visibles = controls.filter((c) => c.visible !== false);
  const pool = campo.tag ? visibles.filter((c) => c.tag === campo.tag) : visibles;
  for (const kw of campo.keywords) {
    const k = normalizar(kw);
    const hit = pool.find((c) => normalizar(textoDeControl(c)).includes(k));
    if (hit) return hit;
  }
  for (const kw of campo.keywords) {
    const k = normalizar(kw);
    const hit = visibles.find((c) => normalizar(c.placeholder || '').includes(k));
    if (hit) return hit;
  }
  return null;
}

/**
 * Índice de la opción de un <select> que corresponde al valor del aviso.
 * Primero exacto, después parcial (en cualquier dirección).
 */
export function indiceOpcion(options, valor) {
  const want = normalizar(valor);
  if (!want) return -1;
  const opts = options || [];
  const exacto = opts.findIndex((o) => normalizar(typeof o === 'string' ? o : o.text) === want);
  if (exacto >= 0) return exacto;
  return opts.findIndex((o) => {
    const t = normalizar(typeof o === 'string' ? o : o.text);
    return t && (t.includes(want) || want.includes(t));
  });
}

/**
 * Calcula el plan de llenado de un paso: qué campo va a qué control.
 * Devuelve [{campo, control, valor}] — sin los campos sin valor (null).
 */
export function planLlenado(controls, payload) {
  const plan = [];
  for (const campo of CAMPOS) {
    const valor = campo.valor(payload);
    if (valor === null || valor === undefined || valor === '') continue;
    const control = elegirControl(controls, campo);
    if (!control) continue;
    plan.push({ key: campo.key, campo, control, valor });
  }
  return plan;
}

/** Botones que avanzan el wizard vs. los que publican. */
export const RE_SIGUIENTE = /continuar|siguiente|avanzar|gu[ií]ame|acepto|aceptar|confirmar|next/i;
export const RE_PUBLICAR = /publicar|publica|guardar|enviar|finalizar|terminar|registrar/i;
