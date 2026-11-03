// API del chat. Montada en /api/dashboard/chat DENTRO de dashboardRoutes, así que ya pasó por
// requireDashboardAuth: el dev sale SIEMPRE de la sesión (c.get('user').devId), nunca del body.
import { Hono } from 'hono';
import { z } from 'zod';
import type { RozContext } from '../types/hono.js';
import { fail } from './http.js';
import {
  addMembers,
  bootstrap,
  browsePublicChannels,
  conversationFor,
  createChannel,
  deleteConversation,
  joinChannel,
  leaveConversation,
  markRead,
  openDm,
  removeMember,
  unreadSummary,
  updateConversation,
  updateMembership,
} from '../chat/conversations.js';
import { deleteMessage, editMessage, getThread, listMessages, locateMessage, sendMessage } from '../chat/messages.js';
import { MAX_CHAT_ATTACHMENT_BYTES, uploadAttachment } from '../chat/attachments.js';
import { MAX_MESSAGE_LENGTH } from '../chat/text.js';
import { searchTasks } from '../chat/tasks.js';

export const chatRoutes = new Hono<RozContext>();

const devIdOf = (c: { get: (k: 'user') => RozContext['Variables']['user'] }) => c.get('user')!.devId;

function invalid(c: any, message: string) {
  return c.json({ error: { code: 'VALIDATION_ERROR', message } }, 400);
}

/** Reporta en el log lo que falló después de responder (broadcast, push). */
function backgroundLogger(c: any) {
  const logger = c.get('logger');
  return (err: unknown) => logger?.warn({ err }, 'chat: tarea en segundo plano falló');
}

// ---- Arranque y no leídos ----

chatRoutes.get('/bootstrap', async (c) => {
  try {
    return c.json(await bootstrap(devIdOf(c)));
  } catch (err) {
    return fail(c, err);
  }
});

chatRoutes.get('/unread', async (c) => {
  try {
    return c.json(await unreadSummary(devIdOf(c)));
  } catch (err) {
    return fail(c, err);
  }
});

// ---- Conversaciones ----

const ChannelBody = z.object({
  name: z.string().min(1).max(80),
  topic: z.string().max(250).nullish(),
  description: z.string().max(1000).nullish(),
  isPrivate: z.boolean().optional(),
  memberDevIds: z.array(z.string().uuid()).max(200).optional(),
});

chatRoutes.post('/conversations', async (c) => {
  const parsed = ChannelBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    const { name, topic, description, isPrivate, memberDevIds } = parsed.data;
    const conversation = await createChannel(devIdOf(c), { name: name!, topic, description, isPrivate, memberDevIds });
    return c.json({ conversation }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

chatRoutes.get('/conversations/browse', async (c) => {
  try {
    return c.json({ channels: await browsePublicChannels(devIdOf(c)) });
  } catch (err) {
    return fail(c, err);
  }
});

chatRoutes.get('/conversations/:id', async (c) => {
  try {
    return c.json({ conversation: await conversationFor(devIdOf(c), c.req.param('id')) });
  } catch (err) {
    return fail(c, err);
  }
});

const ConversationPatch = z
  .object({
    name: z.string().min(1).max(80).optional(),
    topic: z.string().max(250).nullish(),
    description: z.string().max(1000).nullish(),
    isPrivate: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'sin cambios');

chatRoutes.patch('/conversations/:id', async (c) => {
  const parsed = ConversationPatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    return c.json({ conversation: await updateConversation(devIdOf(c), c.req.param('id'), parsed.data) });
  } catch (err) {
    return fail(c, err);
  }
});

chatRoutes.delete('/conversations/:id', async (c) => {
  try {
    await deleteConversation(devIdOf(c), c.req.param('id'));
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

const DmBody = z.object({ devIds: z.array(z.string().uuid()).max(20) });

chatRoutes.post('/dms', async (c) => {
  const parsed = DmBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    return c.json({ conversation: await openDm(devIdOf(c), parsed.data.devIds!) });
  } catch (err) {
    return fail(c, err);
  }
});

chatRoutes.post('/conversations/:id/join', async (c) => {
  try {
    return c.json({ conversation: await joinChannel(devIdOf(c), c.req.param('id')) });
  } catch (err) {
    return fail(c, err);
  }
});

chatRoutes.post('/conversations/:id/leave', async (c) => {
  try {
    await leaveConversation(devIdOf(c), c.req.param('id'));
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

chatRoutes.post('/conversations/:id/read', async (c) => {
  try {
    return c.json(await markRead(devIdOf(c), c.req.param('id')));
  } catch (err) {
    return fail(c, err);
  }
});

const MembershipPatch = z
  .object({ notifyLevel: z.enum(['all', 'mentions', 'none']).optional(), hidden: z.boolean().optional() })
  .refine((b) => b.notifyLevel !== undefined || b.hidden !== undefined, 'sin cambios');

chatRoutes.patch('/conversations/:id/membership', async (c) => {
  const parsed = MembershipPatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    return c.json({ membership: await updateMembership(devIdOf(c), c.req.param('id'), parsed.data) });
  } catch (err) {
    return fail(c, err);
  }
});

const MembersBody = z.object({ devIds: z.array(z.string().uuid()).min(1).max(200) });

chatRoutes.post('/conversations/:id/members', async (c) => {
  const parsed = MembersBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    return c.json({ conversation: await addMembers(devIdOf(c), c.req.param('id'), parsed.data.devIds!) });
  } catch (err) {
    return fail(c, err);
  }
});

chatRoutes.delete('/conversations/:id/members/:devId', async (c) => {
  try {
    await removeMember(devIdOf(c), c.req.param('id'), c.req.param('devId'));
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

// ---- Mensajes ----

chatRoutes.get('/conversations/:id/messages', async (c) => {
  const before = c.req.query('before');
  const limit = Number(c.req.query('limit')) || undefined;
  if (before && Number.isNaN(Date.parse(before))) return invalid(c, '`before` debe ser una fecha ISO');
  try {
    return c.json(await listMessages(devIdOf(c), c.req.param('id'), { before, limit }));
  } catch (err) {
    return fail(c, err);
  }
});

const SendBody = z.object({
  body: z.string().max(MAX_MESSAGE_LENGTH).nullish(),
  parentId: z.string().uuid().nullish(),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
  clientNonce: z.string().max(64).nullish(),
});

chatRoutes.post('/conversations/:id/messages', async (c) => {
  const parsed = SendBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    const message = await sendMessage(devIdOf(c), c.req.param('id'), parsed.data, backgroundLogger(c));
    return c.json({ message }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

const EditBody = z.object({ body: z.string().max(MAX_MESSAGE_LENGTH) });

chatRoutes.patch('/messages/:id', async (c) => {
  const parsed = EditBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    return c.json({ message: await editMessage(devIdOf(c), c.req.param('id'), parsed.data.body!, backgroundLogger(c)) });
  } catch (err) {
    return fail(c, err);
  }
});

chatRoutes.delete('/messages/:id', async (c) => {
  try {
    await deleteMessage(devIdOf(c), c.req.param('id'), backgroundLogger(c));
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

chatRoutes.get('/messages/:id/thread', async (c) => {
  try {
    return c.json(await getThread(devIdOf(c), c.req.param('id')));
  } catch (err) {
    return fail(c, err);
  }
});

chatRoutes.get('/messages/:id/locate', async (c) => {
  try {
    return c.json(await locateMessage(devIdOf(c), c.req.param('id')));
  } catch (err) {
    return fail(c, err);
  }
});

// ---- Citar tareas (`@tarea <persona> <texto>` en el compositor) ----

chatRoutes.get('/tasks', async (c) => {
  try {
    return c.json({ tasks: await searchTasks(devIdOf(c), (c.req.query('q') ?? '').slice(0, 120)) });
  } catch (err) {
    return fail(c, err);
  }
});

// ---- Adjuntos ----

chatRoutes.post('/conversations/:id/attachments', async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) return invalid(c, 'falta el archivo');
    if (file.size > MAX_CHAT_ATTACHMENT_BYTES) return invalid(c, 'el archivo supera 4MB');
    const attachment = await uploadAttachment(devIdOf(c), c.req.param('id'), {
      body: Buffer.from(await file.arrayBuffer()),
      name: file.name || 'archivo',
      contentType: file.type,
      size: file.size,
    });
    return c.json({ attachment }, 201);
  } catch (err) {
    return fail(c, err);
  }
});
