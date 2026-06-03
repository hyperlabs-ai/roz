// Cliente Supabase con service role. roz corre server-side: sin sesión de usuario,
// sin RLS — la autorización vive en la superficie pública (MCP token, firmas de webhook).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
