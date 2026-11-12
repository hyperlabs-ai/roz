// Markdown de Discord → árbol PURO (sin React, sin HTML). El render (components/discord/DiscordMarkdown)
// recorre este árbol y pinta nodos de React: nunca se inyecta HTML, así que no hay XSS posible.
//
// Cubre lo que Discord pinta en un mensaje:
//   bloques: ```código```, > cita, >>> cita hasta el final, # / ## / ### encabezados, -# subtexto,
//            listas (- * 1.)
//   en línea: **negritas**, *cursivas* / _cursivas_, __subrayado__, ~~tachado~~, ||spoiler||,
//            `código`, [texto](url), enlaces sueltos, <https://…> (sin vista previa),
//            <@id> / <@!id> usuario, <@&id> rol, <#id> canal, <:nombre:id> / <a:nombre:id> emoji
//            propio, <t:unix:estilo> fecha, @everyone / @here, y referencias a tareas (HYP-12, ROZ-123).

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'u' | 's' | 'spoiler'; c: MdInline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: MdInline[] }
  | { t: 'user'; id: string }
  | { t: 'role'; id: string }
  | { t: 'channel'; id: string }
  | { t: 'emoji'; id: string; name: string; animated: boolean }
  | { t: 'everyone'; v: '@everyone' | '@here' }
  | { t: 'time'; unix: number; style: string }
  | { t: 'task'; identifier: string; raw: string }
  | { t: 'br' };

export type MdBlock =
  | { t: 'p'; c: MdInline[] }
  | { t: 'h'; level: 1 | 2 | 3; c: MdInline[] }
  | { t: 'sub'; c: MdInline[] }
  | { t: 'quote'; c: MdBlock[] }
  | { t: 'codeblock'; lang: string | null; v: string }
  | { t: 'list'; ordered: boolean; start: number; items: MdInline[][] };

// ------------------------------------------------------------------------------------- en línea

const SAFE_URL = /^https?:\/\//i;

interface Rule {
  re: RegExp;
  /** Si devuelve null, la regla no aplica (se prueba la siguiente). */
  build: (m: RegExpExecArray, prev: string) => MdInline | null;
}

const WORD = /[\p{L}\p{N}_]/u;

const RULES: Rule[] = [
  // Escape: \* \_ \` … se pintan tal cual.
  { re: /^\\([^\p{L}\p{N}\s])/u, build: (m) => ({ t: 'text', v: m[1]! }) },
  // Código en línea: `x`, ``x``.
  {
    re: /^(`+)([\s\S]*?[^`])\1(?!`)/,
    build: (m) => ({ t: 'code', v: m[2]!.replace(/^ (.*) $/s, '$1') }),
  },
  { re: /^\|\|([\s\S]+?)\|\|/, build: (m) => ({ t: 'spoiler', c: parseInline(m[1]!) }) },
  { re: /^\*\*([\s\S]+?)\*\*(?!\*)/, build: (m) => ({ t: 'strong', c: parseInline(m[1]!) }) },
  { re: /^__([\s\S]+?)__(?!_)/, build: (m) => ({ t: 'u', c: parseInline(m[1]!) }) },
  { re: /^~~([\s\S]+?)~~/, build: (m) => ({ t: 's', c: parseInline(m[1]!) }) },
  { re: /^\*(?=\S)([\s\S]*?\S)\*(?!\*)/, build: (m) => ({ t: 'em', c: parseInline(m[1]!) }) },
  {
    // _cursiva_ solo entre límites de palabra (snake_case no es cursiva).
    re: /^_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}_])/u,
    build: (m, prev) => (prev && WORD.test(prev) ? null : { t: 'em', c: parseInline(m[1]!) }),
  },
  { re: /^<@!?(\d{15,25})>/, build: (m) => ({ t: 'user', id: m[1]! }) },
  { re: /^<@&(\d{15,25})>/, build: (m) => ({ t: 'role', id: m[1]! }) },
  { re: /^<#(\d{15,25})>/, build: (m) => ({ t: 'channel', id: m[1]! }) },
  {
    re: /^<(a?):([\w~]{1,64}):(\d{15,25})>/,
    build: (m) => ({ t: 'emoji', animated: m[1] === 'a', name: m[2]!, id: m[3]! }),
  },
  {
    re: /^<t:(-?\d{1,13})(?::([tTdDfFR]))?>/,
    build: (m) => ({ t: 'time', unix: Number(m[1]), style: m[2] ?? 'f' }),
  },
  // <https://…>: enlace sin vista previa.
  { re: /^<(https?:\/\/[^\s>]+)>/, build: (m) => ({ t: 'link', href: m[1]!, c: [{ t: 'text', v: m[1]! }] }) },
  {
    // [texto](url) — solo http(s); el texto no puede ser otro enlace.
    re: /^\[([^\]\n]{1,256})\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/,
    build: (m) => (SAFE_URL.test(m[2]!) ? { t: 'link', href: m[2]!, c: parseInline(m[1]!) } : null),
  },
  {
    re: /^https?:\/\/[^\s<]+[^<.,:;"'!?)\]\s]/,
    build: (m, prev) => (prev && WORD.test(prev) ? null : { t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] }),
  },
  { re: /^@(everyone|here)\b/, build: (m) => ({ t: 'everyone', v: `@${m[1]}` as '@everyone' | '@here' }) },
  {
    // Tareas: HYP-12 de Linear o ROZ-123 viejos, con o sin '#'. El render decide si es una ficha
    // (está en message.tasks) o texto normal.
    re: /^#?([A-Z][A-Z0-9]{1,9}-\d{1,6})(?![\p{L}\p{N}_-])/u,
    build: (m, prev) => (prev && WORD.test(prev) ? null : { t: 'task', identifier: m[1]!, raw: m[0] }),
  },
];

/** Caracteres que pueden empezar una regla: todo lo demás se acumula como texto de un tirón. */
const TRIGGER = /[\\`|*_~<[h@#A-Z\n]/;

function pushText(out: MdInline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === 'text') last.v += v;
  else out.push({ t: 'text', v });
}

export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\n') {
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (TRIGGER.test(ch)) {
      const rest = src.slice(i);
      const prev = i > 0 ? src[i - 1]! : '';
      let matched = false;
      for (const rule of RULES) {
        const m = rule.re.exec(rest);
        if (!m) continue;
        const node = rule.build(m, prev);
        if (!node) continue;
        if (node.t === 'text') pushText(out, node.v);
        else out.push(node);
        i += m[0].length;
        matched = true;
        break;
      }
      if (matched) continue;
    }
    pushText(out, ch);
    i++;
  }
  return out;
}

// ------------------------------------------------------------------------------------- bloques

const FENCE_RE = /```(?:([\w+#.-]{1,20})\n)?([\s\S]*?)```/g;
const QUOTE_RE = /^> ?(.*)$/;
const HEADING_RE = /^(#{1,3}) +(.+)$/;
const SUB_RE = /^-# +(.+)$/;
const LIST_RE = /^ {0,3}([-*]|\d{1,3}\.) +(.*)$/;

function parseLines(text: string, allowQuote: boolean): MdBlock[] {
  const lines = text.split('\n');
  const out: MdBlock[] = [];
  let para: string[] = [];

  const flush = () => {
    // Discord respeta las líneas vacías; solo se recortan las de los extremos del párrafo.
    while (para.length && !para[0]!.trim()) para.shift();
    while (para.length && !para[para.length - 1]!.trim()) para.pop();
    if (para.length) out.push({ t: 'p', c: parseInline(para.join('\n')) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (allowQuote && line.startsWith('>>> ')) {
      flush();
      const rest = [line.slice(4), ...lines.slice(i + 1)].join('\n');
      out.push({ t: 'quote', c: parseLines(rest, false) });
      break;
    }
    if (allowQuote && QUOTE_RE.test(line) && (line.startsWith('> ') || line === '>')) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && (lines[i]!.startsWith('> ') || lines[i] === '>')) {
        quoted.push(QUOTE_RE.exec(lines[i]!)![1] ?? '');
        i++;
      }
      i--;
      out.push({ t: 'quote', c: parseLines(quoted.join('\n'), false) });
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      flush();
      out.push({ t: 'h', level: h[1]!.length as 1 | 2 | 3, c: parseInline(h[2]!) });
      continue;
    }
    const sub = SUB_RE.exec(line);
    if (sub) {
      flush();
      out.push({ t: 'sub', c: parseInline(sub[1]!) });
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]![0]!);
      const items: MdInline[][] = [];
      const start = ordered ? Number.parseInt(li[1]!, 10) : 1;
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]!);
        if (!m || /\d/.test(m[1]![0]!) !== ordered) break;
        items.push(parseInline(m[2]!));
        i++;
      }
      i--;
      out.push({ t: 'list', ordered, start, items });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

/** Árbol de bloques de un mensaje de Discord. */
export function parseDiscordMarkdown(content: string): MdBlock[] {
  const out: MdBlock[] = [];
  let last = 0;
  FENCE_RE.lastIndex = 0;
  for (let m = FENCE_RE.exec(content); m; m = FENCE_RE.exec(content)) {
    // ```una línea``` sin salto: Discord lo pinta como bloque igual.
    if (m.index > last) out.push(...parseLines(content.slice(last, m.index).replace(/\n$/, ''), true));
    out.push({ t: 'codeblock', lang: m[1] ?? null, v: m[2]!.replace(/\n$/, '') });
    last = m.index + m[0].length;
    if (content[last] === '\n') last++;
  }
  if (last < content.length) out.push(...parseLines(content.slice(last), true));
  return out;
}

// ------------------------------------------------------------------------------------- utilidades

const PICTO = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const PICTO_ONLY = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|‍|️|\s)+$/u;

/**
 * Un mensaje hecho SOLO de emojis (hasta 30) se pinta grande, como en Discord.
 */
export function isEmojiOnly(blocks: MdBlock[]): boolean {
  if (blocks.length !== 1 || blocks[0]!.t !== 'p') return false;
  let count = 0;
  for (const n of blocks[0]!.c) {
    if (n.t === 'emoji') count++;
    else if (n.t === 'text') {
      if (!n.v.trim()) continue;
      if (!PICTO_ONLY.test(n.v)) return false;
      count += [...n.v].filter((c) => PICTO.test(c)).length;
    } else if (n.t !== 'br') return false;
  }
  return count > 0 && count <= 30;
}

/** Texto plano de un mensaje (para nombres de tarea y extractos): sin marcas de markdown. */
export function plainText(content: string, resolve?: { user?: (id: string) => string; channel?: (id: string) => string; role?: (id: string) => string }): string {
  const walk = (nodes: MdInline[]): string =>
    nodes
      .map((n) => {
        switch (n.t) {
          case 'text':
            return n.v;
          case 'code':
            return n.v;
          case 'br':
            return '\n';
          case 'user':
            return `@${resolve?.user?.(n.id) ?? 'usuario'}`;
          case 'role':
            return `@${resolve?.role?.(n.id) ?? 'rol'}`;
          case 'channel':
            return `#${resolve?.channel?.(n.id) ?? 'canal'}`;
          case 'emoji':
            return `:${n.name}:`;
          case 'everyone':
            return n.v;
          case 'time':
            return formatDiscordTime(n.unix, n.style);
          case 'task':
            return n.identifier;
          case 'link':
            return walk(n.c);
          default:
            return walk(n.c);
        }
      })
      .join('');
  const blocks = parseDiscordMarkdown(content);
  const lines: string[] = [];
  const visit = (b: MdBlock) => {
    if (b.t === 'codeblock') lines.push(b.v);
    else if (b.t === 'quote') b.c.forEach(visit);
    else if (b.t === 'list') b.items.forEach((it) => lines.push(walk(it)));
    else lines.push(walk(b.c));
  };
  blocks.forEach(visit);
  return lines.join('\n').trim();
}

const RELATIVE = new Intl.RelativeTimeFormat('es-MX', { numeric: 'auto' });

/** `<t:unix:estilo>` como lo pinta Discord, en español. */
export function formatDiscordTime(unix: number, style: string, now = Date.now()): string {
  const d = new Date(unix * 1000);
  if (Number.isNaN(d.getTime())) return String(unix);
  switch (style) {
    case 't':
      return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    case 'T':
      return d.toLocaleTimeString('es-MX');
    case 'd':
      return d.toLocaleDateString('es-MX');
    case 'D':
      return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
    case 'F':
      return d.toLocaleString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    case 'R': {
      const diff = (d.getTime() - now) / 1000;
      const abs = Math.abs(diff);
      if (abs < 60) return RELATIVE.format(Math.round(diff), 'second');
      if (abs < 3600) return RELATIVE.format(Math.round(diff / 60), 'minute');
      if (abs < 86_400) return RELATIVE.format(Math.round(diff / 3600), 'hour');
      if (abs < 2_592_000) return RELATIVE.format(Math.round(diff / 86_400), 'day');
      if (abs < 31_536_000) return RELATIVE.format(Math.round(diff / 2_592_000), 'month');
      return RELATIVE.format(Math.round(diff / 31_536_000), 'year');
    }
    default:
      return d.toLocaleString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
}
