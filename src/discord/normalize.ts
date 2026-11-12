// Mensaje de la API de Discord (JSON crudo, snake_case) → fila de roz.discord_message. Puro.
//
// Lo usan los DOS escritores de la tabla, y por eso vive en un solo lugar:
//   · roz, con la respuesta de executeWebhook(wait=true) al enviar desde el dashboard;
//   · el puente, con el payload crudo del gateway (MESSAGE_CREATE/UPDATE traen la misma forma que la
//     REST; con discord.js se toma de `client.on('raw')` o de `message.toJSON()` no: ese es camelCase).
//
// NUNCA produce dev_id ni client_nonce: esos solo los escribe roz (ver "eco" en el contrato §D).
import type {
  DiscordApiAttachment,
  DiscordApiEmbed,
  DiscordApiMessage,
  DiscordApiReaction,
} from '../adapters/discord.js';
import type { DiscordAttachment, DiscordEmbed, DiscordMessageRow, DiscordReaction } from '../types/discord.js';
import { parseReplyPrefix } from './reply.js';

// ---------------------------------------------------------------- Components V2 → texto/embed
// Las fichas de roz salen en Components V2 (src/discord/commands/v2.ts): sin content ni embeds. Aquí
// se aplanan (sin imports: este archivo se copia al puente) para el espejo y para buscar IDs en ellas.

const COMPONENTS_V2 = 1 << 15;
const T_BUTTON = 2;
const T_TEXT_DISPLAY = 10;
const T_THUMBNAIL = 11;
const T_CONTAINER = 17;
const LINK_STYLE = 5;
const ROZ_ORANGE = 0xff5b23;

export interface FlatComponents {
  /** Markdown de los TextDisplay en orden (un bloque por componente). */
  text: string;
  /** Primera miniatura (foto del responsable/persona). */
  thumbnailUrl: string | null;
  accent: number | null;
  /** Botones de enlace (http/https). */
  links: { label: string; url: string }[];
}

/** Aplana componentes (V2 o filas). Tolera formas desconocidas. */
export function flattenComponents(list: readonly unknown[] | null | undefined): FlatComponents {
  const texts: string[] = [];
  const links: { label: string; url: string }[] = [];
  let thumbnailUrl: string | null = null;
  let accent: number | null = null;
  const visit = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const c = raw as {
      type?: number;
      content?: unknown;
      accent_color?: unknown;
      media?: { url?: unknown };
      style?: number;
      url?: unknown;
      label?: unknown;
      components?: unknown[];
      accessory?: unknown;
    };
    if (c.type === T_TEXT_DISPLAY && typeof c.content === 'string') texts.push(c.content);
    if (c.type === T_CONTAINER && typeof c.accent_color === 'number' && accent === null) accent = c.accent_color;
    if (c.type === T_THUMBNAIL && typeof c.media?.url === 'string' && !thumbnailUrl) thumbnailUrl = c.media.url;
    if (c.type === T_BUTTON && c.style === LINK_STYLE && typeof c.url === 'string' && /^https?:\/\//i.test(c.url)) {
      links.push({ label: typeof c.label === 'string' ? c.label : 'Abrir', url: c.url });
    }
    for (const child of Array.isArray(c.components) ? c.components : []) visit(child);
    if (c.accessory) visit(c.accessory);
  };
  for (const c of list ?? []) visit(c);
  return { text: texts.join('\n\n'), thumbnailUrl, accent, links };
}

function clipTo(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Un mensaje V2 como UN embed clásico ("### Título" → título; "-# " tenue → texto normal). */
export function componentsToEmbed(list: readonly unknown[] | null | undefined): DiscordApiEmbed | null {
  const flat = flattenComponents(list);
  if (!flat.text.trim()) return null;
  const lines = flat.text.split('\n');
  const head = /^#{1,3}\s+(.+)$/.exec(lines[0] ?? '');
  const body = (head ? lines.slice(1) : lines).map((l) => {
    const h = /^#{1,3}\s+(.+)$/.exec(l);
    return h ? `**${h[1]}**` : l.replace(/^-#\s+/, '');
  });
  const embed: DiscordApiEmbed = { type: 'rich', color: flat.accent ?? ROZ_ORANGE };
  if (head) embed.title = clipTo(head[1]!, 256);
  const description = body.join('\n').trim();
  if (description) embed.description = clipTo(description, 4096);
  if (flat.thumbnailUrl) embed.thumbnail = { url: flat.thumbnailUrl };
  return embed;
}

/**
 * Embeds para el espejo. Un mensaje en Components V2 (las fichas de roz) no trae embeds: su texto se
 * aplana en UN embed para que el chat de Discord dentro de roz lo pinte igual que antes.
 */
function mirrorEmbeds(m: DiscordApiMessage): DiscordEmbed[] {
  const embeds = (m.embeds ?? []).map(normalizeEmbed);
  if (!embeds.length && ((m.flags ?? 0) & COMPONENTS_V2) !== 0) {
    const flat = componentsToEmbed(m.components);
    if (flat) embeds.push(normalizeEmbed(flat));
  }
  return embeds;
}

/** Columnas que escribe el puente (y roz al enviar) — todo menos dev_id/client_nonce/synced_at. */
export type DiscordMessageMirrorFields = Omit<DiscordMessageRow, 'dev_id' | 'client_nonce' | 'synced_at'>;

/** Tipo 19 = REPLY; message_reference.type 0 = respuesta (1 sería reenvío). */
const MESSAGE_TYPE_REPLY = 19;

export function normalizeAttachment(a: DiscordApiAttachment): DiscordAttachment {
  return {
    id: a.id,
    filename: a.filename,
    contentType: a.content_type ?? null,
    size: a.size,
    url: a.url,
    proxyUrl: a.proxy_url ?? null,
    width: a.width ?? null,
    height: a.height ?? null,
    description: a.description ?? null,
    durationSecs: a.duration_secs ?? null,
    spoiler: a.filename.startsWith('SPOILER_'),
  };
}

/**
 * Solo URLs http(s). Los embeds los arma quien manda el mensaje (bots, webhooks); el front los pinta
 * como href/src, y un `javascript:` ahí sería XSS en roz. Lo demás se descarta (null).
 */
export function safeUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  return /^https?:\/\//i.test(u) ? u : null;
}

function media(m: { url?: string; width?: number; height?: number } | undefined) {
  const url = safeUrl(m?.url);
  if (!url) return null;
  return { url, width: m?.width ?? null, height: m?.height ?? null };
}

export function normalizeEmbed(e: DiscordApiEmbed): DiscordEmbed {
  return {
    type: e.type ?? null,
    title: e.title ?? null,
    description: e.description ?? null,
    url: safeUrl(e.url),
    color: e.color ?? null,
    timestamp: e.timestamp ?? null,
    author: e.author ? { name: e.author.name, url: safeUrl(e.author.url), iconUrl: safeUrl(e.author.icon_url) } : null,
    footer: e.footer ? { text: e.footer.text, iconUrl: safeUrl(e.footer.icon_url) } : null,
    image: media(e.image),
    thumbnail: media(e.thumbnail),
    video: media(e.video),
    provider: e.provider ? { name: e.provider.name ?? null, url: safeUrl(e.provider.url) } : null,
    fields: (e.fields ?? []).map((f) => ({ name: f.name, value: f.value, inline: f.inline ?? false })),
  };
}

export function normalizeReaction(r: DiscordApiReaction, userIds: string[] = []): DiscordReaction {
  return {
    emoji: { id: r.emoji.id ?? null, name: r.emoji.name ?? null, animated: r.emoji.animated ?? false },
    count: r.count,
    burstCount: r.count_details?.burst ?? 0,
    userIds,
  };
}

/** A qué mensaje responde: referencia nativa, o la línea de respuesta de roz en mensajes de webhook. */
export function replyTargetOf(
  m: Pick<DiscordApiMessage, 'type' | 'message_reference' | 'webhook_id' | 'content'> & { channel_id?: string },
): string | null {
  const ref = m.message_reference;
  if (m.type === MESSAGE_TYPE_REPLY && ref?.message_id && (ref.type ?? 0) === 0) return ref.message_id;
  if (m.webhook_id) {
    // La línea de respuesta es texto: cualquiera que escriba por un webhook (incluido un dev desde
    // roz) puede inventarla. Solo cuenta si apunta a un mensaje del MISMO canal; si no, la cita
    // filtraría el texto de un canal que quien lee no ve.
    const reply = parseReplyPrefix(m.content ?? '').replyTo;
    if (!reply) return null;
    if (m.channel_id && reply.channelId !== m.channel_id) return null;
    return reply.messageId;
  }
  return null;
}

export function normalizeApiMessage(m: DiscordApiMessage, guildId: string): DiscordMessageMirrorFields {
  return {
    id: m.id,
    guild_id: m.guild_id ?? guildId,
    channel_id: m.channel_id,
    type: m.type ?? 0,
    author_id: m.author.id,
    author_username: m.author.username ?? '',
    author_global_name: m.author.global_name ?? null,
    author_avatar: m.author.avatar ?? null,
    author_bot: m.author.bot ?? false,
    webhook_id: m.webhook_id ?? null,
    content: m.content ?? '',
    attachments: (m.attachments ?? []).map(normalizeAttachment),
    embeds: mirrorEmbeds(m),
    stickers: (m.sticker_items ?? []).map((s) => ({ id: s.id, name: s.name, formatType: s.format_type })),
    mentions: (m.mentions ?? []).map((u) => ({ id: u.id, username: u.username, globalName: u.global_name ?? null })),
    mention_roles: m.mention_roles ?? [],
    mention_everyone: m.mention_everyone ?? false,
    reactions: (m.reactions ?? []).map((r) => normalizeReaction(r)),
    reply_to_id: replyTargetOf(m),
    thread_id: m.thread?.id ?? null,
    flags: m.flags ?? 0,
    pinned: m.pinned ?? false,
    created_at: m.timestamp,
    edited_at: m.edited_timestamp ?? null,
    deleted_at: null,
  };
}
