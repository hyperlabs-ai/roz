import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Trash2, Send, ImagePlus, X, GitPullRequest, GitCommit, Loader2, GitMerge, Eye, Pencil, Check, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { UserAvatar } from '@/components/bits';
import { Markdown } from '@/components/Markdown';
import { apiGet, apiSend, apiUpload, type Ticket, type TicketFilterOptions, type Attachment } from '@/lib/api';
import { localDateStr, localTimeStr, toIso } from '@/lib/calendar';
import { htmlToMarkdown, looksLikeHtml } from '@/lib/rich-text';
import { relative, compact } from '@/lib/format';
import { cn } from '@/lib/utils';

const NONE = '__none__'; // centinela del Select para "sin valor"
const MAX_BYTES = 4 * 1024 * 1024; // debe coincidir con el límite del backend

interface TaskComment {
  id: string; authorId: string | null; authorName: string | null;
  body: string; mentions: string[]; createdAt: string;
}

// Anillo del avatar según el veredicto de review (igual que en Tickets).
function reviewRing(state: string | null | undefined): string {
  if (state === 'approved') return 'ring-success';
  if (state === 'changes_requested') return 'ring-warning';
  return 'ring-border';
}

/** Sección con encabezado, para agrupar el panel derecho del bento. */
function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border bg-muted/20 p-3">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

/**
 * Alta / edición de una tarea nativa de roz. Layout bento ancho: a la izquierda la descripción
 * grande + comentarios; a la derecha los metadatos, la conexión con código (solo lectura) y la
 * galería de imágenes (subida/borrado a Supabase Storage). Las fechas se arman de date + time
 * locales y se mandan como ISO. `defaultDate` (YYYY-MM-DD) precarga el día al crear del calendario.
 */
export function TaskDialog({
  open,
  onOpenChange,
  task,
  defaultDate,
  filters,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  task?: Ticket | null;
  defaultDate?: string;
  filters: TicketFilterOptions;
  /** Devuelve la tarea afectada (el backend responde la fila completa) para que la lista toque
   *  esa fila y nada más, en vez de recargarse entera. */
  onSaved: (task: Ticket, mode: 'created' | 'updated' | 'deleted') => void;
}) {
  const editing = !!task;

  const [title, setTitle] = useState('');
  const [spec, setSpec] = useState('');
  const [descMode, setDescMode] = useState<'view' | 'edit'>('edit'); // Vista (render) / Editar (textarea)
  const [projectId, setProjectId] = useState('');
  const [state, setState] = useState('planificada');
  const [priority, setPriority] = useState(NONE);
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [assigneeOpen, setAssigneeOpen] = useState(false); // popover de responsables
  const [schedDate, setSchedDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [dueDate, setDueDate] = useState('');
  const [labels, setLabels] = useState('');
  const [busy, setBusy] = useState(false);

  // Comentarios (solo en edición).
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);

  // Adjuntos / galería. En edición se suben al instante; en creación se encolan (pending) con
  // preview local y se suben después de crear la tarea (cuando ya existe su id).
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pending, setPending] = useState<{ file: File; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Fuente del formulario, leída por REF dentro del efecto de abajo. Va aparte porque el efecto
  // NO debe volver a correr cuando estos valores cambian de identidad: `task` es un objeto nuevo
  // cada vez que la lista se actualiza, y re-ejecutar el efecto reescribía el formulario encima de
  // lo que estabas escribiendo — de ahí la sensación de que la descripción "no se guardaba".
  const src = useRef({ task, defaultDate, projects: filters.allProjects });
  src.current = { task, defaultDate, projects: filters.allProjects };

  // Se resetea SOLO al abrir, o al cambiar de tarea (por id) con el modal ya abierto.
  useEffect(() => {
    if (!open) return;
    const { task, defaultDate, projects } = src.current;
    if (task) {
      setTitle(task.name ?? '');
      setSpec(task.description ?? '');
      setProjectId(task.projectId ?? '');
      setState(task.status || 'planificada');
      setPriority(task.priority ?? NONE);
      setAssigneeIds(task.assignees?.length ? task.assignees.map((a) => a.id) : task.assignee ? [task.assignee.id] : []);
      if (task.scheduledStart) {
        const s = new Date(task.scheduledStart);
        setSchedDate(localDateStr(s));
        setStartTime(localTimeStr(s));
        setEndTime(task.scheduledEnd ? localTimeStr(new Date(task.scheduledEnd)) : localTimeStr(new Date(s.getTime() + 3600_000)));
      } else {
        setSchedDate(''); setStartTime('09:00'); setEndTime('10:00');
      }
      setDueDate(task.dueDate ? task.dueDate.slice(0, 10) : '');
      setLabels((task.labels ?? []).join(', '));
    } else {
      setTitle(''); setSpec(''); setProjectId(projects[0]?.id ?? '');
      setState('planificada'); setPriority(NONE); setAssigneeIds([]);
      setSchedDate(defaultDate ?? ''); setStartTime('09:00'); setEndTime('10:00');
      setDueDate(''); setLabels('');
    }
    setCommentBody('');
    setComments([]);
    setAttachments([]);
    setPending((prev) => { prev.forEach((p) => URL.revokeObjectURL(p.url)); return []; });
    // Al abrir en edición con descripción → arranca en Vista; en alta o sin texto → Editar.
    setDescMode(task && (task.description ?? '').trim() ? 'view' : 'edit');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  // Carga de comentarios + adjuntos al abrir en edición. Por id, por lo mismo: la lista renueva el
  // objeto `task` y no hay que re-pedir comentarios ni imágenes por eso.
  const taskId = task?.id;
  useEffect(() => {
    if (!open || !task) return;
    let alive = true;
    // Se avisa si fallan. Antes eran catch vacíos, y el resultado era que un error del servidor se
    // veía igual que "no hay nada": las imágenes simplemente no aparecían y no había ninguna pista
    // de por qué. Un panel secundario puede degradar, pero no callar.
    apiGet<{ comments: TaskComment[] }>(`/tickets/${task.id}/comments`)
      .then((r) => alive && setComments(r.comments))
      .catch((e) => alive && toast.error('No se pudieron cargar los comentarios', { description: String(e?.message ?? e) }));
    apiGet<{ attachments: Attachment[] }>(`/tickets/${task.id}/attachments`)
      .then((r) => alive && setAttachments(r.attachments))
      .catch((e) => alive && toast.error('No se pudieron cargar las imágenes', { description: String(e?.message ?? e) }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId]);

  async function save() {
    if (!title.trim()) return;
    if (!editing && !projectId) {
      toast.error('Elige un proyecto');
      return;
    }
    setBusy(true);
    const scheduledStart = schedDate ? toIso(schedDate, startTime) : null;
    const scheduledEnd = schedDate ? toIso(schedDate, endTime) : null;
    const labelList = labels.split(',').map((s) => s.trim()).filter(Boolean);
    // Los nombres deben calzar con el schema del backend (TaskCreateBody / TaskPatchBody). Zod
    // hace strip de las claves que no reconoce, así que mandar `title`/`spec`/`state` — los
    // nombres previos a la migración 0020 — no daba error: descartaba nombre, descripción y
    // estado en silencio, y el guardado parecía funcionar sin cambiar nada.
    // En edición este botón guarda SOLO el texto: los detalles ya se guardaron al tocarlos (ver
    // `autosave`). En alta no hay fila que parchear, así que todo viaja junto en el POST.
    const body = editing
      ? { name: title.trim(), description: spec.trim() || null }
      : {
          name: title.trim(),
          description: spec.trim() || null,
          status: state,
          priority: priority === NONE ? null : priority,
          assigneeDevIds: assigneeIds,
          scheduledStart,
          scheduledEnd,
          dueDate: dueDate || null,
          labels: labelList,
          projectId,
        };
    try {
      if (editing) {
        const { task: saved } = await apiSend<{ task: Ticket }>('PATCH', `/tickets/${task!.id}`, body);
        toast.success('Tarea actualizada', { description: title.trim() });
        onOpenChange(false);
        onSaved(saved, 'updated');
      } else {
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
        onOpenChange(false);
        onSaved(created, 'created');
      }
    } catch (e: any) {
      toast.error(editing ? 'No se pudo guardar' : 'No se pudo crear', { description: String(e.message ?? e) });
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
    // Creación: aún no hay tarea → se encolan con preview local y se suben al guardar.
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

  /** Quita una imagen en cola (creación) y libera su preview. */
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
   * Autoguardado de los DETALLES (estado, prioridad, responsables, fechas, etiquetas).
   *
   * Este modal era un formulario entero: cambiabas responsables, cerrabas con Esc o clic fuera, y
   * se descartaba en silencio. La tabla, en cambio, guarda cada celda al tocarla. Convivían dos
   * comportamientos opuestos sin ninguna señal de cuál estabas usando, así que nunca sabías si un
   * cambio había quedado. Ahora los detalles se guardan igual que en la tabla; el título y la
   * descripción siguen con "Guardar" porque son texto largo y no quieres un PATCH por tecla.
   *
   * Encadenado, como en la lista: dos cambios seguidos sobre la misma tarea van en orden, no en
   * paralelo. Al crear no hace nada — todavía no hay fila que parchear y todo viaja en el POST.
   */
  const [autoBusy, setAutoBusy] = useState(0);
  const autoChain = useRef<Promise<void>>(Promise.resolve());
  const autosave = (body: Record<string, unknown>) => {
    if (!task) return;
    const id = task.id;
    setAutoBusy((n) => n + 1);
    autoChain.current = autoChain.current.then(async () => {
      try {
        // Se avisa al padre con la fila completa: la tabla de atrás se actualiza sola, sin recargar.
        onSaved((await apiSend<{ task: Ticket }>('PATCH', `/tickets/${id}`, body)).task, 'updated');
      } catch (e: any) {
        toast.error('No se pudo guardar', { description: String(e?.message ?? e) });
      } finally {
        setAutoBusy((n) => n - 1);
      }
    });
  };

  // Quitar conserva la posición del resto; agregar va al final (= apoyo). Nunca degrada al
  // responsable actual por accidente.
  function setAssignees(next: string[]) {
    setAssigneeIds(next);
    autosave({ assigneeDevIds: next });
  }
  function toggleAssignee(id: string) {
    setAssignees(assigneeIds.includes(id) ? assigneeIds.filter((x) => x !== id) : [...assigneeIds, id]);
  }
  /** Al frente = responsable. Es la única forma de cambiar quién saca la tarea sin vaciar la
   *  lista y volver a armarla en el orden correcto. */
  function promoteAssignee(id: string) {
    setAssignees([id, ...assigneeIds.filter((x) => x !== id)]);
  }
  /** La agenda son tres campos que viajan juntos, así que se recalcula el par completo. */
  function saveSchedule(date: string, start: string, end: string) {
    autosave({
      scheduledStart: date ? toIso(date, start) : null,
      scheduledEnd: date ? toIso(date, end) : null,
    });
  }
  // Avatar de un responsable: su propio avatar (de la lista de devs) o el del ticket. Sin fallback
  // al responsable primario (eso ponía el MISMO avatar a todos).
  const avatarFor = (id: string) =>
    (filters.devs ?? []).find((d) => d.id === id)?.avatarUrl
    ?? task?.assignees?.find((a) => a.id === id)?.avatarUrl
    ?? null;
  const nameOfDev = (id: string) =>
    (filters.devs ?? []).find((d) => d.id === id)?.name
    ?? task?.assignees?.find((a) => a.id === id)?.name
    ?? '—';

  const projects = filters.allProjects ?? [];
  const states = filters.allStates ?? [];
  const priorities = filters.priorities ?? [];
  const devs = filters.devs ?? [];

  // ¿Hay señal de código para mostrar el panel de "Conexión con código"?
  const codeSignal = !!task && (!!task.pr || task.source === 'commit' || !!task.reviewers?.length || !!task.effort?.commits);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl lg:max-w-5xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4 sm:px-6">
          <DialogTitle>{editing ? 'Editar tarea' : 'Nueva tarea'}</DialogTitle>
          <DialogDescription>
            {editing
              ? `${task!.identifier}${task!.projectName ? ` · ${task!.projectName}` : ''}`
              : 'Crea una tarea nativa: asígnala, agéndala en el calendario y dale prioridad.'}
          </DialogDescription>
        </DialogHeader>

        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            {/* ---- Izquierda: descripción grande + comentarios ---- */}
            <div className="flex min-w-0 flex-col gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="task-title">Título</Label>
                <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ej. Ajustar el webhook de PRs" autoFocus className="text-base" />
              </div>

              <div className="flex min-h-0 flex-1 flex-col space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="task-spec">Descripción</Label>
                  <div className="inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setDescMode('view')}
                      className={cn('inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors', descMode === 'view' ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                    >
                      <Eye className="size-3" /> Vista
                    </button>
                    <button
                      type="button"
                      onClick={() => setDescMode('edit')}
                      className={cn('inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors', descMode === 'edit' ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                    >
                      <Pencil className="size-3" /> Editar
                    </button>
                  </div>
                </div>
                {descMode === 'view' ? (
                  <div className="scroll-thin min-h-[200px] flex-1 overflow-y-auto rounded-md border border-input px-3 py-2">
                    {spec.trim()
                      ? <Markdown>{htmlToMarkdown(spec)}</Markdown>
                      : <p className="text-sm text-muted-foreground">Sin descripción</p>}
                  </div>
                ) : (
                  <>
                    <textarea
                      id="task-spec"
                      value={spec}
                      onChange={(e) => setSpec(e.target.value)}
                      placeholder="Contexto, criterios de aceptación, pasos para reproducir…"
                      className="scroll-thin min-h-[200px] w-full flex-1 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    {/* No se reescribe el HTML que viene de Ops: si el dev no toca la descripción,
                        su formato original se conserva intacto. Solo se avisa de qué está viendo. */}
                    <p className="text-[11px] text-muted-foreground">
                      {looksLikeHtml(spec)
                        ? 'Esta descripción se escribió en Ops (HTML). En "Vista" se ve con formato; si la editas aquí, se guardará tal cual la dejes.'
                        : 'Soporta Markdown.'}
                    </p>
                  </>
                )}
              </div>

              {editing && (
                <div className="space-y-2">
                  <Label>Comentarios {comments.length > 0 && <span className="text-muted-foreground">({comments.length})</span>}</Label>
                  <div className="space-y-2">
                    {comments.length === 0 && <p className="text-xs text-muted-foreground">Aún no hay comentarios.</p>}
                    {comments.map((c) => (
                      <div key={c.id} className="flex gap-2">
                        <UserAvatar url={null} name={c.authorName ?? '?'} className="mt-0.5 size-6 shrink-0" />
                        <div className="min-w-0 flex-1 rounded-lg bg-muted/50 px-3 py-2">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-xs font-medium">{c.authorName ?? 'Anónimo'}</span>
                            <span className="shrink-0 text-[11px] text-muted-foreground">{relative(c.createdAt)}</span>
                          </div>
                          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{c.body}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-end gap-2">
                    <textarea
                      value={commentBody}
                      onChange={(e) => setCommentBody(e.target.value)}
                      placeholder="Escribe un comentario…  (⌘/Ctrl + Enter)"
                      rows={2}
                      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addComment(); }}
                      className="flex w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <Button size="icon" variant="secondary" onClick={addComment} disabled={commentBusy || !commentBody.trim()} aria-label="Comentar">
                      {commentBusy ? <Loader2 className="animate-spin" /> : <Send />}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* ---- Derecha: metadatos + código + galería ---- */}
            <div className="flex min-w-0 flex-col gap-4">
              <Section
                title="Detalles"
                action={editing && (
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    {autoBusy > 0 ? <><Loader2 className="size-3 animate-spin" /> Guardando…</> : 'Se guarda solo'}
                  </span>
                )}
              >
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="task-project">Proyecto</Label>
                    <Select value={projectId} onValueChange={setProjectId} disabled={editing}>
                      <SelectTrigger id="task-project"><SelectValue placeholder="Selecciona" /></SelectTrigger>
                      <SelectContent>
                        {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="task-state">Estado</Label>
                      <Select value={state} onValueChange={(v) => { setState(v); autosave({ status: v }); }}>
                        <SelectTrigger id="task-state"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {states.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="task-priority">Prioridad</Label>
                      <Select value={priority} onValueChange={(v) => { setPriority(v); autosave({ priority: v === NONE ? null : v }); }}>
                        <SelectTrigger id="task-priority"><SelectValue placeholder="Sin prioridad" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>— Sin prioridad —</SelectItem>
                          {priorities.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Responsable vs apoyo. El ORDEN de esta lista es el dato: el backend toma el
                      primero como responsable (assignee_dev_id) y el resto queda como apoyo. Antes
                      eso no se veía por ningún lado — dos chips idénticos y "2 responsables" — así
                      que poner a alguien de apoyo dependía del orden en que hubieras hecho clic y
                      no había forma de saber si había funcionado, ni de corregirlo. */}
                  <div className="space-y-1.5">
                    <Label>Responsables</Label>
                    <Popover open={assigneeOpen} onOpenChange={setAssigneeOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
                          <span className={cn('truncate', assigneeIds.length === 0 && 'text-muted-foreground')}>
                            {assigneeIds.length === 0
                              ? 'Sin asignar'
                              : nameOfDev(assigneeIds[0]) + (assigneeIds.length > 1 ? ` · +${assigneeIds.length - 1} de apoyo` : '')}
                          </span>
                          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-1">
                        <div className="scroll-thin max-h-56 overflow-y-auto">
                          {devs.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">Sin developers</p>}
                          {/* El popover NO se cierra al elegir: armar un equipo son varios clics. */}
                          {devs.map((d) => {
                            const at = assigneeIds.indexOf(d.id);
                            const active = at >= 0;
                            return (
                              <button
                                key={d.id}
                                type="button"
                                onClick={() => toggleAssignee(d.id)}
                                className={cn('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent', active && 'bg-accent/50')}
                              >
                                <span className={cn('grid size-4 shrink-0 place-items-center rounded border', active ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}>
                                  {active && <Check className="size-3" />}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                                {active && (
                                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {at === 0 ? 'Responsable' : 'Apoyo'}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </PopoverContent>
                    </Popover>
                    {assigneeIds.length > 0 && (
                      <div className="space-y-1 pt-1">
                        {assigneeIds.map((id, i) => {
                          const d = devs.find((x) => x.id === id);
                          return (
                            <div key={id} className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-xs">
                              <UserAvatar url={avatarFor(id)} name={d?.name ?? '?'} className={cn('size-5 shrink-0', i > 0 && 'opacity-55')} />
                              <span className="min-w-0 flex-1 truncate">{d?.name ?? id}</span>
                              <span className={cn('shrink-0 text-[10px] uppercase tracking-wide', i === 0 ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                                {i === 0 ? 'Responsable' : 'Apoyo'}
                              </span>
                              {i > 0 && (
                                <button
                                  type="button"
                                  onClick={() => promoteAssignee(id)}
                                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                  title="Hacer responsable"
                                  aria-label={`Hacer responsable a ${d?.name ?? ''}`}
                                >
                                  <ChevronUp className="size-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => toggleAssignee(id)}
                                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                aria-label={`Quitar ${d?.name ?? ''}`}
                              >
                                <X className="size-3.5" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {/* Quién asignó: creador de la tarea (usuario del dashboard). Solo en edición. */}
                    {editing && task!.createdBy && (
                      <div className="flex items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
                        <span>Asignada por</span>
                        <UserAvatar url={task!.createdBy.avatarUrl} name={task!.createdBy.name} className="size-4" />
                        <span className="font-medium text-foreground">{task!.createdBy.name}</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="task-date">Agenda (calendario)</Label>
                    {/* Los inputs de fecha/hora solo emiten `change` con un valor COMPLETO (o
                        vacío), así que guardar en cada cambio no manda estados a medias. */}
                    <Input
                      id="task-date"
                      type="date"
                      value={schedDate}
                      onChange={(e) => { setSchedDate(e.target.value); saveSchedule(e.target.value, startTime, endTime); }}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        type="time"
                        value={startTime}
                        onChange={(e) => { setStartTime(e.target.value); saveSchedule(schedDate, e.target.value, endTime); }}
                        disabled={!schedDate}
                        aria-label="Hora de inicio"
                      />
                      <Input
                        type="time"
                        value={endTime}
                        onChange={(e) => { setEndTime(e.target.value); saveSchedule(schedDate, startTime, e.target.value); }}
                        disabled={!schedDate}
                        aria-label="Hora de fin"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">Sin fecha, la tarea vive en el backlog.</p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="task-due">Fecha límite</Label>
                      <Input
                        id="task-due"
                        type="date"
                        value={dueDate}
                        onChange={(e) => { setDueDate(e.target.value); autosave({ dueDate: e.target.value || null }); }}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="task-labels">Etiquetas</Label>
                      {/* Texto libre: guarda al salir del campo, no en cada tecla. Y solo si de
                          verdad cambiaron — tabular por el formulario no debe pegarle a la API. */}
                      <Input
                        id="task-labels"
                        value={labels}
                        onChange={(e) => setLabels(e.target.value)}
                        onBlur={() => {
                          const list = labels.split(',').map((s) => s.trim()).filter(Boolean);
                          const prev = task?.labels ?? [];
                          if (list.length !== prev.length || list.some((l, i) => l !== prev[i])) autosave({ labels: list });
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        placeholder="bug, urgente"
                      />
                    </div>
                  </div>
                </div>
              </Section>

              {codeSignal && (
                <Section title="Conexión con código">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {task!.pr ? (
                        <a
                          href={task!.pr.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 font-mono text-xs text-chart-1 hover:underline"
                          title={`${task!.pr.repo} · PR #${task!.pr.number}`}
                        >
                          <GitPullRequest className="size-3.5" /> #{task!.pr.number}
                        </a>
                      ) : task!.source === 'commit' ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><GitCommit className="size-3.5" /> commit</span>
                      ) : null}
                      {task!.prState && (
                        <Badge variant={task!.prState === 'merged' ? 'default' : task!.prState === 'closed' ? 'destructive' : 'success'} className="capitalize">
                          {task!.prState === 'merged' ? <GitMerge className="size-3" /> : <GitPullRequest className="size-3" />}
                          {task!.prState}
                        </Badge>
                      )}
                      {task!.headRef && <span className="truncate font-mono text-[11px] text-muted-foreground">{task!.headRef}</span>}
                    </div>

                    {!!task!.reviewers?.length && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Revisores</span>
                        <div className="flex -space-x-1.5">
                          {task!.reviewers.slice(0, 5).map((r, i) => (
                            <UserAvatar key={r.login ?? r.name ?? i} url={r.avatarUrl} name={r.name} className={cn('size-5 ring-2', reviewRing(r.reviewState))} title={`${r.name}${r.reviewState ? ` · ${r.reviewState}` : ''}`} />
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-3 gap-2 text-center">
                      <EffortStat label="commits" value={String(task!.effort?.commits ?? 0)} />
                      <EffortStat label="líneas" value={compact(task!.effort?.lines ?? 0)} />
                      <EffortStat label="points" value={compact(task!.effort?.points ?? 0)} accent />
                    </div>
                  </div>
                </Section>
              )}

              {/* Imágenes: disponible también AL CREAR (se encolan y suben tras crear la tarea). */}
              <Section
                title="Imágenes"
                action={
                  <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" onClick={() => fileRef.current?.click()} disabled={uploading}>
                    {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />} Agregar
                  </Button>
                }
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => { uploadFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }}
                />
                <div
                  onDragOver={(e) => { e.preventDefault(); setDropActive(true); }}
                  onDragLeave={() => setDropActive(false)}
                  onDrop={(e) => { e.preventDefault(); setDropActive(false); uploadFiles(Array.from(e.dataTransfer.files ?? [])); }}
                  className={cn('rounded-lg border-2 border-dashed p-2 transition-colors', dropActive ? 'border-primary bg-primary/5' : 'border-border')}
                >
                  {(() => {
                    const items = editing
                      ? attachments.map((a) => ({ key: a.id, url: a.url, name: a.name, remove: () => removeAttachment(a) }))
                      : pending.map((p) => ({ key: p.url, url: p.url, name: p.file.name, remove: () => removePending(p.url) }));
                    if (!items.length) {
                      return (
                        <button type="button" onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center gap-1 py-4 text-xs text-muted-foreground transition-colors hover:text-foreground">
                          <ImagePlus className="size-5" />
                          Arrastra imágenes o haz clic para subir
                          <span className="text-[10px]">PNG, JPG · máx 4MB</span>
                        </button>
                      );
                    }
                    return (
                      <div className="grid grid-cols-3 gap-2">
                        {items.map((it) => (
                          <div key={it.key} className="group relative aspect-square overflow-hidden rounded-md border bg-muted">
                            <a href={it.url} target="_blank" rel="noreferrer" title={it.name}>
                              <img src={it.url} alt={it.name} loading="lazy" className="size-full object-cover transition-transform group-hover:scale-105" />
                            </a>
                            <button
                              type="button"
                              onClick={it.remove}
                              className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100"
                              aria-label={`Eliminar ${it.name}`}
                            >
                              <X className="size-3.5" />
                            </button>
                          </div>
                        ))}
                        {uploading && (
                          <div className="grid aspect-square place-items-center rounded-md border bg-muted text-muted-foreground">
                            <Loader2 className="size-5 animate-spin" />
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </Section>
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t px-5 py-3 sm:justify-between sm:px-6">
          {editing ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" className="text-destructive hover:text-destructive" disabled={busy}>
                  <Trash2 /> Eliminar
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>¿Eliminar esta tarea?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Se eliminará <span className="font-medium">{task!.identifier} · {task!.name}</span>. Esta acción no se puede deshacer.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction className={cn('bg-destructive text-destructive-foreground hover:bg-destructive/90')} onClick={remove}>
                    Eliminar
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : <span />}
          <div className="flex items-center gap-2">
            {/* En edición ya no hay nada que "cancelar" salvo el texto: los detalles se guardaron
                al tocarlos, así que el botón dice lo que hace. */}
            <Button variant="outline" onClick={() => onOpenChange(false)}>{editing ? 'Cerrar' : 'Cancelar'}</Button>
            <Button onClick={save} disabled={busy || !title.trim()}>
              {busy ? 'Guardando…' : editing ? 'Guardar título y descripción' : 'Crear tarea'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EffortStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={cn('rounded-lg border p-2', accent ? 'border-primary/20 bg-primary/5' : 'bg-card')}>
      <div className={cn('text-lg font-bold leading-none tabular-nums', accent && 'text-primary')}>{value}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
