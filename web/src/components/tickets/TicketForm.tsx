import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toast } from '@/lib/toast';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, MessageSquare, Bot, RotateCcw, Shapes, Gauge,
  UserRound, Ticket as TicketIcon, Brain, ListChecks, UserCheck,
} from 'lucide-react';
import { IntegrationIcon } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Disclosure, UserAvatar } from '@/components/bits';
import { OverrideReasonDialog } from '@/components/tasks/OverrideReasonDialog';
import { ChosenWhy, ClassificationRows, DiscardedList } from '@/components/tasks/AutoAssignPanel';
import { DueDateMenu, Kbd, PILL, PriorityIcon, PropertyMenu, useAutosize, type PropOption } from '@/components/tasks/properties';
import {
  apiSend,
  type TicketCorrections,
  type TicketCreateResponse,
  type TicketFilterOptions,
  type TicketPreviewResponse,
} from '@/lib/api';
import { SUGGESTION_LABEL, isOverrideRequired } from '@/lib/assign';
import { PRIO_LABEL } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { ProjectIcon } from '@/components/avatars';

const NONE = '__none__';
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

type Phase = 'write' | 'thinking' | 'preview' | 'creating' | 'done';

/**
 * Ticket inteligente, con el lenguaje del modal de tareas (Linear): breadcrumb con el proyecto,
 * título y descripción sin borde y, cuando roz ya lo leyó, una fila de píldoras con lo que dedujo
 * (tipo, puntos, prioridad, fecha y responsable) que se corrigen ahí mismo. El "porqué" de roz va
 * aparte: columna derecha en la página, plegado en el modal del chat.
 *
 * Flujo: escribir → Previsualizar (Jev clasifica y propone responsable) → corregir → Crear. Al
 * crear, la tarea queda asignada y el responsable recibe un DM desde el perfil de quien la pidió.
 * Ctrl/⌘+Enter hace el siguiente paso (leer o crear).
 */
export function TicketForm({
  filters,
  initialTitle = '',
  initialProjectId,
  onDone,
  onCancel,
  dense = false,
}: {
  filters: TicketFilterOptions;
  initialTitle?: string;
  initialProjectId?: string;
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
  // undefined = lo que propone roz; null = sin responsable; string = alguien elegido a mano.
  const [assignee, setAssignee] = useState<string | null | undefined>(undefined);
  const [askReason, setAskReason] = useState(false);
  const [result, setResult] = useState<TicketCreateResponse | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [projectMenu, setProjectMenu] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  useAutosize(titleRef, title);

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
    setWhyOpen(false);
    setPhase('write');
    setTimeout(() => titleRef.current?.focus(), 0);
  }

  const busy = phase === 'thinking' || phase === 'creating';
  const needsRead = !preview || textChanged;

  /** Siguiente paso: leer (si no hay vista previa o cambió el texto) o crear. */
  function next() {
    if (busy) return;
    if (needsRead) {
      if (!projectId) {
        setProjectMenu(true);
        return;
      }
      if (canPreview) void runPreview(corrections, false);
    } else {
      onCreateClick();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      next();
    }
  }

  // ---------------------------------------------------------------- listo
  if (phase === 'done' && result) {
    return (
      <div className={cn('grid gap-4', !dense && 'rounded-xl border bg-card p-5 sm:p-6')}>
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-green-soft text-green"><CheckCircle2 className="size-5" /></span>
          <div className="min-w-0 space-y-1 text-sm">
            <p className="text-[15px] font-semibold tracking-[-0.01em]">
              <span className="font-mono text-[13px] text-muted-foreground">{result.identifier}</span>{' '}
              creada{finalAssignee ? <> y asignada a {nameOf(finalAssignee)}</> : ' sin responsable'}
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
        {/* Linear como fuente de verdad: lo que no se pudo mapear no frena la creación, pero se avisa. */}
        {result.linear && result.linear.warnings.length > 0 && (
          <div className="flex items-start gap-2.5 rounded-lg border border-yellow/40 bg-yellow-soft p-3 text-sm text-yellow-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 space-y-1">
              <p className="font-medium">Se creó en Linear, pero revisa esto allá:</p>
              <ul className="list-disc space-y-0.5 pl-4">
                {result.linear.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2 border-t pt-4">
          {result.linear?.url && (
            <Button asChild variant="outline" size="sm">
              <a href={result.linear.url} target="_blank" rel="noreferrer">
                <IntegrationIcon name="linear" size="xs" title="" /> Abrir en Linear
              </a>
            </Button>
          )}
          {result.task && !result.linear && (
            <Button asChild variant="outline" size="sm">
              <Link to={`/tareas?task=${result.task.id}`}><TicketIcon className="size-4" /> Ver la tarea</Link>
            </Button>
          )}
          {result.conversationId && (
            <Button asChild variant="outline" size="sm">
              <Link to={`/chat/${result.conversationId}`}><MessageSquare className="size-4" /> Ver el mensaje</Link>
            </Button>
          )}
          <Button size="sm" className="ml-auto" onClick={reset}>Crear otro</Button>
        </div>
      </div>
    );
  }

  const c = preview?.classification ?? null;
  const chosen = preview?.candidates.find((x) => x.status === 'elegido') ?? null;
  const alternatives = preview?.candidates.filter((x) => x.status === 'alternativa') ?? [];
  const discarded = preview?.candidates.filter((x) => x.status === 'descartado') ?? [];
  const priorityValue = corrections.priority ?? c?.suggestedPriority ?? 'medium';
  const typeValue = corrections.solutionTypeId !== undefined ? corrections.solutionTypeId ?? NONE : c?.solutionType?.id ?? NONE;
  const pointsValue = String(corrections.points ?? c?.points ?? '');
  const projectName = projects.find((p) => p.id === projectId)?.name ?? null;

  // ---- Opciones de las píldoras ----
  const projectOptions: PropOption[] = projects.map((p) => ({ value: p.id, label: p.name, icon: <ProjectIcon id={p.id} size="xs" className="size-4" /> }));
  const typeOptions: PropOption[] = [
    { value: NONE, label: c?.typeState === 'ninguno' && !corrections.solutionTypeId ? 'Ninguno (no es trabajo técnico)' : 'Que roz lo deduzca', icon: <Bot className="text-purple-deep" /> },
    ...types.map((t) => ({ value: t.id, label: t.name, icon: <Shapes className="text-muted-foreground" /> })),
  ];
  const pointOptions: PropOption[] = points.map((p) => ({ value: String(p), label: `${p} ${p === 1 ? 'punto' : 'puntos'}`, hint: `≈ ${p * 2} h`, icon: <Gauge className="text-muted-foreground" /> }));
  const priorityOptions: PropOption[] = priorities.map((p) => ({ value: p.value, label: p.label, icon: <PriorityIcon value={p.value} /> }));
  const assigneeOptions: PropOption[] = [
    { value: NONE, label: 'Sin responsable', icon: <UserRound className="text-muted-foreground" /> },
    ...devs.map((d, i) => ({
      value: d.id,
      label: d.name,
      divider: i === 0,
      icon: <UserAvatar url={d.avatarUrl} id={d.id} name={d.name} className="size-4" />,
      hint: d.id === preview?.chosenDevId ? 'propuesta de roz' : alternatives.some((a) => a.devId === d.id) ? 'también cabe' : undefined,
    })),
  ];
  const typeName = types.find((t) => t.id === typeValue)?.name ?? c?.solutionType?.name ?? null;
  const uncertainType = c?.typeState === 'incierto' && !corrections.solutionTypeId;

  // ---------------------------------------------------------------- compositor
  const renderComposer = (beforeFooter?: ReactNode) => (
    <div
      onKeyDown={onKeyDown}
      className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden', !dense && 'min-h-[420px] rounded-xl border bg-card')}
    >
      {/* Breadcrumb: proyecto › Ticket inteligente */}
      <div className={cn('flex h-12 shrink-0 items-center gap-1.5 px-4', dense && 'pr-14')}>
        <PropertyMenu
          title="Elige el proyecto"
          options={projectOptions}
          value={projectId}
          onSelect={setProjectId}
          triggerClassName={cn(PILL, 'border-transparent bg-panel hover:bg-toggle-off/60', !projectId && 'text-muted-foreground')}
          triggerLabel="Proyecto"
          open={projectMenu}
          onOpenChange={setProjectMenu}
          disabled={busy}
        >
          {projectId ? <ProjectIcon id={projectId} size="xs" className="size-4" /> : <Shapes className="text-muted-foreground" />}
          <span className="truncate">{projectName ?? 'Elige proyecto'}</span>
        </PropertyMenu>
        <ChevronRight className="size-3.5 shrink-0 text-faint" />
        <span className="truncate text-[13px] font-medium text-muted-foreground">Ticket inteligente</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5">
        <textarea
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); descRef.current?.focus(); } }}
          rows={1}
          maxLength={200}
          autoFocus={!initialTitle}
          placeholder="Qué hay que resolver"
          aria-label="Nombre"
          className="block w-full resize-none overflow-hidden bg-transparent pt-1 text-[21px] font-semibold leading-snug tracking-[-0.025em] outline-none placeholder:text-faint"
        />
        <textarea
          ref={descRef}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={dense ? 4 : 7}
          maxLength={8000}
          autoFocus={!!initialTitle}
          placeholder="Agrega una descripción… qué pasa o qué se necesita, dónde y para quién."
          aria-label="Descripción"
          className="mt-2 block min-h-[96px] w-full flex-1 resize-none bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-faint"
        />
      </div>

      {/* Lo que dedujo roz, corregible en píldoras */}
      {preview && c && (
        <div className={cn('flex shrink-0 flex-wrap items-center gap-1.5 px-4 pb-3 pt-2', textChanged && 'pointer-events-none opacity-50')}>
          <PropertyMenu title="Tipo de solución" options={typeOptions} value={typeValue} onSelect={(v) => correct({ solutionTypeId: v === NONE ? null : v })} disabled={busy} triggerClassName={cn(PILL, uncertainType && 'border-warning text-warning')}>
            {uncertainType ? <AlertTriangle /> : <Shapes className="text-muted-foreground" />}
            <span className="truncate">{uncertainType ? 'Elige el tipo' : typeName ?? 'Sin tipo'}</span>
          </PropertyMenu>
          <PropertyMenu title="Puntos" options={pointOptions} value={pointsValue} onSelect={(v) => correct({ points: Number(v) })} disabled={busy} footer="1 punto ≈ 2 h.">
            <Gauge className="text-muted-foreground" />
            <span className="truncate">{pointsValue} {pointsValue === '1' ? 'punto' : 'puntos'}</span>
          </PropertyMenu>
          <PropertyMenu title="Prioridad" options={priorityOptions} value={priorityValue} onSelect={(v) => correct({ priority: v })} disabled={busy}>
            <PriorityIcon value={priorityValue} className="size-3.5" />
            <span className="truncate">{priorities.find((p) => p.value === priorityValue)?.label ?? PRIO_LABEL[priorityValue] ?? priorityValue}</span>
          </PropertyMenu>
          <DueDateMenu value={corrections.dueDate ?? null} onChange={(v) => correct({ dueDate: v })} disabled={busy} />
          <PropertyMenu
            title="Asignar a"
            options={assigneeOptions}
            value={finalAssignee ?? NONE}
            onSelect={(v) => setAssignee(v === NONE ? null : v)}
            disabled={busy}
            footer={preview.chosenDevId ? 'Si cambias la propuesta de roz, al crear te pregunto por qué.' : undefined}
            triggerClassName={cn(PILL, preview.chosenDevId && finalAssignee !== preview.chosenDevId && 'border-yellow/60')}
          >
            {finalAssignee ? (
              <>
                <UserAvatar url={devs.find((d) => d.id === finalAssignee)?.avatarUrl ?? null} id={finalAssignee} name={nameOf(finalAssignee)} className="size-4" />
                <span className="truncate">{nameOf(finalAssignee)}</span>
                {finalAssignee === preview.chosenDevId && <Bot className="text-purple-deep" />}
              </>
            ) : (
              <><UserRound className="text-muted-foreground" /><span className="truncate text-muted-foreground">Sin responsable</span></>
            )}
          </PropertyMenu>
        </div>
      )}

      {(error || textChanged) && (
        <div className="px-4 pb-2">
          {error && <p className="rounded-md bg-red-soft px-3 py-2 text-xs text-red">{error}</p>}
          {textChanged && !error && (
            <p className="rounded-md border border-yellow/40 bg-yellow-soft px-3 py-2 text-xs text-yellow-ink">Cambiaste el texto: vuelve a leerlo antes de crear.</p>
          )}
        </div>
      )}

      {beforeFooter}

      {/* Pie */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-sidebar px-4 py-2.5">
        {phase === 'thinking' ? (
          <span className="inline-flex items-center gap-2 rounded-md bg-lavender px-2 py-1 text-xs text-purple-deep">
            <span className="size-2 animate-pulse rounded-full bg-purple-deep" />roz está leyendo el ticket…
          </span>
        ) : preview && !textChanged ? (
          <span className="label-caps text-faint">{preview.jevModel ?? 'roz'}{preview.reused ? ' · sin volver a leer' : ''}</span>
        ) : (
          <span className="hidden items-center gap-1.5 text-[12px] text-muted-foreground sm:inline-flex">
            <Bot className="size-3.5 text-purple-deep" /> roz deduce tipo, skills, tamaño y urgencia
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {onCancel && <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancelar</Button>}
          {preview && !dense && (
            <Button variant="ghost" onClick={reset} disabled={busy} className="text-muted-foreground"><RotateCcw className="size-4" /> Empezar de nuevo</Button>
          )}
          {needsRead ? (
            <Button variant="brand" onClick={next} disabled={!title.trim() || busy} className="gap-2">
              {phase === 'thinking' ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />}
              {preview ? 'Volver a leer' : 'Previsualizar'}
              <Kbd className="hidden border-white/25 bg-white/15 text-white sm:inline-grid">{MOD} ↵</Kbd>
            </Button>
          ) : (
            <Button onClick={next} disabled={busy} className="gap-2">
              {phase === 'creating' ? <Loader2 className="size-4 animate-spin" /> : <TicketIcon className="size-4" />}
              Crear ticket
              <Kbd className="hidden border-white/25 bg-white/15 text-white sm:inline-grid">{MOD} ↵</Kbd>
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  // ---------------------------------------------------------------- el porqué de roz
  const why =
    preview && c ? (
      <div className={cn('grid gap-4 text-sm', textChanged && 'opacity-50')}>
        <section className="grid gap-2">
          <h3 className="flex items-center gap-2 label-caps text-purple-deep">
            <span className="grid size-5 place-items-center rounded-sm bg-lavender"><Bot className="size-3" /></span>
            Cómo lo entendió roz
            {phase === 'thinking' && <Loader2 className="size-3.5 animate-spin" />}
          </h3>
          <div className="grid gap-1 text-xs"><ClassificationRows c={c} /></div>
        </section>
        <section className="grid gap-2 border-t pt-4">
          <h3 className="label-caps">Responsable</h3>
          {preview.outcome === 'escalated' ? (
            <div className="space-y-1.5 rounded-md border border-yellow/40 bg-yellow-soft px-3 py-2 text-xs text-yellow-ink">
              <p className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-3.5" /> roz no encontró a quién asignarlo
                {preview.suggestion && <span className="font-normal">· {SUGGESTION_LABEL[preview.suggestion.suggested] ?? preview.suggestion.suggested}</span>}
              </p>
              <ul className="space-y-1">
                {(preview.suggestion?.options ?? []).map((o, i) => (
                  <li key={i}><span className="font-medium">{SUGGESTION_LABEL[o.kind] ?? o.kind}:</span> {o.detail}</li>
                ))}
              </ul>
              <p>Elige a alguien en la píldora de responsable, o créalo sin responsable.</p>
            </div>
          ) : chosen ? (
            <div className="grid gap-1.5 text-xs">
              <p className="flex items-center gap-2 text-sm">
                <UserAvatar url={devs.find((d) => d.id === chosen.devId)?.avatarUrl ?? null} id={chosen.devId} name={chosen.name} className="size-5" />
                roz propone a <span className="font-semibold">{chosen.name}</span>
              </p>
              <ChosenWhy chosen={chosen} tieBreaks={preview.tieBreaks} name={nameOf} />
            </div>
          ) : null}
          {alternatives.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">También caben:</span>
              {alternatives.map((a) => (
                <button
                  key={a.devId}
                  type="button"
                  onClick={() => setAssignee(a.devId)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border bg-card py-0.5 pl-0.5 pr-2.5 font-medium transition-colors hover:bg-panel',
                    finalAssignee === a.devId && 'border-orange/40 bg-orange-soft text-orange-ink hover:bg-orange-soft',
                  )}
                >
                  <UserAvatar url={devs.find((d) => d.id === a.devId)?.avatarUrl ?? null} id={a.devId} name={a.name} className="size-4" />
                  {a.name}
                </button>
              ))}
            </div>
          )}
          {discarded.length > 0 && (
            <Disclosure className="text-xs" summaryClassName="text-muted-foreground" summary={<span>Descartados ({discarded.length})</span>}>
              <div className="mt-1.5"><DiscardedList candidates={discarded} /></div>
            </Disclosure>
          )}
        </section>
      </div>
    ) : null;

  const overrideDialog = (
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
  );

  // ---- Modal (chat): una columna; el porqué, plegado debajo de las píldoras ----
  if (dense) {
    return (
      <>
        {renderComposer(why && (
          <div className="shrink-0 border-t px-4 pt-3">
            <button
              type="button"
              onClick={() => setWhyOpen((o) => !o)}
              className="flex w-full items-center gap-1.5 pb-3 text-left text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown className={cn('size-4 transition-transform', !whyOpen && '-rotate-90')} />
              Por qué lo entendió así roz
            </button>
            {whyOpen && <div className="max-h-[34dvh] overflow-y-auto pb-4">{why}</div>}
          </div>
        ))}
        {overrideDialog}
      </>
    );
  }

  // ---- Página: compositor | panel de roz. Ambas columnas estiran a la misma altura. ----
  return (
    <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      {renderComposer()}
      <aside className="min-w-0 rounded-xl bg-panel p-5">
        {phase === 'thinking' && !preview ? (
          <div className="grid gap-3">
            <span className="flex items-center gap-2 label-caps text-purple-deep"><Loader2 className="size-3.5 animate-spin" /> roz está leyendo</span>
            <Skeleton className="h-4 w-2/3 bg-card" />
            <Skeleton className="h-4 w-1/2 bg-card" />
            <Skeleton className="h-4 w-3/5 bg-card" />
            <Skeleton className="mt-3 h-16 w-full bg-card" />
          </div>
        ) : why ? (
          why
        ) : (
          <HowItWorks />
        )}
      </aside>
      {overrideDialog}
    </div>
  );
}

/** Estado vacío del panel de roz: los tres pasos, en vez de una columna en blanco. */
function HowItWorks() {
  const steps: { icon: ReactNode; title: string; body: string }[] = [
    { icon: <Brain className="size-4" />, title: 'Lee el ticket', body: 'Deduce el tipo de solución, la skill, el tamaño en puntos y la urgencia.' },
    { icon: <ListChecks className="size-4" />, title: 'Tú lo corriges', body: 'Cada dato queda en una píldora: si roz se equivoca, lo cambias ahí mismo.' },
    { icon: <UserCheck className="size-4" />, title: 'Propone responsable', body: 'Con la misma política de la asignación automática; al crear le llega un DM de tu parte.' },
  ];
  return (
    <div className="grid h-full content-start gap-4">
      <span className="flex items-center gap-2 label-caps text-purple-deep">
        <span className="grid size-5 place-items-center rounded-sm bg-lavender"><Bot className="size-3" /></span> Qué hace roz
      </span>
      <ol className="grid gap-2.5">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3 rounded-lg bg-card p-3.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-lavender text-purple-deep">{s.icon}</span>
            <div className="grid min-w-0 gap-0.5">
              <span className="text-[13.5px] font-semibold"><span className="mr-1.5 tabular-nums text-faint">{i + 1}</span>{s.title}</span>
              <span className="text-[12.5px] text-muted-foreground">{s.body}</span>
            </div>
          </li>
        ))}
      </ol>
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
