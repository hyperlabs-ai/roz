// Escritura del espejo en la base, detrás de una interfaz para poder probar el puente con una base
// en memoria (test/fakes/memory-store.ts). La implementación real es src/store/supabase.ts.
//
// Reglas que toda implementación cumple (contrato §A.3):
//   · upsert por llave primaria; nunca DELETE: borrar = deleted_at / left_at.
//   · solo se escriben las columnas presentes en cada fila (un evento parcial no pisa con null).
//   · discord_message: nunca dev_id ni client_nonce (los escribe roz; ver eco §D).
import type {
  ChannelFields,
  EmojiFields,
  GuildFields,
  MemberFields,
  MessageFields,
  MessagePatch,
  RoleFields,
} from '../map.js';
import type {
  DiscordBridgeStateRow,
  DiscordChannelRow,
  DiscordReaction,
  DiscordSyncStateRow,
} from '../shared/types.js';

export interface ChannelMeta {
  id: string;
  type: number;
  parent_id: string | null;
  archived: boolean;
  member_ids: string[];
  message_count: number | null;
  deleted_at: string | null;
}

export interface MessageMeta {
  id: string;
  channel_id: string;
  reactions: DiscordReaction[];
  thread_id: string | null;
  deleted_at: string | null;
}

export type ChannelPatch = Partial<Omit<DiscordChannelRow, 'id' | 'created_at' | 'updated_at'>>;
export type SyncStateFields = Pick<DiscordSyncStateRow, 'channel_id' | 'guild_id'> &
  Partial<Omit<DiscordSyncStateRow, 'channel_id' | 'guild_id' | 'updated_at'>>;
export type SyncState = Omit<DiscordSyncStateRow, 'updated_at'>;
export type BridgeStateFields = Pick<DiscordBridgeStateRow, 'guild_id'> &
  Partial<Omit<DiscordBridgeStateRow, 'guild_id' | 'updated_at'>>;

export interface MirrorStore {
  // servidor
  upsertGuild(row: GuildFields): Promise<void>;
  markGuildDeleted(guildId: string): Promise<void>;

  // canales, categorías e hilos
  upsertChannels(rows: ChannelFields[]): Promise<void>;
  /** false si el canal no existe en el espejo. */
  patchChannel(id: string, patch: ChannelPatch): Promise<boolean>;
  getChannel(id: string): Promise<ChannelMeta | null>;
  /** Canales vivos (sin deleted_at) del servidor. */
  listChannels(guildId: string): Promise<ChannelMeta[]>;
  /** Devuelve los ids que de verdad cambiaron (los ya borrados no cuentan). */
  softDeleteChannels(ids: string[]): Promise<string[]>;

  // roles
  upsertRoles(rows: RoleFields[]): Promise<void>;
  listRoleIds(guildId: string): Promise<string[]>;
  softDeleteRoles(ids: string[]): Promise<string[]>;

  // miembros
  upsertMembers(rows: MemberFields[]): Promise<void>;
  listActiveMemberIds(guildId: string): Promise<string[]>;
  markMembersLeft(guildId: string, userIds: string[]): Promise<string[]>;

  // emojis
  upsertEmojis(rows: EmojiFields[]): Promise<void>;
  listEmojiIds(guildId: string): Promise<string[]>;
  softDeleteEmojis(ids: string[]): Promise<string[]>;

  // mensajes
  upsertMessages(rows: MessageFields[]): Promise<void>;
  /** UPDATE de las columnas dadas; false si el mensaje no está en el espejo. */
  updateMessage(id: string, patch: MessagePatch): Promise<boolean>;
  getMessages(ids: string[]): Promise<Map<string, MessageMeta>>;
  softDeleteMessages(ids: string[]): Promise<string[]>;
  /** Ids vivos del canal con created_at en [fromIso, toIso] (fromIso null = desde el principio). */
  listMessageIdsBetween(channelId: string, fromIso: string | null, toIso: string): Promise<string[]>;
  countMessages(channelId: string): Promise<number>;

  // cursores y estado
  getSyncState(channelId: string): Promise<SyncState | null>;
  upsertSyncState(row: SyncStateFields): Promise<void>;
  upsertBridgeState(row: BridgeStateFields): Promise<void>;
}
