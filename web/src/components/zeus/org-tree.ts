// El organigrama como árbol por `reportsTo`: quien no reporta a nadie queda arriba.
import type { ZeusOrgMember } from '@/lib/zeus';

export interface TreeNode {
  member: ZeusOrgMember;
  children: TreeNode[];
}

/**
 * Arma el árbol. Tolera datos torcidos: un `reportsTo` que apunta a alguien que no está, o un ciclo
 * (A reporta a B y B a A), dejan a esas personas arriba en vez de desaparecerlas del organigrama.
 */
export function buildOrgTree(members: ZeusOrgMember[]): TreeNode[] {
  const byId = new Map(members.map((m) => [m.devId, m]));
  const kids = new Map<string, ZeusOrgMember[]>();
  for (const m of members) {
    if (!m.reportsTo || !byId.has(m.reportsTo) || m.reportsTo === m.devId) continue;
    kids.set(m.reportsTo, [...(kids.get(m.reportsTo) ?? []), m]);
  }
  const byName = (a: ZeusOrgMember, b: ZeusOrgMember) => a.name.localeCompare(b.name, 'es');
  const seen = new Set<string>();
  const build = (m: ZeusOrgMember): TreeNode => {
    seen.add(m.devId);
    return { member: m, children: (kids.get(m.devId) ?? []).filter((k) => !seen.has(k.devId)).sort(byName).map(build) };
  };
  const roots = members.filter((m) => !m.reportsTo || !byId.has(m.reportsTo) || m.reportsTo === m.devId).sort(byName).map(build);
  // Lo que quedó sin visitar está dentro de un ciclo: se sube a la raíz.
  for (const m of [...members].sort(byName)) if (!seen.has(m.devId)) roots.push(build(m));
  return roots;
}

export function descendants(node: TreeNode, out = new Set<string>()): Set<string> {
  for (const c of node.children) {
    out.add(c.member.devId);
    descendants(c, out);
  }
  return out;
}

export function find(nodes: TreeNode[], devId: string): TreeNode | null {
  for (const n of nodes) {
    if (n.member.devId === devId) return n;
    const hit = find(n.children, devId);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- dibujo del árbol

export const NODE_W = 150;
export const NODE_H = 146;
const GAP_X = 18;
const GAP_Y = 72;
/** Altura del travesaño sobre los hijos (donde bajan los jefes). */
const BUS_DY = 30;

export interface PlacedNode {
  member: ZeusOrgMember;
  /** Esquina superior izquierda. */
  x: number;
  y: number;
}

/** Un grupo de personas que reportan al MISMO conjunto de jefes: los jefes bajan a un travesaño común. */
export interface OrgBus {
  /** Punto de salida de cada jefe (centro del borde inferior). */
  from: Array<{ x: number; y: number }>;
  /** Punto de llegada de cada persona (centro del borde superior). */
  to: Array<{ x: number; y: number }>;
  /** Altura del travesaño. */
  y: number;
}

export interface OrgLayout {
  nodes: PlacedNode[];
  buses: OrgBus[];
  width: number;
  height: number;
}

/**
 * Posiciones del organigrama. Árbol "ordenado" por `reportsTo` (cada jefe centrado sobre su gente) y
 * un ajuste para las líneas punteadas: si un grupo de hermanos también le reporta a otra persona del
 * dibujo (p. ej. Alan y Sebas → Manuel y también Crix), el grupo se recorre hasta quedar centrado
 * entre sus jefes, siempre que no se encime con otro grupo, y todos los jefes bajan al mismo
 * travesaño. Pura, para probarla.
 */
export function layoutOrg(roots: TreeNode[]): OrgLayout {
  const pos = new Map<string, PlacedNode>();
  const widthOf = new Map<string, number>();
  const measure = (n: TreeNode): number => {
    const kids = n.children.reduce((s, c) => s + measure(c), 0) + Math.max(0, n.children.length - 1) * GAP_X;
    const w = Math.max(NODE_W, kids);
    widthOf.set(n.member.devId, w);
    return w;
  };
  const place = (n: TreeNode, left: number, depth: number) => {
    const w = widthOf.get(n.member.devId)!;
    const y = depth * (NODE_H + GAP_Y);
    pos.set(n.member.devId, { member: n.member, x: left + (w - NODE_W) / 2, y });
    const kids = n.children.reduce((s, c) => s + widthOf.get(c.member.devId)!, 0) + Math.max(0, n.children.length - 1) * GAP_X;
    let cur = left + (w - kids) / 2;
    for (const c of n.children) {
      place(c, cur, depth + 1);
      cur += widthOf.get(c.member.devId)! + GAP_X;
    }
  };
  let left = 0;
  for (const r of roots) {
    measure(r);
    place(r, left, 0);
    left += widthOf.get(r.member.devId)! + GAP_X * 2;
  }

  // Grupos por conjunto de jefes presentes en el dibujo.
  const groups = new Map<string, { parents: string[]; kids: string[] }>();
  for (const p of pos.values()) {
    const m = p.member;
    const parents = [m.reportsTo, ...m.alsoReportsTo].filter((id, i, a): id is string => !!id && pos.has(id) && a.indexOf(id) === i);
    if (!parents.length) continue;
    const key = [...parents].sort().join('|');
    const g = groups.get(key) ?? { parents, kids: [] };
    g.kids.push(m.devId);
    groups.set(key, g);
  }

  const center = (id: string) => pos.get(id)!.x + NODE_W / 2;
  // Recorre cada grupo con más de un jefe hacia el centro de sus jefes, si en su fila hay lugar.
  for (const g of groups.values()) {
    if (g.parents.length < 2) continue;
    const kids = g.kids.map((id) => pos.get(id)!);
    const minX = Math.min(...kids.map((k) => k.x));
    const maxX = Math.max(...kids.map((k) => k.x + NODE_W));
    const target = g.parents.reduce((s, id) => s + center(id), 0) / g.parents.length;
    const shift = target - (minX + maxX) / 2;
    if (Math.abs(shift) < 1) continue;
    const row = kids[0]!.y;
    const others = [...pos.values()].filter((p) => p.y === row && !g.kids.includes(p.member.devId));
    const clash = others.some((o) => o.x < maxX + shift + GAP_X && o.x + NODE_W > minX + shift - GAP_X);
    if (!clash) for (const k of kids) k.x += shift;
  }

  // Todo a coordenadas positivas.
  const all = [...pos.values()];
  const offX = -Math.min(0, ...all.map((p) => p.x));
  for (const p of all) p.x += offX;

  const buses: OrgBus[] = [...groups.values()].map((g) => {
    const kids = g.kids.map((id) => pos.get(id)!);
    const top = Math.min(...kids.map((k) => k.y));
    return {
      from: g.parents.map((id) => ({ x: center(id), y: pos.get(id)!.y + NODE_H })),
      to: kids.map((k) => ({ x: k.x + NODE_W / 2, y: k.y })),
      y: top - BUS_DY,
    };
  });
  return {
    nodes: all,
    buses,
    width: Math.max(NODE_W, ...all.map((p) => p.x + NODE_W)),
    height: Math.max(NODE_H, ...all.map((p) => p.y + NODE_H)),
  };
}
