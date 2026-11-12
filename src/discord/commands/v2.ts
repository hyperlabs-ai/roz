// Piezas de Components V2 para los mensajes de roz en Discord (contrato:
// docs/discord-commands-contract.md §7.1). Con el flag IS_COMPONENTS_V2 un mensaje no lleva content
// ni embeds: es un Container con TextDisplay (markdown), Section (texto + miniatura o botón),
// Separator y filas de botones. Aquí viven:
//
//   · los constructores (container, section, text, separator, thumbnail, header);
//   · el mapa ÚNICO de estados → emoji de toda la app (STATUS_EMOJI);
//   · los topes de Discord (40 componentes por mensaje contando los anidados, 4000 caracteres de
//     texto en total) y `fitV2`, que recorta con criterio en vez de dejar que Discord rechace todo;
//   · `toV2`, que envuelve un mensaje clásico (texto + filas) en el Container de roz;
//   · `flattenV2` / `v2ToEmbed` (re-exportados de normalize.ts, que se comparte con el puente): lo
//     inverso, para el chat de Discord dentro de roz (espejo y efímeros del compositor), que pinta embeds.
//
// Puro: sin Discord, sin base. No importa respond.ts (respond.ts importa esto).
import type { DiscordApiEmbed } from '../../adapters/discord.js';
import {
  COMPONENT_TYPE,
  type ActionRowComponent,
  type ButtonComponent,
  type ContainerChild,
  type ContainerComponent,
  type MessageComponent,
  type OutgoingMessage,
  type SectionComponent,
  type SeparatorComponent,
  type TextDisplayComponent,
  type ThumbnailComponent,
} from './types.js';

/** Naranja de roz (#ff5b23): acento de TODOS los mensajes. */
export const ROZ_ORANGE = 0xff5b23;

export const V2_LIMITS = {
  /** Componentes por mensaje, contando los anidados (filas, botones, accesorios…). */
  components: 40,
  /** Caracteres de texto sumando todos los TextDisplay. */
  text: 4000,
  sectionTexts: 3,
  thumbnailDescription: 1024,
} as const;

// ================================================================ estados

/**
 * Un solo emoji por tipo de estado en toda la app:
 *   ok    🟢 trabajando / en línea / hecho
 *   wait  🟡 en junta / ocupado / esperando
 *   agent 🟣 el agente está trabajando
 *   bad   🔴 caído / bloqueado / error
 *   off   ⚪ fuera / inactivo / sin datos
 */
export const STATUS_EMOJI = { ok: '🟢', wait: '🟡', agent: '🟣', bad: '🔴', off: '⚪' } as const;
export type Tone = keyof typeof STATUS_EMOJI;

export function dot(tone: Tone): string {
  return STATUS_EMOJI[tone];
}

// ================================================================ constructores

function clipText(text: string, max: number): string {
  const t = text ?? '';
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

export function text(content: string): TextDisplayComponent {
  return { type: COMPONENT_TYPE.TEXT_DISPLAY, content: clipText(content, V2_LIMITS.text) };
}

/** Encabezado: "### Título" y, debajo, una línea tenue con el resumen. */
export function header(title: string, summary?: string | null): TextDisplayComponent {
  return text(`### ${title}${summary ? `\n-# ${summary}` : ''}`);
}

export function separator(opts: { divider?: boolean; large?: boolean } = {}): SeparatorComponent {
  return { type: COMPONENT_TYPE.SEPARATOR, divider: opts.divider ?? true, spacing: opts.large ? 2 : 1 };
}

export function thumbnail(url: string, description?: string | null): ThumbnailComponent {
  return {
    type: COMPONENT_TYPE.THUMBNAIL,
    media: { url },
    ...(description ? { description: clipText(description, V2_LIMITS.thumbnailDescription) } : {}),
  };
}

/** Section: 1-3 textos + accesorio (miniatura o botón). Sin accesorio no existe: usar `sectionOrText`. */
export function section(content: string | string[], accessory: ThumbnailComponent | ButtonComponent): SectionComponent {
  const parts = (Array.isArray(content) ? content : [content]).filter((s) => s && s.trim()).slice(0, V2_LIMITS.sectionTexts);
  return { type: COMPONENT_TYPE.SECTION, components: (parts.length ? parts : ['​']).map(text), accessory };
}

/** Section si hay accesorio; si no (sin foto, sin URL pública), un TextDisplay con el mismo texto. */
export function sectionOrText(content: string, accessory: ThumbnailComponent | ButtonComponent | null): SectionComponent | TextDisplayComponent {
  return accessory ? section(content, accessory) : text(content);
}

/** Miniatura solo con URL http(s) (Discord rechaza el mensaje entero con otra cosa). */
export function maybeThumbnail(url: string | null | undefined, description?: string | null): ThumbnailComponent | null {
  return url && /^https?:\/\//i.test(url) ? thumbnail(url, description) : null;
}

export function container(children: Array<ContainerChild | null | undefined | false>, accent: number = ROZ_ORANGE): ContainerComponent {
  return { type: COMPONENT_TYPE.CONTAINER, accent_color: accent, components: children.filter((c): c is ContainerChild => !!c) };
}

/** Mensaje de un solo Container. */
export function v2Message(children: Array<ContainerChild | null | undefined | false>, extra: Pick<OutgoingMessage, 'mentionUserIds'> = {}): OutgoingMessage {
  return { components: [container(children)], ...extra };
}

/** Aviso corto (error, sin cuenta, "publicado"): emoji + una frase, y opcionalmente botones. */
export function notice(tone: Tone, line: string, detail?: string | null, rows: ActionRowComponent[] = []): OutgoingMessage {
  return v2Message([text(`${dot(tone)} ${line}${detail ? `\n-# ${detail}` : ''}`), ...rows]);
}

/** Hora relativa que Discord pinta en el idioma de quien mira ("hace 3 minutos"). */
export function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

/** Lista "a, b, c, …" que cabe en `max` caracteres (los que no caben se cuentan: "+3"). */
export function joinFit(items: string[], max: number, sep = ', '): string {
  let out = '';
  for (let i = 0; i < items.length; i++) {
    const next = out ? `${out}${sep}${items[i]}` : items[i]!;
    const rest = items.length - i - 1;
    if (next.length + (rest ? ` +${rest}`.length : 0) > max) return `${out}${out ? ' ' : ''}+${items.length - i}`;
    out = next;
  }
  return out;
}

/** Quita lo que rompería el markdown de una línea (saltos, backticks sueltos). */
export function inline(textIn: string | null | undefined, max: number): string {
  return clipText((textIn ?? '').replace(/\s+/g, ' ').replace(/`/g, "'").trim(), max);
}

// ================================================================ conteo y recorte

type AnyComponent = MessageComponent | ContainerChild | ButtonComponent | ThumbnailComponent | { type: number };

function childrenOf(c: AnyComponent): AnyComponent[] {
  const anyC = c as { components?: AnyComponent[]; accessory?: AnyComponent };
  return [...(anyC.components ?? []), ...(anyC.accessory ? [anyC.accessory] : [])];
}

/** Componentes como los cuenta Discord: todos, incluidos los anidados y los accesorios. */
export function countComponents(list: readonly AnyComponent[]): number {
  return list.reduce((n, c) => n + 1 + countComponents(childrenOf(c)), 0);
}

/** Caracteres de texto de todos los TextDisplay. */
export function textLength(list: readonly AnyComponent[]): number {
  return list.reduce(
    (n, c) => n + (c.type === COMPONENT_TYPE.TEXT_DISPLAY ? (c as TextDisplayComponent).content.length : 0) + textLength(childrenOf(c)),
    0,
  );
}

const TRIM_NOTE = '-# …y más en roz (no cabe en un mensaje de Discord).';

/**
 * Hace caber el mensaje en los topes de Discord (40 componentes, 4000 caracteres de texto). Los
 * constructores ya limitan lo suyo; esto es la red de seguridad: quita del final del Container lo que
 * no sea el encabezado ni una fila de botones (los botones se quedan: son la acción) y deja una nota.
 * Si un solo texto es enorme, lo recorta. Devuelve copias: no toca la entrada.
 */
export function fitV2(list: readonly MessageComponent[]): MessageComponent[] {
  const out = structuredClone(list) as MessageComponent[];
  const over = (extraCount: number, extraText: number) =>
    countComponents(out) + extraCount > V2_LIMITS.components || textLength(out) + extraText > V2_LIMITS.text;
  for (const top of out) {
    if (top.type !== COMPONENT_TYPE.CONTAINER) continue;
    const kids = top.components;
    let removed = 0;
    while (over(removed ? 1 : 0, removed ? TRIM_NOTE.length + 1 : 0)) {
      let idx = -1;
      for (let i = kids.length - 1; i > 0; i--) {
        if (kids[i]!.type !== COMPONENT_TYPE.ACTION_ROW) {
          idx = i;
          break;
        }
      }
      if (idx < 0) break;
      kids.splice(idx, 1);
      removed++;
      // Sin separadores colgando al final del contenido.
      while (idx - 1 > 0 && kids[idx - 1]!.type === COMPONENT_TYPE.SEPARATOR && (idx >= kids.length || kids[idx]!.type === COMPONENT_TYPE.ACTION_ROW)) {
        kids.splice(idx - 1, 1);
        idx--;
      }
    }
    if (removed) {
      const firstRow = kids.findIndex((k, i) => i > 0 && k.type === COMPONENT_TYPE.ACTION_ROW);
      kids.splice(firstRow < 0 ? kids.length : firstRow, 0, text(TRIM_NOTE));
    }
  }
  // Último recurso: un texto que solo no cabe se recorta (el más largo primero).
  let excess = textLength(out) - V2_LIMITS.text;
  while (excess > 0) {
    const texts = allTexts(out).sort((a, b) => b.content.length - a.content.length);
    const big = texts[0];
    if (!big || big.content.length <= 1) break;
    big.content = clipText(big.content, Math.max(1, big.content.length - excess));
    excess = textLength(out) - V2_LIMITS.text;
  }
  while (countComponents(out) > V2_LIMITS.components && out.length > 1) out.pop();
  return out;
}

function allTexts(list: readonly AnyComponent[]): TextDisplayComponent[] {
  return list.flatMap((c) => [...(c.type === COMPONENT_TYPE.TEXT_DISPLAY ? [c as TextDisplayComponent] : []), ...allTexts(childrenOf(c))]);
}

// ================================================================ mensaje clásico ↔ V2

/** ¿El mensaje ya viene armado con Components V2 (algo que no es una fila)? */
export function isV2Message(msg: Pick<OutgoingMessage, 'components'>): boolean {
  return (msg.components ?? []).some((c) => c.type !== COMPONENT_TYPE.ACTION_ROW);
}

/** Texto de un embed clásico como markdown (por si algún mensaje todavía trae embeds). */
function embedAsText(e: DiscordApiEmbed): string {
  return [
    e.title ? `**${e.url ? `[${e.title}](${e.url})` : e.title}**` : null,
    e.description ?? null,
    ...(e.fields ?? []).map((f) => `**${f.name}** · ${f.value}`),
    e.footer?.text ? `-# ${e.footer.text}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Lo que se manda a Discord: SIEMPRE un mensaje V2. Si el handler ya armó un Container se usa (con el
 * `content` suelto, si trae, como primer texto del Container: así la nota del status o "Ticket creado"
 * no se pierden). Si es clásico (texto, embeds, filas), se envuelve en el Container de roz.
 */
export function toV2(msg: OutgoingMessage): MessageComponent[] {
  const lead = msg.content?.trim() ? text(msg.content.trim()) : null;
  if (isV2Message(msg)) {
    const list = structuredClone(msg.components ?? []) as MessageComponent[];
    if (lead) {
      const first = list.find((c): c is ContainerComponent => c.type === COMPONENT_TYPE.CONTAINER);
      if (first) first.components.unshift(lead);
      else list.unshift(lead);
    }
    return list;
  }
  const children: ContainerChild[] = [];
  if (lead) children.push(lead);
  for (const e of msg.embeds ?? []) {
    const body = embedAsText(e);
    if (body) children.push(text(body));
  }
  for (const c of msg.components ?? []) if (c.type === COMPONENT_TYPE.ACTION_ROW) children.push(c);
  if (!children.length) children.push(text('​'));
  return [container(children)];
}

/** Aplanar un mensaje V2 (texto, miniatura, enlaces) vive en normalize.ts: el puente también lo usa. */
export { flattenComponents as flattenV2, componentsToEmbed as v2ToEmbed, type FlatComponents as FlatV2 } from '../normalize.js';
