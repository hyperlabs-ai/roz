import { createClient } from '@supabase/supabase-js';

// Mismo proyecto Supabase que OpsHyper. Solo el anon key vive en el front; el acceso a datos
// va por la API de Hono (que valida el JWT con el service_role server-side).
const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'roz-dashboard-auth' },
});
