// MirrorStore sobre Supabase (PostgREST) con la service-role key, schema `roz`.
//
// Ojo con los upserts por lote: supabase-js manda la UNIÓN de columnas de todas las filas y las que
// falten en una fila quedarían en null/default. Por eso cada lote se agrupa por "forma" (conjunto de
// columnas) y se manda un upsert por forma.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ChannelFields, EmojiFields, GuildFields, MemberFields, MessageFields, MessagePatch, RoleFields } from '../map.js';
import type {
  BridgeStateFields,
  ChannelMeta,
  ChannelPatch,
  MessageMeta,
  MirrorStore,
  SyncState,
  SyncStateFields,
} from './types.js';

const IN_CHUNK = 150; // ids por filtro `in` (largo de URL)
const UPSERT_CHUNK = 500;

export class StoreError extends Error {
  constructor(op: string, detail: string, readonly code?: string) {
    super(`${op}: ${detail}`);
    this.name = 'StoreError';
  }
}

type PgError = { message: string; code?: string } | null;

function check(op: string, error: PgError): void {
  if (error) throw new StoreError(op, error.message, error.code);
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Agrupa filas por su conjunto de columnas (ver comentario de cabecera). */
export function groupByShape<T extends object>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = Object.keys(r).sort().join(',');
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.values()];
}

const now = () => new Date().toISOString();

export class SupabaseMirrorStore implements MirrorStore {
  private readonly db: SupabaseClient<any, 'roz', any>;

  constructor(url: string, serviceRoleKey: string, client?: SupabaseClient<any, 'roz', any>) {
    this.db =
      client ??
      createClient<any, 'roz', any>(url, serviceRoleKey, {
        db: { schema: 'roz' },
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { 'x-client-info': 'roz-discord-bridge' } },
      });
  }

  private async upsert(table: string, rows: object[], onConflict: string, extra: () => object): Promise<void> {
    if (!rows.length) return;
    for (const shape of groupByShape(rows)) {
      for (const part of chunks(shape, UPSERT_CHUNK)) {
        const stamp = extra();
        const { error } = await this.db.from(table).upsert(part.map((r) => ({ ...r, ...stamp })), { onConflict });
        check(`upsert ${table}`, error);
      }
    }
  }

  private async softDelete(table: string, ids: string[], column = 'deleted_at', key = 'id', guildId?: string): Promise<string[]> {
    const changed: string[] = [];
    for (const part of chunks([...new Set(ids)], IN_CHUNK)) {
      let q = this.db.from(table).update({ [column]: now(), updated_at: now() }).in(key, part).is(column, null);
      if (guildId) q = q.eq('guild_id', guildId);
      const { data, error } = await q.select(key);
      check(`soft delete ${table}`, error);
      for (const r of (data ?? []) as unknown as Record<string, string>[]) changed.push(r[key]!);
    }
    return changed;
  }

  private async ids(table: string, key: string, guildId: string, aliveColumn: string): Promise<string[]> {
    const out: string[] = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await this.db
        .from(table)
        .select(key)
        .eq('guild_id', guildId)
        .is(aliveColumn, null)
        .order(key)
        .range(from, from + page - 1);
      check(`list ${table}`, error);
      const rows = (data ?? []) as unknown as Record<string, string>[];
      for (const r of rows) out.push(r[key]!);
      if (rows.length < page) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- servidor
  async upsertGuild(row: GuildFields): Promise<void> {
    await this.upsert('discord_guild', [row], 'id', () => ({ updated_at: now() }));
  }

  async markGuildDeleted(guildId: string): Promise<void> {
    await this.softDelete('discord_guild', [guildId]);
  }

  // ---------------------------------------------------------------- canales
  async upsertChannels(rows: ChannelFields[]): Promise<void> {
    await this.upsert('discord_channel', rows, 'id', () => ({ updated_at: now() }));
  }

  async patchChannel(id: string, patch: ChannelPatch): Promise<boolean> {
    const { data, error } = await this.db
      .from('discord_channel')
      .update({ ...patch, updated_at: now() })
      .eq('id', id)
      .select('id');
    check('patch discord_channel', error);
    return (data ?? []).length > 0;
  }

  async getChannel(id: string): Promise<ChannelMeta | null> {
    const { data, error } = await this.db
      .from('discord_channel')
      .select('id, type, parent_id, archived, member_ids, message_count, deleted_at')
      .eq('id', id)
      .maybeSingle();
    check('get discord_channel', error);
    return (data as ChannelMeta | null) ?? null;
  }

  async listChannels(guildId: string): Promise<ChannelMeta[]> {
    const out: ChannelMeta[] = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await this.db
        .from('discord_channel')
        .select('id, type, parent_id, archived, member_ids, message_count, deleted_at')
        .eq('guild_id', guildId)
        .is('deleted_at', null)
        .order('id')
        .range(from, from + page - 1);
      check('list discord_channel', error);
      const rows = (data ?? []) as ChannelMeta[];
      out.push(...rows);
      if (rows.length < page) break;
    }
    return out;
  }

  softDeleteChannels(ids: string[]): Promise<string[]> {
    return this.softDelete('discord_channel', ids);
  }

  // ---------------------------------------------------------------- roles
  async upsertRoles(rows: RoleFields[]): Promise<void> {
    await this.upsert('discord_role', rows, 'id', () => ({ updated_at: now() }));
  }
  listRoleIds(guildId: string): Promise<string[]> {
    return this.ids('discord_role', 'id', guildId, 'deleted_at');
  }
  softDeleteRoles(ids: string[]): Promise<string[]> {
    return this.softDelete('discord_role', ids);
  }

  // ---------------------------------------------------------------- miembros
  async upsertMembers(rows: MemberFields[]): Promise<void> {
    await this.upsert('discord_member', rows, 'guild_id,user_id', () => ({ updated_at: now() }));
  }
  listActiveMemberIds(guildId: string): Promise<string[]> {
    return this.ids('discord_member', 'user_id', guildId, 'left_at');
  }
  markMembersLeft(guildId: string, userIds: string[]): Promise<string[]> {
    return this.softDelete('discord_member', userIds, 'left_at', 'user_id', guildId);
  }

  // ---------------------------------------------------------------- emojis
  async upsertEmojis(rows: EmojiFields[]): Promise<void> {
    await this.upsert('discord_emoji', rows, 'id', () => ({ updated_at: now() }));
  }
  listEmojiIds(guildId: string): Promise<string[]> {
    return this.ids('discord_emoji', 'id', guildId, 'deleted_at');
  }
  softDeleteEmojis(ids: string[]): Promise<string[]> {
    return this.softDelete('discord_emoji', ids);
  }

  // ---------------------------------------------------------------- mensajes
  async upsertMessages(rows: MessageFields[]): Promise<void> {
    // Defensa en profundidad: aunque normalize no los produce, jamás mandar dev_id/client_nonce.
    // Tampoco `deleted_at`: un upsert NUNCA revive un borrado. Una página del backfill pedida antes
    // de un MESSAGE_DELETE (o un eco tardío de algo que roz ya borró) llega al carril después del
    // borrado; con deleted_at:null lo resucitaría. Sin la columna, un alta nueva toma el default
    // (null) y una fila existente conserva lo que tenía. Los ids de Discord no se reusan.
    const clean = rows.map((r) => {
      const { dev_id: _d, client_nonce: _c, deleted_at: _x, ...rest } = r as MessageFields & { dev_id?: unknown; client_nonce?: unknown };
      return rest;
    });
    await this.upsert('discord_message', clean, 'id', () => ({ synced_at: now() }));
  }

  async updateMessage(id: string, patch: MessagePatch): Promise<boolean> {
    const { dev_id: _d, client_nonce: _c, ...rest } = patch as MessagePatch & { dev_id?: unknown; client_nonce?: unknown };
    const { data, error } = await this.db
      .from('discord_message')
      .update({ ...rest, synced_at: now() })
      .eq('id', id)
      .select('id');
    check('update discord_message', error);
    return (data ?? []).length > 0;
  }

  async getMessages(ids: string[]): Promise<Map<string, MessageMeta>> {
    const out = new Map<string, MessageMeta>();
    for (const part of chunks([...new Set(ids)], IN_CHUNK)) {
      const { data, error } = await this.db
        .from('discord_message')
        .select('id, channel_id, reactions, thread_id, deleted_at')
        .in('id', part);
      check('get discord_message', error);
      for (const r of (data ?? []) as MessageMeta[]) out.set(r.id, r);
    }
    return out;
  }

  softDeleteMessages(ids: string[]): Promise<string[]> {
    return this.softDeleteNoStamp('discord_message', ids);
  }

  /** discord_message no tiene updated_at. */
  private async softDeleteNoStamp(table: string, ids: string[]): Promise<string[]> {
    const changed: string[] = [];
    for (const part of chunks([...new Set(ids)], IN_CHUNK)) {
      const { data, error } = await this.db
        .from(table)
        .update({ deleted_at: now(), synced_at: now() })
        .in('id', part)
        .is('deleted_at', null)
        .select('id');
      check(`soft delete ${table}`, error);
      for (const r of (data ?? []) as { id: string }[]) changed.push(r.id);
    }
    return changed;
  }

  async listMessageIdsBetween(channelId: string, fromIso: string | null, toIso: string): Promise<string[]> {
    const out: string[] = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      let q = this.db
        .from('discord_message')
        .select('id')
        .eq('channel_id', channelId)
        .is('deleted_at', null)
        .lte('created_at', toIso);
      if (fromIso) q = q.gte('created_at', fromIso);
      const { data, error } = await q.order('created_at', { ascending: false }).order('id').range(from, from + page - 1);
      check('list discord_message', error);
      const rows = (data ?? []) as { id: string }[];
      for (const r of rows) out.push(r.id);
      if (rows.length < page) break;
    }
    return out;
  }

  async countMessages(channelId: string): Promise<number> {
    const { count, error } = await this.db
      .from('discord_message')
      .select('id', { count: 'exact', head: true })
      .eq('channel_id', channelId);
    check('count discord_message', error);
    return count ?? 0;
  }

  // ---------------------------------------------------------------- cursores y estado
  async getSyncState(channelId: string): Promise<SyncState | null> {
    const { data, error } = await this.db
      .from('discord_sync_state')
      .select('channel_id, guild_id, oldest_message_id, newest_message_id, backfill_complete, last_synced_at, last_error')
      .eq('channel_id', channelId)
      .maybeSingle();
    check('get discord_sync_state', error);
    return (data as SyncState | null) ?? null;
  }

  async upsertSyncState(row: SyncStateFields): Promise<void> {
    await this.upsert('discord_sync_state', [row], 'channel_id', () => ({ updated_at: now() }));
  }

  async upsertBridgeState(row: BridgeStateFields): Promise<void> {
    await this.upsert('discord_bridge_state', [row], 'guild_id', () => ({ updated_at: now() }));
  }
}
