// Discord simulado: payloads CRUDOS (snake_case, como el gateway/REST) y un DiscordSource en memoria
// con la semántica de paginación de GET /channels/:id/messages (before / after / limit ≤ 100).
import { EventEmitter } from 'node:events';
import type {
  DiscordApiChannel,
  DiscordApiEmoji,
  DiscordApiGuild,
  DiscordApiGuildMember,
  DiscordApiMessage,
  DiscordApiRole,
} from '../../src/shared/api-types.js';
import { compareSnowflakes, snowflakeFromTime } from '../../src/snowflake.js';
import type { DiscordSource, Gateway, GatewayDisconnect, MessageQuery } from '../../src/source/types.js';

export const GUILD = '100000000000000001';
export const BASE_MS = Date.parse('2026-01-01T00:00:00Z');

/** Snowflake determinista: `n` segundos después de BASE_MS (+ incremento para no repetir). */
export function sf(n: number, inc = 0): string {
  return (BigInt(snowflakeFromTime(BASE_MS + n * 1000)) + BigInt(inc)).toString();
}

export function user(id: string, extra: Partial<{ username: string; global_name: string | null; bot: boolean; avatar: string | null }> = {}) {
  return { id, username: extra.username ?? `u${id.slice(-4)}`, global_name: extra.global_name ?? null, avatar: extra.avatar ?? null, bot: extra.bot ?? false };
}

let seq = 0;
export function msg(channelId: string, n: number, extra: Partial<DiscordApiMessage> = {}): DiscordApiMessage {
  const id = extra.id ?? sf(n, seq++ % 1000);
  return {
    id,
    channel_id: channelId,
    guild_id: GUILD,
    type: 0,
    author: user('200000000000000001'),
    content: `mensaje ${n}`,
    timestamp: new Date(BASE_MS + n * 1000).toISOString(),
    edited_timestamp: null,
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    pinned: false,
    ...extra,
  };
}

export function textChannel(id: string, extra: Partial<DiscordApiChannel> = {}): DiscordApiChannel {
  return { id, type: 0, guild_id: GUILD, name: `canal-${id.slice(-3)}`, position: 0, parent_id: null, permission_overwrites: [], ...extra };
}

export function thread(id: string, parentId: string, extra: Partial<DiscordApiChannel> = {}): DiscordApiChannel {
  return {
    id,
    type: 11,
    guild_id: GUILD,
    name: `hilo-${id.slice(-3)}`,
    parent_id: parentId,
    owner_id: '200000000000000001',
    message_count: 0,
    thread_metadata: { archived: false, locked: false, archive_timestamp: '2026-01-01T00:00:00.000Z' },
    ...extra,
  };
}

export class FakeSource implements DiscordSource {
  guild: DiscordApiGuild = { id: GUILD, name: 'Hyper', icon: null, owner_id: '200000000000000009', description: null };
  roles: DiscordApiRole[] = [{ id: GUILD, name: '@everyone', permissions: '1024', position: 0 }];
  channels: DiscordApiChannel[] = [];
  activeThreads: DiscordApiChannel[] = [];
  archivedThreads = new Map<string, DiscordApiChannel[]>();
  threadMembers = new Map<string, string[]>();
  emojis: DiscordApiEmoji[] = [];
  members: DiscordApiGuildMember[] = [];
  /** Mensajes por canal (cualquier orden). */
  messages = new Map<string, DiscordApiMessage[]>();
  /** Canales donde el bot no tiene acceso (50001). */
  noAccess = new Set<string>();
  calls: string[] = [];

  async fetchGuild() {
    this.calls.push('guild');
    return this.guild;
  }
  async fetchRoles() {
    this.calls.push('roles');
    return this.roles;
  }
  async fetchChannels() {
    this.calls.push('channels');
    return this.channels;
  }
  async fetchActiveThreads() {
    this.calls.push('activeThreads');
    return this.activeThreads;
  }
  async fetchArchivedPublicThreads(channelId: string) {
    this.calls.push(`archived:${channelId}`);
    return this.archivedThreads.get(channelId) ?? [];
  }
  async fetchChannel(id: string) {
    this.calls.push(`channel:${id}`);
    return (
      [...this.channels, ...this.activeThreads, ...[...this.archivedThreads.values()].flat()].find((c) => c.id === id) ?? null
    );
  }
  async fetchThreadMemberIds(threadId: string) {
    this.calls.push(`threadMembers:${threadId}`);
    return this.threadMembers.get(threadId) ?? [];
  }
  async fetchEmojis() {
    this.calls.push('emojis');
    return this.emojis;
  }
  async fetchMembers() {
    this.calls.push('members');
    return this.members;
  }
  async fetchMessages(channelId: string, q: MessageQuery) {
    this.calls.push(`messages:${channelId}:${q.before ? 'before' : q.after ? 'after' : 'latest'}`);
    if (this.noAccess.has(channelId)) throw Object.assign(new Error('Missing Access'), { code: 50001, status: 403 });
    const all = [...(this.messages.get(channelId) ?? [])].sort((a, b) => compareSnowflakes(b.id, a.id)); // desc
    const limit = Math.min(100, q.limit);
    if (q.after) {
      // Discord: los `limit` inmediatamente posteriores, devueltos del más nuevo al más viejo.
      const after = all.filter((m) => compareSnowflakes(m.id, q.after!) > 0).reverse().slice(0, limit);
      return after.reverse();
    }
    const base = q.before ? all.filter((m) => compareSnowflakes(m.id, q.before!) < 0) : all;
    return base.slice(0, limit);
  }
  async fetchMessage(channelId: string, id: string) {
    this.calls.push(`message:${id}`);
    return (this.messages.get(channelId) ?? []).find((m) => m.id === id) ?? null;
  }

  addMessages(channelId: string, list: DiscordApiMessage[]) {
    this.messages.set(channelId, [...(this.messages.get(channelId) ?? []), ...list]);
  }
  removeMessages(channelId: string, ids: string[]) {
    const drop = new Set(ids);
    this.messages.set(channelId, (this.messages.get(channelId) ?? []).filter((m) => !drop.has(m.id)));
  }
}

export class FakeGateway extends EventEmitter implements Gateway {
  loggedIn = false;
  destroyed = false;
  pingMs: number | null = 42;
  onDispatch(fn: (t: string, d: unknown) => void) {
    this.on('dispatch', fn);
  }
  onDisconnect(fn: (info: GatewayDisconnect) => void) {
    this.on('disconnect', fn);
  }
  onReconnecting(fn: () => void) {
    this.on('reconnecting', fn);
  }
  onError(fn: (err: unknown) => void) {
    this.on('gwerror', fn);
  }
  async login() {
    this.loggedIn = true;
  }
  async destroy() {
    this.destroyed = true;
  }
  ping() {
    return this.pingMs;
  }
  dispatch(t: string, d: unknown) {
    this.emit('dispatch', t, d);
  }
}
