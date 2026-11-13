import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, ChevronRight, GitCommitHorizontal, Code2, CircleCheck, CircleDot, FolderGit2, Plus, Crown, Zap, Users, Gauge,
  MoreHorizontal, Pencil, UserX, UserCheck, X, Loader2, CircleOff, ListChecks, History,
} from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { EmptyState, ErrorCard, Fresh, RefreshButton, Revalidating } from '@/components/bits';
import { GithubAvatar, GithubHandle, CapsLabel, SectionHeader } from '@/components/brand';
import { MetricCard } from '@/components/MetricCard';
import { DeveloperDialog } from '@/components/DeveloperDialog';
import { PresencePanel, avatarPresence } from '@/components/PresencePanel';
import { Segmented } from '@/components/pulse/roz-v2';
import { useAuth } from '@/auth/AuthContext';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { HyperTooltip } from '@/components/HyperTooltip';
import { SizeDistBar } from '@/components/CommitSizeDist';
import { TeamPanel } from '@/components/developers/TeamPanel';
import { SkillTiles, SKILL_GRID, SKILL_SLOTS, SLOT_VISIBILITY } from '@/components/developers/SkillTiles';
import { useApi } from '@/lib/useApi';
import { useMirror } from '@/lib/useMirror';
import { invalidate } from '@/lib/store';
import { apiGet, apiSend, type DeveloperListItem } from '@/lib/api';
import { compact } from '@/lib/format';
import { usePeriod } from '@/lib/usePeriod';
import { rangeLabel } from '@/lib/period';
import { useDevPresence } from '@/presence/PresenceContext';
import { cn } from '@/lib/utils';

/**
 * El backend ahora devuelve también a los inactivos (`active: false`) y el correo, para buscar y
 * reactivar desde aquí. Se extiende el tipo localmente para no tocar `lib/api.ts` (compartido).
 */
type DevItem = DeveloperListItem & { email?: string | null };

type RankMetric = 'hyper' | 'commits' | 'lines';
type StatusFilter = 'active' | 'inactive';

const METRICS: Record<RankMetric, { label: string; icon: typeof Zap; value: (d: DevItem) => number }> = {
  hyper: { label: 'hyper points', icon: Zap, value: (d) => d.hyperPoints },
  commits: { label: 'commits', icon: GitCommitHorizontal, value: (d) => d.commits },
  lines: { label: 'líneas', icon: Code2, value: (d) => d.linesChanged },
};

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export default function Developers() {
  const [period, setPeriod] = usePeriod();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [createOpen, setCreateOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [toggling, setToggling] = useState<DevItem | null>(null);
  const { user } = useAuth();
  const isAdmin = !!user; // control total para cualquier usuario autenticado (sin roles)
  const nav = useNavigate();
  const { data, loading, refetching, error, reload } = useApi<{ developers: DevItem[] }>(
    () => apiGet('/developers', period.range),
    [period.range.from, period.range.to],
    { key: '/developers', ttl: 60_000 },
  );

  // Espejo: un dev recién creado (0 commits) aparece YA y al frente, no al final de la lista.
  const devs = useMirror<DevItem>(data?.developers, { key: (d) => d.id });

  const [metric, setMetric] = useState<RankMetric>('hyper');
  const m = METRICS[metric];

  const active = useMemo(() => devs.items.filter((d) => d.active !== false), [devs.items]);
  const inactiveCount = devs.items.length - active.length;

  const sorted = useMemo(() => [...devs.items].sort((a, b) => m.value(b) - m.value(a)), [devs.items, m]);
  const top3 = useMemo(() => sorted.filter((d) => d.active !== false && m.value(d) > 0).slice(0, 3), [sorted, m]);

  const needle = fold(q.trim());
  const rows = useMemo(() => {
    const list = sorted.filter((d) => (status === 'active' ? d.active !== false : d.active === false))
      .filter((d) => !needle || fold(`${d.name} ${d.githubLogin ?? ''} ${d.email ?? ''}`).includes(needle));
    // Lo recién creado va al frente, por encima del orden por métrica: si no, nace invisible.
    const fresh = list.filter((d) => devs.isFresh(d.id));
    return fresh.length ? [...fresh, ...list.filter((d) => !devs.isFresh(d.id))] : list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, status, needle, devs.items]);

  // "/" enfoca el buscador (como en Proyectos).
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || t?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Desactivar / reactivar (PATCH `active`). Optimista: la fila cambia de pestaña en el clic. */
  const toggleActive = (d: DevItem) => {
    const next = d.active === false;
    return devs.patch(
      d,
      { active: next },
      async () => { await apiSend('PATCH', `/developers/${d.id}`, { active: next }); },
      { success: { title: next ? 'Developer reactivado' : 'Developer desactivado', description: d.name } },
    ).then(() => { invalidate('/developers/profile'); invalidate('/overview'); });
  };

  const menu = (d: DevItem) =>
    isAdmin ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Acciones de ${d.name}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onClick={() => setEditId(d.id)}><Pencil className="size-4" /> Editar credenciales</DropdownMenuItem>
          {d.active === false ? (
            <DropdownMenuItem onClick={() => setToggling(d)}><UserCheck className="size-4" /> Reactivar</DropdownMenuItem>
          ) : (
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setToggling(d)}><UserX className="size-4" /> Desactivar…</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  return (
    <Layout
      title="Developers"
      actions={
        <div className="flex items-center gap-2">
          <RefreshButton busy={refetching} onClick={reload} />
          <PeriodPicker value={period} onChange={setPeriod} />
          {isAdmin && <Button variant="brand" onClick={() => setCreateOpen(true)}><Plus /> <span className="hidden sm:inline">Nuevo developer</span></Button>}
        </div>
      }
    >
      {error && <ErrorCard message={error} className="mb-4" />}

      {/* Podio (izquierda) + resumen del equipo (derecha): la fila usa el ancho completo en vez de
          un podio centrado con dos franjas vacías a los lados. */}
      {loading ? (
        <div className="mb-8 grid gap-3.5 lg:grid-cols-[1.5fr_1fr]">
          <Skeleton className="h-[320px] rounded-xl" />
          <Skeleton className="h-[320px] rounded-xl" />
        </div>
      ) : active.length > 0 && (
        <div className="mb-8 grid gap-3.5 lg:grid-cols-[1.5fr_1fr]">
          <section className="flex min-w-0 flex-col gap-4 rounded-xl bg-panel p-4 sm:p-5">
            <SectionHeader
              size="sm"
              eyebrow={`Podio · ${rangeLabel(period)}`}
              title={`Top 3 por ${m.label}`}
              actions={
                <Tabs value={metric} onValueChange={(v) => setMetric(v as RankMetric)}>
                  <TabsList className="bg-card">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {/* El data-state del tooltip pisa el de la tab: el activo va por aria-selected. */}
                        <TabsTrigger value="hyper" className="text-xs aria-selected:bg-panel aria-selected:text-foreground aria-selected:shadow-none">
                          <Zap /> Hyper points
                        </TabsTrigger>
                      </TooltipTrigger>
                      <HyperTooltip side="bottom" />
                    </Tooltip>
                    <TabsTrigger value="commits" className="text-xs"><GitCommitHorizontal /> Commits</TabsTrigger>
                    <TabsTrigger value="lines" className="text-xs"><Code2 /> Líneas</TabsTrigger>
                  </TabsList>
                </Tabs>
              }
            />
            {top3.length > 0 ? (
              <div className="mx-auto flex w-full max-w-2xl flex-1 items-end justify-center gap-1.5 pt-6 sm:gap-3">
                {[top3[1], top3[0], top3[2]].map((d) =>
                  d ? <TopCard key={d.id} d={d} rank={top3.indexOf(d) + 1} metric={metric} onClick={() => nav(`/developers/${d.id}`)} /> : null,
                )}
              </div>
            ) : (
              <div className="grid min-h-[200px] flex-1 place-items-center rounded-lg border border-dashed border-toggle-off text-sm text-muted-foreground">
                Nadie suma {m.label} en este período todavía.
              </div>
            )}
          </section>

          <TeamPanel
            devs={active}
            inactiveCount={inactiveCount}
            periodLabel={rangeLabel(period)}
            metricKey={metric}
            metricLabel={m.label}
            metricValue={m.value}
            onPick={(devId) => nav(`/developers/${devId}`)}
          />
        </div>
      )}

      {/* Equipo: buscador + filtro de estado, luego la lista */}
      {!loading && devs.items.length > 0 && (
        <div className="mb-3.5 flex flex-wrap items-end gap-3">
          <SectionHeader
            size="sm"
            eyebrow={`Equipo · ${active.length} ${active.length === 1 ? 'persona' : 'personas'}`}
            eyebrowColor="ink"
            title="Todos los developers"
            className="mr-auto"
          />
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" />
              <Input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQ('')}
                placeholder="Buscar por nombre, GitHub o correo"
                aria-label="Buscar developers"
                className="pl-8 pr-8"
              />
              {q ? (
                <button type="button" onClick={() => setQ('')} aria-label="Limpiar búsqueda" className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-faint hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              ) : (
                <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-[4px] border bg-panel px-1.5 text-[11px] text-faint sm:block">/</kbd>
              )}
            </div>
            <Segmented<StatusFilter>
              value={status}
              onChange={setStatus}
              options={[
                { value: 'active', label: 'Activos', count: active.length },
                { value: 'inactive', label: 'Inactivos', count: inactiveCount },
              ]}
            />
          </div>
        </div>
      )}

      <Revalidating active={refetching} className="space-y-3">
        {loading && Array.from({ length: 5 }).map((_, i) => <DevRowSkeleton key={i} />)}
        {!loading && rows.map((d) => (
          <Fresh key={d.id} fresh={devs.isFresh(d.id)}>
            <DevRow d={d} busy={devs.isBusy(d.id)} menu={menu(d)} onClick={() => nav(`/developers/${d.id}`)} />
          </Fresh>
        ))}
      </Revalidating>

      {!loading && !rows.length && (
        <Card className="mt-2">
          <EmptyState
            icon={q ? <Search /> : status === 'inactive' ? <UserX /> : <Users />}
            action={
              q ? <Button size="sm" variant="secondary" onClick={() => setQ('')}>Limpiar búsqueda</Button>
                : status === 'active' && isAdmin ? <Button size="sm" variant="brand" onClick={() => setCreateOpen(true)}><Plus /> Nuevo developer</Button>
                : undefined
            }
          >
            {q ? `Nadie coincide con "${q.trim()}".` : status === 'inactive' ? 'No hay developers inactivos.' : 'Aún no hay developers. Da de alta al primero con su GitHub para empezar a atribuirle commits.'}
          </EmptyState>
        </Card>
      )}

      <DeveloperDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(dev) => {
          // Inserción optimista con ceros (el backend solo devuelve id y nombre); la revalidación
          // silenciosa rellena las métricas reales.
          const row: DevItem = {
            id: dev.id, name: dev.name, githubLogin: null, avatarUrl: null, active: true,
            availability: 1, commits: 0, ticketsResolved: 0, openTickets: 0, linesChanged: 0,
            hyperPoints: 0, projects: 0, sizeDist: [], topSkills: [],
          };
          setStatus('active');
          setQ('');
          void devs.create(row, async () => row, { success: false }).then(() => reload());
        }}
      />
      <DeveloperDialog
        devId={editId}
        open={!!editId}
        onOpenChange={(v) => !v && setEditId(null)}
        onSaved={() => { reload(); invalidate('/developers/profile'); }}
      />
      <ToggleActiveDialog dev={toggling} onOpenChange={(v) => !v && setToggling(null)} onConfirm={toggleActive} />
    </Layout>
  );
}

function Consequence({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[13px] leading-snug">
      <span className="mt-px grid size-6 shrink-0 place-items-center rounded-md bg-panel text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}

/** Confirmación de desactivar / reactivar, con lo que pasa en cada caso. Nunca se borra a un dev. */
function ToggleActiveDialog({
  dev,
  onOpenChange,
  onConfirm,
}: {
  dev: DevItem | null;
  onOpenChange: (v: boolean) => void;
  onConfirm: (d: DevItem) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const reactivating = dev?.active === false;
  async function confirm() {
    if (!dev) return;
    setBusy(true);
    try { await onConfirm(dev); onOpenChange(false); } finally { setBusy(false); }
  }
  return (
    <AlertDialog open={!!dev} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{reactivating ? `Reactivar a ${dev?.name}` : `Desactivar a ${dev?.name}`}</AlertDialogTitle>
          <AlertDialogDescription>
            {reactivating ? 'Vuelve al equipo activo con todo su historial.' : 'Sale del equipo activo sin perder nada.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="grid gap-2">
          {reactivating ? (
            <>
              <Consequence icon={<ListChecks />}>roz vuelve a considerarlo al asignar tareas.</Consequence>
              <Consequence icon={<Users />}>Aparece otra vez en el podio y en el resumen del equipo.</Consequence>
            </>
          ) : (
            <>
              <Consequence icon={<CircleOff />}>roz deja de asignarle tareas nuevas.</Consequence>
              <Consequence icon={<Users />}>Sale del podio y del resumen; lo ves en la pestaña Inactivos.</Consequence>
              <Consequence icon={<History />}>Sus commits, tareas y skills se conservan. Puedes reactivarlo cuando quieras.</Consequence>
            </>
          )}
        </ul>
        <AlertDialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant={reactivating ? 'default' : 'destructive'} onClick={confirm} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : reactivating ? <UserCheck /> : <UserX />}
            {reactivating ? 'Reactivar' : 'Desactivar'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Podio con la identidad del mock (tokens, claro y oscuro): #1 naranja roz sólido, #2 morado sobre
// lavanda, #3 amarillo sobre crema. Plano, sin brillos: la altura del pedestal marca el puesto.
const RANK_STYLES: Record<number, {
  card: string; ring: string; badge: string; pedestal: string; pedestalH: string;
  avatar: string; value: string; basis: string; lift: string;
}> = {
  1: {
    card: 'border-orange/40',
    ring: 'ring-2 ring-orange ring-offset-2 ring-offset-card sm:ring-[3px]',
    badge: 'bg-orange text-white',
    pedestal: 'bg-orange text-white text-xl sm:text-2xl',
    pedestalH: 'h-16 sm:h-24',
    avatar: 'size-14 sm:size-24',
    value: 'text-2xl text-orange sm:text-5xl',
    basis: 'flex-[1.3] sm:flex-[1.4]',
    lift: '-mt-6 sm:-mt-8',
  },
  2: {
    card: '',
    ring: 'ring-2 ring-purple',
    badge: 'bg-purple-deep text-background',
    pedestal: 'bg-lavender text-purple-deep text-base sm:text-lg',
    pedestalH: 'h-11 sm:h-16',
    avatar: 'size-11 sm:size-16',
    value: 'text-lg text-foreground sm:text-2xl',
    basis: 'flex-1',
    lift: '',
  },
  3: {
    card: '',
    ring: 'ring-2 ring-yellow',
    badge: 'bg-yellow text-ink',
    pedestal: 'bg-yellow-soft text-yellow-ink text-base sm:text-lg',
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
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('group relative flex min-w-0 flex-col items-center focus:outline-none', s?.basis, s?.lift)}
    >
      <Card
        className={cn(
          'relative z-10 flex w-full flex-col items-center gap-1.5 overflow-visible rounded-b-none px-1.5 pb-4 text-center transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-md sm:gap-2 sm:px-3 sm:pb-5',
          isFirst ? 'pt-8 sm:pt-10' : 'pt-6 sm:pt-7',
          s?.card,
        )}
      >
        {isFirst && (
          <Crown className="absolute left-1/2 -top-3 size-7 -translate-x-1/2 fill-orange-soft text-orange transition-transform duration-300 group-hover:-translate-y-0.5 sm:-top-4 sm:size-9" aria-hidden />
        )}
        <div className="relative">
          <GithubAvatar login={d.githubLogin} url={d.avatarUrl} id={d.id} name={d.name} color="orange" className={cn('shrink-0', s?.ring, s?.avatar)} />
          {/* Insignia de puesto (chip numérico tokenizado por rango, no emoji) */}
          <span
            className={cn(
              'absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full text-[10px] font-bold ring-2 ring-card sm:size-6 sm:text-xs tabular-nums',
              s?.badge,
            )}
            aria-hidden
          >
            {rank}
          </span>
        </div>
        <div className="grid w-full min-w-0 justify-items-center gap-0.5">
          <div className={cn('max-w-full truncate font-semibold tracking-[-0.02em]', isFirst ? 'text-sm sm:text-lg' : 'text-xs sm:text-sm')}>{d.name}</div>
          {d.githubLogin && (
            <span className="hidden max-w-full sm:inline-flex" onClick={(e) => e.stopPropagation()}>
              <GithubHandle login={d.githubLogin} />
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-col items-center leading-none">
          <span className={cn('font-semibold tabular-nums tracking-[-0.04em]', s?.value)}>{compact(m.value(d))}</span>
          <CapsLabel className="mt-1.5">{m.label}</CapsLabel>
        </div>
      </Card>

      {/* Pedestal: la altura comunica el puesto (bloque sólido con el número mono, "001") */}
      <div className={cn('relative w-full overflow-hidden rounded-b-lg', s?.pedestal, s?.pedestalH)}>
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-semibold leading-none tabular-nums">
          {String(rank).padStart(3, '0')}
        </span>
      </div>
    </button>
  );
}

/**
 * Rejilla de la fila, compartida con su esqueleto.
 *
 *  · `xl`  — cuatro pistas: identidad | métricas | skills | acciones.
 *  · `lg`  — no cabe todo a lo ancho: la identidad ocupa la izquierda (dos renglones) y a su
 *            derecha se apilan métricas y skills.
 *  · base  — columna.
 *
 * SIN `items-center`: métricas y skills se estiran al mismo alto y cada una reparte el suyo en dos
 * renglones (fichas arriba, línea de detalle abajo), así las fichas de skill miden lo mismo que las
 * de métrica y los dos pies quedan en la misma línea.
 */
const ROW_GRID =
  'flex flex-col gap-4 p-4 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)_auto] lg:gap-x-5 xl:grid-cols-[16rem_26rem_minmax(0,1fr)_auto]';
const ROW_IDENTITY = 'lg:row-span-2 lg:self-center xl:row-span-1';
const ROW_SKILLS = 'lg:col-start-2 xl:col-start-3 xl:row-start-1';
const ROW_ACTIONS = 'lg:col-start-3 lg:row-start-1 xl:col-start-4 xl:self-center';

/** Esqueleto de una fila de developer: misma rejilla que `DevRow`. */
function DevRowSkeleton() {
  return (
    <Card className={ROW_GRID}>
      <div className={cn('flex items-center gap-3', ROW_IDENTITY)}>
        <Skeleton className="size-11 rounded-full" />
        <div className="grid gap-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[66px] rounded-md" />)}
        </div>
        <Skeleton className="mt-2 h-1.5 rounded-full" />
        <Skeleton className="mt-2 h-[11px] w-56" />
      </div>
      <div className={ROW_SKILLS}>
        <div className={SKILL_GRID}>
          {Array.from({ length: SKILL_SLOTS }).map((_, i) => (
            <Skeleton key={i} className={cn('h-[66px] rounded-md', SLOT_VISIBILITY[i])} />
          ))}
        </div>
        <Skeleton className="mt-5 h-[11px] w-48" />
      </div>
      <span className={ROW_ACTIONS} />
    </Card>
  );
}

/** Dato suelto del pie de la fila: icono + cifra resaltada + sustantivo. */
function Fact({ icon, value, label }: { icon: ReactNode; value: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap [&_svg]:size-3 [&_svg]:text-faint">
      {icon}
      <span className="font-medium text-foreground">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function DevRow({ d, busy, menu, onClick }: { d: DevItem; busy: boolean; menu: ReactNode; onClick: () => void }) {
  const presence = useDevPresence(d.id);
  const inactive = d.active === false;
  const availability = Math.round((d.availability ?? 1) * 100);
  return (
    // REJILLA, no fila flex, con TRES pistas de contenido (identidad, métricas, skills) + acciones.
    // La actividad del calendario cuelga del bloque de identidad: `PresencePanel` devuelve `null`
    // sin calendario y en una pista propia eso desalineaba las filas.
    <Card
      interactive
      className={cn('group relative', ROW_GRID, inactive && 'bg-sidebar', busy && 'opacity-60')}
      onClick={onClick}
    >
      <div className={cn('flex min-w-0 flex-col gap-2 pr-8 lg:pr-0', ROW_IDENTITY)}>
        <div className="flex min-w-0 items-center gap-3">
          <GithubAvatar
            login={d.githubLogin}
            id={d.id}
            email={d.email}
            url={d.avatarUrl}
            name={d.name}
            presence={inactive ? undefined : avatarPresence(presence?.status)}
            className={cn('size-11', inactive && 'grayscale')}
          />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-semibold tracking-[-0.01em]">{d.name}</span>
              {inactive && <Badge variant="neutral" className="shrink-0 text-[10.5px]">Inactivo</Badge>}
            </div>
            {d.githubLogin ? (
              <span className="inline-flex min-w-0" onClick={(e) => e.stopPropagation()}>
                <GithubHandle login={d.githubLogin} />
              </span>
            ) : (
              <CapsLabel>Sin GitHub</CapsLabel>
            )}
          </div>
        </div>
        {!inactive && <PresencePanel devId={d.id} variant="inline" />}
      </div>

      {/* Contribuciones del período: fichas + cómo se reparten sus líneas por tamaño de commit */}
      <div className="flex min-w-0 flex-col">
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
        <SizeDistBar dist={d.sizeDist} placeholder />
      </div>

      {/* Skills en pistas fijas + pie con la carga: mismo esquema de dos renglones que las métricas */}
      <div className={cn('flex min-w-0 flex-col', ROW_SKILLS)}>
        <SkillTiles skills={d.topSkills} className="flex-1" />
        <div className="mt-2 flex min-h-[25px] flex-wrap items-end gap-x-4 gap-y-1 text-[11px] leading-none tabular-nums">
          <Fact icon={<CircleDot />} value={d.openTickets} label={d.openTickets === 1 ? 'tarea abierta' : 'tareas abiertas'} />
          <Fact icon={<FolderGit2 />} value={d.projects} label={d.projects === 1 ? 'proyecto' : 'proyectos'} />
          <Fact icon={<Gauge />} value={`${availability}%`} label="disponible" />
        </div>
      </div>

      {/* Acciones: arriba a la derecha en móvil, última pista en escritorio */}
      <div className={cn('absolute right-3 top-3 lg:static', ROW_ACTIONS)}>
        {menu ?? <ChevronRight className="hidden size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-orange lg:block" />}
      </div>
    </Card>
  );
}
