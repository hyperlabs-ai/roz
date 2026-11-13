// Diálogos de un nodo: alta/edición, archivar y "conectar con…". Valen para cualquier documento: el
// registro de zeus es la fuente de verdad, también para los que se importaron de un repo.
import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { DateField } from '@/components/ui/date-field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { invalidate } from '@/lib/store';
import { useAction } from '@/lib/useAction';
import {
  ZEUS_EDGE_KINDS, ZEUS_NODE_KINDS, ZEUS_NODE_STATUSES, zeusApi,
  type ZeusEdgeKind, type ZeusGraphNode, type ZeusNodeDetail, type ZeusNodeInput, type ZeusNodeKind, type ZeusNodeStatus,
} from '@/lib/zeus';
import { GRAPH_KEY, NODES_KEY, useZeusGraph, useZeusProjects } from './hooks';
import { EDGE_META, EdgeSwatch, KIND_META, STATUS_META } from './zeus-ui';

const ORG = '__org__';

/** Lo que cambió en zeus afecta al mapa y a las listas a la vez. */
export function invalidateNodes(): void {
  invalidate(GRAPH_KEY);
  invalidate(NODES_KEY);
}

const parseTags = (s: string): string[] => [...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))];

export function NodeDialog({
  open,
  node,
  defaultKind,
  defaultProjectId,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Con nodo = editar; sin nodo = nuevo. */
  node?: ZeusNodeDetail | null;
  defaultKind?: ZeusNodeKind;
  defaultProjectId?: string | null;
  onClose: () => void;
  onSaved?: (node: ZeusNodeDetail) => void;
}) {
  const projects = useZeusProjects();
  const act = useAction();
  const editing = !!node;
  const [kind, setKind] = useState<ZeusNodeKind>('doc');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [projectId, setProjectId] = useState<string>(ORG);
  const [tags, setTags] = useState('');
  const [pinned, setPinned] = useState(false);
  const [reviewAfter, setReviewAfter] = useState('');
  const [status, setStatus] = useState<ZeusNodeStatus>('active');

  // Se rellena al ABRIR (no en cada render): si el nodo revalida mientras se escribe, no pisa el texto.
  useEffect(() => {
    if (!open) return;
    setKind(node?.kind ?? defaultKind ?? 'doc');
    setTitle(node?.title ?? '');
    setSummary(node?.summary ?? '');
    setBody(node?.body ?? '');
    setProjectId(node ? node.projectId ?? ORG : defaultProjectId ?? ORG);
    setTags(node?.tags.join(', ') ?? '');
    setPinned(node?.pinned ?? false);
    setReviewAfter(node?.reviewAfter?.slice(0, 10) ?? '');
    setStatus(node?.status ?? 'active');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, node?.id]);

  const busy = act.busy('save-node');
  const canSave = title.trim().length > 0 && !busy;

  function save() {
    const input: ZeusNodeInput = {
      kind,
      title: title.trim(),
      summary: summary.trim(),
      body,
      projectId: projectId === ORG ? null : projectId,
      tags: parseTags(tags),
      pinned,
      reviewAfter: reviewAfter || null,
      status,
    };
    void act.run('save-node', () => (node ? zeusApi.updateNode(node.id, input) : zeusApi.createNode(input)), {
      success: editing ? 'Cambios guardados' : 'Entrada creada',
      error: editing ? 'No se pudo guardar' : 'No se pudo crear',
      onDone: (saved) => {
        invalidateNodes();
        onSaved?.(saved);
        onClose();
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader eyebrow={editing ? 'Zeus · editar' : 'Zeus · nueva entrada'}>
          <DialogTitle>{editing ? node!.title : 'Nueva entrada'}</DialogTitle>
          <DialogDescription>
            El registro de zeus es lo que leen el equipo y sus agentes: decisiones, specs, reglas, recursos, diseño y notas.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) save();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[minmax(0,180px)_1fr]">
            <Field label="Tipo" htmlFor="zn-kind">
              <Select value={kind} onValueChange={(v) => setKind(v as ZeusNodeKind)}>
                <SelectTrigger id="zn-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ZEUS_NODE_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>{KIND_META[k].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Título" htmlFor="zn-title" required>
              <Input id="zn-title" autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Convención de ramas y PRs" />
            </Field>
          </div>

          <Field label="En una línea" htmlFor="zn-summary" hint="Es lo que el agente lee en el índice para decidir si abre el documento." optional>
            <Input id="zn-summary" value={summary} maxLength={280} onChange={(e) => setSummary(e.target.value)} placeholder="Qué dice y cuándo aplica" />
          </Field>

          <Field label="Contenido" htmlFor="zn-body" hint="Markdown." optional>
            <Textarea id="zn-body" rows={8} maxRows={18} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-[12.5px]" placeholder={'## Contexto\n\n…'} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Alcance" htmlFor="zn-project" hint="De un proyecto o de toda la organización.">
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="zn-project"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ORG}>Toda la organización</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                  {/* Un proyecto que el grafo aún no trae (caché fría) no debe dejar el select vacío. */}
                  {projectId !== ORG && !projects.some((p) => p.id === projectId) && (
                    <SelectItem value={projectId}>{node?.projectKey ?? 'Proyecto actual'}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Etiquetas" htmlFor="zn-tags" hint="Separadas por coma." optional>
              <Input id="zn-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="backend, convenciones" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Revisar después de" htmlFor="zn-review" hint="Pasada esa fecha se marca como por revisar." optional>
              <DateField id="zn-review" value={reviewAfter} onChange={(e) => setReviewAfter(e.target.value)} />
            </Field>
            <Field label="Estado" htmlFor="zn-status">
              <Select value={status} onValueChange={(v) => setStatus(v as ZeusNodeStatus)}>
                <SelectTrigger id="zn-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ZEUS_NODE_STATUSES.filter((s) => s !== 'archived' || status === 'archived').map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <label htmlFor="zn-pinned" className="flex cursor-pointer items-start gap-3 rounded-md border bg-sidebar px-3.5 py-3">
            <Switch id="zn-pinned" checked={pinned} onCheckedChange={setPinned} className="mt-0.5" />
            <span className="grid gap-0.5">
              <span className="text-[13px] font-medium">Fijar</span>
              <span className="text-xs text-muted-foreground">
                Una entrada fijada se carga SIEMPRE en el contexto del agente para su alcance. Úsalo para lo que no se puede ignorar; cada una cuesta contexto.
              </span>
            </span>
          </label>

          <DialogFooter className="gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
            <Button type="submit" disabled={!canSave}>
              {busy && <Loader2 className="animate-spin" />}
              {editing ? 'Guardar' : 'Crear'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ArchiveNodeDialog({ node, onClose, onArchived }: { node: { id: string; title: string } | null; onClose: () => void; onArchived?: () => void }) {
  const act = useAction();
  const busy = act.busy('archive-node');
  return (
    <AlertDialog open={!!node} onOpenChange={(v) => !v && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archivar esta entrada</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{node?.title}</span> deja de aparecer en el mapa y en el contexto del agente. Su historial se conserva.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Volver</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              if (!node) return;
              void act.run('archive-node', () => zeusApi.archiveNode(node.id), {
                success: 'Entrada archivada',
                error: 'No se pudo archivar',
                onDone: () => {
                  invalidateNodes();
                  onArchived?.();
                  onClose();
                },
              });
            }}
          >
            {busy && <Loader2 className="animate-spin" />}
            Archivar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "Conectar con…": elige el otro extremo buscando en todo el grafo y el tipo de relación. */
export function ConnectDialog({
  source,
  onClose,
  onConnected,
}: {
  source: { ref: string; title: string } | null;
  onClose: () => void;
  onConnected?: () => void;
}) {
  const graph = useZeusGraph(null);
  const act = useAction();
  const [target, setTarget] = useState<string | null>(null);
  const [kind, setKind] = useState<ZeusEdgeKind>('relates_to');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!source) return;
    setTarget(null);
    setKind('relates_to');
    setNote('');
  }, [source?.ref]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = useMemo<ComboboxOption[]>(
    () =>
      (graph.data?.nodes ?? [])
        .filter((n: ZeusGraphNode) => n.ref !== source?.ref && n.status !== 'archived')
        .map((n) => ({
          value: n.ref,
          label: n.title,
          hint: KIND_META[n.kind]?.label ?? n.kind,
          keywords: `${n.summary} ${n.kind}`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'es')),
    [graph.data, source?.ref],
  );
  const busy = act.busy('connect');
  const targetTitle = options.find((o) => o.value === target)?.label;

  return (
    <Dialog open={!!source} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader eyebrow="Zeus · conexión">
          <DialogTitle>Conectar con…</DialogTitle>
          <DialogDescription>
            Desde <span className="font-medium text-foreground">{source?.title}</span>.
          </DialogDescription>
        </DialogHeader>

        <Field label="Con qué" htmlFor="zc-target" required error={graph.error && !graph.data ? 'No se pudo cargar el mapa para elegir el destino.' : undefined}>
          <Combobox
            id="zc-target"
            value={target}
            onChange={setTarget}
            options={options}
            searchFrom={0}
            placeholder={graph.loading ? 'Cargando…' : 'Buscar un documento, persona, proyecto, repo…'}
            searchPlaceholder="Buscar en zeus…"
            emptyText="Nada con ese nombre"
          />
        </Field>

        <Field label="Relación" htmlFor="zc-kind">
          <Select value={kind} onValueChange={(v) => setKind(v as ZeusEdgeKind)}>
            <SelectTrigger id="zc-kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ZEUS_EDGE_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  <span className="flex items-center gap-2.5">
                    <EdgeSwatch kind={k} />
                    {EDGE_META[k].out}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {target && (
          <p className="rounded-md bg-panel px-3 py-2 text-[12.5px] text-muted-foreground">
            <span className="font-medium text-foreground">{source?.title}</span> {EDGE_META[kind].out}{' '}
            <span className="font-medium text-foreground">{targetTitle}</span>.
          </p>
        )}

        <Field label="Nota" htmlFor="zc-note" optional>
          <Input id="zc-note" value={note} maxLength={280} onChange={(e) => setNote(e.target.value)} placeholder="Por qué se relacionan" />
        </Field>

        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button
            disabled={!target || busy}
            onClick={() => {
              if (!source || !target) return;
              void act.run('connect', () => zeusApi.createEdge({ src: source.ref, dst: target, kind, ...(note.trim() ? { note: note.trim() } : {}) }), {
                success: 'Conexión creada',
                error: 'No se pudo conectar',
                onDone: () => {
                  invalidateNodes();
                  onConnected?.();
                  onClose();
                },
              });
            }}
          >
            {busy && <Loader2 className="animate-spin" />}
            Conectar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
