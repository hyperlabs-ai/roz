import { Link } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { MatrixLoader } from '@/components/bits';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useQueueLive } from '@/queue/QueueContext';
import { inflightPhrase } from '@/components/queue/QueueRow';
import { cn } from '@/lib/utils';

/** Ancla del historial de eventos dentro del Pulso (la página de Actividad se unificó con él). */
export const EVENT_HISTORY_HREF = '/app/pulse#historial';

/**
 * El pulso del pipeline, en el header de todas las pantallas. Discreto a propósito: un ícono, un
 * punto de estado y, solo si hay eventos sin procesar, su número junto a un punto rojo. Nada de
 * píldoras de color: el header no debe gritar. El detalle (qué se procesa, de quién) va en el
 * tooltip, y el click abre el historial de eventos en el Pulso.
 */
export function QueuePill() {
  const { pulse, stale } = useQueueLive();

  const counts = pulse?.counts;
  const dead = counts?.dead ?? 0;
  const inflight = pulse?.inflight ?? [];
  const active = inflight[0] ?? null;
  const queued = (counts?.pending ?? 0) + (counts?.processing ?? 0);

  const tip = stale
    ? 'Sin contacto con el servidor'
    : !pulse
      ? 'Historial de eventos'
      : dead > 0
        ? `${dead} evento${dead > 1 ? 's' : ''} sin procesar`
        : active
          ? `${inflightPhrase(active)}${queued > 1 ? ` · +${queued - 1} en cola` : ''}`
          : `Al día · ${pulse.counts.doneLastHour} procesados en la última hora`;

  const dot = stale ? 'bg-toggle-off' : pulse?.health === 'delayed' ? 'bg-yellow' : 'bg-green';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={EVENT_HISTORY_HREF}
          aria-label={tip}
          className="relative flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
        >
          {active && !stale ? (
            <MatrixLoader className="size-4 shrink-0 text-primary" />
          ) : (
            <Activity className="size-[18px] shrink-0" />
          )}
          {dead > 0 ? (
            <span className="flex items-center gap-1 text-[12px] font-semibold tabular-nums text-red">
              <span className="size-1.5 rounded-full bg-red" />
              {dead > 99 ? '99+' : dead}
            </span>
          ) : (
            <span className={cn('absolute bottom-1.5 right-1.5 size-1.5 rounded-full', dot)} />
          )}
        </Link>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
