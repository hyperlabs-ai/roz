import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Zap, GitCommitHorizontal, Code2, CircleCheck, CirclePlus, Timer, FolderKanban, Crosshair,
  CircleAlert, UserX, Inbox,
} from 'lucide-react';
import { BalancedGrid } from '@/components/grid';
import { MetricCard } from '@/components/MetricCard';
import { AreaTrend, Columns, Donut, Sparkline, StackedBar } from '@/components/charts';
import { UserAvatar, EmptyState, ErrorCard, Revalidating } from '@/components/bits';
import { ProjectIcon } from '@/components/avatars';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/lib/useApi';
import { cn } from '@/lib/utils';
import { compact, hours } from '@/lib/format';
import { comparisonRange, type PeriodState } from '@/lib/period';
import { apiGet, type WorkReport as WorkReportData, type WorkReportPerson, type WorkReportShare } from '@/lib/api';

/** Paleta por RANGO de esfuerzo: los cinco proyectos con más trabajo llevan color, el resto gris. */
const RANK_COLORS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'] as const;
const REST = 'hsl(var(--muted-foreground) / 0.45)';
const token = (v: string) => `hsl(var(${v}))`;

const TYPE_LABEL: Record<string, string> = {
  feature: 'Funcionalidad', fix: 'Corrección', refactor: 'Refactor', docs: 'Documentación',
  tests: 'Pruebas', mantenimiento: 'Mantenimiento', otro: 'Sin prefijo',
};
const TYPE_COLOR: Record<string, string> = {
  feature: token('--chart-1'), fix: token('--red'), refactor: token('--chart-2'), docs: token('--chart-5'),
  tests: token('--chart-3'), mantenimiento: token('--chart-4'), otro: REST,
};
const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

const pctFmt = (n: number) => `${Math.round(n)}%`;

/**
 * Trabajo y enfoque: responde de un vistazo a dónde se fue el esfuerzo del período y si eso
 * coincide con lo planeado en Capacidad. Todo sale de `/reports/work` (una sola consulta).
 *
 * "Esfuerzo" = hyper points del cubo (√(commits × líneas) / 10): ni los commits solos ni las líneas
 * solas, que se inflan con micro-commits o con un scaffold.
 */
export function WorkReport({ period }: { period: PeriodState }) {
  const compare = useMemo(() => comparisonRange(period.range, period.compare, period.preset), [period.range, period.compare, period.preset]);
  const { data, loading, refetching, error } = useApi<WorkReportData>(
    () => apiGet('/reports/work', period.range, compare),
    [period.range.from, period.range.to, compare?.from, compare?.to],
    { key: '/reports/work', ttl: 60_000 },
  );

  // Color estable por proyecto en TODA la vista (barra de esfuerzo, columnas, personas, tabla).
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    (data?.byProject ?? []).filter((p) => p.points > 0).forEach((p, i) => {
      m.set(p.projectId ?? 'none', i < RANK_COLORS.length ? token(RANK_COLORS[i]) : REST);
    });
    return (id: string | null) => m.get(id ?? 'none') ?? REST;
  }, [data]);

  if (error) return <ErrorCard message={error} />;
  if (loading || !data) return <WorkSkeleton />;

  const worked = data.byProject.filter((p) => p.points > 0);
  const quiet = data.byProject.filter((p) => p.points === 0 && p.open > 0);
  const hasCompare = data.compare !== null;
  const bucket = data.granularity === 'week' ? 'semana' : 'día';
  const trendSeries = [
    { key: 'commits', name: 'Este período', color: token('--chart-1') },
    ...(hasCompare ? [{ key: 'previous', name: 'Período anterior', color: 'hsl(var(--muted-foreground))' }] : []),
  ];
  const k = data.kpis;
  const netFlow = k.opened.value - k.closed.value;

  return (
    <Revalidating active={refetching}>
      {/* 8 KPIs en 4 columnas: dos filas completas, sin huérfanos. */}
      <BalancedGrid max={{ base: 2, md: 4 }} className="stagger-children">
        <MetricCard label="Hyper points" value={k.hyperPoints.value} metric={k.hyperPoints} icon={Zap} accent format={compact} />
        <MetricCard label="Commits" value={k.commits.value} metric={k.commits} icon={GitCommitHorizontal} colorVar="--chart-1" trend={data.trend} trendKey="commits" />
        <MetricCard label="Líneas cambiadas" value={k.linesChanged.value} metric={k.linesChanged} icon={Code2} format={compact} colorVar="--chart-4" />
        <MetricCard label="Proyectos con trabajo" value={k.activeProjects.value} metric={k.activeProjects} icon={FolderKanban} colorVar="--chart-2" />
        <MetricCard label="Tareas cerradas" value={k.closed.value} metric={k.closed} icon={CircleCheck} colorVar="--chart-3" trend={data.trend} trendKey="closed" />
        <MetricCard label="Tareas nuevas" value={k.opened.value} metric={k.opened} icon={CirclePlus} colorVar="--blue" invert />
        <MetricCard label="Ciclo (mediana)" value={k.cycleHours.value} metric={k.cycleHours} icon={Timer} invert format={hours} colorVar="--chart-5" />
        <MetricCard label="Enfoque · top 3" value={k.focusTop3.value} metric={k.focusTop3} icon={Crosshair} format={pctFmt} colorVar="--orange" />
      </BalancedGrid>

      {/* La lectura principal: una sola barra con todo el esfuerzo del período. */}
      <Card className="mt-3.5">
        <CardHeader>
          <CardTitle>A dónde se fue el esfuerzo</CardTitle>
          <CardDescription>
            {worked.length ? (
              <>
                <span className="font-semibold text-foreground">{data.focus.top1}%</span> en {data.focus.topProject}
                {worked.length > 1 && <> · los 3 primeros concentran <span className="font-semibold text-foreground">{data.focus.top3}%</span></>}
                {data.focus.teamAlignment !== null && <> · alineación con el plan <span className="font-semibold text-foreground">{data.focus.teamAlignment}%</span></>}
              </>
            ) : 'Sin commits en el período'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {worked.length ? (
            <>
              <StackedBar
                height={16}
                valueFormat={(n) => `${compact(Math.round(n))} pts`}
                data={worked.map((p) => ({ label: p.name, value: p.points, color: colorOf(p.projectId) }))}
              />
              <div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {worked.slice(0, 8).map((p) => (
                  <ProjectLegend key={p.projectId ?? 'none'} id={p.projectId} name={p.name} color={colorOf(p.projectId)} share={p.share}>
                    {p.commits} commits · {compact(p.lines)} líneas · {p.people} {p.people === 1 ? 'persona' : 'personas'}
                  </ProjectLegend>
                ))}
              </div>
              {worked.length > 8 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  y {worked.length - 8} más con {worked.slice(8).reduce((s, p) => s + p.share, 0)}% del esfuerzo
                </p>
              )}
            </>
          ) : <EmptyState icon={<Inbox className="size-5" />}>Nada que repartir todavía</EmptyState>}
        </CardContent>
      </Card>

      <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
        <Card className="flex min-w-0 flex-col">
          <CardHeader>
            <CardTitle>Ritmo del período</CardTitle>
            <CardDescription>Commits por {bucket}{hasCompare ? ', contra el período anterior' : ''}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col">
            <AreaTrend data={data.trend} series={trendSeries} fill height={220} />
          </CardContent>
        </Card>
        <Card className="flex min-w-0 flex-col">
          <CardHeader>
            <CardTitle>Esfuerzo por proyecto</CardTitle>
            <CardDescription>Hyper points de cada proyecto</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col">
            <Columns
              fill
              topN={7}
              valueFormat={(n) => compact(Math.round(n))}
              data={worked.map((p) => ({ label: p.name, value: p.points, color: colorOf(p.projectId), sub: `${p.share}%` }))}
            />
          </CardContent>
        </Card>

        <Card className="flex min-w-0 flex-col">
          <CardHeader>
            <CardTitle>Por cliente</CardTitle>
            <CardDescription>
              {clientSplitText(data.split)}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-center">
            <Donut
              layout="side"
              height={170}
              centerLabel="pts"
              valueFormat={(n) => compact(Math.round(n))}
              data={foldTail(data.byClient.map((c) => ({ label: c.label, value: c.points })), 5).map((c, i) => ({
                ...c,
                color: c.label === 'Interno' ? token('--chart-2') : c.label === 'Otros' || c.label === 'Sin proyecto' ? REST : token(['--chart-1', '--chart-3', '--chart-4', '--chart-5', '--salmon'][i % 5]),
              }))}
            />
          </CardContent>
        </Card>
        <Card className="flex min-w-0 flex-col">
          <CardHeader>
            <CardTitle>Tipo de trabajo</CardTitle>
            <CardDescription>Según el prefijo de cada commit (feat, fix, chore…)</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-center">
            <Donut
              layout="side"
              height={170}
              centerLabel="commits"
              data={data.byType.map((t) => ({ label: TYPE_LABEL[t.type] ?? t.type, value: t.commits, color: TYPE_COLOR[t.type] ?? REST }))}
            />
          </CardContent>
        </Card>
      </div>

      {/* Enfoque por persona: reparto real contra el plan de Capacidad. */}
      <Card className="mt-3.5">
        <CardHeader>
          <CardTitle>Enfoque por persona</CardTitle>
          <CardDescription>Dónde trabajó cada quien (código) contra dónde está asignado en Capacidad</CardDescription>
        </CardHeader>
        <CardContent>
          {data.people.length ? (
            <BalancedGrid max={{ base: 1, md: 2, xl: 3 }} className="gap-3">
              {data.people.map((p) => <PersonFocus key={p.devId} person={p} colorOf={colorOf} />)}
            </BalancedGrid>
          ) : <EmptyState>Sin actividad de personas en el período</EmptyState>}
        </CardContent>
      </Card>

      {/* Flujo de tareas */}
      <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
        <Card className="flex min-w-0 flex-col">
          <CardHeader>
            <CardTitle>Entra contra sale</CardTitle>
            <CardDescription>
              {netFlow > 0
                ? <>La cola creció <span className="font-semibold text-foreground">{netFlow}</span>: entraron {k.opened.value} y se cerraron {k.closed.value}</>
                : netFlow < 0
                  ? <>La cola bajó <span className="font-semibold text-foreground">{-netFlow}</span>: se cerraron {k.closed.value} y entraron {k.opened.value}</>
                  : <>Entraron y se cerraron {k.closed.value}: la cola quedó igual</>}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col">
            <AreaTrend
              data={data.trend}
              fill
              height={200}
              series={[
                { key: 'opened', name: 'Nuevas', color: token('--blue') },
                { key: 'closed', name: 'Cerradas', color: token('--chart-3') },
              ]}
            />
          </CardContent>
        </Card>
        <Card className="flex min-w-0 flex-col">
          <CardHeader>
            <CardTitle>Tiempo de ciclo</CardTitle>
            <CardDescription>Cuánto tardaron en cerrarse las tareas del período</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col">
            {/* Orden de la escala, no por valor: es un histograma. */}
            <Columns fill sort={false} hideZeros={false} color={token('--chart-5')} data={data.cycle.dist} />
          </CardContent>
        </Card>

        <Card className="flex min-w-0 flex-col">
          <CardHeader>
            <CardTitle>Antigüedad de la cola</CardTitle>
            <CardDescription>
              <span className="font-semibold text-foreground">{data.backlog.open}</span> abiertas hoy
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4">
            <div className="grid grid-cols-2 gap-2.5">
              <MiniFact icon={<CircleAlert className="size-4" />} tone={data.backlog.overdue > 0 ? 'red' : 'muted'} value={data.backlog.overdue} label="Vencidas" />
              <MiniFact icon={<UserX className="size-4" />} tone={data.backlog.unassigned > 0 ? 'yellow' : 'muted'} value={data.backlog.unassigned} label="Sin responsable" />
            </div>
            <Columns fill height={150} sort={false} hideZeros={false} color={token('--chart-4')} data={data.backlog.age} />
          </CardContent>
        </Card>
        <Card className="flex min-w-0 flex-col">
          <CardHeader>
            <CardTitle>Días de trabajo</CardTitle>
            <CardDescription>Commits por día de la semana</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col">
            <Columns
              fill
              sort={false}
              hideZeros={false}
              data={data.weekday.map((v, i) => ({ label: WEEKDAYS[i], value: v, color: i >= 5 ? token('--chart-2') : token('--chart-1') }))}
            />
          </CardContent>
        </Card>
      </div>

      {/* Tabla resumen por proyecto */}
      <Card className="mt-3.5">
        <CardHeader>
          <CardTitle>Resumen por proyecto</CardTitle>
          {quiet.length > 0 && (
            <CardDescription>
              <span className="font-semibold text-foreground">{quiet.length}</span> {quiet.length === 1 ? 'proyecto tiene' : 'proyectos tienen'} tareas abiertas y cero commits en el período
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="px-0 pb-1">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">Proyecto</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead className="text-right">Esfuerzo</TableHead>
                <TableHead className="text-right">Commits</TableHead>
                <TableHead className="text-right">Líneas</TableHead>
                <TableHead className="text-right">Cerradas</TableHead>
                <TableHead className="text-right">Abiertas</TableHead>
                <TableHead className="text-right">Personas</TableHead>
                <TableHead className="w-32 pr-5">Actividad</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.byProject.map((p) => {
                const idle = p.points === 0;
                const name = (
                  <span className="flex min-w-0 items-center gap-2.5">
                    <ProjectIcon id={p.projectId} size="sm" />
                    <span className={cn('truncate font-medium', idle && 'text-muted-foreground')}>{p.name}</span>
                  </span>
                );
                return (
                  <TableRow key={p.projectId ?? 'none'}>
                    <TableCell className="max-w-[16rem] pl-5">
                      {p.projectId ? <Link to={`/proyectos/${p.projectId}`} className="block hover:underline">{name}</Link> : name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.client}</TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center justify-end gap-2 tabular-nums">
                        {!idle && <span className="size-2 rounded-[3px]" style={{ background: colorOf(p.projectId) }} />}
                        <span className={cn('font-semibold', idle && 'font-normal text-faint')}>{idle ? '—' : `${p.share}%`}</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.commits || <span className="text-faint">—</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.lines ? compact(p.lines) : <span className="text-faint">—</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.closed || <span className="text-faint">—</span>}</TableCell>
                    <TableCell className={cn('text-right tabular-nums', idle && p.open > 0 && 'font-semibold text-yellow-ink')}>
                      {p.open || <span className="text-faint">—</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.people || <span className="text-faint">—</span>}</TableCell>
                    <TableCell className="pr-5">
                      {idle ? <span className="text-xs text-faint">sin commits</span> : (
                        <Sparkline data={p.spark.map((v) => ({ v }))} dataKey="v" height={28} showLast={false} color={colorOf(p.projectId)} />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {!data.byProject.length && <EmptyState>Sin proyectos con movimiento</EmptyState>}
        </CardContent>
      </Card>
    </Revalidating>
  );
}

function clientSplitText(split: WorkReportData['split']): ReactNode {
  const total = split.client + split.internal + split.unassigned;
  if (!total) return 'Sin esfuerzo registrado';
  const c = Math.round((split.client / total) * 100);
  const i = Math.round((split.internal / total) * 100);
  return (
    <>
      <span className="font-semibold text-foreground">{c}%</span> a clientes · <span className="font-semibold text-foreground">{i}%</span> interno
      {split.unassigned > 0 && <> · {100 - c - i}% sin proyecto</>}
    </>
  );
}

/** Deja los `n` primeros y junta la cola en "Otros": una dona con 12 gajos no se lee. */
function foldTail(rows: { label: string; value: number }[], n: number): { label: string; value: number }[] {
  if (rows.length <= n) return rows;
  const rest = rows.slice(n).reduce((s, r) => s + r.value, 0);
  return [...rows.slice(0, n), { label: 'Otros', value: Math.round(rest * 10) / 10 }];
}

function ProjectLegend({ id, name, color, share, children }: { id: string | null; name: string; color: string; share: number; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="mt-1.5 size-2.5 shrink-0 rounded-[3px]" style={{ background: color }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <ProjectIcon id={id} size="xs" />
            <span className="truncate text-[13.5px] font-medium">{name}</span>
          </span>
          <span className="shrink-0 text-[13.5px] font-semibold tabular-nums">{share}%</span>
        </div>
        <div className="truncate text-xs text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

function MiniFact({ icon, value, label, tone }: { icon: ReactNode; value: number; label: string; tone: 'red' | 'yellow' | 'muted' }) {
  return (
    <div className={cn(
      'flex items-center gap-2.5 rounded-lg px-3 py-2.5',
      tone === 'red' ? 'bg-red-soft text-red' : tone === 'yellow' ? 'bg-yellow-soft text-yellow-ink' : 'bg-panel text-muted-foreground',
    )}>
      {icon}
      <span className="text-lg font-bold leading-none tabular-nums text-foreground">{value}</span>
      <span className="truncate text-xs">{label}</span>
    </div>
  );
}

const ALIGN_TONE = (a: number) =>
  a >= 70 ? 'bg-green-soft text-green' : a >= 40 ? 'bg-yellow-soft text-yellow-ink' : 'bg-red-soft text-red';

/** Una persona: su reparto real y su plan, uno encima del otro para compararlos a ojo. */
function PersonFocus({ person: p, colorOf }: { person: WorkReportPerson; colorOf: (id: string | null) => string }) {
  const bar = (rows: WorkReportShare[]) => rows.map((r) => ({ label: r.name, value: r.share, color: colorOf(r.projectId) }));
  const idle = p.commits === 0;
  return (
    <div className="flex h-full flex-col gap-3 rounded-xl bg-panel/60 p-3.5">
      <div className="flex items-center gap-2.5">
        <UserAvatar url={p.avatarUrl} id={p.devId} name={p.name} className="size-9" />
        <div className="min-w-0 flex-1">
          <Link to={`/developers/${p.devId}`} className="block truncate text-sm font-semibold hover:underline">{p.name}</Link>
          <div className="truncate text-xs text-muted-foreground">
            {idle ? 'Sin commits en el período' : <>{p.points} pts · {p.commits} commits · {p.closed} cerradas</>}
          </div>
        </div>
        {p.alignment !== null ? (
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums', ALIGN_TONE(p.alignment))} title="Traslape entre el reparto real y el plan de Capacidad">
            {p.alignment}% en plan
          </span>
        ) : !p.planned.length ? (
          <span className="shrink-0 rounded-full bg-card px-2 py-0.5 text-xs text-muted-foreground">Sin plan</span>
        ) : null}
      </div>

      <div className="space-y-2">
        <FocusRow label="Real" empty="Sin código">{p.actual.length ? <StackedBar data={bar(p.actual)} height={10} valueFormat={pctFmt} /> : null}</FocusRow>
        <FocusRow label="Plan" empty="Sin asignaciones">{p.planned.length ? <StackedBar data={bar(p.planned)} height={10} valueFormat={pctFmt} /> : null}</FocusRow>
      </div>

      {p.actual.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {p.actual.slice(0, 3).map((r) => (
            <span key={r.projectId ?? 'none'} className="inline-flex min-w-0 items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-[3px]" style={{ background: colorOf(r.projectId) }} />
              <span className="max-w-[9rem] truncate text-muted-foreground">{r.name}</span>
              <span className="font-semibold tabular-nums">{r.share}%</span>
            </span>
          ))}
          {p.actual.length > 3 && <span className="text-faint">+{p.actual.length - 3}</span>}
        </div>
      )}
      {p.offPlan >= 30 && (
        <p className="text-xs text-yellow-ink">{p.offPlan}% de su trabajo fue en proyectos fuera de su asignación</p>
      )}
    </div>
  );
}

function FocusRow({ label, empty, children }: { label: string; empty: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="label-caps w-9 shrink-0 text-faint">{label}</span>
      <div className="min-w-0 flex-1">{children ?? <span className="text-xs text-faint">{empty}</span>}</div>
    </div>
  );
}

function WorkSkeleton() {
  return (
    <div className="grid gap-3.5">
      <BalancedGrid max={{ base: 2, md: 4 }}>{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[92px]" />)}</BalancedGrid>
      <Skeleton className="h-44" />
      <div className="grid gap-3.5 lg:grid-cols-2"><Skeleton className="h-72" /><Skeleton className="h-72" /></div>
    </div>
  );
}
