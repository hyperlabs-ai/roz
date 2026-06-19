import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitCommitHorizontal, CircleCheck, Users, Timer, Code2, TriangleAlert, ShieldCheck, Briefcase, Building2 } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { MetricCard } from '@/components/MetricCard';
import { AreaTrend, RankBars, Donut } from '@/components/charts';
import { UserAvatar, EmptyState } from '@/components/bits';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/useApi';
import { apiGet, type Overview as OverviewData } from '@/lib/api';
import { compact, hours } from '@/lib/format';
import { comparisonRange, defaultPeriod } from '@/lib/period';
import { cn } from '@/lib/utils';

const STATE_LABEL: Record<string, string> = {
  backlog: 'Backlog', unstarted: 'Sin empezar', triage: 'Triage', started: 'En curso',
  in_progress: 'En curso', completed: 'Completado', done: 'Hecho', canceled: 'Cancelado',
};

export default function Overview() {
  const [period, setPeriod] = useState(defaultPeriod());
  const nav = useNavigate();
  const compare = useMemo(() => comparisonRange(period.range, period.compare), [period.range, period.compare]);
  const { data, loading, error } = useApi<OverviewData>(
    () => apiGet('/overview', period.range, compare),
    [period.range.from, period.range.to, compare?.from, compare?.to],
  );

  return (
    <Layout title="Resumen" subtitle="El pulso del equipo en un vistazo" actions={<PeriodPicker value={period} onChange={setPeriod} />}>
      {error && <Card><CardContent className="py-4 text-sm text-destructive">{error}</CardContent></Card>}

      {loading || !data ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <MetricCard label="Commits" value={data.kpis.commits.value} metric={data.kpis.commits} icon={GitCommitHorizontal} colorVar="--chart-1" className="col-span-2 lg:col-span-1" />
            <MetricCard label="Líneas cambiadas" value={data.kpis.linesChanged.value} metric={data.kpis.linesChanged} icon={Code2} format={compact} colorVar="--chart-4" />
            <MetricCard label="Tickets resueltos" value={data.kpis.ticketsResolved.value} metric={data.kpis.ticketsResolved} icon={CircleCheck} colorVar="--chart-3" />
            <MetricCard label="Contribuidores" value={data.kpis.activeContributors.value} metric={data.kpis.activeContributors} icon={Users} colorVar="--chart-2" />
            <MetricCard label="Cycle time" value={data.kpis.avgCycleTimeHours.value} metric={data.kpis.avgCycleTimeHours} icon={Timer} invert format={hours} colorVar="--chart-5" />
          </div>

          {/* Actividad + Cliente vs Interno */}
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Actividad del período</CardTitle>
                <CardDescription>Commits y tickets resueltos por día</CardDescription>
              </CardHeader>
              <CardContent>
                <AreaTrend
                  data={data.trend}
                  series={[
                    { key: 'commits', name: 'Commits', color: 'hsl(var(--chart-1))' },
                    { key: 'ticketsResolved', name: 'Tickets', color: 'hsl(var(--chart-3))' },
                  ]}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Cliente vs. Interno</CardTitle>
                <CardDescription>Dónde se invierte el esfuerzo (commits)</CardDescription>
              </CardHeader>
              <CardContent>
                <Donut
                  data={[
                    { label: 'Cliente', value: data.split.client.commits, color: 'hsl(var(--chart-1))' },
                    { label: 'Interno', value: data.split.internal.commits, color: 'hsl(var(--chart-4))' },
                  ]}
                />
                <div className="mt-2 grid grid-cols-2 gap-2 text-center text-xs">
                  <SplitStat icon={<Briefcase className="size-3.5" />} label="Cliente" tickets={data.split.client.ticketsResolved} />
                  <SplitStat icon={<Building2 className="size-3.5" />} label="Interno" tickets={data.split.internal.ticketsResolved} />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Contribución por proyecto + por developer */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Contribución por proyecto</CardTitle>
                <CardDescription>Dónde se invierte el esfuerzo</CardDescription>
              </CardHeader>
              <CardContent>
                <RankBars data={data.byProject.slice(0, 8).map((p) => ({ label: p.name, value: p.commits + p.ticketsResolved }))} height={230} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Contribución por developer</CardTitle>
                <CardDescription>Commits + tickets resueltos en el período</CardDescription>
              </CardHeader>
              <CardContent>
                {data.byDeveloper.length ? (
                  <div className="space-y-2.5">
                    {data.byDeveloper.slice(0, 8).map((d) => {
                      const max = Math.max(...data.byDeveloper.map((x) => x.commits + x.ticketsResolved));
                      const v = d.commits + d.ticketsResolved;
                      return (
                        <div key={d.devId} className="flex cursor-pointer items-center gap-3" onClick={() => nav(`/developers/${d.devId}`)}>
                          <UserAvatar url={d.avatarUrl} name={d.name} className="size-7" />
                          <div className="w-20 shrink-0 truncate text-sm">{d.name}</div>
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-chart-3" style={{ width: `${(v / max) * 100}%` }} />
                          </div>
                          <div className="w-24 shrink-0 text-right text-xs text-muted-foreground">{d.commits}c · {d.ticketsResolved}t</div>
                        </div>
                      );
                    })}
                  </div>
                ) : <EmptyState>Sin actividad en este período</EmptyState>}
              </CardContent>
            </Card>
          </div>

          {/* Balance de carga + Tickets por estado */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Balance de carga</CardTitle>
                <CardDescription>Tickets abiertos asignados, ponderados por prioridad</CardDescription>
              </CardHeader>
              <CardContent>
                <Workload rows={data.workload} onPick={(id) => nav(`/developers/${id}`)} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Pipeline de tickets</CardTitle>
                <CardDescription>Tickets abiertos por estado</CardDescription>
              </CardHeader>
              <CardContent>
                <RankBars data={data.ticketsByState.map((s) => ({ label: STATE_LABEL[s.state] ?? s.state, value: s.count }))} color="hsl(var(--chart-5))" height={230} />
              </CardContent>
            </Card>
          </div>

          {/* Cobertura de skills (rediseñada) */}
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Cobertura de skills</CardTitle>
              <CardDescription>Cuántas personas dominan cada capacidad — bus-factor</CardDescription>
            </CardHeader>
            <CardContent>
              <SkillCoverage coverage={data.skillsCoverage} />
            </CardContent>
          </Card>
        </>
      )}
    </Layout>
  );
}

function SplitStat({ icon, label, tickets }: { icon: React.ReactNode; label: string; tickets: number }) {
  return (
    <div className="rounded-lg bg-muted/50 py-1.5">
      <div className="flex items-center justify-center gap-1 text-muted-foreground">{icon} {label}</div>
      <div className="font-semibold">{tickets} tickets</div>
    </div>
  );
}

function Workload({ rows, onPick }: { rows: OverviewData['workload']; onPick: (id: string) => void }) {
  if (!rows.length) return <EmptyState>Nadie con tickets abiertos asignados</EmptyState>;
  const max = Math.max(...rows.map((r) => r.weighted));
  return (
    <div className="space-y-3">
      {rows.slice(0, 8).map((r) => (
        <div key={r.devId} className="flex cursor-pointer items-center gap-3" onClick={() => onPick(r.devId)}>
          <UserAvatar url={r.avatarUrl} name={r.name} className="size-7" />
          <div className="w-20 shrink-0 truncate text-sm">{r.name}</div>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-chart-1" style={{ width: `${(r.weighted / max) * 100}%` }} />
          </div>
          <div className="w-16 shrink-0 text-right text-xs text-muted-foreground">{r.openTickets} abiertos</div>
        </div>
      ))}
    </div>
  );
}

function SkillCoverage({ coverage }: { coverage: OverviewData['skillsCoverage'] }) {
  if (!coverage.length) return <EmptyState>Sin skills registradas</EmptyState>;
  const risk = coverage.filter((s) => s.busFactorRisk).length;
  const max = Math.max(...coverage.map((s) => s.devCount), 1);
  const sorted = [...coverage].sort((a, b) => b.devCount - a.devCount);

  return (
    <div>
      {/* Resumen */}
      <div className="mb-4 flex flex-wrap gap-3">
        <div className="flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-1.5 text-sm">
          <TriangleAlert className="size-4 text-warning" />
          <span className="font-semibold text-warning">{risk}</span>
          <span className="text-muted-foreground">en riesgo (≤1 dev)</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-1.5 text-sm">
          <ShieldCheck className="size-4 text-success" />
          <span className="font-semibold text-success">{coverage.length - risk}</span>
          <span className="text-muted-foreground">bien cubiertas</span>
        </div>
      </div>

      {/* Barras de cobertura por skill */}
      <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {sorted.map((s) => (
          <div key={s.skillId} className="flex items-center gap-3">
            <div className="w-28 shrink-0 truncate text-sm" title={s.tag}>{s.tag}</div>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full', s.busFactorRisk ? 'bg-warning' : 'bg-success')}
                style={{ width: `${Math.max((s.devCount / max) * 100, 6)}%` }}
              />
            </div>
            <div className={cn('w-16 shrink-0 text-right text-xs', s.busFactorRisk ? 'font-medium text-warning' : 'text-muted-foreground')}>
              {s.devCount} {s.devCount === 1 ? 'dev' : 'devs'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
