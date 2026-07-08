// Auth del dashboard — reusa el MISMO Supabase Auth que OpsHyper (proyecto HyperOps).
// El SPA inicia sesión con el anon key y manda el access_token (JWT) en `Authorization: Bearer`.
// Aquí se valida ese token contra Supabase (auth.getUser), se restringe por dominio y se
// resuelve el rol desde public.user_profiles. El service_role NUNCA toca el cliente; solo el
// anon key valida el token, así que el front jamás recibe credenciales con acceso a datos.
import { createClient } from '@supabase/supabase-js';
import type { MiddlewareHandler } from 'hono';
import { config } from '../config.js';
import { dbPublic } from '../db/supabase.js';
import type { RozContext } from '../types/hono.js';

// Cliente para validar el JWT del usuario. getUser(token) valida el token contra Supabase;
// el apikey del cliente solo debe ser una key válida del proyecto, así que el anon key o el
// service_role sirven igual. Usamos el anon key si está, y caemos al service_role (que el
// backend siempre tiene) para NO depender de SUPABASE_ANON_KEY en runtime.
let authClient: ReturnType<typeof createClient> | null = null;
function authApi() {
  if (!authClient) {
    const key = config.supabase.anonKey || config.supabase.serviceRoleKey;
    if (!config.supabase.url || !key) {
      throw new Error('Supabase no configurado (falta SUPABASE_URL o alguna key)');
    }
    authClient = createClient(config.supabase.url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return authClient;
}

/** Valida el JWT del header Authorization, restringe por dominio y carga rol/nombre. */
export const requireDashboardAuth: MiddlewareHandler<RozContext> = async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'falta token' } }, 401);
  }

  const { data, error } = await authApi().auth.getUser(token);
  const email = data.user?.email?.toLowerCase();
  if (error || !data.user || !email) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'token inválido' } }, 401);
  }

  const domain = email.split('@')[1] ?? '';
  if (config.dashboard.allowedDomains.length && !config.dashboard.allowedDomains.includes(domain)) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'dominio no permitido' } }, 403);
  }

  // Rol y nombre desde public.user_profiles (role, full_name). Best-effort y defensivo: si la tabla
  // no existe (self-host sin ese esquema) o el schema `public` no está expuesto, rol/nombre quedan
  // null sin romper la sesión. El rol ya solo es informativo (se muestra en el layout); no restringe.
  let p: { role?: string | null; full_name?: string | null } | null = null;
  try {
    const { data: profile } = await dbPublic()
      .from('user_profiles')
      .select('role, full_name')
      .eq('user_id', data.user.id)
      .maybeSingle();
    p = profile as { role?: string | null; full_name?: string | null } | null;
  } catch {
    p = null;
  }

  c.set('user', {
    id: data.user.id,
    email,
    name: p?.full_name ?? null,
    role: p?.role ?? null,
  });
  await next();
};

/** Mutaciones (CRUD de skills, asignaciones): cualquier usuario autenticado tiene control
 *  total — los roles admin/superadmin ya no restringen nada en el dashboard. */
export const requireAdmin: MiddlewareHandler<RozContext> = async (c, next) => {
  if (!c.get('user')) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'requiere sesión' } }, 403);
  }
  await next();
};
