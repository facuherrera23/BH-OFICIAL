// ============================================================
// lavez-mapping.mjs — mapeo puro: campos del aviso ↔ controles del formulario
// ============================================================
// Módulo SIN I/O (lo usa scripts/lavoz-publisher.mjs y los tests unitarios
// tests/unit/lavoz-mapping.test.mts).
//
// El formulario de La Voz cambia (wizard de varios pasos, labels que
// varían) → el mapeo es por PALABRAS CLAVE, con degradación:
//   1) keyword EXACTO sobre label / placeholder / name / id
//   2) keyword que ES prefijo del texto del control
//   3) keyword contenido en el texto del control
// Los campos se excluyen mutuamente (exclude) para no comer el select
// equivocado: "Tipo de inmueble" vs "Tipo de barrio", "Ciudad" vs
// "Provincia", etc.
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
  {
    key: 'operacion', valor: (p) => p.operacion_label || p.operacion,
    keywords: ['operacion', 'operación', 'modalidad', 'transaccion', 'transacción'], tag: 'select',
    exclude: ['duracion', 'duración', 'publicacion', 'publicación'],
  },
  {
    key: 'tipo', valor: (p) => p.subrubro_label || p.subrubro,
    keywords: ['tipo de inmueble', 'tipo', 'subrubro', 'categoria', 'categoría', 'inmueble'], tag: 'select',
    exclude: ['barrio', 'vendedor', 'provincia', 'operacion', 'duracion', 'publicacion'],
  },
  {
    key: 'ciudad', valor: (p) => p.ciudad_label || p.ciudad,
    keywords: ['ciudad', 'localidad', 'municipio'], tag: 'select',
    exclude: ['barrio', 'vendedor', 'provincia', 'tipo'],
  },
  {
    key: 'barrio', valor: (p) => p.barrio_label,
    keywords: ['barrio / zona', 'barrio', 'zona'], tag: 'select',
    exclude: ['tipo de barrio', 'vendedor', 'provincia'],
  },
];

/**
 * Controles que La Voz EXIGE y nosotros no tenemos dato.
 * Se eligen sólo si ningún campo del aviso los reclamó antes.
 * Los defaults son editables acá (se cambian sin tocar el motor).
 */
export const DEFAULTS = [
  {
    key: 'provincia', valor: () => 'Córdoba',
    keywords: ['provincia'], tag: 'select',
  },
  {
    key: 'tipo_barrio', valor: () => 'Abierto',
    keywords: ['tipo de barrio', 'tipo barrio', 'clase de barrio', 'tipo de zona'], tag: 'select',
  },
  {
    key: 'tipo_vendedor', valor: () => 'Inmobiliaria',
    keywords: ['tipo de vendedor', 'tipo de anunciante', 'vendedor', 'publicante', 'tipo de cuenta'], tag: 'select',
  },
  {
    key: 'duracion', valor: (p) => p.dias_publicacion,
    keywords: ['duracion', 'duración', 'dias de publicacion', 'días de publicación', 'vigencia', 'tiempo de publicacion', 'tiempo de publicación'], tag: 'select',
  },
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
 * Textos candidatos de un control, uno por atributo.
 * Se comparan por separado (no concatenados) para poder hacer coincidencia
 * EXACTA: un select "Ciudad" no debe Gainarse por el id "barrio_1".
 */
export function candidatosDeControl(c) {
  return [c.label, c.placeholder, c.ariaLabel, c.name, c.id]
    .map((x) => normalizar(x))
    .filter(Boolean);
}

function excluido(c, campo) {
  const excludes = campo.exclude || [];
  if (!excludes.length) return false;
  const textos = candidatosDeControl(c);
  return excludes.some((ex) => {
    const e = normalizar(ex);
    return textos.some((t) => t.includes(e));
  });
}

/**
 * Elige el control que corresponde a un campo.
 * Sólo controles visibles (el wizard reutiliza ids entre pasos).
 * Prioridad: exacto → prefijo → contenido.
 */
export function elegirControl(controls, campo) {
  const visibles = controls.filter((c) => c.visible !== false);
  const base = campo.tag ? visibles.filter((c) => c.tag === campo.tag) : visibles;
  const pool = base.filter((c) => !excluido(c, campo));
  for (const kw of campo.keywords) {
    const k = normalizar(kw);
    const hit = pool.find((c) => candidatosDeControl(c).some((t) => t === k));
    if (hit) return hit;
  }
  for (const kw of campo.keywords) {
    const k = normalizar(kw);
    const hit = pool.find((c) => candidatosDeControl(c).some((t) => t.startsWith(k)));
    if (hit) return hit;
  }
  for (const kw of campo.keywords) {
    const k = normalizar(kw);
    const hit = pool.find((c) => candidatosDeControl(c).some((t) => t.includes(k)));
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

/** Identificador de un control (para saber si ya fue reclamado). */
export function idControl(c) {
  return c?.id || c?.name || null;
}

/**
 * Defaults para los controles que La Voz exige y nosotros no tenemos dato
 * (provincia, tipo de barrio, tipo de vendedor, duración).
 * NO pisa un control ya usado por un campo del aviso.
 */
export function planDefaults(controls, payload, claimed = []) {
  const usados = new Set(claimed.filter(Boolean));
  const plan = [];
  for (const def of DEFAULTS) {
    const valor = def.valor(payload);
    if (valor === null || valor === undefined || valor === '') continue;
    const control = elegirControl(controls, def);
    if (!control) continue;
    const id = idControl(control);
    if (id && usados.has(id)) continue;
    if (id) usados.add(id);
    plan.push({ key: def.key, campo: def, control, valor });
  }
  return plan;
}

/** Botones que avanzan el wizard vs. los que publican. */
export const RE_SIGUIENTE = /continuar|siguiente|avanzar|gu[ií]ame|acepto|aceptar|confirmar|next/i;
export const RE_PUBLICAR = /publicar|publica|guardar|enviar|finalizar|terminar|registrar/i;

/** Casillas de aceptación de términos y condiciones. */
export const RE_TERMINOS = /acepto|terminos|términos|condiciones|politica|política/i;

/** ¿Este texto es el de una casilla de términos? */
export function esTextoTerminos(texto) {
  const t = normalizar(texto);
  if (!t) return false;
  if (/no soy un robot|captcha|turnstile/.test(t)) return false;
  return RE_TERMINOS.test(t);
}
