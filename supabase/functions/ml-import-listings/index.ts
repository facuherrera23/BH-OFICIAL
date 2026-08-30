import { createClient } from 'npm:@supabase/supabase-js@2';
import {
    ML_API,
    fetchWithTimeout,
    getAccessToken,
    getMlCredentials,
    type MlConnectionRow,
    type MlItem,
} from '../_shared/ml.ts';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { MlItemSchema, parseMlResponse } from '../_shared/ml.schemas.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

// ============================================================
// Config
// ============================================================
const IMPORT_BATCH_SIZE = Number(Deno.env.get('ML_IMPORT_BATCH_SIZE') ?? '20');
const FETCH_PAGE_SIZE = 50; // ML API max page size

// ML Status values accepted by /users/{user_id}/items/search
const VALID_STATUSES = ['active', 'paused', 'closed', 'under_review', 'payment_required'] as const;
type MlItemStatus = (typeof VALID_STATUSES)[number];

// ============================================================
// Auth
// ============================================================
async function isAuthorized(req: Request): Promise<boolean> {
    return (await requireAdmin(req, supabase)) !== null;
}

// ============================================================
// Types
// ============================================================
interface ImportFilters {
    status?: MlItemStatus | MlItemStatus[];
    category_id?: string;
    date_from?: string; // ISO date
    date_to?: string;   // ISO date
    limit?: number;
    offset?: number;
}

interface ImportResult {
    total_fetched: number;
    imported: number;
    updated: number;
    skipped: number;
    errors: Array<{ ml_item_id: string; error: string }>;
}

interface PropertyInsertData {
    title: string;
    description: string | null;
    price: number | null;
    currency: string;
    address: string | null;
    area_total: number | null;
    area_covered: number | null;
    bedrooms: number | null;
    bathrooms: number | null;
    garages: number | null;
    listing_type: string;
    status: string;
    latitude: number | null;
    longitude: number | null;
    location_id: string | null;
    amenities: Record<string, unknown>;
    video_url: string | null;
    year_built: number | null;
    expenses: number | null;
    floors: number | null;
    property_type: string | null;
    operation_type: string | null;
}

// ============================================================
// Helpers
// ============================================================
function slugify(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function generatePropertyCode(): number {
    return Math.floor(1000 + Math.random() * 9000);
}

function mapMlStatusToProperty(status: string): string {
    switch (status) {
        case 'active':
        case 'paused':
            return 'publicada';
        case 'closed':
        case 'under_review':
        case 'payment_required':
            return 'borrador';
        default:
            return 'borrador';
    }
}

function mapMlListingType(listingTypeId: string): string {
    // ML listing types: gold_pro, gold_special, gold_premium, free
    switch (listingTypeId) {
        case 'gold_pro':
        case 'gold_premium':
            return 'venta';
        case 'gold_special':
        case 'free':
        default:
            return 'venta';
    }
}

function mapMlOperationType(opType: string | undefined): string | null {
    if (!opType) return null;
    const normalized = opType.toLowerCase();
    if (normalized.includes('venta') || normalized.includes('sell')) return 'venta';
    if (normalized.includes('alquiler') || normalized.includes('rent')) return 'alquiler';
    if (normalized.includes('temporario') || normalized.includes('short')) return 'alquiler_temporario';
    return null;
}

function mapMlPropertyType(propType: string | undefined): string | null {
    if (!propType) return null;
    const normalized = propType.toLowerCase();
    if (normalized.includes('casa') || normalized.includes('house')) return 'casa';
    if (normalized.includes('departamento') || normalized.includes('apartment') || normalized.includes('flat')) return 'departamento';
    if (normalized.includes('ph')) return 'ph';
    if (normalized.includes('terreno') || normalized.includes('land') || normalized.includes('lote')) return 'terreno';
    if (normalized.includes('local') || normalized.includes('comercial') || normalized.includes('commercial')) return 'local_comercial';
    if (normalized.includes('oficina') || normalized.includes('office')) return 'oficina';
    if (normalized.includes('cochera') || normalized.includes('garage') || normalized.includes('parking')) return 'cochera';
    if (normalized.includes('campo') || normalized.includes('farm') || normalized.includes('rural')) return 'campo';
    return null;
}

function extractAttributes(attributes: MlItem['attributes']): Record<string, unknown> {
    if (!attributes) return {};
    const result: Record<string, unknown> = {};
    for (const attr of attributes) {
        if (attr.value_name) {
            result[attr.id] = attr.value_name;
        }
    }
    return result;
}

function extractLocationData(item: MlItem): { latitude: number | null; longitude: number | null; address: string | null; location_id: string | null } {
    const location = (item as Record<string, unknown>).location as Record<string, unknown> | undefined;
    if (!location) return { latitude: null, longitude: null, address: null, location_id: null };

    const latitude = typeof location.latitude === 'number' ? location.latitude : null;
    const longitude = typeof location.longitude === 'number' ? location.longitude : null;
    const address_line = typeof location.address_line === 'string' ? location.address_line : null;
    const neighborhood = typeof location.neighborhood === 'object' && location.neighborhood
        ? (location.neighborhood as Record<string, unknown>).name
        : null;
    const city = typeof location.city === 'object' && location.city
        ? (location.city as Record<string, unknown>).name
        : null;
    const state = typeof location.state === 'object' && location.state
        ? (location.state as Record<string, unknown>).name
        : null;

    const addressParts = [address_line, neighborhood, city, state].filter(Boolean);
    const address = addressParts.length > 0 ? addressParts.join(', ') : null;

    let location_id: string | null = null;
    // TODO: Match with locations table using city/state
    return { latitude, longitude, address, location_id };
}

function extractAreaFromAttributes(attributes: MlItem['attributes'], attrId: string): number | null {
    if (!attributes) return null;
    const attr = attributes.find((a) => a.id === attrId);
    if (!attr?.value_name) return null;
    const num = parseFloat(attr.value_name.replace(/[^0-9.]/g, ''));
    return isNaN(num) ? null : num;
}

function extractIntegerFromAttributes(attributes: MlItem['attributes'], attrId: string): number | null {
    if (!attributes) return null;
    const attr = attributes.find((a) => a.id === attrId);
    if (!attr?.value_name) return null;
    const num = parseInt(attr.value_name.replace(/[^0-9]/g, ''), 10);
    return isNaN(num) ? null : num;
}

function extractRoomsFromAttributes(attributes: MlItem['attributes']): { bedrooms: number | null; bathrooms: number | null; garages: number | null } {
    if (!attributes) return { bedrooms: null, bathrooms: null, garages: null };

    const bedroomAttr = attributes.find((a) => a.id === 'BEDROOMS' || a.id === 'ROOMS');
    const bathroomAttr = attributes.find((a) => a.id === 'FULL_BATHROOMS' || a.id === 'BATHROOMS');
    const garageAttr = attributes.find((a) => a.id === 'GARAGES' || a.id === 'COVERED_PARKING' || a.id === 'PARKING_LOTS');

    return {
        bedrooms: bedroomAttr?.value_name ? parseInt(bedroomAttr.value_name, 10) : null,
        bathrooms: bathroomAttr?.value_name ? parseInt(bathroomAttr.value_name, 10) : null,
        garages: garageAttr?.value_name ? parseInt(garageAttr.value_name, 10) : null,
    };
}

function extractPictures(item: MlItem): string[] {
    if (!item.pictures || item.pictures.length === 0) return [];
    return item.pictures
        .map((p) => p.secure_url || p.url)
        .filter((url): url is string => typeof url === 'string' && url.length > 0);
}

function extractVideoUrl(item: MlItem): string | null {
    const video = (item as Record<string, unknown>).video as Record<string, unknown> | undefined;
    if (!video) return null;
    return (video.url as string | undefined) ?? (video.youtube_url as string | undefined) ?? null;
}

// ============================================================
// ML API Calls
// ============================================================
function buildSearchUrl(
    userId: number,
    offset: number,
    limit: number,
    filters: ImportFilters
): string {
    const params = new URLSearchParams({
        offset: String(offset),
        limit: String(limit),
        order_by: 'date_created',
        order_dir: 'desc',
    });

    // Status filter
    if (filters.status) {
        const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
        params.set('status', statuses.join(','));
    } else {
        params.set('status', 'active,paused,closed,under_review');
    }

    // Category filter
    if (filters.category_id) {
        params.set('category', filters.category_id);
    }

    // Date filters (ML uses date_created_from / date_created_to)
    if (filters.date_from) {
        params.set('date_created_from', filters.date_from);
    }
    if (filters.date_to) {
        params.set('date_created_to', filters.date_to);
    }

    return `${ML_API}/users/${userId}/items/search?${params.toString()}`;
}

async function fetchUserItems(
    accessToken: string,
    userId: number,
    offset = 0,
    limit = FETCH_PAGE_SIZE,
    filters: ImportFilters = {}
): Promise<{ results: string[]; paging: { total: number; offset: number; limit: number } }> {
    const url = buildSearchUrl(userId, offset, limit, filters);
    const res = await fetchWithTimeout(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`ML items search falló (${res.status}): ${text.slice(0, 300)}`);
    }
    return await res.json();
}

async function fetchItemDetails(accessToken: string, itemId: string): Promise<MlItem> {
    const res = await fetchWithTimeout(`${ML_API}/items/${itemId}`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`ML get item ${itemId} falló (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    return parseMlResponse(MlItemSchema, data, `get item ${itemId}`);
}

async function fetchItemDescription(accessToken: string, itemId: string): Promise<string | null> {
    try {
        const res = await fetchWithTimeout(`${ML_API}/items/${itemId}/description`, {
            headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.plain_text ?? null;
    } catch {
        return null;
    }
}

// ============================================================
// Mapper: ML Item -> Property Insert (AVANZADO)
// ============================================================
function mapMlItemToProperty(item: MlItem, description: string | null): PropertyInsertData {
    const attrs = item.attributes ?? [];
    const rooms = extractRoomsFromAttributes(attrs);
    const loc = extractLocationData(item);
    const pictures = extractPictures(item);
    const videoUrl = extractVideoUrl(item);

    // Advanced attribute extraction
    const antiquity = extractIntegerFromAttributes(attrs, 'ANTIQUITY'); // years
    const totalArea = extractAreaFromAttributes(attrs, 'TOTAL_AREA');
    const coveredArea = extractAreaFromAttributes(attrs, 'COVERED_AREA');
    const floors = extractIntegerFromAttributes(attrs, 'FLOORS');
    const operationType = attrs.find((a) => a.id === 'OPERATION_TYPE' || a.id === 'OPERATION')?.value_name;
    const propertyType = attrs.find((a) => a.id === 'PROPERTY_TYPE' || a.id === 'TYPE')?.value_name;
    const parkingLots = extractIntegerFromAttributes(attrs, 'PARKING_LOTS');

    return {
        title: item.title.slice(0, 200),
        description: description ?? item.description ?? null,
        price: item.price,
        currency: item.currency_id ?? 'ARS',
        address: loc.address,
        area_total: totalArea ?? coveredArea,
        area_covered: coveredArea,
        bedrooms: rooms.bedrooms,
        bathrooms: rooms.bathrooms,
        garages: rooms.garages ?? parkingLots,
        listing_type: mapMlListingType(item.listing_type_id),
        status: mapMlStatusToProperty(item.status),
        latitude: loc.latitude,
        longitude: loc.longitude,
        location_id: loc.location_id,
        amenities: extractAttributes(attrs),
        video_url: videoUrl,
        year_built: antiquity ? new Date().getFullYear() - antiquity : null,
        expenses: null,
        floors,
        property_type: mapMlPropertyType(propertyType),
        operation_type: mapMlOperationType(operationType),
    };
}

// ============================================================
// Preview Data (lighter than full import)
// ============================================================
interface PreviewItem {
    ml_item_id: string;
    title: string;
    price: number;
    currency_id: string;
    status: string;
    permalink: string;
    thumbnail: string | null;
    category_id: string | null;
    listing_type_id: string;
    date_created: string;
    pictures_count: number;
    has_video: boolean;
}

function mapMlItemToPreview(item: MlItem): PreviewItem {
    return {
        ml_item_id: item.id,
        title: item.title,
        price: item.price,
        currency_id: item.currency_id ?? 'ARS',
        status: item.status,
        permalink: item.permalink,
        thumbnail: item.pictures?.[0]?.secure_url ?? item.pictures?.[0]?.url ?? null,
        category_id: (item as Record<string, unknown>).category_id as string | null,
        listing_type_id: item.listing_type_id,
        date_created: (item as Record<string, unknown>).date_created as string ?? new Date().toISOString(),
        pictures_count: item.pictures?.length ?? 0,
        has_video: !!((item as Record<string, unknown>).video),
    };
}

// ============================================================
// Database Operations
// ============================================================
async function upsertPropertyAndMeta(
    propertyData: PropertyInsertData,
    mlItemId: string,
    mlItemData: MlItem,
    createdBy: string,
): Promise<{ propertyId: string; action: 'inserted' | 'updated' }> {
    // Check if property_ml_meta already exists for this ml_item_id
    const { data: existingMeta } = await supabase
        .from('property_ml_meta')
        .select('property_id')
        .eq('ml_item_id', mlItemId)
        .maybeSingle();

    if (existingMeta) {
        // Update existing property
        const { error: updateError } = await supabase
            .from('properties')
            .update({
                ...propertyData,
                slug: `${slugify(propertyData.title)}-${existingMeta.property_id.slice(0, 8)}`,
                updated_at: new Date().toISOString(),
            })
            .eq('id', existingMeta.property_id);

        if (updateError) throw new Error(`Error actualizando property: ${updateError.message}`);

        // Update property_ml_meta
        const { error: metaError } = await supabase
            .from('property_ml_meta')
            .update({
                status: mlItemData.status,
                price: mlItemData.price,
                permalink: mlItemData.permalink,
                category_id: (mlItemData as Record<string, unknown>).category_id as string | null,
                listing_type_id: parseInt(mlItemData.listing_type_id.replace(/\D/g, ''), 10) || null,
                raw: mlItemData as unknown as Record<string, unknown>,
                last_sync_at: new Date().toISOString(),
                last_sync_status: 'success',
                updated_at: new Date().toISOString(),
            })
            .eq('ml_item_id', mlItemId);

        if (metaError) throw new Error(`Error actualizando property_ml_meta: ${metaError.message}`);

        return { propertyId: existingMeta.property_id, action: 'updated' };
    }

    // Create new property
    const propertyCode = generatePropertyCode();
    const slug = `${slugify(propertyData.title)}-${propertyCode}`;

    const { data: property, error: propError } = await supabase
        .from('properties')
        .insert({
            ...propertyData,
            code: propertyCode,
            slug,
            created_by: createdBy,
            favorites_count: 0,
            views_count: 0,
            featured: false,
        })
        .select('id')
        .single();

    if (propError) throw new Error(`Error insertando property: ${propError.message}`);

    // Insert property_ml_meta
    const { error: metaError } = await supabase
        .from('property_ml_meta')
        .insert({
            property_id: property.id,
            ml_item_id: mlItemId,
            status: mlItemData.status,
            price: mlItemData.price,
            permalink: mlItemData.permalink,
            category_id: (mlItemData as Record<string, unknown>).category_id as string | null,
            listing_type_id: parseInt(mlItemData.listing_type_id.replace(/\D/g, ''), 10) || null,
            raw: mlItemData as unknown as Record<string, unknown>,
            last_sync_at: new Date().toISOString(),
            last_sync_status: 'success',
        });

    if (metaError) throw new Error(`Error insertando property_ml_meta: ${metaError.message}`);

    return { propertyId: property.id, action: 'inserted' };
}

// ============================================================
// Main Handler
// ============================================================
Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return optionsResponse();

    if (!await isAuthorized(req)) {
        return jsonResponse({ error: 'No autorizado' }, 401);
    }

    // Rate limit
    const rateLimit = await checkRateLimit(req, 'ml-import-listings', 10, 60000);
    if (!rateLimit.allowed) {
        return jsonResponse({ error: 'Rate limit excedido', retry_after: rateLimit.retryAfter }, 429);
    }

    const body = await req.json().catch(() => ({}));
    const {
        limit = IMPORT_BATCH_SIZE,
        offset = 0,
        status,
        category_id,
        date_from,
        date_to,
        preview_only = false,
        preview_limit = 100,
        selected_ids,
    } = body;

    const filters: ImportFilters = {
        status: status as ImportFilters['status'],
        category_id,
        date_from,
        date_to,
        limit,
        offset,
    };

    try {
        // Get active ML connection
        const { data: conn, error: connError } = await supabase
            .from('ml_connection')
            .select('*')
            .eq('is_active', true)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (connError) throw new Error(`Error leyendo conexión ML: ${connError.message}`);
        if (!conn) return jsonResponse({ error: 'No hay conexión ML activa. Conectá la cuenta primero.' }, 400);

        const connection = conn as MlConnectionRow;
        const accessToken = await getAccessToken(supabase, connection);

        // Get ML user info to get user_id
        const userRes = await fetchWithTimeout(`${ML_API}/users/me`, {
            headers: { authorization: `Bearer ${accessToken}` },
        });
        if (!userRes.ok) throw new Error('No se pudo obtener usuario ML');
        const userData = await userRes.json();
        const mlUserId = userData.id as number;

        // Selected IDs mode: import specific items by ml_item_id
        if (selected_ids && Array.isArray(selected_ids) && selected_ids.length > 0) {
            const result: ImportResult = {
                total_fetched: selected_ids.length,
                imported: 0,
                updated: 0,
                skipped: 0,
                errors: [],
            };

            for (const itemId of selected_ids) {
                try {
                    const [itemDetails, description] = await Promise.all([
                        fetchItemDetails(accessToken, itemId),
                        fetchItemDescription(accessToken, itemId),
                    ]);

                    const propertyData = mapMlItemToProperty(itemDetails, description);
                    const { action } = await upsertPropertyAndMeta(propertyData, itemId, itemDetails, connection.id);

                    if (action === 'inserted') result.imported++;
                    else result.updated++;
                } catch (err) {
                    result.errors.push({ ml_item_id: itemId, error: err instanceof Error ? err.message : 'Error desconocido' });
                    result.skipped++;
                }
            }

            return jsonResponse({
                ...result,
                has_more: false,
                total_available: selected_ids.length,
                next_offset: 0,
            });
        }

        // Preview mode: fetch items and return light preview data without importing
        if (preview_only) {
            let totalFetched = 0;
            const previews: PreviewItem[] = [];
            let currentOffset = offset;
            const maxPreview = Math.min(preview_limit, 500); // Cap preview at 500

            while (totalFetched < maxPreview) {
                const searchResult = await fetchUserItems(accessToken, mlUserId, currentOffset, Math.min(FETCH_PAGE_SIZE, maxPreview - totalFetched), filters);
                const itemIds = searchResult.results ?? [];

                if (itemIds.length === 0) break;

                // Fetch details for preview (batched)
                for (const itemId of itemIds) {
                    if (previews.length >= maxPreview) break;
                    try {
                        const itemDetails = await fetchItemDetails(accessToken, itemId);
                        previews.push(mapMlItemToPreview(itemDetails));
                    } catch {
                        // Skip failed items in preview
                    }
                }

                totalFetched += itemIds.length;
                currentOffset += itemIds.length;

                if (!searchResult.paging || itemIds.length < FETCH_PAGE_SIZE) break;
            }

            return jsonResponse({
                mode: 'preview',
                items: previews,
                total_previewed: previews.length,
                total_available: previews.length, // Approximate; real total needs separate count call
                has_more: previews.length >= maxPreview,
                filters_applied: filters,
            });
        }

        // Full import mode
        const searchResult = await fetchUserItems(accessToken, mlUserId, offset, limit, filters);
        const itemIds = searchResult.results ?? [];

        if (itemIds.length === 0) {
            return jsonResponse({
                total_fetched: 0,
                imported: 0,
                updated: 0,
                skipped: 0,
                errors: [],
                has_more: false,
                total_available: searchResult.paging?.total ?? 0,
            });
        }

        // Process each item
        const result: ImportResult = {
            total_fetched: itemIds.length,
            imported: 0,
            updated: 0,
            skipped: 0,
            errors: [],
        };

        for (const itemId of itemIds) {
            try {
                const [itemDetails, description] = await Promise.all([
                    fetchItemDetails(accessToken, itemId),
                    fetchItemDescription(accessToken, itemId),
                ]);

                const propertyData = mapMlItemToProperty(itemDetails, description);
                const { action } = await upsertPropertyAndMeta(propertyData, itemId, itemDetails, connection.id);

                if (action === 'inserted') result.imported++;
                else result.updated++;
            } catch (err) {
                result.errors.push({ ml_item_id: itemId, error: err instanceof Error ? err.message : 'Error desconocido' });
                result.skipped++;
            }
        }

        return jsonResponse({
            ...result,
            has_more: (offset + itemIds.length) < (searchResult.paging?.total ?? 0),
            total_available: searchResult.paging?.total ?? 0,
            next_offset: offset + itemIds.length,
        });
    } catch (err) {
        console.error('[ml-import-listings] Error:', err);
        return jsonResponse({ error: err instanceof Error ? err.message : 'Error interno' }, 500);
    }
});