import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkInWithQr, generateQrCode } from '../_shared/visits.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};

function respond(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

async function isAuthorized(req: Request): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  
  const { data: admins } = await supabase
    .from('admin_users')
    .select('role, is_active')
    .eq('id', data.user.id)
    .limit(1);
  const admin = admins?.[0];
  if (!admin || !admin.is_active || !['super_admin', 'admin', 'staff'].includes(admin.role)) return null;
  
  return token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  
  const token = await isAuthorized(req);
  if (!token) return respond(401, { error: 'No autorizado' });

  if (req.method === 'POST') {
    // Generate QR code
    const { visitId } = await req.json().catch(() => ({}));
    if (!visitId) return respond(400, { error: 'visitId requerido' });
    
    try {
      const qr = await generateQrCode(visitId);
      // Return QR code data URL (using a simple QR generator)
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qr.code)}`;
      return respond(200, { code: qr.code, qrUrl, checkinId: qr.id });
    } catch (err) {
      return respond(500, { error: (err as Error).message });
    }
  }

  if (req.method === 'GET') {
    // Check-in with QR code
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    if (!code) return respond(400, { error: 'code requerido' });
    
    try {
      // Get current user (agent)
      const { data: { user } } = await supabase.auth.getUser(token);
      if (!user) return respond(401, { error: 'Usuario no autenticado' });
      
      const result = await checkInWithQr(code, user.id);
      return respond(result.success ? 200 : 400, result);
    } catch (err) {
      return respond(500, { error: (err as Error).message });
    }
  }

  return respond(405, { error: 'Method not allowed' });
});