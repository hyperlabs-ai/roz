// Utilidades PURAS del chat de Discord (sin React): orden por snowflake, upsert de mensajes con el
// optimista por clientNonce (contrato §C/§D), agrupado, menciones del compositor y URLs del CDN.
// Solo importa TIPOS: lo prueba test/discord-web.test.ts sin alias ni cliente de Supabase.
import type {
  DiscordChannelTreeView,
  DiscordChannelView,
  DiscordMessageView,
  DiscordThreadView,
} from '../lib/api';

/** Subconjunto de DISCORD_CHANNEL_TYPE (lib/api.ts), local para no arrastrar el cliente HTTP. */
const TYPE = { TEXT: 0, VOICE: 2, ANNOUNCEMENT: 5, STAGE: 13, FORUM: 15, MEDIA: 16 } as const;

// ------------------------------------------------------------------------------------- snowflakes

/** Compara dos snowflakes (string) sin BigInt: más largo = más grande; si no, orden lexicográfico. */
export function compareSnowflake(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Fecha de creación codificada en el snowflake (epoch de Discord 2015-01-01). */
export function snowflakeDate(id: string): Date | null {
  try {
    return new Date(Number((BigInt(id) >> 22n) + 1420070400000n));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------- mensajes

/** Mensaje en pantalla: el de la API más el estado local del envío optimista. */
export interface UiMessage extends DiscordMessageView {
  /** Aún no lo confirma la API (id temporal `local:<nonce>`). */
  pending?: boolean;
  failed?: boolean;
  /** Para reintentar un envío fallido tal cual. */
  retry?: { content: string; replyToId?: string; uploadIds?: string[] };
}

export const LOCAL_PREFIX = 'local:';
export const isLocal = (m: Pick<UiMessage, 'id'>) => m.id.startsWith(LOCAL_PREFIX);

/** Orden ascendente (más viejo primero); los locales siempre al final, por hora. */
export function sortMessages(list: UiMessage[]): UiMessage[] {
  return list.slice().sort((a, b) => {
    const la = isLocal(a);
    const lb = isLocal(b);
    if (la !== lb) return la ? 1 : -1;
    if (la && lb) return a.createdAt.localeCompare(b.createdAt);
    return compareSnowflake(a.id, b.id);
  });
}

/**
 * Upsert por id (contrato §C): el mismo mensaje llega por la respuesta 201, por el `created` de roz y
 * por el eco del puente; el que llegue después solo reemplaza. Si trae un `clientNonce` nuestro, el
 * optimista se cambia por el real.
 */
/**
 * El eco del gateway de un mensaje enviado desde roz puede llegar (vía el puente) leído ANTES de que
 * roz guardara su dev_id: viene como webhook sin dueño (fromRoz:false). Si ya teníamos la versión
 * atribuida al dev, se conserva el autor: si no, el mensaje "cambiaría de dueño" y dejaría de poder
 * editarse hasta recargar. Solo aplica cuando lo nuevo es del MISMO webhook y sin atribución.
 */
export function keepRozAuthor(prev: DiscordMessageView, next: DiscordMessageView): DiscordMessageView {
  if (!prev.fromRoz || next.fromRoz || !next.author.webhook || next.author.discordUserId !== prev.author.discordUserId) return next;
  return { ...next, fromRoz: true, author: prev.author, clientNonce: next.clientNonce ?? prev.clientNonce };
}

export function upsertMessage(list: UiMessage[], m: DiscordMessageView): UiMessage[] {
  let next = list;
  if (m.clientNonce) {
    const i = next.findIndex((x) => isLocal(x) && x.clientNonce === m.clientNonce);
    if (i !== -1) next = next.filter((_, n) => n !== i);
  }
  const j = next.findIndex((x) => x.id === m.id);
  if (j !== -1) {
    const copy = next.slice();
    copy[j] = keepRozAuthor(next[j]!, m);
    return copy;
  }
  return sortMessages([...next, m]);
}

/** Quita mensajes borrados y marca como "eliminado" la cita de las respuestas que los citaban. */
export function removeMessages(list: UiMessage[], ids: string[]): UiMessage[] {
  const gone = new Set(ids);
  return list
    .filter((m) => !gone.has(m.id))
    .map((m) => (m.replyTo && gone.has(m.replyTo.id) ? { ...m, replyTo: { ...m.replyTo, deleted: true, excerpt: null } } : m));
}

/** Página (desc) → lista asc, fusionada con lo que ya había (los repetidos ganan con lo nuevo). */
export function mergePage(list: UiMessage[], page: DiscordMessageView[]): UiMessage[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of page) byId.set(m.id, m);
  return sortMessages([...byId.values()]);
}

/**
 * Primera página tras reconectar: lo nuevo reemplaza el tramo reciente; lo más viejo que ya estaba
 * cargado (scroll hacia arriba) se conserva; los optimistas en vuelo también.
 */
export function replaceRecent(list: UiMessage[], page: DiscordMessageView[]): UiMessage[] {
  const fresh = sortMessages(page);
  const oldest = fresh[0]?.id;
  const keepOld = oldest ? list.filter((m) => !isLocal(m) && compareSnowflake(m.id, oldest) < 0) : [];
  const locals = list.filter((m) => isLocal(m) && !fresh.some((f) => f.clientNonce && f.clientNonce === m.clientNonce));
  return sortMessages([...keepOld, ...fresh, ...locals]);
}

/** Llave de autor para agrupar: los mensajes de roz salen todos por el MISMO webhook. */
export function authorKey(m: DiscordMessageView): string {
  return m.author.devId ? `dev:${m.author.devId}` : `${m.author.discordUserId}:${m.author.displayName}`;
}

/** Tipos de mensaje "de usuario" (0 normal, 19 respuesta, 20 comando, 23 menú contextual). */
export function isUserMessage(m: DiscordMessageView): boolean {
  return m.type === 0 || m.type === 19 || m.type === 20 || m.type === 23;
}

const GROUP_MS = 7 * 60_000;

/** Continúa el grupo del anterior (sin avatar ni nombre): mismo autor, < 7 min, sin cita. */
export function continuesGroup(prev: DiscordMessageView | undefined, cur: DiscordMessageView): boolean {
  if (!prev || !isUserMessage(prev) || !isUserMessage(cur) || cur.replyTo) return false;
  if (authorKey(prev) !== authorKey(cur)) return false;
  return new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_MS;
}

export function startsDay(prev: DiscordMessageView | undefined, cur: DiscordMessageView): boolean {
  if (!prev) return true;
  const a = new Date(prev.createdAt);
  const b = new Date(cur.createdAt);
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
}

/** ¿Me menciona? (usuario directo, @everyone/@here, o un rol mío si se conoce). */
export function mentionsMe(m: DiscordMessageView, myDiscordId: string | null, myRoleIds: string[] = []): boolean {
  if (!myDiscordId) return false;
  if (m.mentionEveryone) return true;
  if (m.mentions.some((u) => u.id === myDiscordId)) return true;
  return m.mentionRoles.some((r) => myRoleIds.includes(r));
}

// ------------------------------------------------------------------------------------- canales

export interface ChannelEntry {
  id: string;
  name: string;
  type: number;
  topic: string | null;
  parentId: string | null;
  /** Categoría (para canales) o canal padre (para hilos). */
  isThread: boolean;
  supported: boolean;
  channel: DiscordChannelView | null;
  thread: DiscordThreadView | null;
}

/** Índice plano de canales e hilos visibles (para menciones #canal, encabezado y rutas). */
export function indexChannels(tree: DiscordChannelTreeView | null): Map<string, ChannelEntry> {
  const map = new Map<string, ChannelEntry>();
  if (!tree) return map;
  const all = [...tree.uncategorized, ...tree.categories.flatMap((c) => c.channels)];
  for (const ch of all) {
    map.set(ch.id, {
      id: ch.id, name: ch.name, type: ch.type, topic: ch.topic, parentId: ch.parentId, isThread: false,
      supported: ch.supported, channel: ch, thread: null,
    });
    for (const th of ch.threads) {
      map.set(th.id, {
        id: th.id, name: th.name, type: th.type, topic: null, parentId: ch.id, isThread: true,
        supported: true, channel: null, thread: th,
      });
    }
  }
  return map;
}

export const isForum = (type: number) => type === TYPE.FORUM || type === TYPE.MEDIA;
export const isVoice = (type: number) => type === TYPE.VOICE || type === TYPE.STAGE;
export const isTextLike = (type: number) => type === TYPE.TEXT || type === TYPE.ANNOUNCEMENT;
export const isAnnouncement = (type: number) => type === TYPE.ANNOUNCEMENT;

/** Enlace "Abrir en Discord" (canal, hilo o mensaje). */
export function discordUrl(guildId: string, channelId?: string | null, messageId?: string | null): string {
  if (!channelId) return `https://discord.com/channels/${guildId}`;
  return `https://discord.com/channels/${guildId}/${channelId}${messageId ? `/${messageId}` : ''}`;
}

// ------------------------------------------------------------------------------------- CDN

/**
 * Solo http(s) para href/src que vienen de Discord (embeds, adjuntos). El backend ya los filtra al
 * espejar; esto es la segunda red: React no bloquea `javascript:` en un href.
 */
export function safeHttpUrl(url: string | null | undefined): string | undefined {
  if (typeof url !== 'string') return undefined;
  const u = url.trim();
  return /^https?:\/\//i.test(u) ? u : undefined;
}

export function emojiUrl(id: string, animated: boolean, size = 48): string {
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'webp'}?size=${size}&quality=lossless`;
}

export function stickerUrl(id: string, formatType: number): string | null {
  if (formatType === 3) return null; // Lottie: no se pinta, solo el nombre
  return `https://media.discordapp.net/stickers/${id}.${formatType === 4 ? 'gif' : 'png'}?size=160`;
}

/** Color de rol/embed de Discord (entero RGB) → CSS. Es un DATO de Discord, no un color de roz. */
export function discordColor(n: number | null | undefined): string | null {
  if (!n) return null;
  return `#${n.toString(16).padStart(6, '0')}`;
}

// ------------------------------------------------------------------------------------- compositor

/**
 * Menciones del compositor. En el textarea se ve `@Nombre`, `#canal` y `:emoji:`; al enviar se
 * convierte al formato de Discord (`<@id>`, `<#id>`, `<:nombre:id>`), que es lo que espera la API
 * (contrato §B.4 paso 5).
 */
export interface ComposerToken {
  /** Lo que se ve en el textarea (`@Ana López`, `#general`). */
  label: string;
  /** Lo que viaja a Discord (`<@123>`, `<#456>`). */
  token: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Texto visible → formato de Discord. Las etiquetas más largas primero (`@Ana López` antes que `@Ana`). */
export function encodeComposer(text: string, tokens: ComposerToken[], emojis: { id: string; name: string; animated: boolean }[] = []): string {
  let out = text;
  const sorted = [...tokens].sort((a, b) => b.label.length - a.label.length);
  for (const t of sorted) {
    out = out.replace(new RegExp(`(^|[^\\w<])${escapeRe(t.label)}(?![\\p{L}\\p{N}_])`, 'gu'), (_m, pre: string) => `${pre}${t.token}`);
  }
  if (emojis.length) {
    const byName = new Map(emojis.map((e) => [e.name, e]));
    out = out.replace(/(^|[^<a\w]):([\w~]{2,32}):/g, (m, pre: string, name: string) => {
      const e = byName.get(name);
      return e ? `${pre}<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : m;
    });
  }
  return out;
}

/** Formato de Discord → texto visible (para editar un mensaje propio) + los tokens para re-codificarlo. */
export function decodeComposer(
  content: string,
  names: { user: (id: string) => string | undefined; channel: (id: string) => string | undefined; role: (id: string) => string | undefined },
): { text: string; tokens: ComposerToken[] } {
  const tokens: ComposerToken[] = [];
  const text = content
    .replace(/<@!?(\d{15,25})>/g, (m, id: string) => {
      const n = names.user(id);
      if (!n) return m;
      tokens.push({ label: `@${n}`, token: `<@${id}>` });
      return `@${n}`;
    })
    .replace(/<@&(\d{15,25})>/g, (m, id: string) => {
      const n = names.role(id);
      if (!n) return m;
      tokens.push({ label: `@${n}`, token: `<@&${id}>` });
      return `@${n}`;
    })
    .replace(/<#(\d{15,25})>/g, (m, id: string) => {
      const n = names.channel(id);
      if (!n) return m;
      tokens.push({ label: `#${n}`, token: `<#${id}>` });
      return `#${n}`;
    })
    .replace(/<a?:([\w~]{2,32}):\d{15,25}>/g, (_m, name: string) => `:${name}:`);
  return { text, tokens };
}

/** Consulta de autocompletado bajo el cursor: `@ana`, `#gen`, `:fue`. */
export function triggerAt(text: string, caret: number): { kind: '@' | '#' | ':'; start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)([@#:])([^\s@#:]{0,32})$/u.exec(before);
  if (!m) return null;
  const kind = m[2] as '@' | '#' | ':';
  // `:` necesita al menos 2 letras para no abrir el menú con cada "hora: 10".
  if (kind === ':' && m[3]!.length < 2) return null;
  return { kind, start: caret - m[3]!.length - 1, query: m[3]! };
}

/** Largo máximo del contenido que escribe la persona: 2000 de Discord menos la línea de respuesta. */
export const DISCORD_MAX_CONTENT = 2000;
export const REPLY_PREFIX_RESERVE = 110;

/** Total de adjuntos por envío (contrato §B.4 paso 7): 25 MiB y máximo 10 archivos. */
export const DISCORD_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const DISCORD_MAX_FILES = 10;

// ------------------------------------------------------------------------------------- vistos

const SEEN_KEY = 'roz-discord-seen';

/** Último mensaje visto por canal (este navegador). Sirve para pintar en negritas lo no leído. */
export function loadSeen(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export function saveSeen(seen: Record<string, string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* sin storage: lo no leído vive solo en memoria */
  }
}
