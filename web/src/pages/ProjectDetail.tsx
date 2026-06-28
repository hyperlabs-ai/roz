import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, GitCommitHorizontal, CircleCheck, Users, Plus, Minus, ExternalLink, X, GitBranch } from 'lucide-react';
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
import { apiGet, apiSend, type ProjectDetail as Detail } from '@/lib/api';
import { compact, relative } from '@/lib/format';
import { defaultPeriod } from '@/lib/period';
import { cn } from '@/lib/utils';

const PRIO_DOT: Record<string, string> = { urgent: 'bg-destructive', high: 'bg-warning', medium: 'bg-chart-1', low: 'bg-muted-foreground' };

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

export default function ProjectDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const isAdmin = ['admin', 'superadmin'].includes(user?.role ?? '');
  const [period, setPeriod] = useState(defaultPeriod());
  const [newRepo, setNewRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const { data, loading, reload } = useApi<Detail>(() => apiGet(`/projects/${id}`, period.range), [id, period.range.from, period.range.to]);

  async function addRepo() {
    const repo = newRepo.trim();
    if (!repo) return;
    setBusy(true);
    try {
      await apiSend('POST', `/projects/${id}/repos`, { repo });
      toast.success('Repo vinculado', { description: repo });
      setNewRepo('');
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
              <div className="flex flex-wrap gap-2">
                {data.repos.map((r) => (
                  <span key={r} className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 py-1 pl-2.5 pr-1.5 text-sm">
                    <span className="font-mono text-xs">{r.replace('hyperlabs-ai/', '')}</span>
                    {isAdmin && (
                      <button onClick={() => removeRepo(r)} className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="Desvincular">
                        <X className="size-3.5" />
                      </button>
                    )}
                  </span>
                ))}
                {!data.repos.length && <EmptyState>Sin repos vinculados</EmptyState>}
              </div>
              {isAdmin && (
                <div className="mt-3 flex max-w-sm gap-2">
                  <Input
                    value={newRepo}
                    onChange={(e) => setNewRepo(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addRepo()}
                    placeholder="nombre-del-repo (o owner/repo)"
                  />
                  <Button onClick={addRepo} disabled={busy || !newRepo.trim()}><Plus /> Vincular</Button>
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

          <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
            <div className="min-w-0 space-y-4">
              <Card className="min-w-0">
                <CardHeader><CardTitle>Contribuidores</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {data.contributors.length ? (
                    data.contributors.map((c, i) => (
                      <div key={i} className="flex items-center gap-3">
                        <UserAvatar url={c.avatarUrl} name={c.name} className="size-7" />
                        <span className="flex-1 truncate text-sm">{c.name}</span>
                        <span className="text-xs text-muted-foreground">{c.commits} commits · {compact(c.lines)} líneas</span>
                      </div>
                    ))
                  ) : <EmptyState>Sin contribuidores</EmptyState>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <CardTitle>Tickets abiertos</CardTitle>
                  <span className="text-sm text-muted-foreground">{data.openTickets.length}</span>
                </CardHeader>
                <CardContent className="space-y-1">
                  {data.openTickets.length ? (
                    data.openTickets.map((t) => (
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
                  ) : <EmptyState>Sin tickets abiertos</EmptyState>}
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

            <Card className="min-w-0 lg:col-span-2">
              <CardHeader><CardTitle>Historial de commits</CardTitle></CardHeader>
              <CardContent className="p-0">
                {!data.history.length && <EmptyState>Sin commits en este período</EmptyState>}

                {/* Desktop: tabla */}
                {data.history.length > 0 && (
                  <div className="hidden md:block">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Commit</TableHead>
                          <TableHead>Autor</TableHead>
                          <TableHead className="text-right">Cambios</TableHead>
                          <TableHead className="text-right">Fecha</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.history.map((c) => (
                          <TableRow key={c.sha}>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{c.sha}</code>
                                <span className="max-w-[36ch] truncate text-sm">
                                  {c.url && c.url !== '#' ? <a href={c.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">{c.message}<ExternalLink className="size-3 opacity-60" /></a> : c.message}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <UserAvatar url={c.avatarUrl} name={c.author ?? '—'} className="size-5" />
                                <span className="text-xs text-muted-foreground">{c.author ?? '—'}</span>
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
                        <span className="min-w-0 flex-1 text-sm leading-snug">
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
