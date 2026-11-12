import type { ReactNode } from 'react';
import { CheckCircle2, CircleDashed, Loader2, TriangleAlert } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import type {
  MeetingCandidate, MeetingCandidateKind, MeetingCandidateStatus, MeetingSource, MeetingStatus, ManualTranscriptFormat,
} from '@/lib/api';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PersonAvatar } from '@/components/avatars';

/**
 * Vocabulario visual de Juntas (mock "plano de control", `#producto → Juntas`). Los valores son los
 * de src/types/roz-v2.ts; aquí solo se decide cómo se ven. Juntas = amarillo (lo humano); lo que
 * hace roz/el LLM = morado; listo = verde; error = rojo.
 */

export const MEETING_STATUS: Record<MeetingStatus, { label: string; variant: BadgeVariant }> = {
  pendiente: { label: 'En espera', variant: 'neutral' },
  extrayendo: { label: 'Leyendo la junta…', variant: 'llm' },
  lista: { label: 'Lista', variant: 'ok' },
  error: { label: 'Error', variant: 'bad' },
};

export function MeetingStatusBadge({ status }: { status: MeetingStatus }) {
  const s = MEETING_STATUS[status];
  const Icon = status === 'extrayendo' ? Loader2 : status === 'lista' ? CheckCircle2 : status === 'error' ? TriangleAlert : CircleDashed;
  return (
    <Badge variant={s.variant} className="whitespace-nowrap">
      <Icon className={cn('size-3', status === 'extrayendo' && 'animate-spin')} />
      {s.label}
    </Badge>
  );
}

/** Insignia mono de origen (`.src-badge` del mock): granola en verde, manual en amarillo. */
export function SourceBadge({ source, className }: { source: MeetingSource; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-[3px] px-1.5 py-px label-caps leading-[1.5]',
        source === 'granola' ? 'bg-green-soft text-green' : 'bg-yellow-soft text-yellow-ink',
        className,
      )}
    >
      {source}
    </span>
  );
}

export const KIND_LABEL: Record<MeetingCandidateKind, string> = {
  tarea: 'Tarea',
  compromiso: 'Compromiso',
  decision: 'Decisión',
};

export const CANDIDATE_STATUS: Record<MeetingCandidateStatus, { label: string; variant: BadgeVariant }> = {
  pendiente: { label: 'Pendiente', variant: 'neutral' },
  aceptada: { label: 'Issue creado', variant: 'ok' },
  comentada: { label: 'Comentado en duplicado', variant: 'ok' },
  descartada: { label: 'Descartada', variant: 'secondary' },
  guardada: { label: 'Guardada en el brain', variant: 'llm' },
};

export const PRIORITY_LABEL: Record<1 | 2 | 3 | 4, string> = { 1: 'Urgente', 2: 'Alta', 3: 'Media', 4: 'Baja' };
export const PRIORITY_DOT: Record<1 | 2 | 3 | 4, string> = {
  1: 'bg-red',
  2: 'bg-orange',
  3: 'bg-yellow',
  4: 'bg-toggle-off',
};

export const FORMAT_LABEL: Record<ManualTranscriptFormat, string> = {
  texto: 'Texto',
  vtt: 'Subtítulos .vtt',
  srt: 'Subtítulos .srt',
  granola_resumen: 'Resumen de Granola',
};

/** Clases de un <textarea> con el mismo aspecto que `Input` (campo `.inp` del mock). */
export const TEXTAREA_CLS =
  'flex w-full rounded-md border border-input bg-card px-3 py-2 text-[13.5px] transition-colors placeholder:text-faint focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50';

/** Etiqueta de campo del mock (`.field label`): 12px seminegrita en tinta 2. */
export function FieldLabel({ children, htmlFor, className }: { children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn('text-xs font-semibold text-muted-foreground', className)}>
      {children}
    </label>
  );
}

/**
 * Avatar mini (18px, `.mini-av` del mock) de un asistente. Con correo es el `micah` de
 * `PersonAvatar` sembrado con él; sin correo (asistente de texto libre) quedan las iniciales.
 */
export function MiniAvatar({ name, email, className }: { name: string; email?: string | null; className?: string }) {
  if (email) return <PersonAvatar name={name} email={email} className={cn('size-[18px]', className)} />;
  return (
    <span
      aria-hidden
      className={cn('grid size-[18px] shrink-0 place-items-center rounded-full bg-ink text-[8.5px] font-bold text-ink-foreground', className)}
    >
      {initials(name)}
    </span>
  );
}

// ---- Color por candidata

/**
 * Cada candidata tiene su color suave: el resaltado en el transcript y el borde izquierdo de su
 * tarjeta comparten tono, así se ve de un vistazo qué cita respalda qué. Clases literales para que
 * Tailwind las genere.
 */
export interface CandidateTone {
  mark: string;
  ring: string;
  border: string;
  dot: string;
}
const TONES: CandidateTone[] = [
  { mark: 'bg-orange-soft', ring: 'ring-salmon', border: 'border-l-salmon', dot: 'bg-salmon' },
  { mark: 'bg-lavender', ring: 'ring-purple', border: 'border-l-purple', dot: 'bg-purple' },
  { mark: 'bg-green-soft', ring: 'ring-green', border: 'border-l-green', dot: 'bg-green' },
  { mark: 'bg-yellow-soft', ring: 'ring-yellow', border: 'border-l-yellow', dot: 'bg-yellow' },
  { mark: 'bg-blue-soft', ring: 'ring-blue', border: 'border-l-blue', dot: 'bg-blue' },
];
/** Las decisiones van al brain: tono neutro de tinta para no competir con las candidatas. */
export const DECISION_TONE: CandidateTone = { mark: 'bg-panel', ring: 'ring-ink', border: 'border-l-ink', dot: 'bg-ink' };

export function toneAt(i: number): CandidateTone {
  return TONES[((i % TONES.length) + TONES.length) % TONES.length]!;
}

/** id → tono, en el orden en que llegan (las decisiones en tinta). */
export function candidateTones(candidates: Pick<MeetingCandidate, 'id' | 'kind'>[]): Map<string, CandidateTone> {
  const out = new Map<string, CandidateTone>();
  let i = 0;
  for (const c of candidates) out.set(c.id, c.kind === 'decision' ? DECISION_TONE : toneAt(i++));
  return out;
}

// ---- Localizar la cita en el transcript

const QUOTES: Record<string, string> = { '“': '"', '”': '"', '«': '"', '»': '"', '‘': "'", '’': "'" };

/**
 * Texto normalizado + mapa de cada carácter normalizado a su índice en el original. Misma receta que
 * la verificación del backend (minúsculas, sin acentos, espacios colapsados, comillas rectas), así
 * que una cita que el backend aceptó siempre se encuentra aquí.
 */
function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const raw = text[i]!;
    let ch = QUOTES[raw] ?? raw;
    ch = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (/\s/.test(ch)) {
      if (prevSpace || norm.length === 0) continue;
      norm += ' ';
      map.push(i);
      prevSpace = true;
      continue;
    }
    prevSpace = false;
    for (const c of ch) {
      norm += c;
      map.push(i);
    }
  }
  return { norm, map };
}

function normalize(text: string): string {
  return normalizeWithMap(text).norm.trim();
}

/** Rango [inicio, fin) de la cita en el transcript, o null si no aparece. */
export function locateQuote(transcript: string, quote: string, hint: number | null): [number, number] | null {
  const q = normalize(quote);
  if (!q) return null;
  if (hint != null && hint >= 0 && hint < transcript.length) {
    const slice = transcript.slice(hint, hint + quote.length);
    if (normalize(slice) === q) return [hint, hint + quote.length];
  }
  const { norm, map } = normalizeWithMap(transcript);
  const at = norm.indexOf(q);
  if (at < 0) return null;
  const start = map[at]!;
  const end = (map[at + q.length - 1] ?? start) + 1;
  return [start, end];
}
