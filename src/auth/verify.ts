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

let authClient: ReturnType<typeof createClient> | null = null;
function authApi() {
  if (!authClient) {
    authClient = createClient(config.supabase.url, config.supabase.anonKey, {
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

  // Rol y nombre desde user_profiles (mismo modelo que OpsHyper). Best-effort: sin perfil → null.
  const { data: profile } = await dbPublic()
    .from('user_profiles')
    .select('role, full_name')
    .eq('user_id', data.user.id)
    .maybeSingle();
  const p = profile as { role?: string | null; full_name?: string | null } | null;

  c.set('user', {
    id: data.user.id,
    email,
    name: p?.full_name ?? null,
    role: p?.role ?? null,
  });
  await next();
};

/** Exige rol admin/superadmin (mutaciones: CRUD de skills, asignaciones). */
export const requireAdmin: MiddlewareHandler<RozContext> = async (c, next) => {
  const user = c.get('user');
  if (!user || !['admin', 'superadmin'].includes(user.role ?? '')) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'requiere rol admin' } }, 403);
  }
  await next();
};
