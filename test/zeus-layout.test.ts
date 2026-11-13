import { describe, expect, it } from 'vitest';
import { fitTransform, pathToRoot, zoneLayout, zoomAt, type LayoutEdge, type LayoutNode, type ZoneGroup } from '../web/src/components/zeus/layout.js';

// La geometría del mapa de zeus (web/src/components/zeus/layout.ts) es un módulo PURO, y se prueba
// desde aquí por lo mismo que la caché: lo que importa no se ve en un render. Si el layout dejara de
// ser determinista, cada sondeo movería los nodos; si una entrada se saliera de su zona o dos se
// encimaran, el mapa sería ilegible justo cuando el equipo tiene más contexto cargado.

const KINDS = ['adr', 'spec', 'change', 'doc', 'design', 'rule', 'resource', 'team', 'dev', 'repo', 'runner', 'x1', 'x2', 'x3'];

/** `sizes[i]` entradas en la zona i. */
function makeGroups(sizes: number[]): ZoneGroup[] {
  return sizes.map((n, i) => ({
    id: `k:${KINDS[i]}`,
    kind: KINDS[i]!,
    entries: Array.from({ length: n }, (_, j): LayoutNode => ({ ref: `node:${KINDS[i]}-${j}`, kind: KINDS[i]!, title: `${KINDS[i]} ${String(j).padStart(3, '0')}`, projectId: j % 3 ? 'p1' : null })),
  }));
}

const build = (sizes: number[], extra: Partial<Parameters<typeof zoneLayout>[0]> = {}) =>
  zoneLayout({ centerId: 'zeus', centerKind: 'zeus', groups: makeGroups(sizes), ...extra });

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const TAU = Math.PI * 2;
/** Ángulo de `p` llevado al rango del sector que empieza en `a0`. */
const angleFrom = (p: { x: number; y: number }, a0: number) => {
  let a = Math.atan2(p.y, p.x);
  while (a < a0 - 1e-6) a += TAU;
  while (a >= a0 + TAU - 1e-6) a -= TAU;
  return a;
};

const CASES: Array<[string, number[]]> = [
  ['el volumen real del equipo', [31, 73, 126, 41, 13, 2, 8, 59]],
  ['dos zonas muy desiguales', [220, 1]],
  ['tres zonas parejas', [30, 30, 30]],
  ['catorce zonas de una entrada', Array.from({ length: 14 }, () => 1)],
  ['una grande y muchas chicas', [157, 41, 38, 32, 9, 8, 8, 7, 7, 5, 5, 28]],
];

describe('zeus · radial por zonas', () => {
  it('es determinista: misma entrada (con las entradas en cualquier orden) → mismas coordenadas', () => {
    const groups = makeGroups([14, 6, 3, 40, 2, 9]);
    const a = zoneLayout({ centerId: 'zeus', centerKind: 'zeus', groups });
    const b = zoneLayout({ centerId: 'zeus', centerKind: 'zeus', groups: groups.map((g) => ({ ...g, entries: [...g.entries].reverse() })) });
    expect(b.nodes.length).toBe(a.nodes.length);
    for (const n of a.nodes) {
      const m = b.byId.get(n.id)!;
      expect([m.x, m.y, m.r, m.parent]).toEqual([n.x, n.y, n.r, n.parent]);
    }
  });

  it.each(CASES)('coloca a todas las entradas, cada una colgando de su zona: %s', (_name, sizes) => {
    const l = build(sizes);
    expect(l.byId.get('zeus')).toMatchObject({ x: 0, y: 0, role: 'center' });
    expect(l.nodes.filter((n) => n.role === 'entry').length).toBe(sizes.reduce((a, b) => a + b, 0));
    expect(l.sectors.map((s) => s.count)).toEqual(sizes);
    for (const g of makeGroups(sizes)) {
      for (const e of g.entries) {
        const p = l.byId.get(e.ref);
        expect(p, e.ref).toBeDefined();
        expect(Number.isFinite(p!.x) && Number.isFinite(p!.y)).toBe(true);
        expect(p!.parent).toBe(g.id);
      }
    }
  });

  it.each(CASES)('las zonas cubren la vuelta completa sin traslaparse: %s', (_name, sizes) => {
    const l = build(sizes);
    const span = l.sectors.reduce((s, z) => s + (z.a1 - z.a0), 0);
    expect(span).toBeCloseTo(TAU, 5);
    for (let i = 1; i < l.sectors.length; i++) expect(l.sectors[i]!.a0).toBeCloseTo(l.sectors[i - 1]!.a1, 8);
    for (const z of l.sectors) expect(z.a1 - z.a0).toBeGreaterThan(0);
  });

  it.each(CASES)('cada entrada cae dentro del sector y la banda de su zona: %s', (_name, sizes) => {
    const l = build(sizes);
    const byId = new Map(l.sectors.map((s) => [s.id, s]));
    for (const n of l.nodes) {
      if (n.role !== 'entry') continue;
      const z = byId.get(n.parent!)!;
      const a = angleFrom(n, z.a0);
      expect(a, n.id).toBeGreaterThanOrEqual(z.a0 - 1e-6);
      expect(a, n.id).toBeLessThanOrEqual(z.a1 + 1e-6);
      const r = Math.hypot(n.x, n.y);
      expect(r).toBeGreaterThanOrEqual(z.rIn);
      expect(r).toBeLessThanOrEqual(z.rOut);
    }
  });

  it.each(CASES)('ninguna entrada se encima con otra ni con una categoría: %s', (_name, sizes) => {
    const l = build(sizes);
    const entries = l.nodes.filter((n) => n.role === 'entry');
    const cats = l.nodes.filter((n) => n.role === 'category');
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        expect(dist(entries[i]!, entries[j]!), `${entries[i]!.id} vs ${entries[j]!.id}`).toBeGreaterThanOrEqual(entries[i]!.r + entries[j]!.r);
      }
      for (const c of cats) expect(dist(entries[i]!, c)).toBeGreaterThan(entries[i]!.r + c.r);
    }
    for (let i = 0; i < cats.length; i++) {
      for (let j = i + 1; j < cats.length; j++) expect(dist(cats[i]!, cats[j]!), `${cats[i]!.id} vs ${cats[j]!.id}`).toBeGreaterThan(cats[i]!.r + cats[j]!.r);
    }
  });

  it('todas las zonas terminan a la misma profundidad: el dibujo es un disco', () => {
    const l = build([31, 73, 126, 41, 13, 2, 8, 59]);
    expect(new Set(l.sectors.map((s) => s.rOut)).size).toBe(1);
    // El disco de fondo envuelve a todo lo que no es el anillo exterior.
    const far = Math.max(...l.nodes.filter((n) => n.role !== 'outer').map((n) => Math.hypot(n.x, n.y) + n.r));
    expect(l.discs[0]).toBeGreaterThan(far);
  });

  it('una sola zona: las entradas orbitan el centro, sin nodo de categoría', () => {
    const few = build([20]);
    expect(few.nodes.some((n) => n.role === 'category')).toBe(false);
    expect(few.labelled).toBe(true);
    for (const n of few.nodes.filter((p) => p.role === 'entry')) expect(n.parent).toBe('zeus');
    // Con título visible van en UN anillo, con sitio para escribirlo en radial.
    expect(new Set(few.nodes.filter((p) => p.role === 'entry').map((p) => Math.round(Math.hypot(p.x, p.y)))).size).toBe(1);

    const many = build([300]);
    expect(many.labelled).toBe(false);
    const entries = many.nodes.filter((p) => p.role === 'entry');
    expect(entries.length).toBe(300);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) expect(dist(entries[i]!, entries[j]!)).toBeGreaterThanOrEqual(entries[i]!.r + entries[j]!.r);
    }
  });

  it('el anillo exterior queda fuera del disco y dentro de los límites del encuadre', () => {
    const outer = Array.from({ length: 12 }, (_, i) => ({ id: `project:${i}`, kind: 'project' }));
    const l = build([31, 73, 126], { outer });
    for (const o of outer) {
      const p = l.byId.get(o.id)!;
      expect(p.role).toBe('outer');
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(l.discs[0]!);
      expect(p.x).toBeGreaterThan(l.bounds.minX);
      expect(p.x).toBeLessThan(l.bounds.maxX);
    }
  });

  it('sin zonas queda solo el centro; las zonas vacías y las aristas a referencias desconocidas se descartan', () => {
    expect(build([]).nodes.map((n) => n.id)).toEqual(['zeus']);
    const l = build([3, 0, 2]);
    expect(l.sectors.map((s) => s.id)).toEqual(['k:adr', 'k:change']);
    const edges: LayoutEdge[] = [
      { id: 'ok', src: 'node:adr-0', dst: 'node:change-1', kind: 'relates_to' },
      { id: 'x', src: 'node:adr-0', dst: 'node:fantasma', kind: 'relates_to' },
      { id: 'yo', src: 'node:adr-1', dst: 'node:adr-1', kind: 'relates_to' },
    ];
    const withEdges = build([3, 0, 2], { edges });
    expect(withEdges.links.filter((k) => !k.structural).map((k) => k.id)).toEqual(['ok']);
  });

  it('el camino de un pulso va de la entrada a su zona y de ahí al centro', () => {
    const l = build([4, 4]);
    expect(pathToRoot(l, 'node:spec-1').map((p) => p.id)).toEqual(['node:spec-1', 'k:spec', 'zeus']);
    expect(pathToRoot(build([4]), 'node:adr-1').map((p) => p.id)).toEqual(['node:adr-1', 'zeus']);
    expect(pathToRoot(l, 'node:no-existe')).toEqual([]);
  });
});

describe('zeus · encuadre', () => {
  it('fitTransform centra los límites y zoomAt deja fijo el punto bajo el cursor', () => {
    const t = fitTransform({ minX: -500, minY: -200, maxX: 500, maxY: 200 }, 800, 600);
    expect(t.k).toBeCloseTo(0.8);
    expect(t.x).toBeCloseTo(400);
    expect(t.y).toBeCloseTo(300);
    const z = zoomAt(t, 100, 50, 1.5);
    // El punto del mundo bajo (100, 50) es el mismo antes y después.
    expect((100 - z.x) / z.k).toBeCloseTo((100 - t.x) / t.k);
    expect((50 - z.y) / z.k).toBeCloseTo((50 - t.y) / t.k);
  });
});
