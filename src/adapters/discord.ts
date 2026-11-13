// Discord (chat de roz, ROZ_DISCORD_CHAT): cliente REST con `fetch`. Aquí solo vive el TRANSPORTE;
// qué se publica, en qué canal y con qué permisos lo deciden src/discord/*. La conexión al gateway
// (eventos en vivo) NO vive aquí: es del puente (src/bridge/), porque Vercel no mantiene
// conexiones abiertas.
//
// `fetch` directo y no discord.js, por las mismas razones que src/adapters/linear.ts: controlamos
// cada campo que viaja, no arrastramos un cliente de gateway a una función serverless, y los errores
// salen tipados para que quien llama decida.
//
// Rate limit (https://discord.com/developers/docs/topics/rate-limits):
//   · Por ruta: Discord agrupa rutas en "buckets" (header X-RateLimit-Bucket) y los parte por su
//     parámetro mayor (canal, servidor, webhook+token). Recordamos remaining/reset de cada bucket y,
//     si está agotado, esperamos el reset ANTES de pedir — si la espera es corta; si es larga, error
//     reintentable sin gastar la petición.
//   · 429: se espera `retry_after` y se reintenta (solo si la espera es corta). Un 429 NUNCA se
//     procesó del lado de Discord, así que reintentarlo no duplica mensajes. Un 5xx sí podría haberse
//     procesado: NO se reintenta aquí (un mensaje duplicado en un canal real es peor que un error).
//   · Global (`global: true` o X-RateLimit-Global): frena todas las rutas hasta que venza.
//
// Secretos: el token del bot, los tokens de webhook y los de OAuth NUNCA aparecen en mensajes de
// error ni en logs. Los errores identifican la ruta con `routeKey` (ids → :id, token → :token).
import { config } from '../config.js';
import type { DiscordPermissionOverwrite } from '../types/discord.js';

// ---------------------------------------------------------------- tipos de la API (subconjunto)

export interface DiscordApiUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  discriminator?: string;
  bot?: boolean;
}

export interface DiscordApiWebhook {
  id: string;
  /** 1 = incoming (los que usa roz), 2 = channel follower, 3 = application. */
  type: number;
  guild_id?: string | null;
  channel_id: string | null;
  name: string | null;
  avatar?: string | null;
  /** Solo en webhooks incoming. Secreto: no loguear. */
  token?: string;
  application_id?: string | null;
  user?: DiscordApiUser;
}

export interface DiscordApiAttachment {
  id: string;
  filename: string;
  description?: string | null;
  content_type?: string | null;
  size: number;
  url: string;
  proxy_url?: string | null;
  height?: number | null;
  width?: number | null;
  duration_secs?: number | null;
  flags?: number;
}

export interface DiscordApiEmbed {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  author?: { name: string; url?: string; icon_url?: string };
  footer?: { text: string; icon_url?: string };
  image?: { url: string; width?: number; height?: number };
  thumbnail?: { url: string; width?: number; height?: number };
  video?: { url?: string; width?: number; height?: number };
  provider?: { name?: string; url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface DiscordApiReaction {
  count: number;
  count_details?: { burst: number; normal: number };
  me?: boolean;
  emoji: { id: string | null; name: string | null; animated?: boolean };
}

export interface DiscordApiMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  type: number;
  author: DiscordApiUser;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  webhook_id?: string;
  attachments: DiscordApiAttachment[];
  embeds: DiscordApiEmbed[];
  mentions: DiscordApiUser[];
  mention_roles: string[];
  mention_everyone: boolean;
  pinned: boolean;
  flags?: number;
  /** Componentes del mensaje (filas, o Components V2 si flags trae 1 << 15). */
  components?: unknown[];
  reactions?: DiscordApiReaction[];
  message_reference?: { type?: number; message_id?: string; channel_id?: string; guild_id?: string };
  thread?: { id: string; name: string; message_count?: number };
  sticker_items?: { id: string; name: string; format_type: number }[];
}

export interface DiscordApiChannel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string | null;
  topic?: string | null;
  position?: number;
  parent_id?: string | null;
  nsfw?: boolean;
  permission_overwrites?: DiscordPermissionOverwrite[];
  recipients?: DiscordApiUser[];
}

export interface DiscordApiGuildMember {
  user?: DiscordApiUser;
  nick?: string | null;
  avatar?: string | null;
  roles: string[];
  joined_at: string;
  pending?: boolean;
  communication_disabled_until?: string | null;
}

/** allowed_mentions: qué menciones del texto HACEN SONAR a alguien. */
export interface DiscordAllowedMentions {
  parse: Array<'users' | 'roles' | 'everyone'>;
  users?: string[];
  roles?: string[];
  replied_user?: boolean;
}

export interface DiscordFile {
  name: string;
  contentType: string | null;
  data: Uint8Array | ArrayBuffer | Blob;
  description?: string | null;
}

export interface DiscordOAuthToken {
  accessToken: string;
  tokenType: string;
  scope: string;
  expiresIn: number;
}

// ---------------------------------------------------------------- errores

/** Códigos JSON de error de Discord que roz trata en particular. */
export const DISCORD_ERROR = {
  UNKNOWN_CHANNEL: 10003,
  UNKNOWN_GUILD: 10004,
  UNKNOWN_MEMBER: 10007,
  UNKNOWN_MESSAGE: 10008,
  UNKNOWN_WEBHOOK: 10015,
  UNKNOWN_USER: 10013,
  MAX_WEBHOOKS: 30007,
  ENTITY_TOO_LARGE: 40005,
  MISSING_ACCESS: 50001,
  CANNOT_DM_USER: 50007,
  EMPTY_MESSAGE: 50006,
  MISSING_PERMISSIONS: 50013,
  INVALID_FORM_BODY: 50035,
  THREAD_ARCHIVED: 50083,
} as const;

export class DiscordError extends Error {
  /** HTTP status; null = no hubo respuesta (red, timeout) o no se llegó a pedir (bucket agotado). */
  readonly status: number | null;
  /** true = vale la pena reintentar más tarde (rate limit, 5xx, red, timeout). */
  readonly retryable: boolean;
  /** Segundos que pidió Discord antes de reintentar, si los mandó. */
  readonly retryAfterSec: number | null;
  /** Código JSON de Discord (DISCORD_ERROR) o código propio ('timeout', 'network', 'rate_limited', …). */
  readonly code: number | string | null;
  /** Ruta SIN secretos (routeKey), para logs. */
  readonly route: string;
  /** Lo que devolvió Discord (sin secretos: Discord nunca refleja tokens). */
  readonly detail: unknown;

  constructor(
    message: string,
    opts: { status: number | null; retryable: boolean; route: string; retryAfterSec?: number | null; code?: number | string | null; detail?: unknown },
  ) {
    super(message);
    this.name = 'DiscordError';
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.code = opts.code ?? null;
    this.route = opts.route;
    this.detail = opts.detail ?? null;
  }
}

export function isDiscordError(err: unknown, code?: number | string): err is DiscordError {
  return err instanceof DiscordError && (code === undefined || err.code === code);
}

// ---------------------------------------------------------------- reloj (inyectable en tests)

const clock = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
};

/** Solo tests: reemplaza el reloj (para no dormir de verdad) y/o limpia el estado de rate limit. */
export function __setDiscordClock(over: Partial<typeof clock>): void {
  Object.assign(clock, over);
}

// ---------------------------------------------------------------- rate limit

/** Espera máxima que se tolera en línea (dentro de una petición del usuario) antes de fallar. */
const MAX_INLINE_WAIT_MS = 5_000;
const TIMEOUT_MS = 15_000;
const MAX_429_RETRIES = 2;

interface BucketState {
  remaining: number;
  resetAt: number;
}

const routeBucket = new Map<string, string>(); // `${method} ${routeKey}` → hash de bucket de Discord
const buckets = new Map<string, BucketState>(); // `${bucket}|${majorKey}` → estado
let globalUntil = 0;

export function __resetDiscordRateLimits(): void {
  routeBucket.clear();
  buckets.clear();
  globalUntil = 0;
}

const SNOWFLAKE = /^\d{15,25}$/;

/**
 * Ruta normalizada para buckets y logs: ids → `:id` salvo el parámetro mayor, y el token de webhook
 * SIEMPRE → `:token` (es un secreto). Ej: `POST /webhooks/123/abc` → route `/webhooks/123/:token`,
 * major `webhooks/123`.
 */
export function routeKey(path: string): { route: string; major: string } {
  const clean = path.split('?')[0]!.replace(/\/+$/, '');
  const parts = clean.split('/').filter(Boolean);
  const out: string[] = [];
  let major = '';
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    const prev = parts[i - 1];
    if (i === 1 && (prev === 'channels' || prev === 'guilds') && SNOWFLAKE.test(seg)) {
      out.push(seg);
      major = `${prev}/${seg}`;
    } else if (i === 1 && prev === 'webhooks' && SNOWFLAKE.test(seg)) {
      out.push(seg);
      major = `webhooks/${seg}`;
    } else if (i === 2 && (parts[0] === 'webhooks' || parts[0] === 'interactions')) {
      // Token de webhook o de interacción: secreto, nunca en logs ni en la llave del bucket.
      out.push(':token');
    } else if (SNOWFLAKE.test(seg)) {
      out.push(':id');
    } else {
      out.push(seg);
    }
  }
  return { route: '/' + out.join('/'), major };
}

function bucketKey(method: string, route: string, major: string): string {
  const hash = routeBucket.get(`${method} ${route}`) ?? `${method} ${route}`;
  return `${hash}|${major}`;
}

async function waitOrThrow(untilMs: number, route: string, why: string): Promise<void> {
  const wait = untilMs - clock.now();
  if (wait <= 0) return;
  if (wait > MAX_INLINE_WAIT_MS) {
    throw new DiscordError(`Discord: límite de solicitudes (${why})`, {
      status: null,
      retryable: true,
      route,
      retryAfterSec: Math.ceil(wait / 1000),
      code: 'rate_limited',
    });
  }
  await clock.sleep(wait);
}

function headerNum(h: { get(k: string): string | null }, k: string): number | null {
  const v = h.get(k);
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rememberBucket(method: string, route: string, major: string, headers: { get(k: string): string | null }): void {
  const hash = headers.get('x-ratelimit-bucket');
  if (hash) routeBucket.set(`${method} ${route}`, hash);
  const remaining = headerNum(headers, 'x-ratelimit-remaining');
  const resetAfter = headerNum(headers, 'x-ratelimit-reset-after');
  if (remaining === null || resetAfter === null) return;
  buckets.set(bucketKey(method, route, major), { remaining, resetAt: clock.now() + resetAfter * 1000 });
}

// ---------------------------------------------------------------- petición

type Auth = 'bot' | 'none' | { bearer: string };

export interface DiscordRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Relativa a DISCORD_API_URL, con `/` inicial. Puede llevar un token de webhook: nunca se loguea. */
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  json?: unknown;
  form?: FormData;
  urlencoded?: Record<string, string>;
  auth?: Auth;
  /** X-Audit-Log-Reason (se ve en el registro de auditoría del servidor). */
  reason?: string;
}

export function discordConfigured(): boolean {
  return config.discord.botToken !== '';
}

function authHeader(auth: Auth): string | null {
  if (auth === 'none') return null;
  if (auth === 'bot') return `Bot ${config.discord.botToken}`;
  return `Bearer ${auth.bearer}`;
}

function buildUrl(path: string, query?: DiscordRequest['query']): string {
  const url = new URL(config.discord.apiUrl + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Una llamada REST. Devuelve el JSON (o null en 204) o lanza DiscordError. */
export async function discordRequest<T>(req: DiscordRequest): Promise<T> {
  const auth = req.auth ?? 'bot';
  const { route, major } = routeKey(req.path);
  if (auth === 'bot' && !discordConfigured()) {
    throw new DiscordError('DISCORD_BOT_TOKEN no configurado', { status: null, retryable: false, route, code: 'not_configured' });
  }

  for (let attempt = 0; ; attempt++) {
    await waitOrThrow(globalUntil, route, 'global');
    const state = buckets.get(bucketKey(req.method, route, major));
    if (state && state.remaining <= 0) await waitOrThrow(state.resetAt, route, 'ruta');

    const headers: Record<string, string> = { 'user-agent': 'DiscordBot (https://github.com/hyperlabs-ai/roz, 1.0)' };
    const authValue = authHeader(auth);
    if (authValue) headers.authorization = authValue;
    if (req.reason) headers['x-audit-log-reason'] = encodeURIComponent(req.reason);
    let body: string | FormData | undefined;
    if (req.form) {
      body = req.form; // fetch pone el boundary del multipart
    } else if (req.urlencoded) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(req.urlencoded).toString();
    } else if (req.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.json);
    }

    let res: Response;
    try {
      res = await fetch(buildUrl(req.path, req.query), {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      // Sin el error original en el mensaje: en Node puede incluir la URL, y la URL puede llevar un
      // token de webhook.
      throw new DiscordError(timeout ? `Discord no respondió en ${TIMEOUT_MS / 1000}s` : 'Discord inalcanzable', {
        status: null,
        retryable: true,
        route,
        code: timeout ? 'timeout' : 'network',
      });
    }

    rememberBucket(req.method, route, major, res.headers);
    const text = await res.text().catch(() => '');
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const errBody = (parsed ?? {}) as { code?: number; message?: string; retry_after?: number; global?: boolean };

    if (res.status === 429) {
      const retryAfter = typeof errBody.retry_after === 'number' ? errBody.retry_after : headerNum(res.headers, 'retry-after') ?? 1;
      const isGlobal = errBody.global === true || res.headers.get('x-ratelimit-global') === 'true';
      const until = clock.now() + retryAfter * 1000;
      if (isGlobal) globalUntil = Math.max(globalUntil, until);
      else buckets.set(bucketKey(req.method, route, major), { remaining: 0, resetAt: until });
      if (attempt < MAX_429_RETRIES && retryAfter * 1000 <= MAX_INLINE_WAIT_MS) {
        await clock.sleep(retryAfter * 1000);
        continue;
      }
      throw new DiscordError('Discord: límite de solicitudes', {
        status: 429,
        retryable: true,
        route,
        retryAfterSec: retryAfter,
        code: 'rate_limited',
        detail: { global: isGlobal, scope: res.headers.get('x-ratelimit-scope') },
      });
    }

    if (!res.ok) {
      const code = typeof errBody.code === 'number' ? errBody.code : res.status === 401 ? 'unauthorized' : null;
      throw new DiscordError(`Discord ${res.status} en ${req.method} ${route}${errBody.message ? `: ${errBody.message}` : ''}`, {
        status: res.status,
        retryable: res.status >= 500,
        route,
        code,
        detail: parsed ?? text,
      });
    }

    if (res.status === 204 || !text) return null as T;
    if (parsed === undefined) {
      throw new DiscordError('respuesta_invalida de Discord', { status: res.status, retryable: false, route, code: 'respuesta_invalida' });
    }
    return parsed as T;
  }
}

// ---------------------------------------------------------------- helpers de contenido

/** Máximo de caracteres de `content` en un mensaje. */
export const DISCORD_MAX_CONTENT = 2000;

/**
 * Nombre válido para un webhook/username de webhook: 1-80 caracteres, sin "discord"/"clyde" (Discord
 * rechaza el mensaje entero si aparecen) ni bloques de código. Nunca vacío.
 */
export function sanitizeWebhookUsername(name: string): string {
  let out = (name ?? '')
    .replace(/```/g, '')
    .replace(/discord/gi, 'd1scord')
    .replace(/clyde/gi, 'cl yde')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(everyone|here|system message)$/i.test(out)) out = `${out} (roz)`;
  if (!out) out = 'roz';
  return out.slice(0, 80);
}

/**
 * allowed_mentions SEGURO para todo lo que sale de roz: nunca @everyone/@here ni roles; solo suenan
 * los usuarios listados (los que el texto menciona y son miembros del servidor). Discord acepta como
 * máximo 100 ids.
 */
export function buildAllowedMentions(userIds: Iterable<string>): DiscordAllowedMentions {
  const users = [...new Set([...userIds].filter((id) => SNOWFLAKE.test(id)))].slice(0, 100);
  return { parse: [], users, roles: [], replied_user: false };
}

/** Ids de usuario mencionados en un texto con formato de Discord (`<@id>` o `<@!id>`). */
export function extractUserMentions(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/<@!?(\d{15,25})>/g)) out.add(m[1]!);
  return [...out];
}

function toBlob(file: DiscordFile): Blob {
  const type = file.contentType ?? 'application/octet-stream';
  if (file.data instanceof Blob) return file.data;
  const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
  // Copia a un ArrayBuffer propio: Blob no acepta vistas sobre SharedArrayBuffer en los tipos de TS.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type });
}

// ---------------------------------------------------------------- webhooks

export async function listChannelWebhooks(channelId: string): Promise<DiscordApiWebhook[]> {
  return discordRequest<DiscordApiWebhook[]>({ method: 'GET', path: `/channels/${channelId}/webhooks` });
}

/** Crea un webhook incoming en el canal (exige MANAGE_WEBHOOKS al bot). Máx. 15 por canal. */
export async function createChannelWebhook(channelId: string, name = 'roz', reason = 'roz: publicar desde el dashboard'): Promise<DiscordApiWebhook> {
  return discordRequest<DiscordApiWebhook>({
    method: 'POST',
    path: `/channels/${channelId}/webhooks`,
    json: { name: sanitizeWebhookUsername(name) },
    reason,
  });
}

export interface ExecuteWebhookInput {
  webhookId: string;
  token: string;
  content: string;
  /** Nombre visible (el del dev). Se sanea con sanitizeWebhookUsername. */
  username: string;
  avatarUrl?: string | null;
  allowedMentions: DiscordAllowedMentions;
  /** Publicar dentro de un hilo del canal del webhook. */
  threadId?: string | null;
  files?: DiscordFile[];
  /** 4 = SUPPRESS_EMBEDS, 4096 = SUPPRESS_NOTIFICATIONS, 32768 = IS_COMPONENTS_V2 (sin content ni embeds). */
  flags?: number;
  /** Fichas de roz (comandos desde el compositor de roz). Máx. 10. */
  embeds?: DiscordApiEmbed[];
  /**
   * Botones/selects. Solo los acepta un webhook creado por la app (los de roz lo son: los crea el
   * bot). Forma de la API (filas tipo 1).
   */
  components?: unknown[];
}

/**
 * Publica con el webhook y ESPERA el mensaje creado (wait=true): roz necesita su id para registrar
 * la fila con el dev que lo envió antes de que llegue el eco del gateway.
 */
export async function executeWebhook(input: ExecuteWebhookInput): Promise<DiscordApiMessage> {
  // Con IS_COMPONENTS_V2 (1 << 15) el mensaje no lleva content ni embeds: solo componentes.
  const v2 = ((input.flags ?? 0) & (1 << 15)) !== 0;
  const payload: Record<string, unknown> = {
    ...(v2 ? {} : { content: input.content }),
    username: sanitizeWebhookUsername(input.username),
    allowed_mentions: input.allowedMentions,
  };
  if (input.avatarUrl) payload.avatar_url = input.avatarUrl;
  if (input.flags) payload.flags = input.flags;
  if (input.embeds?.length && !v2) payload.embeds = input.embeds.slice(0, 10);
  if (input.components?.length) payload.components = input.components;
  const files = input.files ?? [];
  const base = {
    method: 'POST' as const,
    path: `/webhooks/${input.webhookId}/${input.token}`,
    // with_components: sin él Discord IGNORA `components` en webhooks (aunque sean de la app).
    query: { wait: true, thread_id: input.threadId ?? undefined, with_components: input.components?.length ? true : undefined },
    auth: 'none' as const,
  };
  if (!files.length) return discordRequest<DiscordApiMessage>({ ...base, json: payload });

  payload.attachments = files.map((f, i) => ({ id: i, filename: f.name, ...(f.description ? { description: f.description } : {}) }));
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  files.forEach((f, i) => form.append(`files[${i}]`, toBlob(f), f.name));
  return discordRequest<DiscordApiMessage>({ ...base, form });
}

export async function editWebhookMessage(
  webhookId: string,
  token: string,
  messageId: string,
  patch: { content: string; allowedMentions: DiscordAllowedMentions },
  threadId?: string | null,
): Promise<DiscordApiMessage> {
  return discordRequest<DiscordApiMessage>({
    method: 'PATCH',
    path: `/webhooks/${webhookId}/${token}/messages/${messageId}`,
    query: { thread_id: threadId ?? undefined },
    json: { content: patch.content, allowed_mentions: patch.allowedMentions },
    auth: 'none',
  });
}

export async function deleteWebhookMessage(webhookId: string, token: string, messageId: string, threadId?: string | null): Promise<void> {
  await discordRequest<null>({
    method: 'DELETE',
    path: `/webhooks/${webhookId}/${token}/messages/${messageId}`,
    query: { thread_id: threadId ?? undefined },
    auth: 'none',
  });
}

// ---------------------------------------------------------------- adjuntos

/** Máximo de URLs por llamada a /attachments/refresh-urls. */
export const DISCORD_REFRESH_URLS_MAX = 50;

/**
 * Las URLs de adjuntos de Discord CADUCAN (~24 h; parámetros `ex`/`is`/`hm`). Esto pide URLs nuevas
 * para las que se le pasen (máx. 50). Devuelve mapa original → refrescada.
 */
export async function refreshAttachmentUrls(urls: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(urls)].slice(0, DISCORD_REFRESH_URLS_MAX);
  const out = new Map<string, string>();
  if (!unique.length) return out;
  const res = await discordRequest<{ refreshed_urls?: { original: string; refreshed: string }[] }>({
    method: 'POST',
    path: '/attachments/refresh-urls',
    json: { attachment_urls: unique },
  });
  for (const r of res?.refreshed_urls ?? []) out.set(r.original, r.refreshed);
  return out;
}

/** Epoch (ms) en que caduca una URL de adjunto de Discord (`ex` en hex, segundos), o null si no trae. */
export function attachmentUrlExpiresAt(url: string): number | null {
  try {
    const ex = new URL(url).searchParams.get('ex');
    if (!ex || !/^[0-9a-f]+$/i.test(ex)) return null;
    return parseInt(ex, 16) * 1000;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- bot

export interface BotMessageInput {
  content: string;
  allowedMentions: DiscordAllowedMentions;
  embeds?: DiscordApiEmbed[];
  /** Respuesta nativa (el bot sí puede, a diferencia del webhook). */
  replyToMessageId?: string | null;
}

export async function sendBotMessage(channelId: string, input: BotMessageInput): Promise<DiscordApiMessage> {
  const json: Record<string, unknown> = { content: input.content, allowed_mentions: input.allowedMentions };
  if (input.embeds?.length) json.embeds = input.embeds;
  if (input.replyToMessageId) json.message_reference = { message_id: input.replyToMessageId, fail_if_not_exists: false };
  return discordRequest<DiscordApiMessage>({ method: 'POST', path: `/channels/${channelId}/messages`, json });
}

/** Abre (o reutiliza) el DM del bot con un usuario. Falla con CANNOT_DM_USER si tiene los DMs cerrados. */
export async function createDmChannel(userId: string): Promise<DiscordApiChannel> {
  return discordRequest<DiscordApiChannel>({ method: 'POST', path: '/users/@me/channels', json: { recipient_id: userId } });
}

/** Miembro del servidor, o null si no está (10007). Sirve para validar el vínculo al ligar la cuenta. */
export async function getGuildMember(userId: string, guildId = config.discord.guildId): Promise<DiscordApiGuildMember | null> {
  try {
    return await discordRequest<DiscordApiGuildMember>({ method: 'GET', path: `/guilds/${guildId}/members/${userId}` });
  } catch (err) {
    if (isDiscordError(err, DISCORD_ERROR.UNKNOWN_MEMBER) || isDiscordError(err, DISCORD_ERROR.UNKNOWN_USER)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------- interacciones (comandos /roz)
//
// Las interacciones llegan por el gateway al puente y el puente las reenvía a roz
// (docs/discord-commands-contract.md). La respuesta INICIAL (≤ 3 s) la manda el puente con lo que roz
// le devuelve; roz completa lo diferido con el token de la interacción (válido 15 min). Nada de esto
// usa el token del bot: el token de la interacción ES la credencial, y nunca se loguea (routeKey lo
// tacha).

/** Cuerpo de un mensaje de interacción (callback type 4/7, editar original, followup). */
export interface InteractionMessageBody {
  /** null al editar con IS_COMPONENTS_V2: Discord exige vaciar el content al poner el flag. */
  content?: string | null;
  embeds?: DiscordApiEmbed[];
  components?: unknown[];
  allowed_mentions?: DiscordAllowedMentions;
  /** 64 = EPHEMERAL (callback type 4/5 y followups); 32768 = IS_COMPONENTS_V2. */
  flags?: number;
}

/** Cuerpo de POST /interactions/{id}/{token}/callback. */
export interface InteractionCallbackBody {
  type: number;
  data?: Record<string, unknown>;
}

/**
 * Respuesta inicial a una interacción. En el flujo normal la manda el PUENTE; roz la expone para
 * pruebas y para el caso en que roz tuviera que responder directo.
 */
export async function createInteractionResponse(interactionId: string, token: string, body: InteractionCallbackBody): Promise<void> {
  await discordRequest<null>({ method: 'POST', path: `/interactions/${interactionId}/${token}/callback`, json: body, auth: 'none' });
}

/** Edita la respuesta original (la diferida "pensando…", o el mensaje del componente tras un type 6). */
export async function editInteractionOriginal(applicationId: string, token: string, body: InteractionMessageBody): Promise<DiscordApiMessage> {
  return discordRequest<DiscordApiMessage>({
    method: 'PATCH',
    path: `/webhooks/${applicationId}/${token}/messages/@original`,
    // with_components: sin él, Discord ignora `components` al editar por el webhook de la interacción.
    query: { with_components: body.components ? true : undefined },
    json: body,
    auth: 'none',
  });
}

export async function deleteInteractionOriginal(applicationId: string, token: string): Promise<void> {
  await discordRequest<null>({ method: 'DELETE', path: `/webhooks/${applicationId}/${token}/messages/@original`, auth: 'none' });
}

/** Mensaje adicional con el mismo token (público o efímero según `flags`). */
export async function createInteractionFollowup(applicationId: string, token: string, body: InteractionMessageBody): Promise<DiscordApiMessage> {
  return discordRequest<DiscordApiMessage>({
    method: 'POST',
    path: `/webhooks/${applicationId}/${token}`,
    query: { wait: true, with_components: body.components ? true : undefined },
    json: body,
    auth: 'none',
  });
}

// ---------------------------------------------------------------- comandos de servidor

/** Comando registrado tal como lo devuelve Discord (subconjunto). */
export interface DiscordApiCommand {
  id: string;
  application_id: string;
  guild_id?: string;
  type?: number;
  name: string;
  description: string;
  options?: unknown[];
  version?: string;
}

export async function listGuildCommands(applicationId: string, guildId = config.discord.guildId): Promise<DiscordApiCommand[]> {
  return discordRequest<DiscordApiCommand[]>({ method: 'GET', path: `/applications/${applicationId}/guilds/${guildId}/commands` });
}

/**
 * Reemplaza TODOS los comandos de la app en el servidor por `commands` (idempotente: lo que no viene
 * se borra, lo que viene igual no cambia de id). Comandos de servidor: se actualizan al instante.
 */
export async function bulkOverwriteGuildCommands(applicationId: string, commands: unknown[], guildId = config.discord.guildId): Promise<DiscordApiCommand[]> {
  return discordRequest<DiscordApiCommand[]>({
    method: 'PUT',
    path: `/applications/${applicationId}/guilds/${guildId}/commands`,
    json: commands,
  });
}

// ---------------------------------------------------------------- OAuth2 (ligar cuenta)

const OAUTH_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';

/** URL a la que se manda al dev para autorizar (scope identify: solo id, nombre y avatar). */
export function oauthAuthorizeUrl(state: string): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.discord.clientId);
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('redirect_uri', config.discord.oauthRedirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'none');
  return url.toString();
}

/** Intercambia el `code` del callback por un access token. No se guarda: solo sirve para /users/@me. */
export async function exchangeOAuthCode(code: string): Promise<DiscordOAuthToken> {
  const raw = await discordRequest<{ access_token: string; token_type: string; scope: string; expires_in: number }>({
    method: 'POST',
    path: '/oauth2/token',
    auth: 'none',
    urlencoded: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.discord.oauthRedirectUri,
      client_id: config.discord.clientId,
      client_secret: config.discord.clientSecret,
    },
  });
  if (!raw?.access_token) {
    throw new DiscordError('respuesta_invalida de Discord (oauth)', { status: 200, retryable: false, route: '/oauth2/token', code: 'respuesta_invalida' });
  }
  return { accessToken: raw.access_token, tokenType: raw.token_type, scope: raw.scope, expiresIn: raw.expires_in };
}

/** Usuario dueño del token de OAuth. */
export async function fetchOAuthUser(accessToken: string): Promise<DiscordApiUser> {
  return discordRequest<DiscordApiUser>({ method: 'GET', path: '/users/@me', auth: { bearer: accessToken } });
}

/** Revoca el token en cuanto se leyó la identidad (roz no lo necesita después). Best-effort. */
export async function revokeOAuthToken(accessToken: string): Promise<void> {
  await discordRequest<null>({
    method: 'POST',
    path: '/oauth2/token/revoke',
    auth: 'none',
    urlencoded: {
      token: accessToken,
      token_type_hint: 'access_token',
      client_id: config.discord.clientId,
      client_secret: config.discord.clientSecret,
    },
  });
}

// ---------------------------------------------------------------- CDN

const CDN = 'https://cdn.discordapp.com';

/** Avatar de un usuario; sin hash, el avatar por defecto que Discord asigna por id. */
export function userAvatarUrl(userId: string, avatarHash: string | null | undefined, size = 128): string {
  if (avatarHash) return `${CDN}/avatars/${userId}/${avatarHash}.${avatarHash.startsWith('a_') ? 'gif' : 'png'}?size=${size}`;
  let index = 0;
  try {
    index = Number((BigInt(userId) >> 22n) % 6n);
  } catch {
    index = 0;
  }
  return `${CDN}/embed/avatars/${index}.png`;
}

/** Avatar propio del servidor (gana sobre el de la cuenta). */
export function memberAvatarUrl(guildId: string, userId: string, guildAvatarHash: string, size = 128): string {
  return `${CDN}/guilds/${guildId}/users/${userId}/avatars/${guildAvatarHash}.${guildAvatarHash.startsWith('a_') ? 'gif' : 'png'}?size=${size}`;
}

export function emojiUrl(emojiId: string, animated: boolean, size = 48): string {
  return `${CDN}/emojis/${emojiId}.${animated ? 'gif' : 'webp'}?size=${size}`;
}

export function guildIconUrl(guildId: string, iconHash: string | null | undefined, size = 128): string | null {
  if (!iconHash) return null;
  return `${CDN}/icons/${guildId}/${iconHash}.${iconHash.startsWith('a_') ? 'gif' : 'png'}?size=${size}`;
}

/** Fecha de creación codificada en un snowflake (ms desde el epoch de Discord, 2015-01-01). */
export function snowflakeDate(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + 1420070400000n));
}
