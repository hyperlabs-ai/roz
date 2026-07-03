import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, GitCommitHorizontal, CircleCheck, Timer, Code2, FolderGit2, Pencil, GitBranch } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { MetricCard } from '@/components/MetricCard';
import { AreaTrend, FocusRadar } from '@/components/charts';
import { UserAvatar, EmptyState, StateBadge, LineDelta, SkillMeters } from '@/components/bits';
import { AvailabilityControl } from '@/components/AvailabilityControl';
import { DeveloperDialog } from '@/components/DeveloperDialog';
import { GithubContributions } from '@/components/GithubContributions';
import { useAuth } from '@/auth/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/lib/useApi';
import { apiGet, type DeveloperProfile as Profile } from '@/lib/api';
import { compact, hours, relative } from '@/lib/format';
import { comparisonRange } from '@/lib/period';
import { usePeriod } from '@/lib/usePeriod';

export default function DeveloperProfile() {
  const { id } = useParams();
  const [period, setPeriod] = usePeriod();
  const [editOpen, setEditOpen] = useState(false);
  const { user } = useAuth();
  const isAdmin = ['admin', 'superadmin'].includes(user?.role ?? '');
  const compare = useMemo(() => comparisonRange(period.range, period.compare), [period.range, period.compare]);
  const { data, loading, error, reload } = useApi<Profile>(
    () => apiGet(`/developers/${id}`, period.range, compare),
    [id, period.range.from, period.range.to, compare?.from, compare?.to],
  );

  return (
    <Layout
      title={data?.dev.name ?? 'Developer'}
      subtitle={data?.dev.githubLogin ? `@${data.dev.githubLogin}` : undefined}
      actions={
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil /> Editar credenciales
            </Button>
          )}
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
      }
    >
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2 text-muted-foreground">
        <Link to="/app/developers"><ArrowLeft /> Developers</Link>
      </Button>

      {error && <Card><CardContent className="py-4 text-sm text-destructive">{error}</CardContent></Card>}
      {loading || !data ? (
        <div className="space-y-4">
          <Skeleton className="h-20" />
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
        </div>
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center">
              <div className="flex min-w-0 items-center gap-4">
                <UserAvatar url={data.dev.avatarUrl} name={data.dev.name} className="size-14 shrink-0" />
                <div className="min-w-0">
                  <div className="truncate text-lg font-semibold">{data.dev.name}</div>
                  <div className="truncate text-sm text-muted-foreground">{data.dev.email ?? '—'}</div>
                </div>
              </div>
              <div className="sm:ml-auto sm:shrink-0">
                <AvailabilityControl devId={data.dev.id} value={data.dev.availability} />
              </div>
            </CardContent>
          </Card>

          <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard label="Commits" value={data.kpis.commits.value} metric={data.kpis.commits} icon={GitCommitHorizontal} colorVar="--chart-1" />
            <MetricCard label="Líneas cambiadas" value={data.kpis.linesChanged.value} metric={data.kpis.linesChanged} icon={Code2} format={compact} colorVar="--chart-4" />
            <MetricCard label="Tickets resueltos" value={data.kpis.ticketsResolved.value} metric={data.kpis.ticketsResolved} icon={CircleCheck} colorVar="--chart-3" />
            <MetricCard label="Cycle time" value={data.kpis.avgCycleTimeHours.value} metric={data.kpis.avgCycleTimeHours} icon={Timer} invert format={hours} colorVar="--chart-5" />
          </div>

          <GithubContributions devId={data.dev.id} />

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Commits por día</CardTitle>
            </CardHeader>
            <CardContent>
              <AreaTrend data={data.commitTrend} series={[{ key: 'commits', name: 'Commits', color: 'hsl(var(--chart-1))' }]} height={200} />
            </CardContent>
          </Card>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="min-w-0 lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><FolderGit2 className="size-4" /> Foco por proyecto</CardTitle>
                <CardDescription>Dónde se concentra el trabajo (commits)</CardDescription>
              </CardHeader>
              <CardContent>
                {data.projects.length ? <FocusRadar data={data.projects.map((p) => ({ label: p.name, value: p.commits }))} height={340} /> : <EmptyState>Sin actividad</EmptyState>}
              </CardContent>
            </Card>
            <Card className="min-w-0">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>Repos</CardTitle>
                {data.repos.length > 0 && <span className="text-sm text-muted-foreground tabular-nums">{data.repos.length}</span>}
              </CardHeader>
              <CardContent>
                {data.repos.length ? <RepoBars repos={data.repos} /> : <EmptyState>Sin actividad</EmptyState>}
              </CardContent>
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Skills</CardTitle>
              <CardDescription>Nivel de dominio por capacidad (1–5)</CardDescription>
            </CardHeader>
            <CardContent>
              <SkillMeters skills={data.skills.map((s) => ({ tag: s.tag, level: s.level }))} />
            </CardContent>
          </Card>

          {/* Fila a dos columnas: ambas cards se estiran a la misma altura (grid) y su contenido
              hace scroll interno; cap compartido para cuando ambas son muy largas. Solo en desktop. */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0 lg:flex lg:max-h-[480px] lg:flex-col">
              <CardHeader>
                <CardTitle>Tickets</CardTitle>
                <CardDescription>{data.tickets.inProgress.length} en curso · {data.tickets.open.length} abiertos · {data.tickets.resolved.length} resueltos</CardDescription>
              </CardHeader>
              <CardContent className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
                <Tabs defaultValue="active" className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
                  <TabsList className="lg:mx-auto lg:flex lg:w-fit lg:shrink-0">
                    <TabsTrigger value="active">Activos</TabsTrigger>
                    <TabsTrigger value="resolved">Resueltos</TabsTrigger>
                  </TabsList>
                  <TabsContent value="active" className="scrollbar-thin lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1"><TicketList tickets={[...data.tickets.inProgress, ...data.tickets.open]} /></TabsContent>
                  <TabsContent value="resolved" className="scrollbar-thin lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1"><TicketList tickets={data.tickets.resolved} /></TabsContent>
                </Tabs>
              </CardContent>
            </Card>

            <Card className="min-w-0 lg:flex lg:max-h-[480px] lg:flex-col">
              <CardHeader><CardTitle>Actividad reciente</CardTitle></CardHeader>
              <CardContent className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
                {data.activity.length ? (
                  <div className="space-y-0.5 scrollbar-thin lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1">
                    {data.activity.map((a, i) => (
                      <div key={i} className="flex items-center gap-3 border-b py-2 last:border-0">
                        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
                          {a.type === 'commit' ? <GitCommitHorizontal className="size-3.5" /> : <CircleCheck className="size-3.5 text-success" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{a.title}</div>
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
                  </div>
                ) : <EmptyState>Sin actividad en este período</EmptyState>}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      <DeveloperDialog devId={id} open={editOpen} onOpenChange={setEditOpen} onSaved={reload} />
    </Layout>
  );
}

/**
 * Repos del dev como barras proporcionales. Altura acotada con scroll: sin importar cuántos repos
 * haya, el card no se estira (a diferencia de RankBars, cuya altura crecía con el nº de repos).
 */
function RepoBars({ repos }: { repos: Profile['repos'] }) {
  const sorted = [...repos].sort((a, b) => b.commits - a.commits);
  const max = sorted[0]?.commits || 1;
  return (
    <div className="space-y-2.5 lg:max-h-[340px] lg:overflow-y-auto lg:pr-3 lg:[scrollbar-color:hsl(var(--border))_transparent] lg:[scrollbar-width:thin] lg:[&::-webkit-scrollbar-thumb]:rounded-full lg:[&::-webkit-scrollbar-thumb]:bg-border hover:lg:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/40 lg:[&::-webkit-scrollbar-track]:bg-transparent lg:[&::-webkit-scrollbar]:w-1.5">
      {sorted.map((r) => {
        const name = r.repo.split('/')[1] ?? r.repo;
        return (
          <div key={r.repo} className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-medium">{name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{r.commits}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${(r.commits / max) * 100}%`, background: 'hsl(var(--chart-4))' }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TicketList({ tickets }: { tickets: Profile['tickets']['open'] }) {
  if (!tickets.length) return <EmptyState>Sin tickets</EmptyState>;
  return (
    <div className="space-y-0.5">
      {tickets.map((t) => (
        <div key={t.id} className="flex items-center gap-3 border-b py-2 last:border-0">
          <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">{t.identifier}</span>
          <span className="min-w-0 flex-1 truncate text-sm">
            {t.url && t.url !== '#' ? <a href={t.url} target="_blank" rel="noreferrer" className="hover:underline">{t.title}</a> : t.title}
          </span>
          <StateBadge state={t.state} />
        </div>
      ))}
    </div>
  );
}
