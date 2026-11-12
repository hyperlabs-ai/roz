import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { apiGet, type TicketCreateResponse, type TicketFilterOptions } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { TicketForm, useTicketReady } from './TicketForm';

/**
 * `/ticket` en el chat: el mismo formulario de la pestaña Ticket, en un modal con el lenguaje del
 * alta de tareas (breadcrumb, título sin borde, píldoras y pie). Lo escrito tras `/ticket` llega
 * como nombre.
 */
export function TicketDialog({
  open,
  onOpenChange,
  initialTitle,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialTitle?: string;
  onCreated?: (r: TicketCreateResponse) => void;
}) {
  // Las opciones de filtro son casi estáticas y las comparten Tareas, Chat y Ticket (misma caché).
  const filters = useApi<TicketFilterOptions>(() => apiGet('/tickets/filters'), [], { key: '/tickets/filters', ttl: 600_000 });
  const { ready, reason } = useTicketReady(filters.data);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px]">
        <DialogTitle className="sr-only">Nuevo ticket</DialogTitle>
        <DialogDescription className="sr-only">Escribe lo esencial; roz completa el resto, propone responsable y le avisa por DM.</DialogDescription>
        {!filters.data ? (
          <div className="grid gap-3 p-5 pt-14">
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <div className="flex gap-1.5 pt-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-7 w-24" />)}</div>
          </div>
        ) : !ready ? (
          <p className="p-6 pr-14 text-sm text-muted-foreground">{reason}</p>
        ) : (
          // `key`: cada apertura empieza limpia (con el título que venga del chat).
          <TicketForm
            key={`${open}-${initialTitle ?? ''}`}
            dense
            filters={filters.data}
            initialTitle={initialTitle}
            onCancel={() => onOpenChange(false)}
            onDone={(r) => {
              onCreated?.(r);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
