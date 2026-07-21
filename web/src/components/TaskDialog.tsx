import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Trash2, Send, ImagePlus, X, GitPullRequest, GitCommit, Loader2, GitMerge, Eye, Pencil, Check, ChevronsUpDown } from 'lucide-react';
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
  onSaved: () => void;
}) {
  const editing = !!task;

  const [title, setTitle] = useState('');
  const [spec, setSpec] = useState('');
  const [descMode, setDescMode] = useState<'view' | 'edit'>('edit'); // Vista (render) / Editar (textarea)
  const [projectId, setProjectId] = useState('');
  const [state, setState] = useState('backlog');
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

  // Adjuntos / galería (solo en edición).
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    if (task) {
      setTitle(task.title ?? '');
      setSpec(task.spec ?? '');
      setProjectId(task.projectId ?? '');
      setState(task.state || 'backlog');
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
      setTitle(''); setSpec(''); setProjectId(filters.allProjects[0]?.id ?? '');
      setState('backlog'); setPriority(NONE); setAssigneeIds([]);
      setSchedDate(defaultDate ?? ''); setStartTime('09:00'); setEndTime('10:00');
      setDueDate(''); setLabels('');
    }
    setCommentBody('');
    setComments([]);
    setAttachments([]);
    // Al abrir en edición con descripción → arranca en Vista; en alta o sin texto → Editar.
    setDescMode(task && (task.spec ?? '').trim() ? 'view' : 'edit');
  }, [open, task, defaultDate, filters.allProjects]);

  // Carga de comentarios + adjuntos al abrir en edición.
  useEffect(() => {
    if (!open || !task) return;
    let alive = true;
    apiGet<{ comments: TaskComment[] }>(`/tickets/${task.id}/comments`)
      .then((r) => alive && setComments(r.comments))
      .catch(() => {/* silencioso: panel secundario */});
    apiGet<{ attachments: Attachment[] }>(`/tickets/${task.id}/attachments`)
      .then((r) => alive && setAttachments(r.attachments))
      .catch(() => {/* silencioso */});
    return () => { alive = false; };
  }, [open, task]);

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
    const body = {
      title: title.trim(),
      spec: spec.trim() || null,
      state,
      priority: priority === NONE ? null : priority,
      assigneeDevIds: assigneeIds,
      scheduledStart,
      scheduledEnd,
      dueDate: dueDate || null,
      labels: labelList,
      ...(editing ? {} : { projectId }),
    };
    try {
      if (editing) {
        await apiSend<{ task: { id: string } }>('PATCH', `/tickets/${task!.id}`, body);
        toast.success('Tarea actualizada', { description: title.trim() });
      } else {
        const { task: created } = await apiSend<{ task: { id: string; identifier: string } }>('POST', '/tickets', body);
        toast.success('Tarea creada', { description: `${created.identifier} · ${title.trim()}` });
      }
      onOpenChange(false);
      onSaved();
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
      toast.success('Tarea eliminada', { description: task.title });
      onOpenChange(false);
      onSaved();
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
    if (!task || !files.length) return;
    const valid = files.filter((f) => {
      if (!f.type.startsWith('image/')) { toast.error('Solo se aceptan imágenes', { description: f.name }); return false; }
      if (f.size > MAX_BYTES) { toast.error('La imagen supera 4MB', { description: f.name }); return false; }
      return true;
    });
    if (!valid.length) return;
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

  function toggleAssignee(id: string) {
    setAssigneeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  // Avatar de un responsable: su propio avatar (de la lista de devs) o el del ticket. Sin fallback
  // al responsable primario (eso ponía el MISMO avatar a todos).
  const avatarFor = (id: string) =>
    (filters.devs ?? []).find((d) => d.id === id)?.avatarUrl
    ?? task?.assignees?.find((a) => a.id === id)?.avatarUrl
    ?? null;

  const projects = filters.allProjects ?? [];
  const states = filters.allStates ?? [];
  const priorities = filters.priorities ?? [];
  const devs = filters.devs ?? [];

  // ¿Hay señal de código para mostrar el panel de "Conexión con código"?
  const codeSignal = !!task && (!!task.pr || task.source === 'commit' || task.reviewers.length > 0 || task.effort.commits > 0);

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
                      ? <Markdown>{spec}</Markdown>
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
                    <p className="text-[11px] text-muted-foreground">Soporta Markdown.</p>
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
              <Section title="Detalles">
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
                      <Select value={state} onValueChange={setState}>
                        <SelectTrigger id="task-state"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {states.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="task-priority">Prioridad</Label>
                      <Select value={priority} onValueChange={setPriority}>
                        <SelectTrigger id="task-priority"><SelectValue placeholder="Sin prioridad" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>— Sin prioridad —</SelectItem>
                          {priorities.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label>Responsables</Label>
                    <Popover open={assigneeOpen} onOpenChange={setAssigneeOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
                          <span className={cn('truncate', assigneeIds.length === 0 && 'text-muted-foreground')}>
                            {assigneeIds.length === 0 ? 'Sin asignar' : `${assigneeIds.length} responsable${assigneeIds.length > 1 ? 's' : ''}`}
                          </span>
                          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-1">
                        <div className="scroll-thin max-h-56 overflow-y-auto">
                          {devs.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">Sin developers</p>}
                          {devs.map((d) => {
                            const active = assigneeIds.includes(d.id);
                            return (
                              <button
                                key={d.id}
                                type="button"
                                onClick={() => { toggleAssignee(d.id); setAssigneeOpen(false); }}
                                className={cn('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent', active && 'bg-accent/50')}
                              >
                                <span className={cn('grid size-4 shrink-0 place-items-center rounded border', active ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}>
                                  {active && <Check className="size-3" />}
                                </span>
                                <span className="truncate">{d.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      </PopoverContent>
                    </Popover>
                    {assigneeIds.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {assigneeIds.map((id) => {
                          const d = devs.find((x) => x.id === id);
                          return (
                            <span key={id} className="inline-flex items-center gap-1 rounded-full border bg-card py-0.5 pl-0.5 pr-1.5 text-xs">
                              <UserAvatar url={avatarFor(id)} name={d?.name ?? '?'} className="size-4" />
                              <span className="max-w-[9rem] truncate">{d?.name ?? id}</span>
                              <button type="button" onClick={() => toggleAssignee(id)} className="text-muted-foreground transition-colors hover:text-foreground" aria-label={`Quitar ${d?.name ?? ''}`}>
                                <X className="size-3" />
                              </button>
                            </span>
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
                    <Input id="task-date" type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} />
                    <div className="grid grid-cols-2 gap-2">
                      <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} disabled={!schedDate} aria-label="Hora de inicio" />
                      <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} disabled={!schedDate} aria-label="Hora de fin" />
                    </div>
                    <p className="text-xs text-muted-foreground">Sin fecha, la tarea vive en el backlog.</p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="task-due">Fecha límite</Label>
                      <Input id="task-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="task-labels">Etiquetas</Label>
                      <Input id="task-labels" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="bug, urgente" />
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

                    {task!.reviewers.length > 0 && (
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
                      <EffortStat label="commits" value={String(task!.effort.commits)} />
                      <EffortStat label="líneas" value={compact(task!.effort.lines)} />
                      <EffortStat label="points" value={compact(task!.effort.points)} accent />
                    </div>
                  </div>
                </Section>
              )}

              {editing && (
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
                    {attachments.length === 0 ? (
                      <button type="button" onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center gap-1 py-4 text-xs text-muted-foreground transition-colors hover:text-foreground">
                        <ImagePlus className="size-5" />
                        Arrastra imágenes o haz clic para subir
                        <span className="text-[10px]">PNG, JPG · máx 4MB</span>
                      </button>
                    ) : (
                      <div className="grid grid-cols-3 gap-2">
                        {attachments.map((a) => (
                          <div key={a.id} className="group relative aspect-square overflow-hidden rounded-md border bg-muted">
                            <a href={a.url} target="_blank" rel="noreferrer" title={a.name}>
                              <img src={a.url} alt={a.name} loading="lazy" className="size-full object-cover transition-transform group-hover:scale-105" />
                            </a>
                            <button
                              type="button"
                              onClick={() => removeAttachment(a)}
                              className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100"
                              aria-label={`Eliminar ${a.name}`}
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
                    )}
                  </div>
                </Section>
              )}
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
                    Se eliminará <span className="font-medium">{task!.identifier} · {task!.title}</span>. Esta acción no se puede deshacer.
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
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button onClick={save} disabled={busy || !title.trim()}>
              {busy ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear tarea'}
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
