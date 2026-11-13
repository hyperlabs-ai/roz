// Capacidad — quién es cada quien, en qué está puesto y cuánto le queda.
//
// La carga SALE de las asignaciones (nadie la teclea) y llega ya calculada del backend
// (src/dashboard/capacity.ts). La pantalla se lee de arriba abajo en tres niveles:
//
//   1. KPIs del equipo (rejilla balanceada).
//   2. Columnas de carga por persona contra la línea del 100%, coloreadas por estado.
//   3. Lista densa: una fila por persona, sin inputs. Click → panel lateral donde se edita todo.
//
// Cada mutación devuelve la tabla entera recalculada y se sustituye la copia local con ella, así
// que subir un % repinta la fila, la columna y los KPIs con el mismo viaje.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Gauge, Hourglass, Search, Users, X, AlertTriangle } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorCard, RefreshButton } from '@/components/bits';
import { MetricCard } from '@/components/MetricCard';
import { BalancedGrid } from '@/components/grid';
import { Segmented } from '@/components/pulse/roz-v2';
import { LOAD_GROUPS, loadGroup, type CapacityActions, type LoadGroup } from '@/components/capacity/cells';
import { LoadChart, LoadChartSkeleton } from '@/components/capacity/LoadChart';
import { PeopleListHeader, PersonRow, PersonRowSkeleton } from '@/components/capacity/PeopleList';
import { PersonSheet } from '@/components/capacity/PersonSheet';
import { useAuth } from '@/auth/AuthContext';
import { useApi } from '@/lib/useApi';
import { apiGet, apiSend, type CapacityDev, type CapacityResponse } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

type Scope = 'active' | 'inactive' | 'all';
type GroupFilter = 'all' | LoadGroup;

const KPI_MAX = { base: 2, md: 3, lg: 5 };

export default function Capacity() {
  const { user } = useAuth();
  const canEdit = !!user; // control total para cualquier usuario autenticado (sin roles), como Developers
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<Scope>('active');
  const [group, setGroup] = useState<GroupFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, loading, refetching, error, reload } = useApi<CapacityResponse>(
    () => apiGet('/capacity'),
    [],
    { key: '/capacity', ttl: 60_000 },
  );

  // Copia local: cada mutación devuelve la tabla ya recalculada y se sustituye entera, sin recargar.
  const [table, setTable] = useState<CapacityResponse | null>(null);
  useEffect(() => { if (data) setTable(data); }, [data]);

  const send = async (fn: () => Promise<CapacityResponse>, fallback: string) => {
    try {
      setTable(await fn());
    } catch (e: any) {
      // Las reglas (tope de principales, dedicación) llegan como 400 con su mensaje: se enseña el
      // del servidor, que explica QUÉ hacer, no un "no se pudo" genérico.
      toast.error(fallback, { description: String(e?.message ?? e) });
      // Se relanza para que el panel pinte "No se guardó" en el campo; el panel SIEMPRE lo atrapa
      // (`useSaveState`), así que nunca queda una promesa rechazada suelta.
      throw e;
    }
  };

  const actions: CapacityActions = useMemo(() => ({
    canEdit,
    patchDev: (devId, patch) =>
      send(() => apiSend<CapacityResponse>('PATCH', `/capacity/devs/${devId}`, patch), 'No se pudo guardar'),
    addAssignment: (devId, body) =>
      send(() => apiSend<CapacityResponse>('POST', `/capacity/devs/${devId}/assignments`, body), 'No se pudo añadir'),
    patchAssignment: (id, body) =>
      send(() => apiSend<CapacityResponse>('PATCH', `/capacity/assignments/${id}`, body), 'No se pudo guardar'),
    removeAssignment: (id) =>
      send(() => apiSend<CapacityResponse>('DELETE', `/capacity/assignments/${id}`), 'No se pudo quitar'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [canEdit]);

  const all = table?.devs ?? [];
  const active = useMemo(() => all.filter((d) => d.active), [all]);
  const inactiveCount = all.length - active.length;
  const projects = table?.projects ?? [];
  const totals = table?.totals;

  // Lo que tiene alcance (activos/inactivos) y búsqueda, ANTES del filtro de estado: los contadores
  // del segmentado de estado se calculan sobre esto, así dicen cuántos quedarían al elegir uno.
  const scoped = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((d) => scope === 'all' || (scope === 'active' ? d.active : !d.active))
      .filter((d) => !needle
        || d.name.toLowerCase().includes(needle)
        || (d.profile ?? '').toLowerCase().includes(needle)
        || [...d.principal, ...d.secondary].some((a) =>
          (a.projectName ?? '').toLowerCase().includes(needle) || (a.repo ?? '').toLowerCase().includes(needle)));
  }, [all, q, scope]);

  const groupCount = (g: LoadGroup) => scoped.filter((d) => loadGroup(d) === g).length;
  const rows = useMemo(
    () => (group === 'all' ? scoped : scoped.filter((d) => loadGroup(d) === group))
      // Activos primero y, dentro, de más a menos carga: lo saturado (lo que hay que resolver) arriba.
      .slice()
      .sort((a, b) => Number(b.active) - Number(a.active) || b.load.pct - a.load.pct || a.name.localeCompare(b.name)),
    [scoped, group],
  );
  const chartDevs = useMemo(() => [...active].sort((a, b) => b.load.pct - a.load.pct), [active]);

  const avgPct = active.length ? Math.round(active.reduce((s, d) => s + d.load.pct, 0) / active.length) : 0;
  const hoursFree = active.reduce((s, d) => s + d.load.hoursFree, 0);
  const holgura = active.filter((d) => loadGroup(d) === 'holgura').length;

  const filtered = !!q.trim() || group !== 'all' || scope !== 'active';
  const clearFilters = () => { setQ(''); setGroup('all'); setScope('active'); };
  const openDev: CapacityDev | null = openId ? all.find((d) => d.id === openId) ?? null : null;

  return (
    <Layout title="Capacidad" width="full" actions={<RefreshButton busy={refetching} onClick={reload} />}>
      {error && <ErrorCard message={error} className="mb-4" />}

      {/* ---- 1. KPIs ---- */}
      {loading && !table ? (
        <BalancedGrid max={KPI_MAX} className="mb-3.5 gap-3.5">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-lg" />)}
        </BalancedGrid>
      ) : totals && all.length > 0 ? (
        <BalancedGrid max={KPI_MAX} className="mb-3.5 gap-3.5">
          <MetricCard
            label="Personas activas"
            value={totals.people}
            icon={Users}
            sub={inactiveCount ? `${inactiveCount} inactiva${inactiveCount === 1 ? '' : 's'}` : 'Todo el equipo'}
          />
          <MetricCard
            label="Horas comprometidas"
            value={`${totals.hoursUsed} / ${totals.hours}`}
            icon={Clock}
            sub={totals.hours ? `${Math.round((totals.hoursUsed / totals.hours) * 100)}% de la semana` : undefined}
          />
          <MetricCard label="Carga media" value={avgPct} format={(v) => `${v}%`} icon={Gauge} sub="Por persona activa" />
          <MetricCard
            label="Horas libres"
            value={hoursFree}
            format={(v) => `${v} h`}
            icon={Hourglass}
            tone={hoursFree > 0 ? 'success' : undefined}
            sub={`${holgura} con holgura`}
          />
          <MetricCard
            label="Saturadas"
            value={totals.saturated}
            icon={AlertTriangle}
            tone={totals.saturated > 0 ? 'destructive' : undefined}
            sub={totals.saturated > 0 ? 'Más carga de la que cabe' : 'Nadie por encima'}
          />
        </BalancedGrid>
      ) : null}

      {/* ---- 2. Carga contra capacidad ---- */}
      {(loading && !table) || active.length > 0 ? (
        <Card className="mb-3.5 p-4 sm:p-5">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <CardTitle>Carga contra capacidad</CardTitle>
            <ChartLegend />
          </div>
          {loading && !table
            ? <LoadChartSkeleton />
            : <LoadChart devs={chartDevs} onPick={(d) => setOpenId(d.id)} />}
        </Card>
      ) : null}

      {/* ---- 3. Equipo ---- */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <div className="mr-auto flex items-baseline gap-2">
            <CardTitle>Equipo</CardTitle>
            {table && <span className="text-[12px] tabular-nums text-faint">{rows.length}</span>}
          </div>

          <div className="relative w-full sm:w-60">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar persona, proyecto o repo…"
              className="h-8 pl-8 pr-7 text-[13px]"
              aria-label="Buscar en el equipo"
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ('')}
                aria-label="Limpiar búsqueda"
                className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-faint hover:bg-panel hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          <Segmented<GroupFilter>
            value={group}
            onChange={setGroup}
            className="max-w-full overflow-x-auto scroll-none"
            options={[
              { value: 'all', label: 'Todos' },
              ...LOAD_GROUPS.map((g) => ({
                value: g.value,
                label: g.label,
                icon: <span className={cn('size-1.5 rounded-full', g.dot)} />,
                count: table ? groupCount(g.value) : undefined,
              })),
            ]}
          />

          {inactiveCount > 0 && (
            <Segmented<Scope>
              value={scope}
              onChange={setScope}
              options={[
                { value: 'active', label: 'Activos' },
                { value: 'inactive', label: 'Inactivos', count: inactiveCount },
                { value: 'all', label: 'Todos' },
              ]}
            />
          )}
        </div>

        <div className="border-t">
          {loading && !table ? (
            <>
              <PeopleListHeader />
              <div className="divide-y">
                {Array.from({ length: 6 }).map((_, i) => <PersonRowSkeleton key={i} />)}
              </div>
            </>
          ) : !all.length ? (
            <EmptyState
              icon={<Users />}
              action={
                <Button asChild variant="outline" size="sm">
                  <Link to="/developers">Ir a Developers</Link>
                </Button>
              }
            >
              Todavía no hay gente en el equipo. Cuando des de alta a alguien en Developers, aparece aquí
              para repartirle proyectos.
            </EmptyState>
          ) : !rows.length ? (
            <EmptyState
              icon={<Search />}
              action={filtered ? <Button variant="secondary" size="sm" onClick={clearFilters}>Limpiar filtros</Button> : undefined}
            >
              Nadie coincide con {q.trim() ? <>“{q.trim()}”</> : 'estos filtros'}.
            </EmptyState>
          ) : (
            <>
              <PeopleListHeader />
              <div className="divide-y">
                {rows.map((d) => <PersonRow key={d.id} dev={d} onOpen={() => setOpenId(d.id)} />)}
              </div>
            </>
          )}
        </div>
      </Card>

      <PersonSheet dev={openDev} projects={projects} actions={actions} onClose={() => setOpenId(null)} />
    </Layout>
  );
}

/** Leyenda de la gráfica: los tres grupos de estado y la línea de capacidad. */
function ChartLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground">
      {LOAD_GROUPS.map((g) => (
        <span key={g.value} className="inline-flex items-center gap-1.5">
          <span className={cn('size-2 rounded-[2px]', g.dot)} />
          {g.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="w-4 border-t-[1.5px] border-dashed border-foreground/45" />
        Capacidad (100%)
      </span>
    </div>
  );
}
