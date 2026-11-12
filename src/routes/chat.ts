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
import { MAX_CHAT_ATTACHMENT_BYTES, completeUpload, requestUpload, tooLargeMessage } from '../chat/attachments.js';
import { MAX_MESSAGE_LENGTH, MAX_STATUS_TASKS } from '../chat/text.js';
import { searchTasks } from '../chat/tasks.js';
import { assertInternalChatWritable } from '../discord/enabled.js';
import { AppError } from '../utils/errors.js';

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

// Con ROZ_DISCORD_CHAT encendido el chat interno queda de solo lectura: lo escrito aquí no llegaría
// a nadie en Discord (409 CHAT_REPLACED_BY_DISCORD). Marcar leído, salir y las preferencias de la
// membresía siguen permitidos (no publican nada). Con el flag apagado no cambia nada.
const INTERNAL_CHAT_ALLOWED_WRITES = [/\/conversations\/[^/]+\/read\/?$/, /\/conversations\/[^/]+\/leave\/?$/, /\/conversations\/[^/]+\/membership\/?$/];
chatRoutes.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !INTERNAL_CHAT_ALLOWED_WRITES.some((re) => re.test(c.req.path))) {
    try {
      assertInternalChatWritable();
    } catch (err) {
      if (err instanceof AppError) {
        return c.json({ error: { code: err.code, message: err.message } }, err.status as 409);
      }
      throw err;
    }
  }
  await next();
});

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
  statusTaskIds: z.array(z.string().uuid()).max(MAX_STATUS_TASKS).optional(),
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
    const limit = Number(c.req.query('limit')) || undefined;
    return c.json({ tasks: await searchTasks(devIdOf(c), (c.req.query('q') ?? '').slice(0, 120), limit) });
  } catch (err) {
    return fail(c, err);
  }
});

// ---- Adjuntos ----

// El archivo NO pasa por aquí (Vercel corta los cuerpos en 4.5 MB): se pide una URL firmada, el
// navegador sube directo a Storage y luego confirma. Ver src/chat/attachments.ts.
const UploadUrlBody = z.object({
  name: z.string().min(1).max(255),
  contentType: z.string().max(255).nullish(),
  size: z.number().int().positive(),
});

chatRoutes.post('/conversations/:id/attachments/upload-url', async (c) => {
  const parsed = UploadUrlBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  const { name, contentType, size } = parsed.data;
  if (size! > MAX_CHAT_ATTACHMENT_BYTES) return invalid(c, tooLargeMessage(name!, size!));
  try {
    return c.json(await requestUpload(devIdOf(c), c.req.param('id'), { name: name!, contentType: contentType ?? null, size: size! }), 201);
  } catch (err) {
    return fail(c, err);
  }
});

chatRoutes.post('/attachments/:id/complete', async (c) => {
  try {
    return c.json({ attachment: await completeUpload(devIdOf(c), c.req.param('id')) });
  } catch (err) {
    return fail(c, err);
  }
});
