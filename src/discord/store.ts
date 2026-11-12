// Lecturas del espejo de Discord (tablas roz.discord_*, migración 0038) que necesita la API de roz.
// El puente es quien ESCRIBE la estructura; aquí solo se lee y se traduce a las entradas del
// algoritmo de permisos (src/discord/permissions.ts, puro).
//
// "Snapshot" = servidor + roles + canales + devs ligados, cargado UNA vez por petición (o por lote de
// avisos del puente) y reutilizado para todos los cálculos de permisos de esa llamada. Un servidor
// de empresa tiene cientos de canales e hilos, no cientos de miles: cabe en memoria sin problema.
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import type {
  DiscordChannelRow,
  DiscordGuildRow,
  DiscordLinkRow,
  DiscordMemberRow,
  DiscordRoleRow,
  DiscordWebhookRow,
} from '../types/discord.js';
import { isThreadType } from '../types/discord.js';
import { devsWhoCanView, type MemberWithUser, type PermissionChannel, type PermissionContext, type PermissionGuild } from './permissions.js';

export const CHANNEL_COLUMNS =
  'id, guild_id, type, name, topic, position, parent_id, nsfw, overwrites, rate_limit_per_user, archived, locked, archived_at, owner_id, member_ids, starter_message_id, message_count, last_message_id, last_message_at, created_at, updated_at, deleted_at';
export const MEMBER_COLUMNS =
  'guild_id, user_id, username, global_name, nick, avatar, guild_avatar, bot, roles, joined_at, communication_disabled_until, pending, created_at, updated_at, left_at';
export const LINK_COLUMNS = 'dev_id, discord_user_id, username, global_name, avatar, linked_at, updated_at';
export const MESSAGE_COLUMNS =
  'id, guild_id, channel_id, type, author_id, author_username, author_global_name, author_avatar, author_bot, webhook_id, dev_id, client_nonce, content, attachments, embeds, stickers, mentions, mention_roles, mention_everyone, reactions, reply_to_id, thread_id, flags, pinned, created_at, edited_at, deleted_at, synced_at';

/** Servidor configurado (DISCORD_GUILD_ID). Todo lo de roz vive en UN servidor. */
export function guildId(): string {
  return config.discord.guildId;
}

/** `.in()` troceado: cientos de ids en una sola URL pasan del tope que acepta PostgREST. */
export async function selectIn<T>(table: string, columns: string, col: string, ids: string[], extra?: (q: any) => any): Promise<T[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    let q = db().from(table).select(columns).in(col, unique.slice(i, i + 100));
    if (extra) q = extra(q);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

// ---------------------------------------------------------------- traducción a permisos

export function toPermissionChannel(row: DiscordChannelRow): PermissionChannel {
  return {
    id: row.id,
    type: row.type,
    parentId: row.parent_id,
    overwrites: Array.isArray(row.overwrites) ? row.overwrites : [],
    memberIds: row.member_ids ?? [],
    archived: row.archived,
    locked: row.locked,
  };
}

export function toPermissionMember(row: DiscordMemberRow): { userId: string; roles: string[]; communicationDisabledUntil: string | null } {
  return { userId: row.user_id, roles: row.roles ?? [], communicationDisabledUntil: row.communication_disabled_until };
}

// ---------------------------------------------------------------- snapshot

export interface LinkedMember {
  devId: string;
  link: DiscordLinkRow;
  /** null = la cuenta ligada no está (o ya no está) en el servidor. */
  member: DiscordMemberRow | null;
}

export interface GuildSnapshot {
  guildId: string;
  guild: DiscordGuildRow | null;
  roles: DiscordRoleRow[];
  /** TODOS los canales del servidor, incluidos los borrados (para avisar a quien los veía). */
  channelRows: Map<string, DiscordChannelRow>;
  /** Solo los vigentes, ya traducidos para el algoritmo. */
  liveChannels: Map<string, PermissionChannel>;
  /** Vigentes Y borrados (calcular destinatarios de algo que acaba de desaparecer). */
  allChannels: Map<string, PermissionChannel>;
  permissionGuild: PermissionGuild;
}

export async function loadGuildRow(id = guildId()): Promise<DiscordGuildRow | null> {
  const { data, error } = await db()
    .from('discord_guild')
    .select('id, name, icon, owner_id, description, created_at, updated_at, deleted_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as DiscordGuildRow | null) ?? null;
}

export async function loadSnapshot(id = guildId()): Promise<GuildSnapshot> {
  const [guild, rolesRes, channelsRes] = await Promise.all([
    loadGuildRow(id),
    db()
      .from('discord_role')
      .select('id, guild_id, name, color, position, permissions, hoist, mentionable, managed, icon, unicode_emoji, created_at, updated_at, deleted_at')
      .eq('guild_id', id)
      .is('deleted_at', null),
    db().from('discord_channel').select(CHANNEL_COLUMNS).eq('guild_id', id),
  ]);
  if (rolesRes.error) throw rolesRes.error;
  if (channelsRes.error) throw channelsRes.error;
  const roles = (rolesRes.data ?? []) as DiscordRoleRow[];
  const channelRows = new Map<string, DiscordChannelRow>();
  const liveChannels = new Map<string, PermissionChannel>();
  const allChannels = new Map<string, PermissionChannel>();
  for (const row of (channelsRes.data ?? []) as DiscordChannelRow[]) {
    channelRows.set(row.id, row);
    const pc = toPermissionChannel(row);
    allChannels.set(row.id, pc);
    if (!row.deleted_at) liveChannels.set(row.id, pc);
  }
  return {
    guildId: id,
    guild,
    roles,
    channelRows,
    liveChannels,
    allChannels,
    // Sin fila del servidor (el puente no ha corrido) nadie es dueño: sin roles, nadie ve nada.
    permissionGuild: { id, ownerId: guild?.owner_id ?? '', roles: roles.map((r) => ({ id: r.id, permissions: r.permissions })) },
  };
}

/** Contexto de permisos de UN miembro sobre el snapshot (canales vigentes). */
export function contextFor(snap: GuildSnapshot, member: DiscordMemberRow, opts: { includeDeleted?: boolean } = {}): PermissionContext {
  return {
    guild: snap.permissionGuild,
    member: toPermissionMember(member),
    channels: opts.includeDeleted ? snap.allChannels : snap.liveChannels,
  };
}

// ---------------------------------------------------------------- vínculos dev ↔ Discord

export async function loadAllLinks(): Promise<DiscordLinkRow[]> {
  const { data, error } = await db().from('discord_link').select(LINK_COLUMNS);
  if (error) throw error;
  return (data ?? []) as DiscordLinkRow[];
}

export async function loadLink(devId: string): Promise<DiscordLinkRow | null> {
  const { data, error } = await db().from('discord_link').select(LINK_COLUMNS).eq('dev_id', devId).maybeSingle();
  if (error) throw error;
  return (data as DiscordLinkRow | null) ?? null;
}

export async function loadMember(userId: string, id = guildId()): Promise<DiscordMemberRow | null> {
  const { data, error } = await db()
    .from('discord_member')
    .select(MEMBER_COLUMNS)
    .eq('guild_id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as DiscordMemberRow | null) ?? null;
}

/** Devs ligados con su fila de miembro (activa o null). */
export async function loadLinkedMembers(id = guildId()): Promise<LinkedMember[]> {
  const links = await loadAllLinks();
  if (!links.length) return [];
  const members = await selectIn<DiscordMemberRow>('discord_member', MEMBER_COLUMNS, 'user_id', links.map((l) => l.discord_user_id), (q) =>
    q.eq('guild_id', id),
  );
  const byUser = new Map(members.map((m) => [m.user_id, m]));
  return links.map((link) => {
    const m = byUser.get(link.discord_user_id) ?? null;
    return { devId: link.dev_id, link, member: m && !m.left_at ? m : null };
  });
}

/** Ligados que siguen en el servidor, listos para devsWhoCanView. */
export function activeLinkedMembers(linked: LinkedMember[]): MemberWithUser[] {
  return linked
    .filter((l): l is LinkedMember & { member: DiscordMemberRow } => !!l.member)
    .map((l) => ({ ...toPermissionMember(l.member), devId: l.devId }));
}

/**
 * Devs que pueden ver un canal/hilo. Usa también los canales borrados: cuando el puente avisa que
 * algo desapareció, el aviso debe llegar a quien lo VEÍA.
 */
export function recipientsFor(snap: GuildSnapshot, linked: LinkedMember[], channelId: string): string[] {
  return devsWhoCanView(snap.permissionGuild, snap.allChannels, activeLinkedMembers(linked), channelId);
}

// ---------------------------------------------------------------- canales y webhooks

/** Canal donde vive el webhook para escribir en `channel`: el propio, o el padre si es un hilo. */
export function webhookChannelOf(channel: Pick<DiscordChannelRow, 'id' | 'type' | 'parent_id'>): string {
  return isThreadType(channel.type) && channel.parent_id ? channel.parent_id : channel.id;
}

export async function loadWebhookRows(channelIds: string[]): Promise<Map<string, DiscordWebhookRow>> {
  const rows = await selectIn<DiscordWebhookRow>(
    'discord_webhook',
    'channel_id, guild_id, webhook_id, token_enc, name, created_at, updated_at',
    'channel_id',
    channelIds,
  );
  return new Map(rows.map((r) => [r.channel_id, r]));
}

export async function loadChannelRow(channelId: string): Promise<DiscordChannelRow | null> {
  const { data, error } = await db().from('discord_channel').select(CHANNEL_COLUMNS).eq('id', channelId).maybeSingle();
  if (error) throw error;
  return (data as DiscordChannelRow | null) ?? null;
}
