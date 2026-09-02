import { createClient } from 'npm:@supabase/supabase-js@2';\r
import {\r
    ML_API,\r
    fetchWithTimeout,\r
    getAccessToken,\r
    setMlCooldown,\r
    type MlConnectionRow,\r
    type MlItem,\r
} from '../_shared/ml.ts';\r
import { jsonResponse, optionsResponse } from '../_shared/http.ts';\r
import { requireAdmin } from '../_shared/auth.ts';\r
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';\r
import {\r
    MlItemSchema,\r
    type MlItemPayload,\r
    parseMlResponse,\r
} from '../_shared/ml.schemas.ts';\r
\r
const supabase = createClient(\r
    Deno.env.get('SUPABASE_URL') ?? '',\r
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',\r
    { auth: { persistSession: false } },\r
);\r
\r
interface PropertyRow {\r
    id: string;\r
    title: string;\r
    description: string | null;\r
    listing_type: string;\r
    price: number | null;\r
    currency: string;\r
    address: string | null;\r
    area_total: number | null;\r
    area_covered: number | null;\r
    bedrooms: number | null;\r
    bathrooms: number | null;\r
    garages: number | null;\r
    property_type: string | null;\r
    rooms: number | null;\r
    full_bathrooms: number | null;\r
    pets_allowed: boolean | null;\r
    has_storage: boolean | null;\r
    furnished: boolean | null;\r
    maintenance_fee: number | null;\r
    inscription_number: string | null;\r
    images: { url: string; storage_path?: string }[];\r
}\r
\r
interface MlDefaults {\r
    category_id: string;\r
    listing_type_id: string;\r
    condition: string;\r
}\r
\r
async function fetchProperty(id: string): Promise<PropertyRow | null> {\r
    const { data: property } = await supabase\r
        .from('properties')\r
        .select(\r
            'id, title, description, listing_type, price, price_usd, price_currency, currency, address, area_total, area_covered, surface_total, surface_covered, bedrooms, bathrooms, garages, property_type, rooms, full_bathrooms, pets_allowed, has_storage, furnished, maintenance_fee, inscription_number, image_urls',\r
        )\r
        .eq('id', id)\r
        .maybeSingle();\r
\r
    if (!property) return null;\r
\r
    const { data: relImages } = await supabase\r
        .from('property_images')\r
        .select('url, storage_path, position')\r
        .eq('property_id', id)\r
        .order('position', { ascending: true });\r
\r
    const images: { url: string; storage_path?: string }[] =\r
        relImages && relImages.length > 0\r
            ? relImages.map((img) => ({ url: img.url, storage_path: img.storage_path ?? undefined }))\r
            : ((property.image_urls ?? []) as string[]).map((url) => ({ url }));\r
\r
    return {\r
        id: property.id,\r
        title: property.title,\r
        description: property.description,\r
        listing_type: property.listing_type ?? 'venta',\r
        price: property.price ?? property.price_usd ?? null,\r
        currency: property.currency ?? property.price_currency ?? 'USD',\r
        address: property.address,\r
        area_total: property.area_total ?? property.surface_total ?? null,\r
        area_covered: property.area_covered ?? property.surface_covered ?? null,\r
        bedrooms: property.bedrooms,\r
        bathrooms: property.bathrooms,\r
        garages: property.garages,\r
        property_type: property.property_type,\r
        rooms: property.rooms,\r
        full_bathrooms: property.full_bathrooms,\r
        pets_allowed: property.pets_allowed,\r
        has_storage: property.has_storage,\r
        furnished: property.furnished,\r
        maintenance_fee: property.maintenance_fee,\r
        inscription_number: property.inscription_number,\r
        images,\r
    };\r
}\r
\r
async function fetchDefaults(): Promise<MlDefaults> {\r
    const { data } = await supabase\r
        .from('site_settings')\r
        .select('value')\r
        .eq('key', 'ml_defaults')\r
        .maybeSingle();\r
    const value = data?.value ?? {};\r
    return {\r
        category_id: String(value.category_id ?? ''),\r
        listing_type_id: String(value.listing_type_id ?? 'silver'),\r
        condition: String(value.condition ?? 'not_specified'),\r
    };\r
}\r
\r
async function prepareImagesForML(\r
    accessToken: string,\r
    images: { url: string; storage_path?: string }[],\r
): Promise<string[]> {\r
    const withStorage = images\r
        .slice(0, 12)\r
        .filter((i): i is { url: string; storage_path: string } => !!i.storage_path);\r
    const directUrls = images\r
        .slice(0, 12)\r
        .filter((i) => !i.storage_path)\r
        .map((i) => i.url);\r
\r
    if (withStorage.length === 0 && directUrls.length === 0) return [];\r
\r
    const downloadUpload = async (img: { storage_path: string }) => {\r
        try {\r
            const { data: fileData, error } = await supabase.storage\r
                .from('property-images')\r
                .download(img.storage_path);\r
            if (error || !fileData) return null;\r
\r
            const uint8Array = new Uint8Array(await fileData.arrayBuffer());\r
            const ext = img.storage_path.split('.').pop()?.toLowerCase();\r
            const contentType =\r
                ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';\r
\r
            const formData = new FormData();\r
            const blob = new Blob([uint8Array], { type: contentType });\r
            const safeName = `image_${crypto.randomUUID()}.${ext || 'jpg'}`;\r
            formData.append('file', blob, safeName);\r
\r
            const uploadRes = await fetchWithTimeout(`${ML_API}/pictures`, {\r
                method: 'POST',\r
                headers: { Authorization: `Bearer ${accessToken}` },\r
                body: formData,\r
            });\r
\r
            if (!uploadRes.ok) return null;\r
            const uploadData = await uploadRes.json();\r
            const variations = (uploadData as { variations?: Array<{ id?: string; url?: string }> })\r
                .variations ?? [];\r
            const mainVariation = variations.find((v) => v.id === 'original') ?? variations[0];\r
            return mainVariation?.url ?? null;\r
        } catch {\r
            return null;\r
        }\r
    };\r
\r
    const results = await Promise.allSettled(withStorage.map(downloadUpload));\r
    const urls: string[] = [];\r
    results.forEach((r) => {\r
        if (r.status === 'fulfilled' && r.value) urls.push(r.value);\r
    });\r
    urls.push(...directUrls);\r
    return urls.slice(0, 12);\r
}\r
\r
function buildItemPayload(property: PropertyRow, defaults: MlDefaults): MlItemPayload {\r
    const operationLabel = property.listing_type === 'venta' ? 'Venta' : 'Alquiler';\r
    const propertyType = property.property_type ?? 'Departamento';\r
    const roomsLabel = property.rooms ?? property.bedrooms ?? 1;\r
    const location = property.address?.split(',')[0]?.trim() ?? '';\r
    const mlTitle =\r
        `${operationLabel} ${propertyType} ${roomsLabel} amb. ${location || 'Salta'}`.slice(0, 60);\r
\r
    const attributes: Array<{ id: string; value_name: string }> = [\r
        { id: 'OPERATION', value_name: operationLabel },\r
        { id: 'PROPERTY_TYPE', value_name: propertyType },\r
        { id: 'ROOMS', value_name: String(property.rooms ?? property.bedrooms ?? 1) },\r
    ];\r
\r
    if (property.bedrooms !== null)\r
        attributes.push({ id: 'BEDROOMS', value_name: String(property.bedrooms) });\r
    if (property.full_bathrooms !== null)\r
        attributes.push({ id: 'FULL_BATHROOMS', value_name: String(property.full_bathrooms) });\r
    if (property.bathrooms !== null)\r
        attributes.push({ id: 'BATHROOMS', value_name: String(property.bathrooms) });\r
    if (property.area_covered !== null)\r
        attributes.push({ id: 'COVERED_AREA', value_name: String(property.area_covered) });\r
    if (property.area_total !== null)\r
        attributes.push({ id: 'TOTAL_AREA', value_name: String(property.area_total) });\r
    if (property.pets_allowed !== null) {\r
        attributes.push({ id: 'PETS', value_name: property.pets_allowed ? 'Sí' : 'No' });\r
        attributes.push({\r
            id: 'IS_SUITABLE_FOR_PETS',\r
            value_name: property.pets_allowed ? 'Sí' : 'No',\r
        });\r
    }\r
    if (property.garages !== null && property.garages > 0)\r
        attributes.push({ id: 'PARKING_LOTS', value_name: String(property.garages) });\r
    if (property.has_storage !== null)\r
        attributes.push({ id: 'STORAGE', value_name: property.has_storage ? 'Sí' : 'No' });\r
    if (property.furnished !== null)\r
        attributes.push({ id: 'FURNISHED', value_name: property.furnished ? 'Sí' : 'No' });\r
    if (property.maintenance_fee !== null) {\r
        attributes.push({ id: 'MAINTENANCE_FEE', value_name: String(property.maintenance_fee) });\r
        attributes.push({ id: 'COMMON_EXPENSES', value_name: String(property.maintenance_fee) });\r
    }\r
    if (property.inscription_number)\r
        attributes.push({ id: 'INSCRIPTION_NUMBER', value_name: property.inscription_number });\r
\r
    const payload: MlItemPayload = {\r
        title: mlTitle,\r
        price: Number(property.price),\r
        currency_id: property.currency,\r
        available_quantity: 1,\r
        buying_mode: 'classified',\r
        condition: ['new', 'used'].includes(defaults.condition)\r
            ? (defaults.condition as 'new' | 'used')\r
            : 'not_specified',\r
        channels: ['marketplace'],\r
        attributes,\r
        location: property.address ? { address_line: property.address } : undefined,\r
    };\r
    if (defaults.category_id) payload.category_id = defaults.category_id;\r
    if (defaults.listing_type_id) payload.listing_type_id = defaults.listing_type_id;\r
    return payload;\r
}\r
\r
async function createMlItem(\r
    accessToken: string,\r
    payload: MlItemPayload,\r
): Promise<MlItem> {\r
    const res = await fetchWithTimeout(`${ML_API}/items`, {\r
        method: 'POST',\r
        headers: {\r
            Authorization: `Bearer ${accessToken}`,\r
            'Content-Type': 'application/json',\r
            Accept: 'application/json',\r
        },\r
        body: JSON.stringify(payload),\r
    });\r
    const text = await res.text();\r
    if (!res.ok) throw new Error(`ML createItem failed (${res.status}): ${text.slice(0, 300)}`);\r
    return parseMlResponse(MlItemSchema, JSON.parse(text), 'mlCreateItem');\r
}\r
\r
async function updateMlItem(\r
    accessToken: string,\r
    itemId: string,\r
    payload: Record<string, unknown>,\r
): Promise<MlItem> {\r
    const res = await fetchWithTimeout(`${ML_API}/items/${itemId}`, {\r
        method: 'PUT',\r
        headers: {\r
            Authorization: `Bearer ${accessToken}`,\r
            'Content-Type': 'application/json',\r
            Accept: 'application/json',\r
        },\r
        body: JSON.stringify(payload),\r
    });\r
    const text = await res.text();\r
    if (!res.ok) throw new Error(`ML updateItem failed (${res.status}): ${text.slice(0, 300)}`);\r
    return parseMlResponse(MlItemSchema, JSON.parse(text), 'mlUpdateItem');\r
}\r
\r
async function setDescription(\r
    accessToken: string,\r
    itemId: string,\r
    plainText: string,\r
): Promise<void> {\r
    const res = await fetchWithTimeout(`${ML_API}/items/${itemId}/description`, {\r
        method: 'PUT',\r
        headers: {\r
            Authorization: `Bearer ${accessToken}`,\r
            'Content-Type': 'application/json',\r
            Accept: 'application/json',\r
        },\r
        body: JSON.stringify({ plain_text: plainText.slice(0, 20000) }),\r
    });\r
    if (!res.ok) {\r
        const text = await res.text();\r
        throw new Error(`ML setDescription failed (${res.status}): ${text.slice(0, 300)}`);\r
    }\r
}\r
\r
async function closeMlItem(accessToken: string, itemId: string): Promise<MlItem> {\r
    return await updateMlItem(accessToken, itemId, { status: 'closed' });\r
}\r
\r
async function getActiveConnection(): Promise<MlConnectionRow | null> {\r
    const { data } = await supabase\r
        .from('ml_connection')\r
        .select(\r
            'id, access_token_encrypted, access_token_iv, refresh_token_encrypted, refresh_token_iv, token_expires_at',\r
        )\r
        .eq('is_active', true)\r
        .order('updated_at', { ascending: false })\r
        .limit(1);\r
    return (data?.[0] ?? null) as MlConnectionRow | null;\r
}\r
\r
async function upsertListing(args: {\r
    propertyId: string;\r
    mlItemId: string;\r
    mlStatus: string;\r
    permalink: string | null;\r
    price: number | null;\r
    title: string;\r
    listingType: string;\r
}): Promise<void> {\r
    const { data: existing } = await supabase\r
        .from('ml_listings')\r
        .select('id')\r
        .eq('property_id', args.propertyId)\r
        .maybeSingle();\r
\r
    if (existing?.id) {\r
        await supabase\r
            .from('ml_listings')\r
            .update({\r
                ml_item_id: args.mlItemId,\r
                status: args.mlStatus,\r
                permalink: args.permalink,\r
                price: args.price,\r
                last_synced_at: new Date().toISOString(),\r
                updated_at: new Date().toISOString(),\r
            })\r
            .eq('id', existing.id);\r
    } else {\r
        await supabase.from('ml_listings').insert({\r
            property_id: args.propertyId,\r
            ml_item_id: args.mlItemId,\r
            status: args.mlStatus,\r
            permalink: args.permalink,\r
            price: args.price,\r
            title: args.title,\r
            listing_type: args.listingType,\r
            last_synced_at: new Date().toISOString(),\r
        });\r
    }\r
\r
    await supabase.from('property_ml_meta').upsert(\r
        {\r
            property_id: args.propertyId,\r
            ml_item_id: args.mlItemId,\r
            updated_at: new Date().toISOString(),\r
        },\r
        { onConflict: 'property_id' },\r
    );\r
}\r
\r
async function auditLog(entry: {\r
    userId: string;\r
    action: string;\r
    propertyId?: string;\r
    mlItemId?: string;\r
    metadata?: Record<string, unknown>;\r
}): Promise<void> {\r
    await supabase.from('audit_log').insert({\r
        action: entry.action,\r
        module: 'portales',\r
        entity_type: 'ml_listing',\r
        entity_id: entry.propertyId ?? null,\r
        entity_label: entry.mlItemId ?? null,\r
        actor_id: entry.userId,\r
        metadata: entry.metadata ?? {},\r
    });\r
}\r
\r
Deno.serve(async (req) => {\r
    if (req.method === 'OPTIONS') return optionsResponse(req);\r
\r
    const respond = (status: number, body: Record<string, unknown>): Response =>\r
        jsonResponse(status, body, req);\r
\r
    const rl = await rateLimitMiddleware('ml-publish', req);\r
    if (rl) return rl;\r
\r
    const token = await requireAdmin(req, supabase);\r
    if (!token) return respond(401, { error: 'No autorizado' });\r
\r
    const { data: userData } = await supabase.auth.getUser(token);\r
    const adminId = userData?.user?.id;\r
    if (!adminId) return respond(401, { error: 'No autorizado' });\r
\r
    let body: { action?: unknown; property_id?: unknown; listing_id?: unknown };\r
    try {\r
        body = await req.json();\r
    } catch {\r
        return respond(400, { error: 'JSON inválido' });\r
    }\r
\r
    const action = typeof body.action === 'string' ? body.action : '';\r
    const propertyId = typeof body.property_id === 'string' ? body.property_id : '';\r
    const listingIdHint = typeof body.listing_id === 'string' ? body.listing_id : '';\r
\r
    if (!['create', 'update', 'remove'].includes(action)) {\r
        return respond(400, { error: 'action debe ser create, update o remove' });\r
    }\r
    if (!propertyId) {\r
        return respond(400, { error: 'property_id requerido' });\r
    }\r
\r
    const conn = await getActiveConnection();\r
    if (!conn) return respond(400, { error: 'No hay cuenta de Mercado Libre conectada' });\r
\r
    let accessToken: string;\r
    try {\r
        accessToken = await getAccessToken(supabase, conn);\r
    } catch (err) {\r
        return respond(429, {\r
            error: 'No se pudo refrescar el token de Mercado Libre',\r
            detail: (err as Error).message,\r
        });\r
    }\r
\r
    const property = await fetchProperty(propertyId);\r
    if (!property) return respond(404, { error: 'Propiedad no encontrada' });\r
\r
    try {\r
        if (action === 'create') {\r
            if (property.price === null || property.price <= 0) {\r
                return respond(400, { error: 'La propiedad debe tener un precio válido' });\r
            }\r
            const defaults = await fetchDefaults();\r
            if (!defaults.category_id || !defaults.listing_type_id) {\r
                return respond(400, {\r
                    error: 'Falta configurar ml_defaults (category_id, listing_type_id)',\r
                });\r
            }\r
\r
            const mlImageUrls = await prepareImagesForML(accessToken, property.images);\r
            if (mlImageUrls.length === 0) {\r
                return respond(400, {\r
                    error: 'Mercado Libre requiere al menos una imagen válida. Subí fotos a la propiedad.',\r
                });\r
            }\r
\r
            const payload = buildItemPayload(property, defaults);\r
            payload.pictures = mlImageUrls.map((url) => ({ source: url }));\r
\r
            const item = await createMlItem(accessToken, payload);\r
            await setDescription(accessToken, item.id, property.description ?? property.title);\r
\r
            await upsertListing({\r
                propertyId,\r
                mlItemId: item.id,\r
                mlStatus: item.status,\r
                permalink: item.permalink ?? null,\r
                price: item.price ?? null,\r
                title: item.title ?? property.title,\r
                listingType: property.listing_type,\r
            });\r
\r
            await auditLog({\r
                userId: adminId,\r
                action: 'ml_publish',\r
                propertyId,\r
                mlItemId: item.id,\r
                metadata: { event: 'publish_create', permalink: item.permalink },\r
            });\r
\r
            return respond(200, {\r
                ok: true,\r
                action: 'create',\r
                listing_id: item.id,\r
                permalink: item.permalink,\r
                status: item.status,\r
            });\r
        }\r
\r
        if (action === 'update' || action === 'remove') {\r
            let mlItemId = listingIdHint;\r
            if (!mlItemId) {\r
                const { data: row } = await supabase\r
                    .from('ml_listings')\r
                    .select('ml_item_id')\r
                    .eq('property_id', propertyId)\r
                    .maybeSingle();\r
                mlItemId = row?.ml_item_id ?? '';\r
            }\r
            if (!mlItemId) {\r
                return respond(400, {\r
                    error: 'La propiedad no tiene publicación en Mercado Libre',\r
                });\r
            }\r
\r
            if (action === 'remove') {\r
                const item = await closeMlItem(accessToken, mlItemId);\r
                await supabase\r
                    .from('ml_listings')\r
                    .update({\r
                        status: item.status,\r
                        last_synced_at: new Date().toISOString(),\r
                        updated_at: new Date().toISOString(),\r
                    })\r
                    .eq('ml_item_id', mlItemId);\r
\r
                await auditLog({\r
                    userId: adminId,\r
                    action: 'ml_publish',\r
                    propertyId,\r
                    mlItemId,\r
                    metadata: { event: 'publish_close' },\r
                });\r
\r
                return respond(200, {\r
                    ok: true,\r
                    action: 'remove',\r
                    listing_id: mlItemId,\r
                    status: item.status,\r
                });\r
            }\r
\r
            // update\r
            const defaults = await fetchDefaults();\r
            const payload = buildItemPayload(property, defaults);\r
            const mlImageUrls = await prepareImagesForML(accessToken, property.images);\r
            if (mlImageUrls.length > 0) {\r
                payload.pictures = mlImageUrls.map((url) => ({ source: url }));\r
            }\r
\r
            const item = await updateMlItem(accessToken, mlItemId, payload as Record<string, unknown>);\r
            if (property.description) {\r
                await setDescription(accessToken, item.id, property.description);\r
            }\r
\r
            await upsertListing({\r
                propertyId,\r
                mlItemId: item.id,\r
                mlStatus: item.status,\r
                permalink: item.permalink ?? null,\r
                price: item.price ?? null,\r
                title: item.title ?? property.title,\r
                listingType: property.listing_type,\r
            });\r
\r
            await auditLog({\r
                userId: adminId,\r
                action: 'ml_publish',\r
                propertyId,\r
                mlItemId,\r
                metadata: { event: 'publish_update' },\r
            });\r
\r
            return respond(200, {\r
                ok: true,\r
                action: 'update',\r
                listing_id: mlItemId,\r
                permalink: item.permalink,\r
                status: item.status,\r
            });\r
        }\r
\r
        return respond(400, { error: 'Acción inválida' });\r
    } catch (err) {\r
        const message = (err as Error).message;\r
        const is429 = message.includes('429') || message.toLowerCase().includes('rate limit');\r
        if (is429) {\r
            await setMlCooldown(supabase, conn.id, 'publish_429', 60_000);\r
        }\r
        await auditLog({\r
            userId: adminId,\r
            action: 'ml_publish_failed',\r
            propertyId,\r
            mlItemId: '',\r
            metadata: { event: action, error: message },\r
        });\r
        return respond(is429 ? 429 : 500, { error: message });\r
    }\r
});\r
