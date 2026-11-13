// Lecturas de zeus que comparten varias pestañas. Todas viven bajo el prefijo de caché `/zeus`, así
// que una mutación hace `invalidate('/zeus/…')` (o `invalidate(ZEUS_KEY)`) y lo montado revalida solo.
import { useMemo } from 'react';
import { useApi } from '@/lib/useApi';
import { zeusApi, type ZeusGraph, type ZeusOrg } from '@/lib/zeus';

export const GRAPH_KEY = '/zeus/graph';
export const NODES_KEY = '/zeus/nodes';
export const ORG_KEY = '/zeus/org';
export const INBOX_KEY = '/zeus/inbox';
export const ME_KEY = '/zeus/me';

export function useZeusGraph(projectId: string | null) {
  return useApi<ZeusGraph>(() => zeusApi.graph(projectId), [projectId ?? ''], { key: GRAPH_KEY, ttl: 30_000 });
}

export interface ZeusProjectOption {
  id: string;
  ref: string;
  name: string;
  key: string | null;
}

/**
 * Proyectos para los filtros y formularios, sacados del propio grafo (los nodos `project:<uuid>`):
 * así el selector ofrece exactamente los proyectos que zeus conoce, sin otra petición ni otro tipo.
 */
export function useZeusProjects(): ZeusProjectOption[] {
  const { data } = useZeusGraph(null);
  return useMemo(
    () =>
      (data?.nodes ?? [])
        .filter((n) => n.kind === 'project')
        .map((n) => ({
          id: n.ref.slice(n.ref.indexOf(':') + 1),
          ref: n.ref,
          name: n.title,
          key: typeof n.meta?.key === 'string' ? n.meta.key : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
    [data],
  );
}

export function useZeusOrg() {
  return useApi<ZeusOrg>(() => zeusApi.org(), [], { key: ORG_KEY, ttl: 30_000 });
}
