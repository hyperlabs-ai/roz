import { NavLink } from 'react-router-dom';
import { Activity, TriangleAlert } from 'lucide-react';
import { UserAvatar } from '@/components/bits';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useQueueLive } from '@/queue/QueueContext';
import { inflightPhrase, personOf } from '@/components/queue/QueueRow';
import { cn } from '@/lib/utils';

/**
 * El pulso del pipeline, en el header de todas las pantallas.
 *
 * Existe para responder de un vistazo, sin ir a buscarla, la pregunta que antes no tenía respuesta:
 * "¿se está procesando algo ahora mismo, y de quién?". Al hacer click lleva a la sección con el
 * detalle — que a propósito NO está en el nav lateral: no es un destino al que uno va, es algo que
 * se consulta cuando el pulso llama la atención.
 *
 * Reposo = ruido cero: en cuanto la cola se vacía vuelve a ser un botón discreto con un punto.
 */
export function QueuePill() {
  const { pulse, stale } = useQueueLive();

  const counts = pulse?.counts;
  const broken = (counts?.dead ?? 0) > 0;
  const inflight = pulse?.inflight ?? [];
  const active = inflight[0] ?? null;
  const extra = Math.max(0, (counts?.pending ?? 0) + (counts?.processing ?? 0) - 1);

  // Sin contacto o sin datos aún: la forma callada. Nunca un skeleton — el header no debe
  // parpadear en cada carga de página.
  if (stale || !pulse || (!active && !broken)) {
    const tip = stale
      ? 'Sin contacto con el servidor'
      : pulse
        ? `Al día · ${pulse.counts.doneLastHour} procesados en la última hora`
        : 'Cola de procesamiento';
    const dot = stale ? 'bg-muted-foreground/40' : pulse?.health === 'delayed' ? 'bg-warning' : 'bg-success';
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <NavLink
            to="/app/activity"
            aria-label={tip}
            className={({ isActive }) =>
              cn(
                'relative grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                isActive && 'bg-primary/10 text-primary',
              )
            }
          >
            <Activity className="size-[18px]" />
            <span className={cn('absolute bottom-1 right-1 size-1.5 rounded-full', dot)} />
          </NavLink>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
    );
  }

  // Hay algo que contar. Se prioriza lo que está pasando ahora sobre lo que falló: lo roto se
  // señala con el borde, pero el texto lo ocupa el trabajo en curso.
  const person = active ? personOf(active) : null;
  const phrase = active ? inflightPhrase(active) : `${counts!.dead} evento${counts!.dead > 1 ? 's' : ''} sin procesar`;

  return (
    <NavLink
      to="/app/activity"
      aria-label={phrase}
      title={phrase}
      className={({ isActive }) =>
        cn(
          'flex h-8 shrink-0 items-center gap-2 rounded-full border bg-card pl-1 pr-1.5 transition-colors sm:pr-2.5',
          broken ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'hover:bg-accent',
          isActive && !broken && 'border-primary/30 bg-primary/10 text-primary',
        )
      }
    >
      {active && person ? (
        <UserAvatar url={person.avatarUrl} name={person.name} className="size-6 shrink-0" />
      ) : broken && !active ? (
        <TriangleAlert className="ml-1 size-4 shrink-0" />
      ) : (
        <span className="relative ml-1 grid size-4 shrink-0 place-items-center">
          <span className="absolute size-2 animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative size-2 rounded-full bg-primary" />
        </span>
      )}

      <span className="hidden max-w-[15rem] truncate text-[13px] font-medium sm:inline">{phrase}</span>
      {extra > 0 && (
        <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground sm:inline">+{extra}</span>
      )}
    </NavLink>
  );
}
