// Tareas — lista densa al estilo Linear: filas de una línea agrupadas (por estado por defecto), con
// el ícono de prioridad y el de estado como controles (clic → menú con búsqueda), chips de etiqueta
// y proyecto, fecha y responsables a la derecha. Todo se edita sin abrir el modal.
//
// Teclado (con el ratón sobre una fila): S estado · P prioridad · A responsables · X seleccionar.
// C crea una tarea. Clic derecho abre el menú contextual de la fila.
//
// Por defecto muestra SOLO las tareas en las que participas — responsable, autor, revisor o
// merger del PR (el backend lo resuelve con `involved=me`, ver involvedWorkItemIds). El resto del
// trabajo del equipo sigue a un clic con el toggle "Todas".
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Plus, ChevronRight, Inbox, Trash2, Copy, X, Search, Loader2, Users, User, RefreshCw,
  List, Columns3, Bot, AlertTriangle, XCircle, Lock, ExternalLink, Ellipsis, SlidersHorizontal,
  Check, Link2, GitPullRequest, FolderClosed, UserRound, SignalHigh, CheckCheck,
} from 'lucide-react';
import { useRozV2 } from '@/components/pulse/roz-v2';
import { Layout } from '@/components/Layout';
import { TaskDialog } from '@/components/TaskDialog';
import { EmptyState, ErrorCard, UserAvatar } from '@/components/bits';
import { IntegrationIcon, ProjectIcon } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  RowCheck, StatusIcon, DateCell, AssigneesCell, MenuCell, assigneesOf, CHIP_CELL, NO_PRIORITY,
  statusMenuOptions, priorityMenuOptions,
} from '@/components/tasks/inline-cells';
import { Kbd, LabelDot, PriorityIcon, PropertyMenu, type PropOption } from '@/components/tasks/properties';
import { TaskBoard } from '@/components/tasks/board';
import { OverrideReasonDialog } from '@/components/tasks/OverrideReasonDialog';
import { needsOverride } from '@/lib/assign';
import { toast } from '@/lib/toast';
import { useApi } from '@/lib/useApi';
import { useIsMobile } from '@/lib/useIsMobile';
import { apiGet, apiSend, type TicketsResponse, type TicketFilterOptions, type Ticket } from '@/lib/api';
import { isPastDay } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  PRIO_ORDER, PRIO_OPTIONS, STATE_OPTIONS, STATE_LABEL, OPEN_STATES, CLOSED_STATES, canonState,
} from '@/lib/labels';

const ALL = '__all__';
const NO_DEV = '__none__'; // filtro "Sin responsable" — el hueco que el resumen ya contaba pero no dejaba ver
const EMPTY_FILTERS: TicketFilterOptions = { projects: [], allProjects: [], devs: [], states: [], allStates: [], priorities: [] };

type GroupMode = 'state' | 'project' | 'assignee' | 'module' | 'none';
const GROUP_MODES: GroupMode[] = ['state', 'project', 'assignee', 'module', 'none'];

// Orden dentro de cada sección. `plan` es el DEFAULT: respeta la secuencia en que se capturó el
// trabajo (`number` es correlativo por proyecto — HYPERHUB-1 = tarea 0.1 del plan), que es como se
// lee un plan de desarrollo paso a paso. `priority` es el criterio histórico — abiertas primero,
// luego prioridad — y sigue disponible en el desplegable.
type OrderMode = 'priority' | 'plan';
const ORDER_MODES: OrderMode[] = ['priority', 'plan'];

// Lista (tabla densa, agrupable) o Tablero (kanban por estado). Vive en la URL como todo lo demás
// de esta pantalla, así que se puede compartir el enlace a "el tablero del equipo".
type ViewMode = 'list' | 'board';

// Pestañas de arriba, las de Linear: todo · lo que está en marcha · lo que aún no se toma.
type Tab = 'all' | 'active' | 'backlog';
const ACTIVE_TAB = ['pendiente', 'en_progreso', 'revision'];
const BACKLOG_TAB = ['planificada'];
const inTab = (t: Ticket, tab: Tab) =>
  tab === 'all' || (tab === 'backlog' ? BACKLOG_TAB : ACTIVE_TAB).includes(canonState(t.status));

type RowMenuKind = 'status' | 'priority' | 'assignee';
const ROW_KEYS: Record<string, RowMenuKind> = { s: 'status', p: 'priority', a: 'assignee' };

const STATUS_MENU = statusMenuOptions(STATE_OPTIONS);
const PRIO_MENU = priorityMenuOptions(PRIO_OPTIONS);

const GROUP_LABEL: Record<GroupMode, string> = {
  state: 'Estado', project: 'Proyecto', assignee: 'Responsable', module: 'Módulo', none: 'Sin agrupar',
};
const ORDER_LABEL: Record<OrderMode, string> = { plan: 'Plan (captura)', priority: 'Prioridad' };

const SIN_MODULO = '__sin_modulo__';

const STATE_RANK: Record<string, number> = {
  planificada: 0, backlog: 0, pendiente: 1, unstarted: 1, triage: 1,
  en_progreso: 2, started: 2, in_progress: 2, revision: 3, review: 3,
  completada: 4, completed: 4, done: 4, cancelada: 5, canceled: 5,
};

interface Group { key: string; name: string; tasks: Ticket[] }

/** Aviso de solo lectura (roz v2): la edición se hace en Linear. */
function warnReadOnly(t: Ticket): void {
  toast('Las tareas se editan en Linear', {
    description: `${t.identifier} es un reflejo de Linear: cámbialo allá y roz lo verá en segundos.`,
    action: t.url ? { label: 'Abrir', onClick: () => window.open(t.url!, '_blank', 'noopener,noreferrer') } : undefined,
  });
}

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

  // roz v2: con Linear como fuente de verdad las tareas son un ESPEJO de solo lectura. Toda edición
  // se hace en Linear (o con /ticket); aquí se deja de ofrecer crear/editar y una fila abre su issue.
  // En ref además de en estado: los callbacks memoizados de la tabla lo leen sin re-crearse.
  const v2 = useRozV2();
  const readOnly = v2.linearSourceOfTruth;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

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
  const view: ViewMode = params.get('view') === 'board' ? 'board' : 'list';
  const board = view === 'board';
  // Por defecto se ve TODO. Las secciones cerradas nacen colapsadas (ver defaultOpen), así que
  // el trabajo terminado está presente y contado sin estorbar. `?active=1` es el enlace viejo.
  const tabParam = params.get('tab');
  const tab: Tab = tabParam === 'active' || tabParam === 'backlog' ? tabParam : params.get('active') === '1' ? 'active' : 'all';
  const setTab = (v: Tab) => {
    const p = new URLSearchParams(params);
    p.delete('active');
    if (v === 'all') p.delete('tab'); else p.set('tab', v);
    setParams(p, { replace: true });
  };

  const [fProject, setFProject] = useState(ALL);
  const [fPriority, setFPriority] = useState(ALL);
  const [fDev, setFDev] = useState(ALL);
  const [q, setQ] = useState('');

  // Mismas claves que Reportes: las opciones de filtro se piden una vez por sesión y la lista de
  // tareas sobrevive a salir y volver a la sección (antes: skeleton y refetch cada vez).
  const filters = useApi<TicketFilterOptions>(() => apiGet('/tickets/filters'), [], {
    key: '/tickets/filters',
    ttl: 600_000,
  });
  const { data, loading, refetching, error, reload } = useApi<TicketsResponse>(
    () => apiGet(`/tickets?scope=all${mine ? '&involved=me' : ''}`),
    [mine],
    { key: '/tickets', ttl: 30_000 },
  );

  // Copia local para pintar el cambio antes de que responda el servidor.
  const [tasks, setTasks] = useState<Ticket[]>([]);
  useEffect(() => { if (data) setTasks(data.tickets); }, [data]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTask, setDialogTask] = useState<Ticket | null>(null);
  const [createState, setCreateState] = useState<string | undefined>(undefined);
  // Valores con los que nace una tarea creada desde la cabecera de un grupo (proyecto, responsable).
  const [createPrefill, setCreatePrefill] = useState<{ projectId?: string; assigneeDevIds?: string[] } | undefined>(undefined);
  // Menú de fila abierto por teclado (S / P / A sobre la fila bajo el ratón) y menú contextual.
  const [rowMenu, setRowMenu] = useState<{ id: string; kind: RowMenuKind } | null>(null);
  const [ctx, setCtx] = useState<{ id: string; x: number; y: number } | null>(null);
  const hoverId = useRef<string | null>(null);
  const onHover = useCallback((id: string | null) => { hoverId.current = id; }, []);
  const closeRowMenu = useCallback(() => setRowMenu(null), []);

  // Memoizados: alimentan filas memoizadas, y un array nuevo en cada render anularía el memo.
  const devs = useMemo(() => filters.data?.devs ?? [], [filters.data]);
  const projects = useMemo(() => filters.data?.allProjects ?? [], [filters.data]);
  const projectMenu: PropOption[] = useMemo(
    () => projects.map((p) => ({ value: p.id, label: p.name, icon: <ProjectIcon id={p.id} size="xs" className="size-4" /> })),
    [projects],
  );

  // Opciones del filtro por responsable: los devs ACTIVOS (los que puedes asignar) mas cualquiera
  // que ya aparezca como responsable en la lista. `filters.devs` solo trae activos, asi que dar de
  // baja a alguien con tareas dejaria su trabajo imposible de filtrar — visible en la tabla pero
  // fuera del desplegable.
  const devOptions = useMemo(() => {
    const map = new Map<string, { id: string; name: string; avatarUrl: string | null }>();
    for (const d of devs) map.set(d.id, { id: d.id, name: d.name, avatarUrl: d.avatarUrl ?? null });
    for (const t of tasks) for (const a of assigneesOf(t)) if (!map.has(a.id)) map.set(a.id, a);
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [devs, tasks]);

  // Todo menos la pestaña: de aquí salen los contadores de las tres pestañas.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tasks
      .filter((t) => fProject === ALL || t.projectId === fProject)
      .filter((t) => fPriority === ALL || t.priority === fPriority)
      // Por responsable: cuenta el principal Y el apoyo, igual que la columna "Resp.". Filtrar
      // solo por el principal escondería el trabajo en el que alguien participa sin encabezarlo,
      // que es justo lo que quieres ver al repartir carga.
      .filter((t) => {
        if (fDev === ALL) return true;
        const people = assigneesOf(t);
        return fDev === NO_DEV ? people.length === 0 : people.some((a) => a.id === fDev);
      })
      .filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.identifier.toLowerCase().includes(needle));
  }, [tasks, fProject, fPriority, fDev, q]);
  const visible = useMemo(() => (tab === 'all' ? filtered : filtered.filter((t) => inTab(t, tab))), [filtered, tab]);
  const tabCount = useMemo(() => ({
    all: filtered.length,
    active: filtered.filter((t) => inTab(t, 'active')).length,
    backlog: filtered.filter((t) => inTab(t, 'backlog')).length,
  }), [filtered]);

  const groups = useMemo(() => buildGroups(visible, group, order), [visible, group, order]);
  // El tablero agrupa por estado en sus columnas, pero el ORDEN de arriba sigue mandando dentro de
  // cada una — por eso recibe la lista ya ordenada con el mismo criterio que la tabla.
  const sorted = useMemo(
    () => [...visible].sort(order === 'plan' ? planSort : taskSort),
    [visible, order],
  );

  // Secciones cerradas arrancan colapsadas al agrupar por estado; el resto abiertas.
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({});
  const defaultOpen = (key: string) => (group === 'state' ? !CLOSED_STATES.includes(key) : true);
  const isOpen = (g: Group) => (group === 'none' ? true : openOverride[g.key] ?? defaultOpen(g.key));
  const toggleGroup = (g: Group) => setOpenOverride((o) => ({ ...o, [g.key]: !isOpen(g) }));

  const activeFilters = (fProject !== ALL ? 1 : 0) + (fPriority !== ALL ? 1 : 0) + (fDev !== ALL ? 1 : 0) + (q ? 1 : 0);
  const clearFilters = () => { setFProject(ALL); setFPriority(ALL); setFDev(ALL); setQ(''); };

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
    if (readOnlyRef.current) {
      warnReadOnly(t);
      return Promise.resolve();
    }
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
  const applyAssignees = useCallback((t: Ticket, ids: string[], extra: Record<string, unknown> = {}) => {
    const people = ids.map((id) => {
      const d = devs.find((x) => x.id === id);
      return { id, name: d?.name ?? '—', avatarUrl: d?.avatarUrl ?? null };
    });
    return patch(t, { assigneeDevIds: ids, ...extra }, { assignees: people, assignee: people[0] ?? null });
  }, [patch, devs]);
  // Cambiar al responsable que eligió roz pide motivo (una sola vez): queda pendiente hasta elegirlo.
  const [overrideAsk, setOverrideAsk] = useState<{ task: Ticket; ids: string[] } | null>(null);
  const setAssignees = useCallback((t: Ticket, ids: string[]) => {
    if (needsOverride(t, ids)) {
      setOverrideAsk({ task: t, ids });
      return Promise.resolve();
    }
    return applyAssignees(t, ids);
  }, [applyAssignees]);

  // Filas que roz sigue asignando en segundo plano: se consultan hasta que terminen (~45 s).
  const pendingIds = useMemo(
    () => tasks.filter((t) => t.autoAssign?.state === 'pending').map((t) => t.id).sort().join(','),
    [tasks],
  );
  useEffect(() => {
    if (!pendingIds) return;
    let alive = true;
    let tries = 0;
    const tick = async () => {
      if (!alive || tries++ >= 15) return;
      for (const id of pendingIds.split(',')) {
        try {
          const { task } = await apiGet<{ task: Ticket }>(`/tickets/${id}`);
          if (alive && task.autoAssign?.state !== 'pending') {
            setTasks((prev) => prev.map((x) => (x.id === task.id ? task : x)));
            setDialogTask((cur) => (cur?.id === task.id ? task : cur));
          }
        } catch {
          /* siguiente intento */
        }
      }
      if (alive) timer = setTimeout(tick, 3000);
    };
    let timer = setTimeout(tick, 3000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pendingIds]);

  /** El círculo de la izquierda alterna completada ⇄ pendiente, como en Ops. */
  const toggleDone = useCallback((t: Ticket) =>
    setStatus(t, t.status === 'completada' ? 'pendiente' : 'completada'), [setStatus]);

  const duplicate = useCallback(async (t: Ticket) => {
    if (readOnlyRef.current) return warnReadOnly(t);
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
        // Una copia conserva a sus responsables; si el original no tenía, la copia tampoco.
        autoAssign: false,
      });
      setTasks((prev) => [task, ...prev.filter((x) => x.id !== task.id)]);
      toast.success('Tarea duplicada', { description: `${task.identifier} · ${task.name}` });
    } catch (e: any) {
      toast.error('No se pudo duplicar', { description: String(e.message ?? e) });
    }
  }, []);

  const remove = useCallback(async (t: Ticket) => {
    if (readOnlyRef.current) return warnReadOnly(t);
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

  function openCreate() { setDialogTask(null); setCreateState(undefined); setCreatePrefill(undefined); setDialogOpen(true); }

  // Etiquetas que ya existen: el menú de etiquetas del modal las sugiere.
  const knownLabels = useMemo(() => [...new Set(tasks.flatMap((t) => t.labels ?? []))], [tasks]);

  // Teclado de la lista, como en Linear, con el foco fuera de un campo y sin modal ni menú abierto:
  // C crea; sobre la fila bajo el ratón, S / P / A abren estado / prioridad / responsables y X la
  // selecciona.
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || dialogOpen) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return;
      const k = e.key.toLowerCase();
      if (k === 'c') {
        e.preventDefault();
        setDialogTask(null);
        setCreateState(undefined);
        setCreatePrefill(undefined);
        setDialogOpen(true);
        return;
      }
      const id = hoverId.current;
      if (!id || board) return;
      if (ROW_KEYS[k]) {
        e.preventDefault();
        setRowMenu({ id, kind: ROW_KEYS[k] });
      } else if (k === 'x') {
        e.preventDefault();
        toggleSelect(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly, dialogOpen, board, toggleSelect]);
  // En solo lectura la fila abre su issue en Linear (ahí se edita); sin URL, el modal sirve para leer.
  const openEdit = useCallback((t: Ticket) => {
    if (readOnlyRef.current && t.url) {
      window.open(t.url, '_blank', 'noopener,noreferrer');
      return;
    }
    setDialogTask(t);
    setDialogOpen(true);
  }, []);
  /** "Añade una tarjeta" desde una columna: la tarea nace ya en el estado de esa columna. */
  const openCreateIn = useCallback((status: string) => {
    if (readOnlyRef.current) return;
    setDialogTask(null);
    setCreateState(status);
    setCreatePrefill(undefined);
    setDialogOpen(true);
  }, []);
  /** El "+" de la cabecera de un grupo: la tarea nace con lo que define a ese grupo. */
  function openCreateInGroup(g: Group) {
    if (readOnly) return;
    if (group === 'state') return openCreateIn(canonState(g.key));
    setDialogTask(null);
    setCreateState(undefined);
    setCreatePrefill(
      group === 'project' && g.key !== '__none__' ? { projectId: g.key }
        : group === 'assignee' && g.key !== '__none__' ? { assigneeDevIds: [g.key] }
          : undefined,
    );
    setDialogOpen(true);
  }

  const onContext = useCallback((e: React.MouseEvent, t: Ticket) => {
    if (readOnlyRef.current) return;
    e.preventDefault();
    setCtx({ id: t.id, x: e.clientX, y: e.clientY });
  }, []);
  // La tarea del menú contextual se lee de la lista viva (su estado puede haber cambiado) y se
  // conserva durante la animación de cierre.
  const ctxKeep = useRef<Ticket | null>(null);
  const ctxTask = (ctx ? tasks.find((x) => x.id === ctx.id) : null) ?? ctxKeep.current;
  if (ctx && ctxTask) ctxKeep.current = ctxTask;

  const copyText = useCallback(async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copiado`);
    } catch {
      toast.error('No se pudo copiar');
    }
  }, []);

  // Anterior / siguiente del detalle: el orden que estás viendo (grupos de la lista o tablero).
  const navList = useMemo(() => (board ? sorted : groups.flatMap((g) => g.tasks)), [board, sorted, groups]);
  const navIdx = dialogTask ? navList.findIndex((x) => x.id === dialogTask.id) : -1;

  /**
   * "Mover las N a …" del menú de una columna.
   *
   * Mueve SOLO lo que esa columna está enseñando (`visible`, ya filtrado), no todo lo que hay en
   * ese estado en la base: con un filtro puesto, arrastrar trabajo que no puedes ver sería una
   * sorpresa desagradable, y el contador del encabezado cuenta justo estas.
   */
  const moveAll = useCallback(async (from: string, to: string) => {
    const items = visible.filter((t) => canonState(t.status) === from);
    if (!items.length) return;
    setBusy(true);
    const results = await Promise.allSettled(items.map(async (t) => {
      const { task } = await apiSend<{ task: Ticket }>('PATCH', `/tickets/${t.id}`, { status: to });
      setTasks((prev) => prev.map((x) => (x.id === task.id ? task : x)));
    }));
    setBusy(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) toast.error(`Mover a ${STATE_LABEL[to] ?? to}: fallaron ${failed} de ${items.length}`);
    else toast.success(`${items.length} tarea${items.length === 1 ? '' : 's'} → ${STATE_LABEL[to] ?? to}`);
  }, [visible]);

  const total = visible.length;
  const abiertas = visible.filter((t) => OPEN_STATES.includes(t.status)).length;
  const vencidas = visible.filter((t) => t.overdue).length;

  return (
    <Layout
      title="Tareas"
      actions={
        <div className="flex items-center gap-2">
          {/* Lista / Tablero. La lista es la tabla densa agrupable; el tablero es el kanban por
              estado, donde arrastrar una tarjeta ES cambiarle el estado. */}
          <div className="flex items-center gap-0.5 rounded-md bg-panel p-[3px]">
            <button
              type="button"
              onClick={() => setParam('view', null)}
              className={cn(
                'flex h-7 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-[12.5px] transition-colors',
                !board ? 'bg-card font-semibold text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.08)]' : 'font-medium text-muted-foreground hover:text-foreground',
              )}
            >
              <List className="size-3.5" />
              Lista
            </button>
            <button
              type="button"
              onClick={() => setParam('view', 'board')}
              className={cn(
                'flex h-7 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-[12.5px] transition-colors',
                board ? 'bg-card font-semibold text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.08)]' : 'font-medium text-muted-foreground hover:text-foreground',
              )}
            >
              <Columns3 className="size-3.5" />
              Tablero
            </button>
          </div>

          {/* Mías / Todas — el filtro lo aplica el backend contra el dev de la sesión. */}
          <div className="flex items-center gap-0.5 rounded-md bg-panel p-[3px]">
            <button
              type="button"
              onClick={() => setParam('scope', null)}
              className={cn(
                'flex h-7 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-[12.5px] transition-colors',
                mine ? 'bg-card font-semibold text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.08)]' : 'font-medium text-muted-foreground hover:text-foreground',
              )}
            >
              <User className="size-3.5" />
              Mías
            </button>
            <button
              type="button"
              onClick={() => setParam('scope', 'team')}
              className={cn(
                'flex h-7 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-[12.5px] transition-colors',
                !mine ? 'bg-card font-semibold text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.08)]' : 'font-medium text-muted-foreground hover:text-foreground',
              )}
            >
              <Users className="size-3.5" />
              Equipo
            </button>
          </div>
          {readOnly ? (
            <Button variant="secondary" asChild>
              <a href="https://linear.app" target="_blank" rel="noreferrer noopener"><IntegrationIcon name="linear" size="xs" title="" /> Linear</a>
            </Button>
          ) : (
            <Button onClick={openCreate} title="Nueva tarea · tecla C"><Plus /> Nueva tarea</Button>
          )}
        </div>
      }
    >
      {error && <ErrorCard message={error} className="mb-4" />}

      {readOnly && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3.5 py-3 text-sm">
          <IntegrationIcon name="linear" framed />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex items-center gap-1.5 label-caps text-faint">
              <Lock className="size-3" /> Solo lectura · espejo de Linear
            </span>
            <span className="text-[13px] text-muted-foreground">
              <span className="font-medium text-foreground">Las tareas viven en Linear.</span>{' '}
              roz refleja lo que hay allá (webhook + reconciliación cada 30 min). Créalas o edítalas en Linear, o con{' '}
              <Link to="/app/ticket" className="font-mono text-[12px] font-medium text-orange-ink hover:underline">/ticket</Link>; una fila abre su issue.
            </span>
          </div>
          <Button variant="dark" size="sm" asChild>
            <a href="https://linear.app" target="_blank" rel="noreferrer noopener">Abrir Linear <ExternalLink /></a>
          </Button>
        </div>
      )}

      {/* Barra de control, como la de Linear: pestañas a la izquierda, filtros como píldoras, y a
          la derecha los contadores y las opciones de vista. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-2">
        <div className="flex items-center gap-1">
          {([['all', 'Todas'], ['active', 'Activas'], ['backlog', 'Backlog']] as [Tab, string][]).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setTab(v)}
              title={v === 'active' ? 'Por hacer, en curso y en revisión' : v === 'backlog' ? 'Planificadas: aún sin tomar' : 'Todas, incluidas las cerradas'}
              className={cn(
                'flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[12.5px] font-medium transition-colors',
                tab === v ? 'border-border bg-card text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.06)]' : 'border-transparent text-muted-foreground hover:bg-panel hover:text-foreground',
              )}
            >
              {label}
              <span className={cn('text-[11px] tabular-nums', tab === v ? 'text-muted-foreground' : 'text-faint')}>{tabCount[v]}</span>
            </button>
          ))}
        </div>

        <span className="mx-0.5 hidden h-4 w-px bg-border sm:block" />

        <FilterMenu
          title="Proyecto"
          icon={<FolderClosed />}
          value={fProject}
          onChange={setFProject}
          options={[{ value: ALL, label: 'Todos los proyectos', icon: <FolderClosed className="text-faint" /> }, ...projectMenu.map((o, i) => ({ ...o, divider: i === 0 }))]}
        />
        {/* Responsable. Tiene sentido sobre todo en "Equipo" — es como ves la carga de otra
            persona — pero tambien sirve en "Mías" para acotar a lo que compartes con alguien. */}
        <FilterMenu
          title="Responsable"
          icon={<UserRound />}
          value={fDev}
          onChange={setFDev}
          options={[
            { value: ALL, label: 'Todo el equipo', icon: <Users className="text-faint" /> },
            { value: NO_DEV, label: 'Sin responsable', icon: <UserRound className="text-faint" /> },
            ...devOptions.map((d, i) => ({
              value: d.id, label: d.name, divider: i === 0,
              icon: <UserAvatar url={d.avatarUrl} id={d.id} name={d.name} className="size-4" />,
            })),
          ]}
        />
        <FilterMenu
          title="Prioridad"
          icon={<SignalHigh />}
          value={fPriority}
          onChange={setFPriority}
          options={[
            { value: ALL, label: 'Toda prioridad', icon: <PriorityIcon value={null} /> },
            ...PRIO_OPTIONS.map((o, i) => ({ value: o.value, label: o.label, divider: i === 0, icon: <PriorityIcon value={o.value} /> })),
          ]}
        />

        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar…"
            className="h-7 w-36 pl-7 text-xs"
          />
        </div>

        {activeFilters > 0 && (
          <button
            type="button"
            onClick={clearFilters}
            className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
            title="Quitar filtros"
          >
            <X className="size-3.5" />
            Limpiar
          </button>
        )}

        {/* En móvil ocupa su propia línea (`basis-full`) en vez de pelear por el hueco que sobra. */}
        <div className="flex basis-full items-center gap-2 sm:ml-auto sm:basis-auto">
          <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
            <span><span className="font-semibold tabular-nums text-foreground">{abiertas}</span> abiertas</span>
            {vencidas > 0 && <Badge variant="bad" dot className="text-[11px]">{vencidas} vencidas</Badge>}
            <span className="tabular-nums text-faint">{total} en total</span>
            {/* El backend topa las filas que trae. Decirlo, en lugar de esconder el trabajo viejo. */}
            {data?.truncated && (
              <span className="font-medium text-warning" title="La consulta alcanzó su techo de filas: falta trabajo más viejo. Filtra por proyecto para verlo.">
                lista recortada
              </span>
            )}
          </div>

          {/* Traer los cambios del equipo. Es MANUAL a propósito: tus ediciones ya se ven al
              instante (cada mutación devuelve su fila), así que la lista no tiene por qué recargarse
              sola y borrarte el scroll o lo que tengas a medio editar. */}
          <button
            type="button"
            onClick={reload}
            disabled={refetching}
            title="Traer cambios del equipo"
            aria-label="Actualizar"
            className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-panel hover:text-foreground disabled:opacity-50 sm:ml-0"
          >
            <RefreshCw className={cn('size-3.5', refetching && 'animate-spin')} />
          </button>

          {/* Opciones de vista (el "Display" de Linear): agrupación y orden en un solo popover. */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex h-7 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-panel data-[state=open]:bg-panel"
              >
                <SlidersHorizontal className="size-3.5 text-muted-foreground" />
                Vista
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 p-1.5">
              {/* En el tablero no se ofrece agrupar: sus columnas ya SON la agrupación (por estado). */}
              {!board && (
                <>
                  <p className="px-2 pb-1 pt-1.5 label-caps">Agrupar por</p>
                  {GROUP_MODES.map((g) => (
                    <DisplayOption key={g} on={group === g} onClick={() => setParam('group', g === 'state' ? null : g)}>{GROUP_LABEL[g]}</DisplayOption>
                  ))}
                  <div className="mx-1 my-1.5 h-px bg-border" />
                </>
              )}
              <p className="px-2 pb-1 pt-1.5 label-caps">Ordenar por</p>
              {ORDER_MODES.slice().reverse().map((o) => (
                <DisplayOption key={o} on={order === o} onClick={() => setParam('order', o === 'plan' ? null : o)}>{ORDER_LABEL[o]}</DisplayOption>
              ))}
              {!readOnly && (
                <>
                  <div className="mx-1 my-1.5 h-px bg-border" />
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-[11.5px] text-muted-foreground">
                    <span className="flex items-center gap-1"><Kbd>C</Kbd> crear</span>
                    <span className="flex items-center gap-1"><Kbd>S</Kbd> estado</span>
                    <span className="flex items-center gap-1"><Kbd>P</Kbd> prioridad</span>
                    <span className="flex items-center gap-1"><Kbd>A</Kbd> asignar</span>
                    <span className="flex items-center gap-1"><Kbd>X</Kbd> elegir</span>
                  </p>
                </>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {loading ? (
        board ? (
          <div className="flex gap-3 overflow-hidden">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="grid w-[286px] shrink-0 content-start gap-1.5 rounded-lg bg-panel p-2">
                <Skeleton className="h-4 w-24 bg-card" />
                {Array.from({ length: 3 - (i % 2) }).map((__, j) => <Skeleton key={j} className="h-[72px] bg-card" />)}
              </div>
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-card">
            <div className="border-b bg-sidebar px-3.5 py-2.5"><Skeleton className="h-3 w-48" /></div>
            <div className="divide-y">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-3.5 py-2.5">
                  <Skeleton className="size-4 rounded-full" />
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="h-3.5 flex-1" />
                  <Skeleton className="h-5 w-20 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        )
      ) : !total ? (
        <Card className="bg-panel">
          <EmptyState
            icon={<Inbox className="size-6" />}
            action={readOnly ? undefined : <Button size="sm" onClick={openCreate}><Plus /> Nueva tarea</Button>}
          >
            {activeFilters > 0
              ? 'Ninguna tarea coincide con los filtros.'
              : tab !== 'all'
                ? (tab === 'active' ? 'No hay tareas activas. Cambia a "Todas" para ver el resto.' : 'El backlog está vacío.')
                : mine
                  ? 'No participas en ninguna tarea. Cambia a "Equipo" para ver el trabajo de todos.'
                  : 'Todavía no hay tareas.'}
          </EmptyState>
        </Card>
      ) : board ? (
        <TaskBoard
          tasks={sorted}
          onOpen={openEdit}
          onToggleDone={toggleDone}
          onStatus={setStatus}
          onDuplicate={duplicate}
          onDelete={remove}
          onCreate={openCreateIn}
          onMoveAll={moveAll}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="scroll-thin max-h-[calc(100dvh-12.5rem)] overflow-y-auto">
            {groups.map((g) => {
              const openNow = isOpen(g);
              const lead = group === 'assignee' && g.key !== '__none__' ? assigneesOf(g.tasks[0])[0] : null;
              return (
                <div key={g.key}>
                  {g.name && (
                    // Cabecera de grupo de Linear: ícono · nombre · conteo, y a la derecha el "+"
                    // que crea una tarea ya dentro de ese grupo.
                    <div className="group/head sticky top-0 z-10 flex h-9 items-center gap-1 border-b bg-sidebar/95 pl-2.5 pr-2 backdrop-blur">
                      <button
                        type="button"
                        onClick={() => toggleGroup(g)}
                        aria-expanded={openNow}
                        className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left"
                      >
                        <ChevronRight className={cn('size-3.5 shrink-0 text-faint transition-transform', openNow && 'rotate-90')} />
                        {group === 'state' && <StatusIcon state={g.key} className="size-4" />}
                        {group === 'project' && g.key !== '__none__' && <ProjectIcon id={g.key} name={g.name} size="sm" className="size-4" />}
                        {group === 'module' && g.key !== SIN_MODULO && <LabelDot label={g.key} />}
                        {lead && <UserAvatar url={lead.avatarUrl} id={lead.id} name={lead.name} className="size-[18px]" />}
                        <span className="truncate text-[13px] font-semibold text-foreground">{g.name}</span>
                        <span className="text-[12px] tabular-nums text-faint">{g.tasks.length}</span>
                      </button>
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() => openCreateInGroup(g)}
                          className="grid size-6 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-panel hover:text-foreground"
                          aria-label={`Nueva tarea en ${g.name}`}
                          title={`Nueva tarea en ${g.name}`}
                        >
                          <Plus className="size-4" />
                        </button>
                      )}
                    </div>
                  )}
                  {openNow && (
                    <div className="divide-y divide-border/70">
                      {/* Callbacks estables (useCallback) + fila memoizada: sin eso, editar una
                          celda repinta las 300 filas del grupo. */}
                      {g.tasks.map((t) => (
                        <TaskRow
                          key={t.id}
                          t={t}
                          devs={devs}
                          projectMenu={projectMenu}
                          showProject={group !== 'project'}
                          selected={selected.has(t.id)}
                          isMobile={isMobile}
                          forceMenu={rowMenu?.id === t.id ? rowMenu.kind : null}
                          onForceClose={closeRowMenu}
                          onHover={onHover}
                          onContext={onContext}
                          onSelect={toggleSelect}
                          onOpen={openEdit}
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

      {/* Menú contextual de la fila (clic derecho). Uno solo para toda la lista, anclado al punto
          del clic con un disparador invisible. */}
      <DropdownMenu open={ctx !== null} onOpenChange={(o) => { if (!o) setCtx(null); }}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: ctx?.x ?? 0, top: ctx?.y ?? 0 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={2} className="scroll-thin max-h-[min(34rem,80dvh)] w-56 overflow-y-auto">
          {ctxTask && (
            <>
              <DropdownMenuLabel className="truncate font-mono text-[11px] font-normal text-faint">{ctxTask.identifier}</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => openEdit(ctxTask)}>Abrir</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Estado</DropdownMenuLabel>
              {STATE_OPTIONS.map((o) => (
                <DropdownMenuItem key={o.value} onClick={() => setStatus(ctxTask, o.value)}>
                  <StatusIcon state={o.value} className="size-3.5" />
                  <span className="flex-1">{o.label}</span>
                  {canonState(ctxTask.status) === o.value && <Check className="size-3.5 text-orange" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Prioridad</DropdownMenuLabel>
              {[{ value: NO_PRIORITY, label: 'Sin prioridad' }, ...PRIO_OPTIONS].map((o) => {
                const v = o.value === NO_PRIORITY ? null : o.value;
                return (
                  <DropdownMenuItem key={o.value} onClick={() => setPriority(ctxTask, v)}>
                    <PriorityIcon value={v} className="size-3.5" />
                    <span className="flex-1">{o.label}</span>
                    {(ctxTask.priority ?? null) === v && <Check className="size-3.5 text-orange" />}
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => copyText(ctxTask.identifier, 'ID')}><Copy className="size-3.5" /> Copiar ID</DropdownMenuItem>
              <DropdownMenuItem onClick={() => copyText(`${window.location.origin}/app/tasks?scope=team&task=${ctxTask.id}`, 'Enlace')}>
                <Link2 className="size-3.5" /> Copiar enlace
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => duplicate(ctxTask)}><Copy className="size-3.5" /> Duplicar</DropdownMenuItem>
              {ctxTask.pr && (
                <DropdownMenuItem onClick={() => window.open(ctxTask.pr!.url, '_blank', 'noopener,noreferrer')}>
                  <GitPullRequest className="size-3.5" /> Ver PR #{ctxTask.pr.number}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => remove(ctxTask)} className="text-destructive focus:text-destructive">
                <Trash2 className="size-3.5" /> Eliminar
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Barra de acciones en lote: aparece al seleccionar, como en Ops. Solo en la lista — el
          tablero no tiene casillas, ahí el lote se hace desde el menú de la columna. */}
      {!board && !readOnly && selected.size > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
          {/* `max-w-full` + `flex-wrap`: en un móvil estrecho los controles bajan de línea en vez de
              salirse de la pastilla. */}
          <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-xl bg-ink px-3 py-2 text-ink-foreground shadow-lg">
            <span className="pl-1 label-caps">{selected.size} seleccionada{selected.size === 1 ? '' : 's'}</span>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-ink-foreground hover:bg-ink-foreground/10 hover:text-ink-foreground" onClick={toggleSelectAll} disabled={busy}>
              <CheckCheck className="size-3.5" />
              {allVisibleSelected ? 'Ninguna' : `Las ${visible.length}`}
            </Button>
            <span className="mx-1 hidden h-4 w-px bg-ink-foreground/20 sm:block" />
            {/* `disabled` también aquí: sin esto se podía lanzar un segundo lote encima del que ya
                estaba corriendo. */}
            <Select onValueChange={batchStatus} disabled={busy}>
              <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent text-xs text-ink-foreground shadow-none hover:bg-ink-foreground/10">
                Cambiar estado
              </SelectTrigger>
              <SelectContent>
                {STATE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-red hover:bg-ink-foreground/10 hover:text-red" onClick={batchDelete} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              Eliminar
            </Button>
            <Button variant="ghost" size="icon-sm" className="size-7 hover:bg-ink-foreground/10 hover:text-ink-foreground" onClick={() => setSelected(new Set())} aria-label="Limpiar selección">
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      <TaskDialog
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
        task={dialogTask}
        defaultState={createState}
        prefill={createPrefill}
        onPrev={navIdx > 0 ? () => setDialogTask(navList[navIdx - 1]) : undefined}
        onNext={navIdx >= 0 && navIdx < navList.length - 1 ? () => setDialogTask(navList[navIdx + 1]) : undefined}
        position={navIdx >= 0 ? `${navIdx + 1} / ${navList.length}` : undefined}
        filters={filters.data ?? EMPTY_FILTERS}
        // El modal devuelve la tarea que guardó (el backend responde la fila completa), así que se
        // toca solo esa. Antes llamaba a `reload` y volvía a traer la lista entera.
        onSaved={(task, mode) => {
          setTasks((prev) =>
            mode === 'deleted' ? prev.filter((x) => x.id !== task.id)
              : mode === 'created' ? [task, ...prev.filter((x) => x.id !== task.id)]
                : prev.map((x) => (x.id === task.id ? task : x)),
          );
          // Solo en edición: con "Crear más" el modal sigue en alta, no salta al detalle de la nueva.
          if (mode === 'updated') setDialogTask((cur) => (cur?.id === task.id ? task : cur));
        }}
        knownLabels={knownLabels}
      />
      <OverrideReasonDialog
        open={overrideAsk !== null}
        categories={filters.data?.overrideCategories ?? []}
        chosenName={
          overrideAsk?.task.autoAssign?.chosenDevId
            ? devs.find((d) => d.id === overrideAsk.task.autoAssign!.chosenDevId)?.name ?? null
            : null
        }
        onConfirm={(category, note) => {
          const ask = overrideAsk;
          setOverrideAsk(null);
          if (ask) void applyAssignees(ask.task, ask.ids, { override: { category, note } });
        }}
        onCancel={() => setOverrideAsk(null)}
      />
    </Layout>
  );
}

/** Opción con palomita del popover "Vista". */
function DisplayOption({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors hover:bg-panel',
        on ? 'font-medium text-foreground' : 'text-muted-foreground',
      )}
    >
      <span className="flex-1 truncate">{children}</span>
      {on && <Check className="size-3.5 text-orange" />}
    </button>
  );
}

/**
 * Filtro como píldora: punteada cuando no filtra, naranja con el valor elegido cuando sí. El menú
 * es el mismo `PropertyMenu` de las propiedades (búsqueda + teclado).
 */
function FilterMenu({ title, icon, value, onChange, options }: {
  title: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  options: PropOption[];
}) {
  const on = value !== ALL;
  const current = on ? options.find((o) => o.value === value) : null;
  return (
    <PropertyMenu
      title={`Filtrar por ${title.toLowerCase()}`}
      triggerLabel={title}
      options={options}
      value={value}
      onSelect={onChange}
      triggerClassName={cn(
        'inline-flex h-7 max-w-[12rem] items-center gap-1.5 rounded-md border px-2 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0',
        on ? 'border-orange/30 bg-orange-soft text-orange-ink' : 'border-dashed text-muted-foreground hover:bg-panel hover:text-foreground data-[state=open]:bg-panel',
      )}
    >
      {current?.icon ?? icon}
      <span className="truncate">{current?.label ?? title}</span>
    </PropertyMenu>
  );
}

/** Una fila de Linear: prioridad · ID · estado · título · etiquetas · proyecto · fecha · responsables.
 *  El título abre el detalle; los íconos de prioridad y estado son los controles (clic → menú con
 *  búsqueda), y el resto se cambia donde está, sin salir de la lista.
 *
 *  Memoizada, y por eso los callbacks reciben el ticket en vez de cerrarse sobre él: así el padre
 *  puede mantenerlos estables entre renders y el memo sirve de algo. */
const TaskRow = memo(function TaskRow({
  t, devs, projectMenu, showProject, selected, isMobile, forceMenu, onForceClose, onHover, onContext,
  onSelect, onOpen, onStatus, onPriority, onDueDate, onProject, onAssignees, onDuplicate, onDelete,
}: {
  t: Ticket;
  devs: { id: string; name: string; avatarUrl?: string | null }[];
  projectMenu: PropOption[];
  showProject: boolean;
  selected: boolean;
  isMobile: boolean;
  /** Menú abierto por teclado (S / P / A con el ratón sobre la fila). */
  forceMenu: RowMenuKind | null;
  onForceClose: () => void;
  onHover: (id: string | null) => void;
  onContext: (e: React.MouseEvent, t: Ticket) => void;
  onSelect: (id: string) => void;
  onOpen: (t: Ticket) => void;
  onStatus: (t: Ticket, v: string) => void;
  onPriority: (t: Ticket, v: string | null) => void;
  onDueDate: (t: Ticket, v: string | null) => void;
  onProject: (t: Ticket, v: string | null) => void;
  onAssignees: (t: Ticket, ids: string[]) => void;
  onDuplicate: (t: Ticket) => void;
  onDelete: (t: Ticket) => void;
}) {
  const closed = CLOSED_STATES.includes(canonState(t.status));

  const check = <RowCheck checked={selected} onChange={() => onSelect(t.id)} label={`Seleccionar ${t.identifier}`} />;
  const statusCell = (
    <MenuCell
      title="Cambiar estado"
      shortcut="S"
      options={STATUS_MENU}
      value={canonState(t.status)}
      onSave={(v) => onStatus(t, v)}
      forceOpen={forceMenu === 'status'}
      onForceClose={onForceClose}
    >
      <StatusIcon state={t.status} className="size-4" />
    </MenuCell>
  );
  const priorityCell = (
    <MenuCell
      title="Prioridad"
      shortcut="P"
      options={PRIO_MENU}
      value={t.priority ?? NO_PRIORITY}
      onSave={(v) => onPriority(t, v === NO_PRIORITY ? null : v)}
      forceOpen={forceMenu === 'priority'}
      onForceClose={onForceClose}
    >
      <PriorityIcon value={t.priority} />
    </MenuCell>
  );
  const title = (
    <button
      type="button"
      onClick={() => onOpen(t)}
      className={cn(
        'ml-1 min-w-0 flex-1 truncate self-stretch text-left text-[13.5px] font-medium transition-colors hover:text-orange-ink',
        closed && 'font-normal text-muted-foreground',
      )}
      title={t.name}
    >
      {t.name}
      <AutoAssignMark task={t} />
    </button>
  );
  const people = (
    <AssigneesCell
      compact
      align="end"
      value={assigneesOf(t)}
      devs={devs}
      onSave={(ids) => onAssignees(t, ids)}
      forceOpen={forceMenu === 'assignee'}
      onForceClose={onForceClose}
    />
  );
  const menu = <RowMenu t={t} onOpen={onOpen} onDuplicate={onDuplicate} onDelete={onDelete} />;

  // Se elige el layout en JS, no con `hidden`: con dos bloques los dos se montan en el DOM (solo
  // uno se ve), duplicando los nodos de cada fila — con 300 filas eso se nota.
  return (
    <div
      onMouseEnter={() => onHover(t.id)}
      onMouseLeave={() => onHover(null)}
      onContextMenu={(e) => onContext(e, t)}
      className={cn('group px-2 transition-colors', selected ? 'bg-orange-soft/60' : 'hover:bg-sidebar')}
      // El navegador se salta layout y pintado de las filas fuera de pantalla. Es virtualización
      // sin librería ni cálculo de posiciones; `containIntrinsicSize` reserva la altura real de la
      // fila para que la barra de scroll no dé saltos.
      style={{ contentVisibility: 'auto', containIntrinsicSize: isMobile ? '0 66px' : '0 41px' }}
    >
      {isMobile ? (
        /* Dos líneas. Como fila tabular no cabía: las columnas fijas se comían casi todo el ancho
           y el título quedaba sin espacio. */
        <div className="py-1">
          <div className="flex h-8 items-center gap-1">
            <span className="grid w-5 shrink-0 place-items-center">{check}</span>
            {statusCell}
            {title}
            <span className="w-7 shrink-0">{menu}</span>
          </div>
          <div className="-mt-0.5 ml-6 flex items-center gap-1">
            {priorityCell}
            <span className="min-w-0 truncate font-mono text-[11px] text-faint">{t.identifier}</span>
            <DateCell compact value={t.dueDate} overdue={t.overdue} onSave={(v) => onDueDate(t, v)} />
            <span className="ml-auto">{people}</span>
          </div>
        </div>
      ) : (
        <div className="flex h-10 items-center gap-1">
          {/* La casilla solo aparece al pasar el ratón (o si ya está marcada), como en Linear. */}
          <span className={cn('grid w-5 shrink-0 place-items-center transition-opacity', !selected && 'opacity-0 focus-within:opacity-100 group-hover:opacity-100')}>
            {check}
          </span>
          {priorityCell}
          {/* Ancho fijo para que los títulos arranquen alineados; `w-24` deja ver el NÚMERO de
              `HYPERFLOW-454`, que es lo único que identifica al ticket. */}
          <span className="hidden w-24 shrink-0 truncate px-1 font-mono text-[11.5px] text-faint sm:block">{t.identifier}</span>
          {statusCell}
          {title}
          {!!t.labels?.length && (
            <span className="hidden shrink-0 items-center gap-1 lg:flex">
              {t.labels.slice(0, 2).map((l) => (
                <span key={l} className="inline-flex h-6 max-w-[9rem] items-center gap-1.5 rounded-full border bg-card px-2 text-[12px] text-muted-foreground">
                  <LabelDot label={l} className="size-1.5" />
                  <span className="truncate">{l}</span>
                </span>
              ))}
              {t.labels.length > 2 && <span className="text-[11.5px] text-faint">+{t.labels.length - 2}</span>}
            </span>
          )}
          {showProject && t.projectId && (
            <span className="hidden shrink-0 xl:block">
              <MenuCell
                title="Mover a proyecto"
                options={projectMenu}
                value={t.projectId}
                onSave={(v) => { if (v !== t.projectId) onProject(t, v); }}
                className={CHIP_CELL}
                align="end"
              >
                <ProjectIcon id={t.projectId} size="xs" className="size-3.5" />
                <span className="truncate">{t.projectName ?? '—'}</span>
              </MenuCell>
            </span>
          )}
          {/* Sin fecha, la celda solo se asoma al pasar el ratón: una columna de guiones es ruido. */}
          <span className={cn('hidden w-[5.25rem] shrink-0 justify-end md:flex', !t.dueDate && 'opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100')}>
            <DateCell compact value={t.dueDate} overdue={t.overdue} onSave={(v) => onDueDate(t, v)} />
          </span>
          <span className="flex w-20 shrink-0 justify-end">{people}</span>
          <span className="w-7 shrink-0">{menu}</span>
        </div>
      )}
    </div>
  );
});

/** Marca de la asignación automática junto al título: pensando, la eligió roz, necesita decisión o
 *  falló. Solo un ícono con su tooltip — el porqué completo vive en el detalle de la tarea. */
function AutoAssignMark({ task }: { task: Ticket }) {
  const s = task.autoAssign?.state;
  if (!s || s === 'overridden') return null;
  const common = 'ml-1.5 inline size-3.5 align-[-2px]';
  if (s === 'pending') return <Loader2 className={cn(common, 'animate-spin text-muted-foreground')} aria-label="roz está eligiendo responsable" />;
  if (s === 'assigned') return <Bot className={cn(common, 'text-purple-deep')} aria-label="Asignada automáticamente"><title>Asignada automáticamente</title></Bot>;
  if (s === 'escalated') return <AlertTriangle className={cn(common, 'text-warning')} aria-label="Necesita decisión"><title>roz no encontró a quién asignarla: necesita decisión</title></AlertTriangle>;
  return <XCircle className={cn(common, 'text-destructive')} aria-label="No se pudo asignar"><title>No se pudo asignar automáticamente</title></XCircle>;
}

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
      className="grid size-7 place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-panel hover:text-foreground focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
      aria-label="Acciones"
    >
      <Ellipsis className="size-4" />
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
