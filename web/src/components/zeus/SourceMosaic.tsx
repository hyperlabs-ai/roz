// Mosaico de los repos que zeus indexa: una tesela por repo, agrupadas por proyecto. El estado de
// cada una es un punto (al día / en cola / con error / sin sincronizar); el error se lee al pasar y
// completo al abrirla. Arriba, las cifras del conjunto, un filtro rápido y la búsqueda.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, GitBranch, RotateCw, Search, X } from 'lucide-react';
import { ProjectIcon } from '@/components/avatars';
import { RefreshButton } from '@/components/bits';
import { IntegrationIcon } from '@/components/brand';
import { fold } from '@/components/projects/project-ui';
import { Segmented } from '@/components/pulse/roz-v2';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ZeusSource } from '@/lib/zeus';
import { Figure, ago, dateTime } from './zeus-ui';

type Filter = 'all' | 'docs' | 'empty' | 'error';
type Status = 'error' | 'pending' | 'ok' | 'never';

const TILE_MIN = 158;
const GAP = 8;
const GROUP_PAD = 6;
const NO_PROJECT = '__sin_proyecto__';

const statusOf = (s: ZeusSource): Status => (s.lastError ? 'error' : s.pending ? 'pending' : s.lastSyncedAt ? 'ok' : 'never');
const STATUS: Record<Status, { label: string; variant: BadgeVariant; dot: string }> = {
  error: { label: 'Con error', variant: 'bad', dot: 'bg-red' },
  pending: { label: 'En cola', variant: 'warn', dot: 'animate-pulse bg-orange' },
  ok: { label: 'Al día', variant: 'ok', dot: 'bg-green' },
  never: { label: 'Sin sincronizar', variant: 'neutral', dot: 'border border-faint' },
};
/** A estos les hace falta una pasada: fallaron o nunca se han leído (y no están ya en cola). */
export const needsSync = (s: ZeusSource): boolean => !s.pending && (!!s.lastError || !s.lastSyncedAt);
const shortName = (repo: string): string => repo.slice(repo.indexOf('/') + 1);
const docs = (n: number): string => `${n} ${n === 1 ? 'documento' : 'documentos'}`;

function Tile({ source, busy, onOpen, onSync }: { source: ZeusSource; busy: boolean; onOpen: () => void; onSync: () => void }) {
  const st = statusOf(source);
  const working = busy || source.pending;
  const empty = source.nodeCount === 0;
  return (
    <div
      className={cn(
        'access-tile group/tile relative min-w-0 rounded-md border bg-card',
        st === 'error' && 'border-red/45 bg-red-soft',
        st !== 'error' && empty && 'border-dashed',
      )}
    >
      <Tooltip delayDuration={350}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            className="grid w-full gap-1.5 rounded-md px-2.5 pb-2 pt-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${source.repo}: ${STATUS[st].label}, ${docs(source.nodeCount)}`}
          >
            <span className="flex min-w-0 items-center gap-1.5 pr-5">
              <span className={cn('size-2 shrink-0 rounded-full', STATUS[st].dot)} />
              <span className={cn('truncate font-mono text-[12px] font-medium leading-tight', empty && st !== 'error' && 'text-muted-foreground')}>{shortName(source.repo)}</span>
            </span>
            <span className="flex h-[15px] min-w-0 items-center justify-between gap-2 text-[10.5px] text-faint">
              <span className="flex min-w-0 items-center gap-1">
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate font-mono">{source.defaultBranch ?? '—'}</span>
              </span>
              {empty ? (
                <span className="shrink-0">vacío</span>
              ) : (
                <span className="shrink-0 tabular-nums">
                  <b className="text-[15px] font-semibold leading-none tracking-[-0.02em] text-foreground">{source.nodeCount}</b> doc{source.nodeCount === 1 ? '' : 's'}
                </span>
              )}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[300px] px-3 py-2 font-normal">
          <span className="grid gap-1">
            <span className="font-mono text-[11px] font-medium">{source.repo}</span>
            <span className="text-[11px] opacity-80">
              {STATUS[st].label} · {docs(source.nodeCount)} · {source.lastSyncedAt ? `leído ${ago(source.lastSyncedAt)}` : 'nunca leído'}
            </span>
            {source.lastError && <span className="line-clamp-3 break-words text-[11px]">{source.lastError}</span>}
          </span>
        </TooltipContent>
      </Tooltip>
      <button
        type="button"
        onClick={onSync}
        disabled={working}
        data-on={working ? '1' : undefined}
        className="access-sync absolute right-1 top-1 grid size-6 place-items-center rounded-[5px] text-muted-foreground hover:bg-panel hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
        aria-label={`Sincronizar ${source.repo}`}
        title={working ? 'En cola' : 'Sincronizar ahora'}
      >
        <RotateCw className={cn('size-3.5', working && 'animate-spin text-orange')} />
      </button>
    </div>
  );
}

function GhostTile() {
  return (
    <div aria-hidden className="grid gap-2.5 rounded-md border border-dashed px-2.5 pb-2.5 pt-2.5">
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-full border border-dashed border-faint" />
        <span className="h-2 w-2/3 rounded-full bg-panel" />
      </span>
      <span className="h-1.5 w-1/3 rounded-full bg-panel" />
    </div>
  );
}

export function SourceMosaic({
  sources,
  loading,
  error,
  refetching,
  onReload,
  isBusy,
  bulkBusy,
  onSync,
  onSyncMany,
  className,
}: {
  sources: ZeusSource[] | null;
  loading: boolean;
  error: string | null;
  refetching: boolean;
  onReload: () => void;
  isBusy: (repo: string) => boolean;
  bulkBusy: boolean;
  onSync: (repo: string) => void;
  onSyncMany: (repos: string[]) => void;
  className?: string;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [openRepo, setOpenRepo] = useState<string | null>(null);
  const list = useMemo(() => sources ?? [], [sources]);

  const counts = useMemo(
    () => ({
      all: list.length,
      docs: list.filter((s) => s.nodeCount > 0).length,
      empty: list.filter((s) => s.nodeCount === 0).length,
      error: list.filter((s) => s.lastError).length,
      nodes: list.reduce((n, s) => n + s.nodeCount, 0),
      pending: list.filter((s) => s.pending).length,
    }),
    [list],
  );
  const stale = useMemo(() => list.filter(needsSync), [list]);

  const shown = useMemo(() => {
    const needle = fold(q.trim());
    return list.filter(
      (s) =>
        (filter === 'all' || (filter === 'docs' && s.nodeCount > 0) || (filter === 'empty' && s.nodeCount === 0) || (filter === 'error' && !!s.lastError)) &&
        (!needle || fold(`${s.repo} ${s.projectKey ?? ''} ${s.defaultBranch ?? ''}`).includes(needle)),
    );
  }, [list, filter, q]);

  const groups = useMemo(() => {
    const m = new Map<string, { key: string | null; projectId: string | null; items: ZeusSource[] }>();
    for (const s of shown) {
      const id = s.projectKey ?? NO_PROJECT;
      const g = m.get(id) ?? { key: s.projectKey, projectId: s.projectId, items: [] };
      g.items.push(s);
      m.set(id, g);
    }
    return [...m.entries()]
      .map(([id, g]) => ({ id, ...g, items: g.items.sort((a, b) => b.nodeCount - a.nodeCount || a.repo.localeCompare(b.repo)) }))
      // Los grupos grandes primero; los de un solo repo rellenan los huecos (rejilla densa).
      .sort((a, b) => b.items.length - a.items.length || (a.key ?? '~').localeCompare(b.key ?? '~'));
  }, [shown]);

  // Columnas del mosaico según el ancho real: cada grupo ocupa tantas como repos tenga.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(6);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setCols(Math.max(1, Math.floor((el.clientWidth + GAP) / (TILE_MIN + GROUP_PAD * 2 + 2 + GAP))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const open = openRepo ? list.find((s) => s.repo === openRepo) ?? null : null;
  const openStatus = open ? statusOf(open) : 'ok';
  const openWorking = open ? isBusy(open.repo) || open.pending : false;
  const ready = sources !== null;
  const dash = (v: number) => (ready ? v : '–');

  return (
    <Card className={cn('flex min-h-0 flex-col overflow-hidden', className)} aria-busy={loading}>
      <div className="grid shrink-0 grid-cols-2 gap-px border-b bg-border sm:grid-cols-4">
        <Figure value={dash(counts.all)} label="Repos indexados" />
        <Figure value={dash(counts.nodes)} label="Documentos" accent />
        <Figure value={<span className={cn(counts.error > 0 && 'text-red')}>{dash(counts.error)}</span>} label="Con error" />
        <Figure value={<span className={cn(ready && 'text-muted-foreground')}>{dash(counts.empty)}</span>} label="Vacíos" />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Todos', count: counts.all },
            { value: 'docs', label: 'Con documentos', count: counts.docs },
            { value: 'empty', label: 'Vacíos', count: counts.empty },
            { value: 'error', label: 'Con error', count: counts.error },
          ]}
        />
        <Input
          fieldSize="sm"
          wrapperClassName="w-52 max-w-full"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQ('')}
          placeholder="Buscar repo o proyecto…"
          aria-label="Buscar repo o proyecto"
          leading={<Search />}
          trailing={
            q ? (
              <button type="button" onClick={() => setQ('')} aria-label="Limpiar búsqueda" className="grid size-6 place-items-center rounded-sm text-faint hover:text-foreground"><X className="size-3.5" /></button>
            ) : undefined
          }
        />
        <div className="ml-auto flex items-center gap-1.5">
          {counts.pending > 0 && <span className="flex items-center gap-1.5 whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground"><span className="size-2 animate-pulse rounded-full bg-orange" /> {counts.pending} en cola</span>}
          {stale.length > 0 && (
            <Button variant="secondary" size="sm" disabled={bulkBusy} onClick={() => onSyncMany(stale.map((s) => s.repo))} title="Pide una pasada, repo por repo, a los que fallaron o nunca se han leído">
              <RotateCw className={bulkBusy ? 'animate-spin' : undefined} />
              Reintentar {stale.length}
            </Button>
          )}
          <RefreshButton busy={refetching} onClick={onReload} />
        </div>
      </div>

      {error && (
        <p className="flex shrink-0 items-start gap-2 border-b bg-red-soft px-4 py-2 text-xs text-red">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}

      <div ref={wrapRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3 max-lg:max-h-[70dvh]">
        {!ready || list.length === 0 ? (
          <>
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {Array.from({ length: cols * 3 }, (_, i) => <GhostTile key={i} />)}
            </div>
            {ready && (
              <p className="mt-3 text-[12.5px] text-muted-foreground">
                {error ? 'No se pudieron cargar las fuentes.' : 'Ningún repo vinculado todavía. Vincula un repo a un proyecto (en Proyectos) y zeus empezará a indexarlo.'}
              </p>
            )}
          </>
        ) : groups.length === 0 ? (
          <div className="grid gap-3">
            <p className="text-[12.5px] text-muted-foreground">
              Ningún repo coincide.{' '}
              <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => { setQ(''); setFilter('all'); }}>Quitar filtros</button>
            </p>
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {Array.from({ length: cols }, (_, i) => <GhostTile key={i} />)}
            </div>
          </div>
        ) : (
          <div className="grid grid-flow-row-dense gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {groups.map((g) => {
              const span = Math.min(g.items.length, cols);
              const total = g.items.reduce((n, s) => n + s.nodeCount, 0);
              return (
                <section key={g.id} className="min-w-0 rounded-lg border bg-sidebar p-1.5" style={{ gridColumn: `span ${span}` }} aria-label={g.key ?? 'Sin proyecto'}>
                  <header className="flex min-w-0 items-center gap-1.5 px-1 pb-1.5 pt-0.5">
                    <ProjectIcon id={g.projectId} size="xs" />
                    <h3 className="label-caps min-w-0 truncate text-[10.5px] text-foreground/80">{g.key ?? 'Sin proyecto'}</h3>
                    {g.items.length > 1 && <span className="label-caps ml-auto shrink-0 whitespace-nowrap text-[10px] tabular-nums">{g.items.length} repos · {total} docs</span>}
                  </header>
                  <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${span}, minmax(0, 1fr))` }}>
                    {g.items.map((s) => (
                      <Tile key={s.repo} source={s} busy={isBusy(s.repo)} onOpen={() => setOpenRepo(s.repo)} onSync={() => onSync(s.repo)} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      <p className="shrink-0 border-t bg-sidebar px-4 py-2 text-[11.5px] leading-snug text-muted-foreground">
        Zeus importa de la rama por defecto de cada repo los ADR, las specs y cambios de OpenSpec, el diseño y las reglas que aún no tiene. Lo ya importado vive en zeus y se edita aquí; el repo no lo pisa.
      </p>

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpenRepo(null)}>
        <DialogContent className="sm:max-w-lg">
          {open && (
            <>
              <DialogHeader eyebrow={`Zeus · repo indexado${open.projectKey ? ` · ${open.projectKey}` : ''}`}>
                <DialogTitle className="flex min-w-0 items-center gap-2">
                  <IntegrationIcon name="github" size="sm" framed />
                  <span className="min-w-0 break-all font-mono text-[14px]">{open.repo}</span>
                </DialogTitle>
                <DialogDescription>
                  {open.projectKey ? 'De su rama por defecto salen los documentos que zeus conoce de este repo.' : 'Este repo no está vinculado a ningún proyecto.'}
                </DialogDescription>
              </DialogHeader>

              <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
                {[
                  ['Estado', <Badge key="s" variant={STATUS[openStatus].variant} dot={openStatus !== 'never'}>{STATUS[openStatus].label}</Badge>],
                  ['Documentos', <span key="d" className="text-[15px] font-semibold tabular-nums">{open.nodeCount}</span>],
                  ['Rama', <span key="b" className="truncate font-mono text-[12px]">{open.defaultBranch ?? '—'}</span>],
                  ['Última lectura', <span key="l" className="text-[12.5px] tabular-nums" title={dateTime(open.lastSyncedAt)}>{open.lastSyncedAt ? ago(open.lastSyncedAt) : 'nunca'}</span>],
                ].map(([label, value]) => (
                  <div key={label as string} className="grid min-w-0 content-start gap-1.5 bg-card px-3 py-2.5">
                    <dt className="label-caps text-[10px]">{label}</dt>
                    <dd className="flex min-w-0 items-center">{value}</dd>
                  </div>
                ))}
              </dl>

              {open.lastError && (
                <div className="grid gap-1.5">
                  <span className="label-caps text-red">Último error</span>
                  <pre className="scroll-thin max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-red-soft px-3 py-2 font-mono text-[11.5px] leading-relaxed text-red">{open.lastError.trim()}</pre>
                </div>
              )}

              <DialogFooter className="gap-2">
                <Button variant="secondary" onClick={() => setOpenRepo(null)}>Cerrar</Button>
                <Button disabled={openWorking} onClick={() => onSync(open.repo)}>
                  <RotateCw className={openWorking ? 'animate-spin' : undefined} />
                  {open.pending ? 'En cola' : 'Sincronizar'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
