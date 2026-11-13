// Lo que el puente necesita de Discord, detrás de interfaces para probarlo sin red:
//   · DiscordSource: lecturas REST (backfill, reconciliación, mensajes viejos) que devuelven el JSON
//     CRUDO de la API (snake_case) — la misma forma que el gateway, así todo pasa por los mismos
//     mappers. Implementación real: src/source/discordjs.ts (REST de discord.js, con su rate limit).
//   · Gateway: la conexión persistente. Entrega cada DISPATCH crudo (t, d) y avisa de caídas.
import type {
  DiscordApiChannel,
  DiscordApiEmoji,
  DiscordApiGuild,
  DiscordApiGuildMember,
  DiscordApiMessage,
  DiscordApiRole,
} from '../shared/api-types.js';

export interface MessageQuery {
  before?: string;
  after?: string;
  limit: number;
}

export interface DiscordSource {
  fetchGuild(): Promise<DiscordApiGuild>;
  fetchRoles(): Promise<DiscordApiRole[]>;
  /** Canales y categorías (sin hilos). */
  fetchChannels(): Promise<DiscordApiChannel[]>;
  /** Hilos activos (no archivados) del servidor que el bot puede ver. */
  fetchActiveThreads(): Promise<DiscordApiChannel[]>;
  /** Una página de hilos públicos archivados de un canal (los más recientes). */
  fetchArchivedPublicThreads(channelId: string, limit: number): Promise<DiscordApiChannel[]>;
  /** null si el canal ya no existe (10003) o el bot no tiene acceso. */
  fetchChannel(channelId: string): Promise<DiscordApiChannel | null>;
  fetchThreadMemberIds(threadId: string): Promise<string[]>;
  fetchEmojis(): Promise<DiscordApiEmoji[]>;
  /** Todos los miembros (pagina de a 1000; requiere el intent privilegiado GuildMembers). */
  fetchMembers(): Promise<DiscordApiGuildMember[]>;
  /** Hasta 100 mensajes; el orden de la respuesta no se asume (el puente ordena por id). */
  fetchMessages(channelId: string, query: MessageQuery): Promise<DiscordApiMessage[]>;
  /** null si el mensaje no existe o no hay acceso. */
  fetchMessage(channelId: string, messageId: string): Promise<DiscordApiMessage | null>;
}

export interface GatewayDisconnect {
  code?: number;
  reason?: string;
}

export interface Gateway {
  /** Cada DISPATCH del gateway tal cual (incluye READY y RESUMED). */
  onDispatch(fn: (type: string, data: unknown) => void): void;
  onDisconnect(fn: (info: GatewayDisconnect) => void): void;
  onReconnecting(fn: () => void): void;
  onError(fn: (err: unknown) => void): void;
  login(): Promise<void>;
  destroy(): Promise<void>;
  /** Latencia del heartbeat del gateway en ms (null si no se sabe). */
  ping(): number | null;
}

/** Errores de Discord en los que no tiene sentido reintentar: el bot no ve el recurso. */
export const NO_ACCESS_CODES = new Set<number>([50001, 50013, 10003, 10008]);

export function discordErrorCode(err: unknown): number | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}

export function isNoAccess(err: unknown): boolean {
  const code = discordErrorCode(err);
  const status = (err as { status?: unknown } | null)?.status;
  return (code !== null && NO_ACCESS_CODES.has(code)) || status === 403 || status === 404;
}
