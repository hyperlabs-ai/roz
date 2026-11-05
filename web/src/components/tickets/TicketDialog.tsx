import { Ticket as TicketIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { apiGet, type TicketCreateResponse, type TicketFilterOptions } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { TicketForm, useTicketReady } from './TicketForm';

/**
 * `/ticket` en el chat: el mismo formulario de la pestaña Ticket, en un modal. Lo que se escribió
 * después de `/ticket` llega como nombre.
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TicketIcon className="size-4" /> Nuevo ticket
          </DialogTitle>
          <DialogDescription>Escribe lo esencial; roz completa el resto, propone responsable y le avisa por DM.</DialogDescription>
        </DialogHeader>
        {!filters.data ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : !ready ? (
          <p className="text-sm text-muted-foreground">{reason}</p>
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
