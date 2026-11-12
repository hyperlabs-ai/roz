import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { DECISION_TONE, candidateTones, locateQuote } from '@/components/meetings/meeting-ui';
import type { MeetingCandidate } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * El texto de la junta con las citas de cada candidata resaltadas, cada una en el tono suave de su
 * candidata (el mismo del borde de su tarjeta). La cita activa lleva anillo y se trae a la vista: es
 * la prueba de que roz no inventó la tarea. Un clic en un resaltado selecciona su candidata.
 */
export function TranscriptView({
  transcript,
  candidates,
  activeId,
  onPick,
  bare = false,
}: {
  transcript: string;
  candidates: MeetingCandidate[];
  activeId: string | null;
  onPick: (id: string) => void;
  /** Sin scroll ni tope propios: el contenedor (el panel de la junta) ya desplaza. */
  bare?: boolean;
}) {
  const tones = useMemo(() => candidateTones(candidates), [candidates]);
  const marks = useMemo(() => {
    const found = candidates
      .map((c) => {
        const r = locateQuote(transcript, c.quote, c.quoteStart);
        return r ? { id: c.id, start: r[0], end: r[1], decision: c.kind === 'decision' } : null;
      })
      .filter((m): m is { id: string; start: number; end: number; decision: boolean } => !!m)
      .sort((a, b) => a.start - b.start);
    // Sin traslapes: si dos citas se pisan, gana la primera (la otra sigue visible en su tarjeta).
    const out: typeof found = [];
    let last = -1;
    for (const m of found) {
      if (m.start < last) continue;
      out.push(m);
      last = m.end;
    }
    return out;
  }, [transcript, candidates]);

  const activeRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeId]);

  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.start > at) parts.push(transcript.slice(at, m.start));
    const isActive = m.id === activeId;
    const tone = tones.get(m.id) ?? DECISION_TONE;
    parts.push(
      <mark
        key={m.id}
        ref={isActive ? (el) => { activeRef.current = el; } : undefined}
        onClick={() => onPick(m.id)}
        className={cn(
          'cursor-pointer rounded-[3px] px-[3px] py-px text-foreground transition-shadow duration-fast',
          tone.mark,
          m.decision && 'font-semibold',
          isActive ? cn('ring-2', tone.ring) : 'hover:ring-1 hover:ring-border',
        )}
      >
        {transcript.slice(m.start, m.end)}
      </mark>,
    );
    at = m.end;
  }
  if (at < transcript.length) parts.push(transcript.slice(at));

  return (
    <div className={cn('whitespace-pre-wrap text-[13.5px] leading-[1.75] text-muted-foreground', !bare && 'scroll-list max-h-[70dvh]')}>
      {parts}
    </div>
  );
}
