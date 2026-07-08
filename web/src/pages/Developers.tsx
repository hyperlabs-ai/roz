import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ChevronRight, GitCommitHorizontal, Code2, CircleCheck, CircleDot, FolderGit2, Plus, Trophy, Crown, Sparkles, Zap } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { UserAvatar, EmptyState, SkillChip } from '@/components/bits';
import { DeveloperDialog } from '@/components/DeveloperDialog';
import { useAuth } from '@/auth/AuthContext';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip';
import { HyperTooltip } from '@/components/HyperTooltip';
import { useApi } from '@/lib/useApi';
import { apiGet, type DeveloperListItem } from '@/lib/api';
import { compact } from '@/lib/format';
import { usePeriod } from '@/lib/usePeriod';
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
  const { data, loading, error, reload } = useApi<{ developers: DeveloperListItem[] }>(
    () => apiGet('/developers', period.range),
    [period.range.from, period.range.to],
  );

  const [metric, setMetric] = useState<RankMetric>('hyper');
  const m = METRICS[metric];

  const sorted = useMemo(
    () => [...(data?.developers ?? [])].sort((a, b) => m.value(b) - m.value(a)),
    [data, m],
  );

  const top3 = useMemo(() => sorted.filter((d) => m.value(d) > 0).slice(0, 3), [sorted, m]);

  const rows = useMemo(
    () => sorted.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()) || (d.githubLogin ?? '').toLowerCase().includes(q.toLowerCase())),
    [sorted, q],
  );

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
          {isAdmin && <Button onClick={() => setCreateOpen(true)}><Plus /> Nuevo developer</Button>}
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
      }
    >
      {/* Buscador en el cuerpo solo en móvil */}
      <div className="mb-4 sm:hidden">{search}</div>

      {error && <Card className="p-4 text-sm text-destructive">{error}</Card>}

      {!loading && !q && sorted.length > 0 && (
        <div className="mb-8">
          <div className="mb-3 flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <Trophy className="size-4 text-amber-500" /> Top 3 por {m.label}
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

      <div className="space-y-3">
        {loading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        {!loading && rows.map((d) => <DevRow key={d.id} d={d} onClick={() => nav(`/app/developers/${d.id}`)} />)}
      </div>

      {!loading && !rows.length && (
        <Card className="mt-2">
          <EmptyState>{q ? 'No hay developers que coincidan' : 'Aún no hay developers'}</EmptyState>
        </Card>
      )}

      <DeveloperDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={reload} />
    </Layout>
  );
}

const RANK_STYLES: Record<number, {
  card: string; ring: string; medal: string; pedestal: string; pedestalH: string;
  avatar: string; commits: string; basis: string; lift: string;
}> = {
  1: {
    card: 'bg-gradient-to-b from-amber-100 to-background ring-2 ring-amber-400 shadow-lg shadow-amber-400/25 dark:from-amber-500/15',
    ring: 'ring-2 ring-amber-400 ring-offset-2 ring-offset-background sm:ring-4',
    medal: '🥇',
    pedestal: 'bg-gradient-to-b from-amber-400 to-amber-500 text-white text-xl sm:text-2xl',
    pedestalH: 'h-16 sm:h-24',
    avatar: 'size-14 sm:size-24',
    commits: 'text-2xl sm:text-5xl',
    basis: 'flex-[1.3] sm:flex-[1.4]',
    lift: '-mt-6 sm:-mt-8',
  },
  2: {
    card: 'bg-gradient-to-b from-slate-100 to-background ring-1 ring-slate-300 dark:from-slate-400/10',
    ring: 'ring-2 ring-slate-300',
    medal: '🥈',
    pedestal: 'bg-gradient-to-b from-slate-300 to-slate-400 text-white text-base sm:text-lg',
    pedestalH: 'h-11 sm:h-16',
    avatar: 'size-11 sm:size-16',
    commits: 'text-lg sm:text-2xl',
    basis: 'flex-1',
    lift: '',
  },
  3: {
    card: 'bg-gradient-to-b from-orange-100/70 to-background ring-1 ring-orange-300 dark:from-orange-500/10',
    ring: 'ring-2 ring-orange-400/70',
    medal: '🥉',
    pedestal: 'bg-gradient-to-b from-orange-400 to-orange-500 text-white text-base sm:text-lg',
    pedestalH: 'h-8 sm:h-10',
    avatar: 'size-11 sm:size-16',
    commits: 'text-lg sm:text-2xl',
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
      {/* Resplandor difuso detrás del ganador */}
      {isFirst && (
        <div className="pointer-events-none absolute -top-6 left-1/2 size-40 -translate-x-1/2 rounded-full bg-amber-300/40 blur-3xl dark:bg-amber-400/20" aria-hidden />
      )}

      <Card
        className={cn(
          'relative z-10 flex w-full flex-col items-center gap-1.5 overflow-visible rounded-b-none px-1.5 pb-4 text-center backdrop-blur-sm transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-xl sm:gap-2 sm:px-3 sm:pb-5',
          isFirst ? 'pt-8 sm:pt-10' : 'pt-6 sm:pt-7',
          s?.card,
        )}
      >
        {isFirst && (
          <>
            <Crown className="absolute left-1/2 -top-3 size-7 -translate-x-1/2 fill-amber-400 text-amber-500 drop-shadow-md transition-transform duration-300 group-hover:-translate-y-0.5 sm:-top-4 sm:size-9" aria-hidden />
            <Sparkles className="absolute right-2 top-2 size-3.5 text-amber-400/80 sm:right-3 sm:top-3 sm:size-4" aria-hidden />
          </>
        )}
        <div className="relative">
          {/* Halo del avatar */}
          <div className={cn('absolute inset-0 -z-10 rounded-full blur-md', isFirst ? 'bg-amber-400/40' : 'bg-transparent')} aria-hidden />
          <UserAvatar url={d.avatarUrl} name={d.name} className={cn('shrink-0', s?.ring, s?.avatar)} />
          <span className={cn('absolute -bottom-1.5 -right-1.5 leading-none drop-shadow-sm', isFirst ? 'text-lg sm:text-3xl' : 'text-base sm:text-xl')} aria-hidden>{s?.medal}</span>
        </div>
        <div className="min-w-0 w-full">
          <div className={cn('truncate font-semibold', isFirst ? 'text-sm sm:text-lg' : 'text-xs sm:text-sm')}>{d.name}</div>
          {d.githubLogin && <div className="hidden truncate text-xs text-muted-foreground sm:block">@{d.githubLogin}</div>}
        </div>
        <div className="mt-0.5 flex flex-col items-center leading-none">
          <span
            className={cn(
              'bg-clip-text font-extrabold tabular-nums text-transparent',
              s?.commits,
              isFirst ? 'bg-gradient-to-b from-amber-500 to-amber-600' : 'bg-gradient-to-b from-primary to-primary/70',
            )}
          >
            {compact(m.value(d))}
          </span>
          <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <MetricIcon className="size-3" /> {m.label}
          </span>
        </div>
      </Card>

      {/* Pedestal: la altura comunica el puesto */}
      <div className={cn('relative w-full overflow-hidden rounded-b-lg shadow-inner', s?.pedestal, s?.pedestalH)}>
        {/* Brillo superior tipo gloss */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/35 to-transparent" aria-hidden />
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-black leading-none opacity-95 drop-shadow-sm">
          {rank}
        </span>
      </div>
    </button>
  );
}

function DevRow({ d, onClick }: { d: DeveloperListItem; onClick: () => void }) {
  return (
    <Card className="group flex cursor-pointer flex-col gap-4 p-4 transition-shadow hover:shadow-md lg:flex-row lg:items-center" onClick={onClick}>
      {/* Identidad (izquierda) */}
      <div className="flex items-center gap-3 lg:w-56 lg:shrink-0">
        <UserAvatar url={d.avatarUrl} name={d.name} className="size-11 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{d.name}</div>
          {d.githubLogin && <div className="truncate text-xs text-muted-foreground">@{d.githubLogin}</div>}
        </div>
      </div>

      {/* Contribuciones destacadas (centro) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[27rem] lg:shrink-0 xl:gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <div><BigStat icon={<Zap className="size-3.5" />} label="Hyper points" value={compact(d.hyperPoints)} accent /></div>
          </TooltipTrigger>
          <HyperTooltip />
        </Tooltip>
        <BigStat icon={<GitCommitHorizontal className="size-3.5" />} label="Commits" value={String(d.commits)} />
        <BigStat icon={<Code2 className="size-3.5" />} label="Líneas" value={compact(d.linesChanged)} />
        <BigStat icon={<CircleCheck className="size-3.5" />} label="Resueltos" value={String(d.ticketsResolved)} />
      </div>

      {/* Skills + secundarios (derecha, ocupa el resto) */}
      <div className="min-w-0 flex-1">
        {d.topSkills.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {d.topSkills.slice(0, 5).map((s) => <SkillChip key={s.tag} tag={s.tag} level={s.level} />)}
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

function BigStat({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent?: boolean }) {
  return (
    <div className={cn('rounded-lg border p-2 text-center', accent ? 'border-primary/20 bg-primary/5' : 'bg-muted/40')}>
      <div className="flex items-center justify-center gap-1 text-muted-foreground">{icon}</div>
      <div className={cn('mt-0.5 text-xl font-bold tabular-nums leading-none', accent && 'text-primary')}>{value}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
