// Lector de un nodo de zeus: inspector ADJUNTO al mapa (no un cajón encimado). Un nodo GUARDADO
// (`node:<uuid>`) se lee completo de `/nodes/:id` (cuerpo, aristas, revisiones); una entidad derivada
// (persona, proyecto, repo, PC) no tiene documento propio, así que se muestra lo que el grafo ya trae.
//
// El registro de zeus es la fuente de verdad: TODO documento se edita aquí (título, línea y contenido
// en el propio lector; el resto en "Más opciones"), venga de donde venga. Los que se importaron de un
// repo conservan su procedencia y una acción explícita, "Traer versión del repo", que es la única
// forma en que git vuelve a pisar su texto (queda como una revisión más).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Archive, CalendarClock, Check, ExternalLink, GitBranch, Loader2, Maximize2, Minimize2, Pencil, Pin, Settings2, Waypoints, X,
} from 'lucide-react';
import { Disclosure, EmptyState, ErrorCard } from '@/components/bits';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { GithubHandle, IntegrationIcon } from '@/components/brand';
import { Markdown } from '@/components/Markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DateField } from '@/components/ui/date-field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { isPastDay, shortDate } from '@/lib/format';
import { to } from '@/lib/routes';
import { useAction } from '@/lib/useAction';
import { useApi } from '@/lib/useApi';
import { cn } from '@/lib/utils';
import { nodeIdOf, zeusApi, type ZeusGraph, type ZeusGraphNode, type ZeusNodeDetail, type ZeusNodeEdge, type ZeusNodeInput } from '@/lib/zeus';
import { NODES_KEY, useZeusOrg } from './hooks';
import { ArchiveNodeDialog, ConnectDialog, NodeDialog, invalidateNodes } from './NodeDialogs';
import { EdgeSwatch, OnlineDot, StatusBadge, ago, dateTime, edgeMeta, kindMeta, viaLabel } from './zeus-ui';

type Tab = 'contenido' | 'conexiones' | 'historial';

/** Aristas de una entidad derivada, armadas desde el grafo con la misma forma que trae `/nodes/:id`. */
function edgesFromGraph(graph: ZeusGraph | null, ref: string): ZeusNodeEdge[] {
  if (!graph) return [];
  const byRef = new Map(graph.nodes.map((n) => [n.ref, n]));
  const out: ZeusNodeEdge[] = [];
  for (const e of graph.edges) {
    if (e.src !== ref && e.dst !== ref) continue;
    const otherRef = e.src === ref ? e.dst : e.src;
    const other = byRef.get(otherRef);
    if (!other) continue;
    out.push({ ...e, otherRef, otherTitle: other.title, otherKind: other.kind, direction: e.src === ref ? 'out' : 'in' });
  }
  return out;
}

/**
 * Separa el frontmatter YAML (`---` … `---` al inicio) del texto. Markdown lo pintaría como un
 * párrafo corrido ilegible; aparte, va en su propio bloque de código.
 */
function splitFrontmatter(body: string): { front: string | null; text: string } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  return m ? { front: m[1]!.trim(), text: body.slice(m[0].length) } : { front: null, text: body };
}

function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid min-w-0 content-start gap-1 bg-card px-4 py-3', className)}>
      <dt className="label-caps text-[10px]">{label}</dt>
      <dd className="min-w-0 truncate text-[13px] font-medium">{children}</dd>
    </div>
  );
}

/** Conexiones agrupadas por tipo de relación: se lee "implementa → A, B" en vez de una lista plana. */
function Connections({
  edges,
  busy,
  onNavigate,
  onRemove,
}: {
  edges: ZeusNodeEdge[];
  busy: (id: string) => boolean;
  onNavigate: (ref: string) => void;
  onRemove: (edge: ZeusNodeEdge) => void;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, { label: string; kind: string; edges: ZeusNodeEdge[] }>();
    for (const e of edges) {
      const meta = edgeMeta(e.kind);
      const label = e.direction === 'out' ? meta.out : meta.in;
      const g = m.get(label);
      if (g) g.edges.push(e);
      else m.set(label, { label, kind: e.kind, edges: [e] });
    }
    return [...m.values()].sort((a, b) => b.edges.length - a.edges.length);
  }, [edges]);

  if (!edges.length) return <EmptyState icon={<Waypoints />}>Sin conexiones todavía. Usa "Conectar" para enlazarlo con un proyecto, una persona u otro documento.</EmptyState>;
  return (
    <div className="grid gap-5">
      {groups.map((g) => (
        <section key={g.label} className="grid gap-2">
          <h4 className="flex items-center gap-2">
            <EdgeSwatch kind={g.kind} />
            <span className="label-caps text-muted-foreground">{g.label}</span>
            <span className="label-caps tabular-nums">{g.edges.length}</span>
          </h4>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {g.edges.map((e) => {
              const m = kindMeta(e.otherKind);
              return (
                <li key={e.id} className="group/edge flex min-w-0 items-stretch overflow-hidden rounded-md border bg-card transition-colors hover:border-foreground/25">
                  <span className={cn('w-1 shrink-0', m.tone.dot)} />
                  <button
                    type="button"
                    onClick={() => onNavigate(e.otherRef)}
                    title={e.note ?? e.otherTitle}
                    className="grid min-w-0 flex-1 gap-0.5 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="label-caps text-[10px]">{m.label}</span>
                    <span className="truncate text-[13px] font-medium">{e.otherTitle}</span>
                  </button>
                  {/* Las derivadas y las que salen del texto de un documento de git no se borran aquí. */}
                  {!e.derived && e.source !== 'git' && (
                    <button
                      type="button"
                      disabled={busy(e.id)}
                      onClick={() => onRemove(e)}
                      aria-label={`Quitar la conexión con ${e.otherTitle}`}
                      title="Quitar conexión"
                      className="grid w-8 shrink-0 place-items-center text-faint opacity-0 transition-opacity hover:text-red focus-visible:opacity-100 group-hover/edge:opacity-100 max-sm:opacity-100"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Lo que zeus agrega encima de cualquier documento, también de los de git: fijar, revisar, etiquetas. */
function Overlay({ node }: { node: ZeusNodeDetail }) {
  const act = useAction();
  const [tags, setTags] = useState(node.tags.join(', '));
  const [review, setReview] = useState(node.reviewAfter?.slice(0, 10) ?? '');
  useEffect(() => {
    setTags(node.tags.join(', '));
    setReview(node.reviewAfter?.slice(0, 10) ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, node.version]);

  const save = (patch: Partial<ZeusNodeInput>, success: string) =>
    void act.run('overlay', () => zeusApi.updateNode(node.id, patch), { success, error: 'No se pudo guardar', onDone: invalidateNodes });
  const parsed = [...new Set(tags.split(',').map((t) => t.trim()).filter(Boolean))];
  const tagsDirty = parsed.join('|') !== node.tags.join('|');
  const reviewDirty = review !== (node.reviewAfter?.slice(0, 10) ?? '');

  return (
    <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
      <label htmlFor="zr-pin" className="flex cursor-pointer items-center gap-3 bg-card px-4 py-3">
        <Switch id="zr-pin" checked={node.pinned} disabled={act.busy('overlay')} onCheckedChange={(v) => save({ pinned: v }, v ? 'Fijada: se carga siempre en el contexto' : 'Ya no está fijada')} />
        <span className="grid gap-0.5">
          <span className="text-[13px] font-medium">Fijar</span>
          <span className="text-[11px] leading-tight text-muted-foreground">Se carga siempre en el contexto del agente</span>
        </span>
      </label>
      <div className="grid gap-1 bg-card px-4 py-3">
        <label htmlFor="zr-review" className="label-caps text-[10px]">Revisar después de</label>
        <div className="flex items-center gap-1.5">
          <DateField id="zr-review" fieldSize="sm" value={review} onChange={(e) => setReview(e.target.value)} wrapperClassName="min-w-0 flex-1" />
          {reviewDirty && (
            <Button size="icon-sm" variant="secondary" className="size-8 shrink-0" aria-label="Guardar fecha" disabled={act.busy('overlay')} onClick={() => save({ reviewAfter: review || null }, 'Fecha de revisión guardada')}><Check /></Button>
          )}
        </div>
      </div>
      <div className="grid gap-1 bg-card px-4 py-3">
        <label htmlFor="zr-tags" className="label-caps text-[10px]">Etiquetas</label>
        <div className="flex items-center gap-1.5">
          <Input id="zr-tags" fieldSize="sm" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="backend, convenciones" wrapperClassName="min-w-0 flex-1" />
          {tagsDirty && (
            <Button size="icon-sm" variant="secondary" className="size-8 shrink-0" aria-label="Guardar etiquetas" disabled={act.busy('overlay')} onClick={() => save({ tags: parsed }, 'Etiquetas guardadas')}><Check /></Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Reader({
  nodeRef,
  graph,
  expanded,
  onToggleExpand,
  onNavigate,
  onClose,
  className,
}: {
  nodeRef: string;
  /** El grafo a la vista, para las entidades derivadas y como respaldo del título mientras carga. */
  graph: ZeusGraph | null;
  /** Ocupa todo el ancho (modo lectura) en vez de convivir con el mapa. */
  expanded?: boolean;
  onToggleExpand?: () => void;
  onNavigate: (ref: string) => void;
  onClose: () => void;
  className?: string;
}) {
  const id = nodeIdOf(nodeRef);
  const graphNode = useMemo<ZeusGraphNode | null>(() => graph?.nodes.find((n) => n.ref === nodeRef) ?? null, [graph, nodeRef]);
  // Entidad derivada: no hay nada que pedir. La clave privada evita cachear un "null" bajo /zeus/nodes.
  const detail = useApi<ZeusNodeDetail | null>(() => (id ? zeusApi.node(id) : Promise.resolve(null)), [id ?? ''], id ? { key: `${NODES_KEY}/detail`, ttl: 20_000 } : {});
  const org = useZeusOrg();
  const act = useAction();
  const [tab, setTab] = useState<Tab>('contenido');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', summary: '', body: '' });
  const [preview, setPreview] = useState(false);
  const [options, setOptions] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [reimporting, setReimporting] = useState(false);

  const node = id ? detail.data : null;
  const title = node?.title ?? graphNode?.title ?? 'Nodo';
  const kind = node?.kind ?? graphNode?.kind ?? 'doc';
  const km = kindMeta(kind);
  const edges = useMemo(() => (id ? node?.edges ?? [] : edgesFromGraph(graph, nodeRef)), [id, node, graph, nodeRef]);
  const owner = node?.ownerDevId ? org.data?.members.find((m) => m.devId === node.ownerDevId) : null;
  const meta = (node?.meta ?? graphNode?.meta ?? {}) as Record<string, unknown>;
  const str = (k: string): string | null => (typeof meta[k] === 'string' && meta[k] ? (meta[k] as string) : null);
  const entityId = nodeRef.slice(nodeRef.indexOf(':') + 1);
  const reviewDue = !!node?.reviewAfter && isPastDay(node.reviewAfter);
  const isGit = node?.source === 'git';
  const doc = useMemo(() => splitFrontmatter(node?.body ?? ''), [node?.body]);
  const projectTitle = (node?.projectId ?? graphNode?.projectId) ? graph?.nodes.find((n) => n.ref === `project:${node?.projectId ?? graphNode?.projectId}`)?.title ?? node?.projectKey ?? 'Proyecto' : null;

  // Otro nodo: se vuelve al contenido y se descarta cualquier edición a medias.
  useEffect(() => {
    setTab(id ? 'contenido' : 'conexiones');
    setEditing(false);
    setPreview(false);
  }, [nodeRef, id]);

  // Esc cierra el lector (o cancela la edición), salvo que haya un diálogo abierto encima.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      if (editing) setEditing(false);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, onClose]);

  const startEdit = () => {
    if (!node) return;
    setDraft({ title: node.title, summary: node.summary, body: node.body });
    setPreview(false);
    setTab('contenido');
    setEditing(true);
  };
  const saveEdit = () => {
    if (!node || !draft.title.trim()) return;
    void act.run('reader-save', () => zeusApi.updateNode(node.id, { title: draft.title.trim(), summary: draft.summary.trim(), body: draft.body }), {
      success: 'Cambios guardados',
      error: 'No se pudo guardar',
      onDone: () => {
        invalidateNodes();
        detail.reload();
        setEditing(false);
      },
    });
  };
  const reimport = () => {
    if (!node) return;
    setReimporting(false);
    void act.run('reimport', () => zeusApi.reimportNode(node.id), {
      success: 'Versión del repo aplicada',
      error: 'No se pudo traer la versión del repo',
      onDone: () => {
        invalidateNodes();
        detail.reload();
      },
    });
  };
  const removeEdge = (e: ZeusNodeEdge) =>
    void act.run(`unlink:${e.id}`, () => zeusApi.deleteEdge(e.id), { success: 'Conexión quitada', error: 'No se pudo quitar la conexión', onDone: invalidateNodes });

  const tabs: Array<{ value: Tab; label: string; count?: number }> = [
    ...(id ? [{ value: 'contenido' as const, label: 'Contenido' }] : []),
    { value: 'conexiones', label: 'Conexiones', count: edges.length },
    ...(node && node.revisions.length ? [{ value: 'historial' as const, label: 'Historial', count: node.revisions.length }] : []),
  ];

  return (
    <article key={nodeRef} className={cn('zeus-reader flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card', className)} aria-label={`Detalle: ${title}`}>
      {/* Cabecera: una franja con el tono del tipo y las acciones de ventana. */}
      <header className="relative border-b">
        <span className={cn('absolute inset-y-0 left-0 w-1', km.tone.dot)} />
        <div className="flex items-start gap-3 py-4 pl-6 pr-3">
          <div className="grid min-w-0 flex-1 gap-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold', km.tone.chip)}>
                <km.icon className="size-3" /> {km.label}
              </span>
              {(node ?? graphNode) && (node ?? graphNode)!.source !== 'derived' && <StatusBadge status={(node ?? graphNode)!.status} />}
              {(node ?? graphNode)?.pinned && <Badge variant="brand"><Pin className="size-3" /> Fijada</Badge>}
              {reviewDue && <Badge variant="human"><CalendarClock className="size-3" /> Por revisar</Badge>}
              {typeof meta.online === 'boolean' && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><OnlineDot online={meta.online} /> {meta.online ? 'En línea' : 'Sin conexión'}</span>
              )}
            </div>
            {editing ? (
              <div className="grid gap-2">
                <Input value={draft.title} maxLength={200} autoFocus onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} aria-label="Título" className="text-base font-semibold" />
                <Input value={draft.summary} maxLength={280} onChange={(e) => setDraft((d) => ({ ...d, summary: e.target.value }))} aria-label="En una línea" placeholder="En una línea: qué dice y cuándo aplica" fieldSize="sm" />
              </div>
            ) : (
              <>
                <h2 className="break-words text-[22px] font-semibold leading-[1.15] tracking-[-0.03em]">{title}</h2>
                {(node?.summary || graphNode?.summary) && <p className="max-w-[70ch] text-sm leading-relaxed text-muted-foreground">{node?.summary || graphNode?.summary}</p>}
              </>
            )}
            {isGit && (node!.sourceRepo || node!.sourcePath) && (
              <p className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
                <GitBranch className="size-3 shrink-0 text-faint" />
                <span className="truncate">{[node!.sourceRepo, node!.sourcePath].filter(Boolean).join(' · ')}</span>
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {onToggleExpand && (
              <Button variant="ghost" size="icon-sm" className="size-8 text-muted-foreground max-lg:hidden" onClick={onToggleExpand} aria-label={expanded ? 'Volver a la vista dividida' : 'Leer a todo lo ancho'} title={expanded ? 'Volver a la vista dividida' : 'Leer a todo lo ancho'}>
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" className="size-8 text-muted-foreground" onClick={onClose} aria-label="Cerrar el detalle" title="Cerrar (Esc)"><X /></Button>
          </div>
        </div>

        {/* Acciones: la principal depende de dónde vive el texto. */}
        <div className="flex flex-wrap items-center gap-1.5 pb-3 pl-6 pr-3">
          {editing ? (
            <>
              <Button size="sm" onClick={saveEdit} disabled={!draft.title.trim() || act.busy('reader-save')}>
                {act.busy('reader-save') ? <Loader2 className="animate-spin" /> : <Check />} Guardar
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setEditing(false)} disabled={act.busy('reader-save')}>Cancelar</Button>
              <Button size="sm" variant="ghost" onClick={() => setPreview((p) => !p)}>{preview ? 'Seguir escribiendo' : 'Vista previa'}</Button>
            </>
          ) : (
            <>
              {node && <Button size="sm" variant="brand" onClick={startEdit}><Pencil /> Editar</Button>}
              <Button size="sm" variant="secondary" onClick={() => setConnecting(true)}><Waypoints /> Conectar</Button>
              {isGit && (
                <Button size="sm" variant="secondary" onClick={() => setReimporting(true)} disabled={act.busy('reimport')}>
                  {act.busy('reimport') ? <Loader2 className="animate-spin" /> : <IntegrationIcon name="github" size="sm" />} Traer versión del repo
                </Button>
              )}
              {isGit && node!.sourceUrl && (
                <Button asChild size="sm" variant="ghost">
                  <a href={node!.sourceUrl} target="_blank" rel="noreferrer noopener">Ver en el repo <ExternalLink /></a>
                </Button>
              )}
              {node && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setOptions(true)}><Settings2 /> Más opciones</Button>
                  {node.status !== 'archived' && <Button size="sm" variant="ghost" onClick={() => setArchiving(true)}><Archive /> Archivar</Button>}
                </>
              )}
              {kind === 'dev' && <Button asChild size="sm" variant="secondary"><Link to={to.developer(entityId)}>Ver perfil</Link></Button>}
              {kind === 'project' && <Button asChild size="sm" variant="secondary"><Link to={to.proyecto(entityId)}>Ver proyecto</Link></Button>}
            </>
          )}
        </div>
      </header>

      {id && detail.loading ? (
        <div className="grid gap-3 p-6">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : id && !node ? (
        <div className="p-6"><ErrorCard message={detail.error ?? 'No se pudo abrir esta entrada.'} /></div>
      ) : !node && !graphNode ? (
        <EmptyState>Este nodo ya no está en el mapa.</EmptyState>
      ) : (
        <>
          {/* Ficha: una tira de celdas, no una columna de pares que se lleve media pantalla. */}
          <dl className="grid shrink-0 grid-cols-2 gap-px border-b bg-border sm:grid-cols-4">
            {node ? (
              <>
                <Cell label="Alcance">{projectTitle ?? 'Toda la organización'}</Cell>
                <Cell label="Dueño">{owner?.name ?? (node.ownerDevId ? 'Fuera del organigrama' : 'Sin dueño')}</Cell>
                <Cell label="Origen">{isGit ? 'Importada de un repo' : 'Escrita en zeus'}</Cell>
                <Cell label="Actualizado"><span title={dateTime(node.updatedAt)}>{ago(node.updatedAt)}</span> <span className="font-normal text-faint">· v{node.version}</span></Cell>
              </>
            ) : (
              <>
                {str('role') && <Cell label="Rol">{str('role')}</Cell>}
                {str('githubLogin') && <Cell label="GitHub"><GithubHandle login={str('githubLogin')!} /></Cell>}
                {str('key') && <Cell label="Clave"><span className="font-mono text-xs">{str('key')}</span></Cell>}
                {kind === 'repo' && <Cell label="Repo" className="col-span-2"><span className="font-mono text-xs">{entityId}</span></Cell>}
                {projectTitle && kind !== 'project' && <Cell label="Proyecto">{projectTitle}</Cell>}
                <Cell label="Conexiones">{edges.length}</Cell>
                {graphNode?.updatedAt && <Cell label="Actualizado">{ago(graphNode.updatedAt)}</Cell>}
              </>
            )}
          </dl>

          <div className="flex shrink-0 items-center gap-5 border-b px-6" role="tablist" aria-label="Secciones del detalle">
            {tabs.map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={tab === t.value}
                onClick={() => setTab(t.value)}
                className={cn(
                  '-mb-px flex h-10 items-center gap-1.5 border-b-2 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  tab === t.value ? 'border-orange text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                {t.count != null && <span className="rounded-full bg-panel px-1.5 text-[10.5px] tabular-nums text-muted-foreground">{t.count}</span>}
              </button>
            ))}
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            {tab === 'contenido' && node && (
              <div className="mx-auto grid w-full max-w-[86ch] grid-cols-[minmax(0,1fr)] gap-6 px-6 py-6">
                {editing ? (
                  preview ? (
                    <Markdown className="zeus-prose">{draft.body || '*Sin contenido.*'}</Markdown>
                  ) : (
                    <Textarea
                      value={draft.body}
                      onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                      rows={22}
                      maxRows={60}
                      aria-label="Contenido en Markdown"
                      placeholder={'## Contexto\n\n…'}
                      className="font-mono text-[13px] leading-relaxed"
                    />
                  )
                ) : (
                  <>
                    {doc.front && (
                      <Disclosure
                        className="overflow-hidden rounded-lg border"
                        summaryClassName="rounded-none bg-sidebar px-4 py-2.5 text-[13px] font-semibold"
                        defaultOpen={!doc.text.trim()}
                        summary={<>Datos estructurados<span className="label-caps">{doc.front.split('\n').length} líneas · YAML</span></>}
                      >
                        <pre className="scroll-thin max-h-[60dvh] overflow-auto border-t bg-terminal px-4 py-3 font-mono text-[12px] leading-relaxed text-terminal-foreground">{doc.front}</pre>
                      </Disclosure>
                    )}
                    {doc.text.trim() ? (
                      <Markdown className="zeus-prose">{doc.text}</Markdown>
                    ) : doc.front ? null : (
                      <EmptyState>Sin contenido: solo el título y su línea.</EmptyState>
                    )}
                    <section className="grid gap-2 border-t pt-5">
                      <h3 className="label-caps text-muted-foreground">Contexto para el agente</h3>
                      <Overlay node={node} />
                      {isGit && (
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          Este documento se importó de su repo y ahora vive en zeus: lo que edites aquí es lo que leen el equipo y sus agentes. El repo ya no lo pisa; si quieres su versión, usa «Traer versión del repo».
                        </p>
                      )}
                    </section>
                  </>
                )}
              </div>
            )}

            {tab === 'conexiones' && (
              <div className="px-6 py-6">
                <Connections edges={edges} busy={(eid) => act.busy(`unlink:${eid}`)} onNavigate={onNavigate} onRemove={removeEdge} />
              </div>
            )}

            {tab === 'historial' && node && (
              <ol className="mx-auto grid w-full max-w-[86ch] px-6 py-6">
                {node.revisions.map((r, i) => (
                  <li key={r.version} className="relative flex gap-4 pb-5 last:pb-0">
                    {i < node.revisions.length - 1 && <span className="absolute left-[13px] top-7 h-full w-px bg-border" />}
                    <span className="z-[1] grid size-7 shrink-0 place-items-center rounded-full border bg-card font-mono text-[10.5px] text-muted-foreground">v{r.version}</span>
                    <div className="grid min-w-0 gap-0.5 pt-1">
                      <p className="text-[13px]">
                        <span className="font-semibold">{r.editedByName ?? (r.editedVia === 'git' ? 'git' : 'Alguien')}</span>
                        <span className="text-muted-foreground"> por {viaLabel(r.editedVia)}</span>
                      </p>
                      {r.title !== node.title && <p className="truncate text-xs text-muted-foreground">Se llamaba "{r.title}"</p>}
                      <p className="text-[11px] tabular-nums text-faint" title={dateTime(r.createdAt)}>{ago(r.createdAt)} · {shortDate(r.createdAt)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}

      {node && <NodeDialog open={options} node={node} onClose={() => setOptions(false)} onSaved={() => detail.reload()} />}
      <ArchiveNodeDialog node={archiving && node ? node : null} onClose={() => setArchiving(false)} onArchived={onClose} />
      <ConnectDialog source={connecting ? { ref: nodeRef, title } : null} onClose={() => setConnecting(false)} />
      <AlertDialog open={reimporting} onOpenChange={(v) => !v && setReimporting(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Traer la versión del repo</AlertDialogTitle>
            <AlertDialogDescription>
              El título, la línea y el contenido de <span className="font-medium text-foreground">{title}</span> se reemplazan por lo que hay hoy en{' '}
              <span className="font-mono text-xs">{node?.sourceRepo}</span>. Lo que se editó en zeus queda en el historial; etiquetas, estado y conexiones no cambian.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={reimport}>Traer versión</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
