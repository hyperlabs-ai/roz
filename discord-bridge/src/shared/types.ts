// GENERADO por discord-bridge/scripts/sync-shared.mjs desde src/types/discord.ts. No editar a mano.
// Tipos compartidos del chat sobre Discord (ROZ_DISCORD_CHAT). Fuente ÚNICA para el backend de roz,
// el puente (discord-bridge/, que los copia o importa) y —copiados a mano, campo por campo—
// web/src/lib/api.ts. El contrato completo (endpoints, eventos, eco del webhook) vive en
// docs/discord-chat-contracts.md; si cambias algo aquí, cambia el doc y los espejos en el mismo cambio.
//
// Tres familias:
//   1. Filas de la base (snake_case) — migrations/0038_discord_chat.sql. Las escribe el puente.
//   2. Vistas para la UI (camelCase) — lo que devuelve /api/dashboard/discord/* y viaja por el
//      tiempo real.
//   3. Avisos puente → roz — POST /v1/internal/discord/events.
//
// Todos los ids de Discord son snowflakes en STRING, y los bitfields de permisos también (decimal).

// ================================================================ constantes de Discord

/** Tipos de canal de Discord que roz entiende. Ver https://discord.com/developers/docs/resources/channel#channel-object-channel-types */
export const DISCORD_CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE_VOICE: 13,
  GUILD_DIRECTORY: 14,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
} as const;
export type DiscordChannelTypeCode = (typeof DISCORD_CHANNEL_TYPE)[keyof typeof DISCORD_CHANNEL_TYPE] | number;

export const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  DISCORD_CHANNEL_TYPE.ANNOUNCEMENT_THREAD,
  DISCORD_CHANNEL_TYPE.PUBLIC_THREAD,
  DISCORD_CHANNEL_TYPE.PRIVATE_THREAD,
]);
export const VOICE_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  DISCORD_CHANNEL_TYPE.GUILD_VOICE,
  DISCORD_CHANNEL_TYPE.GUILD_STAGE_VOICE,
]);
/** Canales donde roz puede LEER y ESCRIBIR mensajes (los hilos van aparte). */
export const TEXT_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  DISCORD_CHANNEL_TYPE.GUILD_TEXT,
  DISCORD_CHANNEL_TYPE.GUILD_ANNOUNCEMENT,
]);

export function isThreadType(type: number): boolean {
  return THREAD_CHANNEL_TYPES.has(type);
}

/** Overwrite de permisos de un canal, tal cual lo manda Discord. `type`: 0 = rol, 1 = miembro. */
export interface DiscordPermissionOverwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

// ================================================================ 1. filas de la base

export interface DiscordGuildRow {
  id: string;
  name: string;
  icon: string | null;
  owner_id: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DiscordChannelRow {
  id: string;
  guild_id: string;
  type: number;
  name: string;
  topic: string | null;
  position: number;
  parent_id: string | null;
  nsfw: boolean;
  overwrites: DiscordPermissionOverwrite[];
  rate_limit_per_user: number;
  archived: boolean;
  locked: boolean;
  archived_at: string | null;
  owner_id: string | null;
  member_ids: string[];
  starter_message_id: string | null;
  message_count: number | null;
  last_message_id: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DiscordRoleRow {
  id: string;
  guild_id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  hoist: boolean;
  mentionable: boolean;
  managed: boolean;
  icon: string | null;
  unicode_emoji: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DiscordMemberRow {
  guild_id: string;
  user_id: string;
  username: string;
  global_name: string | null;
  nick: string | null;
  avatar: string | null;
  guild_avatar: string | null;
  bot: boolean;
  roles: string[];
  joined_at: string | null;
  communication_disabled_until: string | null;
  pending: boolean;
  created_at: string;
  updated_at: string;
  left_at: string | null;
}

export interface DiscordEmojiRow {
  id: string;
  guild_id: string;
  name: string;
  animated: boolean;
  available: boolean;
  roles: string[];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Adjunto normalizado (columna discord_message.attachments). */
export interface DiscordAttachment {
  id: string;
  filename: string;
  contentType: string | null;
  size: number;
  /** URL del CDN de Discord. Las URLs de adjuntos de Discord CADUCAN (parámetros ex/is/hm): ver contrato §B. */
  url: string;
  proxyUrl: string | null;
  width: number | null;
  height: number | null;
  description: string | null;
  /** Nota de voz / duración de audio, si aplica. */
  durationSecs: number | null;
  spoiler: boolean;
}

/** Embed normalizado (subconjunto de lo que pinta roz; columna discord_message.embeds). */
export interface DiscordEmbed {
  type: string | null;
  title: string | null;
  description: string | null;
  url: string | null;
  color: number | null;
  timestamp: string | null;
  author: { name: string; url: string | null; iconUrl: string | null } | null;
  footer: { text: string; iconUrl: string | null } | null;
  image: { url: string; width: number | null; height: number | null } | null;
  thumbnail: { url: string; width: number | null; height: number | null } | null;
  video: { url: string; width: number | null; height: number | null } | null;
  provider: { name: string | null; url: string | null } | null;
  fields: { name: string; value: string; inline: boolean }[];
}

export interface DiscordSticker {
  id: string;
  name: string;
  /** 1 PNG, 2 APNG, 3 Lottie, 4 GIF. */
  formatType: number;
}

/** Emoji de una reacción: `id` null = emoji unicode (va en `name`). */
export interface DiscordEmojiRef {
  id: string | null;
  name: string | null;
  animated: boolean;
}

/** Reacción normalizada (columna discord_message.reactions). Solo lectura en roz: ver contrato §B.7. */
export interface DiscordReaction {
  emoji: DiscordEmojiRef;
  count: number;
  burstCount: number;
  /** Quiénes reaccionaron, si el puente los conoce (MESSAGE_REACTION_ADD trae el user_id). */
  userIds: string[];
}

export interface DiscordMentionedUser {
  id: string;
  username: string;
  globalName: string | null;
}

export interface DiscordMessageRow {
  id: string;
  guild_id: string;
  channel_id: string;
  type: number;
  author_id: string;
  author_username: string;
  author_global_name: string | null;
  author_avatar: string | null;
  author_bot: boolean;
  webhook_id: string | null;
  dev_id: string | null;
  client_nonce: string | null;
  content: string;
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
  stickers: DiscordSticker[];
  mentions: DiscordMentionedUser[];
  mention_roles: string[];
  mention_everyone: boolean;
  reactions: DiscordReaction[];
  reply_to_id: string | null;
  thread_id: string | null;
  flags: number;
  pinned: boolean;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  synced_at: string;
}

export interface DiscordWebhookRow {
  channel_id: string;
  guild_id: string;
  webhook_id: string;
  /** encryptSecret(token). Nunca en claro fuera de src/discord/webhooks.ts. */
  token_enc: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface DiscordLinkRow {
  dev_id: string;
  discord_user_id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  linked_at: string;
  updated_at: string;
}

export interface DiscordProjectChannelRow {
  project_id: string;
  channel_id: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DiscordSyncStateRow {
  channel_id: string;
  guild_id: string;
  oldest_message_id: string | null;
  newest_message_id: string | null;
  backfill_complete: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export type DiscordBridgeStatus = 'connecting' | 'backfilling' | 'ready' | 'disconnected';

export interface DiscordBridgeStateRow {
  guild_id: string;
  status: DiscordBridgeStatus;
  connected_at: string | null;
  last_ready_at: string | null;
  last_heartbeat_at: string | null;
  last_event_at: string | null;
  bridge_version: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface DiscordUploadRow {
  id: string;
  dev_id: string;
  channel_id: string;
  bucket: string;
  storage_path: string;
  name: string;
  content_type: string | null;
  size: number | null;
  completed_at: string | null;
  message_id: string | null;
  created_at: string;
}

// ================================================================ 2. vistas para la UI (camelCase)

/** Por qué el chat de Discord no está listo para este dev (null = listo). */
export type DiscordUnavailableReason =
  | 'disabled'        // ROZ_DISCORD_CHAT apagado: el front usa el chat interno
  | 'not_configured'  // flag encendido pero faltan llaves (no debería pasar: config lo valida)
  | 'not_linked'      // el dev no ha ligado su cuenta de Discord
  | 'not_member';     // la cuenta ligada no está en el servidor (o lo dejó)

export interface DiscordLinkView {
  discordUserId: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
  linkedAt: string;
}

export interface DiscordGuildView {
  id: string;
  name: string;
  iconUrl: string | null;
}

export interface DiscordBridgeView {
  status: DiscordBridgeStatus;
  /** false si el último latido tiene más de 90 s (aunque status diga 'ready'). */
  healthy: boolean;
  lastHeartbeatAt: string | null;
  lastReadyAt: string | null;
}

/** GET /api/dashboard/discord/status */
export interface DiscordStatusView {
  enabled: boolean;
  unavailable: DiscordUnavailableReason | null;
  link: DiscordLinkView | null;
  guild: DiscordGuildView | null;
  bridge: DiscordBridgeView | null;
  /** Tope por adjunto (bytes) al escribir desde roz. */
  maxUploadBytes: number;
  /** Límites de Discord que la UI explica (texto fijo en español). Ver contrato §B.1. */
  limits: string[];
}

/** Lo que el dev puede hacer en un canal/hilo (calculado con src/discord/permissions.ts). */
export interface DiscordChannelAbilities {
  send: boolean;
  attach: boolean;
  /** Mencionar @everyone/@here: roz NUNCA los hace sonar (allowed_mentions), aunque sea true. */
  mentionEveryone: boolean;
  readHistory: boolean;
}

export interface DiscordThreadView {
  id: string;
  parentId: string;
  name: string;
  type: number;
  archived: boolean;
  locked: boolean;
  private: boolean;
  starterMessageId: string | null;
  messageCount: number | null;
  lastMessageAt: string | null;
  /** Cuándo se archivó (null si está activo). Es la llave de `before` al paginar los archivados. */
  archivedAt: string | null;
  abilities: DiscordChannelAbilities;
}

export interface DiscordChannelView {
  id: string;
  /** 0 texto, 5 anuncios, 15 foro, 16 media, 2/13 voz (se listan deshabilitados: no hay voz). */
  type: number;
  name: string;
  topic: string | null;
  position: number;
  parentId: string | null;
  nsfw: boolean;
  /** Overwrites idénticos a los de su categoría (como "Sincronizado" en Discord). */
  syncedWithCategory: boolean;
  /** false para voz/foro/media/directorio: se ven pero no se abren en roz (contrato §B.1). */
  supported: boolean;
  lastMessageId: string | null;
  lastMessageAt: string | null;
  abilities: DiscordChannelAbilities;
  /** Hilos activos (no archivados) visibles para el dev. Los archivados se piden aparte. */
  threads: DiscordThreadView[];
}

export interface DiscordCategoryView {
  id: string;
  name: string;
  position: number;
  channels: DiscordChannelView[];
}

/** GET /api/dashboard/discord/channels */
export interface DiscordChannelTreeView {
  /** Canales sin categoría, ordenados como en Discord. */
  uncategorized: DiscordChannelView[];
  /** Solo categorías con al menos un canal visible, ordenadas por posición. */
  categories: DiscordCategoryView[];
}

export interface DiscordAuthorView {
  /** Id de Discord del autor (para un webhook, el id del webhook). */
  discordUserId: string;
  /** Nombre a mostrar ya resuelto: dev de roz > apodo del servidor > global_name > username. */
  displayName: string;
  username: string;
  avatarUrl: string | null;
  bot: boolean;
  /** true si es un webhook (incluidos los de roz). */
  webhook: boolean;
  /** Dev de roz que lo escribió: por el webhook de roz (dev_id) o por su cuenta ligada. */
  devId: string | null;
  /** true si es el propio bot de roz (sus avisos): la UI pinta a Roz-bot en vez de su avatar. */
  rozBot?: boolean;
}

/** Referencia a una tarea detectada en el texto (#HYP-12 de Linear, ROZ-123 viejos). */
export interface DiscordTaskRef {
  identifier: string;
  workItemId: string | null;
  name: string | null;
  status: string | null;
  url: string | null;
}

export interface DiscordReplyView {
  id: string;
  author: DiscordAuthorView | null;
  /** Primeros ~120 caracteres del mensaje citado, en texto plano. null = no está en el espejo. */
  excerpt: string | null;
  deleted: boolean;
}

/** Mensaje tal como lo pinta la UI. Mismo objeto para todos los devs: "es mío" lo decide el front con devId. */
export interface DiscordMessageView {
  id: string;
  channelId: string;
  guildId: string;
  type: number;
  author: DiscordAuthorView;
  /** Markdown de Discord SIN el prefijo de respuesta de roz (src/discord/reply.ts). */
  content: string;
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
  stickers: DiscordSticker[];
  mentions: DiscordMentionedUser[];
  mentionRoles: string[];
  mentionEveryone: boolean;
  reactions: DiscordReaction[];
  replyTo: DiscordReplyView | null;
  /** Hilo que nació de este mensaje. */
  thread: { id: string; name: string; messageCount: number | null; lastMessageAt: string | null } | null;
  tasks: DiscordTaskRef[];
  pinned: boolean;
  createdAt: string;
  editedAt: string | null;
  /** true si salió de roz por webhook (lo puede editar/borrar su dev desde roz). */
  fromRoz: boolean;
  clientNonce: string | null;
}

/** GET /api/dashboard/discord/channels/:channelId/messages */
export interface DiscordMessagePage {
  messages: DiscordMessageView[];
  /** Hay mensajes más viejos en el espejo (o en Discord, si el backfill no ha terminado). */
  hasMore: boolean;
  /** false mientras el puente no termine el backfill de este canal. */
  backfillComplete: boolean;
}

/** Miembro para el autocompletado de @menciones (GET /api/dashboard/discord/members). */
export interface DiscordMemberView {
  discordUserId: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  bot: boolean;
  devId: string | null;
}

/** Emoji del servidor para el selector (GET /api/dashboard/discord/emojis). */
export interface DiscordEmojiView {
  id: string;
  name: string;
  animated: boolean;
  url: string;
}

/** Rol para pintar menciones <@&id> (GET /api/dashboard/discord/roles). */
export interface DiscordRoleView {
  id: string;
  name: string;
  color: number;
  position: number;
}

/** Adjunto en tránsito (antes de enviar). */
export interface DiscordUploadView {
  id: string;
  name: string;
  contentType: string | null;
  size: number | null;
}

export interface DiscordProjectChannelView {
  projectId: string;
  projectName: string;
  channelId: string | null;
  channelName: string | null;
}

// ================================================================ tiempo real (roz → front)

/**
 * Eventos por el buzón privado `chat:dev:<devId>` (el mismo del chat interno; src/chat/realtime.ts).
 * Prefijo `discord.` para que nunca se confundan con los del chat interno.
 */
export type DiscordRealtimeEvent =
  | 'discord.message.created'
  | 'discord.message.updated'
  | 'discord.message.deleted'
  | 'discord.channels.changed'
  | 'discord.link.changed'
  | 'discord.bridge.status';

export interface DiscordRealtimePayloads {
  'discord.message.created': { channelId: string; message: DiscordMessageView };
  'discord.message.updated': { channelId: string; message: DiscordMessageView };
  'discord.message.deleted': { channelId: string; messageIds: string[] };
  /** Cambió la estructura o los permisos: el front vuelve a pedir /channels. */
  'discord.channels.changed': { reason: DiscordStructureScope };
  'discord.link.changed': { linked: boolean };
  'discord.bridge.status': { status: DiscordBridgeStatus };
}

// ================================================================ 3. avisos puente → roz

export type DiscordStructureScope = 'guild' | 'channels' | 'roles' | 'members' | 'emojis' | 'threads';

/**
 * Un aviso del puente: "ya escribí esto en la base". Lleva solo ids; roz relee la fila (fuente de
 * verdad = la base), calcula quién la puede ver y transmite. Así un aviso repetido o fuera de orden
 * solo provoca una retransmisión del estado ACTUAL, nunca un estado viejo.
 */
export type DiscordBridgeNotice =
  | { kind: 'message.created'; channelId: string; messageId: string }
  | { kind: 'message.updated'; channelId: string; messageId: string }
  | { kind: 'message.deleted'; channelId: string; messageIds: string[] }
  /** Cambió la estructura/permisos/roles/miembros. `userIds` = miembros afectados, si se conocen. */
  | { kind: 'structure.changed'; scope: DiscordStructureScope; channelIds?: string[]; userIds?: string[] }
  | { kind: 'bridge.status'; status: DiscordBridgeStatus };

/** Cuerpo de POST /v1/internal/discord/events. */
export interface DiscordBridgeEventsBody {
  guildId: string;
  /** Máximo 100 por llamada; el puente agrupa en ventanas de ~250 ms. */
  notices: DiscordBridgeNotice[];
}

export interface DiscordBridgeEventsResult {
  ok: true;
  processed: number;
  /** Avisos ignorados (canal/mensaje que no existe en el espejo, guild ajena, etc.). */
  skipped: number;
}
