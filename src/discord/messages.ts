// Mensajes del chat de Discord: leer (paginado), enviar, editar y borrar (contrato §B.3–§B.5).
//
// Leer = el espejo que escribe el puente. Escribir = el webhook de roz del canal, con el nombre y la
// foto del dev; la respuesta de Discord (wait=true) se registra en la MISMA fila que después pisa el
// eco del gateway (llave = snowflake), con dev_id y client_nonce que el puente nunca escribe (§D).
import { db } from '../db/supabase.js';
import {
  DISCORD_ERROR,
  DISCORD_MAX_CONTENT,
  buildAllowedMentions,
  deleteWebhookMessage,
  editWebhookMessage,
  executeWebhook,
  extractUserMentions,
  isDiscordError,
  snowflakeDate,
  userAvatarUrl,
  type DiscordApiMessage,
} from '../adapters/discord.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { inBackground } from '../utils/background.js';
import { TEXT_CHANNEL_TYPES, isThreadType, type DiscordChannelRow, type DiscordMessagePage, type DiscordMessageRow, type DiscordMessageView } from '../types/discord.js';
import { abilitiesIn, assertChannelVisible, type Viewer } from './access.js';
import { DISCORD_CANNOT_SEND, DISCORD_CHANNEL_UNSUPPORTED, DISCORD_NOT_OWN_MESSAGE, DISCORD_THREAD_LOCKED, mapDiscordError } from './errors.js';
import { normalizeApiMessage } from './normalize.js';
import { broadcastDeleted, broadcastMessage } from './realtime.js';
import { parseReplyPrefix, withReplyPrefix, type ReplyTarget } from './reply.js';
import { MESSAGE_COLUMNS, selectIn, webhookChannelOf } from './store.js';
import { downloadUploads, loadUploadsForSend, settleUploads } from './uploads.js';
import { buildMessageViews, compareSnowflake, githubAvatar } from './views.js';
import { existingWebhook, withWebhook } from './webhooks.js';

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;
const AROUND_SIDE = 25;

type OnError = (err: unknown) => void;

// ---------------------------------------------------------------- lectura

export async function loadMessageRow(messageId: string): Promise<DiscordMessageRow | null> {
  const { data, error } = await db().from('discord_message').select(MESSAGE_COLUMNS).eq('id', messageId).maybeSingle();
  if (error) throw error;
  return (data as DiscordMessageRow | null) ?? null;
}

/** Mensaje vigente cuyo canal/hilo ve el dev, o 404. */
export async function loadVisibleMessage(viewer: Viewer, messageId: string): Promise<{ row: DiscordMessageRow; channel: DiscordChannelRow }> {
  const row = await loadMessageRow(messageId);
  if (!row || row.deleted_at || row.guild_id !== viewer.snap.guildId) throw new NotFoundError('el mensaje no existe');
  const { channel, abilities } = assertChannelVisible(viewer, row.channel_id);
  if (!abilities.readHistory) throw new NotFoundError('el mensaje no existe');
  return { row, channel };
}

async function backfillComplete(channelId: string): Promise<boolean> {
  const { data } = await db().from('discord_sync_state').select('backfill_complete').eq('channel_id', channelId).maybeSingle();
  return (data as { backfill_complete: boolean } | null)?.backfill_complete ?? false;
}

function timeOf(row: Pick<DiscordMessageRow, 'created_at'>): number {
  return Date.parse(row.created_at);
}

/** Más nuevo primero: (created_at, id) descendente. */
function newestFirst(a: DiscordMessageRow, b: DiscordMessageRow): number {
  return timeOf(b) - timeOf(a) || compareSnowflake(b.id, a.id);
}

/** Momento de un mensaje: su fila si está en el espejo; si no, el que codifica su snowflake. */
async function anchorTime(messageId: string): Promise<{ iso: string; row: DiscordMessageRow | null }> {
  const row = await loadMessageRow(messageId);
  if (row) return { iso: new Date(timeOf(row)).toISOString(), row };
  return { iso: snowflakeDate(messageId).toISOString(), row: null };
}

/** Filas estrictamente ANTERIORES al ancla (created_at, id) — hasta `limit + 1` para saber si hay más. */
async function olderThan(channelId: string, anchorIso: string, anchorId: string, limit: number): Promise<DiscordMessageRow[]> {
  // `lte` + filtro en memoria en vez de un `or()` compuesto: los empates en created_at (mismo ms)
  // se resuelven por id sin armar filtros de PostgREST a mano. El colchón cubre esos empates.
  const { data, error } = await db()
    .from('discord_message')
    .select(MESSAGE_COLUMNS)
    .eq('channel_id', channelId)
    .is('deleted_at', null)
    .lte('created_at', anchorIso)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 21);
  if (error) throw error;
  const t = Date.parse(anchorIso);
  return ((data ?? []) as DiscordMessageRow[])
    .filter((r) => timeOf(r) < t || (timeOf(r) === t && compareSnowflake(r.id, anchorId) < 0))
    .sort(newestFirst)
    .slice(0, limit + 1);
}

async function newerThan(channelId: string, anchorIso: string, anchorId: string, limit: number): Promise<DiscordMessageRow[]> {
  const { data, error } = await db()
    .from('discord_message')
    .select(MESSAGE_COLUMNS)
    .eq('channel_id', channelId)
    .is('deleted_at', null)
    .gte('created_at', anchorIso)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit + 21);
  if (error) throw error;
  const t = Date.parse(anchorIso);
  return ((data ?? []) as DiscordMessageRow[])
    .filter((r) => timeOf(r) > t || (timeOf(r) === t && compareSnowflake(r.id, anchorId) > 0))
    .sort((a, b) => -newestFirst(a, b))
    .slice(0, limit);
}

export interface ListOptions {
  before?: string | null;
  around?: string | null;
  limit?: number | null;
}

/** GET /channels/:channelId/messages — descendente, paginado hacia atrás (contrato §B.3). */
export async function listChannelMessages(viewer: Viewer, channelId: string, opts: ListOptions = {}): Promise<DiscordMessagePage> {
  const { abilities } = assertChannelVisible(viewer, channelId);
  const complete = await backfillComplete(channelId);
  // Sin READ_MESSAGE_HISTORY Discord tampoco muestra el historial.
  if (!abilities.readHistory) return { messages: [], hasMore: false, backfillComplete: complete };
  const limit = Math.min(Math.max(Math.trunc(Number(opts.limit) || DEFAULT_PAGE), 1), MAX_PAGE);

  let rows: DiscordMessageRow[];
  let hasMore: boolean;
  if (opts.around) {
    const anchor = await anchorTime(opts.around);
    const older = await olderThan(channelId, anchor.iso, opts.around, AROUND_SIDE);
    const newer = await newerThan(channelId, anchor.iso, opts.around, AROUND_SIDE);
    const center = anchor.row && anchor.row.channel_id === channelId && !anchor.row.deleted_at ? [anchor.row] : [];
    hasMore = older.length > AROUND_SIDE || !complete;
    rows = [...newer.reverse(), ...center, ...older.slice(0, AROUND_SIDE)];
  } else {
    let page: DiscordMessageRow[];
    if (opts.before) {
      const anchor = await anchorTime(opts.before);
      page = await olderThan(channelId, anchor.iso, opts.before, limit);
    } else {
      const { data, error } = await db()
        .from('discord_message')
        .select(MESSAGE_COLUMNS)
        .eq('channel_id', channelId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (error) throw error;
      page = ((data ?? []) as DiscordMessageRow[]).sort(newestFirst);
    }
    hasMore = page.length > limit || !complete;
    rows = page.slice(0, limit);
  }
  return { messages: await buildMessageViews(rows, viewer.snap), hasMore, backfillComplete: complete };
}

// ---------------------------------------------------------------- escritura

interface DevIdentity {
  name: string;
  github_login: string | null;
}

async function devIdentity(devId: string): Promise<DevIdentity> {
  const { data, error } = await db().from('dev').select('name, github_login').eq('id', devId).maybeSingle();
  if (error) throw error;
  return (data as DevIdentity | null) ?? { name: 'roz', github_login: null };
}

/** Foto que verá Discord: la de GitHub del dev, o la de su cuenta de Discord ligada, o ninguna. */
export function webhookAvatar(dev: DevIdentity, link: { discord_user_id: string; avatar: string | null } | null): string | null {
  return githubAvatar(dev.github_login, 128) ?? (link ? userAvatarUrl(link.discord_user_id, link.avatar) : null);
}

/** Canal escribible desde roz: texto/anuncios, o un hilo (incluidas publicaciones de foro). */
function assertSupported(channel: DiscordChannelRow): void {
  if (TEXT_CHANNEL_TYPES.has(channel.type) || isThreadType(channel.type)) return;
  throw new AppError(DISCORD_CHANNEL_UNSUPPORTED, 'En este tipo de canal no se puede escribir desde roz.', 400);
}

/** ¿El mensaje salió del webhook de roz de su canal (o del padre, si es un hilo)? */
export async function isRozWebhookMessage(row: DiscordMessageRow, channel: DiscordChannelRow): Promise<boolean> {
  if (!row.webhook_id) return false;
  const { data } = await db().from('discord_webhook').select('webhook_id').eq('channel_id', webhookChannelOf(channel)).maybeSingle();
  return (data as { webhook_id: string } | null)?.webhook_id === row.webhook_id;
}

/** A quién mencionar en la línea de respuesta (contrato §B.4 paso 4). */
async function replyAuthorId(target: DiscordMessageRow): Promise<string | null> {
  if (!target.webhook_id) return target.author_id;
  if (!target.dev_id) return null;
  const { data } = await db().from('discord_link').select('discord_user_id').eq('dev_id', target.dev_id).maybeSingle();
  return (data as { discord_user_id: string } | null)?.discord_user_id ?? null;
}

/** Menciones que SÍ suenan: las del texto que son miembros activos, más el autor citado. */
async function allowedMentionIds(content: string, extra: (string | null)[], guild: string): Promise<string[]> {
  const ids = [...new Set([...extractUserMentions(content), ...extra.filter((x): x is string => !!x)])];
  if (!ids.length) return [];
  const members = await selectIn<{ user_id: string; left_at: string | null }>('discord_member', 'user_id, left_at', 'user_id', ids, (q) =>
    q.eq('guild_id', guild),
  );
  const active = new Set(members.filter((m) => !m.left_at).map((m) => m.user_id));
  return ids.filter((id) => active.has(id));
}

/** Fila que roz registra con la respuesta de Discord (§D): todo lo de Discord + dev_id + client_nonce. */
export function rowFromSend(
  res: DiscordApiMessage,
  guild: string,
  extra: { devId: string; clientNonce: string | null; replyToId: string | null },
): DiscordMessageRow {
  const base = normalizeApiMessage(res, guild);
  return {
    ...base,
    reply_to_id: base.reply_to_id ?? extra.replyToId,
    dev_id: extra.devId,
    client_nonce: extra.clientNonce,
    synced_at: new Date().toISOString(),
  };
}

async function upsertMessage(row: DiscordMessageRow): Promise<void> {
  const { error } = await db().from('discord_message').upsert(row, { onConflict: 'id' });
  if (error) throw error;
}

export interface SendInput {
  content: string;
  replyToId?: string | null;
  uploadIds?: string[];
  clientNonce?: string | null;
}

/** POST /channels/:channelId/messages (contrato §B.4). */
export async function sendDiscordMessage(viewer: Viewer, channelId: string, input: SendInput, onError?: OnError): Promise<DiscordMessageView> {
  const { channel, abilities } = assertChannelVisible(viewer, channelId);
  assertSupported(channel);
  const uploadIds = input.uploadIds ?? [];
  if (!abilities.send) {
    if (isThreadType(channel.type) && channel.locked) throw new AppError(DISCORD_THREAD_LOCKED, 'El hilo está bloqueado.', 409);
    throw new AppError(DISCORD_CANNOT_SEND, 'No tienes permiso para escribir en este canal.', 403);
  }
  if (uploadIds.length && !abilities.attach) throw new AppError(DISCORD_CANNOT_SEND, 'No tienes permiso para adjuntar archivos en este canal.', 403);

  const body = input.content ?? '';
  if (!body.trim() && !uploadIds.length) throw new ValidationError('el mensaje está vacío');

  let content = body;
  let replyAuthor: string | null = null;
  let replyToId: string | null = null;
  if (input.replyToId) {
    const target = await loadMessageRow(input.replyToId);
    if (!target || target.deleted_at || target.channel_id !== channel.id) throw new ValidationError('el mensaje al que respondes no existe en este canal');
    replyAuthor = await replyAuthorId(target);
    replyToId = target.id;
    const reply: ReplyTarget = { guildId: viewer.snap.guildId, channelId: channel.id, messageId: target.id, authorId: replyAuthor };
    content = withReplyPrefix(reply, body);
  }
  if (content.length > DISCORD_MAX_CONTENT) {
    throw new ValidationError(`el mensaje pasa de ${DISCORD_MAX_CONTENT} caracteres (Discord no acepta más)`);
  }

  const uploads = await loadUploadsForSend(viewer.devId, channel.id, uploadIds);
  const files = await downloadUploads(uploads);
  const [dev, mentionIds] = await Promise.all([devIdentity(viewer.devId), allowedMentionIds(content, [replyAuthor], viewer.snap.guildId)]);
  const threadId = isThreadType(channel.type) ? channel.id : null;

  const res = await withWebhook(webhookChannelOf(channel), (hook) =>
    executeWebhook({
      webhookId: hook.webhookId,
      token: hook.token,
      content,
      username: dev.name,
      avatarUrl: webhookAvatar(dev, viewer.link),
      allowedMentions: buildAllowedMentions(mentionIds),
      threadId,
      files,
    }),
  );

  const row = rowFromSend(res, viewer.snap.guildId, { devId: viewer.devId, clientNonce: input.clientNonce ?? null, replyToId });
  await upsertMessage(row);
  await settleUploads(uploads, row.id);

  const [view] = await buildMessageViews([row], viewer.snap, { refreshAttachments: false });
  inBackground(() => broadcastMessage(viewer.snap, 'discord.message.created', view!), onError);
  return view!;
}

/** Solo el dev que lo envió, y solo si salió por el webhook de roz del canal (contrato §B.5). */
async function assertOwnRozMessage(viewer: Viewer, messageId: string): Promise<{ row: DiscordMessageRow; channel: DiscordChannelRow }> {
  const { row, channel } = await loadVisibleMessage(viewer, messageId);
  const mine = row.dev_id?.toLowerCase() === viewer.devId.toLowerCase();
  if (!mine || !(await isRozWebhookMessage(row, channel))) {
    throw new AppError(DISCORD_NOT_OWN_MESSAGE, 'Solo puedes editar o borrar tus propios mensajes enviados desde roz.', 403);
  }
  return { row, channel };
}

async function ownWebhook(channel: DiscordChannelRow) {
  const hook = await existingWebhook(webhookChannelOf(channel));
  if (!hook) throw new AppError(DISCORD_NOT_OWN_MESSAGE, 'El webhook con el que se envió este mensaje ya no existe.', 409);
  return hook;
}

/** PATCH /messages/:messageId — conserva la línea de respuesta y recalcula las menciones. */
export async function editDiscordMessage(viewer: Viewer, messageId: string, newBody: string, onError?: OnError): Promise<DiscordMessageView> {
  const { row, channel } = await assertOwnRozMessage(viewer, messageId);
  if (!newBody.trim() && !(row.attachments ?? []).length) throw new ValidationError('el mensaje está vacío');

  let content = newBody;
  let replyAuthor: string | null = null;
  const prev = parseReplyPrefix(row.content).replyTo;
  if (prev) {
    replyAuthor = prev.authorId;
    content = withReplyPrefix(prev, newBody);
  } else if (row.reply_to_id) {
    const target = await loadMessageRow(row.reply_to_id);
    replyAuthor = target ? await replyAuthorId(target) : null;
    content = withReplyPrefix({ guildId: viewer.snap.guildId, channelId: channel.id, messageId: row.reply_to_id, authorId: replyAuthor }, newBody);
  }
  if (content.length > DISCORD_MAX_CONTENT) throw new ValidationError(`el mensaje pasa de ${DISCORD_MAX_CONTENT} caracteres (Discord no acepta más)`);

  const hook = await ownWebhook(channel);
  const mentionIds = await allowedMentionIds(content, [replyAuthor], viewer.snap.guildId);
  let res: DiscordApiMessage;
  try {
    res = await editWebhookMessage(
      hook.webhookId,
      hook.token,
      row.id,
      { content, allowedMentions: buildAllowedMentions(mentionIds) },
      isThreadType(channel.type) ? channel.id : null,
    );
  } catch (err) {
    throw mapDiscordError(err);
  }
  const next = rowFromSend(res, viewer.snap.guildId, { devId: viewer.devId, clientNonce: row.client_nonce, replyToId: row.reply_to_id });
  await upsertMessage(next);
  const [view] = await buildMessageViews([next], viewer.snap);
  inBackground(() => broadcastMessage(viewer.snap, 'discord.message.updated', view!), onError);
  return view!;
}

/** DELETE /messages/:messageId — borra en Discord y deja el borrado suave en el espejo. */
export async function deleteDiscordMessage(viewer: Viewer, messageId: string, onError?: OnError): Promise<void> {
  const { row, channel } = await assertOwnRozMessage(viewer, messageId);
  const hook = await ownWebhook(channel);
  try {
    await deleteWebhookMessage(hook.webhookId, hook.token, row.id, isThreadType(channel.type) ? channel.id : null);
  } catch (err) {
    // Ya no existía en Discord: el resultado es el mismo que se pidió.
    if (!isDiscordError(err, DISCORD_ERROR.UNKNOWN_MESSAGE)) throw mapDiscordError(err);
  }
  const { error } = await db().from('discord_message').update({ deleted_at: new Date().toISOString() }).eq('id', row.id);
  if (error) throw error;
  inBackground(() => broadcastDeleted(viewer.snap, row.channel_id, [row.id]), onError);
}

/** ¿El canal del viewer admite adjuntos? (para la ruta de subida). */
export function assertCanAttach(viewer: Viewer, channelId: string): DiscordChannelRow {
  const { channel } = assertChannelVisible(viewer, channelId);
  assertSupported(channel);
  const a = abilitiesIn(viewer, channelId);
  if (!a.attach) throw new AppError(DISCORD_CANNOT_SEND, 'No tienes permiso para adjuntar archivos en este canal.', 403);
  return channel;
}
