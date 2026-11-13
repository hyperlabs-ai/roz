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
