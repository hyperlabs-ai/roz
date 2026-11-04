// Mensajes del chat: lectura paginada, hilos, envío / edición / borrado y el vínculo con tareas.
//
// Cada escritura se reparte por tiempo real al buzón de cada miembro con el mensaje COMPLETO (ya
// enriquecido con adjuntos firmados y tareas), así el cliente no tiene que volver a pedirlo.
import { db } from '../db/supabase.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { inBackground } from '../utils/background.js';
import {
  MESSAGE_COLUMNS,
  loadChatDevs,
  type ChatMessage,
  type MessageRow,
} from './model.js';
import { assertCanView, assertMember, listMembers } from './access.js';
import { attachmentsByMessage, linkAttachments, removeMessageFiles } from './attachments.js';
import { broadcastToDevs } from './realtime.js';
import { notifyChatMessage } from './notify.js';
import {
  MAX_MESSAGE_LENGTH, MAX_STATUS_TASKS, extractMentions, extractTaskIdentifiers, hasChannelMention, statusTaskIds,
} from './text.js';
import { tasksByIdentifier, tasksByIds, tasksByMessage } from './tasks.js';

const PAGE_SIZE = 50;
const MAX_THREAD = 500;
const MAX_ATTACHMENTS = 10;

type OnError = (err: unknown) => void;

async function loadMessage(id: string): Promise<MessageRow> {
  const { data, error } = await db().from('chat_message').select(MESSAGE_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('el mensaje no existe');
  return data as unknown as MessageRow;
}

/** Quienes respondieron en cada hilo, del más reciente al más viejo (para los avatares del resumen). */
async function repliersByRoot(rootIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!rootIds.length) return map;
  const { data, error } = await db()
    .from('chat_message')
    .select('parent_id, author_dev_id')
    .in('parent_id', rootIds)
    .eq('kind', 'user')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;
  for (const r of (data ?? []) as { parent_id: string; author_dev_id: string | null }[]) {
    if (!r.author_dev_id) continue;
    const list = map.get(r.parent_id) ?? [];
    if (!list.includes(r.author_dev_id)) list.push(r.author_dev_id);
    map.set(r.parent_id, list);
  }
  return map;
}

async function enrich(rows: MessageRow[]): Promise<ChatMessage[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const withReplies = rows.filter((r) => !r.parent_id && r.reply_count > 0).map((r) => r.id);
  // Citas `#ROZ-12` de todos los mensajes de la página, resueltas en UNA consulta.
  const citedByMessage = new Map(rows.filter((r) => !r.deleted_at).map((r) => [r.id, extractTaskIdentifiers(r.body)]));
  const statusByMessage = new Map(rows.filter((r) => !r.deleted_at).map((r) => [r.id, statusTaskIds(r.meta)]));
  const [files, tasks, repliers, cited, statusCards] = await Promise.all([
    attachmentsByMessage(ids),
    tasksByMessage(ids),
    repliersByRoot(withReplies),
    tasksByIdentifier([...citedByMessage.values()].flat()),
    tasksByIds([...statusByMessage.values()].flat()),
  ]);
  return rows.map((r) => {
    const deleted = !!r.deleted_at;
    return {
      id: r.id,
      conversationId: r.conversation_id,
      parentId: r.parent_id,
      kind: r.kind,
      authorDevId: r.author_dev_id,
      // Un mensaje borrado no entrega su contenido: queda solo como marca en la conversación.
      body: deleted ? '' : r.body,
      mentions: deleted ? [] : r.mentions ?? [],
      mentionChannel: deleted ? false : r.mention_channel,
      meta: r.meta,
      clientNonce: r.client_nonce,
      replyCount: r.reply_count,
      lastReplyAt: r.last_reply_at,
      replyDevIds: repliers.get(r.id) ?? [],
      editedAt: r.edited_at,
      deletedAt: r.deleted_at,
      createdAt: r.created_at,
      attachments: deleted ? [] : files.get(r.id) ?? [],
      tasks: tasks.get(r.id) ?? [],
      citedTasks: (citedByMessage.get(r.id) ?? []).map((i) => cited.get(i)).filter((t): t is NonNullable<typeof t> => !!t),
      statusTasks: (statusByMessage.get(r.id) ?? []).map((i) => statusCards.get(i)).filter((t): t is NonNullable<typeof t> => !!t),
    };
  });
}

/** Mensajes del canal (sin respuestas de hilo), del más viejo al más nuevo. `before` pagina hacia atrás. */
export async function listMessages(devId: string, conversationId: string, opts: { before?: string; limit?: number } = {}) {
  await assertCanView(conversationId, devId);
  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 100);
  let q = db()
    .from('chat_message')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', conversationId)
    .is('parent_id', null)
    // Un raíz borrado solo se conserva como marca si tiene hilo; sin respuestas, desaparece.
    .or('deleted_at.is.null,reply_count.gt.0')
    .order('created_at', { ascending: false })
    .limit(limit + 1);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as MessageRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return { messages: await enrich(page), hasMore };
}

/** Un hilo: el mensaje raíz y sus respuestas. Si `id` es una respuesta, se abre su hilo. */
export async function getThread(devId: string, id: string) {
  let root = await loadMessage(id);
  if (root.parent_id) root = await loadMessage(root.parent_id);
  await assertCanView(root.conversation_id, devId);
  const { data, error } = await db()
    .from('chat_message')
    .select(MESSAGE_COLUMNS)
    .eq('parent_id', root.id)
    .order('created_at', { ascending: true })
    .limit(MAX_THREAD);
  if (error) throw error;
  const [rootMsg, ...replies] = await enrich([root, ...((data ?? []) as unknown as MessageRow[])]);
  return { root: rootMsg!, replies };
}

/** Dónde vive un mensaje (para los enlaces "ver conversación" desde una tarea o un push). */
export async function locateMessage(devId: string, id: string) {
  const msg = await loadMessage(id);
  await assertCanView(msg.conversation_id, devId);
  return { conversationId: msg.conversation_id, rootId: msg.parent_id ?? msg.id, messageId: msg.id };
}

/** Menciones válidas: solo miembros (mencionar a alguien fuera no le da acceso a leer). */
function mentionsFor(body: string, memberIds: Set<string>): string[] {
  return extractMentions(body).filter((id) => memberIds.has(id));
}

export interface SendInput {
  body?: string | null;
  parentId?: string | null;
  attachmentIds?: string[];
  clientNonce?: string | null;
  /** Bloque Status (daily): tareas a mostrar en el mensaje. Se guardan en `meta`; el estado se lee vivo. */
  statusTaskIds?: string[];
}

export async function sendMessage(devId: string, conversationId: string, input: SendInput, onError?: OnError): Promise<ChatMessage> {
  const { conv } = await assertMember(conversationId, devId);
  const body = (input.body ?? '').trim();
  if (body.length > MAX_MESSAGE_LENGTH) throw new ValidationError(`el mensaje supera ${MAX_MESSAGE_LENGTH} caracteres`);
  const attachmentIds = [...new Set(input.attachmentIds ?? [])].slice(0, MAX_ATTACHMENTS);
  const statusIds = [...new Set(input.statusTaskIds ?? [])];
  if (statusIds.length > MAX_STATUS_TASKS) throw new ValidationError(`un status admite hasta ${MAX_STATUS_TASKS} tareas`);
  if (!body && !attachmentIds.length && !statusIds.length) throw new ValidationError('el mensaje está vacío');
  if (statusIds.length) {
    if (input.parentId) throw new ValidationError('el status va en el canal, no en un hilo');
    // Solo tareas que existen: un id inventado no debe quedar guardado en el mensaje.
    const found = await tasksByIds(statusIds);
    if (found.size !== statusIds.length) throw new ValidationError('alguna de las tareas del status ya no existe');
  }

  if (input.parentId) {
    const parent = await loadMessage(input.parentId);
    if (parent.conversation_id !== conversationId || parent.parent_id) {
      throw new ValidationError('el hilo no pertenece a esta conversación');
    }
  }

  // Los archivos se validan ANTES de insertar: solo cuentan los que subió esta persona en esta
  // conversación y que no están usados. Un mensaje sin texto y sin archivos válidos no se crea.
  if (attachmentIds.length) {
    const { count, error: aErr } = await db()
      .from('chat_attachment')
      .select('id', { count: 'exact', head: true })
      .in('id', attachmentIds)
      .eq('conversation_id', conversationId)
      .eq('uploader_dev_id', devId)
      .is('message_id', null);
    if (aErr) throw aErr;
    if (!body && !count) throw new ValidationError('los archivos adjuntos no son válidos');
  }

  const members = await listMembers(conversationId);
  const memberIds = new Set(members.map((m) => m.dev_id.toLowerCase()));

  const { data, error } = await db()
    .from('chat_message')
    .insert({
      conversation_id: conversationId,
      author_dev_id: devId,
      parent_id: input.parentId ?? null,
      kind: 'user',
      body,
      mentions: mentionsFor(body, memberIds),
      mention_channel: hasChannelMention(body),
      client_nonce: input.clientNonce ?? null,
      meta: statusIds.length ? { type: 'status', taskIds: statusIds } : null,
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) throw error;
  const row = data as unknown as MessageRow;

  const linked = await linkAttachments(row.id, conversationId, devId, attachmentIds);

  const writes: PromiseLike<unknown>[] = [];
  // Un MD cerrado vuelve a aparecer en cuanto alguien escribe.
  if (conv.kind === 'dm') {
    writes.push(db().from('chat_member').update({ hidden: false }).eq('conversation_id', conversationId).eq('hidden', true));
  }
  // Escribir en el canal implica haberlo leído hasta aquí.
  if (!row.parent_id) {
    writes.push(
      db().from('chat_member').update({ last_read_at: row.created_at }).eq('conversation_id', conversationId).eq('dev_id', devId),
    );
  }
  await Promise.all(writes);

  const [message] = await enrich([row]);
  inBackground(async () => {
    await broadcastToDevs(members.map((m) => m.dev_id), 'message.created', { message });
    const devs = await loadChatDevs();
    await notifyChatMessage({ conversation: conv, message: row, members, devs, attachmentCount: linked });
  }, onError);
  return message!;
}

async function loadOwnMessage(devId: string, id: string): Promise<MessageRow> {
  const row = await loadMessage(id);
  await assertCanView(row.conversation_id, devId);
  if (row.kind !== 'user' || row.author_dev_id !== devId) {
    throw new AppError('FORBIDDEN', 'solo puedes modificar tus propios mensajes', 403);
  }
  return row;
}

export async function editMessage(devId: string, id: string, rawBody: string, onError?: OnError): Promise<ChatMessage> {
  const row = await loadOwnMessage(devId, id);
  if (row.deleted_at) throw new ValidationError('el mensaje fue eliminado');
  const body = rawBody.trim();
  if (body.length > MAX_MESSAGE_LENGTH) throw new ValidationError(`el mensaje supera ${MAX_MESSAGE_LENGTH} caracteres`);
  if (!body) {
    const { count } = await db().from('chat_attachment').select('id', { count: 'exact', head: true }).eq('message_id', id);
    if (!count && !statusTaskIds(row.meta).length) {
      throw new ValidationError('el mensaje no puede quedar vacío; elimínalo si ya no sirve');
    }
  }

  const members = await listMembers(row.conversation_id);
  const memberIds = new Set(members.map((m) => m.dev_id.toLowerCase()));
  const { data, error } = await db()
    .from('chat_message')
    .update({
      body,
      mentions: mentionsFor(body, memberIds),
      mention_channel: hasChannelMention(body),
      edited_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) throw error;

  const [message] = await enrich([data as unknown as MessageRow]);
  inBackground(() => broadcastToDevs(members.map((m) => m.dev_id), 'message.updated', { message }), onError);
  return message!;
}

export async function deleteMessage(devId: string, id: string, onError?: OnError): Promise<void> {
  const row = await loadOwnMessage(devId, id);
  if (row.deleted_at) return;
  await removeMessageFiles(id);
  const { error } = await db()
    .from('chat_message')
    .update({ deleted_at: new Date().toISOString(), body: '', mentions: [], mention_channel: false })
    .eq('id', id);
  if (error) throw error;
  const members = await listMembers(row.conversation_id);
  inBackground(
    () =>
      broadcastToDevs(members.map((m) => m.dev_id), 'message.deleted', {
        conversationId: row.conversation_id,
        id,
        parentId: row.parent_id,
      }),
    onError,
  );
}

// ---- Mensaje → tarea ----

/** El mensaje de origen de una tarea: tiene que existir, no estar borrado y ser visible para quien crea. */
export async function assertTaskOrigin(devId: string, messageId: string): Promise<MessageRow> {
  const row = await loadMessage(messageId);
  await assertCanView(row.conversation_id, devId);
  if (row.deleted_at) throw new ValidationError('el mensaje de origen fue eliminado');
  return row;
}

/**
 * Deja constancia en el hilo del mensaje de que salió una tarea de él, y actualiza el mensaje de
 * origen en los clientes para que aparezca su ficha. Best-effort: la tarea ya existe; si el aviso
 * falla, la ficha igual aparece al recargar.
 */
export async function announceTaskFromMessage(
  devId: string,
  origin: MessageRow,
  task: { id: string; identifier: string; name: string },
  onError?: OnError,
): Promise<void> {
  try {
    const { data, error } = await db()
      .from('chat_message')
      .insert({
        conversation_id: origin.conversation_id,
        author_dev_id: devId,
        parent_id: origin.parent_id ?? origin.id,
        kind: 'system',
        body: '',
        meta: { type: 'task_created', workItemId: task.id, identifier: task.identifier, name: task.name, sourceMessageId: origin.id },
      })
      .select(MESSAGE_COLUMNS)
      .single();
    if (error) throw error;
    const [system, updated] = await enrich([data as unknown as MessageRow, await loadMessage(origin.id)]);
    const members = (await listMembers(origin.conversation_id)).map((m) => m.dev_id);
    inBackground(async () => {
      await broadcastToDevs(members, 'message.created', { message: system });
      await broadcastToDevs(members, 'message.updated', { message: updated });
    }, onError);
  } catch (err) {
    onError?.(err);
  }
}
