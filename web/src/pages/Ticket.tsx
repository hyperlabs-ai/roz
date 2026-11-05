import { Layout } from '@/components/Layout';
import { ErrorCard } from '@/components/bits';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TicketForm, useTicketReady } from '@/components/tickets/TicketForm';
import { apiGet, type TicketFilterOptions } from '@/lib/api';
import { useApi } from '@/lib/useApi';

/**
 * Ticket inteligente (/app/ticket). Cualquiera del equipo escribe nombre, proyecto y descripción;
 * roz deduce tipo de solución, skills, nivel, puntos y urgencia, propone responsable y —al crear—
 * le manda un DM desde tu perfil. (No confundir con /app/tickets, que es Reportes.)
 */
export default function Ticket() {
  const filters = useApi<TicketFilterOptions>(() => apiGet('/tickets/filters'), [], { key: '/tickets/filters', ttl: 600_000 });
  const { ready, reason } = useTicketReady(filters.data);

  return (
    <Layout title="Ticket" subtitle="Escribe lo esencial: roz completa el resto, asigna y avisa">
      {filters.error && <ErrorCard message={filters.error} className="mb-4" />}
      <Card>
        <CardContent className="p-4 sm:p-6">
          {!filters.data ? (
            <div className="space-y-3">
              <Skeleton className="h-9 w-full max-w-xl" />
              <Skeleton className="h-9 w-full max-w-xl" />
              <Skeleton className="h-40 w-full max-w-xl" />
            </div>
          ) : !ready ? (
            <p className="text-sm text-muted-foreground">{reason}</p>
          ) : (
            <TicketForm filters={filters.data} />
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}
