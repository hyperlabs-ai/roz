// Geometría del mapa de zeus. Módulo PURO (sin React ni DOM) para poder probarlo desde la raíz
// (test/zeus-layout.test.ts). Una sola disposición, el radial POR ZONAS: el centro, un anillo de
// categorías y, hacia afuera, el sector de cada una con sus entradas en filas concéntricas. El mismo
// dibujo sirve en cada nivel de la navegación (zeus → tipo → proyecto → entradas): solo cambian las
// zonas que se le pasan.
//
// Es determinista a propósito (sin simulación de fuerzas ni azar): la misma entrada da siempre las
// mismas coordenadas, así que un sondeo que trae el mismo grafo no mueve nada en pantalla.

export interface LayoutNode {
  ref: string;
  kind: string;
  title: string;
  projectId: string | null;
}

export interface LayoutEdge {
  id: string;
  src: string;
  dst: string;
  kind: string;
}

export type PlacedRole = 'center' | 'category' | 'entry' | 'outer';

export interface Placed {
  id: string;
  x: number;
  y: number;
  /** Radio con el que se dibuja (y con el que se calcula que nada se encime). */
  r: number;
  role: PlacedRole;
  kind: string;
  /** 0 = centro, 1 = categoría (o entrada, si hay una sola zona), 2 = entrada, 3 = anillo exterior. */
  layer: number;
  /** Por dónde viaja un pulso hacia el centro. null en la raíz. */
  parent: string | null;
  /** Ángulo (rad) respecto al centro, en la vista por zonas: orienta las etiquetas radiales. */
  angle?: number;
}

export interface PlacedLink {
  id: string;
  from: string;
  to: string;
  kind: string;
  /** true = esqueleto del dibujo (centro–categoría); false = arista real del grafo. */
  structural: boolean;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface GraphLayout {
  mode: 'zones';
  rootId: string;
  nodes: Placed[];
  byId: Map<string, Placed>;
  links: PlacedLink[];
  bounds: Bounds;
}

export const CENTER_ID = 'zeus';
export const categoryId = (kind: string): string => `cat:${kind}`;

/** Orden fijo de las categorías alrededor del centro: conocimiento primero, luego gente y máquinas. */
export const KIND_ORDER = ['adr', 'spec', 'change', 'doc', 'design', 'rule', 'resource', 'team', 'project', 'dev', 'repo', 'runner'];

const byTitle = (a: LayoutNode, b: LayoutNode): number => a.title.localeCompare(b.title, 'es') || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

const round = (v: number): number => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- vista por zonas

export interface ZoneGroup {
  /** Id de la zona (`k:<tipo>` o `p:<proyecto>`): es el id del nodo de categoría en el dibujo. */
  id: string;
  kind: string;
  entries: LayoutNode[];
}

export interface ZoneSector {
  id: string;
  kind: string;
  count: number;
  /** Arco de la zona (rad). */
  a0: number;
  a1: number;
  mid: number;
  /** Banda radial que ocupan sus entradas. */
  rIn: number;
  rOut: number;
}

export interface ZoneLayout extends GraphLayout {
  mode: 'zones';
  sectors: ZoneSector[];
  /** Radios de los discos de fondo, de afuera hacia adentro. */
  discs: number[];
  /** true = un solo anillo con espacio para el título de cada entrada, escrito en radial. */
  labelled: boolean;
  /** Radio donde viven las categorías (0 si hay una sola zona). */
  orbit: number;
}

export interface ZoneInput {
  centerId: string;
  centerKind: string;
  groups: ZoneGroup[];
  /** Elementos del anillo exterior (p. ej. proyectos): solo se colocan, parejos, alrededor. */
  outer?: Array<{ id: string; kind: string }>;
  edges?: LayoutEdge[];
}

const Z_CENTER_R = 32;
const Z_CAT_R = 17;
const Z_ENTRY_R = 5.5;
const Z_ROW = 19;
const Z_SPACING = 17;
/** Aire angular a cada lado de una zona (rad). */
const Z_PAD = 0.045;
const Z_LABEL_MAX = 96;
/** Ancho de la banda de nombres de zona (del centro de la categoría a la primera fila de entradas). */
export const Z_LABEL_BAND = 98;
const Z_LABEL_SPACING = 15;
const TAU = Math.PI * 2;

/** Cuántas entradas caben en una fila de radio `r` dentro de una zona de ancho `theta`. */
function rowCap(theta: number, r: number, pad: number): number {
  const arc = (theta - 2 * pad) * r;
  return arc <= 0 ? 1 : Math.max(1, Math.floor(arc / Z_SPACING) + 1);
}

function zoneCap(theta: number, r0: number, rows: number, pad: number): number {
  let c = 0;
  for (let j = 0; j < rows; j++) c += rowCap(theta, r0 + j * Z_ROW, pad);
  return c;
}

/** Ancho angular mínimo para que `n` entradas quepan en `rows` filas. */
function needAngle(n: number, r0: number, rows: number, pad: number): number {
  if (n <= 0) return 2 * pad;
  let sum = 0;
  for (let j = 0; j < rows; j++) sum += r0 + j * Z_ROW;
  let theta = Math.max(2 * pad, ((n - rows) * Z_SPACING) / sum + 2 * pad);
  for (let guard = 0; guard < 2000 && zoneCap(theta, r0, rows, pad) < n; guard++) theta += 0.004;
  return theta;
}

/**
 * Vista radial POR ZONAS. El centro, un anillo de categorías y, hacia afuera, la zona de cada una:
 * un sector cuyo ancho es proporcional a lo que contiene, con sus entradas en filas concéntricas.
 * Todas las zonas terminan a la misma profundidad, así que el dibujo es un disco y no una flor
 * desigual. Determinista: la misma entrada da las mismas coordenadas.
 */
export function zoneLayout(input: ZoneInput): ZoneLayout {
  const groups = input.groups.filter((g) => g.entries.length > 0);
  const G = groups.length;
  const placed: Placed[] = [{ id: input.centerId, x: 0, y: 0, r: Z_CENTER_R, role: 'center', kind: input.centerKind, layer: 0, parent: null }];
  const links: PlacedLink[] = [];
  const sectors: ZoneSector[] = [];
  const total = groups.reduce((s, g) => s + g.entries.length, 0);

  const single = G === 1;
  const labelled = single && total <= Z_LABEL_MAX;
  const orbit = single ? 0 : Math.max(108, (G * 44) / TAU);
  const pad = single ? 0 : Math.min(Z_PAD, TAU / Math.max(1, G) / 8);
  // Entre el anillo de categorías y las entradas queda una banda libre: ahí va el nombre de cada zona.
  let r0 = single ? 92 : orbit + Z_LABEL_BAND;
  if (labelled) r0 = Math.max(120, (total * Z_LABEL_SPACING) / TAU);

  // Profundidad común: la menor cantidad de filas con la que todas las zonas caben en la vuelta.
  const minAngle = single ? TAU : Math.min(0.44, (TAU / Math.max(1, G)) * 0.62);
  let rows = 1;
  let angles: number[] = [];
  if (single) {
    if (!labelled) while (zoneCap(TAU, r0, rows, 0) < total && rows < 80) rows++;
    angles = [TAU];
  } else if (G > 0) {
    for (; rows < 80; rows++) {
      angles = groups.map((g) => Math.max(minAngle, needAngle(g.entries.length, r0, rows, pad)));
      if (angles.reduce((a, b) => a + b, 0) <= TAU) break;
    }
    const sum = angles.reduce((a, b) => a + b, 0);
    // El sobrante se reparte en proporción: las zonas grandes respiran más.
    angles = angles.map((a) => (a * TAU) / sum);
  }
  const rMax = r0 + (rows - 1) * Z_ROW;

  let cursor = G ? -Math.PI / 2 - angles[0]! / 2 : 0;
  groups.forEach((g, i) => {
    const theta = angles[i]!;
    const a0 = cursor;
    const a1 = cursor + theta;
    const mid = (a0 + a1) / 2;
    cursor = a1;
    const entries = [...g.entries].sort(byTitle);
    const n = entries.length;
    sectors.push({ id: g.id, kind: g.kind, count: n, a0, a1, mid, rIn: r0 - 14, rOut: rMax + 14 });

    let parent = input.centerId;
    if (!single) {
      parent = g.id;
      placed.push({ id: g.id, x: round(Math.cos(mid) * orbit), y: round(Math.sin(mid) * orbit), r: Z_CAT_R, role: 'category', kind: g.kind, layer: 1, parent: input.centerId, angle: mid });
      links.push({ id: `s:${input.centerId}>${g.id}`, from: input.centerId, to: g.id, kind: 'category', structural: true });
    }

    // Filas que usa ESTA zona y cuántas entradas van en cada una (más afuera caben más).
    let used = 1;
    while (used < rows && zoneCap(theta, r0, used, pad) < n) used++;
    const caps = Array.from({ length: used }, (_, j) => (single ? Math.max(1, Math.floor((TAU * (r0 + j * Z_ROW)) / Z_SPACING)) : rowCap(theta, r0 + j * Z_ROW, pad)));
    const weight = caps.reduce((a, b) => a + b, 0);
    const counts = caps.map((c) => Math.min(c, Math.floor((n * c) / weight)));
    let left = n - counts.reduce((a, b) => a + b, 0);
    for (let guard = 0; left > 0 && guard < 100_000; guard++) {
      const j = guard % used;
      // Tras una vuelta completa sin hueco se acepta pasarse: nunca se pierde una entrada.
      if (counts[j]! < caps[j]! || guard >= used * 4) {
        counts[j]!++;
        left--;
      }
    }

    let k = 0;
    counts.forEach((count, j) => {
      if (!count) return;
      const r = r0 + j * Z_ROW;
      const avail = Math.max(0, theta - 2 * pad);
      // Compacto alrededor del eje de la zona: no se estira a todo el arco si no hace falta.
      const step = single ? TAU / count : count > 1 ? Math.min(avail / (count - 1), (Z_SPACING * 1.7) / r) : 0;
      const start = single ? -Math.PI / 2 + (j % 2 ? step / 2 : 0) : mid - (step * (count - 1)) / 2;
      for (let m = 0; m < count; m++, k++) {
        const e = entries[k]!;
        const t = start + m * step;
        placed.push({ id: e.ref, x: round(Math.cos(t) * r), y: round(Math.sin(t) * r), r: Z_ENTRY_R, role: 'entry', kind: e.kind, layer: single ? 1 : 2, parent, angle: t });
      }
    });
  });

  const discOuter = (G ? rMax : Z_CENTER_R + 60) + 26;
  const outer = input.outer ?? [];
  const rOuter = discOuter + 22;
  outer.forEach((o, i) => {
    const t = -Math.PI / 2 + ((i + 0.5) / outer.length) * TAU;
    placed.push({ id: o.id, x: round(Math.cos(t) * rOuter), y: round(Math.sin(t) * rOuter), r: 3.5, role: 'outer', kind: o.kind, layer: 3, parent: null, angle: t });
  });

  const ids = new Set(placed.map((p) => p.id));
  const seen = new Set<string>();
  for (const e of input.edges ?? []) {
    if (seen.has(e.id) || e.src === e.dst || !ids.has(e.src) || !ids.has(e.dst)) continue;
    seen.add(e.id);
    links.push({ id: e.id, from: e.src, to: e.dst, kind: e.kind, structural: false });
  }

  const byId = new Map(placed.map((p) => [p.id, p]));
  // Las etiquetas radiales (anillo exterior, entradas con título) necesitan margen fuera del disco.
  const reach = discOuter + (outer.length || labelled ? 150 : 24);
  const discs = single ? [discOuter, Z_CENTER_R + 30] : [discOuter, r0 - 22, Math.max(Z_CENTER_R + 22, orbit - 40)];
  return {
    mode: 'zones',
    rootId: input.centerId,
    nodes: placed,
    byId,
    links,
    bounds: { minX: -reach, minY: -reach, maxX: reach, maxY: reach },
    sectors,
    discs,
    labelled,
    orbit,
  };
}

/** Camino de un nodo hasta la raíz (él incluido). Vacío si el nodo no está en el dibujo. */
export function pathToRoot(layout: GraphLayout, id: string): Placed[] {
  const out: Placed[] = [];
  let cur = layout.byId.get(id);
  // El tope evita un ciclo si algún día `parent` se arma mal.
  for (let guard = 0; cur && guard < 8; guard++) {
    out.push(cur);
    cur = cur.parent ? layout.byId.get(cur.parent) : undefined;
  }
  return out;
}

export interface ViewTransform {
  x: number;
  y: number;
  k: number;
}

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 4;
export const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** Transformación que encaja `bounds` centrado en un lienzo de `width`×`height`. */
export function fitTransform(bounds: Bounds, width: number, height: number, maxK = 1.4): ViewTransform {
  const w = Math.max(1, bounds.maxX - bounds.minX);
  const h = Math.max(1, bounds.maxY - bounds.minY);
  const k = clampZoom(Math.min(width / w, height / h, maxK));
  return {
    k,
    x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * k,
    y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * k,
  };
}

/** Zoom alrededor de un punto del lienzo (el cursor o el centro de un pellizco): ese punto no se mueve. */
export function zoomAt(t: ViewTransform, px: number, py: number, factor: number): ViewTransform {
  const k = clampZoom(t.k * factor);
  const f = k / t.k;
  return { k, x: px - (px - t.x) * f, y: py - (py - t.y) * f };
}
