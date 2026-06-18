import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, GitCommitHorizontal, CircleCheck, Timer, Code2, FolderGit2 } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { MetricCard } from '@/components/MetricCard';
import { AreaTrend, RankBars } from '@/components/charts';
import { UserAvatar, EmptyState, StateBadge, LineDelta } from '@/components/bits';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/lib/useApi';
import { apiGet, type DeveloperProfile as Profile } from '@/lib/api';
import { compact, hours, relative } from '@/lib/format';
import { comparisonRange, defaultPeriod } from '@/lib/period';

export default function DeveloperProfile() {
  const { id } = useParams();
  const [period, setPeriod] = useState(defaultPeriod());
  const compare = useMemo(() => comparisonRange(period.range, period.compare), [period.range, period.compare]);
  const { data, loading, error } = useApi<Profile>(
    () => apiGet(`/developers/${id}`, period.range, compare),
    [id, period.range.from, period.range.to, compare?.from, compare?.to],
  );

  return (
    <Layout
      title={data?.dev.name ?? 'Developer'}
      subtitle={data?.dev.githubLogin ? `@${data.dev.githubLogin}` : undefined}
      actions={<PeriodPicker value={period} onChange={setPeriod} />}
    >
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2 text-muted-foreground">
        <Link to="/developers"><ArrowLeft /> Developers</Link>
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
            <CardContent className="flex items-center gap-4 py-5">
              <UserAvatar url={data.dev.avatarUrl} name={data.dev.name} className="size-14" />
              <div>
                <div className="text-lg font-semibold">{data.dev.name}</div>
                <div className="text-sm text-muted-foreground">{data.dev.email ?? '—'}</div>
              </div>
              <div className="ml-auto text-right">
                <div className="text-xs text-muted-foreground">Disponibilidad</div>
                <div className="text-lg font-semibold">{Math.round(data.dev.availability * 100)}%</div>
              </div>
            </CardContent>
          </Card>

          <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard label="Commits" value={data.kpis.commits.value} metric={data.kpis.commits} icon={GitCommitHorizontal} spark={data.commitTrend} />
            <MetricCard label="Tickets resueltos" value={data.kpis.ticketsResolved.value} metric={data.kpis.ticketsResolved} icon={CircleCheck} />
            <MetricCard label="Cycle time" value={data.kpis.avgCycleTimeHours.value} metric={data.kpis.avgCycleTimeHours} icon={Timer} invert format={hours} />
            <MetricCard label="Líneas cambiadas" value={data.kpis.linesChanged.value} metric={data.kpis.linesChanged} icon={Code2} format={compact} />
          </div>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Commits por día</CardTitle>
            </CardHeader>
            <CardContent>
              <AreaTrend data={data.commitTrend} series={[{ key: 'commits', name: 'Commits', color: 'hsl(var(--chart-1))' }]} height={200} />
            </CardContent>
          </Card>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><FolderGit2 className="size-4" /> Proyectos</CardTitle></CardHeader>
              <CardContent>
                {data.projects.length ? <RankBars data={data.projects.map((p) => ({ label: p.name, value: p.commits }))} height={160} /> : <EmptyState>Sin actividad</EmptyState>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Repos</CardTitle></CardHeader>
              <CardContent>
                {data.repos.length ? <RankBars data={data.repos.map((r) => ({ label: r.repo.split('/')[1] ?? r.repo, value: r.commits }))} color="hsl(var(--chart-4))" height={160} /> : <EmptyState>Sin actividad</EmptyState>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Skills</CardTitle></CardHeader>
              <CardContent>
                {data.skills.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {data.skills.map((s) => <Badge key={s.skillId} variant="default">{s.tag} · {s.level}</Badge>)}
                  </div>
                ) : <EmptyState>Sin skills asignadas</EmptyState>}
              </CardContent>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Tickets</CardTitle>
                <CardDescription>{data.tickets.inProgress.length} en curso · {data.tickets.open.length} abiertos · {data.tickets.resolved.length} resueltos</CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="active">
                  <TabsList>
                    <TabsTrigger value="active">Activos</TabsTrigger>
                    <TabsTrigger value="resolved">Resueltos</TabsTrigger>
                  </TabsList>
                  <TabsContent value="active"><TicketList tickets={[...data.tickets.inProgress, ...data.tickets.open]} /></TabsContent>
                  <TabsContent value="resolved"><TicketList tickets={data.tickets.resolved} /></TabsContent>
                </Tabs>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Actividad reciente</CardTitle></CardHeader>
              <CardContent>
                {data.activity.length ? (
                  <div className="space-y-0.5">
                    {data.activity.map((a, i) => (
                      <div key={i} className="flex items-center gap-3 border-b py-2 last:border-0">
                        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
                          {a.type === 'commit' ? <GitCommitHorizontal className="size-3.5" /> : <CircleCheck className="size-3.5 text-success" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{a.title}</div>
                          {a.type === 'commit' && <LineDelta additions={a.additions} deletions={a.deletions} />}
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
    </Layout>
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
