// Pulso del equipo (roz v2): la pantalla principal. Responde "¿qué está pasando ahora?" de un
// vistazo: KPIs de la semana, una tarjeta por persona con trabajo en curso (las demás, en una fila
// compacta), el mapa de calor de la semana y —a la derecha, de alto completo— el historial de
// eventos filtrable (lo que antes eran el feed "En vivo" y la página de Actividad).
//
// Es lectura pura (funciona con el flag apagado). El historial se sondea cada 20 s solo en la semana
// actual; las semanas pasadas son una foto. `/app/activity` y la píldora del header traen aquí con
// `#historial`.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Bot, ChevronLeft, ChevronRight, CircleCheck, GitCommitHorizontal, GitMerge, GitPullRequest, Users } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { BalancedGrid, type GridMax } from '@/components/grid';
import { EmptyState, ErrorCard, ProgressBar, RefreshButton, Revalidating } from '@/components/bits';
import { Eyebrow, GithubAvatar, ProjectIcon } from '@/components/brand';
import { KpiBreakdown, KpiCard } from '@/components/pulse/KpiCard';
import { IdlePeople, PersonCard, isWorking } from '@/components/pulse/PersonCard';
import { PulseHeatmap } from '@/components/pulse/PulseHeatmap';
import { PulseHistory, type HistoryItem } from '@/components/pulse/PulseHistory';
import { Segmented } from '@/components/pulse/roz-v2';
import { isoWeek, personColor } from '@/components/pulse/pulse-ui';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/useApi';
import { usePoll } from '@/lib/usePoll';
import { rozV2Api, type Metric, type PulseFeedItem, type PulseGroupBy, type PulsePerson, type PulseResponse } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const GROUPS: PulseGroupBy[] = ['persona', 'proyecto', 'cliente'];
const FEED_POLL_MS = 20_000;
/** Traslape del sondeo: un commit llega con su fecha de git, que puede ser anterior al último poll. */
const FEED_OVERLAP_MS = 10 * 60_000;
const FEED_MAX = 200;
/**
 * Esqueleto de la pantalla: columna de contenido + historial. En escritorio ocupa como mínimo el
 * alto visible (el mapa de calor se queda con el sobrante), así no queda media pantalla vacía.
 */
const SHELL =
  'grid gap-5 xl:min-h-[calc(100dvh-8rem)] xl:grid-cols-[minmax(0,1fr)_380px] 2xl:grid-cols-[minmax(0,1fr)_420px]';
/** Tope de columnas de las tarjetas de persona: 3 por fila en escritorio (la tarjeta necesita ancho). */
const PEOPLE_MAX: GridMax = { base: 1, md: 2, xl: 3 };

/** Delta contra la semana anterior con la misma forma que el resto de KPIs del dashboard. */
function metric(value: number, previous: number | null): Metric {
  if (previous === null) return { value, compare: null, changePct: null, direction: 'none' };
  if (previous === 0) return { value, compare: 0, changePct: null, direction: value > 0 ? 'up' : 'flat' };
  const pct = Math.round(((value - previous) / previous) * 100);
  return { value, compare: previous, changePct: pct, direction: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' };
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** Lunes de la semana (YYYY-MM-DD) que contiene `from` (ISO de medianoche local del lunes). */
function mondayOf(fromIso: string): string {
  // El backend manda la medianoche de CDMX en UTC (06:00Z): la fecha UTC ya es el lunes.
  return fromIso.slice(0, 10);
}

/** Lunes de la semana actual en la zona del equipo (YYYY-MM-DD). */
function currentMonday(): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return addDays(today, -((dow + 6) % 7));
}

/** Día (YYYY-MM-DD) en la zona del equipo de un instante ISO. */
function teamDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
}

export default function Pulse() {
  const [params, setParams] = useSearchParams();
  const groupParam = params.get('group') as PulseGroupBy | null;
  const groupBy: PulseGroupBy = groupParam && GROUPS.includes(groupParam) ? groupParam : 'persona';
  const weekParam = params.get('week');
  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v === null) p.delete(k);
    else p.set(k, v);
    setParams(p, { replace: true });
  };

  const { data, loading, refetching, error, reload } = useApi<PulseResponse>(
    () => rozV2Api.pulse(groupBy, weekParam),
    [groupBy, weekParam],
    { key: '/pulse', ttl: 30_000 },
  );

  const weekStart = data ? mondayOf(data.period.from) : weekParam;
  const live = !weekParam;

  // ---- Feed en vivo: snapshot del Pulso + lo que llega por sondeo, deduplicado por id.
  const [feed, setFeed] = useState<PulseFeedItem[]>([]);
  const feedRef = useRef<PulseFeedItem[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const lastPoll = useRef<number>(Date.now());
  useEffect(() => {
    if (!data) return;
    feedRef.current = data.feed;
    setFeed(data.feed);
    lastPoll.current = new Date(data.generatedAt).getTime();
  }, [data]);

  usePoll(
    async () => {
      const started = Date.now();
      try {
        const after = new Date(lastPoll.current - FEED_OVERLAP_MS).toISOString();
        const { items } = await rozV2Api.pulseFeed(after);
        lastPoll.current = started;
        const known = new Set(feedRef.current.map((x) => x.id));
        const nuevos = items.filter((x) => !known.has(x.id));
        if (!nuevos.length) return;
        const next = [...nuevos, ...feedRef.current].sort((a, b) => b.at.localeCompare(a.at)).slice(0, FEED_MAX);
        feedRef.current = next;
        setFeed(next);
        setFresh(new Set(nuevos.map((x) => x.id)));
      } catch {
        /* el siguiente sondeo lo vuelve a intentar */
      }
    },
    live && data ? FEED_POLL_MS : null,
  );

  const peopleById = useMemo(() => new Map((data?.people ?? []).map((p) => [p.devId, p])), [data]);

  // ---- `#historial` (la vieja página de Actividad y la píldora del header): lleva al panel y lo
  // resalta un momento. En escritorio ya está a la vista; en móvil queda al fondo.
  const { hash } = useLocation();
  const [flash, setFlash] = useState(false);
  const ready = !!data;
  useEffect(() => {
    if (hash !== '#historial' || !ready) return;
    const el = document.getElementById('historial');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(t);
  }, [hash, ready]);

  // ---- Derivados de presentación (sin llamadas nuevas): serie diaria por persona para la
  // sparkline y eventos de agente por día para la fila morada del mapa de calor.
  const week = weekStart ?? (data ? mondayOf(data.period.from) : null);
  const days = useMemo(() => (week ? Array.from({ length: 7 }, (_, i) => addDays(week, i)) : []), [week]);
  const sparks = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const c of data?.heatmap ?? []) {
      const i = days.indexOf(c.day);
      if (i < 0) continue;
      const row = m.get(c.devId) ?? Array(7).fill(0);
      row[i] += c.count;
      m.set(c.devId, row);
    }
    return m;
  }, [data, days]);
  const agentDays = useMemo(() => {
    const row = Array(7).fill(0) as number[];
    for (const it of feed) {
      if (it.kind !== 'plan') continue;
      const i = days.indexOf(teamDay(it.at));
      if (i >= 0) row[i]! += 1;
    }
    return row;
  }, [feed, days]);

  // Reparto diario de cada KPI, contado del feed. El feed tiene tope: si la suma no cuadra con la
  // cifra del KPI, la serie se descarta en vez de dibujar un reparto incompleto.
  const kindDays = useMemo(() => {
    const out: Record<string, number[]> = { commit: Array(7).fill(0), pr_merged: Array(7).fill(0), issue_closed: Array(7).fill(0) };
    for (const it of feed) {
      const row = out[it.kind];
      if (!row) continue;
      const i = days.indexOf(teamDay(it.at));
      if (i >= 0) row[i]! += 1;
    }
    return out;
  }, [feed, days]);
  const series = (kind: string, value: number) => {
    const row = kindDays[kind]!;
    return value > 0 && row.reduce((a, n) => a + n, 0) === value ? row : null;
  };
  const todayIndex = live ? days.indexOf(teamDay(new Date().toISOString())) : -1;

  const weekLabel = weekStart
    ? `${shortDate(`${weekStart}T12:00:00`)} – ${shortDate(`${addDays(weekStart, 6)}T12:00:00`)}`
    : 'Esta semana';

  // Ciclo más común entre las personas: el del equipo esta semana.
  const cycleNo = useMemo(() => {
    const n = new Map<number, number>();
    for (const p of data?.people ?? []) if (p.cycle) n.set(p.cycle.number, (n.get(p.cycle.number) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }, [data]);

  const eyebrow = [
    weekStart ? `Semana ${isoWeek(weekStart)}` : null,
    weekStart ? weekLabel : null,
    cycleNo != null ? `Ciclo ${cycleNo}` : null,
    !live ? 'Foto' : null,
  ].filter(Boolean).join(' · ');

  return (
    <Layout
      title="Pulso del equipo"
      eyebrow={eyebrow || undefined}
      actions={
        <div className="flex items-center gap-2">
          <Segmented
            value={groupBy}
            onChange={(v) => setParam('group', v === 'persona' ? null : v)}
            options={[
              { value: 'persona', label: 'Personas' },
              { value: 'proyecto', label: 'Proyectos' },
              { value: 'cliente', label: 'Clientes' },
            ]}
          />
          <div className="inline-flex items-center rounded-md bg-panel p-[3px]">
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-[26px] rounded-sm"
              aria-label="Semana anterior"
              disabled={!weekStart}
              onClick={() => weekStart && setParam('week', addDays(weekStart, -7))}
            >
              <ChevronLeft />
            </Button>
            <button
              type="button"
              onClick={() => setParam('week', null)}
              className={cn(
                'h-[26px] min-w-[7.5rem] whitespace-nowrap rounded-sm px-2 text-center text-[12.5px] transition-colors',
                live ? 'bg-card font-semibold shadow-sm' : 'font-medium text-muted-foreground hover:text-foreground',
              )}
              title="Volver a esta semana"
            >
              {live ? 'Esta semana' : weekLabel}
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-[26px] rounded-sm"
              aria-label="Semana siguiente"
              disabled={live || !weekStart}
              onClick={() => {
                if (!weekStart) return;
                const next = addDays(weekStart, 7);
                // Llegar a la semana actual = quitar el parámetro (así vuelve el feed en vivo).
                setParam('week', next >= currentMonday() ? null : next);
              }}
            >
              <ChevronRight />
            </Button>
          </div>
          <RefreshButton busy={refetching} onClick={reload} />
        </div>
      }
    >
      {error && <ErrorCard message={error} className="mb-4" />}

      {loading || !data ? (
        <PulseSkeleton />
      ) : (
        <Revalidating active={refetching} className={SHELL}>
          <div className="flex min-w-0 flex-col gap-5">
          {/* KPIs de la semana (`.kpis` del mock) */}
          <BalancedGrid max={{ base: 2, md: 3, xl: 5 }} className="stagger-children gap-4">
            <KpiCard
              label="Issues cerrados"
              icon={CircleCheck}
              color="green"
              value={data.kpis.issuesClosed}
              metric={metric(data.kpis.issuesClosed, data.kpis.previous.issuesClosed)}
              context={data.kpis.issuesOpened ? `+${data.kpis.issuesOpened} nuevos` : undefined}
              days={series('issue_closed', data.kpis.issuesClosed)}
              todayIndex={todayIndex}
            />
            <KpiCard
              label="PRs integradas"
              icon={GitMerge}
              color="purple"
              value={data.kpis.prsMerged}
              metric={metric(data.kpis.prsMerged, data.kpis.previous.prsMerged)}
              context={data.kpis.prsOpened ? `${data.kpis.prsOpened} abiertas` : undefined}
              days={series('pr_merged', data.kpis.prsMerged)}
              todayIndex={todayIndex}
            />
            <KpiCard
              label="Commits"
              icon={GitCommitHorizontal}
              color="orange"
              value={data.kpis.commits}
              metric={metric(data.kpis.commits, data.kpis.previous.commits)}
              days={series('commit', data.kpis.commits)}
              todayIndex={todayIndex}
            />
            <KpiCard
              label="Personas activas"
              icon={Users}
              color="yellow"
              value={data.kpis.activeDevs}
              context={data.people.length ? `de ${data.people.length}` : undefined}
            >
              <ActivePeople people={data.people} />
            </KpiCard>
            <PlansKpi plans={data.kpis.plans} />
          </BalancedGrid>

          {/* Personas (agrupadas) */}
          <PeopleSection data={data} peopleById={peopleById} sparks={sparks} />

          {/* Mapa de calor de la semana, a todo el ancho de la columna */}
          <Card className="flex flex-1 flex-col p-5">
            <PulseHeatmap
              className="flex-1"
              cells={data.heatmap}
              people={data.people}
              weekStart={weekStart ?? mondayOf(data.period.from)}
              agentDays={agentDays}
            />
          </Card>
          </div>

          {/* Historial: en escritorio ocupa el alto completo de la columna izquierda (sin hueco
              debajo de nada) y hace scroll por dentro; en móvil va al final con alto fijo. */}
          <div className="relative xl:min-h-[36rem]">
            <PulseHistory
              items={feed as HistoryItem[]}
              people={data.people}
              live={live}
              freshIds={fresh}
              className={cn(
                'h-[36rem] transition-shadow duration-500 xl:absolute xl:inset-0 xl:h-auto',
                flash && 'ring-2 ring-orange/40',
              )}
            />
          </div>
        </Revalidating>
      )}
    </Layout>
  );
}

/** KPI de agentes (morado = agentes): planes hechos, avance y el desglose de lo que sigue vivo. */
function PlansKpi({ plans }: { plans: PulseResponse['kpis']['plans'] }) {
  const total = plans.done + plans.running + plans.waitingApproval + plans.claimable;
  return (
    <KpiCard label="Planes del agente" icon={Bot} color="purple-deep" value={plans.done} context={total ? `de ${total}` : 'hechos'}>
      <div className="grid gap-3">
        <ProgressBar pct={total ? Math.round((plans.done / total) * 100) : 0} color="purple-deep" />
        <KpiBreakdown
          items={[
            { label: 'Corriendo', value: plans.running, color: 'purple-deep' },
            { label: 'Por aprobar', value: plans.waitingApproval, color: 'yellow' },
            { label: 'Libres', value: plans.claimable },
          ]}
        />
      </div>
    </KpiCard>
  );
}

/** Pie del KPI de personas: quiénes produjeron algo esta semana, como avatares apilados. */
function ActivePeople({ people }: { people: PulsePerson[] }) {
  const active = people.filter((p) => p.week.commits + p.week.prsOpened + p.week.prsMerged + p.week.issuesClosed > 0);
  const shown = active.slice(0, 5);
  const rest = active.length - shown.length;
  return (
    <div className="flex min-h-[2.75rem] items-center gap-2 border-t pt-3">
      {shown.length ? (
        <span className="flex items-center">
          {shown.map((p) => (
            <span key={p.devId} title={p.name} className="-ml-1.5 rounded-full ring-2 ring-card first:ml-0">
              <GithubAvatar login={p.githubLogin} id={p.devId} url={p.avatarUrl} name={p.name} className="size-7" />
            </span>
          ))}
          {rest > 0 && (
            <span className="-ml-1.5 grid size-7 place-items-center rounded-full bg-panel text-[10.5px] font-semibold tabular-nums text-muted-foreground ring-2 ring-card">
              +{rest}
            </span>
          )}
        </span>
      ) : (
        <span className="text-xs text-faint">Nadie ha producido aún</span>
      )}
    </div>
  );
}

/** Las tarjetas, planas (persona) o por grupo (proyecto/cliente). */
function PeopleSection({
  data,
  peopleById,
  sparks,
}: {
  data: PulseResponse;
  peopleById: Map<string, PulsePerson>;
  sparks: Map<string, number[]>;
}) {
  if (!data.people.length) {
    return (
      <Card className="grid justify-items-center gap-1 py-4">
        <Eyebrow>Equipo</Eyebrow>
        <EmptyState icon={<Users />}>No hay personas activas en roz. Da de alta a tu equipo en Developers.</EmptyState>
      </Card>
    );
  }

  if (data.groupBy === 'persona') return <CardGrid people={data.people} sparks={sparks} />;

  // Proyecto / cliente: una sección por grupo. Quien no cae en ninguno va al final, para que nadie
  // desaparezca del Pulso por no tener proyecto asignado.
  const placed = new Set(data.groups.flatMap((g) => g.devIds));
  const rest = data.people.filter((p) => !placed.has(p.devId));
  // El orden de las tarjetas dentro del grupo es el del backend (activos primero).
  const order = new Map(data.people.map((p, i) => [p.devId, i]));
  const kind = data.groupBy === 'proyecto' ? 'Proyecto' : 'Cliente';
  return (
    <div className="grid gap-6">
      {data.groups.map((g) => {
        const members = g.devIds
          .map((id) => peopleById.get(id))
          .filter((p): p is PulsePerson => !!p)
          .sort((a, b) => (order.get(a.devId) ?? 0) - (order.get(b.devId) ?? 0));
        if (!members.length) return null;
        return (
          <section key={g.key} className="grid gap-3">
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
              <div className="grid gap-1.5">
                <Eyebrow>{kind}</Eyebrow>
                <h2 className="flex items-center gap-2 text-lg font-semibold leading-tight tracking-[-0.025em]">
                  {/* En modo proyecto la clave del grupo ES el id del proyecto. */}
                  {data.groupBy === 'proyecto' && <ProjectIcon id={g.key} name={g.label} size="md" className="size-6" />}
                  {g.label}
                </h2>
              </div>
              <GroupStats people={members.length} kpis={g.kpis} />
            </div>
            <CardGrid people={members} sparks={sparks} />
          </section>
        );
      })}
      {rest.length > 0 && (
        <section className="grid gap-3">
          <div className="grid gap-1.5">
            <Eyebrow color="faint">{kind}</Eyebrow>
            <h2 className="text-lg font-semibold leading-tight tracking-[-0.025em] text-muted-foreground">
              {data.groupBy === 'proyecto' ? 'Sin proyecto' : 'Sin cliente'}
            </h2>
          </div>
          <CardGrid people={rest} sparks={sparks} />
        </section>
      )}
    </div>
  );
}

/** Cifras de un grupo (proyecto/cliente) como íconos + número, no como frase. */
function GroupStats({ people, kpis }: { people: number; kpis: PulseResponse['groups'][number]['kpis'] }) {
  const item = (Icon: typeof Users, n: number, label: string) => (
    <span className={cn('inline-flex items-center gap-1', n === 0 && 'text-faint')} title={`${n} ${label}`}>
      <Icon className="size-3.5" />
      <span className="tabular-nums">{n}</span>
    </span>
  );
  return (
    <span className="flex items-center gap-3 text-[12.5px] text-muted-foreground">
      {item(Users, people, people === 1 ? 'persona' : 'personas')}
      {item(GitCommitHorizontal, kpis.commits, 'commits')}
      {item(GitPullRequest, kpis.prsMerged, 'PRs integradas')}
      {item(CircleCheck, kpis.issuesClosed, 'issues cerrados')}
    </span>
  );
}

/**
 * Quien tiene trabajo en curso → tarjeta en rejilla balanceada (nunca una última fila con huecos);
 * quien no → una fila compacta de píldoras debajo. Si nadie tiene nada en curso, solo la fila.
 */
function CardGrid({ people, sparks }: { people: PulsePerson[]; sparks: Map<string, number[]> }) {
  const working = people.filter(isWorking);
  const idle = people.filter((p) => !isWorking(p));
  return (
    <div className="grid gap-4">
      {working.length > 0 && (
        <BalancedGrid max={PEOPLE_MAX} className="stagger-children gap-4">
          {working.map((p) => (
            <PersonCard key={p.devId} p={p} spark={sparks.get(p.devId) ?? Array(7).fill(0)} color={personColor(p.devId)} />
          ))}
        </BalancedGrid>
      )}
      <IdlePeople people={idle} title={working.length ? 'Sin trabajo en curso' : 'Nadie tiene trabajo en curso'} />
    </div>
  );
}

/** Carga con la misma silueta que la pantalla: KPIs, tarjetas, fila compacta, calor | historial. */
function PulseSkeleton() {
  return (
    <div className={SHELL}>
      <div className="flex min-w-0 flex-col gap-5">
        <BalancedGrid max={{ base: 2, md: 3, xl: 5 }} className="gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="grid h-full gap-3 p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="size-7 rounded-md" />
              </div>
              <Skeleton className="h-8 w-14" />
              <Skeleton className="h-2.5 w-24" />
              <Skeleton className="h-9 rounded-md" />
            </Card>
          ))}
        </BalancedGrid>
        <BalancedGrid max={PEOPLE_MAX} className="gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="grid h-full gap-3.5 p-4">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-10 rounded-full" />
                <div className="grid flex-1 gap-1.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-2.5 w-28" />
                </div>
              </div>
              <Skeleton className="h-12 rounded-l-none rounded-r-md" />
              <Skeleton className="h-6 rounded-md" />
              <Skeleton className="h-1.5 rounded-full" />
              <div className="flex justify-between border-t pt-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-12" />
              </div>
            </Card>
          ))}
        </BalancedGrid>
        <div className="grid gap-3 rounded-lg border border-dashed p-4">
          <Skeleton className="h-2.5 w-32" />
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-md" />
            ))}
          </div>
        </div>
        <Skeleton className="min-h-64 flex-1 rounded-lg" />
      </div>
      <Card className="grid h-[36rem] content-start gap-3.5 p-5 xl:h-auto">
        <div className="flex justify-between">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="h-7 rounded-md" />
        <div className="flex gap-1.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-14 rounded-md" />
          ))}
        </div>
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="flex gap-2.5">
            <Skeleton className="size-6 shrink-0 rounded-md" />
            <div className="grid flex-1 gap-1.5">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-2.5 w-20" />
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
