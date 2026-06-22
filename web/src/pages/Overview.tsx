import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitCommitHorizontal, CircleCheck, Users, Timer, Code2, TriangleAlert, ShieldCheck, Briefcase, Building2, Server, ChevronRight, Triangle, TrainFront, Database, Activity, Rocket } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { MetricCard } from '@/components/MetricCard';
import { AreaTrend, RankBars, Donut } from '@/components/charts';
import { UserAvatar, EmptyState } from '@/components/bits';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/useApi';
import { apiGet, type Overview as OverviewData, type InfraResponse, type InfraService, type ServiceProvider, type ServiceStatus } from '@/lib/api';
import { compact, hours, relative } from '@/lib/format';
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
            <MetricCard label="Commits" value={data.kpis.commits.value} metric={data.kpis.commits} icon={GitCommitHorizontal} colorVar="--chart-1" />
            <MetricCard label="Líneas cambiadas" value={data.kpis.linesChanged.value} metric={data.kpis.linesChanged} icon={Code2} format={compact} colorVar="--chart-4" className="order-first col-span-2 lg:order-none lg:col-span-1" />
            <MetricCard label="Tickets resueltos" value={data.kpis.ticketsResolved.value} metric={data.kpis.ticketsResolved} icon={CircleCheck} colorVar="--chart-3" />
            <MetricCard label="Contribuidores" value={data.kpis.activeContributors.value} metric={data.kpis.activeContributors} icon={Users} colorVar="--chart-2" />
            <MetricCard label="Cycle time" value={data.kpis.avgCycleTimeHours.value} metric={data.kpis.avgCycleTimeHours} icon={Timer} invert format={hours} colorVar="--chart-5" />
          </div>

          {/* Estado de infraestructura (primer vistazo) */}
          <InfraHealth onOpen={() => nav('/infra')} />

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

const INFRA_STATUS: Record<ServiceStatus, { label: string; dot: string }> = {
  healthy: { label: 'operativos', dot: 'bg-success' },
  degraded: { label: 'degradados', dot: 'bg-warning' },
  down: { label: 'caídos', dot: 'bg-destructive' },
  paused: { label: 'pausados', dot: 'bg-muted-foreground' },
  unknown: { label: 'sin datos', dot: 'bg-muted-foreground/40' },
};
const INFRA_ORDER: ServiceStatus[] = ['down', 'degraded', 'paused', 'healthy', 'unknown'];
const INFRA_PROVIDERS: ServiceProvider[] = ['vercel', 'railway', 'supabase'];
const PROV: Record<ServiceProvider, { Icon: typeof Triangle; accent: string }> = {
  vercel: { Icon: Triangle, accent: 'text-foreground' },
  railway: { Icon: TrainFront, accent: 'text-violet-500' },
  supabase: { Icon: Database, accent: 'text-emerald-500' },
};

function latestDeploy(services: InfraService[]): InfraService | null {
  return services
    .filter((s) => s.deploy?.createdAt)
    .sort((a, b) => (b.deploy!.createdAt! > a.deploy!.createdAt! ? 1 : -1))[0] ?? null;
}

// Estado de infraestructura para el Resumen: salud agregada por proyecto, con desglose por
// proveedor, último deploy y peticiones. Lee /infra (estado actual, no depende del período).
function InfraHealth({ onOpen }: { onOpen: () => void }) {
  const { data, loading } = useApi<InfraResponse>(() => apiGet('/infra'), []);
  const projects = (data?.projects ?? []).filter((p) => p.services.length);
  const services = projects.flatMap((p) => p.services);
  if (!loading && !services.length) return null; // sin servicios vinculados → no mostrar

  const counts = services.reduce((a, s) => ((a[s.status] = (a[s.status] ?? 0) + 1), a), {} as Record<ServiceStatus, number>);
  const worstOf = (statuses: ServiceStatus[]) => INFRA_ORDER.find((st) => statuses.includes(st)) ?? 'unknown';
  const totalReq = services.reduce((a, s) => a + (s.metrics?.requests ?? 0), 0);
  const lastDeploy = latestDeploy(services);

  return (
    <Card className="mt-4">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2"><Server className="size-4" /> Estado de infraestructura</CardTitle>
          <CardDescription>Salud de deploys y servicios por proyecto</CardDescription>
        </div>
        <button onClick={onOpen} className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
          Ver todo <ChevronRight className="size-4" />
        </button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-40" />
        ) : (
          <>
            {/* Resumen global */}
            <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
              <div className="flex items-baseline gap-1.5">
                <span className="text-xl font-bold tabular-nums">{services.length}</span>
                <span className="text-xs text-muted-foreground">servicios</span>
              </div>
              {INFRA_ORDER.filter((st) => counts[st]).map((st) => (
                <div key={st} className="flex items-center gap-1.5">
                  <span className={cn('size-2.5 rounded-full', INFRA_STATUS[st].dot)} />
                  <span className="text-sm font-semibold tabular-nums">{counts[st]}</span>
                  <span className="text-xs text-muted-foreground">{INFRA_STATUS[st].label}</span>
                </div>
              ))}
              {totalReq > 0 && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Activity className="size-3.5" />
                  <span className="text-sm font-semibold tabular-nums text-foreground">{compact(totalReq)}</span>
                  <span className="text-xs">peticiones/24h</span>
                </div>
              )}
              {lastDeploy?.deploy?.createdAt && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Rocket className="size-3.5" />
                  <span className="text-xs">último deploy <span className="text-foreground">{relative(lastDeploy.deploy.createdAt)}</span></span>
                </div>
              )}
            </div>

            {/* Tarjeta por proyecto */}
            <div className="grid gap-3 sm:grid-cols-2">
              {projects.map((p) => {
                const worst = worstOf(p.services.map((s) => s.status));
                const issues = p.services.filter((s) => s.status === 'down' || s.status === 'degraded' || s.status === 'paused').length;
                const dep = latestDeploy(p.services);
                const req = p.services.reduce((a, s) => a + (s.metrics?.requests ?? 0), 0);
                const byProv = INFRA_PROVIDERS.map((pr) => ({ pr, n: p.services.filter((s) => s.provider === pr).length })).filter((x) => x.n);
                return (
                  <button key={p.projectId} onClick={onOpen} className="flex flex-col gap-2 rounded-xl border p-3 text-left transition-colors hover:bg-accent/50">
                    <div className="flex items-center gap-2">
                      <span className={cn('size-2.5 shrink-0 rounded-full', INFRA_STATUS[worst].dot)} />
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{p.name}</span>
                      {issues > 0
                        ? <span className="shrink-0 rounded-md bg-warning/12 px-1.5 py-0.5 text-[11px] font-medium text-warning">{issues} con alerta</span>
                        : <span className="shrink-0 text-[11px] font-medium text-success">Todo operativo</span>}
                    </div>

                    {/* Desglose por proveedor */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {byProv.map(({ pr, n }) => {
                        const { Icon, accent } = PROV[pr];
                        return (
                          <span key={pr} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <Icon className={cn('size-3.5', accent)} /><span className="font-medium text-foreground">{n}</span>
                          </span>
                        );
                      })}
                      {req > 0 && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Activity className="size-3" />{compact(req)}/24h
                        </span>
                      )}
                    </div>

                    {/* Último deploy */}
                    {dep?.deploy?.commitMessage ? (
                      <div className="flex items-center gap-1.5 border-t pt-2 text-[11px] text-muted-foreground">
                        <GitCommitHorizontal className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{dep.deploy.commitMessage}</span>
                        {dep.deploy.createdAt && <span className="shrink-0">{relative(dep.deploy.createdAt)}</span>}
                      </div>
                    ) : (
                      <div className="border-t pt-2 text-[11px] text-muted-foreground">{p.services.length} servicios monitoreados</div>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
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
