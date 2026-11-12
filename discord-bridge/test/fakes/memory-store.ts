// MirrorStore en memoria con la MISMA semántica que PostgREST para lo que importa:
//   · upsert = insertar con defaults o, si existe, actualizar SOLO las columnas enviadas;
//   · update de una fila inexistente = no hace nada (false);
//   · borrado suave.
import type { ChannelFields, EmojiFields, GuildFields, MemberFields, MessageFields, MessagePatch, RoleFields } from '../../src/map.js';
import type {
  BridgeStateFields,
  ChannelMeta,
  ChannelPatch,
  MessageMeta,
  MirrorStore,
  SyncState,
  SyncStateFields,
} from '../../src/store/types.js';

type Row = Record<string, any>;

const CHANNEL_DEFAULTS = {
  name: '',
  topic: null,
  position: 0,
  parent_id: null,
  nsfw: false,
  overwrites: [],
  rate_limit_per_user: 0,
  archived: false,
  locked: false,
  archived_at: null,
  owner_id: null,
  member_ids: [],
  starter_message_id: null,
  message_count: null,
  last_message_id: null,
  last_message_at: null,
  deleted_at: null,
};
const MESSAGE_DEFAULTS = { dev_id: null, client_nonce: null, deleted_at: null, reactions: [], thread_id: null };
const SYNC_DEFAULTS = {
  oldest_message_id: null,
  newest_message_id: null,
  backfill_complete: false,
  last_synced_at: null,
  last_error: null,
};

export class MemoryStore implements MirrorStore {
  guilds = new Map<string, Row>();
  channels = new Map<string, Row>();
  roles = new Map<string, Row>();
  members = new Map<string, Row>(); // key guild:user
  emojis = new Map<string, Row>();
  messages = new Map<string, Row>();
  sync = new Map<string, Row>();
  bridge = new Map<string, Row>();
  /** Registro de operaciones (para afirmar orden "base antes que aviso"). */
  ops: string[] = [];
  /** Hace fallar las próximas N escrituras (para probar reintentos). */
  failNext = 0;

  private maybeFail(op: string): void {
    this.ops.push(op);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error(`fallo simulado en ${op}`);
    }
  }

  private up(table: Map<string, Row>, key: string, row: Row, defaults: Row): void {
    const prev = table.get(key);
    table.set(key, prev ? { ...prev, ...row } : { ...defaults, ...row });
  }

  async upsertGuild(row: GuildFields) {
    this.maybeFail('upsertGuild');
    this.up(this.guilds, row.id, row, { deleted_at: null });
  }
  async markGuildDeleted(id: string) {
    this.maybeFail('markGuildDeleted');
    const g = this.guilds.get(id);
    if (g) g.deleted_at = new Date().toISOString();
  }

  async upsertChannels(rows: ChannelFields[]) {
    this.maybeFail('upsertChannels');
    for (const r of rows) this.up(this.channels, r.id, r, CHANNEL_DEFAULTS);
  }
  async patchChannel(id: string, patch: ChannelPatch) {
    this.maybeFail('patchChannel');
    const c = this.channels.get(id);
    if (!c) return false;
    Object.assign(c, patch);
    return true;
  }
  private meta(c: Row): ChannelMeta {
    return {
      id: c.id,
      type: c.type,
      parent_id: c.parent_id,
      archived: c.archived,
      member_ids: c.member_ids,
      message_count: c.message_count,
      deleted_at: c.deleted_at,
    };
  }
  async getChannel(id: string) {
    const c = this.channels.get(id);
    return c ? this.meta(c) : null;
  }
  async listChannels(guildId: string) {
    return [...this.channels.values()].filter((c) => c.guild_id === guildId && !c.deleted_at).map((c) => this.meta(c));
  }
  private soft(table: Map<string, Row>, ids: string[], col = 'deleted_at'): string[] {
    const out: string[] = [];
    for (const id of new Set(ids)) {
      const r = table.get(id);
      if (r && !r[col]) {
        r[col] = new Date().toISOString();
        out.push(id);
      }
    }
    return out;
  }
  async softDeleteChannels(ids: string[]) {
    this.maybeFail('softDeleteChannels');
    return this.soft(this.channels, ids);
  }

  async upsertRoles(rows: RoleFields[]) {
    this.maybeFail('upsertRoles');
    for (const r of rows) this.up(this.roles, r.id, r, {});
  }
  async listRoleIds(guildId: string) {
    return [...this.roles.values()].filter((r) => r.guild_id === guildId && !r.deleted_at).map((r) => r.id as string);
  }
  async softDeleteRoles(ids: string[]) {
    this.maybeFail('softDeleteRoles');
    return this.soft(this.roles, ids);
  }

  async upsertMembers(rows: MemberFields[]) {
    this.maybeFail('upsertMembers');
    for (const r of rows) this.up(this.members, `${r.guild_id}:${r.user_id}`, r, {});
  }
  async listActiveMemberIds(guildId: string) {
    return [...this.members.values()].filter((m) => m.guild_id === guildId && !m.left_at).map((m) => m.user_id as string);
  }
  async markMembersLeft(guildId: string, userIds: string[]) {
    this.maybeFail('markMembersLeft');
    return this.soft(this.members, userIds.map((u) => `${guildId}:${u}`), 'left_at').map((k) => k.split(':')[1]!);
  }

  async upsertEmojis(rows: EmojiFields[]) {
    this.maybeFail('upsertEmojis');
    for (const r of rows) this.up(this.emojis, r.id, r, {});
  }
  async listEmojiIds(guildId: string) {
    return [...this.emojis.values()].filter((e) => e.guild_id === guildId && !e.deleted_at).map((e) => e.id as string);
  }
  async softDeleteEmojis(ids: string[]) {
    this.maybeFail('softDeleteEmojis');
    return this.soft(this.emojis, ids);
  }

  async upsertMessages(rows: MessageFields[]) {
    this.maybeFail('upsertMessages');
    // Como SupabaseMirrorStore: el upsert no manda deleted_at (nunca revive un borrado).
    for (const r of rows) {
      const { deleted_at: _x, ...rest } = r;
      this.up(this.messages, r.id, rest, MESSAGE_DEFAULTS);
    }
  }
  async updateMessage(id: string, patch: MessagePatch) {
    this.maybeFail('updateMessage');
    const m = this.messages.get(id);
    if (!m) return false;
    Object.assign(m, patch);
    return true;
  }
  async getMessages(ids: string[]) {
    const out = new Map<string, MessageMeta>();
    for (const id of ids) {
      const m = this.messages.get(id);
      if (m) out.set(id, { id, channel_id: m.channel_id, reactions: m.reactions, thread_id: m.thread_id, deleted_at: m.deleted_at });
    }
    return out;
  }
  async softDeleteMessages(ids: string[]) {
    this.maybeFail('softDeleteMessages');
    return this.soft(this.messages, ids);
  }
  async listMessageIdsBetween(channelId: string, fromIso: string | null, toIso: string) {
    return [...this.messages.values()]
      .filter(
        (m) =>
          m.channel_id === channelId &&
          !m.deleted_at &&
          Date.parse(m.created_at) <= Date.parse(toIso) &&
          (fromIso === null || Date.parse(m.created_at) >= Date.parse(fromIso)),
      )
      .map((m) => m.id as string);
  }
  async countMessages(channelId: string) {
    return [...this.messages.values()].filter((m) => m.channel_id === channelId).length;
  }

  async getSyncState(channelId: string) {
    return (this.sync.get(channelId) as SyncState | undefined) ?? null;
  }
  async upsertSyncState(row: SyncStateFields) {
    this.maybeFail('upsertSyncState');
    this.up(this.sync, row.channel_id, row, SYNC_DEFAULTS);
  }
  async upsertBridgeState(row: BridgeStateFields) {
    this.up(this.bridge, row.guild_id, row, {});
  }

  /** Mensajes vivos de un canal, del más viejo al más nuevo. */
  aliveIn(channelId: string): Row[] {
    return [...this.messages.values()]
      .filter((m) => m.channel_id === channelId && !m.deleted_at)
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }
}
