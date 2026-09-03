// Tareas — tabla densa y editable en la fila, siguiendo la sección de Ops (que es la que el
// equipo prefiere para organizar trabajo). Sustituye a las vistas de calendario Semana/Mes y a la
// lista anterior: una sola vista, agrupable, con edición sin abrir el modal.
//
// Por defecto muestra SOLO las tareas en las que participas — responsable, autor, revisor o
// merger del PR (el backend lo resuelve con `involved=me`, ver involvedWorkItemIds). El resto del
// trabajo del equipo sigue a un clic con el toggle "Todas".
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus, ChevronDown, Inbox, Trash2, Copy, X, Search, Loader2, Users, User, CircleDot, RefreshCw,
} from 'lucide-react';
import { Layout } from '@/components/Layout';
import { TaskDialog } from '@/components/TaskDialog';
import { EmptyState, ErrorCard } from '@/components/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  RowCheck, StatusIcon, StateCell, PriorityCell, ProjectCell, DateCell, AssigneesCell,
} from '@/components/tasks/inline-cells';
import { toast } from 'sonner';
import { useApi } from '@/lib/useApi';
import { useIsMobile } from '@/lib/useIsMobile';
import { apiGet, apiSend, type TicketsResponse, type TicketFilterOptions, type Ticket } from '@/lib/api';
import { isPastDay } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  PRIO_ORDER, PRIO_OPTIONS, STATE_OPTIONS, STATE_LABEL, OPEN_STATES, CLOSED_STATES,
} from '@/lib/labels';

const ALL = '__all__';
const EMPTY_FILTERS: TicketFilterOptions = { projects: [], allProjects: [], devs: [], states: [], allStates: [], priorities: [] };

type GroupMode = 'state' | 'project' | 'assignee' | 'module' | 'none';
const GROUP_MODES: GroupMode[] = ['state', 'project', 'assignee', 'module', 'none'];

// Orden dentro de cada sección. `plan` es el DEFAULT: respeta la secuencia en que se capturó el
// trabajo (`number` es correlativo por proyecto — HYPERHUB-1 = tarea 0.1 del plan), que es como se
// lee un plan de desarrollo paso a paso. `priority` es el criterio histórico — abiertas primero,
// luego prioridad — y sigue disponible en el desplegable.
type OrderMode = 'priority' | 'plan';
const ORDER_MODES: OrderMode[] = ['priority', 'plan'];

const SIN_MODULO = '__sin_modulo__';

const STATE_RANK: Record<string, number> = {
  planificada: 0, backlog: 0, pendiente: 1, unstarted: 1, triage: 1,
  en_progreso: 2, started: 2, in_progress: 2, revision: 3, review: 3,
  completada: 4, completed: 4, done: 4, cancelada: 5, canceled: 5,
};

interface Group { key: string; name: string; tasks: Ticket[] }

/** Abiertas primero, luego por prioridad. Igual criterio que la lista de Ops. */
function taskSort(a: Ticket, b: Ticket): number {
  const ao = OPEN_STATES.includes(a.status) ? 0 : 1;
  const bo = OPEN_STATES.includes(b.status) ? 0 : 1;
  if (ao !== bo) return ao - bo;
  return (PRIO_ORDER[a.priority ?? ''] ?? 4) - (PRIO_ORDER[b.priority ?? ''] ?? 4);
}

/**
 * Orden de captura: el `number` del identificador, ascendente. Es correlativo por proyecto, así
 * que primero agrupa por proyecto (si no, dos proyectos se intercalarían por un número que no
 * comparten). Las tareas sin número — el legado de Linear — van al final por identificador.
 */
function planSort(a: Ticket, b: Ticket): number {
  const p = (a.projectName ?? '').localeCompare(b.projectName ?? '');
  if (p !== 0) return p;
  if (a.number == null || b.number == null) {
    if (a.number != null) return -1;
    if (b.number != null) return 1;
    return a.identifier.localeCompare(b.identifier);
  }
  return a.number - b.number;
}

/**
 * Responsables con el principal al frente. El backend ya los devuelve así (`orderedAssignees` en
 * getTickets), pero se reafirma aquí porque el orden decide dos cosas: quién se pinta como
 * responsable y, al guardar, quién queda como primario (updateTask toma `[0]`).
 */
function assigneesOf(t: Ticket) {
  const list = t.assignees?.length ? t.assignees : t.assignee ? [t.assignee] : [];
  const primaryId = t.assignee?.id;
  if (!primaryId || list.length < 2) return list;
  const primary = list.filter((a) => a.id === primaryId);
  return primary.length ? [...primary, ...list.filter((a) => a.id !== primaryId)] : list;
}

/** Módulo de la tarea: la primera etiqueta. Es la convención con que se cargó el plan. */
function moduleOf(t: Ticket): string | null {
  return t.labels?.[0] ?? null;
}

/** Trabajo vivo de un grupo — ordena los proyectos por actividad, no alfabéticamente. */
function liveCount(tasks: Ticket[]): number {
  return tasks.filter((t) => !CLOSED_STATES.includes(t.status)).length;
}

/** Menor `number` del grupo: ordena las secciones por dónde arrancan en el plan. */
function firstInPlan(tasks: Ticket[]): number {
  const ns = tasks.map((t) => t.number).filter((n): n is number => n != null);
  return ns.length ? Math.min(...ns) : Number.MAX_SAFE_INTEGER;
}

function buildGroups(tasks: Ticket[], mode: GroupMode, order: OrderMode): Group[] {
  const sorted = [...tasks].sort(order === 'plan' ? planSort : taskSort);
  if (mode === 'none') return [{ key: 'all', name: '', tasks: sorted }];

  const map = new Map<string, Group>();
  const push = (key: string, name: string, t: Ticket) => {
    if (!map.has(key)) map.set(key, { key, name, tasks: [] });
    map.get(key)!.tasks.push(t);
  };
  // Con el orden del plan las secciones también van en secuencia; si no, por trabajo vivo.
  const bySequenceOrActivity = (a: Group, b: Group) =>
    order === 'plan'
      ? firstInPlan(a.tasks) - firstInPlan(b.tasks) || a.name.localeCompare(b.name)
      : liveCount(b.tasks) - liveCount(a.tasks) || a.name.localeCompare(b.name);
  // "Sin …" siempre al final, sea cual sea el criterio.
  const danglingLast = (key: string) => (a: Group, b: Group) =>
    a.key === key ? 1 : b.key === key ? -1 : bySequenceOrActivity(a, b);

  if (mode === 'state') {
    for (const t of sorted) push(t.status, STATE_LABEL[t.status] ?? t.status, t);
    return [...map.values()].sort((a, b) => (STATE_RANK[a.key] ?? 9) - (STATE_RANK[b.key] ?? 9) || a.name.localeCompare(b.name));
  }
  if (mode === 'assignee') {
    // Multi-responsable: la tarea va bajo su responsable PRINCIPAL, para no duplicar filas. El
    // apoyo no abre sección propia — se ve en la columna de responsables de la fila.
    for (const t of sorted) {
      const primary = assigneesOf(t)[0];
      if (primary) push(primary.id, primary.name, t);
      else push('__none__', 'Sin responsable', t);
    }
    return [...map.values()].sort((a, b) => (a.key === '__none__' ? 1 : b.key === '__none__' ? -1 : a.name.localeCompare(b.name)));
  }
  if (mode === 'module') {
    for (const t of sorted) {
      const m = moduleOf(t);
      if (m) push(m, m, t);
      else push(SIN_MODULO, 'Sin módulo', t);
    }
    return [...map.values()].sort(danglingLast(SIN_MODULO));
  }
  for (const t of sorted) push(t.projectId ?? '__none__', t.projectName ?? 'Sin proyecto', t);
  return [...map.values()].sort(danglingLast('__none__'));
}

export default function Tasks() {
  // Un solo listener de viewport para toda la tabla: si cada fila usara el hook, serían 300.
  const isMobile = useIsMobile();
  const [params, setParams] = useSearchParams();

  // Estado en la URL: se puede compartir un enlace a "mis tareas por proyecto".
  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v === null) p.delete(k); else p.set(k, v);
    setParams(p, { replace: true });
  };

  const mine = params.get('scope') !== 'team'; // mías por defecto
  const groupParam = params.get('group') as GroupMode | null;
  const group: GroupMode = groupParam && GROUP_MODES.includes(groupParam) ? groupParam : 'state';
  const orderParam = params.get('order') as OrderMode | null;
  const order: OrderMode = orderParam && ORDER_MODES.includes(orderParam) ? orderParam : 'plan';
  // Por defecto se ve TODO. Las secciones cerradas nacen colapsadas (ver defaultOpen), así que
  // el trabajo terminado está presente y contado sin estorbar. "Activas" es el filtro opcional.
  const onlyActive = params.get('active') === '1';

  const [fProject, setFProject] = useState(ALL);
  const [fPriority, setFPriority] = useState(ALL);
  const [q, setQ] = useState('');

  const filters = useApi<TicketFilterOptions>(() => apiGet('/tickets/filters'), []);
  const { data, loading, refetching, error, reload } = useApi<TicketsResponse>(
    () => apiGet(`/tickets?scope=all${mine ? '&involved=me' : ''}`),
    [mine],
  );

  // Copia local para pintar el cambio antes de que responda el servidor.
  const [tasks, setTasks] = useState<Ticket[]>([]);
  useEffect(() => { if (data) setTasks(data.tickets); }, [data]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTask, setDialogTask] = useState<Ticket | null>(null);

  // Memoizados: alimentan filas memoizadas, y un array nuevo en cada render anularía el memo.
  const devs = useMemo(() => filters.data?.devs ?? [], [filters.data]);
  const projects = useMemo(() => filters.data?.allProjects ?? [], [filters.data]);
  const projectOptions = useMemo(() => projects.map((p) => ({ value: p.id, label: p.name })), [projects]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tasks
      .filter((t) => !onlyActive || OPEN_STATES.includes(t.status))
      .filter((t) => fProject === ALL || t.projectId === fProject)
      .filter((t) => fPriority === ALL || t.priority === fPriority)
      .filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.identifier.toLowerCase().includes(needle));
  }, [tasks, onlyActive, fProject, fPriority, q]);

  const groups = useMemo(() => buildGroups(visible, group, order), [visible, group, order]);

  // Secciones cerradas arrancan colapsadas al agrupar por estado; el resto abiertas.
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({});
  const defaultOpen = (key: string) => (group === 'state' ? !CLOSED_STATES.includes(key) : true);
  const isOpen = (g: Group) => (group === 'none' ? true : openOverride[g.key] ?? defaultOpen(g.key));
  const toggleGroup = (g: Group) => setOpenOverride((o) => ({ ...o, [g.key]: !isOpen(g) }));

  const activeFilters = (fProject !== ALL ? 1 : 0) + (fPriority !== ALL ? 1 : 0) + (q ? 1 : 0);
  const clearFilters = () => { setFProject(ALL); setFPriority(ALL); setQ(''); };

  // Deep-link ?task=<id> — lo usa la notificación de "cambio documentado".
  //
  // Se abre UNA vez por id. El efecto también depende de `tasks`, y sin este candado cada cambio
  // en la lista (un patch en otra fila) volvía a llamar setDialogTask con el objeto nuevo: el
  // modal se reinicializaba encima de lo que estuvieras escribiendo y el texto se perdía.
  const taskParam = params.get('task');
  const openedParam = useRef<string | null>(null);
  useEffect(() => {
    if (!taskParam) { openedParam.current = null; return; }
    if (openedParam.current === taskParam) return;
    const t = tasks.find((x) => x.id === taskParam);
    if (!t) return;
    openedParam.current = taskParam;
    setDialogTask(t);
    setDialogOpen(true);
  }, [taskParam, tasks]);

  function onDialogOpenChange(open: boolean) {
    setDialogOpen(open);
    if (!open && params.get('task')) setParam('task', null);
  }

  /**
   * Patch optimista de UNA fila.
   *
   * Tres cosas, y las tres importan para que se sienta fluido:
   *
   *  · No recarga la lista. El PATCH devuelve la tarea COMPLETA y se sustituye solo esa fila.
   *    Antes cada cambio disparaba un GET /tickets — la consulta más cara de la app (hasta 1500
   *    tareas + atribución + esfuerzo + agregados) — y hasta que volvía, la fila que acababas de
   *    tocar podía pintarse con datos anteriores a tu propio cambio.
   *  · Encadena por tarea. Los cambios sobre la MISMA fila van en orden: el popover de
   *    responsables no se cierra al elegir, así que tres clics seguidos mandaban tres PATCH en
   *    paralelo y ganaba el que contestara al final — no el último que pediste.
   *  · Al fallar revierte SOLO los campos que este patch tocó, no la fila entera: restaurar `t`
   *    completo pisaría un cambio posterior encadenado sobre la misma tarea.
   */
  const chains = useRef(new Map<string, Promise<void>>());
  const patch = useCallback((t: Ticket, body: Record<string, unknown>, optimistic: Partial<Ticket>) => {
    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...optimistic } : x)));
    const run = (chains.current.get(t.id) ?? Promise.resolve()).then(async () => {
      try {
        const { task } = await apiSend<{ task: Ticket }>('PATCH', `/tickets/${t.id}`, body);
        setTasks((prev) => prev.map((x) => (x.id === task.id ? task : x)));
      } catch (e: any) {
        const rollback = Object.fromEntries(Object.keys(optimistic).map((k) => [k, (t as any)[k]]));
        setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...rollback } : x)));
        toast.error('No se pudo guardar', { description: String(e.message ?? e) });
      }
    });
    chains.current.set(t.id, run);
    return run;
  }, []);

  const setStatus = useCallback((t: Ticket, status: string) => patch(t, { status }, { status }), [patch]);
  const setPriority = useCallback((t: Ticket, priority: string | null) => patch(t, { priority }, { priority }), [patch]);
  // El optimista recalcula `overdue` con la misma regla que el backend: dar por hecho que no está
  // vencida haría que la fila cambiara de color sola al llegar la respuesta.
  const setDueDate = useCallback((t: Ticket, dueDate: string | null) =>
    patch(t, { dueDate }, { dueDate, overdue: !CLOSED_STATES.includes(t.status) && isPastDay(dueDate) }), [patch]);
  const setProject = useCallback((t: Ticket, projectId: string | null) =>
    patch(t, { projectId }, { projectId, projectName: projects.find((p) => p.id === projectId)?.name ?? null }), [patch, projects]);
  // El optimista fija TAMBIÉN el responsable primario (`assignee`), no solo la lista: el backend
  // toma `ids[0]` como primario, y `assigneesOf` reordena la fila usando `assignee`. Sin esto,
  // promover a un apoyo se veía como si no hubiera pasado nada — el orden viejo volvía a ganar
  // hasta que respondía el servidor.
  const setAssignees = useCallback((t: Ticket, ids: string[]) => {
    const people = ids.map((id) => {
      const d = devs.find((x) => x.id === id);
      return { id, name: d?.name ?? '—', avatarUrl: d?.avatarUrl ?? null };
    });
    return patch(t, { assigneeDevIds: ids }, { assignees: people, assignee: people[0] ?? null });
  }, [patch, devs]);

  /** El círculo de la izquierda alterna completada ⇄ pendiente, como en Ops. */
  const toggleDone = useCallback((t: Ticket) =>
    setStatus(t, t.status === 'completada' ? 'pendiente' : 'completada'), [setStatus]);

  const duplicate = useCallback(async (t: Ticket) => {
    if (!t.projectId) return toast.error('La tarea no tiene proyecto', { description: 'Duplicar necesita uno.' });
    try {
      // El POST devuelve la tarea completa: se inserta la fila y ya. Sin recargar la lista.
      const { task } = await apiSend<{ task: Ticket }>('POST', '/tickets', {
        projectId: t.projectId,
        name: `${t.name} (copia)`,
        description: t.description ?? undefined,
        status: 'pendiente',
        priority: t.priority ?? undefined,
        assigneeDevIds: assigneesOf(t).map((a) => a.id),
        dueDate: t.dueDate ?? undefined,
        labels: t.labels ?? [],
      });
      setTasks((prev) => [task, ...prev.filter((x) => x.id !== task.id)]);
      toast.success('Tarea duplicada', { description: `${task.identifier} · ${task.name}` });
    } catch (e: any) {
      toast.error('No se pudo duplicar', { description: String(e.message ?? e) });
    }
  }, []);

  const remove = useCallback(async (t: Ticket) => {
    setTasks((prev) => prev.filter((x) => x.id !== t.id));
    try {
      await apiSend('DELETE', `/tickets/${t.id}`);
      toast.success('Tarea eliminada', { description: `${t.identifier} · ${t.name}` });
    } catch (e: any) {
      setTasks((prev) => (prev.some((x) => x.id === t.id) ? prev : [...prev, t]));
      toast.error('No se pudo eliminar', { description: String(e.message ?? e) });
    }
  }, []);

  // ---- Acciones en lote ----
  const selectedTasks = () => visible.filter((t) => selected.has(t.id));

  /** Cada acción actualiza su propia fila; el lote no recarga la lista (ver `patch`). */
  async function batch(label: string, fn: (t: Ticket) => Promise<unknown>) {
    const items = selectedTasks();
    if (!items.length) return;
    setBusy(true);
    const results = await Promise.allSettled(items.map(fn));
    setBusy(false);
    setSelected(new Set());
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) toast.error(`${label}: fallaron ${failed} de ${items.length}`);
    else toast.success(`${label}: ${items.length} tarea${items.length === 1 ? '' : 's'}`);
  }

  const batchStatus = (status: string) =>
    batch(`Estado → ${STATE_LABEL[status] ?? status}`, async (t) => {
      const { task } = await apiSend<{ task: Ticket }>('PATCH', `/tickets/${t.id}`, { status });
      setTasks((prev) => prev.map((x) => (x.id === task.id ? task : x)));
    });
  const batchDelete = () =>
    batch('Eliminadas', async (t) => {
      await apiSend('DELETE', `/tickets/${t.id}`);
      setTasks((prev) => prev.filter((x) => x.id !== t.id));
    });

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const allVisibleSelected = visible.length > 0 && visible.every((t) => selected.has(t.id));
  const toggleSelectAll = () =>
    setSelected(allVisibleSelected ? new Set() : new Set(visible.map((t) => t.id)));

  function openCreate() { setDialogTask(null); setDialogOpen(true); }
  const openEdit = useCallback((t: Ticket) => { setDialogTask(t); setDialogOpen(true); }, []);

  const total = visible.length;
  const abiertas = visible.filter((t) => OPEN_STATES.includes(t.status)).length;
  const vencidas = visible.filter((t) => t.overdue).length;

  return (
    <Layout
      title="Tareas"
      subtitle={mine ? 'El trabajo en el que participas' : 'Todo el trabajo del equipo'}
      actions={
        <div className="flex items-center gap-2">
          {/* Mías / Todas — el filtro lo aplica el backend contra el dev de la sesión. */}
          <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
            <button
              type="button"
              onClick={() => setParam('scope', null)}
              className={cn(
                'flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium transition-colors',
                mine ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <User className="size-3.5" />
              Mías
            </button>
            <button
              type="button"
              onClick={() => setParam('scope', 'team')}
              className={cn(
                'flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium transition-colors',
                !mine ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Users className="size-3.5" />
              Todas
            </button>
          </div>
          <Button onClick={openCreate}><Plus /> Nueva tarea</Button>
        </div>
      }
    >
      {error && <ErrorCard message={error} className="mb-4" />}

      {/* Barra de control: agrupación, filtros y búsqueda */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={group} onValueChange={(v) => setParam('group', v)}>
          <SelectTrigger className="h-8 w-auto min-w-[9.5rem] gap-1 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="state">Agrupar: Estado</SelectItem>
            <SelectItem value="project">Agrupar: Proyecto</SelectItem>
            <SelectItem value="assignee">Agrupar: Responsable</SelectItem>
            <SelectItem value="module">Agrupar: Módulo</SelectItem>
            <SelectItem value="none">Sin agrupar</SelectItem>
          </SelectContent>
        </Select>

        <Select value={order} onValueChange={(v) => setParam('order', v === 'plan' ? null : v)}>
          <SelectTrigger className="h-8 w-auto min-w-[9rem] gap-1 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="plan">Orden: Plan</SelectItem>
            <SelectItem value="priority">Orden: Prioridad</SelectItem>
          </SelectContent>
        </Select>

        <Select value={fProject} onValueChange={setFProject}>
          <SelectTrigger className="h-8 w-auto min-w-[8rem] gap-1 text-xs"><SelectValue placeholder="Proyecto" /></SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={ALL}>Todos los proyectos</SelectItem>
            {projectOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={fPriority} onValueChange={setFPriority}>
          <SelectTrigger className="h-8 w-auto min-w-[7rem] gap-1 text-xs"><SelectValue placeholder="Prioridad" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Toda prioridad</SelectItem>
            {PRIO_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar…"
            className="h-8 w-40 pl-7 text-xs"
          />
        </div>

        <button
          type="button"
          onClick={() => setParam('active', onlyActive ? null : '1')}
          className={cn(
            'flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[13px] font-medium transition-colors',
            onlyActive ? 'border-primary/20 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent',
          )}
          title="Ocultar completadas y canceladas"
        >
          <CircleDot className="size-3.5" />
          Activas
        </button>

        {activeFilters > 0 && (
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground" onClick={clearFilters}>
            <X className="size-3.5" />
            {activeFilters}
          </Button>
        )}

        {/* Traer los cambios del equipo. Es MANUAL a propósito: tus ediciones ya se ven al
            instante (cada mutación devuelve su fila), así que la lista no tiene por qué recargarse
            sola y borrarte el scroll o lo que tengas a medio editar. */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-8 text-muted-foreground"
          onClick={reload}
          disabled={refetching}
          title="Traer cambios del equipo"
          aria-label="Actualizar"
        >
          <RefreshCw className={cn('size-3.5', refetching && 'animate-spin')} />
        </Button>

        {/* En móvil ocupa su propia línea (`basis-full`) en vez de pelear por el hueco que sobra. */}
        <div className="flex basis-full items-center gap-3 text-xs text-muted-foreground sm:ml-auto sm:basis-auto">
          <span><span className="font-medium text-foreground">{abiertas}</span> abiertas</span>
          {vencidas > 0 && <span className="font-medium text-destructive">{vencidas} vencidas</span>}
          <span>{total} en total</span>
          {/* El backend topa las filas que trae. Decirlo, en lugar de esconder el trabajo viejo. */}
          {data?.truncated && (
            <span className="text-amber-600 dark:text-amber-500" title="La consulta alcanzó su techo de filas: falta trabajo más viejo. Filtra por proyecto para verlo.">
              lista recortada
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
      ) : !total ? (
        <Card>
          <EmptyState
            icon={<Inbox className="size-6" />}
            action={<Button size="sm" onClick={openCreate}><Plus /> Nueva tarea</Button>}
          >
            {activeFilters > 0
              ? 'Ninguna tarea coincide con los filtros.'
              : onlyActive
                ? 'No hay tareas activas. Quita el filtro "Activas" para ver el trabajo cerrado.'
                : mine
                  ? 'No participas en ninguna tarea. Cambia a "Todas" para ver el trabajo del equipo.'
                  : 'Todavía no hay tareas.'}
          </EmptyState>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          {/* Encabezado: se queda arriba al scrollear. Las columnas de menos peso se ocultan
              en pantallas chicas en vez de comprimirse — apretadas no se leen. */}
          {/* Encabezado solo en escritorio: en móvil la fila no es tabular, así que unos títulos de
              columna no describirían nada. */}
          <div className="sticky top-0 z-20 hidden items-center gap-2.5 border-b bg-muted/50 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground backdrop-blur md:flex">
            <span className="w-4 shrink-0">
              <RowCheck checked={allVisibleSelected} onChange={toggleSelectAll} label="Seleccionar todo" />
            </span>
            <span className="w-[18px] shrink-0" />
            <span className="hidden w-16 shrink-0 sm:block">ID</span>
            <span className="min-w-0 flex-1">Tarea</span>
            <span className="w-32 shrink-0">Estado</span>
            <span className="hidden w-28 shrink-0 lg:block">Prioridad</span>
            <span className="hidden w-28 shrink-0 md:block">Límite</span>
            <span className="hidden w-36 shrink-0 xl:block">Proyecto</span>
            <span className="w-24 shrink-0">Resp.</span>
            <span className="w-7 shrink-0" />
          </div>

          <div className="max-h-[calc(100dvh-14rem)] overflow-y-auto">
            {groups.map((g) => {
              const openNow = isOpen(g);
              return (
                <div key={g.key}>
                  {g.name && (
                    <button
                      type="button"
                      onClick={() => toggleGroup(g)}
                      className="sticky top-0 z-10 flex w-full items-center gap-1.5 border-b bg-background/95 px-3.5 py-2 text-left backdrop-blur"
                    >
                      <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !openNow && '-rotate-90')} />
                      <span className="truncate text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{g.name}</span>
                      <span className="text-[13px] text-muted-foreground/60">{g.tasks.length}</span>
                    </button>
                  )}
                  {openNow && (
                    <div className="divide-y divide-border">
                      {/* Callbacks estables (useCallback) + fila memoizada: sin eso, editar una
                          celda repinta las 300 filas del grupo. */}
                      {g.tasks.map((t) => (
                        <TaskRow
                          key={t.id}
                          t={t}
                          devs={devs}
                          projectOptions={projectOptions}
                          selected={selected.has(t.id)}
                          isMobile={isMobile}
                          onSelect={toggleSelect}
                          onOpen={openEdit}
                          onToggleDone={toggleDone}
                          onStatus={setStatus}
                          onPriority={setPriority}
                          onDueDate={setDueDate}
                          onProject={setProject}
                          onAssignees={setAssignees}
                          onDuplicate={duplicate}
                          onDelete={remove}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Barra de acciones en lote: aparece al seleccionar, como en Ops. */}
      {selected.size > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
          {/* `max-w-full` + `flex-wrap`: en un móvil estrecho los controles bajan de línea en vez de
              salirse de la pastilla. */}
          <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-2xl border bg-popover px-3 py-2 shadow-lg sm:rounded-full">
            <span className="pl-1 text-xs font-medium">{selected.size} seleccionada{selected.size === 1 ? '' : 's'}</span>
            <span className="mx-1 hidden h-4 w-px bg-border sm:block" />
            <Select onValueChange={batchStatus}>
              <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent text-xs shadow-none hover:bg-accent">
                Cambiar estado
              </SelectTrigger>
              <SelectContent>
                {STATE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-destructive hover:text-destructive" onClick={batchDelete} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              Eliminar
            </Button>
            <Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setSelected(new Set())} aria-label="Limpiar selección">
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      <TaskDialog
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
        task={dialogTask}
        filters={filters.data ?? EMPTY_FILTERS}
        // El modal devuelve la tarea que guardó (el backend responde la fila completa), así que se
        // toca solo esa. Antes llamaba a `reload` y volvía a traer la lista entera.
        onSaved={(task, mode) => {
          setTasks((prev) =>
            mode === 'deleted' ? prev.filter((x) => x.id !== task.id)
              : mode === 'created' ? [task, ...prev.filter((x) => x.id !== task.id)]
                : prev.map((x) => (x.id === task.id ? task : x)),
          );
          if (mode !== 'deleted') setDialogTask(task);
        }}
      />
    </Layout>
  );
}

/** Una fila: densa, de una línea, con las celdas editables donde están. El nombre abre el modal;
 *  todo lo demás se cambia sin salir de la tabla.
 *
 *  Memoizada, y por eso los callbacks reciben el ticket en vez de cerrarse sobre él: así el padre
 *  puede mantenerlos estables entre renders y el memo sirve de algo. */
const TaskRow = memo(function TaskRow({
  t, devs, projectOptions, selected, isMobile, onSelect, onOpen, onToggleDone,
  onStatus, onPriority, onDueDate, onProject, onAssignees, onDuplicate, onDelete,
}: {
  t: Ticket;
  devs: { id: string; name: string; avatarUrl?: string | null }[];
  projectOptions: { value: string; label: string }[];
  selected: boolean;
  isMobile: boolean;
  onSelect: (id: string) => void;
  onOpen: (t: Ticket) => void;
  onToggleDone: (t: Ticket) => void;
  onStatus: (t: Ticket, v: string) => void;
  onPriority: (t: Ticket, v: string | null) => void;
  onDueDate: (t: Ticket, v: string | null) => void;
  onProject: (t: Ticket, v: string | null) => void;
  onAssignees: (t: Ticket, ids: string[]) => void;
  onDuplicate: (t: Ticket) => void;
  onDelete: (t: Ticket) => void;
}) {
  const closed = CLOSED_STATES.includes(t.status);

  const check = <RowCheck checked={selected} onChange={() => onSelect(t.id)} label={`Seleccionar ${t.identifier}`} />;
  const statusToggle = (
    <button
      type="button"
      onClick={() => onToggleDone(t)}
      className="w-[18px] shrink-0 rounded transition-transform hover:scale-110"
      aria-label={closed ? 'Reabrir' : 'Completar'}
      title={closed ? 'Reabrir' : 'Completar'}
    >
      <StatusIcon state={t.status} />
    </button>
  );
  const title = (
    <button
      type="button"
      onClick={() => onOpen(t)}
      className={cn(
        'min-w-0 flex-1 truncate py-1 text-left text-[15px] transition-colors hover:text-primary hover:underline',
        closed && 'text-muted-foreground line-through',
      )}
      title={t.name}
    >
      {t.name}
      {/* Dentro del botón, no como columna hermana: así no desplaza las columnas respecto al
          encabezado en pantallas anchas. */}
      {!!t.labels?.length && (
        <span className="ml-2 hidden gap-1 align-middle 2xl:inline-flex">
          {t.labels.slice(0, 2).map((l) => (
            <Badge key={l} variant="secondary" className="px-1.5 py-0 text-[11px] font-normal">{l}</Badge>
          ))}
        </span>
      )}
    </button>
  );
  const menu = <RowMenu t={t} onOpen={onOpen} onDuplicate={onDuplicate} onDelete={onDelete} />;

  // Se elige el layout en JS, no con `hidden`: con dos bloques los dos se montan en el DOM (solo
  // uno se ve), duplicando los nodos de cada fila — con 300 filas eso se nota.
  return (
    <div
      className={cn('group px-3.5 py-1.5 transition-colors', selected ? 'bg-primary/5' : 'hover:bg-muted/60')}
      // El navegador se salta layout y pintado de las filas fuera de pantalla. Es virtualización
      // sin librería ni cálculo de posiciones; `containIntrinsicSize` reserva la altura real de la
      // fila para que la barra de scroll no dé saltos.
      style={{ contentVisibility: 'auto', containIntrinsicSize: isMobile ? '0 66px' : '0 44px' }}
    >
      {isMobile ? (
        /* Dos líneas. Como fila tabular no cabía: las columnas fijas se comían ~320px de los ~330
           disponibles y el título quedaba sin ancho, encimándose con el estado. */
        <>
          <div className="flex items-center gap-2.5">
            <span className="w-4 shrink-0">{check}</span>
            {statusToggle}
            {title}
            <span className="w-7 shrink-0">{menu}</span>
          </div>
          {/* Segunda línea, alineada con el título. `compact` es lo que hace que quepan en UNA
              línea: sin él las celdas usan w-full y cada una se llevaba su propio renglón. */}
          <div className="-mt-0.5 ml-[42px] flex flex-wrap items-center gap-x-0.5">
            <StateCell compact value={t.status} options={STATE_OPTIONS} onSave={(v) => onStatus(t, v)} />
            <PriorityCell compact value={t.priority} options={PRIO_OPTIONS} onSave={(v) => onPriority(t, v)} />
            <DateCell compact value={t.dueDate} overdue={t.overdue} onSave={(v) => onDueDate(t, v)} />
            <span className="ml-auto"><AssigneesCell compact value={assigneesOf(t)} devs={devs} onSave={(ids) => onAssignees(t, ids)} /></span>
          </div>
        </>
      ) : (
        /* Fila tabular, alineada con el encabezado */
        <div className="flex items-center gap-2.5">
          <span className="w-4 shrink-0">{check}</span>
          {statusToggle}
          <span className="hidden w-16 shrink-0 truncate font-mono text-xs text-muted-foreground sm:block">{t.identifier}</span>
          {title}
          <span className="w-32 shrink-0"><StateCell value={t.status} options={STATE_OPTIONS} onSave={(v) => onStatus(t, v)} /></span>
          <span className="hidden w-28 shrink-0 lg:block"><PriorityCell value={t.priority} options={PRIO_OPTIONS} onSave={(v) => onPriority(t, v)} /></span>
          <span className="hidden w-28 shrink-0 md:block"><DateCell value={t.dueDate} overdue={t.overdue} onSave={(v) => onDueDate(t, v)} /></span>
          <span className="hidden w-36 shrink-0 xl:block"><ProjectCell value={t.projectId} options={projectOptions} onSave={(v) => onProject(t, v)} /></span>
          <span className="w-24 shrink-0"><AssigneesCell value={assigneesOf(t)} devs={devs} onSave={(ids) => onAssignees(t, ids)} /></span>
          <span className="w-7 shrink-0">{menu}</span>
        </div>
      )}
    </div>
  );
});

/** El menú también se monta al primer clic: un DropdownMenu de Radix por fila × 300 filas pesa
 *  tanto como las celdas, y casi nunca se abre. */
function RowMenu({ t, onOpen, onDuplicate, onDelete }: {
  t: Ticket;
  onOpen: (t: Ticket) => void;
  onDuplicate: (t: Ticket) => void;
  onDelete: (t: Ticket) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const trigger = (
    <button
      type="button"
      onClick={() => setMounted(true)}
      className="grid size-7 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
      aria-label="Acciones"
    >
      <ChevronDown className="size-4" />
    </button>
  );

  if (!mounted) return trigger;

  return (
    <DropdownMenu defaultOpen onOpenChange={(o) => { if (!o) setMounted(false); }}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onClick={() => onOpen(t)}>Abrir</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onDuplicate(t)}><Copy className="size-3.5" /> Duplicar</DropdownMenuItem>
        {t.pr && (
          <DropdownMenuItem onClick={() => window.open(t.pr!.url, '_blank')}>
            Ver PR #{t.pr.number}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onDelete(t)} className="text-destructive focus:text-destructive">
          <Trash2 className="size-3.5" /> Eliminar
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
