import { useMemo, useState } from 'react';
import { Ticket as TicketIcon, CircleAlert, UserX, CircleDot, CircleCheck, GitPullRequest, GitMerge } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { WorkReport } from '@/components/reports/WorkReport';
import { usePeriod } from '@/lib/usePeriod';
import { BalancedGrid } from '@/components/grid';
import { MetricCard } from '@/components/MetricCard';
import { Columns, Donut } from '@/components/charts';
import { UserAvatar, EmptyState, ErrorCard, Revalidating } from '@/components/bits';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useApi } from '@/lib/useApi';
import { cn } from '@/lib/utils';
import { apiGet, type TicketsResponse, type TicketFilterOptions } from '@/lib/api';
import {
  PRIO_COLOR_VAR as PRIO_COLOR,
  PRIO_LABEL as PRIO_ES,
  stateColorVar as STATE_COLOR,
  stateRank,
  SOURCE_LABEL,
  SOURCE_COLOR,
} from '@/lib/labels';

const ALL = '__all__';

type View = 'work' | 'tasks';
const VIEW_KEY = 'roz.reports.view';
const VIEWS: { id: View; label: string }[] = [
  { id: 'work', label: 'Trabajo y enfoque' },
  { id: 'tasks', label: 'Tareas' },
];

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'tasks' ? 'tasks' : 'work';
  } catch {
    return 'work';
  }
}

/** Control segmentado del topbar (misma receta que el de Abiertos/Todos). */
function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md bg-panel p-[3px]">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={cn(
            'h-7 whitespace-nowrap rounded-sm px-3 text-[12.5px] transition-colors',
            value === o.id ? 'bg-card font-semibold text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.08)]' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Reportes tiene dos lecturas:
 *  · Trabajo y enfoque — a dónde se fue el esfuerzo del período (código + tareas) y si coincide con
 *    el plan de Capacidad. Acotada por el selector de período compartido.
 *  · Tareas — la foto del backlog por estado, prioridad, origen y atribución de PRs.
 */
export default function Tickets() {
  const [view, setViewState] = useState<View>(loadView);
  const [period, setPeriod] = usePeriod();
  const [scope, setScope] = useState<'open' | 'all'>('open');
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* solo en memoria */
    }
  };

  return (
    <Layout
      title="Reportes"
      actions={
        <>
          <Segmented value={view} onChange={setView} options={VIEWS} label="Vista" />
          {view === 'work' ? (
            <PeriodPicker value={period} onChange={setPeriod} />
          ) : (
            <Segmented value={scope} onChange={setScope} label="Alcance" options={[{ id: 'open', label: 'Abiertos' }, { id: 'all', label: 'Todos' }]} />
          )}
        </>
      }
    >
      {view === 'work' ? <WorkReport period={period} /> : <TaskReport scope={scope} />}
    </Layout>
  );
}

/**
 * Reportes: capa de análisis sobre el trabajo del equipo (mismo `work_item` que Tareas).
 * La gestión (lista/edición) vive en Tareas; aquí solo métricas, distribución y atribución.
 * Los filtros acotan el reporte (afectan KPIs y gráficas vía el querystring del fetch).
 */
function TaskReport({ scope }: { scope: 'open' | 'all' }) {
  const [projectId, setProjectId] = useState(ALL);
  const [state, setState] = useState(ALL);
  const [assignee, setAssignee] = useState(ALL);
  const [priority, setPriority] = useState(ALL);

  // Las opciones de filtro son casi estáticas y se piden también en Tareas: 10 min de caché y una
  // sola petición por sesión.
  const filters = useApi<TicketFilterOptions>(() => apiGet('/tickets/filters'), [], {
    key: '/tickets/filters',
    ttl: 600_000,
  });
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectId !== ALL) p.set('projectId', projectId);
    if (state !== ALL) p.set('state', state);
    if (assignee !== ALL) p.set('assignee', assignee);
    if (priority !== ALL) p.set('priority', priority);
    p.set('scope', scope);
    return p.toString();
  }, [projectId, state, assignee, priority, scope]);

  // La consulta más cara de la app (hasta 1500 filas + atribución + esfuerzo). Con caché, volver a
  // un filtro que ya viste es instantáneo.
  const { data, loading, refetching, error } = useApi<TicketsResponse>(() => apiGet(`/tickets?${qs}`), [qs], {
    key: '/tickets',
    ttl: 30_000,
  });

  return (
    <>
      {error && <ErrorCard message={error} className="mb-4" />}

      {/* Filtros: acotan el reporte */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterSelect value={projectId} onChange={setProjectId} placeholder="Proyecto" options={(filters.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        <FilterSelect value={state} onChange={setState} placeholder="Estado" options={(filters.data?.states ?? []).map((s) => ({ value: s.value, label: s.label }))} />
        <FilterSelect value={assignee} onChange={setAssignee} placeholder="Responsable" options={(filters.data?.devs ?? []).map((d) => ({ value: d.id, label: d.name }))} />
        <FilterSelect value={priority} onChange={setPriority} placeholder="Prioridad" options={[
          { value: 'urgent', label: 'Urgente' }, { value: 'high', label: 'Alta' }, { value: 'medium', label: 'Media' }, { value: 'low', label: 'Baja' },
        ]} />
      </div>

      {/* KPIs */}
      {loading || !data ? (
        <div className="grid gap-3.5"><BalancedGrid max={{ base: 2, md: 3, lg: 5 }}>{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[92px]" />)}</BalancedGrid><div className="grid gap-3.5 lg:grid-cols-2"><Skeleton className="h-64" /><Skeleton className="h-64" /></div></div>
      ) : (
        /* Cambiar un filtro refetchea: los KPIs y las gráficas viejas se atenúan hasta que llegan
           los nuevos. Antes seguían mostrando los números del filtro ANTERIOR, sin ninguna señal:
           leías datos que no correspondían al filtro que ya veías seleccionado. */
        <Revalidating active={refetching}>
          <BalancedGrid max={{ base: 2, md: 3, lg: 5 }}>
            <MetricCard label="Total" value={data.summary.total} icon={TicketIcon} colorVar="--orange" />
            <MetricCard label="En curso" value={data.summary.inProgress} icon={CircleDot} colorVar="--blue" />
            <MetricCard label="Completados" value={data.summary.completed} icon={CircleCheck} colorVar="--green" />
            <MetricCard label="Vencidos" value={data.summary.overdue} icon={CircleAlert} colorVar="--red" tone={data.summary.overdue > 0 ? 'destructive' : undefined} />
            <MetricCard label="Sin asignar" value={data.summary.unassigned} icon={UserX} colorVar="--yellow" />
          </BalancedGrid>

          {/* Dos tarjetas por fila, no cuatro: con cuatro quedaban ~290px a cada una, o sea 48px
              por etiqueta, y los nombres se recortaban a "Hype…" — dos proyectos distintos con la
              MISMA etiqueta. La rejilla anterior estaba pensada para barras finas, que no necesitan
              ancho por categoría; una gráfica de columnas sí.

              Las tarjetas SE ESTIRAN a la altura de su fila (fondos alineados) y las gráficas van
              en modo `fill`, así que el alto de más se lo queda la gráfica en vez de volverse
              hueco. Cada fila del grid se mide por separado, por eso las dos donas de abajo no
              arrastran la altura de las columnas de arriba. */}
          <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
            <Card className="flex min-w-0 flex-col">
              <CardHeader><CardTitle>Por proyecto</CardTitle></CardHeader>
              <CardContent className="flex flex-1 flex-col"><Columns data={data.byProject} fill topN={6} /></CardContent>
            </Card>
            <Card className="flex min-w-0 flex-col">
              <CardHeader><CardTitle>Por estado</CardTitle></CardHeader>
              {/* Columnas en ORDEN DE PIPELINE (`sort={false}` + `stateRank`), no por valor: los
                  estados son una secuencia y verlos desordenados no dice nada. El backend agrupa
                  con un contador, así que el orden en que llegan depende de los tickets que había.

                  Aquí estuvo un embudo y se quitó: calculaba "conversión" entre estados que no son
                  etapas consecutivas del mismo flujo, y con 521 completadas sobre 21 por hacer
                  imprimía un 2481% que no significaba nada. */}
              <CardContent className="flex flex-1 flex-col">
                <Columns
                  fill
                  sort={false}
                  data={[...data.byState]
                    .sort((a, b) => stateRank(a.label) - stateRank(b.label))
                    .map((s) => ({ ...s, color: STATE_COLOR(s.label) }))}
                />
              </CardContent>
            </Card>
            <Card className="min-w-0">
              <CardHeader><CardTitle>Por prioridad</CardTitle></CardHeader>
              <CardContent>
                {/* Leyenda al lado: en una tarjeta de media fila, la dona debajo de su leyenda
                    dejaba el anillo chico en medio de dos huecos. */}
                <Donut data={data.byPriority.map((p) => ({ label: PRIO_ES[p.label] ?? p.label, value: p.value, color: PRIO_COLOR[p.label] ?? 'hsl(var(--muted-foreground))' }))} height={170} layout="side" centerLabel="tickets" />
              </CardContent>
            </Card>
            <Card className="min-w-0">
              <CardHeader><CardTitle>Por origen</CardTitle></CardHeader>
              <CardContent>
                <Donut data={data.bySource.map((s) => ({ label: SOURCE_LABEL[s.label] ?? s.label, value: s.value, color: SOURCE_COLOR[s.label] ?? 'hsl(var(--muted-foreground))' }))} height={170} layout="side" centerLabel="tickets" />
              </CardContent>
            </Card>
          </div>

          {/* Insight de atribución: lo que Linear no muestra. Solo si hay señal. */}
          {(data.attributionMismatch > 0 || data.withoutPr > 0) && (
            <BalancedGrid max={{ base: 1, sm: 2 }} className="mt-3.5 gap-3.5">
              {data.attributionMismatch > 0 && (
                <Card className="border-0 bg-yellow-soft">
                  <CardContent className="flex items-center gap-3 py-4">
                    <GitMerge className="size-5 shrink-0 text-yellow-ink" />
                    <p className="text-[13.5px]">
                      <span className="font-semibold">{data.attributionMismatch}</span> ticket{data.attributionMismatch === 1 ? '' : 's'} mergeado{data.attributionMismatch === 1 ? '' : 's'} por alguien <span className="font-medium">distinto al autor</span>.
                    </p>
                  </CardContent>
                </Card>
              )}
              {data.withoutPr > 0 && (
                <Card>
                  <CardContent className="flex items-center gap-3 py-4">
                    <GitPullRequest className="size-5 shrink-0 text-muted-foreground" />
                    <p className="text-[13.5px]">
                      <span className="font-semibold">{data.withoutPr}</span> ticket{data.withoutPr === 1 ? '' : 's'} cerrado{data.withoutPr === 1 ? '' : 's'} <span className="font-medium">sin PR vinculado</span>.
                    </p>
                  </CardContent>
                </Card>
              )}
            </BalancedGrid>
          )}

          {/* Personas: responsables vs. revisores (atribución por PR) */}
          <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Developers involucrados</CardTitle></CardHeader>
              <CardContent>
                {data.developers.length ? (
                  <div className="flex flex-wrap gap-2">
                    {data.developers.map((d) => (
                      <div key={d.name} className="flex items-center gap-2 rounded-full bg-panel py-1 pl-1 pr-1.5">
                        <UserAvatar url={d.avatarUrl} id={d.devId} name={d.name} className="size-6" />
                        <span className="text-[13px] font-medium">{d.name}</span>
                        <span className="rounded-full bg-card px-2 text-[11px] tabular-nums text-muted-foreground">{d.count}</span>
                      </div>
                    ))}
                  </div>
                ) : <EmptyState>Sin responsables asignados</EmptyState>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Atribución de PRs</CardTitle>
                <CardDescription>Quién revisa y quién integra el trabajo</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <PeopleGroup label="Revisores" people={data.topReviewers} empty="Sin revisiones registradas" />
                <PeopleGroup label="Merges" people={data.topMergers} empty="Sin merges registrados" />
              </CardContent>
            </Card>
          </div>
        </Revalidating>
      )}
    </>
  );
}

/** Grupo de personas con etiqueta (revisores / merges): chips avatar + nombre + conteo. */
function PeopleGroup({ label, people, empty }: { label: string; people: TicketsResponse['topReviewers']; empty: string }) {
  return (
    <div>
      <div className="label-caps mb-2 block">{label}</div>
      {people.length ? (
        <div className="flex flex-wrap gap-2">
          {people.map((r) => (
            <div key={r.name} className="flex items-center gap-2 rounded-full bg-panel py-1 pl-1 pr-1.5">
              <UserAvatar url={r.avatarUrl} id={r.devId} name={r.name} className="size-6" />
              <span className="text-[13px] font-medium">{r.name}</span>
              <span className="rounded-full bg-card px-2 text-[11px] tabular-nums text-muted-foreground">{r.count}</span>
            </div>
          ))}
        </div>
      ) : <p className="text-sm text-muted-foreground">{empty}</p>}
    </div>
  );
}

function FilterSelect({ value, onChange, placeholder, options }: { value: string; onChange: (v: string) => void; placeholder: string; options: { value: string; label: string }[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-auto min-w-36 text-xs"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{placeholder}: todos</SelectItem>
        {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
