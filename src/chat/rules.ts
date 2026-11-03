// Reglas del chat que no dependen de la base: nombres de canal, llave de MD y a quién le llega un
// push. Viven aparte para probarlas sin dobles de Supabase.
import { ValidationError } from '../utils/errors.js';

export type ConversationKind = 'channel' | 'dm';
export type NotifyLevel = 'all' | 'mentions' | 'none';

/** Nivel de aviso al unirse: un MD es una conversación directa (todo avisa); un canal, solo menciones. */
export function defaultNotifyLevel(kind: ConversationKind): NotifyLevel {
  return kind === 'dm' ? 'all' : 'mentions';
}

/**
 * Nombre de canal normalizado: minúsculas, sin espacios ni símbolos (guiones en su lugar), como en
 * Slack. Se conservan acentos y ñ porque el equipo escribe en español. Lanza si queda vacío.
 */
export function channelSlug(raw: string): string {
  const slug = raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9áéíóúüñ-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  if (!slug) throw new ValidationError('el nombre del canal no puede quedar vacío');
  return slug;
}

/** Llave única de un MD: los ids de sus miembros, sin repetir y ordenados. Mismo grupo → misma llave. */
export function dmKey(devIds: string[]): string {
  return [...new Set(devIds.map((d) => d.toLowerCase()))].sort().join(',');
}

export interface PushCandidate {
  devId: string;
  notifyLevel: NotifyLevel;
}

export interface PushContext {
  kind: ConversationKind;
  authorDevId: string;
  members: PushCandidate[];
  /** Devs mencionados con <@id>. */
  mentions: string[];
  /** El mensaje usa <!canal>. */
  mentionChannel: boolean;
  /** Es una respuesta en hilo (no un mensaje del canal). */
  isReply: boolean;
  /** Si es respuesta: quien escribió el raíz y quienes ya respondieron en ese hilo. */
  threadParticipants?: string[];
}

/**
 * A quién le llega push por un mensaje nuevo:
 *   · nunca al autor, y nunca a quien silenció la conversación ('none');
 *   · MD: a todos los demás miembros;
 *   · canal, mensaje raíz: 'all' → siempre; 'mentions' → solo si lo mencionan o hay @canal;
 *   · canal, respuesta en hilo: a quienes participan en el hilo y a los mencionados. El nivel 'all'
 *     NO incluye los hilos ajenos (sería ruido de conversaciones en las que la persona no está), y
 *     @canal en un hilo tampoco despierta al canal entero.
 * Solo se consideran miembros: mencionar a alguien fuera de un canal no le da acceso a leerlo.
 */
export function chatPushRecipients(ctx: PushContext): string[] {
  const mentioned = new Set(ctx.mentions.map((m) => m.toLowerCase()));
  const participants = new Set((ctx.threadParticipants ?? []).map((p) => p.toLowerCase()));
  const author = ctx.authorDevId.toLowerCase();
  const out: string[] = [];

  for (const m of ctx.members) {
    const id = m.devId.toLowerCase();
    if (id === author || m.notifyLevel === 'none') continue;

    let notify: boolean;
    if (ctx.kind === 'dm') {
      notify = true;
    } else if (ctx.isReply) {
      // @canal dentro de un hilo no despierta al canal entero (igual que en los no leídos, que
      // solo cuentan @canal en mensajes raíz): avisa a quienes ya están en el hilo.
      notify = participants.has(id) || mentioned.has(id);
    } else {
      notify = m.notifyLevel === 'all' || mentioned.has(id) || ctx.mentionChannel;
    }
    if (notify && !out.includes(m.devId)) out.push(m.devId);
  }
  return out;
}

// ---- Búsqueda de tareas para citar (`@tarea <persona> <texto>`) ----

const foldText = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
/** Quita lo que rompe un filtro `or(...)` de PostgREST y los `@`/`#` que la gente antepone
 *  ("@tarea @Crix login" es tan válido como "@tarea crix login"). */
const sanitizeWord = (w: string) => w.replace(/[%,()*\\"'.:@#]/g, '').slice(0, 40);

/**
 * Separa la consulta en personas y texto: cada palabra que es el inicio de una parte del nombre de
 * un dev filtra por responsable (con o sin `@`); el resto se busca en el nombre / identificador de
 * la tarea. `empty` = no se escribió nada (entonces se listan las tareas abiertas de quien busca).
 */
export function splitTaskQuery(
  raw: string,
  devs: { id: string; name: string }[],
): { devIds: string[]; textWords: string[]; empty: boolean } {
  const words = raw.trim().split(/\s+/).map(sanitizeWord).filter(Boolean).slice(0, 6);
  const names = devs.map((d) => ({ id: d.id, parts: foldText(d.name).split(/\s+/) }));
  const devIds = new Set<string>();
  const textWords: string[] = [];
  for (const w of words) {
    const f = foldText(w);
    const hits = f.length >= 2 ? names.filter((n) => n.parts.some((part) => part.startsWith(f))) : [];
    if (hits.length) hits.forEach((h) => devIds.add(h.id));
    else textWords.push(w);
  }
  return { devIds: [...devIds], textWords, empty: words.length === 0 };
}
