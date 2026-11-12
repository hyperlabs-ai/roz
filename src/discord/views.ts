// Filas del espejo → vistas de la UI (contrato §B.2 y §B.3). Lo que el front pinta: autores ya
// resueltos (dev de roz con su foto de GitHub, o el usuario de Discord con su avatar), la línea de
// respuesta de roz quitada y convertida en cita, fichas de tarea y URLs de adjuntos vigentes.
//
// Todo en lote: una página de 50 mensajes son ~6 consultas, no 6 por mensaje.
import { db } from '../db/supabase.js';
import {
  attachmentUrlExpiresAt,
  DISCORD_REFRESH_URLS_MAX,
  memberAvatarUrl,
  refreshAttachmentUrls,
  userAvatarUrl,
} from '../adapters/discord.js';
import { extractTaskIdentifiers, previewText } from '../chat/text.js';
import {
  DISCORD_CHANNEL_TYPE,
  TEXT_CHANNEL_TYPES,
  isThreadType,
  type DiscordAuthorView,
  type DiscordCategoryView,
  type DiscordChannelAbilities,
  type DiscordChannelRow,
  type DiscordChannelTreeView,
  type DiscordChannelView,
  type DiscordLinkRow,
  type DiscordMemberRow,
  type DiscordMessageRow,
  type DiscordMessageView,
  type DiscordReplyView,
  type DiscordTaskRef,
  type DiscordThreadView,
} from '../types/discord.js';
import { config } from '../config.js';
import { discordBotConfigured } from './enabled.js';
import { channelAbilities, isSyncedWithCategory, visibleChannelIds, type ChannelAbilities, type PermissionContext } from './permissions.js';
import { parseReplyPrefix } from './reply.js';
import {
  LINK_COLUMNS,
  MEMBER_COLUMNS,
  MESSAGE_COLUMNS,
  loadWebhookRows,
  selectIn,
  toPermissionChannel,
  webhookChannelOf,
  type GuildSnapshot,
} from './store.js';

// ---------------------------------------------------------------- utilidades puras

/** Orden de snowflakes (string) sin perder precisión. */
export function compareSnowflake(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function githubAvatar(login: string | null | undefined, size = 96): string | null {
  return login ? `https://github.com/${login}.png?size=${size}` : null;
}

export function toAbilitiesView(a: ChannelAbilities): DiscordChannelAbilities {
  return { send: a.send, attach: a.attach, mentionEveryone: a.mentionEveryone, readHistory: a.readHistory };
}

/** Texto plano corto de un mensaje de Discord (para la cita de una respuesta). */
export function plainExcerpt(
  content: string,
  names: { user: (id: string) => string | undefined; channel: (id: string) => string | undefined },
  max = 120,
): string {
  const text = content
    .replace(/<@!?(\d{15,25})>/g, (_, id: string) => `@${names.user(id) ?? 'alguien'}`)
    .replace(/<@&(\d{15,25})>/g, '@rol')
    .replace(/<#(\d{15,25})>/g, (_, id: string) => `#${names.channel(id) ?? 'canal'}`)
    .replace(/<a?:(\w+):\d{15,25}>/g, ':$1:')
    .replace(/<t:(\d+)(?::\w)?>/g, (_, s: string) => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace('T', ' '))
    .replace(/\|\|(.+?)\|\|/g, '$1')
    .replace(/^-# /gm, '');
  return previewText(text, () => undefined, max);
}

// ---------------------------------------------------------------- dependencias de un lote

interface DevLite {
  id: string;
  name: string;
  github_login: string | null;
}

interface WorkItemLite {
  id: string;
  identifier: string;
  legacy_identifier?: string | null;
  name: string;
  status: string;
  url: string | null;
  discord_message_id: string | null;
}

interface Deps {
  snap: GuildSnapshot;
  devs: Map<string, DevLite>;
  linkByUser: Map<string, DiscordLinkRow>;
  members: Map<string, DiscordMemberRow>;
  /** canal del webhook → webhook_id de roz. */
  rozWebhooks: Map<string, string>;
  replies: Map<string, DiscordMessageRow>;
  /** identificador citado (mayúsculas) → tarea; y tareas nacidas de cada mensaje. */
  tasksByIdent: Map<string, WorkItemLite>;
  tasksByOrigin: Map<string, WorkItemLite[]>;
}

const WORK_ITEM_COLUMNS = 'id, identifier, name, status, url, discord_message_id';

async function loadTasks(identifiers: string[], messageIds: string[]): Promise<Pick<Deps, 'tasksByIdent' | 'tasksByOrigin'>> {
  const tasksByIdent = new Map<string, WorkItemLite>();
  const tasksByOrigin = new Map<string, WorkItemLite[]>();
  const idents = [...new Set(identifiers.map((i) => i.toUpperCase()))];
  if (idents.length) {
    for (const w of await selectIn<WorkItemLite>('work_item', WORK_ITEM_COLUMNS, 'identifier', idents)) {
      tasksByIdent.set(w.identifier.toUpperCase(), w);
    }
    // ROZ-123 viejos (migrados a Linear: 0037). TOLERANTE: sin la columna, se ignora.
    const missing = idents.filter((i) => !tasksByIdent.has(i));
    if (missing.length) {
      try {
        const legacy = await selectIn<WorkItemLite>('work_item', `${WORK_ITEM_COLUMNS}, legacy_identifier`, 'legacy_identifier', missing);
        for (const w of legacy) if (w.legacy_identifier) tasksByIdent.set(w.legacy_identifier.toUpperCase(), w);
      } catch {
        /* 0037 sin aplicar */
      }
    }
  }
  if (messageIds.length) {
    for (const w of await selectIn<WorkItemLite>('work_item', WORK_ITEM_COLUMNS, 'discord_message_id', messageIds)) {
      if (!w.discord_message_id) continue;
      tasksByOrigin.set(w.discord_message_id, [...(tasksByOrigin.get(w.discord_message_id) ?? []), w]);
    }
  }
  return { tasksByIdent, tasksByOrigin };
}

async function loadDeps(rows: DiscordMessageRow[], snap: GuildSnapshot): Promise<Deps> {
  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter((x): x is string => !!x))];
  const replyRows = replyIds.length ? await selectIn<DiscordMessageRow>('discord_message', MESSAGE_COLUMNS, 'id', replyIds) : [];
  const replies = new Map(replyRows.map((r) => [r.id, r]));
  const all = [...rows, ...replyRows];

  const authorIds = [...new Set(all.filter((r) => !r.webhook_id).map((r) => r.author_id))];
  const [links, members, webhooks] = await Promise.all([
    selectIn<DiscordLinkRow>('discord_link', LINK_COLUMNS, 'discord_user_id', authorIds),
    selectIn<DiscordMemberRow>('discord_member', MEMBER_COLUMNS, 'user_id', authorIds, (q) => q.eq('guild_id', snap.guildId)),
    loadWebhookRows([...new Set(all.map((r) => webhookChannelOf(snap.channelRows.get(r.channel_id) ?? { id: r.channel_id, type: 0, parent_id: null })))]),
  ]);
  const linkByUser = new Map(links.map((l) => [l.discord_user_id, l]));
  const devIds = [...new Set([...all.map((r) => r.dev_id), ...links.map((l) => l.dev_id)].filter((x): x is string => !!x))];
  const devs = new Map((await selectIn<DevLite>('dev', 'id, name, github_login', 'id', devIds)).map((d) => [d.id, d]));

  const identifiers = rows.flatMap((r) => extractTaskIdentifiers(r.webhook_id ? parseReplyPrefix(r.content).body : r.content));
  const tasks = await loadTasks(identifiers, rows.map((r) => r.id));

  return {
    snap,
    devs,
    linkByUser,
    members: new Map(members.map((m) => [m.user_id, m])),
    rozWebhooks: new Map([...webhooks.values()].map((w) => [w.channel_id, w.webhook_id])),
    replies,
    ...tasks,
  };
}

// ---------------------------------------------------------------- piezas de la vista

function isFromRoz(row: DiscordMessageRow, deps: Deps): boolean {
  if (!row.dev_id || !row.webhook_id) return false;
  const channel = deps.snap.channelRows.get(row.channel_id);
  const hookChannel = channel ? webhookChannelOf(channel) : row.channel_id;
  return deps.rozWebhooks.get(hookChannel) === row.webhook_id;
}

function authorOf(row: DiscordMessageRow, deps: Deps): DiscordAuthorView {
  const webhook = !!row.webhook_id;
  const fromRoz = isFromRoz(row, deps);
  const link = webhook ? undefined : deps.linkByUser.get(row.author_id);
  const devId = (fromRoz ? row.dev_id : null) ?? link?.dev_id ?? null;
  const dev = devId ? deps.devs.get(devId) : undefined;
  const member = webhook ? undefined : deps.members.get(row.author_id);

  let displayName: string;
  if (fromRoz && dev) displayName = dev.name;
  else if (member && !member.left_at) displayName = member.nick ?? member.global_name ?? member.username;
  else displayName = row.author_global_name ?? row.author_username;

  let avatarUrl: string | null = githubAvatar(dev?.github_login);
  if (!avatarUrl && member?.guild_avatar) avatarUrl = memberAvatarUrl(deps.snap.guildId, row.author_id, member.guild_avatar);
  if (!avatarUrl) avatarUrl = userAvatarUrl(row.author_id, row.author_avatar);

  return {
    discordUserId: row.author_id,
    displayName: displayName || row.author_username || 'Desconocido',
    username: row.author_username,
    avatarUrl,
    bot: row.author_bot,
    webhook,
    devId,
    // El usuario del bot comparte id con la aplicación (DISCORD_CLIENT_ID).
    rozBot: row.author_bot && !webhook && !!config.discord.clientId && row.author_id === config.discord.clientId,
  };
}

function bodyOf(row: DiscordMessageRow): string {
  return row.webhook_id ? parseReplyPrefix(row.content).body : row.content;
}

function replyOf(row: DiscordMessageRow, deps: Deps): DiscordReplyView | null {
  if (!row.reply_to_id) return null;
  const target = deps.replies.get(row.reply_to_id);
  if (!target) return { id: row.reply_to_id, author: null, excerpt: null, deleted: false };
  // Una respuesta de Discord siempre vive en el canal del mensaje citado. Si la fila apunta a OTRO
  // canal (una línea de respuesta escrita a mano en un webhook, o un dato viejo) no se cita: el
  // extracto podría ser de un canal que quien lee no ve, y esta vista se transmite a todo el canal.
  if (target.channel_id !== row.channel_id) return null;
  const names = {
    user: (id: string) => {
      const m = deps.members.get(id);
      return m ? m.nick ?? m.global_name ?? m.username : undefined;
    },
    channel: (id: string) => deps.snap.channelRows.get(id)?.name,
  };
  const deleted = !!target.deleted_at;
  return { id: target.id, author: authorOf(target, deps), excerpt: deleted ? null : plainExcerpt(bodyOf(target), names), deleted };
}

function taskRef(w: WorkItemLite): DiscordTaskRef {
  return { identifier: w.identifier, workItemId: w.id, name: w.name, status: w.status, url: w.url ?? null };
}

function tasksOf(row: DiscordMessageRow, deps: Deps): DiscordTaskRef[] {
  const out = new Map<string, DiscordTaskRef>();
  for (const w of deps.tasksByOrigin.get(row.id) ?? []) out.set(w.id, taskRef(w));
  for (const ident of extractTaskIdentifiers(bodyOf(row))) {
    const w = deps.tasksByIdent.get(ident);
    if (w && !out.has(w.id)) out.set(w.id, taskRef(w));
  }
  return [...out.values()];
}

function toView(row: DiscordMessageRow, deps: Deps): DiscordMessageView {
  const thread = row.thread_id ? deps.snap.channelRows.get(row.thread_id) : undefined;
  return {
    id: row.id,
    channelId: row.channel_id,
    guildId: row.guild_id,
    type: row.type,
    author: authorOf(row, deps),
    content: bodyOf(row),
    attachments: row.attachments ?? [],
    embeds: row.embeds ?? [],
    stickers: row.stickers ?? [],
    mentions: row.mentions ?? [],
    mentionRoles: row.mention_roles ?? [],
    mentionEveryone: row.mention_everyone,
    reactions: row.reactions ?? [],
    replyTo: replyOf(row, deps),
    thread:
      row.thread_id && thread && !thread.deleted_at
        ? { id: thread.id, name: thread.name, messageCount: thread.message_count, lastMessageAt: thread.last_message_at }
        : null,
    tasks: tasksOf(row, deps),
    pinned: row.pinned,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    fromRoz: isFromRoz(row, deps),
    clientNonce: row.client_nonce,
  };
}

// ---------------------------------------------------------------- URLs de adjuntos

/** Margen: se refrescan las URLs que caducan en menos de esto. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

/**
 * Las URLs de adjuntos de Discord caducan (~24 h). Las que vencen pronto se piden de nuevo (lotes de
 * 50) y se guardan en la fila. Best-effort: si Discord no responde, se entregan las viejas.
 */
export async function refreshExpiringAttachments(rows: DiscordMessageRow[], now = Date.now()): Promise<void> {
  if (!discordBotConfigured()) return;
  const stale = new Set<string>();
  for (const r of rows) {
    for (const a of r.attachments ?? []) {
      const exp = attachmentUrlExpiresAt(a.url);
      if (exp !== null && exp - now < REFRESH_MARGIN_MS) stale.add(a.url);
    }
  }
  if (!stale.size) return;
  const fresh = new Map<string, string>();
  const list = [...stale];
  try {
    for (let i = 0; i < list.length; i += DISCORD_REFRESH_URLS_MAX) {
      for (const [k, v] of await refreshAttachmentUrls(list.slice(i, i + DISCORD_REFRESH_URLS_MAX))) fresh.set(k, v);
    }
  } catch {
    // Discord caído o rate limit: las URLs viejas quizá aún sirvan unos minutos.
  }
  if (!fresh.size) return;
  for (const r of rows) {
    let changed = false;
    const next = (r.attachments ?? []).map((a) => {
      const url = fresh.get(a.url);
      if (!url) return a;
      changed = true;
      return { ...a, url };
    });
    if (!changed) continue;
    r.attachments = next;
    await db().from('discord_message').update({ attachments: next }).eq('id', r.id).then(() => {}, () => {});
  }
}

/** Vistas de un lote de filas, en el MISMO orden. */
export async function buildMessageViews(
  rows: DiscordMessageRow[],
  snap: GuildSnapshot,
  opts: { refreshAttachments?: boolean } = {},
): Promise<DiscordMessageView[]> {
  if (!rows.length) return [];
  if (opts.refreshAttachments !== false) await refreshExpiringAttachments(rows);
  const deps = await loadDeps(rows, snap);
  return rows.map((r) => toView(r, deps));
}

// ---------------------------------------------------------------- árbol de canales

function byPosition(a: DiscordChannelRow, b: DiscordChannelRow): number {
  return a.position - b.position || compareSnowflake(a.id, b.id);
}

function byRecent(a: DiscordChannelRow, b: DiscordChannelRow): number {
  const ta = a.last_message_at ? Date.parse(a.last_message_at) : 0;
  const tb = b.last_message_at ? Date.parse(b.last_message_at) : 0;
  return tb - ta || compareSnowflake(b.id, a.id);
}

export function threadView(row: DiscordChannelRow, ctx: PermissionContext): DiscordThreadView {
  return {
    id: row.id,
    parentId: row.parent_id ?? '',
    name: row.name,
    type: row.type,
    archived: row.archived,
    locked: row.locked,
    private: row.type === DISCORD_CHANNEL_TYPE.PRIVATE_THREAD,
    starterMessageId: row.starter_message_id,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at,
    archivedAt: row.archived ? row.archived_at : null,
    abilities: toAbilitiesView(channelAbilities(ctx, row.id)),
  };
}

/**
 * Hilos ARCHIVADOS visibles de un canal (contrato §B.2), del más recién archivado al más viejo,
 * paginados con `before` (ISO de archived_at). Del snapshot: el puente los guarda cuando los ve.
 */
export function archivedThreads(
  snap: GuildSnapshot,
  ctx: PermissionContext,
  channelId: string,
  opts: { before?: string | null; limit?: number | null } = {},
): { threads: DiscordThreadView[]; hasMore: boolean } {
  const limit = Math.min(Math.max(Math.trunc(Number(opts.limit) || 25), 1), 100);
  const before = opts.before ? Date.parse(opts.before) : Number.POSITIVE_INFINITY;
  const archivedAt = (r: DiscordChannelRow) => (r.archived_at ? Date.parse(r.archived_at) : 0);
  const visible = visibleChannelIds(ctx);
  const list = [...snap.channelRows.values()]
    .filter((r) => r.parent_id === channelId && isThreadType(r.type) && r.archived && !r.deleted_at && visible.has(r.id))
    .filter((r) => archivedAt(r) < before)
    .sort((a, b) => archivedAt(b) - archivedAt(a) || compareSnowflake(b.id, a.id));
  return { threads: list.slice(0, limit).map((t) => threadView(t, ctx)), hasMore: list.length > limit };
}

/** Árbol de canales visibles para el miembro, ordenado como en Discord (contrato §B.2). */
export function buildChannelTree(snap: GuildSnapshot, ctx: PermissionContext): DiscordChannelTreeView {
  const visible = visibleChannelIds(ctx);
  const live = [...snap.channelRows.values()].filter((r) => !r.deleted_at && visible.has(r.id));

  const threadsByParent = new Map<string, DiscordChannelRow[]>();
  for (const t of live.filter((r) => isThreadType(r.type) && !r.archived && r.parent_id)) {
    threadsByParent.set(t.parent_id!, [...(threadsByParent.get(t.parent_id!) ?? []), t]);
  }

  const toChannel = (row: DiscordChannelRow): DiscordChannelView => {
    const category = row.parent_id ? snap.channelRows.get(row.parent_id) : undefined;
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      topic: row.topic,
      position: row.position,
      parentId: row.parent_id,
      nsfw: row.nsfw,
      syncedWithCategory:
        !!category && category.type === DISCORD_CHANNEL_TYPE.GUILD_CATEGORY
          ? isSyncedWithCategory(toPermissionChannel(row), toPermissionChannel(category))
          : false,
      supported: TEXT_CHANNEL_TYPES.has(row.type),
      lastMessageId: row.last_message_id,
      lastMessageAt: row.last_message_at,
      abilities: toAbilitiesView(channelAbilities(ctx, row.id)),
      threads: (threadsByParent.get(row.id) ?? []).sort(byRecent).map((t) => threadView(t, ctx)),
    };
  };

  const categories = live.filter((r) => r.type === DISCORD_CHANNEL_TYPE.GUILD_CATEGORY).sort(byPosition);
  const categoryIds = new Set(categories.map((c) => c.id));
  const channels = live.filter((r) => r.type !== DISCORD_CHANNEL_TYPE.GUILD_CATEGORY && !isThreadType(r.type)).sort(byPosition);

  const out: DiscordChannelTreeView = { uncategorized: [], categories: [] };
  const byCategory = new Map<string, DiscordCategoryView>();
  for (const c of categories) {
    const view: DiscordCategoryView = { id: c.id, name: c.name, position: c.position, channels: [] };
    byCategory.set(c.id, view);
  }
  for (const ch of channels) {
    const cat = ch.parent_id && categoryIds.has(ch.parent_id) ? byCategory.get(ch.parent_id) : undefined;
    if (cat) cat.channels.push(toChannel(ch));
    else out.uncategorized.push(toChannel(ch));
  }
  out.categories = categories.map((c) => byCategory.get(c.id)!).filter((c) => c.channels.length > 0);
  return out;
}
