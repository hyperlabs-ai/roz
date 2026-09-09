import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, GitCommitHorizontal, CircleCheck, Users, Plus, Minus, ExternalLink, X, GitBranch, RefreshCw, Check, CircleAlert, Search, Loader2 } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { AreaTrend, Columns } from '@/components/charts';
import { MetricCard } from '@/components/MetricCard';
import { UserAvatar, EmptyState, LineDelta, ErrorCard, Fresh, ProgressBar, RefreshButton, Revalidating } from '@/components/bits';
import { useAuth } from '@/auth/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useApi } from '@/lib/useApi';
import { useMirror } from '@/lib/useMirror';
import { useAction } from '@/lib/useAction';
import { invalidate } from '@/lib/store';
import { useSync } from '@/sync/SyncContext';
import { isSyncDone, isSyncError } from '@/sync/status';
import { apiGet, apiSend, type ProjectDetail as Detail, type RepoSyncStatus } from '@/lib/api';
import { compact, relative } from '@/lib/format';
import { usePeriod } from '@/lib/usePeriod';
import { cn } from '@/lib/utils';
import { PRIO_DOT } from '@/lib/labels';

function syncPct(s?: RepoSyncStatus): number | null {
  return s?.totalPages ? Math.min(100, Math.round((s.pages / s.totalPages) * 100)) : null;
}

/**
 * Fila de un repo vinculado. Una sola señal de estado por vez (sin iconos repetidos): mientras
 * sincroniza muestra SOLO una barra de progreso (el botón de re-sync se oculta); al terminar, un
 * "Listo ✓" efímero (solo si la corrida es reciente, para no dejar checks permanentes); en error,
 * una etiqueta roja con reintento. En reposo, la fila queda limpia y las acciones aparecen al hover.
 */
function RepoRow({ repo, status, live, isAdmin, active, busy, onResync, onRemove }: {
  repo: string;
  status?: RepoSyncStatus;
  live: boolean;
  isAdmin: boolean;
  active: boolean;
  busy: boolean;
  onResync: () => void;
  onRemove: () => void;
}) {
  const name = repo.replace('hyperlabs-ai/', '');
  const pct = syncPct(status);
  const isError = !!status && isSyncError(status);
  const justDone = !!status && isSyncDone(status) && live;

  return (
    <div className="group relative flex items-center gap-2 rounded-lg border bg-card px-2.5 py-2 transition-colors hover:border-primary/30 hover:bg-accent/40">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:bg-background">
        <GitBranch className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={repo}>{name}</span>

      {active ? (
        <div className="flex shrink-0 items-center gap-1.5" title={`${status?.commits ?? 0} commits · ${status?.pages ?? 0}${status?.totalPages ? `/${status.totalPages}` : ''} páginas`}>
          {/* `pct == null` cuando el backfill todavía no sabe cuántas páginas hay: indeterminado,
              que es justo lo que `ProgressBar` pinta con el barrido en vez de un 35% inventado. */}
          <ProgressBar pct={pct} className="h-1.5 w-12" />
          <span className="w-7 text-right text-[11px] tabular-nums text-muted-foreground">
            {status?.status === 'queued' ? '···' : pct != null ? `${pct}%` : status?.commits ?? 0}
          </span>
        </div>
      ) : justDone ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-success animate-fade-in"><Check className="size-3.5" /> Listo</span>
      ) : isError ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive" title={status?.error ?? 'Error al sincronizar'}>
          <CircleAlert className="size-3" /> Error
        </span>
      ) : null}

      {isAdmin && (
        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-accent/90 pl-1.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
          {!active && (
            <button
              onClick={onResync}
              disabled={busy}
              title={isError ? 'Reintentar sincronización' : 'Re-sincronizar historial'}
              className="press rounded-md p-1.5 text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
            </button>
          )}
          <button
            onClick={onRemove}
            disabled={busy}
            title="Desvincular"
            className="press rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Autocomplete propio para vincular un repo: input con búsqueda + lista flotante navegable con
 *  teclado. Reemplaza el <datalist> nativo (feo y con estilos del sistema). */
function RepoCombobox({ available, linked, busy, error, onAdd }: {
  available: string[];
  linked: string[];
  busy: boolean;
  /** Falló traer la lista de la org: se dice, en vez de mostrar un combo vacío sin explicación. */
  error: string | null;
  onAdd: (repo: string) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const linkedSet = new Set(linked);
    const needle = q.trim().toLowerCase();
    return available
      .filter((r) => !linkedSet.has(r))
      .filter((r) => !needle || r.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [available, q, linked]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  function submit(repo: string) {
    const v = repo.trim();
    if (!v) return;
    onAdd(v);
    setQ('');
    setOpen(false);
  }

  return (
    <div ref={boxRef} className="relative max-w-md">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((i) => Math.min(i + 1, matches.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); submit(matches[hi] ?? q); }
              else if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="Buscar repositorio…"
            className="pl-8"
          />
        </div>
        <Button onClick={() => submit(q)} disabled={busy || !q.trim()}><Plus /> Vincular</Button>
      </div>
      {error && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          No se pudo traer la lista de repos de la organización ({error}). Puedes escribir{' '}
          <span className="font-mono">org/repo</span> a mano.
        </p>
      )}
      {open && matches.length > 0 && (
        <div className="animate-fade-in-up absolute z-20 mt-1.5 w-full overflow-hidden rounded-lg border bg-popover shadow-lg">
          <ul className="scrollbar-thin max-h-64 overflow-y-auto py-1">
            {matches.map((r, i) => (
              <li key={r}>
                <button
                  type="button"
                  onMouseEnter={() => setHi(i)}
                  onClick={() => submit(r)}
                  className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors', i === hi ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60')}
                >
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{r.replace('hyperlabs-ai/', '')}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function ProjectDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const isAdmin = !!user; // control total para cualquier usuario autenticado (sin roles)
  const [period, setPeriod] = usePeriod();
  const [confirmRepo, setConfirmRepo] = useState<string | null>(null);
  const action = useAction();
  const { syncs, trigger, track, isActive } = useSync();
  const { data, loading, refetching, error, reload } = useApi<Detail>(
    () => apiGet(`/projects/${id}`, period.range),
    [id, period.range.from, period.range.to],
    { key: '/projects/detail', ttl: 60_000 },
  );

  // Espejo de los repos vinculados: vincular o desvincular sustituye UNA fila en vez de recargar la
  // consulta más pesada de la página (historial, tendencia, contribuidores, tickets).
  const repos = useMirror<string>(data?.repos, { key: (r) => r });

  /**
   * Autocomplete: repos de la org. En el backend son hasta 20 páginas SECUENCIALES a GitHub, y antes
   * se pedían en CADA montaje de esta página aunque nadie fuera a vincular nada. Ahora va por la
   * caché (10 min, compartida entre proyectos) y solo se pide cuando el panel de admin está visible.
   */
  const repoList = useApi<{ repos: string[] }>(
    () => apiGet('/repos/available'),
    [],
    { key: '/repos/available', ttl: 600_000 },
  );
  const available = isAdmin ? repoList.data?.repos ?? [] : [];

  // Cliente/Interno con override local, para que el botón responda al clic (ver `changeKind`).
  const [kindOverride, setKindOverride] = useState<'client' | 'internal' | null>(null);
  const kind = kindOverride ?? data?.project.kind ?? 'internal';
  useEffect(() => {
    // El servidor ya confirma lo que pintamos: se suelta el override para no quedarnos pegados a él.
    if (data && kindOverride && data.project.kind === kindOverride) setKindOverride(null);
  }, [data, kindOverride]);

  // Estado de sync en vivo desde el widget global (no repolleamos la página aquí); el inicial del
  // payload sirve de fallback en el primer render.
  const liveByRepo = new Map(syncs.map((s) => [s.repo, s]));
  const liveSet = new Set(syncs.map((s) => s.repo));
  const statusFor = (r: string) => liveByRepo.get(r) ?? (data?.repoSync ?? []).find((x) => x.repo === r);

  // Un ÚNICO reload cuando un repo de este proyecto termina de sincronizar: refresca totales/gráficas
  // sin el parpadeo del polling anterior (que recargaba todo cada pocos segundos).
  const doneSeen = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const s of syncs) {
      const key = `${s.repo}:${s.updatedAt}`;
      if (isSyncDone(s) && (data?.repos ?? []).includes(s.repo) && !doneSeen.current.has(key)) {
        doneSeen.current.add(key);
        // El backfill acaba de escribir commits y líneas: se revalidan las vistas que los agregan.
        // Silencioso (los datos actuales siguen en pantalla), no un reload con skeletons.
        reload();
        invalidate('/projects');
        invalidate('/overview');
        invalidate('/developers');
      }
    }
  }, [syncs]); // eslint-disable-line react-hooks/exhaustive-deps

  const resyncRepo = (repo: string) =>
    action.run(`resync:${repo}`, () => trigger(id!, repo), {
      success: { title: 'Re-sincronizando', description: 'El avance va abajo a la derecha.' },
      error: 'No se pudo re-sincronizar',
    });

  const linkRepo = (repo: string) =>
    repos.create(
      repo.trim(),
      async () => {
        const r = await apiSend<{ repo?: string }>('POST', `/projects/${id}/repos`, { repo: repo.trim() });
        // El POST YA encoló el backfill (`src/routes/dashboard.ts`); `track` solo empieza a mirarlo
        // — con `trigger` se encolaría un SEGUNDO backfill del mismo repo. Sin esto, vincular no
        // mostraba progreso alguno y parecía que no había pasado nada, mientras el historial se
        // traía en segundo plano.
        const normalized = r.repo ?? repo.trim();
        track(id!, normalized);
        return normalized; // el backend lo normaliza (minúsculas, sin URL): se adopta esa forma
      },
      {
        success: {
          title: 'Repo vinculado',
          description: 'Trayendo su historial — verás el avance abajo a la derecha (≈1 min por cada 100 commits).',
        },
        error: 'No se pudo vincular',
      },
    );

  const removeRepo = (repo: string) =>
    repos.remove(repo, () => apiSend('DELETE', `/projects/${id}/repos?repo=${encodeURIComponent(repo)}`), {
      success: { title: 'Repo desvinculado', description: repo },
      error: 'No se pudo desvincular',
    }).then(() => invalidate('/projects'));

  /** Cliente/Interno optimista: el botón cambia de texto en el frame del clic y vuelve solo si el
   *  PATCH falla. Antes descartaba el proyecto que devuelve el endpoint y recargaba la página
   *  entera, así que el botón seguía diciendo el valor viejo durante segundos. */
  const changeKind = async (next: 'client' | 'internal') => {
    const prev = kind;
    if (next === prev) return;
    setKindOverride(next);
    const ok = await action.run('kind', async () => {
      await apiSend('PATCH', `/projects/${id}`, { kind: next });
      invalidate('/projects'); // la lista y este detalle se revalidan por prefijo, en silencio
      return true;
    }, {
      success: next === 'client' ? 'Marcado como Cliente' : 'Marcado como Interno',
      error: 'No se pudo cambiar',
    });
    if (!ok) setKindOverride(prev);
  };

  return (
    <Layout
      title={data?.project.name ?? 'Proyecto'}
      subtitle={data?.project.key}
      actions={
        <>
          <RefreshButton busy={refetching} onClick={reload} />
          <PeriodPicker value={period} onChange={setPeriod} />
        </>
      }
    >
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2 text-muted-foreground">
        <Link to="/app/projects"><ArrowLeft /> Proyectos</Link>
      </Button>

      {error && <ErrorCard message={error} className="mb-4" />}

      {loading || !data ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
          <Skeleton className="h-64" />
        </div>
      ) : (
        <Revalidating active={refetching}>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            {/* `layout="row"` es la forma que tenía MiniStat; ahora la da MetricCard, así que estas
                cinco cifras ganan el count-up que solo tenían las de Overview. El tinte del icono
                sale del token, no de una clase en el SVG. */}
            <MetricCard layout="row" icon={<GitCommitHorizontal className="size-[18px]" />} label="Commits" value={data.totals.commits} className="col-span-2 lg:col-span-1" />
            <MetricCard layout="row" icon={<Plus className="size-[18px]" />} label="Líneas agregadas" value={data.totals.additions} format={compact} colorVar="--success" tone="success" />
            <MetricCard layout="row" icon={<Minus className="size-[18px]" />} label="Líneas eliminadas" value={data.totals.deletions} format={compact} colorVar="--destructive" tone="destructive" />
            <MetricCard layout="row" icon={<CircleCheck className="size-[18px]" />} label="Tickets resueltos" value={data.totals.ticketsResolved} />
            <MetricCard layout="row" icon={<Users className="size-[18px]" />} label="Contribuidores" value={data.totals.contributors} />
          </div>

          <Card className="mt-4">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-2">
                <CardTitle className="flex items-center gap-2"><GitBranch className="size-4" /> Repositorios</CardTitle>
                <span className="text-sm text-muted-foreground">{repos.items.length}</span>
              </div>
              {isAdmin ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" disabled={action.busy('kind')}>
                      {action.busy('kind') && <Loader2 className="animate-spin" />}
                      {kind === 'client' ? 'Cliente' : 'Interno'}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => changeKind('client')}>Cliente</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => changeKind('internal')}>Interno</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Badge variant={kind === 'client' ? 'default' : 'secondary'}>
                  {kind === 'client' ? 'Cliente' : 'Interno'}
                </Badge>
              )}
            </CardHeader>
            <CardContent>
              {repos.items.length ? (
                <div className="grid gap-1.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {repos.items.map((r) => (
                    // `rounded-lg` para que el anillo de "recién vinculado" calce con la fila.
                    <Fresh key={r} fresh={repos.isFresh(r)} className="rounded-lg">
                      <RepoRow
                        repo={r}
                        status={statusFor(r)}
                        live={liveSet.has(r)}
                        isAdmin={isAdmin}
                        active={isActive(r)}
                        busy={repos.isBusy(r) || action.busy(`resync:${r}`)}
                        onResync={() => resyncRepo(r)}
                        onRemove={() => setConfirmRepo(r)}
                      />
                    </Fresh>
                  ))}
                </div>
              ) : (
                <EmptyState icon={<GitBranch className="size-6" />}>Sin repos vinculados</EmptyState>
              )}
              {isAdmin && (
                <div className="mt-4 border-t pt-4">
                  <RepoCombobox
                    available={available}
                    linked={repos.items}
                    busy={repos.busyCount > 0}
                    error={repoList.error}
                    onAdd={linkRepo}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="mt-4 min-w-0">
            <CardHeader><CardTitle>Líneas cambiadas por día</CardTitle></CardHeader>
            <CardContent>
              <AreaTrend
                data={data.trend}
                series={[
                  { key: 'additions', name: 'Agregadas', color: 'hsl(var(--success))' },
                  { key: 'deletions', name: 'Eliminadas', color: 'hsl(var(--destructive))' },
                ]}
              />
            </CardContent>
          </Card>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="min-w-0 space-y-4">
              <Card className="min-w-0">
                <CardHeader><CardTitle>Contribuidores</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {data.contributors.length ? (
                    data.contributors.map((c, i) => (
                      <div key={i} className="flex items-center gap-3">
                        <UserAvatar url={c.avatarUrl} name={c.name} className="size-7 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{c.commits} commits · {compact(c.lines)} líneas</span>
                      </div>
                    ))
                  ) : <EmptyState>Sin contribuidores</EmptyState>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <CardTitle>Tickets completados</CardTitle>
                  <span className="text-sm text-muted-foreground">{data.resolvedTickets.length}</span>
                </CardHeader>
                <CardContent className="max-h-[24rem] space-y-1 overflow-y-auto scroll-thin pr-1">
                  {data.resolvedTickets.length ? (
                    data.resolvedTickets.map((t) => (
                      <a
                        key={t.id}
                        href={t.url && t.url !== '#' ? t.url : undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-2.5 rounded-md px-1 py-1.5 hover:bg-accent"
                      >
                        <span className={cn('size-2 shrink-0 rounded-full', PRIO_DOT[t.priority ?? ''] ?? 'bg-muted')} title={t.priority ?? 'sin prioridad'} />
                        {/* Sin ancho fijo y sin envolver: `w-14` no alcanzaba para
                            `HYPERFLOW-454` y el identificador partía en dos renglones, que es lo
                            que rompía la fila. El título de al lado ya absorbe el sobrante con su
                            `flex-1 truncate`, y truncar el identificador no es opción: lo que se
                            recortaría es el número, que es justo lo que identifica al ticket. */}
                        <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-foreground">{t.identifier}</span>
                        <span className="min-w-0 flex-1 truncate text-sm">{t.name}</span>
                        {t.assignee && <UserAvatar url={t.assignee.avatarUrl} name={t.assignee.name} className="size-5 shrink-0" />}
                      </a>
                    ))
                  ) : <EmptyState>Sin tickets completados en este período</EmptyState>}
                </CardContent>
              </Card>

              <Card className="flex min-w-0 flex-col">
                <CardHeader><CardTitle>Actividad por repo</CardTitle></CardHeader>
                <CardContent className="flex flex-1 flex-col">
                  {data.byRepo.length ? (
                    // El nombre corto del repo: `hyperlabs-ai/hyperflow-app` no cabe como
                    // etiqueta de eje, y el prefijo es el mismo en todos, así que no distingue.
                    <Columns
                      fill
                      topN={5}
                      color="hsl(var(--chart-4))"
                      data={data.byRepo.map((r) => ({ label: r.repo.split('/').pop() ?? r.repo, value: r.commits }))}
                    />
                  ) : <EmptyState>Sin repos</EmptyState>}
                </CardContent>
              </Card>

              <Card className="flex min-w-0 flex-col">
                <CardHeader><CardTitle>Tickets por estado</CardTitle></CardHeader>
                <CardContent className="flex flex-1 flex-col">
                  {data.ticketsByStatus.length ? (
                    <Columns
                      fill
                      sort={false}
                      color="hsl(var(--chart-5))"
                      data={data.ticketsByStatus.map((s) => ({ label: s.label, value: s.count }))}
                    />
                  ) : <EmptyState>Sin tickets</EmptyState>}
                </CardContent>
              </Card>
            </div>

            <Card className="min-w-0 lg:col-span-2 lg:flex lg:flex-col">
              <CardHeader><CardTitle>Historial de commits</CardTitle></CardHeader>
              {/* relative + tabla en absolute (abajo): saca la tabla del flujo para que la altura de
                  la fila la marque la columna IZQUIERDA; el Historial se estira a ella y scrollea. */}
              <CardContent className="p-0 lg:relative lg:min-h-0 lg:flex-1">
                {!data.history.length && <EmptyState>Sin commits en este período</EmptyState>}

                {/* Desktop: tabla. En lg llena el alto de la card (= altura de la izquierda) con scroll
                    interno y header fijo, así ambas columnas terminan a la misma altura. */}
                {data.history.length > 0 && (
                  <div className="hidden md:block lg:absolute lg:inset-0 lg:[&>div]:h-full">
                    <Table className="table-fixed">
                      <TableHeader className="sticky top-0 z-10 bg-card">
                        <TableRow>
                          <TableHead>Commit</TableHead>
                          <TableHead className="w-32">Autor</TableHead>
                          <TableHead className="w-24 text-right">Cambios</TableHead>
                          <TableHead className="w-24 text-right">Fecha</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.history.map((c) => (
                          <TableRow key={c.sha}>
                            <TableCell>
                              <div className="flex min-w-0 items-center gap-2">
                                <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{c.sha}</code>
                                {c.url && c.url !== '#' ? (
                                  <a href={c.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:underline">
                                    <span className="truncate text-sm">{c.message}</span>
                                    <ExternalLink className="size-3 shrink-0 opacity-60" />
                                  </a>
                                ) : (
                                  <span className="truncate text-sm">{c.message}</span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex min-w-0 items-center gap-2">
                                <UserAvatar url={c.avatarUrl} name={c.author ?? '—'} className="size-5 shrink-0" />
                                <span className="truncate text-xs text-muted-foreground">{c.author ?? '—'}</span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right"><LineDelta additions={c.additions} deletions={c.deletions} /></TableCell>
                            <TableCell className="text-right text-xs text-muted-foreground">{relative(c.committedAt)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {/* Móvil: lista compacta */}
                <div className="divide-y md:hidden">
                  {data.history.map((c) => (
                    <div key={c.sha} className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <code className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{c.sha}</code>
                        <span className="min-w-0 flex-1 break-words text-sm leading-snug line-clamp-2">
                          {c.url && c.url !== '#' ? <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">{c.message}</a> : c.message}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                        <UserAvatar url={c.avatarUrl} name={c.author ?? '—'} className="size-4" />
                        <span className="truncate">{c.author ?? '—'}</span>
                        <span className="ml-auto shrink-0"><LineDelta additions={c.additions} deletions={c.deletions} /></span>
                        <span className="shrink-0">· {relative(c.committedAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </Revalidating>
      )}

      {/* Desvincular un repo corta su vínculo con el proyecto (y su historial atribuido), así que
          ahora se confirma. Antes era un clic directo, sin `busy`: un doble clic mandaba dos DELETE. */}
      <AlertDialog open={!!confirmRepo} onOpenChange={(v) => !v && setConfirmRepo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Desvincular {confirmRepo}?</AlertDialogTitle>
            <AlertDialogDescription>
              El repo deja de contarse en este proyecto. Su historial ya reconciliado no se borra, y
              puedes volver a vincularlo cuando quieras.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                const r = confirmRepo!;
                void removeRepo(r).finally(() => setConfirmRepo(null));
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Desvincular
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
