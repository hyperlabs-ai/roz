// Utilidades PURAS del chat (texto, menciones, agrupado, fechas, borradores). Sin React ni red:
// las prueba test/chat-web.test.ts. `lib/chat.ts` las re-exporta junto con la API.
import type { ChatConversation, ChatMessage } from './chat';

// ---- Menciones ----
//
// En el compositor se escribe `@Nombre Apellido` (lo inserta el autocompletado); al enviar se
// guarda como `<@devId>` para que un cambio de nombre no rompa mensajes viejos. `@canal` ↔ `<!canal>`.

export const CHANNEL_TOKEN = '<!canal>';
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const TOKEN_RE = new RegExp(`<@(${UUID})>|<!canal>`, 'g');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Texto del compositor → cuerpo con tokens. Nombres más largos primero (no partir "Ana María" en "Ana"). */
export function encodeMentions(text: string, devs: { id: string; name: string }[]): string {
  let out = text.replace(/(^|[^\p{L}\p{N}_])@canal(?![\p{L}\p{N}_])/giu, `$1${CHANNEL_TOKEN}`);
  const sorted = [...devs].filter((d) => d.name.trim()).sort((a, b) => b.name.length - a.name.length);
  for (const d of sorted) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_<])@${escapeRe(d.name.trim())}(?![\\p{L}\\p{N}_])`, 'giu');
    out = out.replace(re, `$1<@${d.id}>`);
  }
  return out;
}

/** Cuerpo con tokens → texto editable (para editar un mensaje). */
export function decodeMentions(body: string, nameOf: (id: string) => string | undefined): string {
  return body.replace(TOKEN_RE, (_tok, id?: string) => (id ? `@${nameOf(id.toLowerCase()) ?? 'alguien'}` : '@canal'));
}

/** Cuerpo con tokens → markdown con enlaces `#mention-<id>` que el render convierte en píldoras. */
export function mentionsToMarkdown(body: string, nameOf: (id: string) => string | undefined): string {
  return body.replace(TOKEN_RE, (_tok, id?: string) => {
    if (!id) return '[@canal](#mention-canal)';
    const name = (nameOf(id.toLowerCase()) ?? 'alguien').replace(/[[\]]/g, '');
    return `[@${name}](#mention-${id.toLowerCase()})`;
  });
}

// ---- Citas de tareas ----
//
// En el texto una tarea se cita con su identificador: `#ROZ-12`. El compositor lo inserta desde el
// autocompletado `@tarea <persona> <texto>`; el backend resuelve la tarjeta al leer (misma regex que
// src/chat/text.ts). El `#` va pegado: `# Título` sigue siendo un título de markdown.

const TASK_REF_RE = /(^|[^\w#/-])#([A-Za-z][A-Za-z0-9_]*-\d+)(?![\w-])/g;

/** Cuerpo → markdown con las citas CONOCIDAS como enlaces `#task-<id>` (el render las vuelve fichas). */
export function taskRefsToMarkdown(body: string, known: Map<string, string>): string {
  if (!known.size) return body;
  return body.replace(TASK_REF_RE, (whole, pre: string, ident: string) => {
    const id = known.get(ident.toUpperCase());
    return id ? `${pre}[#${ident.toUpperCase()}](#task-${id})` : whole;
  });
}

/**
 * ¿Hay una cita de tarea abierta bajo el cursor? `@tarea` seguido (o no) de lo que se busca:
 * personas y/o palabras del nombre ("@tarea crix cronograma"). null = no.
 */
export function taskQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])@tarea(?:[ \t]+([^\n@#]*))?$/iu.exec(before);
  if (!m) return null;
  const start = m.index + m[1]!.length;
  return { start, query: (m[2] ?? '').trimStart() };
}

/** ¿El mensaje me menciona (directo o con @canal)? */
export function mentionsMe(m: Pick<ChatMessage, 'mentions' | 'mentionChannel'>, myDevId: string | null | undefined): boolean {
  if (!myDevId) return false;
  return m.mentionChannel || m.mentions.some((id) => id.toLowerCase() === myDevId.toLowerCase());
}

/**
 * Consulta de autocompletado bajo el cursor: el texto después de una `@` que empieza palabra.
 * Admite un espacio ("@Carmen V") para buscar por nombre y apellido. null = no hay mención abierta.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])@([\p{L}\p{N}._-]*(?: [\p{L}\p{N}._-]*)?)$/u.exec(before);
  if (!m) return null;
  const query = m[2] ?? '';
  if (query.endsWith(' ') && query.trim().includes(' ')) return null;
  return { start: before.length - query.length - 1, query };
}

/** Comparación sin acentos ni mayúsculas, para buscar personas. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

// ---- Agrupado y fechas ----

const GROUP_WINDOW_MS = 5 * 60_000;

function sameLocalDay(a: string, b: string): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** ¿`cur` va pegado a `prev` (sin avatar ni nombre), como en Slack? Mismo autor, mismo día, < 5 min. */
export function continuesGroup(prev: ChatMessage | undefined, cur: ChatMessage): boolean {
  if (!prev || prev.kind !== 'user' || cur.kind !== 'user') return false;
  if (!prev.authorDevId || prev.authorDevId !== cur.authorDevId) return false;
  if (prev.deletedAt || prev.replyCount > 0) return false;
  if (!sameLocalDay(prev.createdAt, cur.createdAt)) return false;
  return new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
}

/** ¿Hay que pintar el separador de día antes de `cur`? */
export function startsDay(prev: ChatMessage | undefined, cur: ChatMessage): boolean {
  return !prev || !sameLocalDay(prev.createdAt, cur.createdAt);
}

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "Hoy", "Ayer" o "lunes 3 de noviembre" (con año si no es el actual). */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  const base = `${WEEKDAYS[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} de ${d.getFullYear()}`;
}

export function timeLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Nombre visible de una conversación: el canal, o las otras personas del MD. */
export function conversationTitle(c: ChatConversation, nameOf: (id: string) => string | undefined, me: string | null | undefined): string {
  if (c.kind === 'channel') return c.name ?? 'canal';
  const others = c.memberIds.filter((id) => id !== me);
  if (!others.length) return `${nameOf(me ?? '') ?? 'Tú'} (tú)`;
  return others.map((id) => nameOf(id) ?? 'Alguien').join(', ');
}

/** Badge del nav: MDs sin leer + menciones; `dot` si solo hay canales con actividad. */
export function chatBadge(conversations: ChatConversation[]): { count: number; dot: boolean } {
  let count = 0;
  let dot = false;
  for (const c of conversations) {
    // Sin membresía (canal público que solo se lee) o silenciada: no suma ni prende nada.
    if (!c.membership || c.membership.notifyLevel === 'none') continue;
    if (c.kind === 'dm') count += c.unread;
    else {
      count += c.mentions;
      if (c.unread > 0) dot = true;
    }
  }
  return { count, dot: dot && count === 0 };
}

export function newNonce(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

// ---- Borradores (por conversación / hilo, en este navegador) ----

const DRAFT_PREFIX = 'roz-chat-draft:';

export function loadDraft(key: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(key: string, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(DRAFT_PREFIX + key, text);
    else localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    /* sin storage: el borrador vive solo en memoria */
  }
}
