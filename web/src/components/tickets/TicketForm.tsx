import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from '@/lib/toast';
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, MessageSquare, Sparkles, Ticket as TicketIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { OverrideReasonDialog } from '@/components/tasks/OverrideReasonDialog';
import { ChosenWhy, ClassificationRows, DiscardedList } from '@/components/tasks/AutoAssignPanel';
import {
  apiSend,
  type TicketCorrections,
  type TicketCreateResponse,
  type TicketFilterOptions,
  type TicketPreviewResponse,
} from '@/lib/api';
import { SUGGESTION_LABEL, isOverrideRequired } from '@/lib/assign';
import { cn } from '@/lib/utils';

const NONE = '__none__';
/** Override automático cuando el responsable vino de una `@mención` (categoría cerrada del backend). */
const MENTION_OVERRIDE = { category: 'preferencia', note: 'Asignado con @mención en /ticket del chat' };
const textareaCls =
  'scroll-thin w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

type Phase = 'write' | 'thinking' | 'preview' | 'creating' | 'done';

/**
 * Ticket inteligente: la persona escribe SOLO lo crucial (nombre, proyecto, descripción) y roz
 * completa el resto con Jev — tipo de solución, skills, nivel, puntos y urgencia — y propone
 * responsable con la misma política de la asignación automática. Se revisa (y se corrige) antes de
 * crear. Al crear, la tarea queda asignada y el responsable recibe un DM desde el perfil de quien
 * pidió el ticket. Se usa en la página /app/ticket y en el modal de `/ticket` del chat.
 */
export function TicketForm({
  filters,
  initialTitle = '',
  initialProjectId,
  initialAssigneeId,
  onDone,
  onCancel,
  dense = false,
}: {
  filters: TicketFilterOptions;
  initialTitle?: string;
  initialProjectId?: string;
  /** Responsable elegido con `@persona` en el `/ticket` del chat: gana a la propuesta de roz y no
   *  pide motivo (la persona ya dijo a quién). */
  initialAssigneeId?: string;
  /** Se creó el ticket (el modal del chat se cierra con esto). */
  onDone?: (r: TicketCreateResponse) => void;
  onCancel?: () => void;
  /** Versión compacta (modal). */
  dense?: boolean;
}) {
  const projects = filters.allProjects ?? [];
  const [title, setTitle] = useState(initialTitle);
  const [projectId, setProjectId] = useState(
    initialProjectId && projects.some((p) => p.id === initialProjectId) ? initialProjectId : '',
  );
  const [description, setDescription] = useState('');
  const [phase, setPhase] = useState<Phase>('write');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TicketPreviewResponse | null>(null);
  // Texto con el que se hizo la vista previa: si la persona lo edita después, hay que volver a leerlo.
  const [previewedText, setPreviewedText] = useState<{ title: string; projectId: string; description: string } | null>(null);
  const [corrections, setCorrections] = useState<TicketCorrections>({});
  // Responsable por `@mención` (solo si es un dev que existe en las opciones).
  const mentioned = initialAssigneeId && (filters.devs ?? []).some((d) => d.id === initialAssigneeId) ? initialAssigneeId : undefined;
  // undefined = lo que propone roz; null = sin responsable; string = alguien elegido a mano.
  const [assignee, setAssignee] = useState<string | null | undefined>(mentioned);
  const [askReason, setAskReason] = useState(false);
  const [result, setResult] = useState<TicketCreateResponse | null>(null);

  const devs = filters.devs ?? [];
  const types = (filters.solutionTypes ?? []).filter((t) => t.active);
  const points = filters.estimatePoints ?? [1, 2, 3, 5, 8, 13];
  const priorities = filters.priorities ?? [];
  const nameOf = (id: string | null | undefined) =>
    id ? preview?.devNames[id] ?? devs.find((d) => d.id === id)?.name ?? '—' : '—';

  const textChanged =
    !!previewedText &&
    (previewedText.title !== title.trim() || previewedText.projectId !== projectId || previewedText.description !== description.trim());
  const canPreview = !!title.trim() && !!projectId && phase !== 'thinking' && phase !== 'creating';
  const finalAssignee = assignee === undefined ? preview?.chosenDevId ?? null : assignee;

  async function runPreview(next: TicketCorrections = corrections, reuse = true) {
    setError(null);
    setPhase('thinking');
    try {
      const body = {
        title: title.trim(),
        projectId,
        description: description.trim(),
        previewId: reuse && !textChanged ? preview?.previewId ?? null : null,
        corrections: next,
      };
      const r = await apiSend<TicketPreviewResponse>('POST', '/ticket/preview', body);
      setPreview(r);
      setPreviewedText({ title: body.title, projectId, description: body.description });
      setCorrections(next);
      // Si la propuesta de roz cambió, la elección manual previa deja de tener sentido salvo que
      // siga siendo distinta a propósito: se respeta solo si la persona ya eligió a alguien.
      setPhase('preview');
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setPhase(preview ? 'preview' : 'write');
    }
  }

  function correct(patch: TicketCorrections) {
    // Corregir no vuelve a llamar a Jev: el backend reusa su respuesta y recalcula la propuesta.
    void runPreview({ ...corrections, ...patch });
  }

  async function create(override?: { category: string; note: string | null }) {
    if (!preview) return;
    setError(null);
    setPhase('creating');
    try {
      const r = await apiSend<TicketCreateResponse>('POST', '/ticket', {
        title: title.trim(),
        projectId,
        description: description.trim(),
        previewId: preview.previewId,
        corrections,
        assigneeDevId: finalAssignee,
        ...(override ? { override } : {}),
      });
      setResult(r);
      setPhase('done');
      toast.success(`${r.identifier} creada`, {
        description: finalAssignee ? `Asignada a ${nameOf(finalAssignee)}${r.messageSent ? ' · le mandé un mensaje' : ''}` : 'Sin responsable',
      });
      onDone?.(r);
    } catch (e: any) {
      if (isOverrideRequired(e)) {
        setPhase('preview');
        setAskReason(true);
        return;
      }
      const code = (e as { code?: string })?.code;
      if (code === 'PREVIEW_STALE') {
        toast.message('El ticket cambió: vuelvo a leerlo');
        await runPreview(corrections, false);
        return;
      }
      setError(String(e?.message ?? e));
      setPhase('preview');
    }
  }

  function onCreateClick() {
    if (!preview) return;
    // Elegido con `@persona` en el chat: el motivo ya está dicho. Queda registrado como preferencia
    // del equipo (sirve igual para que roz aprenda) sin interrumpir con el diálogo.
    if (mentioned && finalAssignee === mentioned && preview.chosenDevId && finalAssignee !== preview.chosenDevId) {
      void create(MENTION_OVERRIDE);
      return;
    }
    // Cambiar al que propuso roz pide motivo (lo mismo que corregir una asignación automática).
    if (preview.chosenDevId && finalAssignee !== preview.chosenDevId) {
      setAskReason(true);
      return;
    }
    void create();
  }

  function reset() {
    setTitle('');
    setDescription('');
    setPreview(null);
    setPreviewedText(null);
    setCorrections({});
    setAssignee(undefined);
    setResult(null);
    setError(null);
    setPhase('write');
  }

  // ---------------------------------------------------------------- listo
  if (phase === 'done' && result) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="min-w-0 space-y-1 text-sm">
            <p className="font-medium">
              {result.identifier} creada{finalAssignee ? <> y asignada a {nameOf(finalAssignee)}</> : ' sin responsable'}
            </p>
            {finalAssignee && (
              <p className="text-muted-foreground">
                {result.messageSent
                  ? 'Le mandé un mensaje desde tu perfil: «Te asigné una nueva tarea».'
                  : 'No se mandó el mensaje (te la asignaste tú, o el chat no respondió); igual le llega el aviso de asignación.'}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {result.task && (
            <Button asChild variant="outline" size="sm">
              <Link to={`/app/tasks?task=${result.task.id}`}>
                <TicketIcon className="size-4" /> Ver la tarea
              </Link>
            </Button>
          )}
          {result.conversationId && (
            <Button asChild variant="outline" size="sm">
              <Link to={`/app/chat/${result.conversationId}`}>
                <MessageSquare className="size-4" /> Ver el mensaje
              </Link>
            </Button>
          )}
          <Button size="sm" onClick={reset}>
            Crear otro
          </Button>
        </div>
      </div>
    );
  }

  const c = preview?.classification ?? null;
  const chosen = preview?.candidates.find((x) => x.status === 'elegido') ?? null;
  const alternatives = preview?.candidates.filter((x) => x.status === 'alternativa') ?? [];
  const discarded = preview?.candidates.filter((x) => x.status === 'descartado') ?? [];
  const priorityValue = corrections.priority ?? c?.suggestedPriority ?? 'medium';
  const busy = phase === 'thinking' || phase === 'creating';

  return (
    <div className={cn('grid gap-6', !dense && preview && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]')}>
      {/* ---------------------------------------------------------- lo que escribe la persona */}
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="ticket-title">Nombre</Label>
          <Input
            id="ticket-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ej. El checkout no cobra con tarjeta"
            autoFocus={!initialTitle}
            maxLength={200}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ticket-project">Proyecto</Label>
          <Select value={projectId || NONE} onValueChange={(v) => setProjectId(v === NONE ? '' : v)}>
            <SelectTrigger id="ticket-project">
              <SelectValue placeholder="Elige el proyecto" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE} disabled>
                Elige el proyecto
              </SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ticket-description">Descripción</Label>
          <textarea
            id="ticket-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Qué pasa o qué se necesita, dónde y para quién. roz deduce el tipo de trabajo, las skills, el tamaño y la urgencia."
            rows={dense ? 5 : 8}
            autoFocus={!!initialTitle}
            className={textareaCls}
            maxLength={8000}
          />
        </div>

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {(!preview || textChanged) && (
            <Button onClick={() => runPreview(corrections, false)} disabled={!canPreview}>
              {phase === 'thinking' ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {preview ? 'Volver a leer' : 'Previsualizar'}
            </Button>
          )}
          {onCancel && (
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              Cancelar
            </Button>
          )}
          {phase === 'thinking' && !preview && <span className="text-xs text-muted-foreground">roz está leyendo el ticket…</span>}
          {textChanged && <span className="text-xs text-muted-foreground">Cambiaste el texto: vuelve a leerlo antes de crear.</span>}
        </div>
      </div>

      {/* ---------------------------------------------------------- lo que completa roz */}
      {preview && c && (
        <div className={cn('space-y-4 text-sm', textChanged && 'pointer-events-none opacity-50')}>
          <section className="space-y-3 rounded-lg border bg-card p-4">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Sparkles className="size-3.5" /> Cómo lo entendió roz
              {phase === 'thinking' && <Loader2 className="size-3.5 animate-spin" />}
            </h3>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="ticket-type" className={cn(c.typeState === 'incierto' && 'text-warning')}>
                  Tipo de solución
                </Label>
                <Select
                  value={corrections.solutionTypeId ?? c.solutionType?.id ?? NONE}
                  onValueChange={(v) => correct({ solutionTypeId: v === NONE ? null : v })}
                  disabled={busy}
                >
                  <SelectTrigger id="ticket-type" className={cn(c.typeState === 'incierto' && 'border-warning')}>
                    <SelectValue placeholder="Elige el tipo" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>
                      {c.typeState === 'ninguno' && !corrections.solutionTypeId ? 'Ninguno (no es trabajo técnico)' : '— Que roz lo deduzca —'}
                    </SelectItem>
                    {types.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {c.typeState === 'incierto' && (
                  <p className="text-xs text-warning">roz no está seguro de qué clase de trabajo es: elige el tipo.</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ticket-points">Puntos</Label>
                <Select value={String(corrections.points ?? c.points)} onValueChange={(v) => correct({ points: Number(v) })} disabled={busy}>
                  <SelectTrigger id="ticket-points">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {points.map((p) => (
                      <SelectItem key={p} value={String(p)}>
                        {p} {p === 1 ? 'punto' : 'puntos'} · ≈ {p * 2} h
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ticket-priority">Prioridad</Label>
                <Select value={priorityValue} onValueChange={(v) => correct({ priority: v })} disabled={busy}>
                  <SelectTrigger id="ticket-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {priorities.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="ticket-due">Fecha límite (opcional)</Label>
                <Input
                  id="ticket-due"
                  type="date"
                  value={corrections.dueDate ?? ''}
                  onChange={(e) => correct({ dueDate: e.target.value || null })}
                  disabled={busy}
                />
              </div>
            </div>

            <div className="space-y-1 border-t pt-3 text-xs">
              <ClassificationRows c={c} />
            </div>
          </section>

          <section className="space-y-3 rounded-lg border bg-card p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Responsable</h3>

            {preview.outcome === 'escalated' ? (
              <div className="space-y-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                <p className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="size-3.5 text-warning" /> roz no encontró a quién asignarlo
                  {preview.suggestion && (
                    <span className="font-normal text-muted-foreground">
                      · {SUGGESTION_LABEL[preview.suggestion.suggested] ?? preview.suggestion.suggested}
                    </span>
                  )}
                </p>
                <ul className="space-y-1">
                  {(preview.suggestion?.options ?? []).map((o, i) => (
                    <li key={i} className={cn(i === 0 ? 'text-foreground' : 'text-muted-foreground')}>
                      <span className="font-medium">{SUGGESTION_LABEL[o.kind] ?? o.kind}:</span> {o.detail}
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground">Elige a alguien abajo, o créalo sin responsable.</p>
              </div>
            ) : (
              chosen && (
                <div className="space-y-1.5 text-xs">
                  <p className="text-sm">
                    roz propone a <span className="font-semibold">{chosen.name}</span>
                  </p>
                  <ChosenWhy chosen={chosen} tieBreaks={preview.tieBreaks} name={nameOf} />
                </div>
              )
            )}

            {alternatives.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">También caben:</span>
                {alternatives.map((a) => (
                  <button
                    key={a.devId}
                    type="button"
                    onClick={() => setAssignee(a.devId)}
                    className={cn(
                      'rounded-full border px-2 py-0.5 transition-colors hover:bg-muted',
                      finalAssignee === a.devId && 'border-primary bg-primary/10 text-primary',
                    )}
                  >
                    {a.name}
                  </button>
                ))}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="ticket-assignee">Asignar a</Label>
              <Select value={finalAssignee ?? NONE} onValueChange={(v) => setAssignee(v === NONE ? null : v)} disabled={busy}>
                <SelectTrigger id="ticket-assignee">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Sin responsable</SelectItem>
                  {devs.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                      {d.id === preview.chosenDevId ? ' (propuesta de roz)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {mentioned && finalAssignee === mentioned ? (
                <p className="text-xs text-muted-foreground">Elegido con @mención en el chat.</p>
              ) : (
                preview.chosenDevId &&
                finalAssignee !== preview.chosenDevId && (
                  <p className="text-xs text-muted-foreground">Al crear te pregunto por qué cambias la propuesta de roz (ayuda a que aprenda).</p>
                )
              )}
            </div>

            {discarded.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer select-none text-muted-foreground">
                  Descartados ({discarded.length})
                </summary>
                <div className="mt-1.5">
                  <DiscardedList candidates={discarded} />
                </div>
              </details>
            )}
          </section>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onCreateClick} disabled={busy || textChanged}>
              {phase === 'creating' ? <Loader2 className="size-4 animate-spin" /> : <TicketIcon className="size-4" />}
              Crear ticket
            </Button>
            {!dense && (
              <Button variant="ghost" onClick={reset} disabled={busy}>
                <ArrowLeft className="size-4" /> Empezar de nuevo
              </Button>
            )}
            <span className="text-[11px] text-muted-foreground">
              {preview.jevModel ?? 'roz'}
              {preview.reused ? ' · sin volver a leer' : ''}
            </span>
          </div>
        </div>
      )}

      <OverrideReasonDialog
        open={askReason}
        categories={filters.overrideCategories ?? []}
        chosenName={preview?.chosenDevId ? nameOf(preview.chosenDevId) : null}
        onCancel={() => setAskReason(false)}
        onConfirm={(category, note) => {
          setAskReason(false);
          void create({ category, note });
        }}
      />
    </div>
  );
}

/** Hook chico para saber si el formulario puede usarse (hay TypeSafe y proyectos). */
export function useTicketReady(filters: TicketFilterOptions | null | undefined) {
  return useMemo(() => {
    if (!filters) return { ready: false, reason: null as string | null };
    if (!filters.autoAssignEnabled) return { ready: false, reason: 'Los tickets inteligentes necesitan TypeSafe (falta TYPESAFE_API_KEY en el servidor).' };
    if (!(filters.allProjects ?? []).length) return { ready: false, reason: 'No hay proyectos activos.' };
    return { ready: true, reason: null };
  }, [filters]);
}
