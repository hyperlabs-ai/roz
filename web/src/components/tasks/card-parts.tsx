import { CalendarDays } from 'lucide-react';
import { AvatarStack } from '@/components/bits';
import { LabelDot, PriorityIcon } from '@/components/tasks/properties';
import { PRIO_LABEL } from '@/lib/labels';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Las dos filas de la tarjeta del kanban que no dependen del tablero: las etiquetas y la fila de
 * metadatos (identificador, prioridad, fecha límite, responsables). Viven aparte para que la
 * tarjeta del tablero y la que se cita en el chat sean la MISMA tarjeta y no dos que se parecen.
 *
 * Lenguaje de Linear: la etiqueta es un chip con su punto de color, la prioridad es el ícono de
 * barras dentro de un cuadrito, y la fecha un chip que se pone rojo al vencer.
 */
export function CardLabels({ labels }: { labels?: string[] | null }) {
  if (!labels?.length) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1">
      {labels.slice(0, 3).map((l) => (
        <span key={l} className="inline-flex max-w-full items-center gap-1 rounded-full border bg-card px-1.5 py-px text-[10.5px] font-medium text-muted-foreground">
          <LabelDot label={l} className="size-1.5" />
          <span className="truncate">{l}</span>
        </span>
      ))}
      {labels.length > 3 && <span className="px-0.5 text-[10.5px] text-faint">+{labels.length - 3}</span>}
    </div>
  );
}

export function CardMeta({
  identifier,
  priority,
  dueDate,
  overdue,
  people,
}: {
  identifier: string;
  priority?: string | null;
  dueDate?: string | null;
  overdue?: boolean;
  people: { name: string; avatarUrl: string | null; id?: string | null }[];
}) {
  return (
    <div className="mt-2 flex min-h-5 items-center gap-1.5 text-[11px] text-muted-foreground">
      <span
        className="grid size-5 shrink-0 place-items-center rounded-[5px] border bg-card"
        title={priority ? `Prioridad ${PRIO_LABEL[priority] ?? priority}` : 'Sin prioridad'}
      >
        <PriorityIcon value={priority ?? null} className="size-3" />
      </span>
      <span className="min-w-0 truncate font-mono text-[10.5px] text-faint">{identifier}</span>
      {dueDate && (
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px',
            overdue ? 'border-transparent bg-red-soft font-medium text-red' : 'bg-card',
          )}
        >
          <CalendarDays className="size-3" />
          {shortDate(dueDate)}
        </span>
      )}
      <span className="ml-auto shrink-0">
        {people.length > 0 && <AvatarStack people={people} max={3} size="size-5" />}
      </span>
    </div>
  );
}
