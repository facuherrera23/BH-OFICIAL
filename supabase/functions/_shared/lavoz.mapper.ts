// ============================================================
// lavoz.mapper — lógica pura de la publicación en Clasificados La Voz
// ============================================================
// Módulo SIN I/O: lo usan la edge function lavoz-proxy y los tests
// unitarios (node --test tests/unit/lavoz-mapper.test.mts).
//
// CONTEXTO (investigación 2026-11-04):
//   Clasificados La Voz no tiene API ni carga masiva. El aviso se arma acá
//   (texto + fotos con la PORTADA primero + los campos del formulario) y
//   una persona lo carga en el panel de La Voz. La foto PORTADA es la
//   PRIMERA del array image_urls: en el panel la estrella "usar como foto
//   de portada" reordena el array, y la ficha pública usa ese mismo orden.
//
// Taxonomía de La Voz (slugs verificados en /inmuebles el 2026-11-04):
//   casas · departamentos · terrenos-y-lotes · locales · galpones-y-depositos
//   · oficinas · cocheras · campos · fondo-de-comercio
// Filtros: operacion (venta|alquileres|alquileres temporarios|compra),
//   provincia → ciudad → barrio, tipo de barrio (Abierto|Con Seguridad|
//   Cerrado|Country), tipo de vendedor (Inmobiliaria|Particular|Comercio).
// ============================================================

export const MAX_FOTOS = 25;      // La Voz admite hasta 25 fotos por aviso
export const MAX_DESC = 2400;

export const OPERACION_LABEL: Record<string, string> = {
  venta: 'Venta',
  alquileres: 'Alquiler',
  alquiler: 'Alquiler',
  alquileres_temporarios: 'Alquiler temporal',
  compra: 'Compra',
};

export const PLAN_LABEL: Record<string, string> = {
  basico: 'Básico (1 foto, sin destacar)',
  estandar: 'Estándar (6 fotos)',
  premium: 'Premium (12 fotos + video)',
  super_premium: 'Súper Premium (25 fotos + video)',
};

/**
 * Etiquetas de las ciudades de La Voz (el slug no alcanza: "cordoba"
 * tiene que mostrarse como "Córdoba"). La config puede sobrescribirlas con
 * `ciudad_label`; esta tabla es el fallback.
 */
export const CIUDAD_LABEL: Record<string, string> = {
  cordoba: 'Córdoba',
  'villa-carlos-paz': 'Villa Carlos Paz',
  'la-calera': 'La Calera',
  'villa-berna': 'Villa Berna',
  'san-ignacio': 'San Ignacio',
  'potrero-de-garay': 'Potrero de Garay',
};

/** "villa-carlos-paz" → "Villa Carlos Paz" */
function titulizar(s: string): string {
  return s
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export interface LavozTipoMap { subrubro: string; label: string }
export interface LavozUbicacion {
  ciudad?: string;
  /** Nombre para mostrar de la ciudad (con tildes). Si falta, se deduce del slug. */
  ciudad_label?: string;
  barrio?: string | null;
  label?: string;
}
export interface LavozContacto {
  email?: string; telefono?: string; whatsapp?: string; mostrar_whatsapp?: boolean;
}
export interface LavozConfig {
  dias_publicacion: number;
  tipo_map: Record<string, LavozTipoMap>;
  ubicacion_map: Record<string, LavozUbicacion>;
  contacto: LavozContacto;
}

export interface LavozPayload {
  property_id: string;
  property_code: string;
  titulo: string;
  descripcion: string;
  operacion: string | null;
  operacion_label: string | null;
  subrubro: string;
  subrubro_label: string;
  ciudad: string | null;
  ciudad_label: string;
  barrio: string | null;
  barrio_label: string;
  sin_equivalencia: boolean;
  ubicacion_label: string;
  address: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  cocheras: number | null;
  superficie_total: number | null;
  superficie_cubierta: number | null;
  antiguedad: number | null;
  expensas: number | null;
  precio: number | null;
  moneda: string | null;
  fotos: string[];
  fotos_count: number;
  video_url: string | null;
  ficha_url: string | null;
  plan_recomendado: string;
  dias_publicacion: number;
  avisos: string[];
}

/** Normaliza para comparar claves de mapa: minúsculas, sin tildes, espacios colapsados. */
export function norm(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 0 = "no aplica" (terrenos, galpones) → null. */
export function numPos(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

export function slug(s: unknown): string {
  return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Reescala una foto de Cloudinary para La Voz.
 * La Voz muestra 800x450 en su CDN y acepta hasta 25 fotos: forzamos JPG
 * (f_jpg) para que el archivo sea un JPG real y no dependa del Accept.
 */
export function resizeFoto(url: string): string {
  if (!/res\.cloudinary\.com/.test(url)) return url;
  // /image/upload/<transforms>/<version>/<path> → se reemplazan los transforms
  // por el resize de La Voz. El grupo de transforms es opcional (las URLs
  // viejas pueden no tenerlo).
  return url.replace(
    /\/image\/upload\/(?:([^/]+)\/)?/,
    (_m, transforms?: string) => {
      const base = (transforms || '')
        .split(',')
        .filter((t) => t && !/^f_(auto|jpg|jpeg|png|webp)$/.test(t) && !/^q_/.test(t));
      const parts = [...base, 'w_1200', 'h_900', 'c_limit', 'f_jpg', 'q_80'];
      return `/image/upload/${parts.join(',')}/`;
    },
  );
}

/**
 * Arma el aviso de La Voz a partir de una propiedad.
 * `avisos` trae los warnings para el panel (no bloquean, salvo que falte
 * operación/precio/subrubro).
 */
export function buildLavozPayload(
  p: Record<string, unknown>,
  cfg: LavozConfig,
): LavozPayload {
  const avisos: string[] = [];
  const code = String(p.property_code || '');
  const tipo = norm(p.property_type);
  const tipoMap = cfg.tipo_map?.[tipo];
  const subrubro = tipoMap?.subrubro || '';
  const subrubroLabel = tipoMap?.label || String(p.property_type || '');

  if (!tipoMap) avisos.push(`El tipo "${p.property_type || '—'}" no tiene subrubro mapeado en La Voz.`);
  if (!p.listing_type) avisos.push('Falta la operación (venta/alquiler): no se puede publicar sin ella.');
  if (!subrubro) avisos.push('Falta el subrubro: revisá el tipo de propiedad.');

  // --- Ubicación: primero el barrio (zone), después la ciudad (locality) ---
  const zoneKey = norm(p.zone);
  const cityKey = norm(p.locality);
  let ub = cfg.ubicacion_map?.[zoneKey] || cfg.ubicacion_map?.[cityKey] || null;
  let sinEquivalencia = false;
  if (!ub) {
    sinEquivalencia = true;
    avisos.push(
      `La zona "${p.zone || '—'}" no tiene barrio equivalente en La Voz (medido 2026-11-04). ` +
      'Se publica en Córdoba con la zona real en el texto.',
    );
    ub = { ciudad: 'cordoba', barrio: null, label: String(p.zone || '') };
  }
  const barrioLabel = String(ub.label || p.zone || '');
  const ciudadLabel = ub.ciudad
    ? (ub.ciudad_label || CIUDAD_LABEL[ub.ciudad] || titulizar(ub.ciudad))
    : 'Córdoba';

  // --- Medidas ---
  const superficieTotal = numPos(p.surface_total) ?? numPos(p.area_m2) ?? numPos(p.surface_covered);
  const superficieCubierta = numPos(p.surface_covered);
  const bedrooms = numPos(p.bedrooms) ?? numPos(p.rooms);
  const bathrooms = numPos(p.bathrooms);
  const cocheras = numPos(p.garage_spaces);
  const anios = numPos(p.year_built);
  const expensas = numPos(p.maintenance_fee);
  const precio = num(p.price_usd);
  const moneda = p.price_currency ? String(p.price_currency).toUpperCase() : null;

  if (precio === null) avisos.push('Falta el precio.');
  if (!p.zone && !p.locality) avisos.push('Falta la zona y la localidad.');
  if (anios === null && subrubro !== 'terrenos-y-lotes') avisos.push('No cargamos antigüedad (year_built vacío).');

  // --- Fotos: la PORTADA (primera del array) va primero ---
  const rawFotos = Array.isArray(p.image_urls) ? (p.image_urls as unknown[]) : [];
  const fotos = rawFotos
    .map((u) => String(u || '').trim())
    .filter((u) => /^https?:\/\//.test(u))
    .slice(0, MAX_FOTOS)
    .map(resizeFoto);
  if (!fotos.length) avisos.push('La propiedad no tiene fotos: el aviso básico mostrará una imagen genérica.');
  if (rawFotos.length > MAX_FOTOS) avisos.push(`La propiedad tiene ${rawFotos.length} fotos; La Voz admite ${MAX_FOTOS}.`);

  // --- Título: el nuestro, con el barrio adelante si no lo menciona ---
  const tituloBase = String(p.title || '').trim();
  let titulo = tituloBase;
  if (titulo && barrioLabel && !norm(titulo).includes(norm(barrioLabel))) {
    titulo = `${barrioLabel} — ${titulo}`;
  }
  if (titulo.length > 140) titulo = titulo.slice(0, 137).trim() + '...';

  // --- Descripción ---
  let descripcion = String(p.description || '').trim();
  if (!descripcion) {
    descripcion = `${subrubroLabel}${p.listing_type ? ' en ' + (OPERACION_LABEL[norm(p.listing_type)] || '') : ''}` +
      ` en ${barrioLabel}.`;
    avisos.push('La propiedad no tiene descripción: se armó una mínima.');
  }
  if (descripcion.length > MAX_DESC) {
    descripcion = descripcion.slice(0, MAX_DESC - 3).trim() + '...';
  }
  const c = cfg.contacto || {};
  if (c.mostrar_whatsapp && c.whatsapp) {
    descripcion += `\n\nConsultas: WhatsApp ${c.whatsapp}`;
  } else if (c.telefono) {
    descripcion += `\n\nConsultas: ${c.telefono}`;
  } else if (c.email) {
    descripcion += `\n\nConsultas: ${c.email}`;
  }

  return {
    property_id: String(p.id || ''),
    property_code: code,
    titulo,
    descripcion,
    operacion: norm(p.listing_type) || null,
    operacion_label: OPERACION_LABEL[norm(p.listing_type)] || null,
    subrubro,
    subrubro_label: subrubroLabel,
    ciudad: ub.ciudad || null,
    ciudad_label: ciudadLabel,
    barrio: ub.barrio || null,
    barrio_label: barrioLabel,
    sin_equivalencia: sinEquivalencia,
    ubicacion_label: [barrioLabel, ciudadLabel].filter(Boolean).join(', '),
    address: (p.address as string) || null,
    bedrooms,
    bathrooms,
    cocheras,
    superficie_total: superficieTotal,
    superficie_cubierta: superficieCubierta,
    antiguedad: anios,
    expensas,
    precio,
    moneda,
    fotos,
    fotos_count: fotos.length,
    video_url: (p.video_url as string) || null,
    ficha_url: code ? `https://bienenhaus.com.ar/fichas/${code}.html` : null,
    plan_recomendado: fotos.length >= 25 ? 'super_premium'
      : fotos.length >= 12 ? 'premium'
      : fotos.length >= 6 ? 'estandar' : 'basico',
    dias_publicacion: cfg.dias_publicacion,
    avisos,
  };
}

/** Ficha de texto para copiar y pegar en el formulario de La Voz. */
export function buildLavozFicha(p: LavozPayload): string {
  const linea = (k: string, v: unknown) => `${k}: ${v === null || v === undefined || v === '' ? '—' : v}`;
  return [
    'PUBLICACIÓN · CLASIFICADOS LA VOZ',
    '=================================',
    `Propiedad interna: ${p.property_code}`,
    '',
    linea('Título', p.titulo),
    linea('Operación', p.operacion_label),
    linea('Tipo de inmueble', p.subrubro_label),
    linea('Ciudad', p.ciudad_label),
    linea('Barrio / Zona', p.ubicacion_label),
    linea('Dormitorios', p.bedrooms),
    linea('Baños', p.bathrooms),
    linea('Cocheras', p.cocheras),
    linea('Superficie total (m²)', p.superficie_total),
    linea('Superficie cubierta (m²)', p.superficie_cubierta),
    linea('Antigüedad (años)', p.antiguedad),
    linea('Expensas', p.expensas),
    linea('Precio', p.precio !== null ? `${p.precio} ${p.moneda || ''}`.trim() : null),
    linea('Fotos a subir', `${p.fotos_count} (la primera es la PORTADA)`),
    linea('Ficha propia', p.ficha_url),
    '',
    '--- DESCRIPCIÓN (copiar) ---',
    p.descripcion,
  ].join('\n');
}
