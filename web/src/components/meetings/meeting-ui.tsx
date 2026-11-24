import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { MeetingAttendee, MeetingSource } from '@/lib/api';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PersonAvatar } from '@/components/avatars';

/**
 * Vocabulario visual de Juntas. Juntas = amarillo (lo humano). Las juntas son solo registro: texto,
 * quién estuvo, cuándo y de qué proyecto.
 */

/** Insignia de origen: granola en verde, manual en amarillo. */
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

/** Clases de un <textarea> con el mismo aspecto que `Input`. (También lo usan los diálogos de Discord.) */
export const TEXTAREA_CLS =
  'flex w-full rounded-md border border-input bg-card px-3 py-2 text-[13.5px] transition-colors placeholder:text-faint focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50';

/** Etiqueta de campo: 12px seminegrita en tinta 2. */
export function FieldLabel({ children, htmlFor, className }: { children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn('text-xs font-semibold text-muted-foreground', className)}>
      {children}
    </label>
  );
}

/** Avatar mini (18px) de un asistente: con correo, el de `PersonAvatar`; sin correo, iniciales. */
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

/** Chip de un asistente (avatar + nombre; el correo en el título). */
export function AttendeeChip({ a, onRemove, className }: { a: MeetingAttendee; onRemove?: () => void; className?: string }) {
  return (
    <span
      title={a.email ?? undefined}
      className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full bg-panel py-0.5 pl-1 pr-2.5 text-xs font-medium', onRemove && 'pr-1', className)}
    >
      <MiniAvatar name={a.name} email={a.email} />
      <span className="truncate">{a.name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Quitar a ${a.name}`}
          onClick={onRemove}
          className="grid size-4 place-items-center rounded-full text-faint transition-colors hover:bg-card hover:text-foreground"
        >
          ×
        </button>
      )}
    </span>
  );
}

// ---- Búsqueda: mismas reglas que el backend (src/meetings/store.ts)

/** Minúsculas y sin acentos, carácter por carácter (mismo largo: sirve para recortar el original). */
export function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const base = ch.length === 1 ? (ch.normalize('NFD')[0] ?? ch).toLowerCase() : ch;
    out += base.length === ch.length ? base : ch;
  }
  return out;
}

/** Palabras de una búsqueda: solo letras y números, hasta 6. */
export function searchTerms(q: string): string[] {
  return [...new Set(q.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))].slice(0, 6);
}

/**
 * Texto con las palabras buscadas resaltadas (sin importar acentos ni mayúsculas). La primera
 * coincidencia se trae a la vista al abrir.
 */
export function HighlightedText({ text, terms, className }: { text: string; terms: string[]; className?: string }) {
  const ranges = useMemo(() => {
    if (!terms.length) return [];
    const folded = fold(text);
    const found: [number, number][] = [];
    for (const t of terms.map(fold)) {
      let at = folded.indexOf(t);
      while (at >= 0 && found.length < 1000) {
        found.push([at, at + t.length]);
        at = folded.indexOf(t, at + t.length);
      }
    }
    found.sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    for (const r of found) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else out.push([...r]);
    }
    return out;
  }, [text, terms]);

  const first = useRef<HTMLElement | null>(null);
  useEffect(() => {
    first.current?.scrollIntoView({ block: 'center' });
  }, [ranges]);

  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) parts.push(text.slice(at, s));
    parts.push(
      <mark key={s} ref={i === 0 ? (el) => { first.current = el; } : undefined} className="rounded-[3px] bg-yellow-soft px-[2px] text-foreground">
        {text.slice(s, e)}
      </mark>,
    );
    at = e;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <div className={className}>{parts}</div>;
}
