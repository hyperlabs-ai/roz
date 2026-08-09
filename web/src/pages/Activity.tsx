import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, Inbox, RefreshCw, RotateCw, TriangleAlert } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { EmptyState, ErrorCard } from '@/components/bits';
import { QueueRow, Ago } from '@/components/queue/QueueRow';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/useApi';
import { usePoll } from '@/lib/usePoll';
import { useQueueLive } from '@/queue/QueueContext';
import { apiGet, apiSend, type QueueBeat, type QueueEvent, type QueueResponse } from '@/lib/api';
import { QUEUE_HEALTH } from '@/lib/labels';
import { cn } from '@/lib/utils';

/** Cadencia del historial. Lo que está en vuelo NO se sondea aquí: viene del contexto global, que
 *  ya va más rápido — así el indicador del header y esta vista jamás se contradicen. */
const HISTORY_MS = 20_000;

type Filter = 'all' | 'inflight' | 'problems';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Todo' },
  { key: 'inflight', label: 'En vuelo' },
  { key: 'problems', label: 'Con problemas' },
];

// ---- Bloques ----

/** Punto de estado. Late solo cuando la cola está viva; en el resto de estados es fijo. */
function LiveDot({ health }: { health: string }) {
  const st = QUEUE_HEALTH[health] ?? QUEUE_HEALTH.unknown!;
  const live = health === 'idle' || health === 'working';
  return (
    <span className="relative inline-flex size-2">
      {live && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-75', st.dot)} />}
      <span className={cn('relative inline-flex size-2 rounded-full', st.dot)} />
    </span>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'warning' | 'destructive' }) {
  return (
    <div>
      <div
        className={cn(
          'text-lg font-semibold tabular-nums leading-none',
          tone === 'warning' && 'text-warning',
          tone === 'destructive' && 'text-destructive',
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function HealthBar({ data }: { data: QueueResponse }) {
  const st = QUEUE_HEALTH[data.health] ?? QUEUE_HEALTH.unknown!;
  const c = data.counts;
  return (
    <div className="mb-4 rounded-xl border bg-card px-5 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <LiveDot health={data.health} />
          <span className="text-lg font-semibold leading-none">{st.label}</span>
        </div>
        <div className="text-[11px] text-muted-foreground">
          {data.lastDrainAt ? (
            <>
              último ciclo <Ago iso={data.lastDrainAt} className="tabular-nums" />
            </>
          ) : (
            'el ciclo aún no se ha registrado'
          )}
          {data.oldestPendingSec != null && data.oldestPendingSec > 60 && (
            <> · el más viejo lleva {Math.round(data.oldestPendingSec / 60)} min en cola</>
          )}
        </div>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-5">
        <Metric label="En cola" value={c.pending} />
        <div className="h-8 w-px bg-border" />
        <Metric label="Procesando" value={c.processing} />
        <div className="h-8 w-px bg-border" />
        <Metric label="Acreditados (1 h)" value={c.doneLastHour} />
        {c.failed > 0 && (
          <>
            <div className="h-8 w-px bg-border" />
            <Metric label="Reintentando" value={c.failed} tone="warning" />
          </>
        )}
        {c.dead > 0 && (
          <>
            <div className="h-8 w-px bg-border" />
            <Metric label="Sin procesar" value={c.dead} tone="destructive" />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * El latido del cron: una barra por minuto de la última media hora. Es lo que impide que la vista
 * se sienta muerta en el caso NORMAL — la cola sana está vacía casi todo el tiempo, así que sin
 * esto no habría nada que mirar y "al día" se leería como "roto".
 */
function CronBeat({ beat }: { beat: QueueBeat[] }) {
  const max = Math.max(1, ...beat.map((b) => b.done + b.failed));
  const total = beat.reduce((a, b) => a + b.done + b.failed, 0);
  return (
    <div className="mb-4 rounded-xl border bg-card px-5 py-4">
      <div className="flex h-9 items-end gap-px">
        {beat.map((b) => {
          const n = b.done + b.failed;
          const pct = n ? Math.max(18, Math.round((n / max) * 100)) : 6;
          return (
            <div
              key={b.minute}
              title={n ? `${n} evento${n > 1 ? 's' : ''}` : 'sin actividad'}
              className={cn(
                'min-w-px flex-1 rounded-[1.5px] transition-[height] duration-500 ease-spring',
                b.failed > 0 ? 'bg-warning' : n ? 'bg-chart-1' : 'bg-muted',
              )}
              style={{ height: `${pct}%` }}
            />
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>hace 30 min</span>
        <span className="tabular-nums">{total} eventos</span>
        <span>ahora</span>
      </div>
    </div>
  );
}

function DeadLetter({ events, onRetried }: { events: QueueEvent[]; onRetried: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const retry = async (id: string) => {
    setBusy(id);
    try {
      await apiSend('POST', `/queue/${id}/retry`, {});
      toast.success('Evento reencolado');
      onRetried();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo reencolar');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mb-4 border-destructive/30 bg-destructive/5">
      <CardContent className="py-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-destructive">
          <TriangleAlert className="size-4 shrink-0" />
          {events.length} evento{events.length > 1 ? 's' : ''} agotó sus reintentos
        </div>
        <div className="divide-y divide-destructive/15">
          {events.map((ev) => (
            <div key={ev.id} className="flex items-center gap-2 py-1">
              <div className="min-w-0 flex-1">
                <QueueRow ev={ev} />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={busy === ev.id}
                onClick={() => retry(ev.id)}
              >
                <RotateCw className={cn(busy === ev.id && 'animate-spin')} /> Reintentar
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function QueueSkeleton() {
  return (
    <div className="stagger-children">
      <Skeleton className="mb-4 h-24 rounded-xl" />
      <Skeleton className="mb-4 h-20 rounded-xl" />
      <div className="rounded-xl border">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b px-4 py-3 last:border-0">
            <Skeleton className="size-7 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
            <Skeleton className="h-3 w-10 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Página ----

export default function Activity() {
  const { pulse, refresh } = useQueueLive();
  const { data, loading, error, reload } = useApi<QueueResponse>(() => apiGet('/queue'), []);
  const [filter, setFilter] = useState<Filter>('all');

  // El historial se sondea aquí; lo en vuelo llega del contexto (que va más rápido).
  usePoll(reload, HISTORY_MS);
  useEffect(() => { refresh(); }, [refresh]);

  // Solo se anima la ENTRADA de filas realmente nuevas. Animar la lista entera en cada sondeo
  // convertiría la vista en un parpadeo constante.
  const seen = useRef<Set<string>>(new Set());
  const isNew = (id: string) => {
    if (seen.current.has(id)) return false;
    seen.current.add(id);
    return seen.current.size > 24; // el primer pintado no se anima fila por fila
  };

  // Preferir lo en vuelo del contexto: es la misma fuente que alimenta el indicador del header.
  const inflight = pulse?.inflight ?? data?.inflight ?? [];
  const events = data?.events ?? [];
  const dead = useMemo(() => events.filter((e) => e.status === 'dead'), [events]);

  const resolved = useMemo(() => {
    if (filter === 'inflight') return [];
    if (filter === 'problems') return events.filter((e) => e.status === 'failed' || e.status === 'dead');
    return events;
  }, [events, filter]);

  const nothingEver = !loading && !events.length && !inflight.length;

  return (
    <Layout
      title="Actividad en vivo"
      subtitle="Lo que roz está procesando ahora y a quién se le acreditó"
      actions={
        <Button variant="outline" size="sm" onClick={reload}>
          <RefreshCw /> Actualizar
        </Button>
      }
    >
      {error && <ErrorCard message={error} className="mb-4" />}

      {loading || !data ? (
        <QueueSkeleton />
      ) : (
        <>
          <HealthBar data={{ ...data, ...(pulse ?? {}) }} />
          <CronBeat beat={data.beat} />

          {dead.length > 0 && <DeadLetter events={dead} onRetried={() => { reload(); refresh(); }} />}

          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Stream</h2>
            <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  aria-pressed={filter === f.key}
                  className={cn(
                    'rounded px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground',
                    filter === f.key && 'bg-background text-foreground shadow-sm',
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {nothingEver ? (
            <div className="rounded-xl border bg-card">
              <EmptyState icon={<Inbox />}>
                Todavía no ha pasado nada por la cola. Cuando llegue un commit o se integre una PR, aparecerá aquí.
              </EmptyState>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card">
              {/* Zona "ahora mismo". No desaparece cuando se vacía —se sustituye por una fila
                  tranquila— para que la lista de abajo no salte cada vez que termina un evento. */}
              <div className="border-b bg-muted/20 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Ahora mismo
              </div>
              {inflight.length ? (
                <div className="divide-y">
                  {inflight.map((ev) => (
                    <QueueRow key={ev.id} ev={ev} isNew={isNew(ev.id)} />
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2.5 px-4 py-3 text-sm text-muted-foreground">
                  <CircleCheck className="size-4 shrink-0 text-success" />
                  <span>
                    Nada en proceso
                    {data.lastDrainAt && (
                      <> · el último ciclo terminó <Ago iso={data.lastDrainAt} /></>
                    )}
                  </span>
                </div>
              )}

              <div className="border-y bg-muted/20 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {filter === 'problems' ? 'Con problemas' : 'Resueltas'}
              </div>
              {resolved.length ? (
                <div className="divide-y">
                  {resolved.map((ev) => (
                    <QueueRow key={ev.id} ev={ev} isNew={isNew(ev.id)} />
                  ))}
                </div>
              ) : (
                <p className="px-4 py-3 text-sm text-muted-foreground">
                  {filter === 'problems' ? 'Nada ha fallado.' : 'Sin eventos resueltos en la ventana.'}
                </p>
              )}

              {data.truncated && filter === 'all' && (
                <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">
                  Mostrando los {resolved.length} eventos más recientes.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Layout>
  );
}
