import { useMemo, useState } from 'react';
import { GitCommitHorizontal, CircleCheck, Users, Timer, Code2, TriangleAlert, ShieldCheck } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { MetricCard } from '@/components/MetricCard';
import { AreaTrend, RankBars } from '@/components/charts';
import { UserAvatar, EmptyState } from '@/components/bits';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/useApi';
import { apiGet, type Overview as OverviewData } from '@/lib/api';
import { compact, hours } from '@/lib/format';
import { comparisonRange, defaultPeriod } from '@/lib/period';

export default function Overview() {
  const [period, setPeriod] = useState(defaultPeriod());
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
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <MetricCard label="Commits" value={data.kpis.commits.value} metric={data.kpis.commits} icon={GitCommitHorizontal} spark={data.trend} className="col-span-2 lg:col-span-1" />
            <MetricCard label="Tickets resueltos" value={data.kpis.ticketsResolved.value} metric={data.kpis.ticketsResolved} icon={CircleCheck} />
            <MetricCard label="Contribuidores" value={data.kpis.activeContributors.value} metric={data.kpis.activeContributors} icon={Users} />
            <MetricCard label="Cycle time" value={data.kpis.avgCycleTimeHours.value} metric={data.kpis.avgCycleTimeHours} icon={Timer} invert format={hours} />
            <MetricCard label="Líneas cambiadas" value={data.kpis.linesChanged.value} metric={data.kpis.linesChanged} icon={Code2} format={compact} />
          </div>

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
                <CardTitle>Contribución por proyecto</CardTitle>
                <CardDescription>Dónde se invierte el esfuerzo</CardDescription>
              </CardHeader>
              <CardContent>
                <RankBars data={data.byProject.slice(0, 7).map((p) => ({ label: p.name, value: p.commits + p.ticketsResolved }))} height={210} />
              </CardContent>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Balance de carga</CardTitle>
                <CardDescription>Tickets abiertos asignados, ponderados por prioridad</CardDescription>
              </CardHeader>
              <CardContent>
                <Workload rows={data.workload} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Cobertura de skills</CardTitle>
                <CardDescription>Bus-factor: riesgo de punto único de falla</CardDescription>
              </CardHeader>
              <CardContent>
                <BusFactor coverage={data.skillsCoverage} />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </Layout>
  );
}

function Workload({ rows }: { rows: OverviewData['workload'] }) {
  if (!rows.length) return <EmptyState>Nadie con tickets abiertos asignados</EmptyState>;
  const max = Math.max(...rows.map((r) => r.weighted));
  return (
    <div className="space-y-3">
      {rows.slice(0, 8).map((r) => (
        <div key={r.devId} className="flex items-center gap-3">
          <UserAvatar url={r.avatarUrl} name={r.name} className="size-7" />
          <div className="w-24 shrink-0 truncate text-sm">{r.name}</div>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-chart-1" style={{ width: `${(r.weighted / max) * 100}%` }} />
          </div>
          <div className="w-16 shrink-0 text-right text-xs text-muted-foreground">{r.openTickets} abiertos</div>
        </div>
      ))}
    </div>
  );
}

function BusFactor({ coverage }: { coverage: OverviewData['skillsCoverage'] }) {
  const risk = coverage.filter((s) => s.busFactorRisk).sort((a, b) => a.devCount - b.devCount);
  const strong = coverage.filter((s) => !s.busFactorRisk).sort((a, b) => b.devCount - a.devCount).slice(0, 8);
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-warning">
          <TriangleAlert className="size-3.5" /> En riesgo (≤1 dev)
        </div>
        <div className="flex flex-wrap gap-1.5">
          {risk.length ? risk.map((s) => <Badge key={s.skillId} variant="warning">{s.tag} · {s.devCount}</Badge>) : <span className="text-sm text-muted-foreground">Ninguna 🎉</span>}
        </div>
      </div>
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-success">
          <ShieldCheck className="size-3.5" /> Bien cubiertas
        </div>
        <div className="flex flex-wrap gap-1.5">
          {strong.map((s) => <Badge key={s.skillId} variant="secondary">{s.tag} · {s.devCount}</Badge>)}
        </div>
      </div>
    </div>
  );
}
