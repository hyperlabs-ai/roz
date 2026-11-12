// Formas CRUDAS (snake_case) de la API/gateway de Discord que usa el puente. Las de mensaje son las
// mismas que src/adapters/discord.ts de roz (normalize.ts las importa con estos nombres); las demás
// (guild, rol, miembro, emoji, hilo) solo las necesita el puente.
import type { DiscordPermissionOverwrite } from './types.js';

export interface DiscordApiUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  discriminator?: string;
  bot?: boolean;
}

export interface DiscordApiAttachment {
  id: string;
  filename: string;
  description?: string | null;
  content_type?: string | null;
  size: number;
  url: string;
  proxy_url?: string | null;
  height?: number | null;
  width?: number | null;
  duration_secs?: number | null;
  flags?: number;
}

export interface DiscordApiEmbed {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  author?: { name: string; url?: string; icon_url?: string };
  footer?: { text: string; icon_url?: string };
  image?: { url: string; width?: number; height?: number };
  thumbnail?: { url: string; width?: number; height?: number };
  video?: { url?: string; width?: number; height?: number };
  provider?: { name?: string; url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface DiscordApiReaction {
  count: number;
  count_details?: { burst: number; normal: number };
  me?: boolean;
  emoji: { id: string | null; name: string | null; animated?: boolean };
}

export interface DiscordApiMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  type: number;
  author: DiscordApiUser;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  webhook_id?: string;
  attachments: DiscordApiAttachment[];
  embeds: DiscordApiEmbed[];
  mentions: DiscordApiUser[];
  mention_roles: string[];
  mention_everyone: boolean;
  pinned: boolean;
  flags?: number;
  /** Componentes del mensaje (filas, o Components V2 si flags trae 1 << 15). */
  components?: unknown[];
  reactions?: DiscordApiReaction[];
  message_reference?: { type?: number; message_id?: string; channel_id?: string; guild_id?: string };
  thread?: { id: string; name: string; message_count?: number };
  sticker_items?: { id: string; name: string; format_type: number }[];
}

export interface DiscordApiGuild {
  id: string;
  name: string;
  icon?: string | null;
  owner_id: string;
  description?: string | null;
  unavailable?: boolean;
}

export interface DiscordApiRole {
  id: string;
  name: string;
  color?: number;
  position?: number;
  permissions: string;
  hoist?: boolean;
  mentionable?: boolean;
  managed?: boolean;
  icon?: string | null;
  unicode_emoji?: string | null;
}

export interface DiscordApiThreadMetadata {
  archived?: boolean;
  locked?: boolean;
  archive_timestamp?: string | null;
}

/** Canal, categoría o hilo (en Discord los tres son "canales"). */
export interface DiscordApiChannel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string | null;
  topic?: string | null;
  position?: number;
  parent_id?: string | null;
  nsfw?: boolean;
  permission_overwrites?: Array<{ id: string; type: number | string; allow: string; deny: string }>;
  rate_limit_per_user?: number;
  owner_id?: string | null;
  message_count?: number;
  last_message_id?: string | null;
  thread_metadata?: DiscordApiThreadMetadata;
}

export interface DiscordApiGuildMember {
  user?: DiscordApiUser;
  nick?: string | null;
  avatar?: string | null;
  roles: string[];
  joined_at?: string | null;
  pending?: boolean;
  communication_disabled_until?: string | null;
}

export interface DiscordApiEmoji {
  id: string | null;
  name: string | null;
  animated?: boolean;
  available?: boolean;
  roles?: string[];
}

export interface DiscordApiThreadMember {
  id?: string;
  user_id?: string;
}

export type { DiscordPermissionOverwrite };
