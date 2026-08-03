import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Trash2, ImagePlus, X, Loader2, Lock, Users, Lightbulb } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { DefinitionMeter } from '@/components/ideas/DefinitionMeter';
import { GuidedFieldEditor } from '@/components/ideas/GuidedField';
import { FeatureList } from '@/components/ideas/FeatureList';
import { BlockList } from '@/components/ideas/BlockList';
import { apiGet, apiSend, apiUpload, type Attachment, type Idea, type IdeaBlock, type IdeaDetail, type IdeaFeature } from '@/lib/api';
import { GUIDED_FIELDS, IDEA_STATUS_OPTIONS, definitionScore, type DefinitionCheck, type GuidedKey } from '@/lib/ideas';
import { relative } from '@/lib/format';
import { cn } from '@/lib/utils';

const MAX_BYTES = 4 * 1024 * 1024; // debe coincidir con el límite del backend

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

type GuidedState = Record<GuidedKey, string>;

const EMPTY_GUIDED: GuidedState = {
  problem: '', audience: '', value: '', outOfScope: '', risks: '', success: '', nextStep: '',
};

/**
 * Editor de una idea. Bento de dos columnas: a la izquierda el cuestionario guiado, el alcance y
 * los bloques libres; a la derecha el medidor de definición, el estado y las imágenes.
 *
 * Qué se guarda cuándo, y por qué: los campos de TEXTO se mandan juntos con el botón Guardar (son
 * un formulario, y guardar en cada tecla haría una petición por letra). El estado, el toggle de
 * compartir, las features, los bloques y las imágenes son entidades o banderas sueltas: se guardan
 * al instante, igual que los comentarios de una tarea.
 */
export function IdeaDialog({
  ideaId,
  open,
  isDraft,
  onOpenChange,
  onSaved,
}: {
  ideaId: string | null;
  open: boolean;
  /** Recién creada desde "Nueva idea": si se cierra sin escribir nada, se descarta sola. */
  isDraft?: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [idea, setIdea] = useState<Idea | null>(null);
  const [features, setFeatures] = useState<IdeaFeature[]>([]);
  const [blocks, setBlocks] = useState<IdeaBlock[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);

  const [title, setTitle] = useState('');
  const [pitch, setPitch] = useState('');
  const [guided, setGuided] = useState<GuidedState>(EMPTY_GUIDED);
  const [tags, setTags] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  // La idea se crea al abrir el editor (features y bloques necesitan un idea_id al que colgarse),
  // pero mientras no se guarde NO cuenta como creada: cerrar la tira. Deja de ser descartable en el
  // primer Guardar, no antes — si no, un borrador cerrado a medias quedaría en la rejilla.
  const [discardable, setDiscardable] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);

  const readOnly = !!idea && !idea.canEdit;

  useEffect(() => {
    if (!open || !ideaId) return;
    let alive = true;
    setLoading(true);
    apiGet<IdeaDetail>(`/ideas/${ideaId}`)
      .then((r) => {
        if (!alive) return;
        setIdea(r.idea);
        setFeatures(r.features);
        setBlocks(r.blocks);
        setAttachments(r.attachments);
        setTitle(r.idea.title);
        setPitch(r.idea.pitch ?? '');
        setGuided({
          problem: r.idea.problem ?? '',
          audience: r.idea.audience ?? '',
          value: r.idea.value ?? '',
          outOfScope: r.idea.outOfScope ?? '',
          risks: r.idea.risks ?? '',
          success: r.idea.success ?? '',
          nextStep: r.idea.nextStep ?? '',
        });
        setTags((r.idea.tags ?? []).join(', '));
        setDirty(false);
        setDiscardable(!!isDraft);
        // Borrador: el cursor cae en el título con el provisional seleccionado, así escribir lo
        // reemplaza. Es el equivalente a haberlo tecleado antes, pero sin pedirlo por adelantado.
        if (isDraft) setTimeout(() => titleInput.current?.select(), 60);
      })
      .catch((e: any) => alive && toast.error('No se pudo abrir la idea', { description: String(e?.message ?? e) }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, ideaId]);

  const mustCount = useMemo(() => features.filter((f) => f.priority === 'imprescindible').length, [features]);
  // El medidor lee el estado LOCAL, no lo guardado: la barra tiene que moverse mientras escribes.
  const score = useMemo(() => definitionScore({ ...guided, mustCount }), [guided, mustCount]);

  const setField = useCallback((key: GuidedKey, v: string) => {
    setGuided((prev) => ({ ...prev, [key]: v }));
    setDirty(true);
  }, []);

  /** Salta al campo que falta desde la checklist del medidor. */
  const jump = useCallback((target: DefinitionCheck['target']) => {
    const id = target === 'features' ? 'ideas-features' : `guided-${target}`;
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (target !== 'features') {
      const input = el?.querySelector<HTMLTextAreaElement>(`[data-guided-input="${target}"]`);
      setTimeout(() => input?.focus(), 300);
    }
  }, []);

  async function save() {
    if (!ideaId || !title.trim()) return;
    setBusy(true);
    // Los nombres deben calzar EXACTO con IdeaPatchBody del backend: zod hace strip de las claves
    // que no reconoce, así que un campo mal nombrado se descartaría sin error y el guardado
    // parecería funcionar sin guardar nada.
    const body = {
      title: title.trim(),
      pitch: pitch.trim() || null,
      problem: guided.problem.trim() || null,
      audience: guided.audience.trim() || null,
      value: guided.value.trim() || null,
      outOfScope: guided.outOfScope.trim() || null,
      risks: guided.risks.trim() || null,
      success: guided.success.trim() || null,
      nextStep: guided.nextStep.trim() || null,
      tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
    };
    try {
      const { idea: updated } = await apiSend<{ idea: Idea }>('PATCH', `/ideas/${ideaId}`, body);
      setIdea(updated);
      setDirty(false);
      setDiscardable(false); // a partir de aquí es una idea de verdad, no un borrador
      toast.success('Idea guardada', { description: updated.title });
      onSaved();
    } catch (e: any) {
      toast.error('No se pudo guardar', { description: String(e?.message ?? e) });
    }
    setBusy(false);
  }

  /** Banderas sueltas (estado, compartir): una petición con una sola clave, sin tocar el texto. */
  async function patchFlag(body: { status?: string; shared?: boolean }) {
    if (!ideaId) return;
    try {
      const { idea: updated } = await apiSend<{ idea: Idea }>('PATCH', `/ideas/${ideaId}`, body);
      // Solo se adopta la bandera: el resto del estado local puede tener cambios sin guardar.
      setIdea((prev) => (prev ? { ...prev, status: updated.status, shared: updated.shared } : updated));
      onSaved();
    } catch (e: any) {
      toast.error('No se pudo guardar', { description: String(e?.message ?? e) });
    }
  }

  async function removeIdea() {
    if (!ideaId) return;
    setBusy(true);
    try {
      await apiSend<{ ok: true }>('DELETE', `/ideas/${ideaId}`);
      toast.success('Idea eliminada', { description: idea?.title });
      onOpenChange(false);
      onSaved();
    } catch (e: any) {
      toast.error('No se pudo eliminar', { description: String(e?.message ?? e) });
    }
    setBusy(false);
  }

  // ---- Features ----
  async function addFeature(featureTitle: string) {
    if (!ideaId) return;
    try {
      const { feature } = await apiSend<{ feature: IdeaFeature }>('POST', `/ideas/${ideaId}/features`, { title: featureTitle });
      setFeatures((prev) => [...prev, feature]);
    } catch (e: any) {
      toast.error('No se pudo añadir la feature', { description: String(e?.message ?? e) });
    }
  }

  async function updateFeature(id: string, patch: { title?: string; detail?: string | null; priority?: string }) {
    const before = features;
    setFeatures((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } as IdeaFeature : f)));
    try {
      await apiSend<{ feature: IdeaFeature }>('PATCH', `/ideas/${ideaId}/features/${id}`, patch);
    } catch (e: any) {
      setFeatures(before); // revert: la fila vuelve a lo que estaba guardado
      toast.error('No se pudo guardar la feature', { description: String(e?.message ?? e) });
    }
  }

  async function deleteFeature(id: string) {
    const before = features;
    setFeatures((prev) => prev.filter((f) => f.id !== id));
    try {
      await apiSend<{ ok: true }>('DELETE', `/ideas/${ideaId}/features/${id}`);
    } catch (e: any) {
      setFeatures(before);
      toast.error('No se pudo eliminar', { description: String(e?.message ?? e) });
    }
  }

  async function moveFeature(id: string, dir: -1 | 1) {
    const i = features.findIndex((f) => f.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= features.length) return;
    const next = [...features];
    [next[i], next[j]] = [next[j]!, next[i]!];
    const before = features;
    setFeatures(next);
    try {
      await apiSend<{ features: IdeaFeature[] }>('POST', `/ideas/${ideaId}/features/reorder`, { ids: next.map((f) => f.id) });
    } catch (e: any) {
      setFeatures(before);
      toast.error('No se pudo reordenar', { description: String(e?.message ?? e) });
    }
  }

  // ---- Bloques ----
  async function addBlock(kind: string) {
    if (!ideaId) return;
    try {
      const { block } = await apiSend<{ block: IdeaBlock }>('POST', `/ideas/${ideaId}/blocks`, { kind });
      setBlocks((prev) => [...prev, block]);
    } catch (e: any) {
      toast.error('No se pudo añadir el bloque', { description: String(e?.message ?? e) });
    }
  }

  async function updateBlock(
    id: string,
    patch: { title?: string | null; body?: string | null; source?: string | null; url?: string | null; resolved?: boolean },
  ) {
    const before = blocks;
    setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } as IdeaBlock : b)));
    try {
      await apiSend<{ block: IdeaBlock }>('PATCH', `/ideas/${ideaId}/blocks/${id}`, patch);
    } catch (e: any) {
      setBlocks(before);
      toast.error('No se pudo guardar', { description: String(e?.message ?? e) });
    }
  }

  async function deleteBlock(id: string) {
    const before = blocks;
    setBlocks((prev) => prev.filter((b) => b.id !== id));
    try {
      await apiSend<{ ok: true }>('DELETE', `/ideas/${ideaId}/blocks/${id}`);
    } catch (e: any) {
      setBlocks(before);
      toast.error('No se pudo eliminar', { description: String(e?.message ?? e) });
    }
  }

  // ---- Imágenes ----
  async function uploadFiles(files: File[]) {
    if (!ideaId || !files.length) return;
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        toast.error('Solo se aceptan imágenes', { description: file.name });
        continue;
      }
      if (file.size > MAX_BYTES) {
        toast.error('La imagen supera 4MB', { description: file.name });
        continue;
      }
      try {
        const { attachment } = await apiUpload<{ attachment: Attachment }>(`/ideas/${ideaId}/attachments`, file);
        setAttachments((prev) => [...prev, attachment]);
      } catch (e: any) {
        toast.error('No se pudo subir la imagen', { description: String(e?.message ?? e) });
      }
    }
  }

  async function removeAttachment(id: string) {
    const before = attachments;
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    try {
      await apiSend<{ ok: true }>('DELETE', `/ideas/${ideaId}/attachments/${id}`);
    } catch (e: any) {
      setAttachments(before);
      toast.error('No se pudo eliminar la imagen', { description: String(e?.message ?? e) });
    }
  }

  /** ¿El borrador sigue intacto? Entonces no es una idea, es un clic arrepentido. */
  const pristine =
    discardable &&
    (!title.trim() || title === 'Sin título') &&
    !pitch.trim() &&
    Object.values(guided).every((v) => !v.trim()) &&
    features.length === 0 &&
    blocks.length === 0 &&
    attachments.length === 0;

  /** Tira el borrador entero. Se llama al cerrar uno intacto, y al confirmar "Descartar". */
  async function discardDraft() {
    if (!ideaId) return;
    onOpenChange(false);
    try {
      await apiSend<{ ok: true }>('DELETE', `/ideas/${ideaId}`);
    } catch {
      // Si falla, el borrador se queda en la rejilla: no vale la pena molestar por esto.
    }
    onSaved();
  }

  /**
   * Al cerrar hay tres casos distintos, y confundirlos es lo que hacía que una idea sin guardar
   * apareciera igual en la rejilla:
   *   borrador intacto  → se tira sin preguntar
   *   borrador escrito  → se pregunta, y descartar lo BORRA (nunca llegó a existir para el usuario)
   *   idea ya guardada  → se pregunta, y descartar solo pierde los cambios del formulario
   */
  async function requestClose(next: boolean) {
    if (next) return onOpenChange(true);
    if (pristine) return discardDraft();
    if ((discardable || dirty) && !readOnly) {
      setConfirmClose(true);
      return;
    }
    onOpenChange(false);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent className="flex max-h-[92dvh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl lg:max-w-5xl">
          <DialogHeader className="shrink-0 border-b px-5 py-4 sm:px-6">
            <DialogTitle className="flex items-center gap-2">
              <Lightbulb className="size-4 text-chart-4" />
              {readOnly ? 'Idea compartida' : 'Aterrizar idea'}
            </DialogTitle>
            <DialogDescription>
              {readOnly
                ? `De ${idea?.createdByName ?? 'otra persona'} · solo lectura`
                : 'Contesta lo que puedas. Lo que falte se queda a la vista — para eso está el medidor.'}
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="grid flex-1 place-items-center py-16">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="scroll-thin flex-1 overflow-y-auto">
              <div className="grid gap-4 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_300px]">
                {/* ---- Columna principal ---- */}
                <div className="min-w-0 space-y-4">
                  <div className="space-y-2">
                    <input
                      ref={titleInput}
                      value={title}
                      onChange={(e) => {
                        setTitle(e.target.value);
                        setDirty(true);
                      }}
                      readOnly={readOnly}
                      placeholder="Título de la idea"
                      className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-xl font-semibold outline-none transition-colors placeholder:text-muted-foreground/60 hover:border-input focus:border-input focus:ring-1 focus:ring-ring read-only:hover:border-transparent"
                    />
                    <input
                      value={pitch}
                      onChange={(e) => {
                        setPitch(e.target.value);
                        setDirty(true);
                      }}
                      readOnly={readOnly}
                      placeholder="En una frase: qué es, para quién, y qué le resuelve"
                      className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-sm text-muted-foreground outline-none transition-colors placeholder:text-muted-foreground/60 hover:border-input focus:border-input focus:ring-1 focus:ring-ring read-only:hover:border-transparent"
                    />
                  </div>

                  <div className="space-y-2">
                    {GUIDED_FIELDS.map((f) => (
                      <GuidedFieldEditor
                        key={f.key}
                        field={f}
                        value={guided[f.key]}
                        onChange={(v) => setField(f.key, v)}
                        readOnly={readOnly}
                      />
                    ))}
                  </div>

                  <div>
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Alcance</h3>
                      <span className="text-[11px] text-muted-foreground">
                        {mustCount} imprescindible{mustCount === 1 ? '' : 's'} de {features.length}
                      </span>
                    </div>
                    <FeatureList
                      features={features}
                      readOnly={readOnly}
                      onAdd={addFeature}
                      onUpdate={updateFeature}
                      onDelete={deleteFeature}
                      onMove={moveFeature}
                    />
                  </div>

                  <BlockList
                    blocks={blocks}
                    readOnly={readOnly}
                    handlers={{ onAdd: addBlock, onUpdate: updateBlock, onDelete: deleteBlock }}
                  />
                </div>

                {/* ---- Panel derecho ---- */}
                <div className="space-y-3 lg:sticky lg:top-0 lg:self-start">
                  <Section title="Definición">
                    <DefinitionMeter score={score} onJump={readOnly ? undefined : jump} />
                    {score.pct === 100 && idea?.status !== 'definida' && !readOnly && (
                      <Button size="sm" variant="secondary" className="mt-3 w-full text-xs" onClick={() => patchFlag({ status: 'definida' })}>
                        Marcar como Definida
                      </Button>
                    )}
                  </Section>

                  <Section title="Estado">
                    <Select value={idea?.status ?? 'semilla'} onValueChange={(v) => patchFlag({ status: v })} disabled={readOnly}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {IDEA_STATUS_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value} className="text-xs">
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Section>

                  <Section title="Visibilidad">
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => patchFlag({ shared: !idea?.shared })}
                      className={cn(
                        'flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors',
                        readOnly ? 'cursor-default' : 'hover:bg-muted/50',
                        idea?.shared ? 'border-chart-1/40 bg-chart-1/5' : 'border-dashed',
                      )}
                    >
                      {idea?.shared ? <Users className="mt-0.5 size-4 shrink-0 text-chart-1" /> : <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                      <span className="min-w-0">
                        <span className="block text-xs font-medium">{idea?.shared ? 'Compartida con el equipo' : 'Privada'}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {idea?.shared ? 'Otros devs la ven en solo lectura' : 'Solo tú la ves'}
                        </span>
                      </span>
                    </button>
                  </Section>

                  <Section title="Etiquetas">
                    <Input
                      value={tags}
                      onChange={(e) => {
                        setTags(e.target.value);
                        setDirty(true);
                      }}
                      readOnly={readOnly}
                      placeholder="interno, cliente, experimento"
                      className="h-8 text-xs"
                    />
                  </Section>

                  <Section
                    title="Imágenes"
                    action={
                      !readOnly && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => fileInput.current?.click()}>
                          <ImagePlus className="size-3.5" />
                        </Button>
                      )
                    }
                  >
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        uploadFiles(Array.from(e.target.files ?? []));
                        e.target.value = '';
                      }}
                    />
                    <div
                      onDragOver={(e) => {
                        if (readOnly) return;
                        e.preventDefault();
                        setDragging(true);
                      }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(e) => {
                        if (readOnly) return;
                        e.preventDefault();
                        setDragging(false);
                        uploadFiles(Array.from(e.dataTransfer.files));
                      }}
                      className={cn(
                        'grid grid-cols-3 gap-1.5 rounded-lg transition-colors',
                        dragging && 'outline-dashed outline-2 outline-offset-2 outline-chart-1',
                      )}
                    >
                      {attachments.map((a) => (
                        <div key={a.id} className="group relative aspect-square overflow-hidden rounded-md border">
                          <a href={a.url} target="_blank" rel="noreferrer noopener">
                            <img src={a.url} alt={a.name} className="size-full object-cover" loading="lazy" />
                          </a>
                          {!readOnly && (
                            <button
                              type="button"
                              onClick={() => removeAttachment(a.id)}
                              className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full bg-background/80 opacity-0 transition-opacity group-hover:opacity-100"
                              aria-label={`Eliminar ${a.name}`}
                            >
                              <X className="size-3" />
                            </button>
                          )}
                        </div>
                      ))}
                      {attachments.length === 0 && (
                        <p className="col-span-3 py-2 text-center text-[11px] text-muted-foreground">
                          {readOnly ? 'Sin imágenes' : 'Arrastra bocetos o capturas'}
                        </p>
                      )}
                    </div>
                  </Section>

                  {idea && (
                    <div className="px-1 text-[11px] text-muted-foreground">
                      <div>Creada por {idea.createdByName ?? '—'}</div>
                      <div>Actualizada {relative(idea.updatedAt)}</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="shrink-0 gap-2 border-t px-5 py-3 sm:px-6">
            {!readOnly && !discardable && (
              <Button variant="ghost" className="mr-auto text-muted-foreground hover:text-destructive" onClick={() => setConfirmDelete(true)} disabled={busy}>
                <Trash2 className="size-4" />
                <span className="ml-1.5">Eliminar</span>
              </Button>
            )}
            {(dirty || discardable) && !readOnly && (
              <Badge variant="secondary" className="self-center text-[10px]">Sin guardar</Badge>
            )}
            <Button variant="outline" onClick={() => requestClose(false)}>
              {readOnly ? 'Cerrar' : discardable ? 'Descartar' : 'Cancelar'}
            </Button>
            {!readOnly && (
              <Button onClick={save} disabled={busy || !title.trim()}>
                {busy && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Guardar
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{discardable ? '¿Descartar esta idea?' : 'Tienes cambios sin guardar'}</AlertDialogTitle>
            <AlertDialogDescription>
              {discardable
                ? 'Todavía no la has guardado, así que se borra entera — incluidas las features, los bloques y las imágenes que hayas añadido.'
                : 'Las features, los bloques y las imágenes ya se guardaron. Lo que se perdería es el texto de los campos guiados.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Seguir editando</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (discardable) return void discardDraft();
                setDirty(false);
                onOpenChange(false);
              }}
            >
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar esta idea?</AlertDialogTitle>
            <AlertDialogDescription>
              Se borran también sus features, bloques e imágenes. No se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={removeIdea}>Eliminar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
