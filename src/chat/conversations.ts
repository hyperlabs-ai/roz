// Conversaciones del chat: canales (públicos o privados), MDs y la membresía de cada quien.
//
// Los cambios a una conversación (miembros, nombre, privacidad) se avisan por tiempo real con un
// evento SIN datos de la conversación (`conversation.updated { conversationId }`): la vista que
// recibe cada persona depende de ella (su nivel de aviso, sus no leídos), así que cada cliente pide
// la suya. Son cambios raros; un fetch extra por cliente es más simple que armar N vistas.
import { db } from '../db/supabase.js';
import { AppError, ValidationError } from '../utils/errors.js';
import { inBackground } from '../utils/background.js';
import {
  CONVERSATION_COLUMNS,
  MEMBER_COLUMNS,
  loadChatDevs,
  toMembership,
  type ChatConversation,
  type ConversationRow,
  type MemberRow,
} from './model.js';
import {
  assertCanView,
  assertChannel,
  assertMember,
  assertOwner,
  getMembership,
  listMembers,
} from './access.js';
import { channelSlug, defaultNotifyLevel, dmKey, type NotifyLevel } from './rules.js';
import { broadcastToDevs } from './realtime.js';
import { removeConversationFiles } from './attachments.js';

/** Máximo de personas en un MD grupal (más que eso es un canal privado). */
const MAX_DM_MEMBERS = 9;

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === '23505';

function notify(devIds: string[], event: 'conversation.updated' | 'conversation.removed', conversationId: string) {
  inBackground(() => broadcastToDevs(devIds, event, { conversationId }));
}

function shape(
  conv: ConversationRow,
  members: MemberRow[],
  devId: string,
  counts?: { unread: number; mentions: number },
): ChatConversation {
  const mine = members.find((m) => m.dev_id === devId) ?? null;
  return {
    id: conv.id,
    kind: conv.kind,
    name: conv.name,
    topic: conv.topic,
    description: conv.description,
    isPrivate: conv.is_private,
    isDefault: conv.is_default,
    createdBy: conv.created_by,
    lastMessageAt: conv.last_message_at,
    createdAt: conv.created_at,
    memberIds: members.map((m) => m.dev_id),
    ownerIds: members.filter((m) => m.role === 'owner').map((m) => m.dev_id),
    membership: mine ? toMembership(mine) : null,
    unread: counts?.unread ?? 0,
    mentions: counts?.mentions ?? 0,
  };
}

async function unreadCounts(devId: string): Promise<Map<string, { unread: number; mentions: number }>> {
  const { data, error } = await db().rpc('chat_unread', { p_dev_id: devId });
  if (error) throw error;
  const rows = (data ?? []) as { conversation_id: string; unread: number; mentions: number }[];
  return new Map(rows.map((r) => [r.conversation_id, { unread: r.unread, mentions: r.mentions }]));
}

async function membersByConversation(ids: string[]): Promise<Map<string, MemberRow[]>> {
  const map = new Map<string, MemberRow[]>();
  if (!ids.length) return map;
  const { data, error } = await db().from('chat_member').select(MEMBER_COLUMNS).in('conversation_id', ids);
  if (error) throw error;
  for (const m of (data ?? []) as unknown as MemberRow[]) {
    const list = map.get(m.conversation_id) ?? [];
    list.push(m);
    map.set(m.conversation_id, list);
  }
  return map;
}

/** La conversación tal como la ve `devId` (con su membresía y sus no leídos). */
export async function conversationFor(devId: string, id: string): Promise<ChatConversation> {
  const { conv } = await assertCanView(id, devId);
  const [members, counts] = await Promise.all([listMembers(id), unreadCounts(devId)]);
  return shape(conv, members, devId, counts.get(id));
}

/** Todo dev queda unido a los canales por defecto (#general) la primera vez que abre el chat. */
async function ensureDefaultMemberships(devId: string): Promise<void> {
  const { data, error } = await db().from('chat_conversation').select('id').eq('kind', 'channel').eq('is_default', true);
  if (error) throw error;
  const rows = ((data ?? []) as { id: string }[]).map((c) => ({
    conversation_id: c.id,
    dev_id: devId,
    role: 'member',
    notify_level: defaultNotifyLevel('channel'),
  }));
  if (!rows.length) return;
  const { error: upErr } = await db()
    .from('chat_member')
    .upsert(rows, { onConflict: 'conversation_id,dev_id', ignoreDuplicates: true });
  if (upErr) throw upErr;
}

/** Arranque del chat: mis conversaciones (con no leídos) y el directorio de devs. */
export async function bootstrap(devId: string) {
  await ensureDefaultMemberships(devId);
  const { data: mine, error } = await db().from('chat_member').select('conversation_id').eq('dev_id', devId);
  if (error) throw error;
  const ids = ((mine ?? []) as { conversation_id: string }[]).map((m) => m.conversation_id);

  const [convRes, members, counts, devs] = await Promise.all([
    ids.length
      ? db().from('chat_conversation').select(CONVERSATION_COLUMNS).in('id', ids)
      : Promise.resolve({ data: [], error: null }),
    membersByConversation(ids),
    unreadCounts(devId),
    loadChatDevs(),
  ]);
  if (convRes.error) throw convRes.error;

  const conversations = ((convRes.data ?? []) as unknown as ConversationRow[]).map((c) =>
    shape(c, members.get(c.id) ?? [], devId, counts.get(c.id)),
  );
  return {
    conversations,
    devs: devs.map(({ email: _email, ...d }) => d),
  };
}

/** Resumen ligero de no leídos (lo consulta el badge del nav por polling cuando no hay socket). */
export async function unreadSummary(devId: string) {
  const [{ data, error }, counts] = await Promise.all([
    db().from('chat_member').select('conversation_id, notify_level, hidden, chat_conversation(kind)').eq('dev_id', devId),
    unreadCounts(devId),
  ]);
  if (error) throw error;
  const rows = (data ?? []) as unknown as {
    conversation_id: string;
    notify_level: NotifyLevel;
    hidden: boolean;
    chat_conversation: { kind: 'channel' | 'dm' } | null;
  }[];
  return {
    items: rows.map((r) => ({
      conversationId: r.conversation_id,
      kind: r.chat_conversation?.kind ?? 'channel',
      notifyLevel: r.notify_level,
      unread: counts.get(r.conversation_id)?.unread ?? 0,
      mentions: counts.get(r.conversation_id)?.mentions ?? 0,
    })),
  };
}

async function assertActiveDevs(devIds: string[]): Promise<string[]> {
  const ids = [...new Set(devIds)];
  if (!ids.length) return [];
  const { data, error } = await db().from('dev').select('id').in('id', ids).eq('active', true);
  if (error) throw error;
  const found = new Set(((data ?? []) as { id: string }[]).map((d) => d.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new ValidationError('alguna de las personas no existe o ya no está activa');
  return ids;
}

export interface ChannelInput {
  name: string;
  topic?: string | null;
  description?: string | null;
  isPrivate?: boolean;
  memberDevIds?: string[];
}

export async function createChannel(devId: string, input: ChannelInput): Promise<ChatConversation> {
  const name = channelSlug(input.name);
  const others = (await assertActiveDevs(input.memberDevIds ?? [])).filter((id) => id !== devId);

  const { data, error } = await db()
    .from('chat_conversation')
    .insert({
      kind: 'channel',
      name,
      topic: input.topic?.trim() || null,
      description: input.description?.trim() || null,
      is_private: !!input.isPrivate,
      created_by: devId,
    })
    .select('id')
    .single();
  if (error) {
    if (isUniqueViolation(error)) throw new AppError('CONFLICT', `ya existe un canal #${name}`, 409);
    throw error;
  }
  const id = (data as { id: string }).id;

  const level = defaultNotifyLevel('channel');
  const { error: mErr } = await db()
    .from('chat_member')
    .insert([
      { conversation_id: id, dev_id: devId, role: 'owner', notify_level: level },
      ...others.map((d) => ({ conversation_id: id, dev_id: d, role: 'member', notify_level: level })),
    ]);
  if (mErr) throw mErr;

  notify(others, 'conversation.updated', id);
  return conversationFor(devId, id);
}

export interface ConversationPatch {
  name?: string;
  topic?: string | null;
  description?: string | null;
  isPrivate?: boolean;
}

export async function updateConversation(devId: string, id: string, patch: ConversationPatch): Promise<ChatConversation> {
  const { conv, member } = await assertMember(id, devId);
  assertChannel(conv);

  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = channelSlug(patch.name);
  if (patch.topic !== undefined) row.topic = patch.topic?.trim() || null;
  if (patch.description !== undefined) row.description = patch.description?.trim() || null;
  if (patch.isPrivate !== undefined && patch.isPrivate !== conv.is_private) {
    assertOwner(member);
    if (conv.is_default) throw new AppError('FORBIDDEN', 'el canal general no puede ser privado', 403);
    row.is_private = patch.isPrivate;
  }

  const { error } = await db().from('chat_conversation').update(row).eq('id', id);
  if (error) {
    if (isUniqueViolation(error)) throw new AppError('CONFLICT', `ya existe un canal #${String(row.name)}`, 409);
    throw error;
  }
  const members = await listMembers(id);
  notify(members.map((m) => m.dev_id).filter((d) => d !== devId), 'conversation.updated', id);
  return conversationFor(devId, id);
}

/** Borra el canal con todo su historial y sus archivos. Solo el dueño; #general no se borra. */
export async function deleteConversation(devId: string, id: string): Promise<void> {
  const { conv, member } = await assertMember(id, devId);
  assertChannel(conv);
  assertOwner(member);
  if (conv.is_default) throw new AppError('FORBIDDEN', 'el canal general no se puede eliminar', 403);
  await hardDelete(id);
}

async function hardDelete(id: string): Promise<void> {
  const members = await listMembers(id);
  await removeConversationFiles(id);
  const { error } = await db().from('chat_conversation').delete().eq('id', id);
  if (error) throw error;
  notify(members.map((m) => m.dev_id), 'conversation.removed', id);
}

/** Abre (o reabre) el MD con esas personas. El mismo grupo siempre cae en la misma conversación. */
export async function openDm(devId: string, devIds: string[]): Promise<ChatConversation> {
  const all = [...new Set([devId, ...devIds])];
  if (all.length > MAX_DM_MEMBERS) {
    throw new ValidationError(`un mensaje directo admite hasta ${MAX_DM_MEMBERS} personas; para más, crea un canal privado`);
  }
  await assertActiveDevs(all.filter((d) => d !== devId));
  const key = dmKey(all);

  const find = async () => {
    const { data, error } = await db().from('chat_conversation').select('id').eq('dm_key', key).maybeSingle();
    if (error) throw error;
    return (data as { id: string } | null)?.id ?? null;
  };

  let id = await find();
  if (!id) {
    const { data, error } = await db()
      .from('chat_conversation')
      .insert({ kind: 'dm', dm_key: key, created_by: devId })
      .select('id')
      .single();
    if (error && !isUniqueViolation(error)) throw error;
    // Si otra petición lo creó en paralelo, se usa el suyo.
    id = (data as { id: string } | null)?.id ?? (await find());
    if (!id) throw new AppError('INTERNAL', 'no se pudo abrir el mensaje directo', 500);
    const { error: mErr } = await db()
      .from('chat_member')
      .upsert(
        all.map((d) => ({ conversation_id: id, dev_id: d, role: 'member', notify_level: defaultNotifyLevel('dm') })),
        { onConflict: 'conversation_id,dev_id', ignoreDuplicates: true },
      );
    if (mErr) throw mErr;
  } else {
    await db().from('chat_member').update({ hidden: false }).eq('conversation_id', id).eq('dev_id', devId);
  }
  return conversationFor(devId, id);
}

/** Canales públicos para explorar, con cuántos miembros tienen y si ya estoy dentro. */
export async function browsePublicChannels(devId: string) {
  const { data, error } = await db()
    .from('chat_conversation')
    .select('id, name, topic, description, is_default, created_at, last_message_at')
    .eq('kind', 'channel')
    .eq('is_private', false)
    .order('name');
  if (error) throw error;
  const channels = (data ?? []) as {
    id: string;
    name: string;
    topic: string | null;
    description: string | null;
    is_default: boolean;
    created_at: string;
    last_message_at: string | null;
  }[];
  const members = await membersByConversation(channels.map((c) => c.id));
  return channels.map((c) => {
    const list = members.get(c.id) ?? [];
    return {
      id: c.id,
      name: c.name,
      topic: c.topic,
      description: c.description,
      isDefault: c.is_default,
      createdAt: c.created_at,
      lastMessageAt: c.last_message_at,
      memberCount: list.length,
      joined: list.some((m) => m.dev_id === devId),
    };
  });
}

export async function joinChannel(devId: string, id: string): Promise<ChatConversation> {
  const { conv, member } = await assertCanView(id, devId);
  assertChannel(conv);
  if (!member) {
    const { error } = await db()
      .from('chat_member')
      .upsert(
        { conversation_id: id, dev_id: devId, role: 'member', notify_level: defaultNotifyLevel('channel') },
        { onConflict: 'conversation_id,dev_id', ignoreDuplicates: true },
      );
    if (error) throw error;
    const members = await listMembers(id);
    notify(members.map((m) => m.dev_id).filter((d) => d !== devId), 'conversation.updated', id);
  }
  return conversationFor(devId, id);
}

/**
 * Salir de una conversación. Un MD no se abandona (el otro seguiría escribiéndote): se oculta hasta
 * el próximo mensaje. Si quien sale era el único dueño, hereda el miembro más antiguo; un canal
 * privado que queda vacío se borra (nadie podría volver a entrar).
 */
export async function leaveConversation(devId: string, id: string): Promise<void> {
  const { conv, member } = await assertMember(id, devId);
  if (conv.kind === 'dm') {
    await updateMembership(devId, id, { hidden: true });
    return;
  }
  if (conv.is_default) throw new AppError('FORBIDDEN', 'no puedes salir del canal general', 403);
  await removeAndRebalance(conv, member, devId);
}

async function removeAndRebalance(conv: ConversationRow, removed: MemberRow, actorDevId: string): Promise<void> {
  const { error } = await db().from('chat_member').delete().eq('conversation_id', conv.id).eq('dev_id', removed.dev_id);
  if (error) throw error;
  const remaining = await listMembers(conv.id);

  if (!remaining.length && conv.is_private) {
    await hardDelete(conv.id);
    notify([removed.dev_id], 'conversation.removed', conv.id);
    return;
  }
  if (removed.role === 'owner' && remaining.length && !remaining.some((m) => m.role === 'owner')) {
    const heir = [...remaining].sort((a, b) => a.joined_at.localeCompare(b.joined_at))[0]!;
    await db().from('chat_member').update({ role: 'owner' }).eq('conversation_id', conv.id).eq('dev_id', heir.dev_id);
  }
  notify([removed.dev_id], 'conversation.removed', conv.id);
  notify(remaining.map((m) => m.dev_id).filter((d) => d !== actorDevId), 'conversation.updated', conv.id);
}

export async function addMembers(devId: string, id: string, devIds: string[]): Promise<ChatConversation> {
  const { conv } = await assertMember(id, devId);
  assertChannel(conv);
  const ids = await assertActiveDevs(devIds);
  if (ids.length) {
    const { error } = await db()
      .from('chat_member')
      .upsert(
        ids.map((d) => ({ conversation_id: id, dev_id: d, role: 'member', notify_level: defaultNotifyLevel('channel') })),
        { onConflict: 'conversation_id,dev_id', ignoreDuplicates: true },
      );
    if (error) throw error;
    const members = await listMembers(id);
    notify(members.map((m) => m.dev_id).filter((d) => d !== devId), 'conversation.updated', id);
  }
  return conversationFor(devId, id);
}

export async function removeMember(devId: string, id: string, targetDevId: string): Promise<void> {
  if (targetDevId === devId) return leaveConversation(devId, id);
  const { conv, member } = await assertMember(id, devId);
  assertChannel(conv);
  assertOwner(member);
  if (conv.is_default) throw new AppError('FORBIDDEN', 'nadie sale del canal general', 403);
  const target = await getMembership(id, targetDevId);
  if (!target) return;
  await removeAndRebalance(conv, target, devId);
}

export async function updateMembership(
  devId: string,
  id: string,
  patch: { notifyLevel?: NotifyLevel; hidden?: boolean },
) {
  await assertMember(id, devId);
  const row: Record<string, unknown> = {};
  if (patch.notifyLevel !== undefined) row.notify_level = patch.notifyLevel;
  if (patch.hidden !== undefined) row.hidden = patch.hidden;
  if (!Object.keys(row).length) throw new ValidationError('sin cambios');
  const { data, error } = await db()
    .from('chat_member')
    .update(row)
    .eq('conversation_id', id)
    .eq('dev_id', devId)
    .select(MEMBER_COLUMNS)
    .single();
  if (error) throw error;
  // Mis otras pestañas / dispositivos.
  notify([devId], 'conversation.updated', id);
  return toMembership(data as unknown as MemberRow);
}

/** Marca la conversación como leída hasta ahora. Sin membresía (canal público ajeno) no hay nada que marcar. */
export async function markRead(devId: string, id: string): Promise<{ lastReadAt: string | null }> {
  const lastReadAt = new Date().toISOString();
  const { data, error } = await db()
    .from('chat_member')
    .update({ last_read_at: lastReadAt })
    .eq('conversation_id', id)
    .eq('dev_id', devId)
    .select('dev_id');
  if (error) throw error;
  if (!(data ?? []).length) return { lastReadAt: null };
  inBackground(() => broadcastToDevs([devId], 'read', { conversationId: id, lastReadAt }));
  return { lastReadAt };
}
