import { createClient } from 'npm:@supabase/supabase-js@2';
import {
    ML_API,
    fetchWithTimeout,
    getAccessToken,
    setMlCooldown,
    type MlConnectionRow,
    type MlItem,
} from '../_shared/ml.ts';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';
import {
    MlItemSchema,
    type MlItemPayload,
    parseMlResponse,
} from '../_shared/ml.schemas.ts';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
);

interface PropertyRow {
    id: string;
    title: string;
    description: string | null;
    listing_type: string;
    price: number | null;
    currency: string;
    address: string | null;
    area_total: number | null;
    area_covered: number | null;
    bedrooms: number | null;
    bathrooms: number | null;
    garages: number | null;
    property_type: string | null;
    rooms: number | null;
    full_bathrooms: number | null;
    pets_allowed: boolean | null;
    has_storage: boolean | null;
    furnished: boolean | null;
    maintenance_fee: number | null;
    inscription_number: string | null;
    images: { url: string; storage_path?: string }[];
}

interface MlDefaults {
    category_id: string;
    listing_type_id: string;
    condition: string;
}

async function fetchProperty(id: string): Promise<PropertyRow | null> {
    const { data: property } = await supabase
        .from('properties')
        .select(
            'id, title, description, listing_type, price, price_usd, price_currency, currency, address, area_total, area_covered, surface_total, surface_covered, bedrooms, bathrooms, garages, property_type, rooms, full_bathrooms, pets_allowed, has_storage, furnished, maintenance_fee, inscription_number, image_urls',
        )
        .eq('id', id)
        .maybeSingle();

    if (!property) return null;

    const { data: relImages } = await supabase
        .from('property_images')
        .select('url, storage_path, position')
        .eq('property_id', id)
        .order('position', { ascending: true });

    const images: { url: string; storage_path?: string }[] =
        relImages && relImages.length > 0
            ? relImages.map((img) => ({ url: img.url, storage_path: img.storage_path ?? undefined }))
            : ((property.image_urls ?? []) as string[]).map((url) => ({ url }));

    return {
        id: property.id,
        title: property.title,
        description: property.description,
        listing_type: property.listing_type ?? 'venta',
        price: property.price ?? property.price_usd ?? null,
        currency: property.currency ?? property.price_currency ?? 'USD',
        address: property.address,
        area_total: property.area_total ?? property.surface_total ?? null,
        area_covered: property.area_covered ?? property.surface_covered ?? null,
        bedrooms: property.bedrooms,
        bathrooms: property.bathrooms,
        garages: property.garages,
        property_type: property.property_type,
        rooms: property.rooms,
        full_bathrooms: property.full_bathrooms,
        pets_allowed: property.pets_allowed,
        has_storage: property.has_storage,
        furnished: property.furnished,
        maintenance_fee: property.maintenance_fee,
        inscription_number: property.inscription_number,
        images,
    };
}

async function fetchDefaults(): Promise<MlDefaults> {
    const { data } = await supabase
        .from('site_settings')
        .select('value')
        .eq('key', 'ml_defaults')
        .maybeSingle();
    const value = data?.value ?? {};
    return {
        category_id: String(value.category_id ?? ''),
        listing_type_id: String(value.listing_type_id ?? 'silver'),
        condition: String(value.condition ?? 'not_specified'),
    };
}

async function prepareImagesForML(
    accessToken: string,
    images: { url: string; storage_path?: string }[],
): Promise<string[]> {
    const withStorage = images
        .slice(0, 12)
        .filter((i): i is { url: string; storage_path: string } => !!i.storage_path);
    const directUrls = images
        .slice(0, 12)
        .filter((i) => !i.storage_path)
        .map((i) => i.url);

    if (withStorage.length === 0 && directUrls.length === 0) return [];

    const downloadUpload = async (img: { storage_path: string }) => {
        try {
            const { data: fileData, error } = await supabase.storage
                .from('property-images')
                .download(img.storage_path);
            if (error || !fileData) return null;

            const uint8Array = new Uint8Array(await fileData.arrayBuffer());
            const ext = img.storage_path.split('.').pop()?.toLowerCase();
            const contentType =
                ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

            const formData = new FormData();
            const blob = new Blob([uint8Array], { type: contentType });
            const safeName = `image_${crypto.randomUUID()}.${ext || 'jpg'}`;
            formData.append('file', blob, safeName);

            const uploadRes = await fetchWithTimeout(`${ML_API}/pictures`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}` },
                body: formData,
            });

            if (!uploadRes.ok) return null;
            const uploadData = await uploadRes.json();
            const variations = (uploadData as { variations?: Array<{ id?: string; url?: string }> })
                .variations ?? [];
            const mainVariation = variations.find((v) => v.id === 'original') ?? variations[0];
            return mainVariation?.url ?? null;
        } catch {
            return null;
        }
    };

    const results = await Promise.allSettled(withStorage.map(downloadUpload));
    const urls: string[] = [];
    results.forEach((r) => {
        if (r.status === 'fulfilled' && r.value) urls.push(r.value);
    });
    urls.push(...directUrls);
    return urls.slice(0, 12);
}

function buildItemPayload(property: PropertyRow, defaults: MlDefaults): MlItemPayload {
    const operationLabel = property.listing_type === 'venta' ? 'Venta' : 'Alquiler';
    const propertyType = property.property_type ?? 'Departamento';
    const roomsLabel = property.rooms ?? property.bedrooms ?? 1;
    const location = property.address?.split(',')[0]?.trim() ?? '';
    const mlTitle =
        `${operationLabel} ${propertyType} ${roomsLabel} amb. ${location || 'Salta'}`.slice(0, 60);

    const attributes: Array<{ id: string; value_name: string }> = [
        { id: 'OPERATION', value_name: operationLabel },
        { id: 'PROPERTY_TYPE', value_name: propertyType },
        { id: 'ROOMS', value_name: String(property.rooms ?? property.bedrooms ?? 1) },
    ];

    if (property.bedrooms !== null)
        attributes.push({ id: 'BEDROOMS', value_name: String(property.bedrooms) });
    if (property.full_bathrooms !== null)
        attributes.push({ id: 'FULL_BATHROOMS', value_name: String(property.full_bathrooms) });
    if (property.bathrooms !== null)
        attributes.push({ id: 'BATHROOMS', value_name: String(property.bathrooms) });
    if (property.area_covered !== null)
        attributes.push({ id: 'COVERED_AREA', value_name: String(property.area_covered) });
    if (property.area_total !== null)
        attributes.push({ id: 'TOTAL_AREA', value_name: String(property.area_total) });
    if (property.pets_allowed !== null) {
        attributes.push({ id: 'PETS', value_name: property.pets_allowed ? 'SÃ­' : 'No' });
        attributes.push({
            id: 'IS_SUITABLE_FOR_PETS',
            value_name: property.pets_allowed ? 'SÃ­' : 'No',
        });
    }
    if (property.garages !== null && property.garages > 0)
        attributes.push({ id: 'PARKING_LOTS', value_name: String(property.garages) });
    if (property.has_storage !== null)
        attributes.push({ id: 'STORAGE', value_name: property.has_storage ? 'SÃ­' : 'No' });
    if (property.furnished !== null)
        attributes.push({ id: 'FURNISHED', value_name: property.furnished ? 'SÃ­' : 'No' });
    if (property.maintenance_fee !== null) {
        attributes.push({ id: 'MAINTENANCE_FEE', value_name: String(property.maintenance_fee) });
        attributes.push({ id: 'COMMON_EXPENSES', value_name: String(property.maintenance_fee) });
    }
    if (property.inscription_number)
        attributes.push({ id: 'INSCRIPTION_NUMBER', value_name: property.inscription_number });

    const payload: MlItemPayload = {
        title: mlTitle,
        price: Number(property.price),
        currency_id: property.currency,
        available_quantity: 1,
        buying_mode: 'classified',
        condition: ['new', 'used'].includes(defaults.condition)
            ? (defaults.condition as 'new' | 'used')
            : 'not_specified',
        channels: ['marketplace'],
        attributes,
        location: property.address ? { address_line: property.address } : undefined,
    };
    if (defaults.category_id) payload.category_id = defaults.category_id;
    if (defaults.listing_type_id) payload.listing_type_id = defaults.listing_type_id;
    return payload;
}

async function createMlItem(
    accessToken: string,
    payload: MlItemPayload,
): Promise<MlItem> {
    const res = await fetchWithTimeout(`${ML_API}/items`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ML createItem failed (${res.status}): ${text.slice(0, 300)}`);
    return parseMlResponse(MlItemSchema, JSON.parse(text), 'mlCreateItem');
}

async function updateMlItem(
    accessToken: string,
    itemId: string,
    payload: Record<string, unknown>,
): Promise<MlItem> {
    const res = await fetchWithTimeout(`${ML_API}/items/${itemId}`, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ML updateItem failed (${res.status}): ${text.slice(0, 300)}`);
    return parseMlResponse(MlItemSchema, JSON.parse(text), 'mlUpdateItem');
}

async function setDescription(
    accessToken: string,
    itemId: string,
    plainText: string,
): Promise<void> {
    const res = await fetchWithTimeout(`${ML_API}/items/${itemId}/description`, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({ plain_text: plainText.slice(0, 20000) }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`ML setDescription failed (${res.status}): ${text.slice(0, 300)}`);
    }
}

async function closeMlItem(accessToken: string, itemId: string): Promise<MlItem> {
    return await updateMlItem(accessToken, itemId, { status: 'closed' });
}

async function getActiveConnection(): Promise<MlConnectionRow | null> {
    const { data } = await supabase
        .from('ml_connection')
        .select(
            'id, access_token_encrypted, access_token_iv, refresh_token_encrypted, refresh_token_iv, token_expires_at',
        )
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1);
    return (data?.[0] ?? null) as MlConnectionRow | null;
}

async function upsertListing(args: {
    propertyId: string;
    mlItemId: string;
    mlStatus: string;
    permalink: string | null;
    price: number | null;
    title: string;
    listingType: string;
}): Promise<void> {
    const { data: existing } = await supabase
        .from('ml_listings')
        .select('id')
        .eq('property_id', args.propertyId)
        .maybeSingle();

    if (existing?.id) {
        await supabase
            .from('ml_listings')
            .update({
                ml_item_id: args.mlItemId,
                status: args.mlStatus,
                permalink: args.permalink,
                price: args.price,
                last_synced_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id);
    } else {
        await supabase.from('ml_listings').insert({
            property_id: args.propertyId,
            ml_item_id: args.mlItemId,
            status: args.mlStatus,
            permalink: args.permalink,
            price: args.price,
            title: args.title,
            listing_type: args.listingType,
            last_synced_at: new Date().toISOString(),
        });
    }

    await supabase.from('property_ml_meta').upsert(
        {
            property_id: args.propertyId,
            ml_item_id: args.mlItemId,
            updated_at: new Date().toISOString(),
        },
        { onConflict: 'property_id' },
    );
}

async function auditLog(entry: {
    userId: string;
    action: string;
    propertyId?: string;
    mlItemId?: string;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    await supabase.from('audit_log').insert({
        action: entry.action,
        module: 'portales',
        entity_type: 'ml_listing',
        entity_id: entry.propertyId ?? null,
        entity_label: entry.mlItemId ?? null,
        actor_id: entry.userId,
        metadata: entry.metadata ?? {},
    });
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);

    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);

    const rl = await rateLimitMiddleware('ml-publish', req);
    if (rl) return rl;

    const token = await requireAdmin(req, supabase);
    if (!token) return respond(401, { error: 'No autorizado' });

    const { data: userData } = await supabase.auth.getUser(token);
    const adminId = userData?.user?.id;
    if (!adminId) return respond(401, { error: 'No autorizado' });

    let body: { action?: unknown; property_id?: unknown; listing_id?: unknown };
    try {
        body = await req.json();
    } catch {
        return respond(400, { error: 'JSON invÃ¡lido' });
    }

    const action = typeof body.action === 'string' ? body.action : '';
    const propertyId = typeof body.property_id === 'string' ? body.property_id : '';
    const listingIdHint = typeof body.listing_id === 'string' ? body.listing_id : '';

    if (!['create', 'update', 'remove'].includes(action)) {
        return respond(400, { error: 'action debe ser create, update o remove' });
    }
    if (!propertyId) {
        return respond(400, { error: 'property_id requerido' });
    }

    const conn = await getActiveConnection();
    if (!conn) return respond(400, { error: 'No hay cuenta de Mercado Libre conectada' });

    let accessToken: string;
    try {
        accessToken = await getAccessToken(supabase, conn);
    } catch (err) {
        return respond(429, {
            error: 'No se pudo refrescar el token de Mercado Libre',
            detail: (err as Error).message,
        });
    }

    const property = await fetchProperty(propertyId);
    if (!property) return respond(404, { error: 'Propiedad no encontrada' });

    try {
        if (action === 'create') {
            if (property.price === null || property.price <= 0) {
                return respond(400, { error: 'La propiedad debe tener un precio vÃ¡lido' });
            }
            const defaults = await fetchDefaults();
            if (!defaults.category_id || !defaults.listing_type_id) {
                return respond(400, {
                    error: 'Falta configurar ml_defaults (category_id, listing_type_id)',
                });
            }

            const mlImageUrls = await prepareImagesForML(accessToken, property.images);
            if (mlImageUrls.length === 0) {
                return respond(400, {
                    error: 'Mercado Libre requiere al menos una imagen vÃ¡lida. SubÃ­ fotos a la propiedad.',
                });
            }

            const payload = buildItemPayload(property, defaults);
            payload.pictures = mlImageUrls.map((url) => ({ source: url }));

            const item = await createMlItem(accessToken, payload);
            await setDescription(accessToken, item.id, property.description ?? property.title);

            await upsertListing({
                propertyId,
                mlItemId: item.id,
                mlStatus: item.status,
                permalink: item.permalink ?? null,
                price: item.price ?? null,
                title: item.title ?? property.title,
                listingType: property.listing_type,
            });

            await auditLog({
                userId: adminId,
                action: 'ml_publish',
                propertyId,
                mlItemId: item.id,
                metadata: { event: 'publish_create', permalink: item.permalink },
            });

            return respond(200, {
                ok: true,
                action: 'create',
                listing_id: item.id,
                permalink: item.permalink,
                status: item.status,
            });
        }

        if (action === 'update' || action === 'remove') {
            let mlItemId = listingIdHint;
            if (!mlItemId) {
                const { data: row } = await supabase
                    .from('ml_listings')
                    .select('ml_item_id')
                    .eq('property_id', propertyId)
                    .maybeSingle();
                mlItemId = row?.ml_item_id ?? '';
            }
            if (!mlItemId) {
                return respond(400, {
                    error: 'La propiedad no tiene publicaciÃ³n en Mercado Libre',
                });
            }

            if (action === 'remove') {
                const item = await closeMlItem(accessToken, mlItemId);
                await supabase
                    .from('ml_listings')
                    .update({
                        status: item.status,
                        last_synced_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    })
                    .eq('ml_item_id', mlItemId);

                await auditLog({
                    userId: adminId,
                    action: 'ml_publish',
                    propertyId,
                    mlItemId,
                    metadata: { event: 'publish_close' },
                });

                return respond(200, {
                    ok: true,
                    action: 'remove',
                    listing_id: mlItemId,
                    status: item.status,
                });
            }

            // update
            const defaults = await fetchDefaults();
            const payload = buildItemPayload(property, defaults);
            const mlImageUrls = await prepareImagesForML(accessToken, property.images);
            if (mlImageUrls.length > 0) {
                payload.pictures = mlImageUrls.map((url) => ({ source: url }));
            }

            const item = await updateMlItem(accessToken, mlItemId, payload as Record<string, unknown>);
            if (property.description) {
                await setDescription(accessToken, item.id, property.description);
            }

            await upsertListing({
                propertyId,
                mlItemId: item.id,
                mlStatus: item.status,
                permalink: item.permalink ?? null,
                price: item.price ?? null,
                title: item.title ?? property.title,
                listingType: property.listing_type,
            });

            await auditLog({
                userId: adminId,
                action: 'ml_publish',
                propertyId,
                mlItemId,
                metadata: { event: 'publish_update' },
            });

            return respond(200, {
                ok: true,
                action: 'update',
                listing_id: mlItemId,
                permalink: item.permalink,
                status: item.status,
            });
        }

        return respond(400, { error: 'AcciÃ³n invÃ¡lida' });
    } catch (err) {
        const message = (err as Error).message;
        const is429 = message.includes('429') || message.toLowerCase().includes('rate limit');
        if (is429) {
            await setMlCooldown(supabase, conn.id, 'publish_429', 60_000);
        }
        await auditLog({
            userId: adminId,
            action: 'ml_publish_failed',
            propertyId,
            mlItemId: '',
            metadata: { event: action, error: message },
        });
        return respond(is429 ? 429 : 500, { error: message });
    }
});
