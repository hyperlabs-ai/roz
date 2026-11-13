import { BalancedGrid } from '@/components/grid';
import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, GitCommitHorizontal, CircleCheck, Timer, Code2, FolderGit2, Pencil, Zap, Eye, UserX, UserCheck, Loader2, GraduationCap } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { DeltaBadge, MetricCard } from '@/components/MetricCard';
import { Columns, Donut, MiniArea } from '@/components/charts';
import { EmptyState, StateBadge, SkillMeter, ErrorCard, RefreshButton } from '@/components/bits';
import { GithubAvatar, GithubHandle, CapsLabel, SectionHeader } from '@/components/brand';
import { AvailabilityControl } from '@/components/AvailabilityControl';
import { PresencePanel, avatarPresence } from '@/components/PresencePanel';
import { DeveloperDialog } from '@/components/DeveloperDialog';
import { GithubContributions } from '@/components/GithubContributions';
import { DevActivity } from '@/components/DevActivity';
import { SizeDistPanel } from '@/components/CommitSizeDist';
import { CommitRhythm } from '@/components/developers/CommitRhythm';
import { useAuth } from '@/auth/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip';
import { HyperTooltip } from '@/components/HyperTooltip';
import { useApi } from '@/lib/useApi';
import { invalidate } from '@/lib/store';
import { useAction } from '@/lib/useAction';
import { apiGet, apiSend, type DeveloperProfile as Profile } from '@/lib/api';
import { compact, hours } from '@/lib/format';
import { comparisonRange } from '@/lib/period';
import { usePeriod } from '@/lib/usePeriod';
import { useDevPresence } from '@/presence/PresenceContext';

export default function DeveloperProfile() {
  const { id } = useParams();
  const [period, setPeriod] = usePeriod();
  const [editOpen, setEditOpen] = useState(false);
  const { user } = useAuth();
  const presence = useDevPresence(id);
  const isAdmin = !!user; // control total para cualquier usuario autenticado (sin roles)
  const action = useAction();
  const compare = useMemo(() => comparisonRange(period.range, period.compare, period.preset), [period.range, period.compare, period.preset]);
  const { data, loading, refetching, error, reload } = useApi<Profile>(
    () => apiGet(`/developers/${id}`, period.range, compare),
    [id, period.range.from, period.range.to, compare?.from, compare?.to],
    { key: '/developers/profile', ttl: 60_000 },
  );

  /**
   * Disponibilidad que se está mostrando. El slider y el <Select> del diálogo de credenciales
   * escriben el MISMO campo: sin este override compartido, guardar en uno dejaba al otro mostrando
   * el valor viejo, y los dos controles se contradecían en la misma pantalla.
   */
  const [availability, setAvailability] = useState<number | null>(null);
  const shownAvailability = availability ?? data?.dev.availability ?? 1;
  useEffect(() => {
    if (data && availability !== null && data.dev.availability === availability) setAvailability(null);
  }, [data, availability]);

  const reactivate = () =>
    action.run('reactivate', async () => {
      await apiSend('PATCH', `/developers/${id}`, { active: true });
      reload();
      invalidate('/developers');
    }, { success: 'Developer reactivado', error: 'No se pudo reactivar' });

  return (
    <Layout
      title={data?.dev.name ?? 'Developer'}
      eyebrow={data?.dev.githubLogin ? `Developer · @${data.dev.githubLogin}` : undefined}
      actions={
        <div className="flex items-center gap-2">
          <RefreshButton busy={refetching} onClick={reload} />
          {isAdmin && (
            <Button variant="secondary" onClick={() => setEditOpen(true)}>
              <Pencil /> <span className="hidden sm:inline">Editar credenciales</span>
            </Button>
          )}
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
      }
    >
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2 label-caps text-faint">
        <Link to="/developers"><ArrowLeft /> Developers</Link>
      </Button>

      {error && <ErrorCard message={error} className="mb-4" />}
      {loading || !data ? (
        <div className="space-y-3.5">
          <Card className="flex items-center gap-4 p-5">
            <Skeleton className="size-14 rounded-full" />
            <div className="grid gap-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="ml-auto hidden h-14 w-40 rounded-lg sm:block" />
          </Card>
          <BalancedGrid max={{ base: 2, md: 3, lg: 5 }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <Card key={i} className="grid gap-3 p-5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-8 w-16" />
              </Card>
            ))}
          </BalancedGrid>
          <Skeleton className="h-[180px] rounded-lg" />
          <div className="grid gap-3.5 xl:grid-cols-[1.5fr_1fr]">
            <Skeleton className="h-[260px] rounded-lg" />
            <Skeleton className="h-[260px] rounded-lg" />
          </div>
        </div>
      ) : (
        <>
          {!data.dev.active && (
            <div className="mb-3.5 flex flex-wrap items-center gap-3 rounded-lg border border-yellow/40 bg-yellow-soft px-4 py-2.5 text-[13px] text-yellow-ink">
              <UserX className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">Inactivo: roz no le asigna tareas nuevas y no aparece en el podio. Su historial sigue aquí.</span>
              {isAdmin && (
                <Button size="sm" variant="secondary" onClick={reactivate} disabled={action.busy('reactivate')}>
                  {action.busy('reactivate') ? <Loader2 className="animate-spin" /> : <UserCheck />} Reactivar
                </Button>
              )}
            </div>
          )}
          <Card>
            <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:gap-6 sm:py-5">
              {/* Identidad: foto de GitHub con presencia del calendario + handle */}
              <div className="flex min-w-0 items-center gap-4 sm:w-60 sm:shrink-0">
                <GithubAvatar
                  login={data.dev.githubLogin}
                  email={data.dev.email}
                  id={data.dev.id}
                  url={data.dev.avatarUrl}
                  name={data.dev.name}
                  presence={avatarPresence(presence?.status)}
                  className="size-14"
                />
                <div className="grid min-w-0 gap-1">
                  <div className="truncate text-lg font-semibold tracking-[-0.025em]">{data.dev.name}</div>
                  {data.dev.githubLogin && <GithubHandle login={data.dev.githubLogin} />}
                  {(data.dev.email || !data.dev.githubLogin) && (
                    <span className="truncate text-xs text-muted-foreground">{data.dev.email ?? 'Sin correo'}</span>
                  )}
                </div>
              </div>

              {/* Módulo propio, a la altura del de hyper points y el de disponibilidad. La agenda
                  real y la carga declarada son hermanas: una la reporta el calendario, la otra la
                  declara la persona. */}
              <PresencePanel devId={data.dev.id} className="w-full sm:w-60 sm:shrink-0" />

              {/* Commits por día: contexto de apoyo, toma el ancho que sobre. */}
              <div className="min-w-0 sm:flex-1">
                <MiniArea data={data.commitTrend} height={52} />
                <CapsLabel className="mt-1 block text-center">Commits por día</CapsLabel>
              </div>

              {/* Hyper points: panel destacado */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex w-full items-center justify-center gap-3 rounded-lg bg-panel px-5 py-3 sm:w-auto sm:shrink-0">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-card text-hyper">
                      <Zap className="size-5 fill-hyper/25" />
                    </div>
                    <div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-[28px] font-semibold leading-none tracking-[-0.04em] tabular-nums">{data.kpis.hyperPoints.value}</span>
                        <DeltaBadge metric={data.kpis.hyperPoints} />
                      </div>
                      <CapsLabel className="mt-1.5 block text-hyper">Hyper points</CapsLabel>
                    </div>
                  </div>
                </TooltipTrigger>
                <HyperTooltip />
              </Tooltip>

              <Separator orientation="vertical" className="hidden h-12 self-center sm:block" />
              <div className="w-full sm:w-auto sm:shrink-0">
                <AvailabilityControl
                  devId={data.dev.id}
                  value={shownAvailability}
                  onSaved={(v) => { setAvailability(v); invalidate('/developers'); }}
                />
              </div>
            </CardContent>
          </Card>

          <BalancedGrid max={{ base: 2, md: 3, lg: 5 }} className="mt-3.5">
            <MetricCard label="Commits" value={data.kpis.commits.value} metric={data.kpis.commits} icon={GitCommitHorizontal} colorVar="--chart-1" trend={data.commitTrend} trendKey="commits" />
            <MetricCard label="Líneas cambiadas" value={data.kpis.linesChanged.value} metric={data.kpis.linesChanged} icon={Code2} format={compact} colorVar="--chart-4" />
            <MetricCard label="Tickets resueltos" value={data.kpis.ticketsResolved.value} metric={data.kpis.ticketsResolved} icon={CircleCheck} colorVar="--chart-3" />
            <MetricCard label="Revisiones" value={data.kpis.reviews.value} metric={data.kpis.reviews} icon={Eye} colorVar="--chart-2" />
            <MetricCard label="Cycle time" value={data.kpis.avgCycleTimeHours.value} metric={data.kpis.avgCycleTimeHours} icon={Timer} invert format={hours} colorVar="--chart-5" />
          </BalancedGrid>

          <GithubContributions devId={data.dev.id} />

          <SectionHeader
            size="sm"
            eyebrow="002 · Estilo de trabajo"
            eyebrowColor="purple-deep"
            title="Cómo y dónde trabaja"
            className="mb-4 mt-10"
          />

          {/* Distribución (1.5fr) | skills (1fr). La de distribución marca la altura; las skills la
              llenan con scroll propio si son muchas, en vez de dejar dos tarjetas a lo ancho
              apiladas con media pantalla vacía en cada una. */}
          <CommitRhythm trend={data.commitTrend} />

          <div className="mt-3.5 grid gap-3.5 xl:grid-cols-[1.5fr_1fr]">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Distribución de commits</CardTitle>
                <CardDescription>En qué tamaños de commit se reparte su actividad.</CardDescription>
              </CardHeader>
              <CardContent>
                {data.sizeDist.some((b) => b.commits > 0) ? <SizeDistPanel dist={data.sizeDist} /> : <EmptyState>Sin actividad en este período</EmptyState>}
              </CardContent>
            </Card>

            <Card className="min-w-0 xl:flex xl:flex-col">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>Skills</CardTitle>
                <span className="text-[11px] text-faint tabular-nums">{data.skills.length ? `${data.skills.length} · nivel 1–5` : ''}</span>
              </CardHeader>
              <CardContent className="xl:relative xl:min-h-[12rem] xl:flex-1">
                {data.skills.length ? (
                  <div className="scroll-list [--edge:1rem] sm:[--edge:1.25rem] xl:absolute xl:inset-x-5 xl:bottom-5 xl:top-0">
                    <BalancedGrid max={{ base: 2, sm: 3, xl: 2 }} className="gap-2.5">
                      {[...data.skills].sort((a, b) => b.level - a.level).map((s) => <SkillMeter key={s.tag} tag={s.tag} level={s.level} />)}
                    </BalancedGrid>
                  </div>
                ) : (
                  <EmptyState icon={<GraduationCap />}>Sin skills registradas</EmptyState>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Dos columnas iguales y no 2/3 + 1/3: con la dona a 320px dentro de la tarjeta ancha
              quedaba un anillo chico flotando entre dos huecos. Ahora lleva su leyenda al lado, así
              que la tarjeta se acorta. Las dos se estiran a la misma altura: la de Repos absorbe el
              sobrante en su gráfica (`fill`) y la de la dona lo centra. */}
          <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
            <Card className="flex min-w-0 flex-col">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><FolderGit2 className="size-4" /> Foco por proyecto</CardTitle>
                <CardDescription>Dónde se concentra el trabajo (commits)</CardDescription>
              </CardHeader>
              {/* Una dona no crece de forma útil (es cuadrada), así que esta tarjeta no puede
                  `fill`. Lo que sí puede es centrar: el alto que le sobra al estirarse a la fila se
                  reparte arriba y abajo en vez de quedarse todo al pie como un hueco. */}
              <CardContent className="flex flex-1 flex-col justify-center">
                {data.projects.length ? <Donut data={projectShare(data.projects)} height={200} layout="side" /> : <EmptyState>Sin actividad</EmptyState>}
              </CardContent>
            </Card>
            <Card className="flex min-w-0 flex-col">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>Repos</CardTitle>
                {data.repos.length > 0 && <span className="text-xs text-faint tabular-nums">{String(data.repos.length).padStart(3, '0')}</span>}
              </CardHeader>
              <CardContent className="flex flex-1 flex-col">
                {data.repos.length ? <RepoBars repos={data.repos} /> : <EmptyState>Sin actividad</EmptyState>}
              </CardContent>
            </Card>
          </div>

          <SectionHeader size="sm" eyebrow="003 · Entregas" eyebrowColor="green" title="Actividad y tickets" className="mt-10" />

          {/* Fila a dos columnas: ambas cards se estiran a la misma altura (grid) y su contenido
              hace scroll interno; cap compartido para cuando ambas son muy largas. Solo en desktop. */}
          <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
            <DevActivity devId={data.dev.id} to={period.range.to} />

            <Card className="min-w-0 lg:flex lg:max-h-[480px] lg:flex-col">
              <CardHeader>
                <CardTitle>Tickets</CardTitle>
                <CardDescription>{data.tickets.resolved.length} resueltos · {data.tickets.inProgress.length} en curso · {data.tickets.open.length} abiertos</CardDescription>
              </CardHeader>
              <CardContent className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
                <Tabs defaultValue="resolved" className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
                  <TabsList className="mx-auto flex w-fit lg:shrink-0">
                    <TabsTrigger value="resolved">Resueltos</TabsTrigger>
                    <TabsTrigger value="active">Activos</TabsTrigger>
                  </TabsList>
                  <TabsContent value="resolved" className="[--edge:1rem] sm:[--edge:1.25rem] lg:scroll-list lg:min-h-0 lg:flex-1"><TicketList tickets={data.tickets.resolved} /></TabsContent>
                  <TabsContent value="active" className="[--edge:1rem] sm:[--edge:1.25rem] lg:scroll-list lg:min-h-0 lg:flex-1"><TicketList tickets={[...data.tickets.inProgress, ...data.tickets.open]} /></TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>
        </>
      )}

      <DeveloperDialog
        devId={id}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={() => { reload(); invalidate('/developers'); }}
      />
    </Layout>
  );
}

const PROJECT_COLORS = [
  'hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))',
  'hsl(var(--chart-4))', 'hsl(var(--chart-5))',
];

/** Reparto de commits por proyecto para la dona: top 5 con la paleta + resto agrupado en "Otros"
 *  (regla de paleta categórica: nunca ciclar colores; el excedente se pliega a "Otros"). */
function projectShare(projects: Profile['projects']): { label: string; value: number; color: string }[] {
  const sorted = [...projects].filter((p) => p.commits > 0).sort((a, b) => b.commits - a.commits);
  const top = sorted.slice(0, 5).map((p, i) => ({ label: p.name, value: p.commits, color: PROJECT_COLORS[i]! }));
  const rest = sorted.slice(5).reduce((s, p) => s + p.commits, 0);
  return rest > 0 ? [...top, { label: 'Otros', value: rest, color: 'hsl(var(--faint))' }] : top;
}

/**
 * Repos del dev como columnas. Top 6: la tarjeta ocupa media fila, y por encima de seis los
 * nombres de repo se solapan en el eje. El resto se lee en "Ver todos".
 */
function RepoBars({ repos }: { repos: Profile['repos'] }) {
  return (
    <Columns
      fill
      topN={6}
      color="hsl(var(--chart-4))"
      data={repos.map((r) => ({ label: r.repo.split('/')[1] ?? r.repo, value: r.commits }))}
    />
  );
}

function TicketList({ tickets }: { tickets: Profile['tickets']['open'] }) {
  if (!tickets.length) return <EmptyState>Sin tickets</EmptyState>;
  return (
    <div className="space-y-0.5">
      {tickets.map((t) => (
        <div key={t.id} className="flex items-center gap-3 border-b py-2 last:border-0">
          {/* Sin ancho fijo: `w-16` no alcanzaba para `HYPERFLOW-454` y partía en dos renglones. */}
          <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-faint">{t.identifier}</span>
          <span className="min-w-0 flex-1 truncate text-sm">
            {t.url && t.url !== '#' ? <a href={t.url} target="_blank" rel="noreferrer" className="hover:underline">{t.name}</a> : t.name}
          </span>
          <StateBadge state={t.status} />
        </div>
      ))}
    </div>
  );
}
