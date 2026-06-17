// Clientes Supabase con service role. roz corre server-side: sin sesión de usuario, sin RLS
// — la autorización vive en la superficie pública (MCP token, firmas de webhook).
//
//  · db()       → schema `roz` (tablas propias de roz, aisladas de producción).
//  · dbPublic() → schema `public` de HyperOps (solo lectura de github_repositories, projects…).
import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

function build(schema: string) {
  return createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema },
  });
}

let rozClient: ReturnType<typeof build> | null = null;
let publicClient: ReturnType<typeof build> | null = null;

export function db() {
  if (!rozClient) rozClient = build('roz');
  return rozClient;
}

export function dbPublic() {
  if (!publicClient) publicClient = build('public');
  return publicClient;
}
