import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from '@/lib/toast';
import { Link } from 'react-router-dom';
import {
  Trash2, Send, ImagePlus, X, GitPullRequest, GitCommit, Loader2, GitMerge, ChevronUp, ChevronRight,
  MessagesSquare, Paperclip, Bot, UserRound, Tag, Gauge, Shapes, CalendarClock, Ellipsis, Copy, Check,
  Lock, ExternalLink, ChevronDown, Link2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/bits';
import { GithubAvatar, IntegrationIcon } from '@/components/brand';
import { ProjectIcon } from '@/components/avatars';
import { Markdown } from '@/components/Markdown';
import { useRozV2 } from '@/components/pulse/roz-v2';
import { AutoAssignPanel } from '@/components/tasks/AutoAssignPanel';
import { OverrideReasonDialog } from '@/components/tasks/OverrideReasonDialog';
import { StatusIcon } from '@/components/tasks/inline-cells';
import {
  DueDateMenu, Kbd, LabelDot, PILL, PriorityIcon, PropRow, PropertyMenu, ROW, ScheduleMenu, SideSection,
  useAutosize, type PropOption,
} from '@/components/tasks/properties';
import { apiGet, apiSend, apiUpload, type Ticket, type TicketFilterOptions, type Attachment } from '@/lib/api';
import { isOverrideRequired, needsOverride } from '@/lib/assign';
import { localDateStr, localTimeStr, toIso } from '@/lib/calendar';
import { htmlToMarkdown, looksLikeHtml } from '@/lib/rich-text';
import { relative, compact, isPastDay } from '@/lib/format';
import { OPEN_STATES, CLOSED_STATES, PRIO_OPTIONS, STATE_OPTIONS, STATE_LABEL, PRIO_LABEL } from '@/lib/labels';
import { cn } from '@/lib/utils';

const NONE = '__none__'; // "sin valor" en los menús
const AUTO = '__auto__'; // "que roz lo asigne" (solo al crear)
const MAX_BYTES = 4 * 1024 * 1024; // debe coincidir con el límite del backend
const CREATE_MORE_KEY = 'roz-task-create-more';
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** Atajos de teclado del modal (con el foco fuera de un campo de texto). */
const SHORTCUTS: Record<string, MenuKey> = { s: 'status', p: 'priority', a: 'assignee', l: 'labels', e: 'estimate', d: 'due' };
type MenuKey = 'status' | 'priority' | 'assignee' | 'labels' | 'estimate' | 'due' | 'project' | 'solution' | 'schedule' | 'more';

interface TaskComment {
  id: string; authorId: string | null; authorName: string | null;
  body: string; mentions: string[]; createdAt: string;
}

// Anillo del avatar según el veredicto de review (igual que en Tickets).
function reviewRing(state: string | null | undefined): string {
  if (state === 'approved') return 'ring-green';
  if (state === 'changes_requested') return 'ring-orange';
  return 'ring-border';
}

function readCreateMore(): boolean {
  try { return localStorage.getItem(CREATE_MORE_KEY) === '1'; } catch { return false; }
}
function writeCreateMore(v: boolean) {
  try { localStorage.setItem(CREATE_MORE_KEY, v ? '1' : '0'); } catch { /* sin almacenamiento: da igual */ }
}

/**
 * Alta y detalle de una tarea nativa, con el lenguaje de Linear.
 *
 *  · ALTA: modal limpio arriba-centro. Breadcrumb con el proyecto, título grande sin borde,
 *    descripción sin borde, una fila de píldoras de propiedades (cada una abre un menú con búsqueda
 *    y teclado), y un pie con adjuntar, "Crear más" y "Crear tarea" (Ctrl/⌘+Enter). Lo avanzado
 *    (tipo de solución, agenda) vive en "Más"; la asignación automática es una opción del menú de
 *    responsable ("Que roz lo asigne") y corre al crear.
 *  · DETALLE: a la izquierda título, descripción, adjuntos y actividad; a la derecha el panel de
 *    propiedades, la asignación automática y la conexión con código. TODO se guarda solo: los
 *    detalles al tocarlos y el texto al salir del campo (o al cerrar).
 *
 * Atajos (con el foco fuera de un campo): S estado, P prioridad, A responsable, L etiquetas,
 * E estimación, D fecha límite. Esc cierra; dentro de un menú, Esc cierra solo el menú.
 */
export function TaskDialog({
  open,
  onOpenChange,
  task,
  defaultDate,
  defaultState,
  prefill,
  chatMessageId,
  filters,
  knownLabels,
  onSaved,
  onPrev,
  onNext,
  position,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  task?: Ticket | null;
  defaultDate?: string;
  /** Estado con el que nace una tarea nueva. Lo manda el tablero: si pulsaste "Añade una tarjeta"
   *  en "En curso", la tarea tiene que nacer en "En curso" y no en el estado por defecto. */
  defaultState?: string;
  /** Valores iniciales de una tarea NUEVA (p. ej. "Crear tarea" desde un mensaje del chat). */
  prefill?: { name?: string; description?: string; assigneeDevIds?: string[]; projectId?: string };
  /** Mensaje del chat del que nace la tarea: viaja en el POST y queda como su origen. */
  chatMessageId?: string;
  filters: TicketFilterOptions;
  /** Etiquetas que ya existen (para sugerirlas en el menú). Opcional. */
  knownLabels?: string[];
  /** Devuelve la tarea afectada (el backend responde la fila completa) para que la lista toque
   *  esa fila y nada más, en vez de recargarse entera. */
  onSaved: (task: Ticket, mode: 'created' | 'updated' | 'deleted') => void;
  /** Tarea anterior / siguiente de la lista (detalle). Sin ellos no se pintan las flechas. */
  onPrev?: () => void;
  onNext?: () => void;
  /** "3 / 40": posición dentro de la lista visible. */
  position?: string;
}) {
  const editing = !!task;
  // Con Linear como fuente de verdad las tareas son de solo lectura: el detalle sirve para leer.
  const readOnly = useRozV2().linearSourceOfTruth;

  const [title, setTitle] = useState('');
  const [spec, setSpec] = useState('');
  const [descEditing, setDescEditing] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [state, setState] = useState('planificada');
  const [priority, setPriority] = useState(NONE);
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [autoAssign, setAutoAssign] = useState(false); // "Que roz lo asigne" (solo alta)
  const [schedDate, setSchedDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [dueDate, setDueDate] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [estimate, setEstimate] = useState(NONE); // story points (1/2/3/5/8/13)
  // Tipo de solución (Skills → Tipos de solución). Lo que fija una persona gana sobre roz.
  const [solutionTypeId, setSolutionTypeId] = useState(NONE);
  // Cambio de responsables pendiente de motivo: corrige al que eligió roz (override).
  const [overridePrompt, setOverridePrompt] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [createMore, setCreateMore] = useState(readCreateMore);
  const [menu, setMenu] = useState<MenuKey | null>(null);
  // Píldoras opcionales que se sacaron del menú "Más" en el alta.
  const [revealed, setRevealed] = useState<Set<MenuKey>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState<'id' | 'link' | null>(null);

  // Comentarios (solo en edición).
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);

  // Adjuntos. En edición se suben al instante; en alta se encolan (pending) con preview local y se
  // suben después de crear la tarea (cuando ya existe su id).
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pending, setPending] = useState<{ file: File; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  useAutosize(titleRef, title);
  useAutosize(descRef, spec + String(descEditing));

  // Último texto guardado (detalle): evita un PATCH doble cuando el blur y el cierre coinciden.
  const savedText = useRef({ name: '', description: '' });

  // Fuente del formulario, leída por REF dentro del efecto de abajo. Va aparte porque el efecto
  // NO debe volver a correr cuando estos valores cambian de identidad: `task` es un objeto nuevo
  // cada vez que la lista se actualiza, y re-ejecutar el efecto reescribía el formulario encima de
  // lo que estabas escribiendo.
  const src = useRef({ task, defaultDate, defaultState, prefill, projects: filters.allProjects });
  src.current = { task, defaultDate, defaultState, prefill, projects: filters.allProjects };

  // Se resetea SOLO al abrir, o al cambiar de tarea (por id) con el modal ya abierto.
  useEffect(() => {
    if (!open) return;
    const { task, defaultDate, defaultState, prefill, projects } = src.current;
    if (task) {
      setTitle(task.name ?? '');
      setSpec(task.description ?? '');
      savedText.current = { name: task.name ?? '', description: task.description ?? '' };
      setProjectId(task.projectId ?? '');
      setState(task.status || 'planificada');
      setPriority(task.priority ?? NONE);
      setAssigneeIds(currentAssignees(task));
      if (task.scheduledStart) {
        const s = new Date(task.scheduledStart);
        setSchedDate(localDateStr(s));
        setStartTime(localTimeStr(s));
        setEndTime(task.scheduledEnd ? localTimeStr(new Date(task.scheduledEnd)) : localTimeStr(new Date(s.getTime() + 3600_000)));
      } else {
        setSchedDate(''); setStartTime('09:00'); setEndTime('10:00');
      }
      setDueDate(task.dueDate ? task.dueDate.slice(0, 10) : '');
      setLabels(task.labels ?? []);
      setEstimate(task.estimate ? String(task.estimate) : NONE);
      setSolutionTypeId(task.solutionTypeId ?? NONE);
    } else {
      setTitle(prefill?.name ?? ''); setSpec(prefill?.description ?? '');
      setProjectId(prefill?.projectId && projects.some((p) => p.id === prefill.projectId) ? prefill.projectId : projects[0]?.id ?? '');
      setState(defaultState ?? 'planificada'); setPriority(NONE); setAssigneeIds(prefill?.assigneeDevIds ?? []);
      setSchedDate(defaultDate ?? ''); setStartTime('09:00'); setEndTime('10:00');
      setDueDate(''); setLabels([]); setEstimate(NONE); setSolutionTypeId(NONE);
      setRevealed(new Set(defaultDate ? (['schedule'] as MenuKey[]) : []));
    }
    setAutoAssign(false);
    setMenu(null);
    setOverridePrompt(null);
    setConfirmDelete(false);
    setCommentBody('');
    setComments([]);
    setAttachments([]);
    setPending((prev) => { prev.forEach((p) => URL.revokeObjectURL(p.url)); return []; });
    // En el detalle con descripción → se lee renderizada; sin texto → editor directo.
    setDescEditing(!(task && (task.description ?? '').trim()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  // Comentarios + adjuntos al abrir el detalle. Por id: la lista renueva el objeto `task` y no hay
  // que re-pedir nada por eso. Se avisa si fallan (un panel secundario puede degradar, no callar).
  const taskId = task?.id;
  useEffect(() => {
    if (!open || !task) return;
    let alive = true;
    setCommentsLoading(true);
    apiGet<{ comments: TaskComment[] }>(`/tickets/${task.id}/comments`)
      .then((r) => alive && setComments(r.comments))
      .catch((e) => alive && toast.error('No se pudieron cargar los comentarios', { description: String(e?.message ?? e) }))
      .finally(() => alive && setCommentsLoading(false));
    apiGet<{ attachments: Attachment[] }>(`/tickets/${task.id}/attachments`)
      .then((r) => alive && setAttachments(r.attachments))
      .catch((e) => alive && toast.error('No se pudieron cargar las imágenes', { description: String(e?.message ?? e) }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId]);

  const projects = filters.allProjects ?? [];
  const states = filters.allStates?.length ? filters.allStates : STATE_OPTIONS;
  const priorities = filters.priorities?.length ? filters.priorities : PRIO_OPTIONS;
  const devs = filters.devs ?? [];
  const solutionTypes = filters.solutionTypes ?? [];
  const points = filters.estimatePoints ?? [1, 2, 3, 5, 8, 13];
  const canAutoCreate = !editing && !!filters.autoAssignEnabled && OPEN_STATES.includes(state);
  const locked = editing && readOnly;

  // ------------------------------------------------------------------ alta
  async function create() {
    if (!title.trim() || busy) return;
    if (!projectId) {
      toast.error('Elige un proyecto');
      setMenu('project');
      return;
    }
    setBusy(true);
    const body = {
      name: title.trim(),
      description: spec.trim() || null,
      status: state,
      priority: priority === NONE ? null : priority,
      assigneeDevIds: assigneeIds,
      scheduledStart: schedDate ? toIso(schedDate, startTime) : null,
      scheduledEnd: schedDate ? toIso(schedDate, endTime) : null,
      dueDate: dueDate || null,
      labels,
      projectId,
      estimate: estimate === NONE ? null : Number(estimate),
      ...(solutionTypeId !== NONE ? { solutionTypeId } : {}),
      // "Que roz lo asigne": el backend solo corre la asignación si se pide explícito y no hay nadie.
      ...(autoAssign && canAutoCreate && assigneeIds.length === 0 ? { autoAssign: true } : {}),
      ...(chatMessageId ? { chatMessageId } : {}),
    };
    try {
      const { task: created } = await apiSend<{ task: Ticket }>('POST', '/tickets', body);
      // Subir las imágenes encoladas ahora que la tarea existe (best-effort: no anula la creación).
      if (pending.length) {
        try {
          for (const p of pending) await apiUpload<{ attachment: Attachment }>(`/tickets/${created.id}/attachments`, p.file);
        } catch {
          toast.error('La tarea se creó, pero algunas imágenes no se subieron');
        }
        pending.forEach((p) => URL.revokeObjectURL(p.url));
      }
      toast.success('Tarea creada', { description: `${created.identifier} · ${title.trim()}` });
      const more = createMore && !chatMessageId;
      if (more) {
        // Como Linear: se queda abierto con las mismas propiedades y el texto limpio.
        setTitle('');
        setSpec('');
        setPending([]);
        setTimeout(() => titleRef.current?.focus(), 0);
      } else {
        onOpenChange(false);
      }
      onSaved(created, 'created');
    } catch (e: any) {
      toast.error('No se pudo crear', { description: String(e.message ?? e) });
    }
    setBusy(false);
  }

  async function remove() {
    if (!task) return;
    setBusy(true);
    try {
      await apiSend<{ ok: true }>('DELETE', `/tickets/${task.id}`);
      toast.success('Tarea eliminada', { description: task.name });
      onOpenChange(false);
      onSaved(task, 'deleted');
    } catch (e: any) {
      toast.error('No se pudo eliminar', { description: String(e.message ?? e) });
    }
    setBusy(false);
  }

  async function addComment() {
    if (!task || !commentBody.trim()) return;
    setCommentBusy(true);
    try {
      const { comment } = await apiSend<{ comment: TaskComment }>('POST', `/tickets/${task.id}/comments`, { body: commentBody.trim() });
      setComments((prev) => [...prev, comment]);
      setCommentBody('');
    } catch (e: any) {
      toast.error('No se pudo comentar', { description: String(e.message ?? e) });
    }
    setCommentBusy(false);
  }

  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    const valid = files.filter((f) => {
      if (!f.type.startsWith('image/')) { toast.error('Solo se aceptan imágenes', { description: f.name }); return false; }
      if (f.size > MAX_BYTES) { toast.error('La imagen supera 4MB', { description: f.name }); return false; }
      return true;
    });
    if (!valid.length) return;
    // Alta: aún no hay tarea → se encolan con preview local y se suben al crear.
    if (!task) {
      setPending((prev) => [...prev, ...valid.map((f) => ({ file: f, url: URL.createObjectURL(f) }))]);
      return;
    }
    setUploading(true);
    try {
      for (const f of valid) {
        const { attachment } = await apiUpload<{ attachment: Attachment }>(`/tickets/${task.id}/attachments`, f);
        setAttachments((prev) => [...prev, attachment]);
      }
      toast.success(valid.length === 1 ? 'Imagen subida' : `${valid.length} imágenes subidas`);
    } catch (e: any) {
      toast.error('No se pudo subir', { description: String(e.message ?? e) });
    }
    setUploading(false);
  }

  function removePending(url: string) {
    setPending((prev) => {
      const found = prev.find((p) => p.url === url);
      if (found) URL.revokeObjectURL(found.url);
      return prev.filter((p) => p.url !== url);
    });
  }

  async function removeAttachment(a: Attachment) {
    if (!task) return;
    const prev = attachments;
    setAttachments((list) => list.filter((x) => x.id !== a.id)); // optimista
    try {
      await apiSend<{ ok: true }>('DELETE', `/tickets/${task.id}/attachments/${a.id}`);
    } catch (e: any) {
      setAttachments(prev); // revierte
      toast.error('No se pudo eliminar la imagen', { description: String(e.message ?? e) });
    }
  }

  /**
   * Autoguardado del detalle. Encadenado: dos cambios seguidos sobre la misma tarea van en orden,
   * no en paralelo. En el alta no hace nada — todavía no hay fila y todo viaja en el POST.
   */
  const [autoBusy, setAutoBusy] = useState(0);
  const autoChain = useRef<Promise<void>>(Promise.resolve());
  const autosave = (body: Record<string, unknown>) => {
    if (!task || readOnly) return;
    const id = task.id;
    setAutoBusy((n) => n + 1);
    autoChain.current = autoChain.current.then(async () => {
      try {
        // Se avisa al padre con la fila completa: la lista de atrás se actualiza sola.
        onSaved((await apiSend<{ task: Ticket }>('PATCH', `/tickets/${id}`, body)).task, 'updated');
      } catch (e: any) {
        if (isOverrideRequired(e) && Array.isArray(body.assigneeDevIds)) {
          // El backend pide motivo (la regla local no lo vio venir): se revierte y se pregunta.
          setAssigneeIds(currentAssignees(src.current.task));
          setOverridePrompt(body.assigneeDevIds as string[]);
        } else {
          toast.error('No se pudo guardar', { description: String(e?.message ?? e) });
        }
      } finally {
        setAutoBusy((n) => n - 1);
      }
    });
  };

  /** Guarda título y descripción si cambiaron (detalle). Lo llaman el blur, Ctrl+Enter y el cierre. */
  function flushText() {
    if (!task || readOnly) return;
    const patch: Record<string, unknown> = {};
    const name = title.trim();
    if (!name) setTitle(savedText.current.name);
    else if (name !== savedText.current.name) patch.name = name;
    if (spec !== savedText.current.description) patch.description = spec.trim() || null;
    if (!Object.keys(patch).length) return;
    savedText.current = { name: name || savedText.current.name, description: spec };
    autosave(patch);
  }

  function handleOpenChange(v: boolean) {
    if (!v && editing) flushText();
    onOpenChange(v);
  }

  // ---- Responsables. El ORDEN es el dato: el primero es el responsable, el resto apoyo. ----
  function setAssignees(next: string[]) {
    if (!task) {
      setAssigneeIds(next);
      return;
    }
    // Cambiar al responsable que eligió roz pide un motivo (una sola vez): es lo que le enseña.
    if (needsOverride(task, next)) {
      setOverridePrompt(next);
      return;
    }
    setAssigneeIds(next);
    autosave({ assigneeDevIds: next });
  }
  function confirmOverride(category: string, note: string | null) {
    const next = overridePrompt;
    setOverridePrompt(null);
    if (!next) return;
    setAssigneeIds(next);
    autosave({ assigneeDevIds: next, override: { category, note } });
  }
  function onAutoAssignChange(t: Ticket) {
    setAssigneeIds(currentAssignees(t));
    if (t.estimate) setEstimate(String(t.estimate));
    if (t.solutionTypeId) setSolutionTypeId(t.solutionTypeId);
    onSaved(t, 'updated');
  }
  function pickAssignee(v: string) {
    if (v === AUTO) {
      setAutoAssign((a) => !a);
      if (assigneeIds.length) setAssigneeIds([]);
      return;
    }
    setAutoAssign(false);
    if (v === NONE) return setAssignees([]);
    setAssignees(assigneeIds.includes(v) ? assigneeIds.filter((x) => x !== v) : [...assigneeIds, v]);
  }
  const promoteAssignee = (id: string) => setAssignees([id, ...assigneeIds.filter((x) => x !== id)]);

  function saveSchedule(date: string, start: string, end: string) {
    setSchedDate(date); setStartTime(start); setEndTime(end);
    autosave({ scheduledStart: date ? toIso(date, start) : null, scheduledEnd: date ? toIso(date, end) : null });
  }
  function toggleLabel(l: string) {
    const next = labels.includes(l) ? labels.filter((x) => x !== l) : [...labels, l];
    setLabels(next);
    autosave({ labels: next });
  }

  const devById = (id: string) => devs.find((d) => d.id === id) ?? task?.assignees?.find((a) => a.id === id) ?? null;
  const nameOfDev = (id: string) => devById(id)?.name ?? '—';

  // ---- Opciones de los menús ----
  const statusOptions: PropOption[] = useMemo(
    () => states.map((s) => ({ value: s.value, label: s.label, icon: <StatusIcon state={s.value} className="size-4" /> })),
    [states],
  );
  const priorityOptions: PropOption[] = useMemo(
    () => [
      { value: NONE, label: 'Sin prioridad', icon: <PriorityIcon value={null} /> },
      ...priorities.map((p) => ({ value: p.value, label: p.label, icon: <PriorityIcon value={p.value} /> })),
    ],
    [priorities],
  );
  const assigneeOptions: PropOption[] = [
    ...(canAutoCreate
      ? [{ value: AUTO, label: 'Que roz lo asigne', keywords: 'auto automatico roz jev', icon: <Bot className="text-purple-deep" />, hint: 'al crear' }]
      : []),
    { value: NONE, label: 'Sin responsable', icon: <UserRound className="text-muted-foreground" /> },
    ...devs.map((d, i) => {
      const at = assigneeIds.indexOf(d.id);
      return {
        value: d.id,
        label: d.name,
        divider: i === 0,
        icon: <UserAvatar url={d.avatarUrl} id={d.id} name={d.name} className="size-4" />,
        hint: at === 0 ? 'Responsable' : at > 0 ? 'Apoyo' : undefined,
      };
    }),
  ];
  const assigneeValues = autoAssign ? [AUTO] : assigneeIds.length ? assigneeIds : [NONE];
  const labelOptions: PropOption[] = useMemo(() => {
    const all = [...new Set([...(knownLabels ?? []), ...labels])].sort((a, b) => a.localeCompare(b));
    return all.map((l) => ({ value: l, label: l, icon: <LabelDot label={l} /> }));
  }, [knownLabels, labels]);
  const estimateOptions: PropOption[] = [
    { value: NONE, label: 'Sin estimar', icon: <Gauge className="text-faint" /> },
    ...points.map((p) => ({ value: String(p), label: `${p} ${p === 1 ? 'punto' : 'puntos'}`, hint: `≈ ${p * 2} h`, icon: <Gauge className="text-muted-foreground" /> })),
  ];
  const projectOptions: PropOption[] = projects.map((p) => ({ value: p.id, label: p.name, icon: <ProjectIcon id={p.id} size="xs" className="size-4" /> }));
  const solutionOptions: PropOption[] = [
    { value: NONE, label: 'Sin tipo (roz lo deduce)', icon: <Shapes className="text-faint" /> },
    ...solutionTypes
      .filter((t) => t.active || t.id === solutionTypeId)
      .map((t) => ({ value: t.id, label: t.active ? t.name : `${t.name} (retirado)`, icon: <Shapes className="text-muted-foreground" /> })),
  ];

  /** Props de apertura controlada: los atajos y el menú "Más" abren un menú concreto. */
  const menuProps = (k: MenuKey) => ({
    open: menu === k,
    onOpenChange: (o: boolean) => setMenu((cur) => (o ? k : cur === k ? null : cur)),
  });

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (editing) {
        flushText();
        (document.activeElement as HTMLElement | null)?.blur();
      } else {
        void create();
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, [contenteditable="true"]')) return;
    // J / K: tarea siguiente / anterior, como en Linear.
    if (editing && (e.key === 'j' || e.key === 'k')) {
      const go = e.key === 'j' ? onNext : onPrev;
      if (go) { e.preventDefault(); flushText(); go(); }
      return;
    }
    if (locked) return;
    const k = SHORTCUTS[e.key.toLowerCase()];
    if (k) {
      e.preventDefault();
      setMenu(k);
    }
  }

  // ---- Disparadores (contenido de las píldoras / filas) ----
  const stateLabel = states.find((s) => s.value === state)?.label ?? STATE_LABEL[state] ?? state;
  const statusDisplay = <><StatusIcon state={state} className="size-3.5" /><span className="truncate">{stateLabel}</span></>;
  const priorityDisplay = (
    <>
      <PriorityIcon value={priority === NONE ? null : priority} className="size-3.5" />
      <span className={cn('truncate', priority === NONE && 'text-muted-foreground')}>
        {priority === NONE ? 'Prioridad' : priorities.find((p) => p.value === priority)?.label ?? PRIO_LABEL[priority] ?? priority}
      </span>
    </>
  );
  const assigneeDisplay = autoAssign ? (
    <><Bot className="text-purple-deep" /><span className="truncate">roz lo asigna</span></>
  ) : assigneeIds.length ? (
    <>
      <UserAvatar url={devById(assigneeIds[0])?.avatarUrl ?? null} id={assigneeIds[0]} name={nameOfDev(assigneeIds[0])} className="size-4" />
      <span className="truncate">{nameOfDev(assigneeIds[0])}</span>
      {assigneeIds.length > 1 && <span className="shrink-0 text-faint">+{assigneeIds.length - 1}</span>}
    </>
  ) : (
    <><UserRound className="text-muted-foreground" /><span className="truncate text-muted-foreground">{editing ? 'Sin responsable' : 'Responsable'}</span></>
  );
  const labelsDisplay = labels.length ? (
    <>
      <span className="flex shrink-0 -space-x-0.5">{labels.slice(0, 3).map((l) => <LabelDot key={l} label={l} className="ring-2 ring-card" />)}</span>
      <span className="truncate">{labels.length === 1 ? labels[0] : `${labels.length} etiquetas`}</span>
    </>
  ) : (
    <><Tag className="text-muted-foreground" /><span className="truncate text-muted-foreground">{editing ? 'Sin etiquetas' : 'Etiquetas'}</span></>
  );
  const estimateDisplay = (
    <>
      <Gauge className={cn(estimate === NONE && 'text-muted-foreground')} />
      <span className={cn('truncate', estimate === NONE && 'text-muted-foreground')}>
        {estimate === NONE ? (editing ? 'Sin estimar' : 'Estimación') : `${estimate} ${estimate === '1' ? 'punto' : 'puntos'}`}
      </span>
    </>
  );
  const solutionName = solutionTypes.find((t) => t.id === solutionTypeId)?.name;
  const solutionDisplay = (
    <><Shapes className={cn(!solutionName && 'text-muted-foreground')} /><span className={cn('truncate', !solutionName && 'text-muted-foreground')}>{solutionName ?? 'Tipo de solución'}</span></>
  );
  const projectName = projects.find((p) => p.id === projectId)?.name ?? task?.projectName ?? null;
  const overdue = !!dueDate && !CLOSED_STATES.includes(state) && isPastDay(dueDate);

  const assigneeFooter = editing
    ? 'El primero es el responsable; los demás, apoyo.'
    : canAutoCreate
      ? 'El primero es el responsable. "Que roz lo asigne" elige al crear.'
      : 'El primero es el responsable; los demás, apoyo.';

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*"
      multiple
      className="hidden"
      onChange={(e) => { uploadFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }}
    />
  );
  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => { if (locked) return; e.preventDefault(); setDropActive(true); },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false); },
    onDrop: (e: React.DragEvent) => { if (locked) return; e.preventDefault(); setDropActive(false); uploadFiles(Array.from(e.dataTransfer.files ?? [])); },
  };

  // =========================================================================== ALTA
  if (!editing) {
    const optional: { key: MenuKey; label: string; icon: ReactNode; show: boolean }[] = [
      { key: 'solution', label: 'Tipo de solución', icon: <Shapes />, show: solutionTypes.length > 0 },
      { key: 'schedule', label: 'Agendar en el calendario', icon: <CalendarClock />, show: true },
    ];
    const isShown = (k: MenuKey) =>
      revealed.has(k) || (k === 'solution' ? solutionTypeId !== NONE : k === 'schedule' ? !!schedDate : false);
    const hidden = optional.filter((o) => o.show && !isShown(o.key));

    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        {/* Contenedor transparente a pantalla completa: la animación del modal centra con
            translate(-50%,-50%), así que la tarjeta se coloca arriba-centro DENTRO de él. Los clics
            en la zona transparente pasan al fondo (y cierran), como en cualquier modal. */}
        <DialogContent
          showClose={false}
          className="flex h-[100dvh] max-w-none flex-col items-stretch justify-start gap-0 border-0 bg-transparent p-0 shadow-none sm:max-w-[760px]"
          style={{ pointerEvents: 'none' }}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => { e.preventDefault(); titleRef.current?.focus(); }}
        >
          <div
            {...dropHandlers}
            style={{ pointerEvents: 'auto' }}
            className={cn(
              'relative mx-3 mt-[7dvh] flex max-h-[86dvh] flex-col overflow-hidden rounded-xl border bg-card shadow-lg transition-colors sm:mx-0 sm:mt-[12dvh] sm:max-h-[76dvh]',
              dropActive && 'border-orange ring-2 ring-orange/30',
            )}
          >
            {/* ---- Breadcrumb: proyecto › Nueva tarea ---- */}
            <div className="flex h-12 shrink-0 items-center gap-1.5 px-4">
              <PropertyMenu
                title="Mover a proyecto"
                options={projectOptions}
                value={projectId}
                onSelect={setProjectId}
                triggerClassName={cn(PILL, 'h-7 border-transparent bg-panel hover:bg-toggle-off/60')}
                triggerLabel="Proyecto"
                {...menuProps('project')}
              >
                {projectId ? <ProjectIcon id={projectId} size="xs" className="size-4" /> : <Shapes className="text-muted-foreground" />}
                <span className={cn('truncate', !projectId && 'text-muted-foreground')}>{projectName ?? 'Elige proyecto'}</span>
              </PropertyMenu>
              <ChevronRight className="size-3.5 shrink-0 text-faint" />
              <DialogTitle className="truncate text-[13px] font-medium tracking-normal text-muted-foreground">Nueva tarea</DialogTitle>
              <DialogDescription className="sr-only">Escribe el título, la descripción y elige sus propiedades.</DialogDescription>
              {chatMessageId && (
                <span className="ml-1 hidden items-center gap-1 rounded-md bg-lavender px-1.5 py-0.5 text-[11.5px] font-medium text-purple-deep sm:inline-flex" title="Queda enlazada al mensaje y se avisa en su hilo">
                  <MessagesSquare className="size-3" /> Desde el chat
                </span>
              )}
              <button
                type="button"
                onClick={() => handleOpenChange(false)}
                className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
                aria-label="Cerrar"
                title="Cerrar · Esc"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* ---- Título + descripción, sin bordes ---- */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
              <textarea
                ref={titleRef}
                value={title}
                onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); descRef.current?.focus(); }
                }}
                rows={1}
                placeholder="Título de la tarea"
                aria-label="Título"
                className="block w-full resize-none overflow-hidden bg-transparent pt-1 text-[21px] font-semibold leading-snug tracking-[-0.025em] outline-none placeholder:text-faint"
              />
              <textarea
                ref={descRef}
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                rows={3}
                placeholder="Agrega una descripción…"
                aria-label="Descripción"
                className="mt-2 block min-h-[96px] w-full resize-none overflow-hidden bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-faint"
              />
              {pending.length > 0 && (
                <div className="flex flex-wrap gap-2 pb-2 pt-1">
                  {pending.map((p) => (
                    <Thumb key={p.url} url={p.url} name={p.file.name} onRemove={() => removePending(p.url)} size="size-16" />
                  ))}
                </div>
              )}
            </div>

            {/* ---- Propiedades ---- */}
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pb-3 pt-1">
              <PropertyMenu title="Cambiar estado" shortcut="S" options={statusOptions} value={state} onSelect={setState} {...menuProps('status')}>
                {statusDisplay}
              </PropertyMenu>
              <PropertyMenu title="Prioridad" shortcut="P" options={priorityOptions} value={priority} onSelect={setPriority} {...menuProps('priority')}>
                {priorityDisplay}
              </PropertyMenu>
              <PropertyMenu
                title="Asignar a"
                shortcut="A"
                options={assigneeOptions}
                values={assigneeValues}
                multi
                onSelect={pickAssignee}
                footer={assigneeFooter}
                {...menuProps('assignee')}
              >
                {assigneeDisplay}
              </PropertyMenu>
              <PropertyMenu
                title="Etiquetas"
                shortcut="L"
                options={labelOptions}
                values={labels}
                multi
                onSelect={(l) => setLabels((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]))}
                onCreate={(l) => setLabels((cur) => (cur.includes(l) ? cur : [...cur, l]))}
                {...menuProps('labels')}
              >
                {labelsDisplay}
              </PropertyMenu>
              <PropertyMenu title="Estimación" shortcut="E" options={estimateOptions} value={estimate} onSelect={setEstimate} footer="1 punto ≈ 2 h. Sin valor, roz lo estima al asignar." {...menuProps('estimate')}>
                {estimateDisplay}
              </PropertyMenu>
              <DueDateMenu value={dueDate || null} onChange={(v) => setDueDate(v ?? '')} overdue={overdue} shortcut="D" {...menuProps('due')} />
              {isShown('solution') && solutionTypes.length > 0 && (
                <PropertyMenu title="Tipo de solución" options={solutionOptions} value={solutionTypeId} onSelect={setSolutionTypeId} {...menuProps('solution')}>
                  {solutionDisplay}
                </PropertyMenu>
              )}
              {isShown('schedule') && (
                <ScheduleMenu
                  date={schedDate}
                  start={startTime}
                  end={endTime}
                  onChange={(d, s, en) => { setSchedDate(d); setStartTime(s); setEndTime(en); }}
                  {...menuProps('schedule')}
                />
              )}
              {hidden.length > 0 && (
                <PropertyMenu
                  title="Más propiedades"
                  options={hidden.map((o) => ({ value: o.key, label: o.label, icon: o.icon }))}
                  value={null}
                  onSelect={(v) => {
                    const k = v as MenuKey;
                    setRevealed((r) => new Set(r).add(k));
                    setMenu(k);
                  }}
                  triggerClassName={cn(PILL, 'w-7 justify-center px-0')}
                  triggerLabel="Más propiedades"
                  {...menuProps('more')}
                >
                  <Ellipsis />
                </PropertyMenu>
              )}
            </div>

            {/* ---- Pie: adjuntar · crear más · crear ---- */}
            <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2.5 sm:px-4">
              {fileInput}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
                title="Adjuntar imágenes (o arrástralas al modal)"
                aria-label="Adjuntar imágenes"
              >
                <Paperclip className="size-4" />
                {pending.length > 0 && <span className="tabular-nums">{pending.length}</span>}
              </button>
              <div className="ml-auto flex items-center gap-3">
                {!chatMessageId && (
                  <label className="flex cursor-pointer select-none items-center gap-2 text-[12.5px] text-muted-foreground">
                    <Switch
                      checked={createMore}
                      onCheckedChange={(v) => { setCreateMore(v); writeCreateMore(v); }}
                      aria-label="Crear más"
                    />
                    <span className="hidden sm:inline">Crear más</span>
                  </label>
                )}
                <Button onClick={() => void create()} disabled={busy || !title.trim()} className="gap-2">
                  {busy && <Loader2 className="animate-spin" />}
                  Crear tarea
                  <Kbd className="hidden border-white/25 bg-white/15 text-white sm:inline-grid">{MOD} ↵</Kbd>
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // =========================================================================== DETALLE
  const t = task!;
  const codeSignal = !!t.pr || t.source === 'commit' || !!t.reviewers?.length || !!t.effort?.commits;
  const descMarkdown = looksLikeHtml(spec) ? htmlToMarkdown(spec) : spec;

  async function copy(what: 'id' | 'link') {
    try {
      await navigator.clipboard.writeText(
        what === 'id' ? t.identifier : `${window.location.origin}/tareas?scope=team&task=${t.id}`,
      );
      setCopied(what);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      toast.error('No se pudo copiar');
    }
  }
  const copyId = () => copy('id');
  /** Cambiar de tarea guarda antes el texto a medio escribir de la actual. */
  const navigate = (go?: () => void) => {
    if (!go) return;
    flushText();
    go();
  };
  // Todos los controles de la barra miden lo mismo (28px) y van centrados en ella.
  const HBTN =
    'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35 data-[state=open]:bg-panel data-[state=open]:text-foreground [&_svg]:size-4';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showClose={false}
        className="flex h-[100dvh] w-full max-w-none flex-col gap-0 overflow-hidden p-0 sm:h-[min(90dvh,900px)] sm:max-w-[1120px]"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* ---- Barra superior: proyecto › ID · navegación · acciones. El cierre es un botón más de
            la fila (el de Radix se oculta): antes flotaba aparte, más grande y descentrado. ---- */}
        <div className="flex h-12 shrink-0 items-center gap-1 border-b pl-4 pr-2.5">
          <ProjectIcon id={t.projectId} size="xs" className="size-4" />
          <span className="ml-0.5 truncate text-[13px] text-muted-foreground">{projectName ?? 'Sin proyecto'}</span>
          <ChevronRight className="size-3.5 shrink-0 text-faint" />
          <button
            type="button"
            onClick={copyId}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 font-mono text-[12px] text-foreground transition-colors hover:bg-panel"
            title="Copiar ID"
          >
            {t.identifier}
            {copied === 'id' ? <Check className="size-3 text-green" /> : <Copy className="size-3 text-faint" />}
          </button>
          <DialogTitle className="sr-only">{t.name}</DialogTitle>
          <DialogDescription className="sr-only">Detalle de la tarea {t.identifier}</DialogDescription>
          {locked && (
            <span className="ml-1 inline-flex h-6 items-center gap-1 rounded-md bg-panel px-1.5 text-[11.5px] text-muted-foreground">
              <Lock className="size-3" /> Solo lectura
            </span>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <span className="mr-1.5 hidden items-center gap-1 text-[11.5px] text-faint sm:flex" aria-live="polite">
              {autoBusy > 0 && <><Loader2 className="size-3 animate-spin" /> Guardando…</>}
            </span>
            {(onPrev || onNext) && (
              <>
                {position && <span className="mr-1 hidden text-[11.5px] tabular-nums text-faint sm:inline">{position}</span>}
                <button type="button" className={HBTN} onClick={() => navigate(onPrev)} disabled={!onPrev} aria-label="Tarea anterior" title="Anterior · K">
                  <ChevronUp />
                </button>
                <button type="button" className={HBTN} onClick={() => navigate(onNext)} disabled={!onNext} aria-label="Tarea siguiente" title="Siguiente · J">
                  <ChevronDown />
                </button>
                <span className="mx-1 h-4 w-px bg-border" />
              </>
            )}
            <button type="button" className={HBTN} onClick={() => copy('link')} aria-label="Copiar enlace" title="Copiar enlace">
              {copied === 'link' ? <Check className="text-green" /> : <Link2 />}
            </button>
            {t.chatMessageId && (
              <Link to={`/chat/m/${t.chatMessageId}`} onClick={() => handleOpenChange(false)} className={HBTN} aria-label="Ver conversación de origen" title="Ver conversación de origen">
                <MessagesSquare />
              </Link>
            )}
            {locked && t.url && (
              <a href={t.url} target="_blank" rel="noreferrer noopener" className={HBTN} aria-label="Abrir en Linear" title="Abrir en Linear"><ExternalLink /></a>
            )}
            {!locked && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={HBTN} aria-label="Más acciones" title="Más acciones"><Ellipsis /></button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onClick={copyId}><Copy className="size-3.5" /> Copiar ID</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => copy('link')}><Link2 className="size-3.5" /> Copiar enlace</DropdownMenuItem>
                  {t.pr && (
                    <DropdownMenuItem onClick={() => window.open(t.pr!.url, '_blank', 'noopener,noreferrer')}>
                      <GitPullRequest className="size-3.5" /> Ver PR #{t.pr.number}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setConfirmDelete(true)} className="text-destructive focus:text-destructive">
                    <Trash2 className="size-3.5" /> Eliminar tarea
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <button type="button" className={HBTN} onClick={() => handleOpenChange(false)} aria-label="Cerrar" title="Cerrar · Esc">
              <X />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_288px] md:overflow-hidden">
          {/* ---- Principal: título, descripción, adjuntos, actividad ---- */}
          <div {...dropHandlers} className={cn('relative min-w-0 md:overflow-y-auto', dropActive && 'bg-orange-soft/40')}>
            <div className="mx-auto grid max-w-[720px] gap-6 px-5 py-6 sm:px-8">
              <div className="grid gap-2">
                <textarea
                  ref={titleRef}
                  value={title}
                  readOnly={locked}
                  onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                  onBlur={flushText}
                  rows={1}
                  placeholder="Título de la tarea"
                  aria-label="Título"
                  className="block w-full resize-none overflow-hidden bg-transparent text-[24px] font-semibold leading-tight tracking-[-0.03em] outline-none placeholder:text-faint"
                />
                {!descEditing && spec.trim() ? (
                  <div
                    role={locked ? undefined : 'button'}
                    tabIndex={locked ? undefined : 0}
                    onClick={(e) => { if (locked || (e.target as HTMLElement).closest('a')) return; setDescEditing(true); setTimeout(() => descRef.current?.focus(), 0); }}
                    onKeyDown={(e) => { if (!locked && e.key === 'Enter') { e.preventDefault(); setDescEditing(true); setTimeout(() => descRef.current?.focus(), 0); } }}
                    className={cn('-mx-2 rounded-md px-2 py-1 text-[14px] transition-colors', !locked && 'cursor-text hover:bg-sidebar')}
                    title={locked ? undefined : 'Clic para editar'}
                  >
                    <Markdown>{descMarkdown}</Markdown>
                  </div>
                ) : (
                  <>
                    <textarea
                      ref={descRef}
                      value={spec}
                      readOnly={locked}
                      onChange={(e) => setSpec(e.target.value)}
                      onBlur={() => { flushText(); if (spec.trim()) setDescEditing(false); }}
                      onKeyDown={(e) => { if (e.key === 'Escape' && spec.trim()) { e.stopPropagation(); e.currentTarget.blur(); } }}
                      placeholder="Agrega una descripción…"
                      aria-label="Descripción"
                      className="block min-h-[120px] w-full resize-none overflow-hidden bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-faint"
                    />
                    {looksLikeHtml(spec) && (
                      <p className="text-[11.5px] text-faint">Se escribió en Ops (HTML): se guarda tal cual la dejes.</p>
                    )}
                  </>
                )}
              </div>

              {/* Adjuntos */}
              <section className="grid gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="label-caps">Adjuntos{attachments.length > 0 && <span className="ml-1.5 tabular-nums">{attachments.length}</span>}</span>
                  {!locked && (
                    <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => fileRef.current?.click()} disabled={uploading}>
                      {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />} Agregar
                    </Button>
                  )}
                </div>
                {fileInput}
                {attachments.length > 0 || uploading ? (
                  <div className="flex flex-wrap gap-2">
                    {attachments.map((a) => (
                      <Thumb key={a.id} url={a.url} name={a.name} onRemove={locked ? undefined : () => removeAttachment(a)} />
                    ))}
                    {uploading && (
                      <div className="grid size-24 place-items-center rounded-lg border bg-panel text-faint">
                        <Loader2 className="size-5 animate-spin" />
                      </div>
                    )}
                  </div>
                ) : !locked ? (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className={cn(
                      'flex h-14 items-center justify-center gap-2 rounded-lg border border-dashed text-[12.5px] text-muted-foreground transition-colors hover:border-faint hover:text-foreground',
                      dropActive && 'border-orange text-orange-ink',
                    )}
                  >
                    <ImagePlus className="size-4" /> Arrastra imágenes o haz clic · PNG, JPG hasta 4MB
                  </button>
                ) : (
                  <p className="text-[12.5px] text-faint">Sin adjuntos.</p>
                )}
              </section>

              {/* Actividad */}
              <section className="grid gap-3 border-t pt-5">
                <span className="label-caps">Actividad</span>
                <ol className="grid gap-3">
                  <li className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                    <span className="grid size-6 shrink-0 place-items-center"><span className="size-1.5 rounded-full bg-toggle-off" /></span>
                    {t.createdBy ? (
                      <>
                        <UserAvatar url={t.createdBy.avatarUrl} email={t.createdBy.email} name={t.createdBy.name} className="size-4" />
                        <span><span className="font-medium text-foreground">{t.createdBy.name}</span> creó la tarea</span>
                      </>
                    ) : (
                      <span>Tarea creada</span>
                    )}
                    {t.ageDays != null && <span className="text-faint">· {t.ageDays === 0 ? 'hoy' : `hace ${t.ageDays} d`}</span>}
                  </li>
                  {t.pr && (
                    <li className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                      <span className="grid size-6 shrink-0 place-items-center">
                        {t.prState === 'merged' ? <GitMerge className="size-3.5 text-purple" /> : <GitPullRequest className="size-3.5" />}
                      </span>
                      <span className="min-w-0 truncate">
                        {t.prState === 'merged' ? 'Se integró el' : t.prState === 'closed' ? 'Se cerró el' : 'Se abrió el'}{' '}
                        <a href={t.pr.url} target="_blank" rel="noreferrer noopener" className="font-medium text-foreground hover:underline">
                          PR #{t.pr.number}
                        </a>{' '}
                        <span className="font-mono text-[11.5px] text-faint">{t.pr.repo}</span>
                      </span>
                    </li>
                  )}
                  {!t.pr && !!t.effort?.commits && (
                    <li className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                      <span className="grid size-6 shrink-0 place-items-center"><GitCommit className="size-3.5" /></span>
                      <span>{t.effort.commits} commit{t.effort.commits === 1 ? '' : 's'} enlazado{t.effort.commits === 1 ? '' : 's'} · {compact(t.effort.lines ?? 0)} líneas</span>
                    </li>
                  )}
                  {t.completedAt && (
                    <li className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                      <span className="grid size-6 shrink-0 place-items-center"><StatusIcon state="completada" className="size-3.5" /></span>
                      <span>Se completó</span>
                      <span className="text-faint">· {relative(t.completedAt)}</span>
                    </li>
                  )}
                  {commentsLoading && comments.length === 0 && (
                    <li className="flex gap-2.5">
                      <Skeleton className="size-6 rounded-full" />
                      <div className="grid flex-1 gap-1.5"><Skeleton className="h-3 w-32" /><Skeleton className="h-3 w-3/4" /></div>
                    </li>
                  )}
                  {comments.map((c) => (
                    <li key={c.id} className="flex gap-2.5">
                      <UserAvatar url={null} id={c.authorId} name={c.authorName ?? '?'} className="mt-0.5 size-6 shrink-0" />
                      <div className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-2">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate text-[12.5px] font-medium">{c.authorName ?? 'Anónimo'}</span>
                          <span className="shrink-0 text-[11px] tabular-nums text-faint">{relative(c.createdAt)}</span>
                        </div>
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-[13.5px]">{c.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                {!locked && (
                  <div className="rounded-lg border bg-card focus-within:ring-2 focus-within:ring-ring">
                    <textarea
                      value={commentBody}
                      onChange={(e) => setCommentBody(e.target.value)}
                      placeholder="Deja un comentario…"
                      rows={2}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); void addComment(); }
                      }}
                      className="block w-full resize-none bg-transparent px-3 pt-2.5 text-[13.5px] outline-none placeholder:text-faint"
                    />
                    <div className="flex items-center justify-end gap-2 px-2 pb-2">
                      <span className="text-[11px] text-faint">{MOD} ↵</span>
                      <Button size="icon-sm" variant="secondary" onClick={() => void addComment()} disabled={commentBusy || !commentBody.trim()} aria-label="Comentar">
                        {commentBusy ? <Loader2 className="animate-spin" /> : <Send />}
                      </Button>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </div>

          {/* ---- Panel de propiedades ---- */}
          <aside className="min-w-0 border-t bg-sidebar md:overflow-y-auto md:border-l md:border-t-0">
            <SideSection title="Propiedades">
              <PropRow label="Estado">
                <PropertyMenu title="Cambiar estado" shortcut="S" options={statusOptions} value={state} onSelect={(v) => { setState(v); autosave({ status: v }); }} triggerClassName={ROW} disabled={locked} {...menuProps('status')}>
                  {statusDisplay}
                </PropertyMenu>
              </PropRow>
              <PropRow label="Prioridad">
                <PropertyMenu title="Prioridad" shortcut="P" options={priorityOptions} value={priority} onSelect={(v) => { setPriority(v); autosave({ priority: v === NONE ? null : v }); }} triggerClassName={ROW} disabled={locked} {...menuProps('priority')}>
                  {priorityDisplay}
                </PropertyMenu>
              </PropRow>
              <PropRow label="Responsable">
                <PropertyMenu title="Asignar a" shortcut="A" options={assigneeOptions} values={assigneeValues} multi onSelect={pickAssignee} footer={assigneeFooter} triggerClassName={ROW} disabled={locked} align="end" {...menuProps('assignee')}>
                  {assigneeDisplay}
                </PropertyMenu>
              </PropRow>
              {assigneeIds.length > 1 && (
                <ul className="ml-[92px] grid gap-0.5 pb-1">
                  {assigneeIds.map((id, i) => (
                    <li key={id} className="group flex h-7 items-center gap-2 rounded-md px-2 text-[12.5px] hover:bg-panel">
                      <UserAvatar url={devById(id)?.avatarUrl ?? null} id={id} name={nameOfDev(id)} className={cn('size-4 shrink-0', i > 0 && 'opacity-60')} />
                      <span className="min-w-0 flex-1 truncate">{nameOfDev(id)}</span>
                      <span className="label-caps text-[10px]">{i === 0 ? 'Resp.' : 'Apoyo'}</span>
                      {i > 0 && !locked && (
                        <button type="button" onClick={() => promoteAssignee(id)} className="hidden rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:block" title="Hacer responsable" aria-label={`Hacer responsable a ${nameOfDev(id)}`}>
                          <ChevronUp className="size-3.5" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <PropRow label="Etiquetas">
                <PropertyMenu
                  title="Etiquetas"
                  shortcut="L"
                  options={labelOptions}
                  values={labels}
                  multi
                  onSelect={toggleLabel}
                  onCreate={(l) => { if (!labels.includes(l)) toggleLabel(l); }}
                  triggerClassName={cn(ROW, 'h-auto min-h-8 py-1')}
                  disabled={locked}
                  align="end"
                  {...menuProps('labels')}
                >
                  {labels.length ? (
                    <span className="flex min-w-0 flex-wrap gap-1">
                      {labels.map((l) => (
                        <span key={l} className="inline-flex items-center gap-1 rounded-full border bg-card px-1.5 py-px text-[11.5px]">
                          <LabelDot label={l} className="size-1.5" />{l}
                        </span>
                      ))}
                    </span>
                  ) : labelsDisplay}
                </PropertyMenu>
              </PropRow>
              <PropRow label="Proyecto">
                <PropertyMenu
                  title="Mover a proyecto"
                  options={projectOptions}
                  value={projectId}
                  onSelect={(v) => { if (v !== projectId) { setProjectId(v); autosave({ projectId: v }); } }}
                  triggerClassName={ROW}
                  disabled={locked}
                  align="end"
                  {...menuProps('project')}
                >
                  <ProjectIcon id={projectId} size="xs" className="size-4" />
                  <span className="truncate">{projectName ?? 'Sin proyecto'}</span>
                </PropertyMenu>
              </PropRow>
              <PropRow label="Estimación">
                <PropertyMenu title="Estimación" shortcut="E" options={estimateOptions} value={estimate} onSelect={(v) => { setEstimate(v); autosave({ estimate: v === NONE ? null : Number(v) }); }} footer="1 punto ≈ 2 h. La asignación automática lo usa para medir carga." triggerClassName={ROW} disabled={locked} align="end" {...menuProps('estimate')}>
                  {estimateDisplay}
                </PropertyMenu>
              </PropRow>
              <PropRow label="Fecha límite">
                <DueDateMenu
                  value={dueDate || null}
                  overdue={overdue}
                  onChange={(v) => { setDueDate(v ?? ''); autosave({ dueDate: v }); }}
                  triggerClassName={ROW}
                  disabled={locked}
                  shortcut="D"
                  {...menuProps('due')}
                />
              </PropRow>
              <PropRow label="Agenda">
                <ScheduleMenu date={schedDate} start={startTime} end={endTime} onChange={saveSchedule} triggerClassName={ROW} disabled={locked} {...menuProps('schedule')} />
              </PropRow>
              {solutionTypes.length > 0 && (
                <PropRow label="Tipo">
                  <PropertyMenu title="Tipo de solución" options={solutionOptions} value={solutionTypeId} onSelect={(v) => { setSolutionTypeId(v); autosave({ solutionTypeId: v === NONE ? null : v }); }} triggerClassName={ROW} disabled={locked} align="end" {...menuProps('solution')}>
                    {solutionDisplay}
                  </PropertyMenu>
                </PropRow>
              )}
            </SideSection>

            <SideSection title="Asignación">
              {t.createdBy && (
                <div className="flex items-center gap-1.5 px-2 text-[12.5px] text-muted-foreground">
                  <span>Asignada por</span>
                  <UserAvatar url={t.createdBy.avatarUrl} email={t.createdBy.email} name={t.createdBy.name} className="size-4" />
                  <span className="truncate font-medium text-foreground">{t.createdBy.name}</span>
                </div>
              )}
              <AutoAssignPanel
                task={t}
                enabled={!!filters.autoAssignEnabled && !locked}
                overrideLabels={Object.fromEntries((filters.overrideCategories ?? []).map((c) => [c.value, c.label]))}
                onTaskChange={onAutoAssignChange}
              />
            </SideSection>

            {codeSignal && (
              <SideSection title="Código">
                <div className="flex flex-wrap items-center gap-2 px-2">
                  {t.pr ? (
                    <a
                      href={t.pr.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 font-mono text-xs text-orange-ink hover:underline"
                      title={`${t.pr.repo} · PR #${t.pr.number}`}
                    >
                      <IntegrationIcon name="github" size="xs" /> #{t.pr.number}
                    </a>
                  ) : t.source === 'commit' ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><GitCommit className="size-3.5" /> commit</span>
                  ) : null}
                  {t.prState && (
                    <Badge variant={t.prState === 'merged' ? 'llm' : t.prState === 'closed' ? 'bad' : 'ok'} className="capitalize">
                      {t.prState === 'merged' ? <GitMerge className="size-3" /> : <GitPullRequest className="size-3" />}
                      {t.prState}
                    </Badge>
                  )}
                </div>
                {t.headRef && <span className="truncate px-2 font-mono text-[11px] text-muted-foreground" title={t.headRef}>{t.headRef}</span>}
                {!!t.reviewers?.length && (
                  <div className="flex items-center gap-2 px-2">
                    <span className="text-[12.5px] text-muted-foreground">Revisores</span>
                    <div className="flex -space-x-1.5">
                      {t.reviewers.slice(0, 5).map((r, i) => (
                        <GithubAvatar key={r.login ?? r.name ?? i} login={r.login} url={r.avatarUrl} id={r.devId} name={r.name} className={cn('size-5 ring-2', reviewRing(r.reviewState))} />
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-1 grid grid-cols-3 overflow-hidden rounded-md border bg-card text-center">
                  <EffortStat label="commits" value={String(t.effort?.commits ?? 0)} />
                  <EffortStat label="líneas" value={compact(t.effort?.lines ?? 0)} />
                  <EffortStat label="points" value={compact(t.effort?.points ?? 0)} accent />
                </div>
              </SideSection>
            )}
          </aside>
        </div>
      </DialogContent>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar esta tarea?</AlertDialogTitle>
            <AlertDialogDescription>
              Se eliminará <span className="font-medium">{t.identifier} · {t.name}</span>. Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={remove} disabled={busy}>
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <OverrideReasonDialog
        open={overridePrompt !== null}
        categories={filters.overrideCategories ?? []}
        chosenName={t.autoAssign?.chosenDevId ? nameOfDev(t.autoAssign.chosenDevId) : null}
        onConfirm={confirmOverride}
        onCancel={() => setOverridePrompt(null)}
      />
    </Dialog>
  );
}

/** Responsables de una tarea con el principal al frente. */
function currentAssignees(t: Ticket | null | undefined): string[] {
  if (!t) return [];
  return t.assignees?.length ? t.assignees.map((a) => a.id) : t.assignee ? [t.assignee.id] : [];
}

/** Miniatura de una imagen con su botón de quitar. */
function Thumb({ url, name, onRemove, size = 'size-24' }: { url: string; name: string; onRemove?: () => void; size?: string }) {
  return (
    <div className={cn('group relative shrink-0 overflow-hidden rounded-lg border bg-panel', size)}>
      <a href={url} target="_blank" rel="noreferrer" title={name}>
        <img src={url} alt={name} loading="lazy" className="size-full object-cover transition-transform group-hover:scale-105" />
      </a>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-scrim/70 text-white opacity-0 transition-opacity hover:bg-destructive focus:opacity-100 group-hover:opacity-100"
          aria-label={`Quitar ${name}`}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

function EffortStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={cn('border-l px-2 py-2 first:border-l-0', accent && 'bg-orange-soft')}>
      <div className={cn('text-[15px] font-semibold leading-none tracking-[-0.03em] tabular-nums', accent && 'text-orange-ink')}>{value}</div>
      <div className="label-caps mt-1 block text-[10px]">{label}</div>
    </div>
  );
}
