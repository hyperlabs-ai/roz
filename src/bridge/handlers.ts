// Eventos del gateway (DISPATCH crudo) → escrituras en el espejo → avisos a roz.
//
// Cada handler: (1) escribe en la base, (2) SOLO si la escritura salió bien, encola el aviso
// (contrato §A.3: "primero la base, después el aviso"). Corren dentro del carril serial
// (src/queue.ts), así que las lecturas-modificación-escritura no se cruzan.
//
// Cualquier cambio de configuración en Discord (canal/categoría creado-renombrado-movido-borrado,
// permisos, roles, miembros, hilos, emojis) llega aquí y se refleja en el acto.
import { isFullMessage, mapChannel, mapEmoji, mapGuild, mapMember, mapMessage, mapMessagePatch, mapRole } from './map.js';
import type { EmojiFields, MemberFields } from './map.js';
import {
  applyReactionAdd,
  applyReactionRemove,
  applyReactionRemoveEmoji,
  mergeReactions,
  sameReactions,
  emojiKey,
  type RawEmoji,
} from './reactions.js';
import type {
  DiscordApiChannel,
  DiscordApiEmoji,
  DiscordApiGuild,
  DiscordApiGuildMember,
  DiscordApiMessage,
  DiscordApiRole,
  DiscordApiUser,
} from './shared/api-types.js';
import { DISCORD_CHANNEL_TYPE, TEXT_CHANNEL_TYPES, isThreadType, type DiscordBridgeNotice, type DiscordReaction } from './shared/types.js';
import { snowflakeIso } from './snowflake.js';
import type { DiscordSource } from './source/types.js';
import type { MirrorStore } from './store/types.js';

export interface HandlerContext {
  guildId: string;
  store: MirrorStore;
  source: DiscordSource;
  notify: (...notices: DiscordBridgeNotice[]) => void;
}

type Raw = Record<string, unknown>;

/** Eventos que el puente procesa (el resto se ignora). */
export const HANDLED_EVENTS = new Set([
  'GUILD_CREATE',
  'GUILD_UPDATE',
  'GUILD_DELETE',
  'GUILD_ROLE_CREATE',
  'GUILD_ROLE_UPDATE',
  'GUILD_ROLE_DELETE',
  'GUILD_MEMBER_ADD',
  'GUILD_MEMBER_UPDATE',
  'GUILD_MEMBER_REMOVE',
  'GUILD_MEMBERS_CHUNK',
  'GUILD_EMOJIS_UPDATE',
  'CHANNEL_CREATE',
  'CHANNEL_UPDATE',
  'CHANNEL_DELETE',
  'THREAD_CREATE',
  'THREAD_UPDATE',
  'THREAD_DELETE',
  'THREAD_LIST_SYNC',
  'THREAD_MEMBERS_UPDATE',
  'MESSAGE_CREATE',
  'MESSAGE_UPDATE',
  'MESSAGE_DELETE',
  'MESSAGE_DELETE_BULK',
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
  'MESSAGE_REACTION_REMOVE_ALL',
  'MESSAGE_REACTION_REMOVE_EMOJI',
]);

/** Guild del evento: la mayoría trae guild_id; GUILD_* traen el objeto guild (id). */
export function eventGuildId(type: string, d: Raw): string | null {
  if (type === 'GUILD_CREATE' || type === 'GUILD_UPDATE' || type === 'GUILD_DELETE') return (d.id as string) ?? null;
  return (d.guild_id as string) ?? null;
}

/**
 * Procesa un DISPATCH. Devuelve true si era un evento del servidor espejado y se procesó.
 * Lanza si falla la base (quien llama reintenta).
 */
export async function handleDispatch(ctx: HandlerContext, type: string, data: unknown): Promise<boolean> {
  if (!HANDLED_EVENTS.has(type) || !data || typeof data !== 'object') return false;
  const d = data as Raw;
  // Un solo servidor: lo de otros servidores (o DMs, sin guild_id) se ignora.
  if (eventGuildId(type, d) !== ctx.guildId) return false;

  switch (type) {
    case 'GUILD_CREATE':
    case 'GUILD_UPDATE':
      return onGuild(ctx, d as unknown as DiscordApiGuild);
    case 'GUILD_DELETE':
      return onGuildDelete(ctx, d);
    case 'GUILD_ROLE_CREATE':
    case 'GUILD_ROLE_UPDATE':
      return onRole(ctx, d.role as DiscordApiRole);
    case 'GUILD_ROLE_DELETE':
      return onRoleDelete(ctx, d.role_id as string);
    case 'GUILD_MEMBER_ADD':
    case 'GUILD_MEMBER_UPDATE':
      return onMembers(ctx, [d as unknown as DiscordApiGuildMember], true);
    case 'GUILD_MEMBERS_CHUNK':
      return onMembers(ctx, (d.members as DiscordApiGuildMember[]) ?? [], false);
    case 'GUILD_MEMBER_REMOVE':
      return onMemberRemove(ctx, d.user as DiscordApiUser);
    case 'GUILD_EMOJIS_UPDATE':
      return onEmojis(ctx, (d.emojis as DiscordApiEmoji[]) ?? []);
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
      return onChannel(ctx, d as unknown as DiscordApiChannel, type === 'CHANNEL_CREATE');
    case 'CHANNEL_DELETE':
      return onChannelDelete(ctx, d.id as string);
    case 'THREAD_CREATE':
      return onThreadCreate(ctx, d as unknown as DiscordApiChannel & { newly_created?: boolean });
    case 'THREAD_UPDATE':
      return onThreadUpdate(ctx, d as unknown as DiscordApiChannel);
    case 'THREAD_DELETE':
      return onThreadDelete(ctx, d.id as string, (d.parent_id as string) ?? null);
    case 'THREAD_LIST_SYNC':
      return onThreadListSync(ctx, (d.threads as DiscordApiChannel[]) ?? []);
    case 'THREAD_MEMBERS_UPDATE':
      return onThreadMembers(ctx, d);
    case 'MESSAGE_CREATE':
      return onMessageCreate(ctx, d as unknown as DiscordApiMessage);
    case 'MESSAGE_UPDATE':
      return onMessageUpdate(ctx, d as unknown as Partial<DiscordApiMessage> & { id: string; channel_id: string });
    case 'MESSAGE_DELETE':
      return onMessageDelete(ctx, d.channel_id as string, [d.id as string]);
    case 'MESSAGE_DELETE_BULK':
      return onMessageDelete(ctx, d.channel_id as string, (d.ids as string[]) ?? []);
    case 'MESSAGE_REACTION_ADD':
      return onReaction(ctx, d, (list) => applyReactionAdd(list, d.emoji as RawEmoji, d.user_id as string, d.burst === true), {
        addUser: { emoji: d.emoji as RawEmoji, userId: d.user_id as string },
      });
    case 'MESSAGE_REACTION_REMOVE':
      return onReaction(ctx, d, (list) => applyReactionRemove(list, d.emoji as RawEmoji, d.user_id as string, d.burst === true));
    case 'MESSAGE_REACTION_REMOVE_ALL':
      return onReaction(ctx, d, () => []);
    case 'MESSAGE_REACTION_REMOVE_EMOJI':
      return onReaction(ctx, d, (list) => applyReactionRemoveEmoji(list, d.emoji as RawEmoji));
  }
  return false;
}

// ---------------------------------------------------------------- servidor

async function onGuild(ctx: HandlerContext, g: DiscordApiGuild): Promise<boolean> {
  if (g.unavailable) return false; // caída de Discord: no es un cambio real
  await ctx.store.upsertGuild(mapGuild(g));
  ctx.notify({ kind: 'structure.changed', scope: 'guild' });
  return true;
}

async function onGuildDelete(ctx: HandlerContext, d: Raw): Promise<boolean> {
  // unavailable = caída temporal de Discord; sin él = sacaron al bot del servidor.
  if (d.unavailable) return false;
  await ctx.store.markGuildDeleted(ctx.guildId);
  ctx.notify({ kind: 'structure.changed', scope: 'guild' });
  return true;
}

// ---------------------------------------------------------------- roles

async function onRole(ctx: HandlerContext, role: DiscordApiRole | undefined): Promise<boolean> {
  if (!role?.id) return false;
  await ctx.store.upsertRoles([mapRole(role, ctx.guildId)]);
  ctx.notify({ kind: 'structure.changed', scope: 'roles' });
  return true;
}

async function onRoleDelete(ctx: HandlerContext, roleId: string | undefined): Promise<boolean> {
  if (!roleId) return false;
  await ctx.store.softDeleteRoles([roleId]);
  ctx.notify({ kind: 'structure.changed', scope: 'roles' });
  return true;
}

// ---------------------------------------------------------------- miembros

async function onMembers(ctx: HandlerContext, members: DiscordApiGuildMember[], withIds: boolean): Promise<boolean> {
  const rows = members.map((m) => mapMember(m, ctx.guildId)).filter((r): r is MemberFields => r !== null);
  if (!rows.length) return false;
  await ctx.store.upsertMembers(rows);
  ctx.notify(
    withIds
      ? { kind: 'structure.changed', scope: 'members', userIds: rows.map((r) => r.user_id) }
      : { kind: 'structure.changed', scope: 'members' },
  );
  return true;
}

async function onMemberRemove(ctx: HandlerContext, user: DiscordApiUser | undefined): Promise<boolean> {
  if (!user?.id) return false;
  await ctx.store.markMembersLeft(ctx.guildId, [user.id]);
  ctx.notify({ kind: 'structure.changed', scope: 'members', userIds: [user.id] });
  return true;
}

// ---------------------------------------------------------------- emojis

async function onEmojis(ctx: HandlerContext, emojis: DiscordApiEmoji[]): Promise<boolean> {
  const rows = emojis.map((e) => mapEmoji(e, ctx.guildId)).filter((r): r is EmojiFields => r !== null);
  await ctx.store.upsertEmojis(rows);
  // GUILD_EMOJIS_UPDATE trae la lista COMPLETA: lo que ya no viene, se borró.
  const keep = new Set(rows.map((r) => r.id));
  const gone = (await ctx.store.listEmojiIds(ctx.guildId)).filter((id) => !keep.has(id));
  if (gone.length) await ctx.store.softDeleteEmojis(gone);
  ctx.notify({ kind: 'structure.changed', scope: 'emojis' });
  return true;
}

// ---------------------------------------------------------------- canales y categorías

/** Un canal nuevo no tiene historial: su backfill ya está completo. */
async function markFreshChannel(ctx: HandlerContext, channelId: string): Promise<void> {
  const state = await ctx.store.getSyncState(channelId);
  if (state) return;
  await ctx.store.upsertSyncState({
    channel_id: channelId,
    guild_id: ctx.guildId,
    backfill_complete: true,
    last_synced_at: new Date().toISOString(),
  });
}

async function onChannel(ctx: HandlerContext, c: DiscordApiChannel, created: boolean): Promise<boolean> {
  if (!c?.id) return false;
  if (isThreadType(c.type)) return created ? onThreadCreate(ctx, c) : onThreadUpdate(ctx, c);
  await ctx.store.upsertChannels([mapChannel(c, ctx.guildId)]);
  if (created && TEXT_CHANNEL_TYPES.has(c.type)) await markFreshChannel(ctx, c.id);
  ctx.notify({ kind: 'structure.changed', scope: 'channels', channelIds: [c.id] });
  return true;
}

async function onChannelDelete(ctx: HandlerContext, channelId: string | undefined): Promise<boolean> {
  if (!channelId) return false;
  // Discord borra los hilos con su canal sin mandar THREAD_DELETE de cada uno.
  const threads = (await ctx.store.listChannels(ctx.guildId))
    .filter((ch) => ch.parent_id === channelId && isThreadType(ch.type))
    .map((ch) => ch.id);
  await ctx.store.softDeleteChannels([channelId, ...threads]);
  ctx.notify({ kind: 'structure.changed', scope: 'channels', channelIds: [channelId, ...threads] });
  return true;
}

// ---------------------------------------------------------------- hilos

async function refreshPrivateMembers(ctx: HandlerContext, thread: DiscordApiChannel): Promise<void> {
  if (thread.type !== DISCORD_CHANNEL_TYPE.PRIVATE_THREAD) return;
  const ids = await ctx.source.fetchThreadMemberIds(thread.id);
  await ctx.store.patchChannel(thread.id, { member_ids: ids });
}

/** Enlaza el hilo con el mensaje del que nació (y ese mensaje con el hilo, para "N respuestas"). */
async function linkStarter(ctx: HandlerContext, thread: DiscordApiChannel): Promise<void> {
  const starter = (await ctx.store.getMessages([thread.id])).get(thread.id);
  if (!starter) return;
  if (starter.channel_id === thread.parent_id) {
    // Hilo creado desde un mensaje del canal: el id del hilo es el del mensaje.
    await ctx.store.patchChannel(thread.id, { starter_message_id: thread.id });
    if (starter.thread_id !== thread.id) {
      await ctx.store.updateMessage(thread.id, { thread_id: thread.id });
      ctx.notify({ kind: 'message.updated', channelId: starter.channel_id, messageId: thread.id });
    }
  } else if (starter.channel_id === thread.id) {
    // Publicación de foro: el primer mensaje vive DENTRO del hilo con el mismo id.
    await ctx.store.patchChannel(thread.id, { starter_message_id: thread.id });
  }
}

async function onThreadCreate(ctx: HandlerContext, t: DiscordApiChannel & { newly_created?: boolean }): Promise<boolean> {
  if (!t?.id) return false;
  await ctx.store.upsertChannels([mapChannel(t, ctx.guildId)]);
  await refreshPrivateMembers(ctx, t);
  await linkStarter(ctx, t);
  if (t.newly_created) await markFreshChannel(ctx, t.id);
  ctx.notify({ kind: 'structure.changed', scope: 'threads', channelIds: [t.id, ...(t.parent_id ? [t.parent_id] : [])] });
  return true;
}

async function onThreadUpdate(ctx: HandlerContext, t: DiscordApiChannel): Promise<boolean> {
  if (!t?.id) return false;
  const known = await ctx.store.getChannel(t.id);
  await ctx.store.upsertChannels([mapChannel(t, ctx.guildId)]);
  // Hilo que el puente no conocía (p. ej. desarchivado): completar miembros y mensaje de origen.
  if (!known) {
    await refreshPrivateMembers(ctx, t);
    await linkStarter(ctx, t);
  }
  ctx.notify({ kind: 'structure.changed', scope: 'threads', channelIds: [t.id, ...(t.parent_id ? [t.parent_id] : [])] });
  return true;
}

async function onThreadDelete(ctx: HandlerContext, threadId: string | undefined, parentId: string | null): Promise<boolean> {
  if (!threadId) return false;
  await ctx.store.softDeleteChannels([threadId]);
  const starter = (await ctx.store.getMessages([threadId])).get(threadId);
  if (starter && starter.thread_id === threadId && starter.channel_id !== threadId) {
    await ctx.store.updateMessage(threadId, { thread_id: null });
    ctx.notify({ kind: 'message.updated', channelId: starter.channel_id, messageId: threadId });
  }
  ctx.notify({ kind: 'structure.changed', scope: 'threads', channelIds: [threadId, ...(parentId ? [parentId] : [])] });
  return true;
}

async function onThreadListSync(ctx: HandlerContext, threads: DiscordApiChannel[]): Promise<boolean> {
  if (!threads.length) return false;
  await ctx.store.upsertChannels(threads.map((t) => mapChannel(t, ctx.guildId)));
  for (const t of threads) await refreshPrivateMembers(ctx, t);
  ctx.notify({ kind: 'structure.changed', scope: 'threads', channelIds: threads.map((t) => t.id) });
  return true;
}

async function onThreadMembers(ctx: HandlerContext, d: Raw): Promise<boolean> {
  const id = d.id as string | undefined;
  if (!id) return false;
  const meta = await ctx.store.getChannel(id);
  if (!meta) return false;
  const added = ((d.added_members as Array<{ user_id?: string }>) ?? []).map((m) => m.user_id).filter((x): x is string => !!x);
  const removed = (d.removed_member_ids as string[]) ?? [];
  const next = new Set(meta.member_ids ?? []);
  for (const u of added) next.add(u);
  for (const u of removed) next.delete(u);
  await ctx.store.patchChannel(id, { member_ids: [...next] });
  ctx.notify({ kind: 'structure.changed', scope: 'threads', channelIds: [id], userIds: [...added, ...removed] });
  return true;
}

// ---------------------------------------------------------------- mensajes

async function onMessageCreate(ctx: HandlerContext, m: DiscordApiMessage): Promise<boolean> {
  if (!isFullMessage(m)) return false;
  await ctx.store.upsertMessages([mapMessage(m, ctx.guildId)]);

  const channel = await ctx.store.getChannel(m.channel_id);
  if (channel) {
    const patch: Parameters<MirrorStore['patchChannel']>[1] = {
      last_message_id: m.id,
      last_message_at: snowflakeIso(m.id),
    };
    if (isThreadType(channel.type)) patch.message_count = (channel.message_count ?? 0) + 1;
    await ctx.store.patchChannel(m.channel_id, patch);
  }

  ctx.notify({ kind: 'message.created', channelId: m.channel_id, messageId: m.id });

  // Respuesta en un hilo: el mensaje de origen (en el canal padre) muestra "N respuestas".
  if (channel && isThreadType(channel.type) && channel.parent_id) {
    const starter = (await ctx.store.getMessages([m.channel_id])).get(m.channel_id);
    if (starter && starter.channel_id === channel.parent_id && !starter.deleted_at) {
      ctx.notify({ kind: 'message.updated', channelId: channel.parent_id, messageId: m.channel_id });
    }
  }
  return true;
}

async function onMessageUpdate(
  ctx: HandlerContext,
  m: Partial<DiscordApiMessage> & { id: string; channel_id: string },
): Promise<boolean> {
  if (!m.id || !m.channel_id) return false;
  const existing = (await ctx.store.getMessages([m.id])).get(m.id);
  if (existing) {
    const patch = mapMessagePatch(m, ctx.guildId);
    if (patch.reactions) patch.reactions = mergeReactions(patch.reactions, existing.reactions);
    if (!Object.keys(patch).length) return false;
    await ctx.store.updateMessage(m.id, patch);
  } else {
    // No está en el espejo (mensaje más viejo que el backfill): se trae entero.
    const full = isFullMessage(m) ? m : await ctx.source.fetchMessage(m.channel_id, m.id);
    if (!full) return false;
    await ctx.store.upsertMessages([mapMessage(full, ctx.guildId)]);
  }
  ctx.notify({ kind: 'message.updated', channelId: m.channel_id, messageId: m.id });
  return true;
}

async function onMessageDelete(ctx: HandlerContext, channelId: string | undefined, ids: string[]): Promise<boolean> {
  if (!channelId || !ids.length) return false;
  const changed = await ctx.store.softDeleteMessages(ids);
  if (!changed.length) return false;
  ctx.notify({ kind: 'message.deleted', channelId, messageIds: changed });
  return true;
}

async function onReaction(
  ctx: HandlerContext,
  d: Raw,
  apply: (list: DiscordReaction[]) => DiscordReaction[],
  opts: { addUser?: { emoji: RawEmoji; userId: string } } = {},
): Promise<boolean> {
  const channelId = d.channel_id as string | undefined;
  const messageId = d.message_id as string | undefined;
  if (!channelId || !messageId) return false;

  const existing = (await ctx.store.getMessages([messageId])).get(messageId);
  if (existing) {
    const next = apply(existing.reactions ?? []);
    if (sameReactions(next, existing.reactions ?? [])) return false;
    await ctx.store.updateMessage(messageId, { reactions: next });
  } else {
    // Reacción a un mensaje fuera del espejo: se trae entero (sus conteos ya incluyen este evento).
    const full = await ctx.source.fetchMessage(channelId, messageId);
    if (!full) return false;
    const row = mapMessage(full, ctx.guildId);
    if (opts.addUser) {
      const key = emojiKey(opts.addUser.emoji);
      row.reactions = row.reactions.map((r) =>
        emojiKey(r.emoji) === key && !r.userIds.includes(opts.addUser!.userId)
          ? { ...r, userIds: [...r.userIds, opts.addUser!.userId] }
          : r,
      );
    }
    await ctx.store.upsertMessages([row]);
  }
  ctx.notify({ kind: 'message.updated', channelId, messageId });
  return true;
}

