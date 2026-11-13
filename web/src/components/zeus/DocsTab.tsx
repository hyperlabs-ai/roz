// Pestaña "Documentos": la estantería de zeus. A la izquierda la matriz proyectos × tipos (cada
// documento es un punto); a la derecha las entradas de lo que esté fijado en la matriz, agrupadas.
// Al abrir una entrada, el lector queda adjunto: la matriz se compacta y la lista le hace de índice.
//
// Los documentos salen de `/nodes` (todos: la matriz los necesita completos; el estado se filtra
// aquí). Con texto se usa `/search`, acotada a la celda fijada, que además trae el recorte donde
// coincidió. Toda la vista vive en la URL: `?p=&k=&estado=&q=&doc=&leer=`.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarClock, ChevronRight, GitBranch, Pin, Plus, Search, X } from 'lucide-react';
import { ErrorCard, RefreshButton } from '@/components/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { isPastDay } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { cn } from '@/lib/utils';
import {
  ZEUS_NODE_KINDS, ZEUS_NODE_STATUSES, nodeIdOf, zeusApi,
  type ZeusNodeKind, type ZeusNodeStatus, type ZeusNodeSummary, type ZeusSearchHit,
} from '@/lib/zeus';
import { DocGlyph, DocsShelf, ORG, type ShelfPick, type ShelfRow } from './DocsShelf';
import { NODES_KEY, useZeusGraph, useZeusProjects } from './hooks';
import { NodeDialog } from './NodeDialogs';
import { Reader } from './Reader';
import { STATUS_META, ago, kindMeta } from './zeus-ui';

const ANY = '__todos__';
/** Sin celda fijada la lista es un resumen: unas cuantas por grupo y el resto a un clic. */
const PEEK = 4;
const GROUP_CAP = 14;

/** Fila común a `/nodes` y `/search` (el resultado de búsqueda trae menos campos y un recorte). */
interface Row {
  id: string;
  kind: ZeusNodeKind;
  title: string;
  summary: string;
  projectId: string | null;
  status: ZeusNodeStatus;
  source: 'manual' | 'git';
  pinned: boolean;
  reviewAfter: string | null;
  tags: string[];
  updatedAt: string;
  snippet: string | null;
}

const fromSummary = (n: ZeusNodeSummary): Row => ({ ...n, snippet: null });
const fromHit = (h: ZeusSearchHit): Row => ({ ...h, reviewAfter: null, tags: [], snippet: h.snippet });

interface Group {
  id: string;
  label: string;
  kind?: string;
  rows: Row[];
  /** Fijar este grupo en la matriz (para ver todas sus entradas). */
  narrow?: ShelfPick;
}

/**
 * El recorte puede traer la coincidencia marcada con `<b>…</b>` (así lo hace `ts_headline`). Se
 * parte por esas marcas y se pinta con elementos de React: nunca se inyecta HTML del servidor.
 */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<b>.*?<\/b>)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^<b>(.*)<\/b>$/.exec(p);
        return m ? <mark key={i} className="rounded-[2px] bg-yellow-soft px-0.5 text-yellow-ink">{m[1]}</mark> : <span key={i}>{p}</span>;
      })}
    </>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function EntryRow({ row, context, selected, onOpen }: { row: Row; context: ReactNode; selected: boolean; onOpen: () => void }) {
  const due = !!row.reviewAfter && isPastDay(row.reviewAfter);
  const meta = !!context || row.status !== 'active' || due || row.tags.length > 0;
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected || undefined}
        data-doc={row.id}
        className={cn(
          'flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'bg-orange-soft' : 'hover:bg-panel',
        )}
      >
        <DocGlyph kind={row.kind} status={row.status} pinned={row.pinned} large className="mt-[5px]" />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn('truncate text-[13px] font-medium', selected && 'text-orange-ink')}>{row.title}</span>
            {row.pinned && <Pin className="size-3 shrink-0 text-orange" aria-label="Fijado: se carga siempre en el contexto del agente" />}
            {due && <CalendarClock className="size-3 shrink-0 text-yellow" aria-label="Ya pasó su fecha de revisión" />}
            <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 text-[10.5px] tabular-nums text-faint">
              {row.source === 'git' && <GitBranch className="size-2.5" aria-label="Indexado desde git" />}
              {ago(row.updatedAt).replace('hace ', '')}
            </span>
          </span>
          {(row.snippet || row.summary) && (
            <span className={cn('text-[11.5px] leading-snug text-muted-foreground', row.snippet ? 'line-clamp-2' : 'truncate')}>
              {row.snippet ? <Snippet text={row.snippet} /> : row.summary}
            </span>
          )}
          {meta && (
            <span className="flex min-w-0 items-center gap-x-2 overflow-hidden whitespace-nowrap text-[10.5px] text-faint">
              {context}
              {row.status !== 'active' && <span className="shrink-0 font-semibold text-muted-foreground">{STATUS_META[row.status]?.label ?? row.status}</span>}
              {due && <span className="shrink-0 font-semibold text-yellow-ink">Por revisar</span>}
              {row.tags.slice(0, 3).map((t) => <span key={t} className="truncate">#{t}</span>)}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

export function DocsTab() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('doc');
  const reading = params.get('leer') === '1';
  const p = params.get('p');
  const k = params.get('k');
  const estado = params.get('estado');
  const patch = useCallback(
    (changes: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, v] of Object.entries(changes)) {
            if (v === null || v === '') next.delete(key);
            else next.set(key, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const setOpen = useCallback((id: string | null) => patch(id ? { doc: id } : { doc: null, leer: null }), [patch]);

  const graph = useZeusGraph(null);
  const projects = useZeusProjects();
  const [text, setText] = useState(() => params.get('q') ?? '');
  const q = useDebounced(text.trim(), 280);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // La búsqueda viaja en la URL (ya asentada, no cada tecla) para poder compartir el resultado.
  useEffect(() => {
    patch({ q: q || null });
  }, [q, patch]);

  // Atajo `/` para enfocar la búsqueda (mismo patrón que el mapa).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || t?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const all = useApi<ZeusNodeSummary[]>(() => zeusApi.nodes({}).then((r) => r.nodes), [], { key: NODES_KEY, ttl: 20_000 });
  const nodes = useMemo(() => all.data ?? [], [all.data]);

  const projectName = useMemo(() => {
    const m = new Map<string, string>(projects.map((x) => [x.id, x.name]));
    // Un proyecto que el grafo aún no trae se nombra por su clave antes que quedar anónimo.
    for (const n of nodes) if (n.projectId && !m.has(n.projectId) && n.projectKey) m.set(n.projectId, n.projectKey);
    return (key: string | null): string => (!key || key === ORG ? 'Organización' : m.get(key) ?? 'Proyecto');
  }, [projects, nodes]);

  /** Filas de la matriz: los proyectos con documentos, por volumen, más la organización. */
  const shelfRows = useMemo<ShelfRow[]>(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) counts.set(n.projectId ?? ORG, (counts.get(n.projectId ?? ORG) ?? 0) + 1);
    const keys = new Set(counts.keys());
    keys.add(ORG);
    // Sin documentos todavía: la estantería se dibuja igual, con los proyectos que zeus conoce.
    if (nodes.length === 0) for (const x of projects.slice(0, 11)) keys.add(x.id);
    return [...keys]
      .map((key) => ({ key, label: projectName(key) }))
      .sort((a, b) => (counts.get(b.key) ?? 0) - (counts.get(a.key) ?? 0) || Number(a.key === ORG) - Number(b.key === ORG) || a.label.localeCompare(b.label, 'es'));
  }, [nodes, projects, projectName]);

  const kinds = useMemo<string[]>(() => {
    const present = new Set(nodes.map((n) => n.kind));
    const list = ZEUS_NODE_KINDS.filter((x) => present.has(x));
    return list.length ? list : [...ZEUS_NODE_KINDS];
  }, [nodes]);

  // Un filtro que ya no existe (enlace viejo, proyecto sin documentos) se ignora en vez de vaciar la vista.
  const vp = p && (all.loading || shelfRows.some((r) => r.key === p)) ? p : null;
  const vk = k && (ZEUS_NODE_KINDS as readonly string[]).includes(k) && (all.loading || kinds.includes(k)) ? (k as ZeusNodeKind) : null;
  const statusParam = estado && (ZEUS_NODE_STATUSES as readonly string[]).includes(estado) ? (estado as ZeusNodeStatus) : null;
  const pick = useMemo<ShelfPick>(() => ({ p: vp, k: vk }), [vp, vk]);

  const searching = q.length >= 2;
  // "Organización" no es un proyecto: el API filtra por uuid, así que ese caso se acota aquí.
  const projectParam = vp && vp !== ORG ? vp : null;
  const found = useApi<{ hits: ZeusSearchHit[] | null }>(
    () => (searching ? zeusApi.search(q, { projectId: projectParam, kinds: vk ? [vk] : undefined }).then((r) => ({ hits: r.hits })) : Promise.resolve({ hits: null })),
    [searching ? q : '', searching ? vk ?? '' : '', searching ? projectParam ?? '' : ''],
    searching ? { key: `${NODES_KEY}/search`, ttl: 20_000 } : {},
  );
  const hits = searching ? found.data?.hits ?? null : null;

  const rows = useMemo<Row[]>(() => {
    const base = hits
      ? hits.map(fromHit).filter((r) => (vp === ORG ? r.projectId === null : true))
      : searching
        ? []
        : nodes.filter((n) => (!vp || (n.projectId ?? ORG) === vp) && (!vk || n.kind === vk)).map(fromSummary);
    // `/search` no filtra por estado: se aplica sobre sus resultados.
    return statusParam ? base.filter((r) => r.status === statusParam) : base;
  }, [hits, searching, nodes, vp, vk, statusParam]);

  /** Lo que sigue encendido en la matriz cuando hay búsqueda o filtro de estado. */
  const lit = useMemo<Set<string> | null>(() => {
    if (!statusParam && !hits) return null;
    const hitIds = hits ? new Set(hits.map((h) => h.id)) : null;
    const out = new Set<string>();
    for (const n of nodes) {
      if (statusParam && n.status !== statusParam) continue;
      // La búsqueda va acotada a lo fijado: fuera de ahí no se sabe, así que no se apaga.
      const inScope = (!vp || (n.projectId ?? ORG) === vp) && (!vk || n.kind === vk);
      if (hitIds && inScope && !hitIds.has(n.id)) continue;
      out.add(n.id);
    }
    return out;
  }, [nodes, hits, statusParam, vp, vk]);

  const groups = useMemo<Group[]>(() => {
    const bucket = (keyOf: (r: Row) => string): Map<string, Row[]> => {
      const m = new Map<string, Row[]>();
      for (const r of rows) {
        const key = keyOf(r);
        const b = m.get(key);
        if (b) b.push(r);
        else m.set(key, [r]);
      }
      return m;
    };
    if (vp && vk && !searching) {
      // Una celda: se lee por vigencia.
      const m = bucket((r) => (r.status === 'active' ? (r.pinned ? 'pin' : 'active') : r.status === 'draft' ? 'draft' : 'off'));
      const labels: Array<[string, string]> = [['pin', 'Fijados'], ['active', 'Vigentes'], ['draft', 'Borradores'], ['off', 'Reemplazados y archivados']];
      return labels.filter(([id]) => m.has(id)).map(([id, label]) => ({ id, label, rows: m.get(id)! }));
    }
    if (vp && !vk) {
      const m = bucket((r) => r.kind);
      return ZEUS_NODE_KINDS.filter((x) => m.has(x)).map((x) => ({ id: x, label: kindMeta(x).plural, kind: x, rows: m.get(x)!, narrow: { p: vp, k: x } }));
    }
    const m = bucket((r) => r.projectId ?? ORG);
    return [...m.entries()]
      .sort((a, b) => b[1].length - a[1].length || projectName(a[0]).localeCompare(projectName(b[0]), 'es'))
      .map(([key, list]) => ({ id: key, label: projectName(key), rows: list, narrow: { p: key, k: vk } }));
  }, [rows, vp, vk, searching, projectName]);

  // Sin nada fijado la lista es un vistazo por proyecto; con fila o columna, algo más; la celda, completa.
  const cap = searching || (vp && vk) ? Infinity : vp || vk ? GROUP_CAP : PEEK;

  const stats = useMemo(
    () => ({
      pinned: rows.filter((r) => r.pinned).length,
      due: rows.filter((r) => r.reviewAfter && isPastDay(r.reviewAfter)).length,
      git: rows.filter((r) => r.source === 'git').length,
    }),
    [rows],
  );

  // El documento abierto queda a la vista en la lista (al llegar por enlace o desde una conexión).
  useEffect(() => {
    if (!openId) return;
    listRef.current?.querySelector(`[data-doc="${CSS.escape(openId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [openId, rows.length]);

  const filtered = !!(vp || vk || statusParam || text);
  const clear = () => {
    setText('');
    patch({ p: null, k: null, estado: null, q: null });
  };
  const onPick = useCallback((next: ShelfPick) => patch({ p: next.p, k: next.k }), [patch]);

  const scopeTitle = vp && vk ? `${projectName(vp)} · ${kindMeta(vk).plural}` : vp ? projectName(vp) : vk ? kindMeta(vk).plural : 'Toda la biblioteca';
  const listLoading = all.loading || (searching && found.loading);
  const stage = 'lg:h-[calc(100dvh-var(--shell-top,196px)-var(--shell-pad-b,0px)-44px)] lg:min-h-[560px]';

  const shelf = (
    <DocsShelf
      rows={shelfRows}
      kinds={kinds}
      docs={nodes}
      lit={lit}
      pick={pick}
      openId={openId}
      loading={all.loading}
      onPick={onPick}
      className={cn('max-lg:max-h-[70dvh]', stage)}
    />
  );

  const list = (
    <Card className={cn('flex min-h-0 flex-col overflow-hidden max-lg:max-h-[80dvh]', stage)}>
      <header className="grid shrink-0 gap-1.5 border-b px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <span className="label-caps">{searching ? `Resultados de "${q}"` : 'En la estantería'}</span>
            <h2 className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold leading-tight tracking-[-0.01em]">
              <span className="truncate">{scopeTitle}</span>
              {(vp || vk) && (
                <button type="button" onClick={() => patch({ p: null, k: null })} aria-label="Soltar el filtro de la matriz" title="Ver toda la biblioteca" className="grid size-5 shrink-0 place-items-center rounded-sm text-faint hover:bg-panel hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              )}
            </h2>
          </div>
          <span className={cn('text-[26px] font-semibold leading-none tracking-[-0.04em] tabular-nums', rows.length ? 'text-orange' : 'text-faint')}>{listLoading ? '–' : rows.length}</span>
        </div>
        <p className={cn('flex flex-wrap gap-x-3 text-[11.5px] tabular-nums text-muted-foreground', listLoading && 'invisible')}>
          <span><b className="font-semibold text-foreground">{stats.pinned}</b> {stats.pinned === 1 ? 'fijado' : 'fijados'}</span>
          <span><b className="font-semibold text-foreground">{stats.git}</b> desde git</span>
          <span><b className="font-semibold text-foreground">{rows.length - stats.git}</b> escritos en zeus</span>
          {stats.due > 0 && <span className="text-yellow-ink"><b className="font-semibold">{stats.due}</b> por revisar</span>}
        </p>
      </header>

      <div ref={listRef} className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5 transition-opacity duration-200', (all.refetching || found.refetching) && 'opacity-60')}>
        {listLoading ? (
          <ul className="grid gap-px pt-1.5" aria-busy="true">
            {Array.from({ length: 9 }, (_, i) => (
              <li key={i} className="bib-ghost flex items-start gap-2.5 px-2 py-2" style={{ animationDelay: `${i * 70}ms` }}>
                <span className="mt-1 size-2 shrink-0 rounded-full bg-panel" />
                <span className="grid flex-1 gap-1.5">
                  <span className="h-2.5 rounded-full bg-panel" style={{ width: `${48 + ((i * 29) % 40)}%` }} />
                  <span className="h-2 w-[86%] rounded-full bg-panel" />
                </span>
              </li>
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <div className="grid gap-3 px-2 pt-3">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {all.error && !all.data
                ? 'No se pudieron cargar los documentos.'
                : searching
                  ? `Nada coincide con "${q}"${vp || vk ? ' en esta parte de la estantería' : ''}.`
                  : nodes.length === 0
                    ? 'Zeus aún no tiene documentos. Los de git llegan solos al vincular un repo; lo demás se crea aquí.'
                    : statusParam
                      ? 'Ninguna entrada con ese estado aquí.'
                      : 'Esta celda está vacía.'}
            </p>
            {!searching && !(all.error && !all.data) && (
              <Button variant="secondary" size="sm" className="justify-self-start" onClick={() => setCreating(true)}>
                <Plus /> {nodes.length === 0 ? 'Crear la primera' : 'Crear una aquí'}
              </Button>
            )}
            {/* La lista conserva su forma aunque no haya nada: renglones por llenar. */}
            <ul className="grid gap-1.5 pt-1" aria-hidden>
              {Array.from({ length: 5 }, (_, i) => <li key={i} className="h-11 rounded-md border border-dashed" />)}
            </ul>
          </div>
        ) : (
          groups.map((g) => {
            const shown = g.rows.slice(0, cap);
            const rest = g.rows.length - shown.length;
            const canNarrow = !!g.narrow && !(g.narrow.p === vp && g.narrow.k === vk);
            const head = (
              <>
                {g.kind && <span className={cn('size-2 shrink-0 rounded-full', kindMeta(g.kind).tone.dot)} />}
                <span className="label-caps truncate text-muted-foreground">{g.label}</span>
                <span className="label-caps tabular-nums">{g.rows.length}</span>
              </>
            );
            return (
              <section key={g.id} className="grid grid-cols-[minmax(0,1fr)]">
                {canNarrow ? (
                  <button type="button" onClick={() => onPick(g.narrow!)} title={`Ver solo ${g.label}`} className="group/g sticky top-0 z-[1] flex items-center gap-2 bg-card px-2 pb-1.5 pt-3 text-left focus-visible:outline-none">
                    {head}
                    <ChevronRight className="ml-auto size-3.5 shrink-0 text-faint transition-transform group-hover/g:translate-x-0.5 group-hover/g:text-foreground" />
                  </button>
                ) : (
                  <h3 className="sticky top-0 z-[1] flex items-center gap-2 bg-card px-2 pb-1.5 pt-3">{head}</h3>
                )}
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-px">
                  {shown.map((r) => (
                    <EntryRow
                      key={r.id}
                      row={r}
                      selected={r.id === openId}
                      onOpen={() => setOpen(r.id)}
                      // El grupo ya dice el proyecto (o el tipo); aquí solo lo que falte.
                      context={!vp && !vk ? <span className="shrink-0">{kindMeta(r.kind).label}</span> : null}
                    />
                  ))}
                </ul>
                {rest > 0 && canNarrow && (
                  <button type="button" onClick={() => onPick(g.narrow!)} className="mx-2 mb-1 mt-0.5 justify-self-start rounded-sm text-[11.5px] font-medium text-muted-foreground hover:text-orange-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Ver las {g.rows.length}
                  </button>
                )}
              </section>
            );
          })
        )}
      </div>
    </Card>
  );

  const reader = openId ? (
    <Reader
      nodeRef={`node:${openId}`}
      graph={graph.data}
      expanded={reading}
      onToggleExpand={() => patch({ leer: reading ? null : '1' })}
      onClose={() => setOpen(null)}
      onNavigate={(ref) => {
        const id = nodeIdOf(ref);
        if (id) {
          setOpen(id);
          return;
        }
        // Una persona, proyecto, repo o PC no es un documento: se abre en el mapa.
        const next = new URLSearchParams();
        next.set('nodo', ref);
        setParams(next);
      }}
      className={cn('max-lg:min-h-[70dvh]', stage)}
    />
  ) : null;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={searchRef}
          fieldSize="sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            // Con texto, Esc solo lo limpia (y no cierra el lector que esté abierto al lado).
            if (text) e.stopPropagation();
            setText('');
          }}
          placeholder="Buscar en el contenido…"
          aria-label="Buscar documentos"
          leading={<Search />}
          trailing={text ? (
            <button type="button" onClick={() => { setText(''); searchRef.current?.focus(); }} aria-label="Limpiar búsqueda" className="grid size-6 place-items-center rounded-sm text-faint hover:text-foreground">
              <X className="size-3.5" />
            </button>
          ) : (
            <kbd className="rounded-sm border px-1 text-[10.5px] text-faint">/</kbd>
          )}
          wrapperClassName="w-full sm:w-80"
        />
        <Select value={statusParam ?? ANY} onValueChange={(v) => patch({ estado: v === ANY ? null : v })}>
          <SelectTrigger aria-label="Estado" className={cn('h-8 w-full text-[13px] sm:w-44', statusParam && 'border-orange/40 bg-orange-soft text-orange-ink')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Todos los estados</SelectItem>
            {ZEUS_NODE_STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>)}
          </SelectContent>
        </Select>
        {filtered && <Button variant="ghost" size="sm" onClick={clear}>Limpiar</Button>}
        <div className="ml-auto flex items-center gap-2">
          {all.data && <span className="label-caps tabular-nums">{nodes.length} {nodes.length === 1 ? 'entrada' : 'entradas'}</span>}
          <RefreshButton busy={all.refetching || found.refetching} onClick={() => { all.reload(); if (searching) found.reload(); }} />
          <Button variant="brand" size="sm" onClick={() => setCreating(true)}><Plus /> Nueva entrada</Button>
        </div>
      </div>

      {all.error && <ErrorCard message={all.error} />}
      {searching && found.error && <ErrorCard message={found.error} />}

      {reader ? (
        // Leyendo: la matriz se compacta (solo en pantallas anchas), la lista hace de índice y el
        // lector queda adjunto. A todo lo ancho, solo el lector.
        <div className={cn('grid gap-3', !reading && 'lg:grid-cols-[320px_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_320px_minmax(560px,46%)]')}>
          {!reading && <div className="max-2xl:hidden">{shelf}</div>}
          {!reading && <div className="max-lg:hidden">{list}</div>}
          {reader}
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_380px]">
          {shelf}
          {list}
        </div>
      )}

      <NodeDialog
        open={creating}
        defaultKind={vk ?? undefined}
        defaultProjectId={projectParam}
        onClose={() => setCreating(false)}
        onSaved={(n) => setOpen(n.id)}
      />
    </div>
  );
}
