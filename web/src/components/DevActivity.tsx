import { useState } from 'react';
import { GitCommitHorizontal, GitBranch, CircleCheck, Eye } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, LineDelta, ErrorCard } from '@/components/bits';
import { useApi } from '@/lib/useApi';
import { apiGet, type DeveloperActivity } from '@/lib/api';
import { relative } from '@/lib/format';
import { cn } from '@/lib/utils';

// Ventanas del selector (deben coincidir con ACTIVITY_WINDOWS del backend, que acota ?days=).
const WINDOWS = [
  { days: 7, label: '7d' },
  { days: 14, label: '14d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
] as const;

const DEFAULT_DAYS = 30;

/**
 * Actividad reciente del dev con su PROPIO selector de ventana. Antes heredaba el período del
 * dashboard, así que con "este mes" recién empezado el feed mostraba dos o tres días. La ventana
 * se ancla al fin del período visible (`to`) para que un período histórico siga mostrando su
 * propia cola, pero puede retroceder hasta 90 días por debajo de él.
 */
export function DevActivity({ devId, to }: { devId: string; to: string }) {
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const { data, loading, error } = useApi<DeveloperActivity>(
    () => apiGet(`/developers/${devId}/activity?days=${days}&to=${encodeURIComponent(to)}`),
    [devId, days, to],
  );

  return (
    <Card className="min-w-0 lg:flex lg:max-h-[480px] lg:flex-col">
      {/* En móvil el selector baja a su propia línea: lado a lado con el título no cabe. */}
      <CardHeader className="flex-col gap-2 space-y-0 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
        <CardTitle>Actividad reciente</CardTitle>
        <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              onClick={() => setDays(w.days)}
              aria-pressed={days === w.days}
              className={cn(
                'rounded px-2 py-1 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:text-foreground',
                days === w.days && 'bg-background text-foreground shadow-sm',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
        {error && <ErrorCard message={error} />}
        {loading && (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
          </div>
        )}
        {!loading && data && (data.activity.length ? (
          <div className="space-y-0.5 scrollbar-thin lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1">
            {data.activity.map((a, i) => (
              <div key={i} className="flex items-center gap-3 border-b py-2 last:border-0">
                <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
                  {a.type === 'commit' ? <GitCommitHorizontal className="size-3.5" /> : a.type === 'revision' ? <Eye className="size-3.5 text-chart-2" /> : <CircleCheck className="size-3.5 text-success" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{a.name}</div>
                  <div className="mt-0.5 flex items-center gap-2">
                    {a.repo && (
                      <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground" title={a.repo}>
                        <GitBranch className="size-3 shrink-0" />
                        <span className="truncate font-mono">{a.repo.replace('hyperlabs-ai/', '')}</span>
                      </span>
                    )}
                    {a.type === 'commit' && <LineDelta additions={a.additions} deletions={a.deletions} />}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{relative(a.ts)}</span>
              </div>
            ))}
            {data.truncated && (
              <div className="py-2 text-center text-[11px] text-muted-foreground">
                Mostrando los {data.activity.length} eventos más recientes de la ventana
              </div>
            )}
          </div>
        ) : <EmptyState>Sin actividad en los últimos {data.days} días</EmptyState>)}
      </CardContent>
    </Card>
  );
}
