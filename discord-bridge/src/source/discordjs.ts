// Implementación real de Gateway y DiscordSource con discord.js v14.
//
// El puente NO usa los objetos de discord.js (camelCase, con caché): escucha el evento `raw` (cada
// DISPATCH del gateway, JSON crudo) y lee la REST con `client.rest` (JSON crudo, con el manejo de
// rate limit por ruta de discord.js). Así el gateway y el backfill producen exactamente la misma
// forma y pasan por los mismos mappers (src/map.ts, src/shared/normalize.ts).
import {
  Client,
  Events,
  GatewayIntentBits,
  Options,
  Partials,
  Routes,
  type GatewayDispatchPayload,
} from 'discord.js';
import type {
  DiscordApiChannel,
  DiscordApiEmoji,
  DiscordApiGuild,
  DiscordApiGuildMember,
  DiscordApiMessage,
  DiscordApiRole,
} from '../shared/api-types.js';
import { isNoAccess, type DiscordSource, type Gateway, type GatewayDisconnect, type MessageQuery } from './types.js';

/** Intents del contrato §A.3. GuildMembers y MessageContent son PRIVILEGIADOS (activar en el portal). */
export const BRIDGE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildEmojisAndStickers,
];

export function createDiscordClient(): Client {
  return new Client({
    intents: BRIDGE_INTENTS,
    // Reacciones y ediciones de mensajes viejos (que no están en la caché) también llegan.
    partials: [Partials.Message, Partials.Reaction, Partials.Channel, Partials.User, Partials.GuildMember, Partials.ThreadMember],
    // El espejo vive en Supabase: no hace falta guardar mensajes en memoria.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      ReactionManager: 0,
      ReactionUserManager: 0,
    }),
    // Nunca menciona con sonido por accidente (el puente no envía, pero por si acaso).
    allowedMentions: { parse: [] },
  });
}

export class DiscordJsGateway implements Gateway {
  constructor(
    private readonly client: Client,
    private readonly token: string,
  ) {}

  onDispatch(fn: (type: string, data: unknown) => void): void {
    this.client.on(Events.Raw, (packet: { op?: number; t?: string | null; d?: unknown } | GatewayDispatchPayload) => {
      const p = packet as { op?: number; t?: string | null; d?: unknown };
      if (p.op === 0 && p.t) fn(p.t, p.d);
    });
  }

  onDisconnect(fn: (info: GatewayDisconnect) => void): void {
    this.client.on(Events.ShardDisconnect, (ev: { code?: number; reason?: string }) => fn({ code: ev?.code, reason: ev?.reason }));
    this.client.on(Events.Invalidated, () => fn({ reason: 'sesión invalidada' }));
  }

  onReconnecting(fn: () => void): void {
    this.client.on(Events.ShardReconnecting, () => fn());
  }

  onError(fn: (err: unknown) => void): void {
    this.client.on(Events.ShardError, (err) => fn(err));
    this.client.on(Events.Error, (err) => fn(err));
  }

  async login(): Promise<void> {
    await this.client.login(this.token);
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }

  ping(): number | null {
    const p = this.client.ws.ping;
    return typeof p === 'number' && p >= 0 ? p : null;
  }
}

export class DiscordJsSource implements DiscordSource {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
  ) {}

  private get<T>(route: `/${string}`, query?: Record<string, string | undefined>): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) q.set(k, v);
    return this.client.rest.get(route, q.size ? { query: q } : undefined) as Promise<T>;
  }

  fetchGuild(): Promise<DiscordApiGuild> {
    return this.get(Routes.guild(this.guildId));
  }

  fetchRoles(): Promise<DiscordApiRole[]> {
    return this.get(Routes.guildRoles(this.guildId));
  }

  fetchChannels(): Promise<DiscordApiChannel[]> {
    return this.get(Routes.guildChannels(this.guildId));
  }

  async fetchActiveThreads(): Promise<DiscordApiChannel[]> {
    const res = await this.get<{ threads: DiscordApiChannel[] }>(Routes.guildActiveThreads(this.guildId));
    return res.threads ?? [];
  }

  async fetchArchivedPublicThreads(channelId: string, limit: number): Promise<DiscordApiChannel[]> {
    try {
      const res = await this.get<{ threads: DiscordApiChannel[] }>(Routes.channelThreads(channelId, 'public'), {
        limit: String(limit),
      });
      return res.threads ?? [];
    } catch (err) {
      if (isNoAccess(err)) return [];
      throw err;
    }
  }

  async fetchChannel(channelId: string): Promise<DiscordApiChannel | null> {
    try {
      return await this.get<DiscordApiChannel>(Routes.channel(channelId));
    } catch (err) {
      if (isNoAccess(err)) return null;
      throw err;
    }
  }

  async fetchThreadMemberIds(threadId: string): Promise<string[]> {
    try {
      const list = await this.get<Array<{ user_id?: string; id?: string }>>(Routes.threadMembers(threadId));
      return list.map((m) => m.user_id ?? '').filter(Boolean);
    } catch (err) {
      if (isNoAccess(err)) return [];
      throw err;
    }
  }

  fetchEmojis(): Promise<DiscordApiEmoji[]> {
    return this.get(Routes.guildEmojis(this.guildId));
  }

  async fetchMembers(): Promise<DiscordApiGuildMember[]> {
    const out: DiscordApiGuildMember[] = [];
    let after = '0';
    for (;;) {
      const page = await this.get<DiscordApiGuildMember[]>(Routes.guildMembers(this.guildId), { limit: '1000', after });
      out.push(...page);
      if (page.length < 1000) break;
      const last = page[page.length - 1]?.user?.id;
      if (!last) break;
      after = last;
    }
    return out;
  }

  fetchMessages(channelId: string, query: MessageQuery): Promise<DiscordApiMessage[]> {
    return this.get(Routes.channelMessages(channelId), {
      limit: String(Math.min(100, Math.max(1, query.limit))),
      before: query.before,
      after: query.after,
    });
  }

  async fetchMessage(channelId: string, messageId: string): Promise<DiscordApiMessage | null> {
    try {
      return await this.get<DiscordApiMessage>(Routes.channelMessage(channelId, messageId));
    } catch (err) {
      if (isNoAccess(err)) return null;
      throw err;
    }
  }
}
