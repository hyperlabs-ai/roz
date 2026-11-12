import { Bot } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { ErrorCard } from '@/components/bits';
import { Skeleton } from '@/components/ui/skeleton';
import { TicketForm, useTicketReady } from '@/components/tickets/TicketForm';
import { apiGet, type TicketFilterOptions } from '@/lib/api';
import { useApi } from '@/lib/useApi';

/**
 * Ticket inteligente (/app/ticket). Cualquiera del equipo escribe nombre, proyecto y descripción;
 * roz deduce tipo de solución, skills, nivel, puntos y urgencia, propone responsable y —al crear—
 * le manda un DM desde tu perfil. (No confundir con /app/tickets, que es Reportes.)
 *
 * Composición: el compositor a la izquierda y el panel de roz a la derecha (qué hace → leyendo →
 * cómo lo entendió), las dos columnas a la misma altura.
 */
export default function Ticket() {
  const filters = useApi<TicketFilterOptions>(() => apiGet('/tickets/filters'), [], { key: '/tickets/filters', ttl: 600_000 });
  const { ready, reason } = useTicketReady(filters.data);

  return (
    <Layout title="Ticket">
      {filters.error && <ErrorCard message={filters.error} className="mb-4" />}
      {!filters.data ? (
        <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <div className="grid min-h-[420px] content-start gap-3 rounded-xl border bg-card p-5">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="mt-2 h-7 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
          <div className="grid content-start gap-2.5 rounded-xl bg-panel p-5">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full bg-card" />)}
          </div>
        </div>
      ) : !ready ? (
        <div className="flex items-start gap-3 rounded-xl border bg-card p-5">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-lavender text-purple-deep"><Bot className="size-4" /></span>
          <div className="grid gap-1">
            <span className="text-[14px] font-semibold">Los tickets inteligentes no están disponibles</span>
            <p className="text-sm text-muted-foreground">{reason}</p>
          </div>
        </div>
      ) : (
        <TicketForm filters={filters.data} />
      )}
    </Layout>
  );
}
