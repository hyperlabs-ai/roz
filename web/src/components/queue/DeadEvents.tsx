import { useMemo, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ChevronDown, CircleCheck, RotateCw, TriangleAlert } from 'lucide-react';
import { EmptyState, LineDelta } from '@/components/bits';
import { GithubAvatar } from '@/components/brand';
import { Ago, familyOf, iconFor, personOf, shortRepo } from '@/components/queue/QueueRow';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { apiGet, apiSend, type QueueEvent, type QueueResponse } from '@/lib/api';
import { QUEUE_FAMILY, QUEUE_FAMILY_FAILED } from '@/lib/labels';
import { toast } from '@/lib/toast';
import { useApi } from '@/lib/useApi';
import { useQueueLive } from '@/queue/QueueContext';
import { cn } from '@/lib/utils';

/**
 * El error llega crudo del worker ("Error: 400 {"type":"error","error":{…"message":"…"}}"). Se
 * separa en una frase legible (el `message` más interno del JSON, si lo hay) y el código HTTP; el
 * texto completo queda disponible al expandir la fila.
 */
export function parseQueueError(raw: string | null): { summary: string; code: string | null; raw: string } | null {
  if (!raw) return null;
  const text = raw.trim();
  const code = text.match(/\b([45]\d{2})\b/)?.[1] ?? null;
  let summary = text.replace(/^Error:\s*/i, '');
  const brace = text.indexOf('{');
  if (brace >= 0) {
    try {
      const j = JSON.parse(text.slice(brace)) as Record<string, unknown>;
      const inner = (j.error && typeof j.error === 'object' ? (j.error as Record<string, unknown>).message : null) ?? j.message ?? j.error;
      if (typeof inner === 'string' && inner.trim()) summary = inner.trim();
    } catch {
      // JSON truncado por el backend: se rescata el "message" con una expresión regular.
      const m = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)/);
      if (m?.[1]) summary = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ');
    }
  }
  return { summary, code, raw: text };
}

/** Reintentos en paralelo acotado: 20 POST a la vez saturarían el drain sin ganar nada. */
const RETRY_CONCURRENCY = 4;

/**
 * Eventos que agotaron sus reintentos. Solo consulta `/queue` al abrirse. Arma su propia cabecera
 * (no `DialogHeader`): el contenido va sin padding para que la lista haga scroll de filo a filo.
 */
export function DeadEventsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] w-[calc(100vw-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        {open && <DeadBody />}
      </DialogContent>
    </Dialog>
  );
}

function DeadBody() {
  const { pulse, refresh } = useQueueLive();
  const { data, loading, reload } = useApi<QueueResponse>(() => apiGet<QueueResponse>('/queue'), [], { key: '/queue', ttl: 15_000 });
  const dead = useMemo(() => (data?.events ?? []).filter((e) => e.status === 'dead'), [data]);
  const total = Math.max(pulse?.counts.dead ?? 0, dead.length);

  // Estado por fila: reintentando / ya reencolado (la fila se atenúa hasta que recarga la lista).
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);

  const mark = (set: typeof setBusy, id: string, on: boolean) =>
    set((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const retryOne = async (id: string, quiet = false): Promise<boolean> => {
    mark(setBusy, id, true);
    try {
      await apiSend('POST', `/queue/${id}/retry`, {});
      mark(setSent, id, true);
      return true;
    } catch (e) {
      if (!quiet) toast.error(e instanceof Error ? e.message : 'No se pudo reencolar');
      return false;
    } finally {
      mark(setBusy, id, false);
    }
  };

  const after = () => {
    reload();
    refresh();
  };

  const retrySingle = async (id: string) => {
    if (await retryOne(id)) {
      toast.success('Evento reencolado');
      after();
    }
  };

  const retryAll = async () => {
    const ids = dead.filter((e) => !sent.has(e.id)).map((e) => e.id);
    if (!ids.length) return;
    setBulk({ done: 0, total: ids.length });
    let ok = 0;
    let i = 0;
    const worker = async () => {
      while (i < ids.length) {
        const id = ids[i++]!;
        if (await retryOne(id, true)) ok++;
        setBulk((b) => (b ? { ...b, done: b.done + 1 } : b));
      }
    };
    await Promise.all(Array.from({ length: Math.min(RETRY_CONCURRENCY, ids.length) }, worker));
    setBulk(null);
    if (ok === ids.length) toast.success(`${ok} evento${ok === 1 ? '' : 's'} reencolado${ok === 1 ? '' : 's'}`);
    else toast.error(`Se reencolaron ${ok} de ${ids.length}. Revisa los que quedaron.`);
    after();
  };

  // Causa más repetida: con 100 eventos muertos por lo mismo, leer una vez basta.
  const topCause = useMemo(() => {
    const n = new Map<string, number>();
    for (const e of dead) {
      const s = parseQueueError(e.error)?.summary;
      if (s) n.set(s, (n.get(s) ?? 0) + 1);
    }
    const top = [...n.entries()].sort((a, b) => b[1] - a[1])[0];
    return top && top[1] > 1 ? { text: top[0], count: top[1] } : null;
  }, [dead]);

  const pending = dead.filter((e) => !sent.has(e.id)).length;

  return (
    <>
      {/* Cabecera propia: eyebrow + título, con hueco a la derecha para la X del diálogo. */}
      <div className="grid shrink-0 gap-1.5 border-b px-5 pb-4 pr-14 pt-5 sm:px-6">
        <span className="eyebrow [--sq:var(--red)]">Pipeline</span>
        <DialogPrimitive.Title className="text-xl font-semibold leading-tight tracking-[-0.03em]">
          Eventos sin procesar
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="text-[13px] leading-snug text-muted-foreground">
          Agotaron sus reintentos automáticos. Corrige la causa y vuelve a encolarlos.
        </DialogPrimitive.Description>
      </div>

      {loading && !data ? (
        <div className="grid gap-2.5 p-5 sm:p-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[72px] rounded-lg" />
          ))}
        </div>
      ) : !dead.length ? (
        <EmptyState icon={<CircleCheck />}>No hay eventos pendientes de reintentar.</EmptyState>
      ) : (
        <>
          {topCause && (
            <div className="flex shrink-0 items-start gap-2.5 border-b bg-red-soft/50 px-5 py-3 sm:px-6">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red" />
              <div className="min-w-0 text-[12.5px] leading-snug">
                <span className="font-semibold text-red">
                  {topCause.count} de {dead.length} fallan por lo mismo
                </span>
                <p className="mt-0.5 line-clamp-3 break-words text-foreground/85">{topCause.text}</p>
              </div>
            </div>
          )}

          <ol className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            {dead.map((ev) => (
              <DeadRow
                key={ev.id}
                ev={ev}
                busy={busy.has(ev.id)}
                sent={sent.has(ev.id)}
                disabled={!!bulk}
                onRetry={() => retrySingle(ev.id)}
              />
            ))}
          </ol>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-sidebar px-5 py-3 sm:px-6">
            <span className="text-[12.5px] tabular-nums text-muted-foreground">
              {total > dead.length ? (
                <>
                  Mostrando <b className="font-semibold text-foreground">{dead.length}</b> de{' '}
                  <b className="font-semibold text-foreground">{total}</b>
                </>
              ) : (
                <>
                  <b className="font-semibold text-foreground">{dead.length}</b> evento{dead.length === 1 ? '' : 's'}
                </>
              )}
            </span>
            <Button size="sm" disabled={!!bulk || pending === 0} onClick={retryAll}>
              <RotateCw className={cn(bulk && 'animate-spin')} />
              {bulk ? `Reencolando ${bulk.done}/${bulk.total}` : `Reintentar ${pending === dead.length ? 'estos' : 'los'} ${pending}`}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

function DeadRow({
  ev,
  busy,
  sent,
  disabled,
  onRetry,
}: {
  ev: QueueEvent;
  busy: boolean;
  sent: boolean;
  disabled: boolean;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = iconFor(ev.type);
  const family = familyOf(ev.type);
  const person = personOf(ev);
  const err = parseQueueError(ev.error);

  const meta = [
    ev.repo ? <span key="r" className="font-mono" title={ev.repo}>{shortRepo(ev.repo)}</span> : null,
    ev.prNumber != null ? <span key="p" className="font-mono">#{ev.prNumber}</span> : null,
    ev.sha ? <span key="s" className="font-mono">{ev.sha}</span> : null,
    ev.task ? <span key="t" className="font-mono">{ev.task.identifier}</span> : null,
    person ? <span key="n">{person.name}</span> : null,
  ].filter(Boolean);

  return (
    <li className={cn('border-b px-5 py-3.5 transition-opacity last:border-b-0 sm:px-6', sent && 'opacity-50')}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3">
        {person ? (
          <GithubAvatar login={person.login} id={person.devId} url={person.avatarUrl} name={person.name} className="size-8" />
        ) : (
          <span className={cn('grid size-8 place-items-center rounded-md', QUEUE_FAMILY[family])}>
            <Icon className="size-4" />
          </span>
        )}

        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="label-caps text-muted-foreground">{QUEUE_FAMILY_FAILED[family]}</span>
            <span className="text-faint">·</span>
            <Ago iso={ev.resolvedAt ?? ev.createdAt} className="shrink-0 tabular-nums text-faint" />
          </div>
          <div className="mt-0.5 line-clamp-2 break-words text-[13.5px] font-medium leading-snug" title={ev.subject ?? undefined}>
            {ev.url ? (
              <a href={ev.url} target="_blank" rel="noreferrer noopener" className="hover:underline">
                {ev.subject ?? ev.type}
              </a>
            ) : (
              ev.subject ?? ev.type
            )}
          </div>
          {(meta.length > 0 || ev.additions != null || ev.deletions != null) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-faint">
              {meta}
              {(ev.additions != null || ev.deletions != null) && <LineDelta additions={ev.additions} deletions={ev.deletions} />}
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1.5">
          <Button variant="secondary" size="sm" disabled={busy || sent || disabled} onClick={onRetry}>
            {sent ? <CircleCheck /> : <RotateCw className={cn(busy && 'animate-spin')} />}
            {sent ? 'Reencolado' : 'Reintentar'}
          </Button>
          <span className="whitespace-nowrap text-[11px] font-medium tabular-nums text-red">
            {ev.attempts}/{ev.maxAttempts} intentos
          </span>
        </div>
      </div>

      {err && (
        <div className="ml-11 mt-2 rounded-md bg-red-soft/60">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-[12px] leading-snug text-red"
          >
            {err.code && <span className="shrink-0 rounded-sm bg-red/15 px-1 font-mono text-[11px] font-semibold">{err.code}</span>}
            <span className={cn('min-w-0 flex-1 break-words', !open && 'line-clamp-2')}>{err.summary}</span>
            <ChevronDown className={cn('mt-0.5 size-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
          </button>
          {open && (
            <pre className="scroll-thin max-h-48 overflow-auto whitespace-pre-wrap break-all border-t border-red/15 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">
              {prettyRaw(err.raw)}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

/** Si el error trae JSON válido, se indenta; si no (o viene truncado), se muestra tal cual. */
function prettyRaw(raw: string): string {
  const brace = raw.indexOf('{');
  if (brace < 0) return raw;
  try {
    return `${raw.slice(0, brace).trim()}\n${JSON.stringify(JSON.parse(raw.slice(brace)), null, 2)}`.trim();
  } catch {
    return raw;
  }
}
