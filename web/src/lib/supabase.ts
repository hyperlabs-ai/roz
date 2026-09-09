import { createClient } from '@supabase/supabase-js';

// Mismo proyecto Supabase que OpsHyper. Solo el anon key vive en el front; el acceso a datos
// va por la API de Hono (que valida el JWT con el service_role server-side).
const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// Llave de localStorage donde auth-js guarda la sesión. Se exporta porque el store de auth escucha
// el evento `storage` sobre ella: es como detecta que otra pestaña cerró sesión de verdad.
export const STORAGE_KEY = 'roz-dashboard-auth';

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: STORAGE_KEY },
});
