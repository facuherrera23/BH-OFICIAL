/* ============================================================
   RELA Mapper — BH (tabla `properties`) → payload Open RELA.
   Módulo PURO: sin imports, sin I/O; lo usan las Edge Functions
   (Deno) y los tests unitarios (node --test, type stripping).

   El payload sigue el modelo documentado en:
   https://open-classifieds.notion.site/arg/rela/
   (2.5 Gestión de avisos y 3. Modelos de avisos).

   Los IDs de catálogo (idTipo/idSubTipo, idUbicacion, ids de
   características) NO están publicados en la documentación
   general: se resuelven desde `RelaConfig.catalogMapping`,
   `tipoPropiedadMap` y `ubicacionMap`, alimentados por los
   endpoints GET /v1/tipopropiedades, GET /v1/ubicaciones, etc.
   ============================================================ */

export interface BhProperty {
  id: string;
  property_code: string | null;
  title: string | null;
  description: string | null;
  property_type: string | null;   // casa|departamento|terreno|local|oficina|galpon|quinta|otro
  status: string | null;          // venta|alquiler|vendido|alquilado|pausado
  zone: string | null;
  address: string | null;
  price_usd: number | null;
  price_currency: string | null;  // 'USD' | 'ARS'
  area_m2: number | null;
  surface_covered: number | null;
  surface_total: number | null;
  rooms: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  garage_spaces: number | null;
  year_built: number | null;
  image_urls: string[] | null;
  video_url: string | null;
}

export interface RelaConfig {
  codigoInmobiliaria?: string;
  plan?: string;                  // tipoDePublicacion, ej. 'SIMPLE'
  contactoNombre?: string;
  contactoEmail?: string;
  contactoTelefono?: string;
  catalogMapping?: Record<string, string>;   // SUPERFICIE_TOTAL→'CFT100', etc.
  tipoPropiedadMap?: Record<string, { idTipo: string; idSubTipo?: string }>;
  ubicacionMap?: Record<string, string>;     // zona normalizada → idUbicacion
}

export interface RelaPayload {
  codigoAviso: string;
  publicador: {
    codigoInmobiliaria: string;
    nombreDeContacto?: string;
    emailDeContacto?: string;
    telefonoDeContacto?: string;
  };
  publicacion: { tipoDePublicacion: string };
  titulo: string;
  descripcion: string;
  tipoDePropiedad: { idTipo: string; idSubTipo?: string };
  localizacion: {
    idUbicacion: string;
    direccion?: string;
    muestraMapa: string;          // 'EXACTO' | 'APROXIMADO' | 'NO_MOSTRAR'
  };
  precios: Array<{ operacion: string; monto: string; moneda: string }>;
  caracteristicas: Array<{ id: string; valor: string }>;
  multimedia: {
    imagenes?: Array<{ titulo?: string; urlImagenOriginal: string }>;
    planos?: Array<{ titulo?: string; urlImagenOriginal: string }>;
  };
  claveReferencia?: string;
}

export const RELA_CHAR_KEYS = [
  'SUPERFICIE_TOTAL',
  'SUPERFICIE_CUBIERTA',
  'AMBIENTES',
  'DORMITORIOS',
  'BANOS',
  'MEDIO_BANO',
  'GARAGE',
] as const;

function normalizeZone(zone: string): string {
  return zone
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

export function makeCodigoAviso(p: BhProperty): string {
  const base = (p.property_code && p.property_code.trim()) || `BH-${p.id.slice(0, 8)}`;
  return base.replace(/\s+/g, '-').slice(0, 60);
}

export function validateForRela(p: BhProperty, cfg: RelaConfig): string[] {
  const errors: string[] = [];

  if (!cfg.codigoInmobiliaria) {
    errors.push('Falta configurar el código de inmobiliaria de RELA (Portales > RELA).');
  }
  if (!cfg.plan) {
    errors.push('Falta configurar el plan de publicación RELA (tipoDePublicacion).');
  }
  if (!p.title || !p.title.trim()) {
    errors.push('No se puede publicar en RELA: falta el título de la propiedad.');
  } else if (p.title.length > 80) {
    errors.push('El título supera los 80 caracteres que acepta RELA (se truncaría).');
  }
  if (!p.description || p.description.trim().length < 50) {
    errors.push('No se puede publicar en RELA: la descripción debe tener al menos 50 caracteres.');
  }
  const typeEntry = p.property_type ? cfg.tipoPropiedadMap?.[p.property_type] : undefined;
  if (!typeEntry?.idTipo) {
    errors.push(`No hay mapeo RELA para el tipo de propiedad "${p.property_type || 'sin definir'}". Cargá el mapeo en Portales > RELA (catálogos).`);
  }
  const ubId = p.zone ? cfg.ubicacionMap?.[normalizeZone(p.zone)] : undefined;
  if (!ubId) {
    errors.push(`No hay idUbicacion RELA para la zona "${p.zone || 'sin definir'}". Sincronizá el catálogo de ubicaciones y mapeala en Portales > RELA.`);
  }
  if (p.status !== 'venta' && p.status !== 'alquiler') {
    errors.push(`La propiedad está en estado "${p.status || 'sin estado'}"; sólo se publican 'venta' o 'alquiler'.`);
  }
  if (!p.price_usd || p.price_usd <= 0) {
    errors.push('No se puede publicar en RELA: falta el precio o es 0 (WARN-0210 del portal).');
  }
  if (!p.price_currency || !['USD', 'ARS'].includes(p.price_currency)) {
    errors.push('Moneda no soportada: debe ser USD o ARS.');
  }
  if (!p.surface_covered && !p.surface_total && !p.area_m2) {
    errors.push('No se puede publicar en RELA: falta superficie (cubierta o total).');
  }
  const imgs = (p.image_urls || []).filter(isHttpUrl);
  if (imgs.length === 0) {
    errors.push('No se puede publicar en RELA: no hay fotos con URL pública (http/https).');
  }
  return errors;
}

function surfaceValues(p: BhProperty): { total: number | null; covered: number | null } {
  const covered = p.surface_covered ?? p.area_m2 ?? null;
  // RELA aplica SUPERFICIE_TOTAL = cubierta cuando falta (WARN-0215); además
  // tratamos un total 0 como ausente para no mandar basura.
  const total = p.surface_total && p.surface_total > 0 ? p.surface_total : covered;
  return { total, covered };
}

export function mapPropertyToRela(p: BhProperty, cfg: RelaConfig): RelaPayload {
  const typeEntry = cfg.tipoPropiedadMap![p.property_type as string];
  const ubId = cfg.ubicacionMap![normalizeZone(p.zone as string)];
  const cm = cfg.catalogMapping || {};

  const caracteristicas: Array<{ id: string; valor: string }> = [];
  const { total, covered } = surfaceValues(p);
  const addChar = (key: string, value: number | null) => {
    const id = cm[key];
    if (id && value !== null && value !== undefined && value > 0) {
      caracteristicas.push({ id, valor: String(value) });
    }
  };
  addChar('SUPERFICIE_TOTAL', total);
  addChar('SUPERFICIE_CUBIERTA', covered);
  addChar('AMBIENTES', p.rooms);
  addChar('DORMITORIOS', p.bedrooms);
  addChar('BANOS', p.bathrooms);
  addChar('MEDIO_BANO', null);
  addChar('GARAGE', p.garage_spaces);

  const imagenes = (p.image_urls || [])
    .filter(isHttpUrl)
    .slice(0, 50) // WARN-0211: RELA toma como máximo 50 fotos válidas
    .map((url) => ({ urlImagenOriginal: url }));

  return {
    codigoAviso: makeCodigoAviso(p),
    publicador: {
      codigoInmobiliaria: cfg.codigoInmobiliaria as string,
      nombreDeContacto: cfg.contactoNombre || undefined,
      emailDeContacto: cfg.contactoEmail || undefined,
      telefonoDeContacto: cfg.contactoTelefono || undefined,
    },
    publicacion: { tipoDePublicacion: cfg.plan as string },
    titulo: (p.title as string).slice(0, 80),
    descripcion: p.description as string,
    tipoDePropiedad: typeEntry.idSubTipo
      ? { idTipo: typeEntry.idTipo, idSubTipo: typeEntry.idSubTipo }
      : { idTipo: typeEntry.idTipo },
    localizacion: {
      idUbicacion: ubId,
      direccion: p.address || undefined,
      muestraMapa: 'NO_MOSTRAR',
    },
    precios: [
      {
        operacion: p.status === 'alquiler' ? 'ALQUILER' : 'VENTA',
        monto: String(p.price_usd),
        moneda: p.price_currency as string,
      },
    ],
    caracteristicas,
    multimedia: imagenes.length ? { imagenes } : {},
    claveReferencia: p.property_code || undefined,
  };
}

// Hash determinista del payload (para UPDATE_PENDING cuando cambia la propiedad).
// djb2 doble sobre el JSON con claves ordenadas; suficiente para detección.
export function hashPayload(payload: unknown): string {
  const str = stableStringify(payload);
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = (h1 * 33) ^ c;
    h2 = (h2 * 31) ^ c;
  }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, '0');
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return '{' + Object.keys(obj).sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
    .join(',') + '}';
}
