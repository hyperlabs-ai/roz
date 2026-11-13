// Pestaña "Mapa": el tablero de zeus. El lienzo (isométrico o plano) ocupa TODO el tablero y los
// instrumentos flotan encima en vidrio: a la izquierda el nivel actual (sus zonas, o sus entradas al
// llegar al fondo); a la derecha el estado del alcance y la actividad en vivo. Se navega bajando: zeus → tipo → proyecto → entradas (o al revés, con la lente
// "por proyecto"). Al elegir una entrada, los rieles ceden su lugar al lector, adjunto al mapa.
//
// Toda la vista vive en la URL (`?lente=&k=&p=&nodo=&leer=`) para poder compartir "mira este ADR".
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, ChevronRight, CircleDot, Network, Plus, Radio, Search, X } from 'lucide-react';
import { EmptyState, ErrorCard, RefreshButton } from '@/components/bits';
import { Segmented } from '@/components/pulse/roz-v2';
import { fold } from '@/components/projects/project-ui';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { usePrefersReducedMotion } from '@/lib/motion';
import { usePoll } from '@/lib/usePoll';
import { cn } from '@/lib/utils';
import { zeusApi, type ZeusActivityEvent, type ZeusGraphNode, type ZeusNodeKind } from '@/lib/zeus';
import { useZeusGraph } from './hooks';
import { KIND_ORDER, zoneLayout, type LayoutNode, type ZoneGroup } from './layout';
import { IsoCanvas } from './IsoCanvas';
import { HudCard, LeaderRow, Mix, Neon, Pips, Skyline, Timeline, TimelineItem, Waffle, toneVar } from './MapHud';
import { NodeDialog } from './NodeDialogs';
import { Reader } from './Reader';
import { ZoneCanvas, type ZoneCanvasHandle, type ZoneInfo } from './ZoneCanvas';
import { STATUS_META, TONES, ago, describeActivity, kindMeta, zoneTone, type Tone } from './zeus-ui';

type Lens = 'tipo' | 'proyecto';
const ORG = 'org';
const LIST_CAP = 120;
/** Alto del tablero: toda la pantalla bajo el chrome de la app (el shell publica cuánto mide). */
const STAGE_H = 'lg:h-[calc(100dvh-var(--shell-top,196px)-var(--shell-pad-b,0px))] lg:min-h-[640px]';
/** Lo que tapan los instrumentos flotantes a cada lado: el lienzo encuadra en el hueco que dejan. */
const HUD_INSET = { left: 308, right: 312 };
const MAX_ZONES = 12;
const OTHERS = '__otros__';
/** Acciones que cambian el grafo: al verlas pasar, el mapa se vuelve a pedir. */
const MUTATING = /create|write|update|edit|archive|delete|link|sync|ingest/i;
const SAVED_KINDS = new Set(['adr', 'spec', 'change', 'doc', 'design', 'rule', 'resource', 'team']);

const haystack = (n: ZeusGraphNode): string => fold(`${n.title} ${n.summary} ${kindMeta(n.kind).label}`);
const projectKeyOf = (n: ZeusGraphNode): string => n.projectId ?? ORG;

// ---------------------------------------------------------------- actividad en vivo

/**
 * Sondea `/activity` mientras la pestaña se ve. Cada evento nuevo con `ref` dispara un pulso en el
 * lienzo (por el handle imperativo: no pasa por el estado de React) y entra a la lista.
 */
function useLiveActivity(graphRef: RefObject<ZoneCanvasHandle>, onMutation: () => void) {
  const [events, setEvents] = useState<ZeusActivityEvent[]>([]);
  const [down, setDown] = useState(false);
  const since = useRef<string | null>(null);
  const lastId = useRef(0);
  const first = useRef(true);
  const inflight = useRef(false);
  const alive = useRef(true);
  const timers = useRef<number[]>([]);
  const onMutationRef = useRef(onMutation);
  onMutationRef.current = onMutation;

  const poll = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const res = await zeusApi.activity(since.current);
      if (!alive.current) return;
      setDown(false);
      const serverNow = new Date(res.now).getTime();
      since.current = res.now;
      const fresh = res.events.filter((e) => e.id > lastId.current).sort((a, b) => a.id - b.id);
      if (!fresh.length) return;
      lastId.current = fresh[fresh.length - 1]!.id;
      setEvents((prev) => [...[...fresh].reverse(), ...prev].slice(0, 24));

      // La primera respuesta trae historia: solo lo de los últimos segundos merece un pulso, o al
      // abrir la pestaña el mapa entero parpadearía por cosas que pasaron hace una hora.
      const toPulse = first.current ? fresh.filter((e) => serverNow - new Date(e.at).getTime() < 15_000) : fresh;
      const wasFirst = first.current;
      first.current = false;
      toPulse.slice(-12).forEach((e, i) => {
        if (!e.ref) return;
        timers.current.push(window.setTimeout(() => graphRef.current?.pulse(e.ref!), i * 240));
      });
      if (!wasFirst && fresh.some((e) => MUTATING.test(e.action))) onMutationRef.current();
    } catch {
      if (alive.current) setDown(true);
    } finally {
      inflight.current = false;
    }
  }, [graphRef]);

  useEffect(() => {
    alive.current = true;
    void poll();
    const pending = timers.current;
    return () => {
      alive.current = false;
      pending.forEach((t) => window.clearTimeout(t));
    };
  }, [poll]);
  // `usePoll` ya se detiene con la pestaña oculta y retoma al volver.
  usePoll(() => void poll(), 5_000, { onFocus: 'always' });

  return { events, down };
}

// ---------------------------------------------------------------- pestaña

export function MapTab() {
  const [params, setParams] = useSearchParams();
  const lens: Lens = params.get('lente') === 'proyecto' ? 'proyecto' : 'tipo';
  const k = params.get('k');
  const p = params.get('p');
  const selected = params.get('nodo');
  /** Dentro de la zona "Otros": la cola larga de proyectos chicos. */
  const more = params.get('mas') === '1';
  const reading = params.get('leer') === '1';
  /** Isométrico por defecto; `?vista=plano` deja el radial visto desde arriba. */
  const flat = params.get('vista') === 'plano';
  // Cambiar de nivel, de lente o de documento es NAVEGAR: entra al historial, así el botón Atrás del
  // navegador deshace el último paso dentro del mapa en vez de sacarte de él. Solo los ajustes de vista
  // (isométrico/plano, leer a lo ancho) reemplazan la entrada actual.
  const patch = useCallback(
    (changes: Record<string, string | null>) => {
      const replace = Object.keys(changes).every((key) => key === 'vista' || key === 'leer');
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, v] of Object.entries(changes)) {
            if (v === null) next.delete(key);
            else next.set(key, v);
          }
          return next;
        },
        { replace },
      );
    },
    [setParams],
  );

  const reduced = usePrefersReducedMotion();
  // Los instrumentos flotan sobre el lienzo solo en pantallas anchas; abajo de eso van apilados.
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    const m = window.matchMedia('(min-width: 1024px)');
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  const [q, setQ] = useState('');
  const [hotZone, setHotZone] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const canvas = useRef<ZoneCanvasHandle>(null);

  const { data: graph, loading, refetching, error, reload } = useZeusGraph(null);
  const live = useLiveActivity(canvas, reload);

  // Atajo `/` para enfocar la búsqueda (mismo patrón que Proyectos y Developers).
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

  const byRef = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.ref, n])), [graph]);
  const projectNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of graph?.nodes ?? []) if (n.kind === 'project') m.set(n.ref.slice(n.ref.indexOf(':') + 1), n.title);
    return m;
  }, [graph]);
  const projectLabel = useCallback((key: string) => (key === ORG ? 'Organización' : projectNames.get(key) ?? 'Proyecto'), [projectNames]);

  // Un filtro que ya no existe (proyecto archivado, enlace viejo) se ignora en vez de dejar el mapa vacío.
  const entries = useMemo(() => (graph?.nodes ?? []).filter((n) => n.kind !== 'project'), [graph]);
  const vk = k && entries.some((n) => n.kind === k) ? k : null;
  const vp = p && entries.some((n) => projectKeyOf(n) === p) ? p : null;

  const scope = useMemo(() => entries.filter((n) => (!vk || n.kind === vk) && (!vp || projectKeyOf(n) === vp)), [entries, vk, vp]);
  const groupBy: 'k' | 'p' | null = lens === 'tipo' ? (!vk ? 'k' : !vp ? 'p' : null) : !vp ? 'p' : !vk ? 'k' : null;
  const atRoot = !vk && !vp && !more;

  /** Zonas del nivel: su id, su nombre, su tono y lo que contienen. */
  const zones = useMemo(() => {
    const buckets = new Map<string, ZeusGraphNode[]>();
    for (const n of scope) {
      const key = groupBy === 'k' ? n.kind : groupBy === 'p' ? projectKeyOf(n) : 'all';
      const b = buckets.get(key);
      if (b) b.push(n);
      else buckets.set(key, [n]);
    }
    let keys = [...buckets.keys()];
    if (groupBy === 'k') {
      const rank = (x: string) => (KIND_ORDER.indexOf(x) === -1 ? 99 : KIND_ORDER.indexOf(x));
      keys.sort((a, b) => rank(a) - rank(b));
    } else {
      keys.sort((a, b) => buckets.get(b)!.length - buckets.get(a)!.length || projectLabel(a).localeCompare(projectLabel(b), 'es'));
      // Treinta proyectos de una entrada cada uno no son treinta zonas: la cola larga se junta en
      // "Otros", que al abrirse muestra esos proyectos como zonas propias.
      if (groupBy === 'p' && keys.length > MAX_ZONES) {
        if (more) keys = keys.slice(MAX_ZONES - 1);
        else {
          const rest = keys.slice(MAX_ZONES - 1).flatMap((key) => buckets.get(key)!);
          keys = [...keys.slice(0, MAX_ZONES - 1), OTHERS];
          buckets.set(OTHERS, rest);
        }
      }
    }
    return keys.map((key, i) => {
      const nodes = buckets.get(key)!;
      const info: ZoneInfo =
        groupBy === 'k'
          ? { label: kindMeta(key).plural, tone: kindMeta(key).tone }
          : groupBy === 'p'
            ? { label: key === OTHERS ? 'Otros' : projectLabel(key), tone: key === OTHERS ? TONES.neutral : zoneTone(i) }
            : { label: vk ? kindMeta(vk).plural : 'Entradas', tone: vk ? kindMeta(vk).tone : TONES.orange };
      return { id: groupBy ? `${groupBy}:${key}` : 'all', key, kind: groupBy === 'k' ? key : groupBy === 'p' ? 'project' : vk ?? 'doc', info, nodes };
    });
  }, [scope, groupBy, projectLabel, vk, more]);

  // Una sola zona no es un nivel: es ya la lista de entradas (p. ej. un tipo que vive en un solo proyecto).
  const leaf = !groupBy || zones.length <= 1;

  const zoneInfo = useMemo(() => new Map(zones.map((z) => [z.id, z.info])), [zones]);
  const toneOfEntry = useMemo(() => {
    const m = new Map<string, Tone>();
    for (const z of zones) for (const n of z.nodes) m.set(n.ref, z.info.tone);
    return m;
  }, [zones]);

  // Anillo exterior: en la raíz por tipo, los proyectos que tienen algo. Dice de quién es cada entrada.
  const outer = useMemo(() => {
    if (!atRoot || lens !== 'tipo') return [];
    const withStuff = new Set(scope.map((n) => n.projectId).filter(Boolean) as string[]);
    return [...withStuff]
      .sort((a, b) => projectLabel(a).localeCompare(projectLabel(b), 'es'))
      .map((id) => ({ id: `project:${id}`, kind: 'project' }));
  }, [atRoot, lens, scope, projectLabel]);
  const outerIds = useMemo(() => new Set(outer.map((o) => o.id)), [outer]);
  const outerOf = useCallback(
    (id: string): string | null => {
      const n = byRef.get(id);
      const ref = n?.projectId && n.kind !== 'project' ? `project:${n.projectId}` : null;
      return ref && outerIds.has(ref) ? ref : null;
    },
    [byRef, outerIds],
  );

  // El layout solo depende del grafo y del nivel: ni la selección, ni el filtro de texto, ni un pulso
  // lo recalculan.
  const layout = useMemo(() => {
    const toLayout = (n: ZeusGraphNode): LayoutNode => ({ ref: n.ref, kind: n.kind, title: n.title, projectId: n.projectId });
    const groups: ZoneGroup[] = zones.map((z) => ({ id: z.id, kind: z.kind, entries: z.nodes.map(toLayout) }));
    return zoneLayout({
      centerId: 'zeus',
      centerKind: 'zeus',
      groups,
      outer,
      edges: (graph?.edges ?? []).map((e) => ({ id: e.id, src: e.src, dst: e.dst, kind: e.kind })),
    });
  }, [zones, outer, graph]);

  const dimmed = useMemo(() => {
    const needle = fold(q.trim());
    if (!needle) return null;
    return new Set(scope.filter((n) => !haystack(n).includes(needle)).map((n) => n.ref));
  }, [scope, q]);

  // ---------------------------------------------------------------- navegación

  const crumbs = useMemo(() => {
    type Crumb = { label: string; clear: Record<string, string | null> };
    const out: Crumb[] = [{ label: 'zeus', clear: { k: null, p: null } }];
    const kCrumb: Crumb | null = vk ? { label: kindMeta(vk).plural, clear: lens === 'tipo' ? { p: null } : {} } : null;
    const pCrumb: Crumb | null = vp ? { label: projectLabel(vp), clear: lens === 'proyecto' ? { k: null } : {} } : null;
    for (const c of lens === 'tipo' ? [kCrumb, pCrumb] : [pCrumb, kCrumb]) if (c) out.push(c);
    if (more && groupBy === 'p') {
      out[out.length - 1]!.clear = { ...out[out.length - 1]!.clear, mas: null };
      out.push({ label: 'Otros', clear: {} });
    }
    return out;
  }, [vk, vp, lens, projectLabel, more, groupBy]);

  const openZone = useCallback(
    (zoneId: string) => {
      const [dim, ...rest] = zoneId.split(':');
      const key = rest.join(':');
      if (key === OTHERS) patch({ mas: '1' });
      else if (dim === 'k' || dim === 'p') patch({ [dim]: key, mas: null });
    },
    [patch],
  );
  const up = useCallback(() => {
    const order: Array<'k' | 'p'> = lens === 'tipo' ? ['p', 'k'] : ['k', 'p'];
    const last = order.find((d) => (d === 'k' ? vk : vp));
    if (more && groupBy === 'p') patch({ mas: null });
    else if (last) patch({ [last]: null });
  }, [lens, vk, vp, more, groupBy, patch]);
  const select = useCallback((ref: string) => patch({ nodo: ref }), [patch]);
  const openOuter = useCallback((id: string) => patch({ p: id.slice(id.indexOf(':') + 1) }), [patch]);
  const closeReader = useCallback(() => patch({ nodo: null, leer: null }), [patch]);

  // Zonas HERMANAS de la que está abierta: para saltar de lado (de un proyecto a otro, de un tipo a
  // otro) sin tener que subir y volver a bajar.
  const lastDim: 'k' | 'p' | null = lens === 'tipo' ? (vp ? 'p' : vk ? 'k' : null) : vk ? 'k' : vp ? 'p' : null;
  const siblings = useMemo(() => {
    if (!lastDim) return [];
    const counts = new Map<string, number>();
    for (const n of entries) {
      if (lastDim === 'k' ? vp && projectKeyOf(n) !== vp : vk && n.kind !== vk) continue;
      const key = lastDim === 'k' ? n.kind : projectKeyOf(n);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const keys = [...counts.keys()];
    if (lastDim === 'k') keys.sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
    else keys.sort((a, b) => counts.get(b)! - counts.get(a)! || projectLabel(a).localeCompare(projectLabel(b), 'es'));
    return keys.map((key, i) => ({ key, count: counts.get(key)!, label: lastDim === 'k' ? kindMeta(key).plural : projectLabel(key), tone: lastDim === 'k' ? kindMeta(key).tone : zoneTone(i) }));
  }, [entries, lastDim, vk, vp, projectLabel]);
  const currentSibling = lastDim === 'k' ? vk : vp;
  const jump = useCallback(
    (step: number) => {
      if (!lastDim || siblings.length < 2) return;
      const i = siblings.findIndex((x) => x.key === currentSibling);
      const next = siblings[(i + step + siblings.length) % siblings.length]!;
      patch({ [lastDim]: next.key, mas: null });
    },
    [lastDim, siblings, currentSibling, patch],
  );
  // ← → saltan entre zonas hermanas; ↑ sube un nivel. No actúan al escribir ni con un diálogo abierto.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || selected || t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (e.key === 'ArrowRight') jump(1);
      else if (e.key === 'ArrowLeft') jump(-1);
      else if (e.key === 'ArrowUp') up();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jump, up, selected]);

  // ---------------------------------------------------------------- cifras del alcance

  const stats = useMemo(() => {
    const refs = new Set(scope.map((n) => n.ref));
    const degree = new Map<string, number>();
    let edges = 0;
    for (const e of graph?.edges ?? []) {
      const a = refs.has(e.src);
      const b = refs.has(e.dst);
      if (!a && !b) continue;
      edges++;
      if (a) degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
      if (b) degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
    }
    const saved = scope.filter((n) => SAVED_KINDS.has(n.kind));
    const status = { active: 0, draft: 0, superseded: 0, archived: 0 } as Record<string, number>;
    for (const n of saved) status[n.status] = (status[n.status] ?? 0) + 1;
    const hubs = [...degree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ref, d]) => ({ node: byRef.get(ref)!, degree: d }))
      .filter((h) => h.node);
    return {
      entries: scope.length,
      edges,
      pinned: scope.filter((n) => n.pinned).length,
      online: scope.filter((n) => (n.kind === 'dev' || n.kind === 'runner') && n.meta?.online === true).length,
      status,
      git: saved.filter((n) => n.source === 'git').length,
      manual: saved.filter((n) => n.source === 'manual').length,
      ofProject: saved.filter((n) => n.projectId).length,
      ofOrg: saved.filter((n) => !n.projectId).length,
      hubs,
      degree,
    };
  }, [scope, graph, byRef]);

  const recent = useMemo(
    () => scope.filter((n) => SAVED_KINDS.has(n.kind) && n.updatedAt).sort((a, b) => (a.updatedAt! < b.updatedAt! ? 1 : -1)).slice(0, 14),
    [scope],
  );

  const results = useMemo(() => {
    const needle = fold(q.trim());
    if (!needle) return null;
    return entries.filter((n) => haystack(n).includes(needle)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title, 'es'));
  }, [entries, q]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, []);

  const hasNodes = entries.length > 0;
  const Canvas = flat ? ZoneCanvas : IsoCanvas;
  const fitKey = `${flat ? 'p' : 'i'}|${lens}|${vk ?? ''}|${vp ?? ''}|${more ? 1 : 0}|${hasNodes ? 1 : 0}|${selected ? 1 : 0}|${reading ? 1 : 0}`;

  if (loading) {
    return (
      <Skeleton className={cn('h-[62dvh] rounded-xl', STAGE_H)} />
    );
  }

  if (!graph) {
    return (
      <div className="grid gap-3">
        <ErrorCard message={error ?? 'No se pudo cargar el mapa de zeus.'} />
        <Card><EmptyState icon={<Network />} action={<Button variant="secondary" size="sm" onClick={reload}>Reintentar</Button>}>El mapa no está disponible ahora mismo.</EmptyState></Card>
      </div>
    );
  }

  if (!hasNodes) {
    return (
      <Card>
        <EmptyState icon={<Network />} action={<Button variant="brand" size="sm" onClick={() => setCreating(true)}><Plus /> Nueva entrada</Button>}>
          Zeus todavía no tiene contexto. Vincula un repo con ADRs u OpenSpec (pestaña Acceso) o crea la primera entrada.
        </EmptyState>
        <NodeDialog open={creating} onClose={() => setCreating(false)} onSaved={(n) => select(n.ref)} />
      </Card>
    );
  }

  // ---------------------------------------------------------------- tablero

  const levelName = crumbs[crumbs.length - 1]!.label;
  const list = results ?? (leaf ? [...scope].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title, 'es')) : null);

  const leftHud = (
    <aside className="flex min-h-0 flex-col gap-2.5 lg:absolute lg:bottom-3 lg:left-3 lg:top-3 lg:w-[296px]" aria-label="Nivel del mapa">
      {/* Módulo 1 — dónde estoy y cuánto hay aquí. */}
      <div className="zeus-glass zeus-hud-card zeus-hud-head relative grid shrink-0 gap-3 overflow-hidden rounded-xl p-4">
        <nav className="flex min-h-5 flex-wrap items-center gap-1" aria-label="Ruta dentro del mapa">
          {crumbs.map((c, i) => {
            const lastCrumb = i === crumbs.length - 1;
            return (
              <span key={i} className="flex min-w-0 items-center gap-1">
                {i > 0 && <ChevronRight className="size-3 shrink-0 text-faint" />}
                <button
                  type="button"
                  disabled={lastCrumb}
                  onClick={() => patch(i === 0 ? { k: null, p: null, mas: null } : c.clear)}
                  className={cn('label-caps max-w-[130px] truncate rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', lastCrumb ? 'text-orange' : 'text-muted-foreground hover:text-foreground')}
                >
                  {c.label}
                </button>
              </span>
            );
          })}
        </nav>
        <div className="flex items-end justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <span className="zeus-numeral zeus-numeral-accent text-[46px] font-semibold leading-[0.9] tracking-[-0.05em] tabular-nums">{scope.length}</span>
            <span className="truncate text-[13px] text-muted-foreground">
              {leaf ? 'entradas' : <>entradas en <b className="font-semibold text-foreground">{zones.length}</b> zonas</>}
            </span>
          </div>
          <Button variant="brand" size="sm" className="shrink-0" onClick={() => setCreating(true)}><Plus /> Nueva</Button>
        </div>
      </div>

      {/* Módulo 2 — cómo lo miro y qué busco. */}
      <div className="zeus-glass zeus-hud-card grid shrink-0 gap-2.5 rounded-xl p-3">
        <Segmented
          value={lens}
          onChange={(v: Lens) => patch({ lente: v === 'tipo' ? null : v, k: null, p: null, mas: null })}
          options={[
            { value: 'tipo', label: 'Por tipo' },
            { value: 'proyecto', label: 'Por proyecto' },
          ]}
        />
        <Input
          ref={searchRef}
          fieldSize="sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQ('');
              e.currentTarget.blur();
            }
          }}
          placeholder="Buscar en zeus…"
          aria-label="Buscar en zeus"
          leading={<Search />}
          trailing={
            q ? (
              <button type="button" onClick={() => setQ('')} aria-label="Limpiar búsqueda" className="grid size-6 place-items-center rounded-sm text-faint hover:text-foreground"><X className="size-3.5" /></button>
            ) : (
              <kbd className="rounded-sm border px-1 text-[10.5px] text-faint">/</kbd>
            )
          }
        />
      </div>

      {list ? (
        /* Módulo 3 (fondo del mapa o búsqueda) — las entradas. */
        <HudCard title={results ? `${results.length} coincidencias` : levelName} className="flex min-h-[180px] flex-1 flex-col overflow-hidden !px-2">
          {list.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">Nada coincide con esa búsqueda.</p>
          ) : (
            <ul className="scroll-thin grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start overflow-y-auto">
              {list.slice(0, LIST_CAP).map((n) => (
                <LeaderRow
                  key={n.ref}
                  tone={results ? kindMeta(n.kind).tone : toneOfEntry.get(n.ref) ?? TONES.neutral}
                  label={n.title}
                  sub={n.summary || kindMeta(n.kind).label}
                  pinned={n.pinned}
                  diamond={n.pinned}
                  active={n.ref === selected}
                  onClick={() => select(n.ref)}
                />
              ))}
              {list.length > LIST_CAP && <li className="px-3 py-2 text-xs text-faint">Y {list.length - LIST_CAP} más: afina la búsqueda.</li>}
            </ul>
          )}
        </HudCard>
      ) : (
        <>
          {/* Módulo 3 — el nivel de frente: una columna por zona. */}
          <HudCard title={groupBy === 'p' ? 'Tamaño por proyecto' : 'Tamaño por tipo'} className="shrink-0">
            <Skyline
              items={zones.map((z) => ({ id: z.id, label: z.info.label, count: z.nodes.length, tone: z.info.tone }))}
              hot={hotZone}
              onHover={setHotZone}
              onOpen={openZone}
            />
          </HudCard>

          {/* Módulo 4 — el índice de zonas. */}
          <HudCard title="Zonas" meta={<span className="label-caps tabular-nums">{zones.length}</span>} className="flex min-h-[140px] flex-1 flex-col overflow-hidden !px-2 [&>header]:px-1.5">
            <ul className="scroll-thin grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start overflow-y-auto">
              {zones.map((z) => (
                <LeaderRow
                  key={z.id}
                  tone={z.info.tone}
                  label={z.info.label}
                  value={z.nodes.length}
                  active={hotZone === z.id}
                  chevron
                  onClick={() => openZone(z.id)}
                  onHover={(on) => setHotZone((cur) => (on ? z.id : cur === z.id ? null : cur))}
                />
              ))}
            </ul>
          </HudCard>

          {/* Módulo 5 — lo último que cambió en este nivel. */}
          {recent.length > 0 && (
            <HudCard title="Lo último que cambió" className="flex max-h-[30%] min-h-[128px] shrink-0 flex-col overflow-hidden">
              <Timeline className="scroll-thin -mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
                {recent.map((n) => (
                  <TimelineItem key={n.ref} token={toneVar(kindMeta(n.kind).tone)}>
                    <button type="button" onClick={() => select(n.ref)} className="grid min-w-0 gap-0.5 rounded-sm text-left hover:text-orange focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <span className="truncate text-[12.5px] font-medium leading-tight">{n.title}</span>
                      <span className="text-[10.5px] tabular-nums text-faint">{kindMeta(n.kind).label} · {ago(n.updatedAt, now)}</span>
                    </button>
                  </TimelineItem>
                ))}
              </Timeline>
            </HudCard>
          )}
        </>
      )}
    </aside>
  );

  const rightHud = (
    <aside className="scroll-none flex min-h-0 flex-col gap-2.5 lg:absolute lg:bottom-3 lg:right-3 lg:top-[52px] lg:w-[300px] lg:overflow-y-auto" aria-label="Estado del contexto">
      <HudCard className="shrink-0">
        <div className="zeus-hud-quad grid grid-cols-2">
          <Neon value={stats.edges} label="Conexiones" />
          <Neon value={stats.pinned} label="Fijadas" accent />
          <Neon value={stats.manual} label="Escritas aquí" />
          <Neon value={stats.online} label="En línea" />
        </div>
      </HudCard>

      <HudCard title="Vigencia" className="shrink-0">
        <Mix
          parts={[
            { label: STATUS_META.active.label, value: stats.status.active ?? 0, token: '--green' },
            { label: STATUS_META.draft.label, value: stats.status.draft ?? 0, token: '--purple' },
            { label: STATUS_META.superseded.label, value: stats.status.superseded ?? 0, token: '--yellow' },
            { label: STATUS_META.archived.label, value: stats.status.archived ?? 0, token: '--faint' },
          ]}
        />
      </HudCard>

      <HudCard title="De quién es" className="shrink-0">
        <Waffle
          a={{ label: 'de un proyecto', value: stats.ofProject, token: '--blue' }}
          b={{ label: 'de la organización', value: stats.ofOrg, token: '--orange' }}
        />
      </HudCard>

      {stats.hubs.length > 0 && (
        <HudCard title="Más conectadas" className="shrink-0">
          <ol className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
            {stats.hubs.map((h, i) => (
              <li key={h.node.ref} className="min-w-0">
                <button type="button" onClick={() => select(h.node.ref)} className="zeus-leader-row flex w-full items-center gap-2.5 rounded-md px-1 py-[5px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" style={{ '--c': `var(${toneVar(kindMeta(h.node.kind).tone)})` } as CSSProperties}>
                  <span className="w-3 shrink-0 text-[10.5px] font-semibold tabular-nums text-faint">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{h.node.title}</span>
                  <Pips n={Math.min(7, h.degree)} token={toneVar(kindMeta(h.node.kind).tone)} />
                </button>
              </li>
            ))}
          </ol>
        </HudCard>
      )}

      <HudCard
        title="Actividad en vivo"
        meta={<Radio className={cn('size-3.5', live.down ? 'text-faint' : 'animate-pulse text-orange')} />}
        className="flex min-h-[150px] flex-1 flex-col overflow-hidden"
      >
        {live.events.length === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground" aria-live="polite">
            {live.down ? 'Sin conexión con zeus; reintentando.' : 'Sin actividad reciente. Cuando alguien (o su agente) consulte zeus, lo verás pasar aquí y en el mapa.'}
          </p>
        ) : (
          <Timeline className="scroll-thin -mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
            {live.events.slice(0, 16).map((ev, i) => {
              const d = describeActivity(ev, ev.ref ? byRef.get(ev.ref)?.title ?? null : null);
              const known = !!ev.ref && byRef.has(ev.ref);
              const body = (
                <>
                  <span className="text-xs leading-snug">
                    <b className="font-semibold">{d.who}</b> <span className="text-muted-foreground">{d.verb}</span>
                    {d.what && <> <b className="font-medium">{d.what}</b></>}
                  </span>
                  <span className="text-[10.5px] tabular-nums text-faint">{ago(ev.at, now)}{d.who !== d.via && ` · por ${d.via}`}</span>
                </>
              );
              return (
                <TimelineItem key={ev.id} live={i === 0 && now - new Date(ev.at).getTime() < 60_000}>
                  {known ? (
                    <button type="button" onClick={() => select(ev.ref!)} className="grid gap-0.5 rounded-sm text-left hover:text-orange focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{body}</button>
                  ) : (
                    body
                  )}
                </TimelineItem>
              );
            })}
          </Timeline>
        )}
      </HudCard>
    </aside>
  );

  // Con el lector abierto el lienzo va solo (sin instrumentos): el lector ocupa su lugar.
  const solo = !!selected;
  const canvasEl = (
    <Canvas
      ref={canvas}
      weights={stats.degree}
      layout={layout}
      nodes={byRef}
      zones={zoneInfo}
      center={{ label: levelName, caption: String(scope.length), canGoUp: !atRoot }}
      outerOf={outerOf}
      projectNames={projectNames}
      selectedId={selected}
      dimmed={dimmed}
      hotZone={hotZone}
      fitKey={fitKey}
      inset={solo || !wide ? undefined : HUD_INSET}
      reducedMotion={reduced}
      onSelect={select}
      onOpenZone={openZone}
      onOpenOuter={openOuter}
      onUp={up}
      className="max-lg:h-[62dvh] max-lg:min-h-[420px] max-lg:rounded-xl lg:absolute lg:inset-0"
    />
  );

  const stage = (
    <div className={cn('dark zeus-board relative grid gap-3 overflow-hidden rounded-xl bg-background text-foreground lg:border', STAGE_H)}>
      {canvasEl}
      {/* Barra del lienzo: vista y refresco. */}
      <div className={cn('absolute top-3 z-10 flex items-center gap-2 max-lg:right-3', solo ? 'right-3' : 'lg:right-3')}>
        <Segmented
          value={flat ? 'plano' : 'iso'}
          onChange={(v: 'iso' | 'plano') => patch({ vista: v === 'plano' ? 'plano' : null })}
          options={[
            { value: 'iso', label: 'Isométrico', icon: <Box /> },
            { value: 'plano', label: 'Plano', icon: <CircleDot /> },
          ]}
        />
        <RefreshButton busy={refetching} onClick={reload} />
      </div>
      {/* Zonas hermanas: salto lateral sin subir de nivel. */}
      {!solo && siblings.length > 1 && (
        <nav
          className="zeus-glass scroll-none absolute top-3 z-10 flex items-center gap-1 overflow-x-auto rounded-lg p-1 max-lg:hidden"
          style={{ left: HUD_INSET.left + 96, maxWidth: `calc(100% - ${HUD_INSET.left + 96 + HUD_INSET.right + 8}px)` }}
          aria-label="Zonas del mismo nivel"
        >
          {siblings.map((x) => {
            const on = x.key === currentSibling;
            return (
              <button
                key={x.key}
                type="button"
                aria-current={on || undefined}
                data-on={on || undefined}
                onClick={() => lastDim && patch({ [lastDim]: x.key, mas: null })}
                style={{ '--c': `var(${toneVar(x.tone)})` } as CSSProperties}
                className="zeus-sibling flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="size-[7px] rounded-full" style={{ background: `hsl(var(${toneVar(x.tone)}))` }} />
                <span className="max-w-[130px] truncate">{x.label}</span>
                <span className="tabular-nums opacity-60">{x.count}</span>
              </button>
            );
          })}
        </nav>
      )}
      {/* Pie del lienzo: cómo se maneja y qué significa cada marca. */}
      <div
        className="pointer-events-none absolute bottom-3 z-10 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground max-lg:hidden"
        style={{ left: solo ? 12 : HUD_INSET.left + 8, right: solo ? 130 : HUD_INSET.right + 122 }}
      >
        <span>{flat ? 'Rueda para acercar' : 'Arrastra para girar · rueda para acercar'} · {!leaf ? 'clic en una zona para entrar' : 'clic en el centro para subir'}{siblings.length > 1 && ' · ← → cambian de zona'}</span>
        <span className="ml-auto flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-foreground/70" /> entrada</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rotate-45 rounded-[1px] bg-foreground/70" /> fijada</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full border border-foreground/70" /> borrador</span>
        </span>
      </div>
      {!solo && leftHud}
      {!solo && rightHud}
    </div>
  );

  return (
    <div className="grid gap-3">
      {error && <ErrorCard message={error} />}
      {selected ? (
        <div className={cn('grid gap-3', !reading && 'lg:grid-cols-[minmax(0,1fr)_minmax(520px,46%)]')}>
          {!reading && <div className="max-lg:hidden">{stage}</div>}
          <Reader
            nodeRef={selected}
            graph={graph}
            expanded={reading}
            onToggleExpand={() => patch({ leer: reading ? null : '1' })}
            onNavigate={select}
            onClose={closeReader}
            className={cn('max-lg:min-h-[70dvh]', STAGE_H)}
          />
        </div>
      ) : (
        stage
      )}
      <NodeDialog open={creating} defaultKind={(vk && SAVED_KINDS.has(vk) ? vk : undefined) as ZeusNodeKind | undefined} defaultProjectId={vp && vp !== ORG ? vp : null} onClose={() => setCreating(false)} onSaved={(n) => select(n.ref)} />
    </div>
  );
}
