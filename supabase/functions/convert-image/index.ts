import sharp from 'npm:sharp@0.33';
import { corsHeaders, jsonResponse, optionsResponse } from '../_shared/http.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';

const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);

    if (req.method !== 'POST') {
        return jsonResponse(405, { error: 'Method not allowed' }, req);
    }

    // Protección DoS: sharp es CPU-intensivo, limitar por IP.
    const rl = await rateLimitMiddleware('convert-image', req);
    if (rl) return rl;

    try {
        const formData = await req.formData();
        const file = formData.get('file') as File;
        const quality = Number(formData.get('quality') ?? '85');
        const maxWidth = Number(formData.get('maxWidth') ?? '2000');

        if (!file) {
            return jsonResponse(400, { error: 'No file provided' }, req);
        }

        // Validate file type
        if (!ALLOWED_TYPES.includes(file.type)) {
            return jsonResponse(400, { error: `Tipo no permitido: ${file.type}` }, req);
        }

        // Validate file size
        if (file.size > MAX_SIZE) {
            return jsonResponse(400, { error: `Archivo supera ${MAX_SIZE / 1024 / 1024} MB` }, req);
        }

        const buffer = new Uint8Array(await file.arrayBuffer());

        // Convert to WebP with Sharp
        const output = await sharp(buffer)
            .resize({ width: maxWidth, withoutEnlargement: true })
            .webp({ quality })
            .toBuffer();

        return new Response(output, {
            headers: {
                'Content-Type': 'image/webp',
                ...corsHeaders(req),
            },
        });
    } catch (err) {
        console.error('[convert-image] Error:', err);
        return jsonResponse(500, { error: (err as Error).message }, req);
    }
});
