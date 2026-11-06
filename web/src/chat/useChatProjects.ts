import { apiGet, type TicketFilterOptions } from '@/lib/api';
import { useApi } from '@/lib/useApi';

const EMPTY: { id: string; name: string }[] = [];

/**
 * Proyectos que se pueden mencionar con `@` en el chat. Misma petición y caché que Tareas y
 * `/ticket` (`/tickets/filters`, casi estática), así que no suma tráfico.
 */
export function useChatProjects(): { id: string; name: string }[] {
  const filters = useApi<TicketFilterOptions>(() => apiGet('/tickets/filters'), [], { key: '/tickets/filters', ttl: 600_000 });
  return filters.data?.allProjects ?? EMPTY;
}
