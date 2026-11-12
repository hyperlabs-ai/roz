// API del chat sobre Discord (ROZ_DISCORD_CHAT; contrato en docs/discord-chat-contracts.md).
//
//   · discordRoutes        → /api/dashboard/discord/* — montado DENTRO de dashboardRoutes, así que
//                            ya pasó por requireDashboardAuth: el dev sale SIEMPRE de la sesión.
//   · discordBridgeRoutes  → /v1/internal/discord/events — avisos del puente (Bearer ROZ_BRIDGE_SECRET).
//
// Con el flag apagado todo responde 404 DISCORD_CHAT_DISABLED, salvo GET /status (enabled:false),
// que es con lo que el front decide qué chat montar.
import { Hono } from 'hono';
import { z } from 'zod';
import type { RozContext } from '../types/hono.js';
import { config } from '../config.js';
import { AppError } from '../utils/errors.js';
import { bearerToken, secureEqual } from '../utils/secure-compare.js';
import { fail } from './http.js';
import { discordChatEnabled, DISCORD_CHAT_DISABLED_CODE } from '../discord/enabled.js';
import { DISCORD_NOT_LINKED, DISCORD_NOT_MEMBER, assertChannelVisible, loadViewer } from '../discord/access.js';
import { bindOAuthStateCookie, discordStatus, startDiscordLink, unlinkDiscord } from '../discord/link.js';
import { assertCanAttach, deleteDiscordMessage, editDiscordMessage, listChannelMessages, sendDiscordMessage } from '../discord/messages.js';
import { completeDiscordUpload, requestDiscordUpload, tooLarge } from '../discord/uploads.js';
import { archivedThreads, buildChannelTree } from '../discord/views.js';
import { listEmojis, listRoles, searchMembers } from '../discord/directory.js';
import { listProjectChannels, setProjectChannel } from '../discord/projects.js';
import { createTaskFromDiscordMessage } from '../discord/tasks.js';
import { BridgeEventsBodySchema, processBridgeNotices } from '../discord/events.js';
import type { DiscordBridgeNotice } from '../types/discord.js';
import { ROZ_SUBCOMMANDS } from '../discord/commands/definitions.js';
import { autocompleteFromRoz, rozCommandMenu, runCommandFromRoz } from '../discord/commands/from-roz.js';

export const discordRoutes = new Hono<RozContext>();

const devIdOf = (c: { get: (k: 'user') => RozContext['Variables']['user'] }) => c.get('user')!.devId;

function invalid(c: any, message: string) {
  return c.json({ error: { code: 'VALIDATION_ERROR', message } }, 400);
}

/** Como `fail`, pero conserva `details` (p. ej. retryAfterSec de un 503 de Discord, §B.4). */
function failDiscord(c: any, err: unknown) {
  if (err instanceof AppError && err.details !== undefined) {
    c.get('logger')?.warn({ code: err.code, err: err.message }, 'discord app error');
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  }
  return fail(c, err);
}

function backgroundLogger(c: any) {
  const logger = c.get('logger');
  return (err: unknown) => logger?.warn({ err }, 'discord: tarea en segundo plano falló');
}

const disabled = (c: any) =>
  c.json({ error: { code: DISCORD_CHAT_DISABLED_CODE, message: 'El chat de Discord no está activado en este servidor.' } }, 404);

// Guardia del flag para todo menos GET /status.
discordRoutes.use('*', async (c, next) => {
  const isStatus = c.req.method === 'GET' && /\/status\/?$/.test(c.req.path);
  if (!isStatus && !discordChatEnabled()) return disabled(c);
  await next();
});

const snowflake = z.string().regex(/^\d{15,25}$/, 'id de Discord inválido');
const validId = (id: string) => /^\d{15,25}$/.test(id);

// ---- Estado y cuenta ligada ----

discordRoutes.get('/status', async (c) => {
  try {
    return c.json(await discordStatus(devIdOf(c)));
  } catch (err) {
    return failDiscord(c, err);
  }
});

discordRoutes.post('/link/start', async (c) => {
  try {
    const { url } = await startDiscordLink(devIdOf(c), c.get('user')?.id ?? null);
    // El state también queda en una cookie HttpOnly de ESTE navegador: el callback exige que
    // coincidan. Sin eso, alguien podría mandarle a otra persona su propia URL de autorización y
    // ligar la cuenta de Discord de la víctima a SU dev (y leer sus canales desde roz).
    bindOAuthStateCookie(c, new URL(url).searchParams.get('state') ?? '');
    return c.json({ url });
  } catch (err) {
    return failDiscord(c, err);
  }
});

discordRoutes.delete('/link', async (c) => {
  try {
    await unlinkDiscord(devIdOf(c));
    return c.json({ ok: true });
  } catch (err) {
    return failDiscord(c, err);
  }
});

// ---- Canales ----

discordRoutes.get('/channels', async (c) => {
  try {
    const viewer = await loadViewer(devIdOf(c));
    return c.json(buildChannelTree(viewer.snap, viewer.ctx));
  } catch (err) {
    return failDiscord(c, err);
  }
});

discordRoutes.get('/channels/:channelId/threads', async (c) => {
  const channelId = c.req.param('channelId');
  const before = c.req.query('before');
  if (!validId(channelId)) return invalid(c, 'id de canal inválido');
  if (before && Number.isNaN(Date.parse(before))) return invalid(c, '`before` debe ser una fecha ISO');
  try {
    const viewer = await loadViewer(devIdOf(c));
    assertChannelVisible(viewer, channelId);
    return c.json(archivedThreads(viewer.snap, viewer.ctx, channelId, { before, limit: Number(c.req.query('limit')) || undefined }));
  } catch (err) {
    return failDiscord(c, err);
  }
});

// ---- Mensajes ----

discordRoutes.get('/channels/:channelId/messages', async (c) => {
  const channelId = c.req.param('channelId');
  const before = c.req.query('before') || null;
  const around = c.req.query('around') || null;
  if (!validId(channelId)) return invalid(c, 'id de canal inválido');
  if (before && !validId(before)) return invalid(c, '`before` debe ser un id de mensaje');
  if (around && !validId(around)) return invalid(c, '`around` debe ser un id de mensaje');
  if (before && around) return invalid(c, 'usa `before` o `around`, no ambos');
  try {
    const viewer = await loadViewer(devIdOf(c));
    return c.json(await listChannelMessages(viewer, channelId, { before, around, limit: Number(c.req.query('limit')) || null }));
  } catch (err) {
    return failDiscord(c, err);
  }
});

const SendBody = z.object({
  content: z.string().max(2000).default(''),
  replyToId: snowflake.nullish(),
  uploadIds: z.array(z.string().uuid()).max(10).optional(),
  clientNonce: z.string().max(64).nullish(),
});

discordRoutes.post('/channels/:channelId/messages', async (c) => {
  const channelId = c.req.param('channelId');
  if (!validId(channelId)) return invalid(c, 'id de canal inválido');
  const parsed = SendBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    // z.infer marca requeridos como opcionales en el build de prod → destructurar + `!`.
    const { content, replyToId, uploadIds, clientNonce } = parsed.data;
    const viewer = await loadViewer(devIdOf(c));
    const message = await sendDiscordMessage(viewer, channelId, { content: content!, replyToId, uploadIds, clientNonce }, backgroundLogger(c));
    return c.json({ message }, 201);
  } catch (err) {
    return failDiscord(c, err);
  }
});

const EditBody = z.object({ content: z.string().max(2000) });

discordRoutes.patch('/messages/:messageId', async (c) => {
  const messageId = c.req.param('messageId');
  if (!validId(messageId)) return invalid(c, 'id de mensaje inválido');
  const parsed = EditBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    const viewer = await loadViewer(devIdOf(c));
    return c.json({ message: await editDiscordMessage(viewer, messageId, parsed.data.content!, backgroundLogger(c)) });
  } catch (err) {
    return failDiscord(c, err);
  }
});

discordRoutes.delete('/messages/:messageId', async (c) => {
  const messageId = c.req.param('messageId');
  if (!validId(messageId)) return invalid(c, 'id de mensaje inválido');
  try {
    const viewer = await loadViewer(devIdOf(c));
    await deleteDiscordMessage(viewer, messageId, backgroundLogger(c));
    return c.json({ ok: true });
  } catch (err) {
    return failDiscord(c, err);
  }
});

// ---- Adjuntos (subida directa a Storage; §B.6) ----

const UploadBody = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().positive(),
  contentType: z.string().max(255).nullish(),
});

discordRoutes.post('/channels/:channelId/uploads', async (c) => {
  const channelId = c.req.param('channelId');
  if (!validId(channelId)) return invalid(c, 'id de canal inválido');
  const parsed = UploadBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  const { name, size, contentType } = parsed.data;
  try {
    if (size! > config.discord.maxUploadBytes) throw tooLarge(name!, size!);
    const viewer = await loadViewer(devIdOf(c));
    const channel = assertCanAttach(viewer, channelId);
    return c.json(await requestDiscordUpload(viewer.devId, channel.id, { name: name!, size: size!, contentType: contentType ?? null }), 201);
  } catch (err) {
    return failDiscord(c, err);
  }
});

discordRoutes.post('/uploads/:uploadId/complete', async (c) => {
  const uploadId = c.req.param('uploadId');
  if (!z.string().uuid().safeParse(uploadId).success) return invalid(c, 'id de archivo inválido');
  try {
    return c.json({ upload: await completeDiscordUpload(devIdOf(c), uploadId) });
  } catch (err) {
    return failDiscord(c, err);
  }
});

// ---- Directorio (compositor y menciones; §B.8) ----

discordRoutes.get('/members', async (c) => {
  try {
    await loadViewer(devIdOf(c)); // sin vínculo/miembro no se lista a nadie
    return c.json({ members: await searchMembers((c.req.query('q') ?? '').slice(0, 80), Number(c.req.query('limit')) || 20) });
  } catch (err) {
    return failDiscord(c, err);
  }
});

discordRoutes.get('/emojis', async (c) => {
  try {
    await loadViewer(devIdOf(c));
    return c.json({ emojis: await listEmojis() });
  } catch (err) {
    return failDiscord(c, err);
  }
});

discordRoutes.get('/roles', async (c) => {
  try {
    await loadViewer(devIdOf(c));
    return c.json({ roles: await listRoles() });
  } catch (err) {
    return failDiscord(c, err);
  }
});

// ---- Proyecto ↔ canal (§B.10) ----

discordRoutes.get('/project-channels', async (c) => {
  try {
    // Sin vínculo (o fuera del servidor) se lista igual, pero sin nombres de canal.
    const viewer = await loadViewer(devIdOf(c)).catch((err) => {
      if (err instanceof AppError && (err.code === DISCORD_NOT_LINKED || err.code === DISCORD_NOT_MEMBER)) return null;
      throw err;
    });
    return c.json({ items: await listProjectChannels(viewer) });
  } catch (err) {
    return failDiscord(c, err);
  }
});

const ProjectChannelBody = z.object({ channelId: snowflake.nullable() });

discordRoutes.put('/project-channels/:projectId', async (c) => {
  const projectId = c.req.param('projectId');
  if (!z.string().uuid().safeParse(projectId).success) return invalid(c, 'id de proyecto inválido');
  const parsed = ProjectChannelBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    const viewer = await loadViewer(devIdOf(c));
    return c.json({ item: await setProjectChannel(viewer, projectId, parsed.data.channelId ?? null) });
  } catch (err) {
    return failDiscord(c, err);
  }
});

// ---- Crear issue desde un mensaje (§B.11) ----

const TASK_STATE = z.enum(['planificada', 'pendiente', 'en_progreso', 'revision', 'completada', 'cancelada']);
const TASK_PRIORITY = z.enum(['urgent', 'high', 'medium', 'low']);
const TASK_POINTS = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8), z.literal(13)]);

const TaskBody = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(500),
  description: z.string().nullish(),
  status: TASK_STATE.optional(),
  priority: TASK_PRIORITY.nullish(),
  assigneeDevId: z.string().uuid().nullish(),
  assigneeDevIds: z.array(z.string().uuid()).optional(),
  dueDate: z.string().nullish(),
  labels: z.array(z.string()).optional(),
  estimate: TASK_POINTS.nullish(),
  solutionTypeId: z.string().uuid().nullish(),
});

discordRoutes.post('/messages/:messageId/task', async (c) => {
  const messageId = c.req.param('messageId');
  if (!validId(messageId)) return invalid(c, 'id de mensaje inválido');
  const parsed = TaskBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    const { projectId, name, description, status, priority, assigneeDevId, assigneeDevIds, dueDate, labels, estimate, solutionTypeId } = parsed.data;
    const viewer = await loadViewer(devIdOf(c));
    const result = await createTaskFromDiscordMessage(
      viewer,
      messageId,
      {
        projectId: projectId!,
        name: name!,
        description,
        status,
        priority,
        assigneeDevId,
        assigneeDevIds,
        dueDate,
        labels,
        estimate: estimate ?? null,
        solutionTypeId,
      },
      c.get('user')?.id ?? null,
      backgroundLogger(c),
    );
    return c.json(result, 201);
  } catch (err) {
    return failDiscord(c, err);
  }
});

// ---- Comandos de /roz desde el compositor de roz (docs/discord-commands-contract.md §9) ----

const SubcommandSchema = z.enum(ROZ_SUBCOMMANDS);
const OptionsSchema = z.record(z.string().max(200)).optional();

/** Menú "/": la MISMA lista y descripciones que el desplegable de Discord. */
discordRoutes.get('/commands', async (c) => {
  try {
    await loadViewer(devIdOf(c));
    return c.json({ items: rozCommandMenu() });
  } catch (err) {
    return failDiscord(c, err);
  }
});

const CommandBody = z.object({
  subcommand: SubcommandSchema,
  options: OptionsSchema,
  fields: z.record(z.union([z.string().max(8000), z.array(z.string().max(100)).max(50)])).optional(),
});

discordRoutes.post('/channels/:channelId/commands', async (c) => {
  const channelId = c.req.param('channelId');
  if (!validId(channelId)) return invalid(c, 'id de canal inválido');
  const parsed = CommandBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  const logger = c.get('logger');
  try {
    const { subcommand, options, fields } = parsed.data;
    const viewer = await loadViewer(devIdOf(c));
    const result = await runCommandFromRoz(viewer, channelId, { subcommand: subcommand!, options, fields }, {
      log: (msg, extra) => logger?.info({ ...extra, subcommand }, msg),
    });
    return c.json(result);
  } catch (err) {
    return failDiscord(c, err);
  }
});

const AutocompleteBody = z.object({
  subcommand: SubcommandSchema,
  option: z.string().min(1).max(32),
  value: z.string().max(200).default(''),
  options: OptionsSchema,
});

discordRoutes.post('/channels/:channelId/commands/autocomplete', async (c) => {
  const channelId = c.req.param('channelId');
  if (!validId(channelId)) return invalid(c, 'id de canal inválido');
  const parsed = AutocompleteBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    const { subcommand, option, value, options } = parsed.data;
    const viewer = await loadViewer(devIdOf(c));
    return c.json({ choices: await autocompleteFromRoz(viewer, channelId, { subcommand: subcommand!, option: option!, value: value ?? '', options }) });
  } catch (err) {
    return failDiscord(c, err);
  }
});

// ================================================================ puente → roz (§A.2)

export const discordBridgeRoutes = new Hono<RozContext>();

/** Bearer del puente en tiempo constante. Secreto vacío → nunca pasa (fail-closed). */
export function bridgeAuthorized(header: string | null | undefined): boolean {
  const secret = config.discord.bridgeSecret;
  if (!secret) return false;
  return secureEqual(bearerToken(header), secret);
}

discordBridgeRoutes.post('/discord/events', async (c) => {
  // Flag primero: con el chat apagado el puente recibe 404 y deja de avisar hasta su próximo arranque
  // (aunque roz no tenga secreto configurado, que con el flag apagado no se exige).
  if (!discordChatEnabled()) return disabled(c);
  if (!bridgeAuthorized(c.req.header('authorization'))) return c.json({ error: 'forbidden' }, 403);
  const parsed = BridgeEventsBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  const { guildId, notices } = parsed.data;
  if (guildId !== config.discord.guildId) return c.json({ error: 'forbidden' }, 403);
  const logger = c.get('logger');
  try {
    const result = await processBridgeNotices(guildId!, notices as DiscordBridgeNotice[], (err) =>
      logger?.warn({ err }, 'discord: broadcast de un aviso del puente falló'),
    );
    return c.json(result);
  } catch (err) {
    logger?.error({ err }, 'discord: no se pudieron procesar los avisos del puente');
    return c.json({ error: { code: 'INTERNAL', message: 'no se pudieron procesar los avisos' } }, 500);
  }
});
