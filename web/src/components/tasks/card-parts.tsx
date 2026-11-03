import { CalendarDays } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { AvatarStack } from '@/components/bits';
import { PRIO_DOT, PRIO_LABEL } from '@/lib/labels';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Las dos filas de la tarjeta del kanban que no dependen del tablero: las etiquetas de arriba y la
 * fila de metadatos (identificador, prioridad, fecha límite, responsables). Viven aparte para que
 * la tarjeta del tablero y la que se cita en el chat sean la MISMA tarjeta y no dos que se parecen.
 */
export function CardLabels({ labels }: { labels?: string[] | null }) {
  if (!labels?.length) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1">
      {labels.slice(0, 3).map((l) => (
        <Badge key={l} variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">{l}</Badge>
      ))}
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
  people: { name: string; avatarUrl: string | null }[];
}) {
  return (
    <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="shrink-0 font-mono">{identifier}</span>
      {priority && (
        <span className="flex shrink-0 items-center gap-1" title={`Prioridad ${PRIO_LABEL[priority] ?? priority}`}>
          <span className={cn('size-1.5 rounded-full', PRIO_DOT[priority] ?? 'bg-muted')} />
          {PRIO_LABEL[priority] ?? priority}
        </span>
      )}
      {dueDate && (
        <span className={cn('flex shrink-0 items-center gap-1', overdue && 'font-medium text-destructive')}>
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
