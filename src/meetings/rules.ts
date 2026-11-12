// Reglas puras de las juntas: qué cuenta como duplicado, qué prioridad propone roz, qué modo usa
// "Aceptar" por defecto y el rastro que deja el issue. Sin base ni red (mismo patrón que
// src/tickets/rules.ts), para probarlas solas.
import type { Urgency } from '../assign/policy.js';
import type { LinearPriority, MeetingCandidateKind } from '../types/roz-v2.js';
import { normalizeForMatch } from './quotes.js';

// ---------------------------------------------------------------- duplicados

/**
 * Umbral de la búsqueda híbrida (RRF, k = 60) para llamar "duplicado" a un issue abierto del espejo.
 * 1/(60+r): aparecer 1º en UNA sola lista da 0.0164; en las dos (palabras + vector) entre los
 * primeros ~20 da ≥ 0.025. O sea: con este umbral hace falta que los DOS buscadores coincidan.
 * Umbral inicial: si la bandeja marca de más o de menos, se ajusta aquí (y en el doc del contrato).
 */
export const DUPLICATE_RRF_THRESHOLD = 0.025;
/**
 * Respaldo cuando no hay vectores (el issue o la candidata sin embedding: la búsqueda cae a solo
 * palabras y nunca llega al umbral de arriba): el mejor resultado por palabras cuenta como
 * duplicado si su nombre comparte al menos este tanto de palabras con el título de la candidata
 * (sobre el más corto de los dos) y al menos DUPLICATE_MIN_SHARED palabras.
 */
export const DUPLICATE_TITLE_OVERLAP = 0.6;
export const DUPLICATE_MIN_SHARED = 2;

const STOPWORDS = new Set([
  'para', 'por', 'con', 'sin', 'del', 'las', 'los', 'una', 'uno', 'unos', 'unas', 'que', 'como', 'the', 'and', 'for', 'with',
  'from', 'este', 'esta', 'esto', 'ese', 'esa', 'eso', 'hay', 'mas', 'muy', 'todo', 'toda', 'todos', 'todas',
]);

/** Palabras con contenido (≥ 3 letras, sin acentos ni vacías). */
export function contentWords(s: string): Set<string> {
  return new Set(
    normalizeForMatch(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

export function titleOverlap(a: string, b: string): { ratio: number; shared: number } {
  const x = contentWords(a);
  const y = contentWords(b);
  if (!x.size || !y.size) return { ratio: 0, shared: 0 };
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return { ratio: shared / Math.min(x.size, y.size), shared };
}

export interface DuplicateHit {
  id: string;
  identifier: string;
  name: string;
  status: string;
  linear_id: string | null;
  score: number;
}

/** El duplicado (si lo hay) entre los resultados de search_work_items_hybrid, ya ordenados por score. */
export function pickDuplicate(hits: DuplicateHit[], title: string): DuplicateHit | null {
  const top = hits[0];
  if (!top) return null;
  if (top.score >= DUPLICATE_RRF_THRESHOLD) return top;
  // Sin vector de la candidata (o del issue) la fusión no puede pasar el umbral: respaldo por nombre.
  const o = titleOverlap(title, top.name);
  return o.shared >= DUPLICATE_MIN_SHARED && o.ratio >= DUPLICATE_TITLE_OVERLAP ? top : null;
}

// ---------------------------------------------------------------- prioridad

/** Prioridad de Linear que propone roz desde la urgencia que leyó Jev. Incierta = sin prioridad. */
export function priorityFromUrgency(urgency: Urgency | null | undefined): Exclude<LinearPriority, 0> | null {
  if (urgency === 'urgente') return 1;
  if (urgency === 'no_urgente') return 3;
  return null;
}

/** Prioridad de Linear → la de roz (tarea nativa con el flag apagado). */
export function rozPriorityOf(p: Exclude<LinearPriority, 0> | null): 'urgent' | 'high' | 'medium' | 'low' | null {
  return p === 1 ? 'urgent' : p === 2 ? 'high' : p === 3 ? 'medium' : p === 4 ? 'low' : null;
}

// ---------------------------------------------------------------- aceptar

export type AcceptMode = 'crear' | 'comentar';

/** 'comentar' si la candidata tiene duplicado; si no, 'crear'. Lo que pida la persona gana. */
export function acceptMode(requested: AcceptMode | null | undefined, hasDuplicate: boolean): AcceptMode {
  return requested ?? (hasDuplicate ? 'comentar' : 'crear');
}

/** Solo tareas y compromisos pasan por la bandeja; las decisiones van directo al brain. */
export function inboxKind(kind: MeetingCandidateKind): boolean {
  return kind === 'tarea' || kind === 'compromiso';
}

/** Fecha corta en español para los rastros ("12 nov 2026"). */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Cita en markdown (cada renglón con "> "). */
export function quoteBlock(quote: string): string {
  return quote
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

/** Rastro de la junta al final de una descripción (tarea nativa, flag apagado). */
export function meetingTrail(meeting: { title: string; heldAt: string }, quote: string): string {
  return `---\nDesde la junta «${meeting.title}» (${shortDate(meeting.heldAt)}):\n\n${quoteBlock(quote)}`;
}

/** Comentario en el issue duplicado: qué se volvió a hablar y dónde. */
export function duplicateComment(meeting: { title: string; heldAt: string }, c: { title: string; description: string | null; quote: string }): string {
  const lines = [`Se volvió a hablar de esto en la junta «${meeting.title}» (${shortDate(meeting.heldAt)}).`, '', quoteBlock(c.quote)];
  if (c.description?.trim() && c.description.trim() !== c.title.trim()) lines.push('', c.description.trim());
  return lines.join('\n');
}

/** Cuerpo del átomo del brain de una decisión. */
export function decisionAtomBody(meeting: { title: string; heldAt: string }, d: { title: string; description: string | null; quote: string }): string {
  const parts = [d.description?.trim() || d.title.trim(), '', quoteBlock(d.quote), '', `Decidido en la junta «${meeting.title}» (${shortDate(meeting.heldAt)}).`];
  return parts.join('\n');
}
