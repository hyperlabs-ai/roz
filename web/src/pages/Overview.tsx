import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitCommitHorizontal, CircleCheck, Users, Timer, Code2, TriangleAlert, ShieldCheck, Briefcase, Building2, Server, ChevronRight, Triangle, TrainFront, Database, Activity, Rocket } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { MetricCard } from '@/components/MetricCard';
import { AreaTrend, RankBars, Donut } from '@/components/charts';
import { UserAvatar, EmptyState, ProgressBar, ErrorCard } from '@/components/bits';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/useApi';
import { apiGet, type Overview as OverviewData, type InfraResponse, type InfraUptimeResponse, type InfraService, type ServiceProvider, type ServiceStatus } from '@/lib/api';
import { compact, hours, relative } from '@/lib/format';
import { comparisonRange } from '@/lib/period';
import { usePeriod } from '@/lib/usePeriod';
import { cn } from '@/lib/utils';
import { PRIO_LABEL, PRIO_COLOR_VAR } from '@/lib/labels';

export default function Overview() {
  const [period, setPeriod] = usePeriod();
  const nav = useNavigate();
  const compare = useMemo(() => comparisonRange(period.range, period.compare, period.preset), [period.range, period.compare, period.preset]);
  const { data, loading, error } = useApi<OverviewData>(
    () => apiGet('/overview', period.range, compare),
    [period.range.from, period.range.to, compare?.from, compare?.to],
  );

  return (
    <Layout title="Resumen" subtitle="El pulso del equipo en un vistazo" actions={<PeriodPicker value={period} onChange={setPeriod} />}>
      {error && <ErrorCard message={error} className="mb-4" />}

      {loading || !data ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="stagger-children grid grid-cols-2 gap-4 lg:grid-cols-5">
            <MetricCard label="Commits" value={data.kpis.commits.value} metric={data.kpis.commits} icon={GitCommitHorizontal} colorVar="--chart-1" />
            <MetricCard label="Líneas cambiadas" value={data.kpis.linesChanged.value} metric={data.kpis.linesChanged} icon={Code2} format={compact} colorVar="--chart-4" className="order-first col-span-2 lg:order-none lg:col-span-1" />
            <MetricCard label="Tickets resueltos" value={data.kpis.ticketsResolved.value} metric={data.kpis.ticketsResolved} icon={CircleCheck} colorVar="--chart-3" />
            <MetricCard label="Contribuidores" value={data.kpis.activeContributors.value} metric={data.kpis.activeContributors} icon={Users} colorVar="--chart-2" />
            <MetricCard label="Cycle time" value={data.kpis.avgCycleTimeHours.value} metric={data.kpis.avgCycleTimeHours} icon={Timer} invert format={hours} colorVar="--chart-5" />
          </div>

          {/* Estado de infraestructura (primer vistazo) */}
          <InfraHealth onOpen={() => nav('/app/infra')} />

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
                  <div className="-mx-2">
                    {/* Cabecera de columnas: deja claro qué es cada número */}
                    <div className="flex items-center gap-3 px-2 pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                      <span className="w-4 shrink-0" />
                      <span className="min-w-0 flex-1">Developer</span>
                      <span className="w-12 text-right">commits</span>
                      <span className="w-12 text-right">tickets</span>
                      <span className="w-12 text-right">líneas</span>
                      <span className="w-4 shrink-0" />
                    </div>
                    <div className="space-y-0.5">
                      {data.byDeveloper.slice(0, 8).map((d, i) => (
                        <div
                          key={d.devId}
                          className="group row-nudge flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-accent/50"
                          onClick={() => nav(`/app/developers/${d.devId}`)}
                        >
                          <span className="w-4 shrink-0 text-center font-mono text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                          <UserAvatar url={d.avatarUrl} name={d.name} className="size-7 shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.name}</span>
                          <span className="w-12 text-right font-mono text-sm tabular-nums">{d.commits}</span>
                          <span className="w-12 text-right font-mono text-sm tabular-nums">{d.ticketsResolved}</span>
                          <span className="w-12 text-right font-mono text-sm tabular-nums text-muted-foreground">{compact(d.lines)}</span>
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : <EmptyState>Sin actividad en este período</EmptyState>}
              </CardContent>
            </Card>
          </div>

          {/* Tickets completados: por developer (ponderado) + por prioridad */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Tickets completados</CardTitle>
                <CardDescription>Completados en el período por developer, ponderados por prioridad</CardDescription>
              </CardHeader>
              <CardContent>
                <Workload rows={data.workload} onPick={(id) => nav(`/app/developers/${id}`)} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Completados por prioridad</CardTitle>
                <CardDescription>Tickets resueltos en el período según su prioridad</CardDescription>
              </CardHeader>
              <CardContent>
                <RankBars data={data.completedByPriority.map((p) => ({ label: PRIO_LABEL[p.priority] ?? p.priority, value: p.count, color: PRIO_COLOR_VAR[p.priority] ?? 'hsl(var(--muted-foreground))' }))} />
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
// Color de cada barra del timeline de disponibilidad (status page).
const UPTIME_BAR: Record<string, string> = {
  // En light el verde va algo más suave (una pared de verde saturado se ve intensa); en dark, pleno.
  healthy: 'bg-success/80 dark:bg-success',
  degraded: 'bg-warning',
  down: 'bg-destructive',
  paused: 'bg-muted-foreground/50',
  unknown: 'bg-muted',
};
const INFRA_PROVIDERS: ServiceProvider[] = ['vercel', 'railway', 'supabase'];
const PROV: Record<ServiceProvider, { Icon: typeof Triangle; accent: string }> = {
  vercel: { Icon: Triangle, accent: 'text-foreground' },
  railway: { Icon: TrainFront, accent: 'text-chart-5' },
  supabase: { Icon: Database, accent: 'text-chart-3' },
};

function latestDeploy(services: InfraService[]): InfraService | null {
  return services
    .filter((s) => s.deploy?.createdAt)
    .sort((a, b) => (b.deploy!.createdAt! > a.deploy!.createdAt! ? 1 : -1))[0] ?? null;
}

// Elige columnas (3 o 4) y cuántas tarjetas mostrar para que la grilla quede siempre "cuadrada"
// (sin celdas vacías). Se recorta al mayor múltiplo de columnas que quepa, mostrando el máximo.
const GRID_COLS: Record<number, string> = {
  1: '',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
};
function squareLayout(total: number): { cols: number; count: number } {
  if (total <= 2) return { cols: Math.max(total, 1), count: total };
  const opt4 = total - (total % 4); // mayor múltiplo de 4 ≤ total
  const opt3 = total - (total % 3); // mayor múltiplo de 3 ≤ total
  return opt4 >= opt3 ? { cols: 4, count: opt4 } : { cols: 3, count: opt3 };
}

// Estado de infraestructura para el Resumen: salud agregada + una tarjeta por proyecto.
// La grilla se mantiene "cuadrada" (3–4 por línea, sin celdas vacías): si el total de proyectos
// no llena filas completas, se muestran solo los primeros que sí las completan. Lee /infra.
function InfraHealth({ onOpen }: { onOpen: () => void }) {
  const { data, loading } = useApi<InfraResponse>(() => apiGet('/infra'), []);
  // Ventana propia del status page (histórico retenido), NO el período del dashboard.
  const { data: uptime } = useApi<InfraUptimeResponse>(() => apiGet('/infra/uptime'), []);
  const allProjects = (data?.projects ?? []).filter((p) => p.services.length);
  const services = allProjects.flatMap((p) => p.services);
  if (!loading && !services.length) return null; // sin servicios vinculados → no mostrar

  const counts = services.reduce((a, s) => ((a[s.status] = (a[s.status] ?? 0) + 1), a), {} as Record<ServiceStatus, number>);
  const worstOf = (statuses: ServiceStatus[]) => INFRA_ORDER.find((st) => statuses.includes(st)) ?? 'unknown';
  const totalReq = services.reduce((a, s) => a + (s.metrics?.requests ?? 0), 0);
  const lastDeploy = latestDeploy(services);

  // Recorta a una cantidad que llene filas completas de 3 o 4 columnas.
  const { cols, count } = squareLayout(allProjects.length);
  const projects = allProjects.slice(0, count);
  const hidden = allProjects.length - projects.length;

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
          <>
            {/* Resumen global */}
            <div className="mb-4 flex flex-col gap-4 rounded-xl border bg-muted/30 p-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-5 w-44" />
                <Skeleton className="h-2 w-full rounded-full" />
                <div className="flex gap-3">
                  {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-4 w-20" />)}
                </div>
              </div>
              <div className="flex gap-6 sm:shrink-0 sm:border-l sm:border-border sm:pl-6">
                {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-10 w-24" />)}
              </div>
            </div>
            {/* Tarjetas por proyecto */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-2.5 rounded-xl border p-3.5">
                  <div className="flex items-center gap-2">
                    <Skeleton className="size-2.5 shrink-0 rounded-full" />
                    <Skeleton className="h-4 flex-1" />
                  </div>
                  <div className="flex gap-2"><Skeleton className="h-5 w-10 rounded-md" /><Skeleton className="h-5 w-10 rounded-md" /></div>
                  <div className="border-t pt-2.5"><Skeleton className="h-3 w-32" /></div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            {/* Resumen global: barra de salud (izq., crece) + métricas clave (der.) */}
            <div className="mb-4 flex flex-col gap-4 rounded-xl border bg-muted/30 p-3.5 sm:flex-row sm:items-center sm:justify-between">
              {/* Salud agregada */}
              <div className="min-w-0 flex-1">
                {/* Cabecera: nº de servicios (izq.) + estado actual agregado (der.), estilo status page. */}
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xl font-bold tabular-nums">{services.length}</span>
                    <span className="text-xs text-muted-foreground">servicios monitoreados</span>
                  </div>
                  {(() => {
                    const o = counts['down']
                      ? { t: 'Incidencia', c: 'text-destructive', dot: 'bg-destructive' }
                      : counts['degraded']
                        ? { t: 'Degradado', c: 'text-warning', dot: 'bg-warning' }
                        : { t: 'Operativo', c: 'text-success', dot: 'bg-success' };
                    return (
                      <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-sm font-medium', o.c)}>
                        <span className={cn('size-2 rounded-full', o.dot)} /> {o.t}
                      </span>
                    );
                  })()}
                </div>
                {uptime && uptime.buckets.length ? (
                  /* Timeline estilo status page: muchas barras finas sobre el período con histórico. */
                  <div>
                    <div className="flex h-9 items-stretch gap-[2px]">
                      {uptime.buckets.map((b) => (
                        <div
                          key={b.start}
                          title={`${b.start.slice(0, 10)} ${b.start.slice(11, 16)} · ${INFRA_STATUS[b.status]?.label ?? b.status}${b.total ? ` (${b.up}/${b.total} ok)` : ' · sin datos'}`}
                          className={cn('min-w-[2px] flex-1 rounded-[1.5px] transition-colors', UPTIME_BAR[b.status] ?? 'bg-muted')}
                        />
                      ))}
                    </div>
                    <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                      <span className="shrink-0">hace {uptime.days} {uptime.days === 1 ? 'día' : 'días'}</span>
                      <span className="h-px flex-1 bg-border" />
                      {uptime.uptimePct != null && <span className="shrink-0 font-mono tabular-nums">{uptime.uptimePct}% disponibilidad</span>}
                      <span className="h-px flex-1 bg-border" />
                      <span className="shrink-0">hoy</span>
                    </div>
                  </div>
                ) : (
                  /* Fallback (aún sin histórico de snapshots): proporción por estado actual + leyenda. */
                  <>
                    <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
                      {INFRA_ORDER.filter((st) => counts[st]).map((st) => (
                        <div
                          key={st}
                          className={cn('h-full first:rounded-l-full last:rounded-r-full', INFRA_STATUS[st].dot)}
                          style={{ width: `${(counts[st] / services.length) * 100}%` }}
                          title={`${counts[st]} ${INFRA_STATUS[st].label}`}
                        />
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                      {INFRA_ORDER.filter((st) => counts[st]).map((st) => (
                        <span key={st} className="inline-flex items-center gap-1.5 text-xs">
                          <span className={cn('size-2 rounded-full', INFRA_STATUS[st].dot)} />
                          <span className="font-semibold tabular-nums">{counts[st]}</span>
                          <span className="text-muted-foreground">{INFRA_STATUS[st].label}</span>
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Métricas secundarias, ancladas a la derecha */}
              {(totalReq > 0 || lastDeploy?.deploy?.createdAt) && (
                <div className="flex items-center gap-6 sm:shrink-0 sm:border-l sm:border-border sm:pl-6">
                  {totalReq > 0 && (
                    <div>
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Activity className="size-3.5" /><span className="text-xs">peticiones/24h</span>
                      </div>
                      <div className="mt-0.5 text-lg font-bold tabular-nums">{compact(totalReq)}</div>
                    </div>
                  )}
                  {lastDeploy?.deploy?.createdAt && (
                    <div>
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Rocket className="size-3.5" /><span className="text-xs">último deploy</span>
                      </div>
                      <div className="mt-0.5 text-sm font-semibold">{relative(lastDeploy.deploy.createdAt)}</div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Tarjeta por proyecto (grilla cuadrada, 3–4 por línea) */}
            <div className={cn('stagger-children grid grid-cols-1 gap-3', GRID_COLS[cols])}>
              {projects.map((p) => {
                const worst = worstOf(p.services.map((s) => s.status));
                const issues = p.services.filter((s) => s.status === 'down' || s.status === 'degraded' || s.status === 'paused').length;
                const dep = latestDeploy(p.services);
                const req = p.services.reduce((a, s) => a + (s.metrics?.requests ?? 0), 0);
                const byProv = INFRA_PROVIDERS.map((pr) => ({ pr, n: p.services.filter((s) => s.provider === pr).length })).filter((x) => x.n);
                return (
                  <button key={p.projectId} onClick={onOpen} className="hover-lift press flex min-w-0 flex-col gap-2.5 rounded-xl border p-3.5 text-left transition-colors hover:border-primary/30 hover:bg-accent/50">
                    <div className="flex items-center gap-2">
                      <span className={cn('size-2.5 shrink-0 rounded-full', INFRA_STATUS[worst].dot)} />
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{p.name}</span>
                      {issues > 0
                        ? <span className="shrink-0 rounded-md bg-warning/12 px-1.5 py-0.5 text-[11px] font-medium text-warning">{issues} alerta{issues !== 1 ? 's' : ''}</span>
                        : <CircleCheck className="size-4 shrink-0 text-success" />}
                    </div>

                    {/* Desglose por proveedor (izq.) + peticiones (der.) */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        {byProv.map(({ pr, n }) => {
                          const { Icon, accent } = PROV[pr];
                          return (
                            <span key={pr} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                              <Icon className={cn('size-3.5', accent)} /><span className="font-semibold tabular-nums text-foreground">{n}</span>
                            </span>
                          );
                        })}
                      </div>
                      {req > 0 && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                          <Activity className="size-3.5" /><span className="font-semibold tabular-nums text-foreground">{compact(req)}</span>/24h
                        </span>
                      )}
                    </div>

                    {/* Último deploy */}
                    {dep?.deploy?.commitMessage ? (
                      <div className="flex items-center gap-1.5 border-t pt-2.5 text-[11px] text-muted-foreground">
                        <GitCommitHorizontal className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{dep.deploy.commitMessage}</span>
                        {dep.deploy.createdAt && <span className="shrink-0">{relative(dep.deploy.createdAt)}</span>}
                      </div>
                    ) : (
                      <div className="border-t pt-2.5 text-[11px] text-muted-foreground">{p.services.length} servicios monitoreados</div>
                    )}
                  </button>
                );
              })}
            </div>

            {hidden > 0 && (
              <button onClick={onOpen} className="mt-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
                Ver {hidden} proyecto{hidden !== 1 ? 's' : ''} más <ChevronRight className="size-4" />
              </button>
            )}
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
  if (!rows.length) return <EmptyState>Nadie completó tickets en este período</EmptyState>;
  const max = Math.max(...rows.map((r) => r.weighted));
  return (
    <div className="space-y-3">
      {rows.slice(0, 8).map((r) => (
        <div key={r.devId} className="row-nudge -mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1 hover:bg-accent/50" onClick={() => onPick(r.devId)}>
          <UserAvatar url={r.avatarUrl} name={r.name} className="size-7" />
          <div className="w-20 shrink-0 truncate text-sm">{r.name}</div>
          <ProgressBar pct={(r.weighted / max) * 100} className="flex-1" barClassName="bg-chart-1" />
          <div className="w-20 shrink-0 text-right text-xs text-muted-foreground">{r.completedTickets} completados</div>
        </div>
      ))}
    </div>
  );
}

function SkillCoverage({ coverage }: { coverage: OverviewData['skillsCoverage'] }) {
  if (!coverage.length) return <EmptyState>Sin skills registradas</EmptyState>;
  const risk = coverage.filter((s) => s.busFactorRisk).length;
  // En riesgo primero (bus-factor), luego por cobertura desc.
  const sorted = [...coverage].sort((a, b) => Number(b.busFactorRisk) - Number(a.busFactorRisk) || b.devCount - a.devCount);

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

      {/* Capacidades como chips: sin barras. El punto marca la cobertura (rojo = en riesgo ≤1 dev,
          verde = bien cubierta) y el número la magnitud. */}
      <div className="flex flex-wrap gap-2.5">
        {sorted.map((s) => (
          <span
            key={s.skillId}
            title={`${s.tag} · ${s.devCount} ${s.devCount === 1 ? 'dev' : 'devs'}`}
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm transition-colors',
              s.busFactorRisk ? 'border-destructive/30 bg-destructive/5' : 'border-border hover:bg-muted/50',
            )}
          >
            <span className={cn('size-2 shrink-0 rounded-full', s.busFactorRisk ? 'bg-destructive' : 'bg-success')} />
            <span className="font-medium text-foreground">{s.tag}</span>
            <span className={cn('font-mono tabular-nums', s.busFactorRisk ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
              {s.devCount}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
