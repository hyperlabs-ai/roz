import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ChevronRight, GitCommitHorizontal, Code2, CircleCheck, CircleDot, FolderGit2, Plus, Trophy, Crown, Zap } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { UserAvatar, EmptyState, SkillChip, ErrorCard, Fresh, RefreshButton, Revalidating } from '@/components/bits';
import { MetricCard } from '@/components/MetricCard';
import { DeveloperDialog } from '@/components/DeveloperDialog';
import { PresencePanel } from '@/components/PresencePanel';
import { useAuth } from '@/auth/AuthContext';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip';
import { HyperTooltip } from '@/components/HyperTooltip';
import { SizeDistBar } from '@/components/CommitSizeDist';
import { useApi } from '@/lib/useApi';
import { useMirror } from '@/lib/useMirror';
import { apiGet, type DeveloperListItem } from '@/lib/api';
import { compact } from '@/lib/format';
import { usePeriod } from '@/lib/usePeriod';
import { useDevPresence } from '@/presence/PresenceContext';
import { cn } from '@/lib/utils';

type RankMetric = 'hyper' | 'commits' | 'lines';

const METRICS: Record<RankMetric, { label: string; icon: typeof Zap; value: (d: DeveloperListItem) => number }> = {
  hyper: { label: 'hyper points', icon: Zap, value: (d) => d.hyperPoints },
  commits: { label: 'commits', icon: GitCommitHorizontal, value: (d) => d.commits },
  lines: { label: 'líneas', icon: Code2, value: (d) => d.linesChanged },
};


export default function Developers() {
  const [period, setPeriod] = usePeriod();
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const { user } = useAuth();
  const isAdmin = !!user; // control total para cualquier usuario autenticado (sin roles)
  const nav = useNavigate();
  const { data, loading, refetching, error, reload } = useApi<{ developers: DeveloperListItem[] }>(
    () => apiGet('/developers', period.range),
    [period.range.from, period.range.to],
    { key: '/developers', ttl: 60_000 },
  );

  // Espejo para que un dev recién creado aparezca YA. Sin él, la lista se ordena por métrica y uno
  // nuevo (0 commits, 0 puntos) caía al final: el toast decía "creado" y no se veía nada.
  const devs = useMirror<DeveloperListItem>(data?.developers, { key: (d) => d.id });

  const [metric, setMetric] = useState<RankMetric>('hyper');
  const m = METRICS[metric];

  const sorted = useMemo(
    () => [...devs.items].sort((a, b) => m.value(b) - m.value(a)),
    [devs.items, m],
  );

  const top3 = useMemo(() => sorted.filter((d) => m.value(d) > 0).slice(0, 3), [sorted, m]);

  const filtered = useMemo(
    () => sorted.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()) || (d.githubLogin ?? '').toLowerCase().includes(q.toLowerCase())),
    [sorted, q],
  );

  // Lo recién creado va al frente, por encima del orden por métrica: si no, nace invisible.
  const rows = useMemo(() => {
    const fresh = filtered.filter((d) => devs.isFresh(d.id));
    return fresh.length ? [...fresh, ...filtered.filter((d) => !devs.isFresh(d.id))] : filtered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, devs.items]);

  const search = (
    <div className="relative w-full">
      <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar developer…" className="pl-8" />
    </div>
  );

  return (
    <Layout
      title="Developers"
      subtitle="Quién contribuye y en qué"
      actions={
        <div className="flex items-center gap-2">
          {/* Buscador en la topbar solo en desktop; en móvil va en el cuerpo */}
          <div className="hidden w-56 sm:block">{search}</div>
          <RefreshButton busy={refetching} onClick={reload} />
          {isAdmin && <Button onClick={() => setCreateOpen(true)}><Plus /> Nuevo developer</Button>}
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
      }
    >
      {/* Buscador en el cuerpo solo en móvil */}
      <div className="mb-4 sm:hidden">{search}</div>

      {error && <ErrorCard message={error} className="mb-4" />}

      {!loading && !q && sorted.length > 0 && (
        <div className="mb-8">
          <div className="mb-3 flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <Trophy className="size-4 text-primary" /> Top 3 por {m.label}
            </div>
            <Tabs value={metric} onValueChange={(v) => setMetric(v as RankMetric)}>
              <TabsList className="h-8">
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* El data-state del tooltip (open/closed) pisa el de la tab (active), así que
                        el estilo de activo va por aria-selected, que el tooltip no toca. */}
                    <TabsTrigger value="hyper" className="text-xs aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm">
                      <Zap /> Hyper points
                    </TabsTrigger>
                  </TooltipTrigger>
                  <HyperTooltip side="bottom" />
                </Tooltip>
                <TabsTrigger value="commits" className="text-xs"><GitCommitHorizontal /> Commits</TabsTrigger>
                <TabsTrigger value="lines" className="text-xs"><Code2 /> Líneas</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {/* Podio: #1 centrado, grande y elevado; #2 izquierda, #3 derecha */}
          {top3.length > 0 && (
            <div className="mx-auto flex max-w-2xl items-end justify-center gap-1.5 pt-7 sm:gap-3 sm:pt-8">
              {[top3[1], top3[0], top3[2]].map((d) =>
                d ? <TopCard key={d.id} d={d} rank={top3.indexOf(d) + 1} metric={metric} onClick={() => nav(`/app/developers/${d.id}`)} /> : null,
              )}
            </div>
          )}
        </div>
      )}

      <Revalidating active={refetching} className="space-y-3">
        {loading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        {!loading && rows.map((d) => (
          <Fresh key={d.id} fresh={devs.isFresh(d.id)}>
            <DevRow d={d} onClick={() => nav(`/app/developers/${d.id}`)} />
          </Fresh>
        ))}
      </Revalidating>

      {!loading && !rows.length && (
        <Card className="mt-2">
          <EmptyState>{q ? 'No hay developers que coincidan' : 'Aún no hay developers'}</EmptyState>
        </Card>
      )}

      <DeveloperDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(dev) => {
          // Inserción optimista con ceros (el backend solo devuelve id y nombre); la revalidación
          // silenciosa rellena las métricas reales.
          const row: DeveloperListItem = {
            id: dev.id, name: dev.name, githubLogin: null, avatarUrl: null, active: true,
            availability: 1, commits: 0, ticketsResolved: 0, openTickets: 0, linesChanged: 0,
            hyperPoints: 0, projects: 0, sizeDist: [], topSkills: [],
          };
          void devs.create(row, async () => row, { success: false }).then(() => reload());
        }}
      />
    </Layout>
  );
}

// Podio pulido con TOKENS del tema (adapta a light y dark): #1 con el acento de marca, #2/#3 en
// neutros. La altura del pedestal comunica el puesto; sin emojis ni degradados crudos amber/slate.
// Podio con la MISMA paleta de charts (theme-aware): #1 azul de marca (sólido, destaca el ganador),
// #2 aqua y #3 naranja (tintados). Cada puesto con su color; la altura del pedestal marca el ranking.
const RANK_STYLES: Record<number, {
  card: string; ring: string; badge: string; pedestal: string; pedestalH: string;
  avatar: string; value: string; basis: string; lift: string;
}> = {
  1: {
    card: 'bg-primary/[0.06] ring-1 ring-primary/30',
    ring: 'ring-2 ring-primary ring-offset-2 ring-offset-background sm:ring-[3px]',
    badge: 'bg-primary text-primary-foreground',
    pedestal: 'bg-primary text-primary-foreground text-xl sm:text-2xl',
    pedestalH: 'h-16 sm:h-24',
    avatar: 'size-14 sm:size-24',
    value: 'text-2xl text-primary sm:text-5xl',
    basis: 'flex-[1.3] sm:flex-[1.4]',
    lift: '-mt-6 sm:-mt-8',
  },
  2: {
    card: 'bg-chart-3/[0.08] ring-1 ring-chart-3/30',
    ring: 'ring-2 ring-chart-3',
    badge: 'bg-chart-3 text-white',
    pedestal: 'bg-chart-3/20 text-chart-3 text-base sm:text-lg',
    pedestalH: 'h-11 sm:h-16',
    avatar: 'size-11 sm:size-16',
    value: 'text-lg text-foreground sm:text-2xl',
    basis: 'flex-1',
    lift: '',
  },
  3: {
    card: 'bg-chart-2/[0.08] ring-1 ring-chart-2/30',
    ring: 'ring-2 ring-chart-2',
    badge: 'bg-chart-2 text-white',
    pedestal: 'bg-chart-2/20 text-chart-2 text-base sm:text-lg',
    pedestalH: 'h-8 sm:h-10',
    avatar: 'size-11 sm:size-16',
    value: 'text-lg text-foreground sm:text-2xl',
    basis: 'flex-1',
    lift: '',
  },
};

function TopCard({ d, rank, metric, onClick }: { d: DeveloperListItem; rank: number; metric: RankMetric; onClick: () => void }) {
  const s = RANK_STYLES[rank];
  const isFirst = rank === 1;
  const m = METRICS[metric];
  const MetricIcon = m.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('group relative flex min-w-0 flex-col items-center focus:outline-none', s?.basis, s?.lift)}
    >
      {/* Resplandor difuso detrás del ganador (azul de marca, sutil en ambos modos) */}
      {isFirst && (
        <div className="pointer-events-none absolute -top-6 left-1/2 size-40 -translate-x-1/2 rounded-full bg-primary/15 blur-3xl" aria-hidden />
      )}

      <Card
        className={cn(
          'relative z-10 flex w-full flex-col items-center gap-1.5 overflow-visible rounded-b-none px-1.5 pb-4 text-center transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-md sm:gap-2 sm:px-3 sm:pb-5',
          isFirst ? 'pt-8 sm:pt-10' : 'pt-6 sm:pt-7',
          s?.card,
        )}
      >
        {isFirst && (
          <Crown className="absolute left-1/2 -top-3 size-7 -translate-x-1/2 fill-primary/20 text-primary transition-transform duration-300 group-hover:-translate-y-0.5 sm:-top-4 sm:size-9" aria-hidden />
        )}
        <div className="relative">
          <UserAvatar url={d.avatarUrl} name={d.name} className={cn('shrink-0', s?.ring, s?.avatar)} />
          {/* Insignia de puesto redibujada (chip numérico tokenizado por rango, no emoji) */}
          <span
            className={cn(
              'absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full text-[10px] font-bold ring-2 ring-card sm:size-6 sm:text-xs',
              s?.badge,
            )}
            aria-hidden
          >
            {rank}
          </span>
        </div>
        <div className="min-w-0 w-full">
          <div className={cn('truncate font-semibold', isFirst ? 'text-sm sm:text-lg' : 'text-xs sm:text-sm')}>{d.name}</div>
          {d.githubLogin && <div className="hidden truncate text-xs text-muted-foreground sm:block">@{d.githubLogin}</div>}
        </div>
        <div className="mt-0.5 flex flex-col items-center leading-none">
          <span className={cn('font-mono font-extrabold tabular-nums', s?.value)}>{compact(m.value(d))}</span>
          <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <MetricIcon className="size-3" /> {m.label}
          </span>
        </div>
      </Card>

      {/* Pedestal: la altura comunica el puesto (bloque sólido con el número, tokenizado) */}
      <div className={cn('relative w-full overflow-hidden rounded-b-lg', s?.pedestal, s?.pedestalH)}>
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-mono font-black leading-none opacity-90">
          {rank}
        </span>
      </div>
    </button>
  );
}

function DevRow({ d, onClick }: { d: DeveloperListItem; onClick: () => void }) {
  const presence = useDevPresence(d.id);
  return (
    // REJILLA, no fila flex, y con TRES pistas de contenido: identidad, métricas y skills.
    //
    // El calendario ya no tiene pista propia. La tuvo, y fue el origen del desfase: `PresencePanel`
    // devuelve `null` cuando el dev no conectó calendario, y en una fila flex ese `null` hacía
    // desaparecer la columna, así que las métricas se corrían y ninguna fila coincidía con la de
    // arriba. Reservar la pista arreglaba la alineación pero dejaba el hueco a la vista. Ahora la
    // actividad se cuelga del bloque de identidad y el problema no existe: no hay pista que
    // reservar ni hueco que rellenar. En móvil no aplica (`lg:`) y sigue siendo una columna.
    <Card
      className="group flex cursor-pointer flex-col gap-4 p-4 transition-shadow hover:shadow-md lg:grid lg:grid-cols-[17rem_27rem_minmax(0,1fr)_auto] lg:items-center"
      onClick={onClick}
    >
      {/* Identidad: avatar, nombre, @handle y —si tiene calendario— qué está haciendo.
          El punto del avatar sigue dando la señal de un vistazo; el renglón da el motivo.

          La actividad va en su PROPIO renglón, a lo ancho de la columna completa, y no metida
          junto al @handle: ahí quedaba indentada bajo el avatar y perdía sus 56px, que es justo el
          ancho que le faltaba para leerse. Con `flex-col` el hueco entre renglones solo existe si
          hay dos, así que un dev sin calendario no paga separación de más.

          `min-w-0` en los dos contenedores no es decorativo: es lo que permite que el título del
          calendario se recorte en vez de empujar la fila. Sin él, el `truncate` de dentro no tiene
          efecto porque la cadena nunca baja de su ancho de contenido. */}
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <UserAvatar url={d.avatarUrl} name={d.name} className="size-11 shrink-0" presence={presence?.status} presenceTitle={presence?.title ?? undefined} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{d.name}</div>
            {d.githubLogin && <div className="truncate text-xs text-muted-foreground">@{d.githubLogin}</div>}
          </div>
        </div>
        <PresencePanel devId={d.id} variant="inline" />
      </div>

      {/* Contribuciones destacadas (centro) */}
      <div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <div><MetricCard layout="center" surface="inset" icon={<Zap className="size-3.5" />} label="Hyper points" value={d.hyperPoints} format={compact} accent /></div>
            </TooltipTrigger>
            <HyperTooltip />
          </Tooltip>
          <MetricCard layout="center" surface="inset" icon={<GitCommitHorizontal className="size-3.5" />} label="Commits" value={d.commits} />
          <MetricCard layout="center" surface="inset" icon={<Code2 className="size-3.5" />} label="Líneas" value={d.linesChanged} format={compact} />
          <MetricCard layout="center" surface="inset" icon={<CircleCheck className="size-3.5" />} label="Resueltos" value={d.ticketsResolved} />
        </div>
        <SizeDistBar dist={d.sizeDist} />
      </div>

      {/* Skills + secundarios (derecha, ocupa el resto) */}
      <div className="min-w-0">
        {/* Top 3 + contador, no top 4 suelto: un dev con cuatro skills de nombre largo
            ("liderazgo-tecnico", "integraciones") las envolvía a cuatro renglones y ESA fila se
            volvía más alta que todas las demás. Tres acotan el alto a dos renglones, y el "+N"
            dice que hay más sin fingir que no existen. La lista completa está en su perfil. */}
        {d.topSkills.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {d.topSkills.slice(0, 3).map((s) => <SkillChip key={s.tag} tag={s.tag} level={s.level} />)}
            {d.topSkills.length > 3 && (
              <span className="rounded-full border border-dashed px-2 py-1 text-xs text-muted-foreground">
                +{d.topSkills.length - 3}
              </span>
            )}
          </div>
        )}
        <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1"><CircleDot className="size-3.5" /> {d.openTickets} abiertos</span>
          <span className="inline-flex items-center gap-1"><FolderGit2 className="size-3.5" /> {d.projects} proyectos</span>
        </div>
      </div>

      <ChevronRight className="hidden size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 lg:block" />
    </Card>
  );
}
