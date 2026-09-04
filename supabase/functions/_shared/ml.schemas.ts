/**
 * Zod Schemas para validación runtime de Mercado Libre API responses.
 * Elimina todos los `as unknown as` / `any` en ml.ts, ml-sync, ml-webhook, ml-metrics.
 */

import { z } from 'npm:zod@3';

/*
 * NOTA: el import usa prefijo npm: porque el runtime de Supabase Edge no
 * resuelve bare imports ('zod') sin import_map.json. Sin el prefijo la
 * resolución de módulos falla al boot y la función responde 503 BOOT_ERROR.
 */

// ============================================================
// OAuth & Token Schemas
// ============================================================

export const MlTokenResponseSchema = z.object({
    access_token: z.string(),
    token_type: z.string(),
    expires_in: z.number().int().positive(),
    scope: z.string(),
    user_id: z.number().int().positive(),
    refresh_token: z.string(),
});

export const MlUserSchema = z.object({
    id: z.number().int().positive(),
    nickname: z.string(),
    email: z.string().email(),
    site_id: z.string(),
});

// ============================================================
// Item Schemas
// ============================================================

export const MlItemAttributeSchema = z.object({
    id: z.string(),
    value_name: z.string(),
    value_id: z.string().optional(),
});

export const MlItemPictureSchema = z.object({
    id: z.string(),
    url: z.string().url(),
    secure_url: z.string().url().optional(),
    size: z.string().optional(),
    max_size: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    quality: z.number().optional(),
    variation_id: z.string().optional(),
});

export const MlItemPictureUploadResponseSchema = z.object({
    id: z.string(),
    max_size: z.number(),
    max_width: z.number(),
    max_height: z.number(),
    quality: z.number(),
    variations: z.array(
        z.object({
            id: z.string(),
            url: z.string().url(),
            width: z.number(),
            height: z.number(),
            size: z.number(),
        }),
    ),
});

export const MlItemSchema = z.object({
    id: z.string(),
    title: z.string(),
    price: z.number().nonnegative(),
    status: z.string(),
    permalink: z.string().url(),
    listing_type_id: z.string(),
    sold_quantity: z.number().int().nonnegative().optional(),
    available_quantity: z.number().int().nonnegative().optional(),
    currency_id: z.string().optional(),
    pictures: z.array(MlItemPictureSchema).optional(),
    attributes: z.array(MlItemAttributeSchema).optional(),
    description: z.string().optional(),
});

export const MlItemPayloadSchema = z.object({
    title: z.string().max(60),
    category_id: z.string().optional(),
    price: z.number().positive(),
    currency_id: z.string(),
    available_quantity: z.number().int().positive(),
    buying_mode: z.literal('classified'),
    listing_type_id: z.string().optional(),
    condition: z.enum(['new', 'used', 'not_specified']),
    pictures: z.array(z.object({ source: z.string().url() })).optional(),
    description: z.object({ plain_text: z.string().max(20000) }).optional(),
    attributes: z.array(MlItemAttributeSchema).optional(),
    channels: z.array(z.literal('marketplace')).optional(),
    location: z.object({ address_line: z.string().optional() }).optional(),
});

// ============================================================
// Category & Listing Type Schemas
// ============================================================

export const MlCategorySchema = z.object({
    id: z.string(),
    name: z.string(),
});

export const MlListingTypeSchema = z.object({
    id: z.string(),
    name: z.string(),
});

// ============================================================
// Question Schemas
// ============================================================

export const MlQuestionAnswerSchema = z.object({
    text: z.string(),
    status: z.enum(['ACTIVE', 'DISABLED']),
    date_created: z.string(),
});

export const MlQuestionFromSchema = z.object({
    user_id: z.number().int().positive().optional(),
    nickname: z.string().optional(),
});

export const MlQuestionSchema = z.object({
    id: z.number().int().positive(),
    item_id: z.string(),
    text: z.string().nullable().optional(),
    from: MlQuestionFromSchema.nullable().optional(),
    date_created: z.string(),
    status: z.enum(['UNANSWERED', 'ANSWERED', 'CLOSED']),
    answer: MlQuestionAnswerSchema.optional(),
});

export const MlQuestionsResponseSchema = z.object({
    questions: z.array(MlQuestionSchema),
});

// ============================================================
// Order Schemas
// ============================================================

export const MlOrderPaymentSchema = z.object({
    status: z.string(),
});

export const MlOrderShippingSchema = z.object({
    status: z.string().optional(),
});

export const MlOrderItemSchema = z.object({
    item: z.object({ id: z.string() }),
});

export const MlOrderBuyerSchema = z.object({
    id: z.number().int().positive().optional(),
    nickname: z.string().optional(),
});

export const MlOrderSchema = z.object({
    id: z.string(),
    status: z.string(),
    shipping: MlOrderShippingSchema.nullable().optional(),
    payments: z.array(MlOrderPaymentSchema).optional(),
    order_items: z.array(MlOrderItemSchema).optional(),
    buyer: MlOrderBuyerSchema.nullable().optional(),
    total_amount: z.number().nonnegative().nullable().optional(),
    currency_id: z.string().nullable().optional(),
    date_created: z.string().nullable().optional(),
    date_closed: z.string().nullable().optional(),
});

export const MlOrdersResponseSchema = z.object({
    orders: z.array(MlOrderSchema),
});

// ============================================================
// Metrics Schemas
// ============================================================

export const MlVisitsResponseSchema = z.object({
    item_id: z.string(),
    visits: z.number().int().nonnegative(),
});

export const MlItemMetricsSchema = z.object({
    item_id: z.string(),
    title: z.string(),
    visits: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    sold_quantity: z.number().int().nonnegative(),
    available_quantity: z.number().int().nonnegative(),
    price: z.number().nonnegative(),
    currency_id: z.string(),
    status: z.string(),
    permalink: z.string().url(),
});

export const MlMetricsResponseSchema = z.object({
    items: z.array(MlItemMetricsSchema),
    total_visits: z.number().int().nonnegative(),
    total_questions: z.number().int().nonnegative(),
    unanswered_questions: z.number().int().nonnegative(),
    total_sales: z.number().int().nonnegative(),
    total_revenue: z.number().nonnegative(),
    conversion_rate: z.number().nonnegative(),
});

// ============================================================
// Webhook Schemas
// ============================================================

export const MlWebhookPayloadSchema = z.object({
    user_id: z.number().int().positive(),
    resource: z.string(),
    topic: z.enum(['questions', 'orders', 'orders_v2', 'items', 'payments', 'shipments']),
    application_id: z.number().int().positive(),
    attempts: z.number().int().nonnegative(),
    sent: z.string(),
    received: z.string(),
});

// ============================================================
// Sync Queue / History Schemas (para DB)
// ============================================================

export const MlSyncQueueRowSchema = z.object({
    id: z.number().int().positive(),
    property_id: z.string().uuid(),
    operation: z.enum(['publish', 'update', 'delete']),
    status: z.enum(['pending', 'processing', 'success', 'failed', 'cancelled']),
    attempts: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    next_attempt_at: z.string().datetime(),
    ml_item_id: z.string().nullable().optional(),
    last_error: z.string().nullable().optional(),
    created_at: z.string().datetime(),
    payload: z.record(z.unknown()).optional(),
});

export const MlSyncHistoryRowSchema = z.object({
    id: z.number().int().positive(),
    queue_id: z.number().int().positive(),
    operation: z.enum(['publish', 'update', 'delete']),
    status: z.enum(['success', 'failed']),
    attempt: z.number().int().positive(),
    response: z.record(z.unknown()).nullable().optional(),
    error: z.string().nullable().optional(),
    created_at: z.string().datetime(),
});

// ============================================================
// Helper Functions
// ============================================================

/**
 * Valida y parsea respuesta de ML API con Zod.
 * Lanza error tipado si falla validación.
 */
export function parseMlResponse<T>(
    schema: z.ZodSchema<T>,
    data: unknown,
    operationName: string,
): T {
    const result = schema.safeParse(data);
    if (!result.success) {
        const errorMsg = `${operationName}: Respuesta ML inválida - ${result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`;
        throw new Error(errorMsg);
    }
    return result.data;
}

/**
 * Extrae error message de response ML para categorización.
 */
export function extractMlErrorMessage(data: unknown): string {
    if (typeof data === 'object' && data !== null) {
        const obj = data as Record<string, unknown>;
        if (typeof obj.message === 'string') return obj.message;
        if (typeof obj.error === 'string') return obj.error;
        if (typeof obj.details === 'string') return obj.details;
    }
    return String(data);
}

// ============================================================
// Type Exports (para uso en ml.ts, ml-sync, ml-webhook, ml-metrics)
// ============================================================

export type MlTokenResponse = z.infer<typeof MlTokenResponseSchema>;
export type MlUser = z.infer<typeof MlUserSchema>;
export type MlItem = z.infer<typeof MlItemSchema>;
export type MlItemPayload = z.infer<typeof MlItemPayloadSchema>;
export type MlItemPicture = z.infer<typeof MlItemPictureSchema>;
export type MlItemPictureUploadResponse = z.infer<typeof MlItemPictureUploadResponseSchema>;
export type MlCategory = z.infer<typeof MlCategorySchema>;
export type MlListingType = z.infer<typeof MlListingTypeSchema>;
export type MlQuestion = z.infer<typeof MlQuestionSchema>;
export type MlQuestionsResponse = z.infer<typeof MlQuestionsResponseSchema>;
export type MlOrder = z.infer<typeof MlOrderSchema>;
export type MlOrdersResponse = z.infer<typeof MlOrdersResponseSchema>;
export type MlVisitsResponse = z.infer<typeof MlVisitsResponseSchema>;
export type MlItemMetrics = z.infer<typeof MlItemMetricsSchema>;
export type MlMetricsResponse = z.infer<typeof MlMetricsResponseSchema>;
export type MlWebhookPayload = z.infer<typeof MlWebhookPayloadSchema>;
export type MlSyncQueueRow = z.infer<typeof MlSyncQueueRowSchema>;
export type MlSyncHistoryRow = z.infer<typeof MlSyncHistoryRowSchema>;
