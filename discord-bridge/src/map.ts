// Payload CRUDO de Discord (snake_case, tal como llega por el gateway o la REST) → columnas de las
// tablas roz.discord_*. Puro: sin red ni base. Tests en test/map.test.ts.
//
// Regla general: una columna que el payload NO trae no se incluye en el objeto (PostgREST solo
// actualiza las columnas enviadas), así un evento parcial nunca pisa con null un dato bueno. Las
// columnas que mantiene el puente aparte (member_ids, starter_message_id) nunca salen de aquí.
import type {
  DiscordApiChannel,
  DiscordApiEmoji,
  DiscordApiGuild,
  DiscordApiGuildMember,
  DiscordApiMessage,
  DiscordApiRole,
} from './shared/api-types.js';
import { normalizeApiMessage, type DiscordMessageMirrorFields } from './shared/normalize.js';
import type {
  DiscordChannelRow,
  DiscordEmojiRow,
  DiscordGuildRow,
  DiscordMemberRow,
  DiscordPermissionOverwrite,
  DiscordRoleRow,
} from './shared/types.js';
import { isThreadType } from './shared/types.js';
import { snowflakeIso } from './snowflake.js';

export type GuildFields = Omit<DiscordGuildRow, 'created_at' | 'updated_at'>;
export type ChannelFields = Pick<DiscordChannelRow, 'id' | 'guild_id' | 'type'> &
  Partial<Omit<DiscordChannelRow, 'id' | 'guild_id' | 'type' | 'created_at' | 'updated_at' | 'member_ids' | 'starter_message_id'>>;
export type RoleFields = Omit<DiscordRoleRow, 'created_at' | 'updated_at'>;
export type MemberFields = Omit<DiscordMemberRow, 'created_at' | 'updated_at'>;
export type EmojiFields = Omit<DiscordEmojiRow, 'created_at' | 'updated_at'>;
export type MessageFields = DiscordMessageMirrorFields;
/** Columnas de un MESSAGE_UPDATE parcial: solo lo que vino. */
export type MessagePatch = Partial<Omit<MessageFields, 'id'>>;

export function mapGuild(g: DiscordApiGuild): GuildFields {
  return {
    id: g.id,
    name: g.name,
    icon: g.icon ?? null,
    owner_id: g.owner_id,
    description: g.description ?? null,
    deleted_at: null,
  };
}

/** `type` de overwrite: la API vieja mandaba 'role'/'member'; hoy 0/1. */
export function mapOverwrites(list: DiscordApiChannel['permission_overwrites']): DiscordPermissionOverwrite[] {
  return (list ?? []).map((o) => ({
    id: String(o.id),
    type: o.type === 0 || o.type === '0' || o.type === 'role' ? 0 : 1,
    allow: String(o.allow ?? '0'),
    deny: String(o.deny ?? '0'),
  }));
}

export function mapChannel(c: DiscordApiChannel, guildId: string): ChannelFields {
  const row: ChannelFields = {
    id: c.id,
    guild_id: c.guild_id ?? guildId,
    type: c.type,
    deleted_at: null,
  };
  if ('name' in c) row.name = c.name ?? '';
  if ('topic' in c) row.topic = c.topic ?? null;
  if ('position' in c) row.position = c.position ?? 0;
  if ('parent_id' in c) row.parent_id = c.parent_id ?? null;
  if ('nsfw' in c) row.nsfw = c.nsfw ?? false;
  if ('permission_overwrites' in c) row.overwrites = mapOverwrites(c.permission_overwrites);
  if ('rate_limit_per_user' in c) row.rate_limit_per_user = c.rate_limit_per_user ?? 0;
  if ('last_message_id' in c) {
    row.last_message_id = c.last_message_id ?? null;
    row.last_message_at = c.last_message_id ? safeIso(c.last_message_id) : null;
  }
  if (isThreadType(c.type)) {
    if ('owner_id' in c) row.owner_id = c.owner_id ?? null;
    if ('message_count' in c) row.message_count = c.message_count ?? null;
    const meta = c.thread_metadata;
    if (meta) {
      row.archived = meta.archived ?? false;
      row.locked = meta.locked ?? false;
      row.archived_at = meta.archived ? (meta.archive_timestamp ?? null) : null;
    }
  }
  return row;
}

function safeIso(id: string): string | null {
  try {
    return snowflakeIso(id);
  } catch {
    return null;
  }
}

export function mapRole(r: DiscordApiRole, guildId: string): RoleFields {
  return {
    id: r.id,
    guild_id: guildId,
    name: r.name,
    color: r.color ?? 0,
    position: r.position ?? 0,
    permissions: String(r.permissions ?? '0'),
    hoist: r.hoist ?? false,
    mentionable: r.mentionable ?? false,
    managed: r.managed ?? false,
    icon: r.icon ?? null,
    unicode_emoji: r.unicode_emoji ?? null,
    deleted_at: null,
  };
}

/** null si el payload no trae usuario (no se puede guardar sin user_id). */
export function mapMember(m: DiscordApiGuildMember, guildId: string): MemberFields | null {
  const u = m.user;
  if (!u?.id) return null;
  return {
    guild_id: guildId,
    user_id: u.id,
    username: u.username ?? '',
    global_name: u.global_name ?? null,
    nick: m.nick ?? null,
    avatar: u.avatar ?? null,
    guild_avatar: m.avatar ?? null,
    bot: u.bot ?? false,
    // @everyone (id = guild_id) lo tienen todos y se aplica aparte (permissions.ts).
    roles: (m.roles ?? []).filter((id) => id !== guildId),
    joined_at: m.joined_at ?? null,
    communication_disabled_until: m.communication_disabled_until ?? null,
    pending: m.pending ?? false,
    left_at: null,
  };
}

export function mapEmoji(e: DiscordApiEmoji, guildId: string): EmojiFields | null {
  if (!e.id) return null;
  return {
    id: e.id,
    guild_id: guildId,
    name: e.name ?? '',
    animated: e.animated ?? false,
    available: e.available ?? true,
    roles: e.roles ?? [],
    deleted_at: null,
  };
}

// ---------------------------------------------------------------- mensajes

/** Un MESSAGE_CREATE / respuesta REST trae el mensaje completo (autor + timestamp). */
export function isFullMessage(m: Partial<DiscordApiMessage>): m is DiscordApiMessage {
  return !!m.id && !!m.channel_id && !!m.author?.id && typeof m.timestamp === 'string';
}

export function mapMessage(m: DiscordApiMessage, guildId: string): MessageFields {
  return normalizeApiMessage(m, guildId);
}

/**
 * MESSAGE_UPDATE puede ser parcial (p. ej. solo `embeds` cuando Discord resuelve una vista previa).
 * Devuelve solo las columnas cuyo origen vino en el payload. Nunca `dev_id`/`client_nonce`.
 */
export function mapMessagePatch(m: Partial<DiscordApiMessage> & { id: string; channel_id: string }, guildId: string): MessagePatch {
  const filled = {
    type: 0,
    content: '',
    timestamp: new Date(0).toISOString(),
    edited_timestamp: null,
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    pinned: false,
    ...m,
    author: m.author ?? { id: '', username: '' },
  } as DiscordApiMessage;
  const full = normalizeApiMessage(filled, guildId);
  const has = (k: keyof DiscordApiMessage) => k in m;
  const patch: MessagePatch = {};
  if (has('type')) patch.type = full.type;
  if (has('author') && m.author?.id) {
    patch.author_id = full.author_id;
    patch.author_username = full.author_username;
    patch.author_global_name = full.author_global_name;
    patch.author_avatar = full.author_avatar;
    patch.author_bot = full.author_bot;
  }
  if (has('webhook_id')) patch.webhook_id = full.webhook_id;
  if (has('content')) patch.content = full.content;
  if (has('attachments')) patch.attachments = full.attachments;
  // Un mensaje en Components V2 (fichas de roz) no trae embeds: normalize aplana sus componentes en un
  // embed. Al editarse (p. ej. "Tomar") llegan los componentes nuevos: también actualizan ese embed.
  if (has('embeds') || (has('components') && ((m.flags ?? 0) & (1 << 15)) !== 0)) patch.embeds = full.embeds;
  if (has('sticker_items')) patch.stickers = full.stickers;
  if (has('mentions')) patch.mentions = full.mentions;
  if (has('mention_roles')) patch.mention_roles = full.mention_roles;
  if (has('mention_everyone')) patch.mention_everyone = full.mention_everyone;
  if (has('reactions')) patch.reactions = full.reactions;
  // La respuesta se deduce de message_reference, o de la línea de roz en el contenido de un webhook.
  // Sin message_reference ni línea de respuesta no se toca: una edición de roz reconstruye la línea,
  // y un payload parcial sin esos campos no dice nada sobre la respuesta.
  if (has('message_reference')) patch.reply_to_id = full.reply_to_id;
  else if (has('content') && m.webhook_id && full.reply_to_id) patch.reply_to_id = full.reply_to_id;
  if (has('thread')) patch.thread_id = full.thread_id;
  if (has('flags')) patch.flags = full.flags;
  if (has('pinned')) patch.pinned = full.pinned;
  if (has('timestamp')) patch.created_at = full.created_at;
  if (has('edited_timestamp')) patch.edited_at = full.edited_at;
  return patch;
}
