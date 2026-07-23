import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, GitCommitHorizontal, CircleCheck, Users, Plus, Minus, ExternalLink, X, GitBranch, RefreshCw, Check, CircleAlert, Search } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { AreaTrend, RankBars } from '@/components/charts';
import { UserAvatar, EmptyState, LineDelta } from '@/components/bits';
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
import { useApi } from '@/lib/useApi';
import { useSync } from '@/sync/SyncContext';
import { apiGet, apiSend, type ProjectDetail as Detail, type RepoSyncStatus } from '@/lib/api';
import { compact, relative } from '@/lib/format';
import { usePeriod } from '@/lib/usePeriod';
import { cn } from '@/lib/utils';
import { PRIO_DOT } from '@/lib/labels';

function MiniStat({ icon, label, value, valueClassName, className }: { icon: React.ReactNode; label: string; value: string; valueClassName?: string; className?: string }) {
  return (
    <Card className={className}>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">{icon}</div>
        <div className="min-w-0">
          <div className={cn('text-xl font-bold tabular-nums', valueClassName)}>{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function syncPct(s?: RepoSyncStatus): number | null {
  return s?.totalPages ? Math.min(100, Math.round((s.pages / s.totalPages) * 100)) : null;
}

/**
 * Fila de un repo vinculado. Una sola señal de estado por vez (sin iconos repetidos): mientras
 * sincroniza muestra SOLO una barra de progreso (el botón de re-sync se oculta); al terminar, un
 * "Listo ✓" efímero (solo si la corrida es reciente, para no dejar checks permanentes); en error,
 * una etiqueta roja con reintento. En reposo, la fila queda limpia y las acciones aparecen al hover.
 */
function RepoRow({ repo, status, live, isAdmin, active, onResync, onRemove }: {
  repo: string;
  status?: RepoSyncStatus;
  live: boolean;
  isAdmin: boolean;
  active: boolean;
  onResync: () => void;
  onRemove: () => void;
}) {
  const name = repo.replace('hyperlabs-ai/', '');
  const pct = syncPct(status);
  const isError = status?.status === 'error';
  const justDone = status?.status === 'done' && live;

  return (
    <div className="group relative flex items-center gap-2 rounded-lg border bg-card px-2.5 py-2 transition-colors hover:border-primary/30 hover:bg-accent/40">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:bg-background">
        <GitBranch className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={repo}>{name}</span>

      {active ? (
        <div className="flex shrink-0 items-center gap-1.5" title={`${status?.commits ?? 0} commits · ${status?.pages ?? 0}${status?.totalPages ? `/${status.totalPages}` : ''} páginas`}>
          <div className={cn('h-1.5 w-12 overflow-hidden rounded-full bg-muted', pct == null && 'shimmer')}>
            <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-spring" style={{ width: pct != null ? `${pct}%` : '35%' }} />
          </div>
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
            <button onClick={onResync} title={isError ? 'Reintentar sincronización' : 'Re-sincronizar historial'} className="press rounded-md p-1.5 text-muted-foreground hover:bg-background hover:text-foreground">
              <RefreshCw className="size-3.5" />
            </button>
          )}
          <button onClick={onRemove} title="Desvincular" className="press rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Autocomplete propio para vincular un repo: input con búsqueda + lista flotante navegable con
 *  teclado. Reemplaza el <datalist> nativo (feo y con estilos del sistema). */
function RepoCombobox({ available, linked, busy, onAdd }: {
  available: string[];
  linked: string[];
  busy: boolean;
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
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState<string[]>([]);
  const { syncs, trigger, isActive } = useSync();
  const { data, loading, reload } = useApi<Detail>(() => apiGet(`/projects/${id}`, period.range), [id, period.range.from, period.range.to]);

  // Autocomplete: repos de la org (solo admin; una vez).
  useEffect(() => {
    if (!isAdmin) return;
    apiGet<{ repos: string[] }>('/repos/available').then((r) => setAvailable(r.repos)).catch(() => {});
  }, [isAdmin]);

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
      if (s.status === 'done' && (data?.repos ?? []).includes(s.repo) && !doneSeen.current.has(key)) {
        doneSeen.current.add(key);
        reload();
      }
    }
  }, [syncs]); // eslint-disable-line react-hooks/exhaustive-deps

  async function resyncRepo(repo: string) {
    try {
      await trigger(id!, repo);
    } catch (e: any) {
      toast.error('No se pudo re-sincronizar', { description: String(e.message ?? e) });
    }
  }

  async function linkRepo(repo: string) {
    const v = repo.trim();
    if (!v) return;
    setBusy(true);
    try {
      await apiSend('POST', `/projects/${id}/repos`, { repo: v });
      toast.success('Repo vinculado', { description: v });
      reload();
    } catch (e: any) {
      toast.error('No se pudo vincular', { description: String(e.message ?? e) });
    }
    setBusy(false);
  }

  async function removeRepo(repo: string) {
    try {
      await apiSend('DELETE', `/projects/${id}/repos?repo=${encodeURIComponent(repo)}`);
      toast.success('Repo desvinculado', { description: repo });
      reload();
    } catch (e: any) {
      toast.error('No se pudo desvincular', { description: String(e.message ?? e) });
    }
  }

  async function changeKind(kind: 'client' | 'internal') {
    try {
      await apiSend('PATCH', `/projects/${id}`, { kind });
      toast.success(kind === 'client' ? 'Marcado como Cliente' : 'Marcado como Interno');
      reload();
    } catch (e: any) {
      toast.error('No se pudo cambiar', { description: String(e.message ?? e) });
    }
  }

  return (
    <Layout title={data?.project.name ?? 'Proyecto'} subtitle={data?.project.key} actions={<PeriodPicker value={period} onChange={setPeriod} />}>
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2 text-muted-foreground">
        <Link to="/app/projects"><ArrowLeft /> Proyectos</Link>
      </Button>

      {loading || !data ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
          <Skeleton className="h-64" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <MiniStat icon={<GitCommitHorizontal className="size-[18px]" />} label="Commits" value={String(data.totals.commits)} className="col-span-2 lg:col-span-1" />
            <MiniStat icon={<Plus className="size-[18px] text-success" />} label="Líneas agregadas" value={compact(data.totals.additions)} valueClassName="text-success" />
            <MiniStat icon={<Minus className="size-[18px] text-destructive" />} label="Líneas eliminadas" value={compact(data.totals.deletions)} valueClassName="text-destructive" />
            <MiniStat icon={<CircleCheck className="size-[18px]" />} label="Tickets resueltos" value={String(data.totals.ticketsResolved)} />
            <MiniStat icon={<Users className="size-[18px]" />} label="Contribuidores" value={String(data.totals.contributors)} />
          </div>

          <Card className="mt-4">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-2">
                <CardTitle className="flex items-center gap-2"><GitBranch className="size-4" /> Repositorios</CardTitle>
                <span className="text-sm text-muted-foreground">{data.repos.length}</span>
              </div>
              {isAdmin ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">{data.project.kind === 'client' ? 'Cliente' : 'Interno'}</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => changeKind('client')}>Cliente</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => changeKind('internal')}>Interno</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Badge variant={data.project.kind === 'client' ? 'default' : 'secondary'}>
                  {data.project.kind === 'client' ? 'Cliente' : 'Interno'}
                </Badge>
              )}
            </CardHeader>
            <CardContent>
              {data.repos.length ? (
                <div className="grid gap-1.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {data.repos.map((r) => (
                    <RepoRow
                      key={r}
                      repo={r}
                      status={statusFor(r)}
                      live={liveSet.has(r)}
                      isAdmin={isAdmin}
                      active={isActive(r)}
                      onResync={() => resyncRepo(r)}
                      onRemove={() => removeRepo(r)}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState icon={<GitBranch className="size-6" />}>Sin repos vinculados</EmptyState>
              )}
              {isAdmin && (
                <div className="mt-4 border-t pt-4">
                  <RepoCombobox available={available} linked={data.repos} busy={busy} onAdd={linkRepo} />
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
                        <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">{t.identifier}</span>
                        <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                        {t.assignee && <UserAvatar url={t.assignee.avatarUrl} name={t.assignee.name} className="size-5 shrink-0" />}
                      </a>
                    ))
                  ) : <EmptyState>Sin tickets completados en este período</EmptyState>}
                </CardContent>
              </Card>

              <Card className="min-w-0">
                <CardHeader><CardTitle>Actividad por repo</CardTitle></CardHeader>
                <CardContent>
                  {data.byRepo.length ? (
                    <RankBars data={data.byRepo.map((r) => ({ label: r.repo, value: r.commits }))} color="hsl(var(--chart-4))" height={Math.max(data.byRepo.length * 30, 60)} />
                  ) : <EmptyState>Sin repos</EmptyState>}
                </CardContent>
              </Card>

              <Card className="min-w-0">
                <CardHeader><CardTitle>Tickets por estado</CardTitle></CardHeader>
                <CardContent>
                  {data.ticketsByState.length ? (
                    <RankBars data={data.ticketsByState.map((s) => ({ label: s.label, value: s.count }))} color="hsl(var(--chart-5))" height={Math.max(data.ticketsByState.length * 30, 60)} />
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
        </>
      )}
    </Layout>
  );
}
