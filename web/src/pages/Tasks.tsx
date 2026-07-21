import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, ChevronLeft, ChevronRight, ChevronDown, Inbox } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { TaskDialog } from '@/components/TaskDialog';
import { AvatarStack, EmptyState } from '@/components/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { useApi } from '@/lib/useApi';
import { apiGet, apiSend, type TicketsResponse, type TicketFilterOptions, type Ticket } from '@/lib/api';
import {
  WEEKDAYS, addDays, addMonths, localDateStr, monthGrid, monthLabel, pad, sameDay, startOfMonth, startOfWeek, toIso, weekLabel,
} from '@/lib/calendar';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const ALL = '__all__';
const START_HOUR = 7;
const END_HOUR = 21;
const HOURS = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i); // 7…20
const SPAN = END_HOUR - START_HOUR; // horas visibles
const ROW_H = 48; // px por hora

const EMPTY_FILTERS: TicketFilterOptions = { projects: [], allProjects: [], devs: [], states: [], allStates: [], priorities: [] };

const PRIO: Record<string, { label: string; dot: string }> = {
  urgent: { label: 'Urgente', dot: 'bg-destructive' },
  high: { label: 'Alta', dot: 'bg-warning' },
  medium: { label: 'Media', dot: 'bg-chart-1' },
  low: { label: 'Baja', dot: 'bg-muted-foreground' },
};

// Estilo del bloque en el calendario: barra izquierda + tinte, por prioridad.
function prioBlock(priority: string | null): string {
  switch (priority) {
    case 'urgent': return 'border-l-destructive bg-destructive/10';
    case 'high': return 'border-l-warning bg-warning/10';
    case 'medium': return 'border-l-chart-1 bg-chart-1/10';
    case 'low': return 'border-l-muted-foreground bg-muted';
    default: return 'border-l-muted-foreground bg-card';
  }
}

function stateVariant(state: string): 'success' | 'default' | 'secondary' {
  if (['completed', 'done'].includes(state)) return 'success';
  if (['started', 'in_progress', 'review'].includes(state)) return 'default';
  return 'secondary';
}

/** Hora decimal (local) de un ISO. */
function hourOf(iso: string): number {
  const d = new Date(iso);
  return d.getHours() + d.getMinutes() / 60;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

type View = 'week' | 'month' | 'list';

// Orden de tareas en la vista Lista: abiertas primero, luego por prioridad.
const OPEN_STATES = ['backlog', 'unstarted', 'triage', 'started', 'in_progress', 'review'];
const PRIO_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
function taskSort(a: Ticket, b: Ticket): number {
  const ao = OPEN_STATES.includes(a.state) ? 0 : 1;
  const bo = OPEN_STATES.includes(b.state) ? 0 : 1;
  if (ao !== bo) return ao - bo;
  return (PRIO_ORDER[a.priority ?? ''] ?? 4) - (PRIO_ORDER[b.priority ?? ''] ?? 4);
}

const DONE_STATES = ['completed', 'done'];

type GroupMode = 'state' | 'project' | 'assignee' | 'none';
const GROUP_MODES: GroupMode[] = ['state', 'project', 'assignee', 'none'];

// Orden de las secciones cuando se agrupa por estado.
const STATE_RANK: Record<string, number> = {
  backlog: 0, unstarted: 1, triage: 1, started: 2, in_progress: 2, review: 3, completed: 4, done: 4, canceled: 5,
};

interface Group { key: string; name: string; tasks: Ticket[] }

/** Trabajo vivo (ni completado ni cancelado) de un grupo — para ordenar proyectos por actividad. */
function liveCount(tasks: Ticket[]): number {
  return tasks.filter((t) => !DONE_STATES.includes(t.state) && t.state !== 'canceled').length;
}

/** Agrupa las tareas según el modo. Multi-responsable: la tarea va bajo su PRIMER responsable
 *  (primary) para no duplicar filas. Dentro de cada grupo, filas por estado/prioridad (taskSort). */
function buildGroups(tasks: Ticket[], mode: GroupMode): Group[] {
  const sorted = [...tasks].sort(taskSort);
  if (mode === 'none') return [{ key: 'all', name: '', tasks: sorted }];

  const map = new Map<string, Group>();
  const push = (key: string, name: string, t: Ticket) => {
    if (!map.has(key)) map.set(key, { key, name, tasks: [] });
    map.get(key)!.tasks.push(t);
  };

  if (mode === 'state') {
    for (const t of sorted) push(t.state, t.stateName || t.state, t);
    return [...map.values()].sort((a, b) => (STATE_RANK[a.key] ?? 9) - (STATE_RANK[b.key] ?? 9) || a.name.localeCompare(b.name));
  }
  if (mode === 'assignee') {
    for (const t of sorted) {
      const primary = assigneesOf(t)[0];
      if (primary) push(primary.id, primary.name, t);
      else push('__none__', 'Sin responsable', t);
    }
    return [...map.values()].sort((a, b) => (a.key === '__none__' ? 1 : b.key === '__none__' ? -1 : a.name.localeCompare(b.name)));
  }
  // proyecto
  for (const t of sorted) push(t.projectId ?? '__none__', t.projectName ?? 'Sin proyecto', t);
  return [...map.values()].sort((a, b) =>
    a.key === '__none__' ? 1 : b.key === '__none__' ? -1 : liveCount(b.tasks) - liveCount(a.tasks) || a.name.localeCompare(b.name),
  );
}

/** Fecha a mostrar en la vista Lista: agenda si existe, si no la fecha límite. */
function listDate(t: Ticket): { label: string; overdue: boolean } | null {
  if (t.scheduledStart) return { label: shortDate(t.scheduledStart), overdue: false };
  if (t.dueDate) return { label: shortDate(t.dueDate), overdue: t.overdue };
  return null;
}

/** Responsables de una tarea: prefiere `assignees` (multi), cae a `assignee` (primary) por compat. */
function assigneesOf(t: Ticket) {
  return t.assignees?.length ? t.assignees : t.assignee ? [t.assignee] : [];
}

interface Placed { t: Ticket; start: number; end: number; col: number; cols: number }

/** Layout de columnas para bloques solapados (estilo Google Calendar): agrupa por clúster de
 *  solapamiento y asigna cada bloque a la primera columna libre; `cols` = máximo simultáneo del clúster. */
function layoutDay(dayTasks: Ticket[]): Placed[] {
  const items = dayTasks
    .map((t) => {
      const start = hourOf(t.scheduledStart!);
      const rawEnd = t.scheduledEnd ? hourOf(t.scheduledEnd) : start + 1;
      return { t, start, end: Math.max(rawEnd, start + 0.25) };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const placed: Placed[] = [];
  let cluster: typeof items = [];
  let clusterMaxEnd = -Infinity;

  const finalize = () => {
    const colEnds: number[] = []; // fin del último bloque en cada columna
    const colOf = new Map<(typeof cluster)[number], number>();
    for (const it of cluster) {
      let c = colEnds.findIndex((e) => e <= it.start + 1e-9);
      if (c === -1) { c = colEnds.length; colEnds.push(it.end); } else colEnds[c] = it.end;
      colOf.set(it, c);
    }
    const cols = colEnds.length;
    for (const it of cluster) placed.push({ t: it.t, start: it.start, end: it.end, col: colOf.get(it)!, cols });
    cluster = [];
    clusterMaxEnd = -Infinity;
  };

  for (const it of items) {
    if (cluster.length && it.start >= clusterMaxEnd - 1e-9) finalize();
    cluster.push(it);
    clusterMaxEnd = Math.max(clusterMaxEnd, it.end);
  }
  if (cluster.length) finalize();
  return placed;
}

export default function Tasks() {
  const [params, setParams] = useSearchParams();
  const viewParam = params.get('view');
  const view: View = viewParam === 'month' ? 'month' : viewParam === 'list' ? 'list' : 'week';
  const setView = (v: View) => {
    const p = new URLSearchParams(params);
    p.set('view', v);
    setParams(p, { replace: true });
  };

  const [anchor, setAnchor] = useState(() => new Date());

  // Filtros del backlog.
  const [fProject, setFProject] = useState(ALL);
  const [fAssignee, setFAssignee] = useState(ALL);
  const [fPriority, setFPriority] = useState(ALL);

  const filters = useApi<TicketFilterOptions>(() => apiGet('/tickets/filters'), []);
  const { data, loading, error, reload } = useApi<TicketsResponse>(() => apiGet('/tickets?scope=all'), []);

  // Copia local mutable para actualizar optimista al arrastrar.
  const [tasks, setTasks] = useState<Ticket[]>([]);
  useEffect(() => { if (data) setTasks(data.tickets); }, [data]);

  // Diálogo de alta/edición.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTask, setDialogTask] = useState<Ticket | null>(null);
  const [dialogDate, setDialogDate] = useState<string | undefined>(undefined);

  // Arrastre (HTML5 DnD nativo): guardamos la tarea en un ref para leerla en el drop.
  const dragTask = useRef<Ticket | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const scheduled = useMemo(() => tasks.filter((t) => t.scheduledStart), [tasks]);
  const backlog = useMemo(
    () => tasks
      .filter((t) => !t.scheduledStart && t.state !== 'canceled' && t.state !== 'completed')
      .filter((t) => fProject === ALL || t.projectId === fProject)
      .filter((t) => fAssignee === ALL || t.assignee?.id === fAssignee)
      .filter((t) => fPriority === ALL || t.priority === fPriority),
    [tasks, fProject, fAssignee, fPriority],
  );

  function openCreate(date?: string) {
    setDialogTask(null);
    setDialogDate(date);
    setDialogOpen(true);
  }
  function openEdit(t: Ticket) {
    setDialogTask(t);
    setDialogDate(undefined);
    setDialogOpen(true);
  }

  // Deep-link: ?task=<id> abre la tarea en edición (lo usa la notificación de "cambio documentado").
  // Funciona en cualquier vista; si el id no está en `tasks` (aún cargando o filtrado), no abre nada.
  const taskParam = params.get('task');
  useEffect(() => {
    if (!taskParam) return;
    const t = tasks.find((x) => x.id === taskParam);
    if (!t) return;
    setDialogTask(t);
    setDialogDate(undefined);
    setDialogOpen(true);
  }, [taskParam, tasks]);

  // Al cerrar el diálogo, limpia ?task de la URL (sin tocar ?view).
  function onDialogOpenChange(open: boolean) {
    setDialogOpen(open);
    if (!open && params.get('task')) {
      const p = new URLSearchParams(params);
      p.delete('task');
      setParams(p, { replace: true });
    }
  }

  // Agenda (o reagenda) una tarea: optimista → PATCH → refetch.
  async function schedule(task: Ticket, startIso: string, endIso: string) {
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, scheduledStart: startIso, scheduledEnd: endIso } : t)));
    try {
      await apiSend('PATCH', `/tickets/${task.id}`, { scheduledStart: startIso, scheduledEnd: endIso });
      toast.success('Tarea agendada', { description: `${task.identifier} · ${task.title}` });
    } catch (e: any) {
      toast.error('No se pudo agendar', { description: String(e.message ?? e) });
    } finally {
      reload();
    }
  }

  function onDragStart(t: Ticket) {
    dragTask.current = t;
    setDragId(t.id);
  }
  function onDragEnd() {
    dragTask.current = null;
    setDragId(null);
  }

  // Drop en una celda de la vista semana: día + hora exacta (bloque de 1h por defecto).
  function dropOnSlot(day: Date, hour: number) {
    const t = dragTask.current;
    if (!t) return;
    const date = localDateStr(day);
    schedule(t, toIso(date, `${pad(hour)}:00`), toIso(date, `${pad(hour + 1)}:00`));
  }
  // Drop en un día de la vista mes: hora por defecto 9:00–10:00.
  function dropOnDay(day: Date) {
    const t = dragTask.current;
    if (!t) return;
    const date = localDateStr(day);
    schedule(t, toIso(date, '09:00'), toIso(date, '10:00'));
  }

  const goToday = () => setAnchor(new Date());
  const goPrev = () => setAnchor((a) => (view === 'week' ? addDays(startOfWeek(a), -7) : addMonths(a, -1)));
  const goNext = () => setAnchor((a) => (view === 'week' ? addDays(startOfWeek(a), 7) : addMonths(a, 1)));

  const rangeLabel = view === 'week' ? weekLabel(startOfWeek(anchor)) : monthLabel(anchor);

  return (
    <Layout
      title="Tareas"
      subtitle="Planifica y agenda el trabajo del equipo"
      actions={
        <div className="flex items-center gap-2">
          <Tabs value={view} onValueChange={(v) => setView(v as View)}>
            <TabsList className="h-9">
              <TabsTrigger value="week">Semana</TabsTrigger>
              <TabsTrigger value="month">Mes</TabsTrigger>
              <TabsTrigger value="list">Lista</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button onClick={() => openCreate()}><Plus /> Nueva tarea</Button>
        </div>
      }
    >
      {error && <Card className="mb-4 p-4 text-sm text-destructive">{error}</Card>}

      {/* Navegación del período (no aplica en Lista) */}
      {view !== 'list' && (
        <div className="mb-3 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={goToday}>Hoy</Button>
          <div className="flex">
            <Button variant="outline" size="icon-sm" className="rounded-r-none" onClick={goPrev} aria-label="Anterior"><ChevronLeft /></Button>
            <Button variant="outline" size="icon-sm" className="-ml-px rounded-l-none" onClick={goNext} aria-label="Siguiente"><ChevronRight /></Button>
          </div>
          <span className="ml-1 text-sm font-medium capitalize">{rangeLabel}</span>
        </div>
      )}

      {view === 'list' ? (
        /* Vista Lista: full-width, agrupada por proyecto, sin backlog lateral. */
        loading ? (
          <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : (
          <ListView tasks={tasks} onOpen={openEdit} />
        )
      ) : (
        <div className="grid items-stretch gap-4 lg:grid-cols-[1fr_18rem]">
          {/* Calendario */}
          <div className="min-w-0">
            {loading ? (
              <Skeleton className="h-[560px] w-full" />
            ) : view === 'week' ? (
              <WeekView anchor={anchor} tasks={scheduled} dragId={dragId} onDragStart={onDragStart} onDragEnd={onDragEnd} onDropSlot={dropOnSlot} onOpen={openEdit} />
            ) : (
              <MonthView anchor={anchor} tasks={scheduled} onDropDay={dropOnDay} onOpen={openEdit} onCreate={openCreate} />
            )}
          </div>

          {/* Backlog: iguala la altura del calendario. En desktop la Card va absolute dentro del
              aside (que el grid estira a la altura de la fila = altura del calendario), así su
              contenido NO agranda la fila; la lista scrollea internamente. En móvil, flujo normal. */}
          <aside className="relative min-w-0">
            <Card className="flex w-full flex-col p-3 lg:absolute lg:inset-0">
              <div className="mb-2 flex items-center gap-2">
                <Inbox className="size-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Backlog</span>
                <Badge variant="secondary" className="ml-auto">{backlog.length}</Badge>
              </div>
              <div className="mb-3 space-y-2">
                <FilterSelect value={fProject} onChange={setFProject} placeholder="Proyecto" options={(filters.data?.allProjects ?? []).map((p) => ({ value: p.id, label: p.name }))} />
                <div className="grid grid-cols-2 gap-2">
                  <FilterSelect value={fAssignee} onChange={setFAssignee} placeholder="Responsable" options={(filters.data?.devs ?? []).map((d) => ({ value: d.id, label: d.name }))} />
                  <FilterSelect value={fPriority} onChange={setFPriority} placeholder="Prioridad" options={(filters.data?.priorities ?? []).map((p) => ({ value: p.value, label: p.label }))} />
                </div>
              </div>
              <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 max-lg:max-h-[50vh]">
                {loading && Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
                {!loading && backlog.length === 0 && <EmptyState icon={<Inbox className="size-5" />}>Backlog vacío</EmptyState>}
                {!loading && backlog.map((t) => (
                  <BacklogCard key={t.id} t={t} dragging={dragId === t.id} onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={() => openEdit(t)} />
                ))}
              </div>
              <p className="mt-2 shrink-0 text-[11px] text-muted-foreground">Arrastra una tarea al calendario para agendarla.</p>
            </Card>
          </aside>
        </div>
      )}

      <TaskDialog
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
        task={dialogTask}
        defaultDate={dialogDate}
        filters={filters.data ?? EMPTY_FILTERS}
        onSaved={reload}
      />
    </Layout>
  );
}

// ---- Vista lista (plana, densa, estilo Linear, con "agrupar por") ----
function ListView({ tasks, onOpen }: { tasks: Ticket[]; onOpen: (t: Ticket) => void }) {
  const [params, setParams] = useSearchParams();
  const groupParam = params.get('group') as GroupMode | null;
  const group: GroupMode = groupParam && GROUP_MODES.includes(groupParam) ? groupParam : 'state';
  const setGroup = (g: GroupMode) => {
    const p = new URLSearchParams(params);
    p.set('group', g);
    setParams(p, { replace: true });
  };

  const [showDone, setShowDone] = useState(false); // completadas/canceladas ocultas por defecto
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}); // por defecto TODO expandido

  // La lista es para el trabajo VIVO: oculta completadas/canceladas por defecto (evita el ruido del
  // histórico ya cerrado, p.ej. lo auto-documentado desde PRs). Toggle para mostrarlas.
  const visible = useMemo(
    () => (showDone ? tasks : tasks.filter((t) => !DONE_STATES.includes(t.state) && t.state !== 'canceled')),
    [tasks, showDone],
  );
  const groups = useMemo(() => buildGroups(visible, group), [visible, group]);

  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));
  const anyOpen = groups.some((g) => !collapsed[g.key]);
  const setAll = () => setCollapsed(anyOpen ? Object.fromEntries(groups.map((g) => [g.key, true])) : {});

  const header = (
    <div className="mb-2 flex items-center gap-2">
      <Select value={group} onValueChange={(v) => setGroup(v as GroupMode)}>
        <SelectTrigger className="h-8 w-auto min-w-[9.5rem] gap-1 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="state">Agrupar: Estado</SelectItem>
          <SelectItem value="project">Agrupar: Proyecto</SelectItem>
          <SelectItem value="assignee">Agrupar: Responsable</SelectItem>
          <SelectItem value="none">Sin agrupar</SelectItem>
        </SelectContent>
      </Select>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={() => setShowDone((v) => !v)}>
          {showDone ? 'Ocultar completadas' : 'Mostrar completadas'}
        </Button>
        {group !== 'none' && (
          <Button variant="ghost" size="sm" onClick={setAll} disabled={!groups.length}>
            {anyOpen ? 'Colapsar todo' : 'Expandir todo'}
          </Button>
        )}
      </div>
    </div>
  );

  const empty = !groups.some((g) => g.tasks.length);
  if (empty) {
    return (
      <div>
        {header}
        <Card><EmptyState icon={<Inbox className="size-6" />}>{showDone ? 'No hay tareas' : 'No hay tareas activas'}</EmptyState></Card>
      </div>
    );
  }

  return (
    <div>
      {header}
      {/* Lista plana: contenedor scrolleable propio con encabezados de sección sticky dentro. */}
      <div className="scroll-thin max-h-[calc(100dvh-11rem)] overflow-y-auto rounded-lg border">
        {groups.map((g) => {
          const isOpen = group === 'none' || !collapsed[g.key];
          return (
            <div key={g.key}>
              {g.name && (
                <button
                  type="button"
                  onClick={() => toggle(g.key)}
                  className="sticky top-0 z-10 flex w-full items-center gap-1.5 border-b bg-background/95 px-3 py-1.5 text-left backdrop-blur"
                >
                  <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', !isOpen && '-rotate-90')} />
                  <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.name}</span>
                  <span className="text-xs text-muted-foreground/60">{g.tasks.length}</span>
                </button>
              )}
              {isOpen && (
                <div className="divide-y divide-border">
                  {g.tasks.map((t) => <ListRow key={t.id} t={t} onOpen={onOpen} hideState={group === 'state'} />)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Fila densa de una sola línea. En móvil oculta estado + fecha (deja dot · ID · título · avatares). */
function ListRow({ t, onOpen, hideState }: { t: Ticket; onOpen: (t: Ticket) => void; hideState: boolean }) {
  const prio = t.priority ? PRIO[t.priority] : null;
  const date = listDate(t);
  return (
    <button
      type="button"
      onClick={() => onOpen(t)}
      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent/50"
    >
      <span className={cn('size-2 shrink-0 rounded-full', prio?.dot ?? 'bg-muted')} title={prio?.label ?? 'sin prioridad'} />
      <span className="w-14 shrink-0 truncate font-mono text-xs text-muted-foreground">{t.identifier}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
      {!hideState && <Badge variant={stateVariant(t.state)} className="hidden shrink-0 sm:inline-flex">{t.stateName}</Badge>}
      <AvatarStack people={assigneesOf(t)} max={3} size="size-5" className="shrink-0" />
      <span className={cn('hidden w-12 shrink-0 text-right text-xs sm:block', date?.overdue ? 'font-medium text-destructive' : 'text-muted-foreground')}>
        {date?.label ?? '—'}
      </span>
    </button>
  );
}

// ---- Vista semana ----
function WeekView({
  anchor, tasks, dragId, onDragStart, onDragEnd, onDropSlot, onOpen,
}: {
  anchor: Date;
  tasks: Ticket[];
  dragId: string | null;
  onDragStart: (t: Ticket) => void;
  onDragEnd: () => void;
  onDropSlot: (day: Date, hour: number) => void;
  onOpen: (t: Ticket) => void;
}) {
  const monday = startOfWeek(anchor);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const today = new Date();
  const nowFrac = today.getHours() + today.getMinutes() / 60;
  const showNow = nowFrac >= START_HOUR && nowFrac <= END_HOUR;

  return (
    <Card className="overflow-hidden">
      <div className="scroll-thin overflow-x-auto">
        <div className="min-w-[760px]">
          {/* Cabecera de días */}
          <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b bg-card">
            <div />
            {days.map((d, i) => {
              const isToday = sameDay(d, today);
              return (
                <div key={i} className={cn('border-l py-2 text-center', isToday && 'bg-primary/5')}>
                  <div className="text-[11px] uppercase text-muted-foreground">{WEEKDAYS[i]}</div>
                  <div className={cn('mx-auto mt-0.5 grid size-7 place-items-center rounded-full text-sm font-semibold', isToday && 'bg-primary text-primary-foreground')}>
                    {d.getDate()}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Cuerpo: gutter de horas + 7 columnas */}
          <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]">
            {/* Gutter */}
            <div className="relative">
              {HOURS.map((h) => (
                <div key={h} style={{ height: ROW_H }} className="relative">
                  <span className="absolute -top-2 right-1.5 text-[11px] text-muted-foreground">{pad(h)}:00</span>
                </div>
              ))}
            </div>

            {/* Columnas por día */}
            {days.map((day, di) => {
              const isToday = sameDay(day, today);
              const dayTasks = tasks.filter((t) => t.scheduledStart && sameDay(new Date(t.scheduledStart), day));
              return (
                <div key={di} className={cn('relative border-l', isToday && 'bg-primary/5')} style={{ height: SPAN * ROW_H }}>
                  {/* Celdas de drop (una por hora) */}
                  {HOURS.map((h) => (
                    <div
                      key={h}
                      style={{ height: ROW_H }}
                      className="border-b border-border/60 transition-colors hover:bg-accent/40"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => onDropSlot(day, h)}
                    />
                  ))}

                  {/* Línea de "ahora" */}
                  {isToday && showNow && (
                    <div className="pointer-events-none absolute inset-x-0 z-20" style={{ top: (nowFrac - START_HOUR) * ROW_H }}>
                      <div className="h-px bg-destructive" />
                      <div className="absolute -left-1 -top-1 size-2 rounded-full bg-destructive" />
                    </div>
                  )}

                  {/* Bloques (con layout de columnas para solapamientos) */}
                  {layoutDay(dayTasks).map(({ t, start, end, col, cols }) => {
                    const top = clamp(start - START_HOUR, 0, SPAN) * ROW_H;
                    const height = Math.max(22, (clamp(end, START_HOUR, END_HOUR) - clamp(start, START_HOUR, END_HOUR)) * ROW_H - 2);
                    const leftPct = (col / cols) * 100;
                    const widthPct = 100 / cols;
                    const people = assigneesOf(t);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        draggable
                        onDragStart={() => onDragStart(t)}
                        onDragEnd={onDragEnd}
                        onClick={() => onOpen(t)}
                        style={{ top, height, left: `calc(${leftPct}% + 1px)`, width: `calc(${widthPct}% - 2px)` }}
                        className={cn(
                          'absolute z-10 flex flex-col gap-0.5 overflow-hidden rounded-md border border-l-[3px] p-1 text-left shadow-sm transition hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring',
                          prioBlock(t.priority),
                          dragId === t.id && 'opacity-40',
                        )}
                        title={`${t.identifier} · ${t.title}`}
                      >
                        {/* El título tiende a ser largo → en el calendario solo ID + avatares (el título vive en el modal). */}
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-sm font-semibold">{t.identifier}</span>
                          <AvatarStack people={people} max={3} size="size-5" className="ml-auto shrink-0" />
                        </div>
                        {height > 56 && <Badge variant={stateVariant(t.state)} className="mt-auto w-fit px-1 py-0 text-[9px]">{t.stateName}</Badge>}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---- Vista mes ----
function MonthView({
  anchor, tasks, onDropDay, onOpen, onCreate,
}: {
  anchor: Date;
  tasks: Ticket[];
  onDropDay: (day: Date) => void;
  onOpen: (t: Ticket) => void;
  onCreate: (date: string) => void;
}) {
  const cells = useMemo(() => monthGrid(anchor), [anchor]);
  const today = new Date();
  const monthStart = startOfMonth(anchor);

  return (
    <Card className="overflow-hidden">
      {/* Cabecera de días de la semana */}
      <div className="grid grid-cols-7 border-b bg-card">
        {WEEKDAYS.map((d) => (
          <div key={d} className="py-2 text-center text-[11px] font-medium uppercase text-muted-foreground">{d}</div>
        ))}
      </div>
      {/* Cuadrícula 6×7 */}
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          const inMonth = day.getMonth() === monthStart.getMonth();
          const isToday = sameDay(day, today);
          const dayTasks = tasks
            .filter((t) => t.scheduledStart && sameDay(new Date(t.scheduledStart), day))
            .sort((a, b) => new Date(a.scheduledStart!).getTime() - new Date(b.scheduledStart!).getTime());
          const shown = dayTasks.slice(0, 3);
          const extra = dayTasks.length - shown.length;
          return (
            <div
              key={i}
              className={cn(
                'group min-h-[104px] cursor-pointer border-b border-l p-1.5 transition-colors first:border-l-0 [&:nth-child(7n+1)]:border-l-0 hover:bg-accent/30',
                !inMonth && 'bg-muted/30 text-muted-foreground',
              )}
              onClick={() => onCreate(localDateStr(day))}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDropDay(day)}
            >
              <div className="mb-1 flex items-center justify-between">
                <span className={cn('grid size-6 place-items-center rounded-full text-xs font-medium', isToday && 'bg-primary text-primary-foreground')}>
                  {day.getDate()}
                </span>
              </div>
              <div className="space-y-1">
                {shown.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onOpen(t); }}
                    className={cn('flex w-full items-center gap-1 rounded border-l-2 px-1 py-0.5 text-left text-[11px] transition hover:brightness-95', prioBlock(t.priority))}
                    title={`${t.identifier} · ${t.title}`}
                  >
                    {/* Solo ID + stack de avatares: el título completo está en el modal. */}
                    <span className="truncate font-mono font-medium">{t.identifier}</span>
                    <AvatarStack people={assigneesOf(t)} max={3} size="size-4" className="ml-auto shrink-0" />
                  </button>
                ))}
                {extra > 0 && <div className="px-1 text-[11px] text-muted-foreground">+{extra} más</div>}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---- Tarjeta del backlog (arrastrable) ----
function BacklogCard({
  t, dragging, onDragStart, onDragEnd, onClick,
}: {
  t: Ticket;
  dragging: boolean;
  onDragStart: (t: Ticket) => void;
  onDragEnd: () => void;
  onClick: () => void;
}) {
  const prio = t.priority ? PRIO[t.priority] : null;
  return (
    <div
      draggable
      onDragStart={() => onDragStart(t)}
      onDragEnd={onDragEnd}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
      className={cn(
        'cursor-grab rounded-lg border bg-card p-2 shadow-sm transition hover:shadow-md active:cursor-grabbing',
        dragging && 'opacity-40',
      )}
    >
      <div className="flex items-start gap-2">
        <span className={cn('mt-1 size-2 shrink-0 rounded-full', prio?.dot ?? 'bg-muted')} title={prio?.label ?? 'sin prioridad'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground">{t.identifier}</span>
            <AvatarStack people={assigneesOf(t)} max={3} size="size-4" className="ml-auto shrink-0" />
          </div>
          <div className="mt-0.5 line-clamp-2 break-words text-xs font-medium leading-snug">{t.title}</div>
          {t.projectName && <div className="mt-1 truncate text-[11px] text-muted-foreground">{t.projectName}</div>}
        </div>
      </div>
    </div>
  );
}

function FilterSelect({ value, onChange, placeholder, options }: { value: string; onChange: (v: string) => void; placeholder: string; options: { value: string; label: string }[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{placeholder}: todos</SelectItem>
        {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
