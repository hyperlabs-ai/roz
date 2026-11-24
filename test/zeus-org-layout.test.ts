// Dibujo del organigrama (web/src/components/zeus/org-tree.ts): módulo puro. Lo que importa aquí es
// que alguien que reporta a dos personas (los co-CTOs) quede entre ellas y conectado a ambas.
import { describe, expect, it } from 'vitest';
import { NODE_W, buildOrgTree, layoutOrg } from '../web/src/components/zeus/org-tree.js';
import type { ZeusOrgMember } from '../web/src/lib/zeus.js';

const m = (devId: string, reportsTo: string | null, alsoReportsTo: string[] = []): ZeusOrgMember => ({
  devId,
  name: devId,
  email: null,
  role: 'dev',
  githubLogin: null,
  active: true,
  reportsTo,
  title: null,
  alsoReportsTo,
  duties: [],
  zeusAdmin: false,
  projects: [],
  skills: [],
  online: false,
});

const team = [
  m('Fer', null),
  m('Araly', 'Fer'),
  m('Crix', 'Fer'),
  m('Manuel', 'Fer'),
  m('German', 'Araly'),
  m('Alan', 'Manuel', ['Crix']),
  m('Sebas', 'Manuel', ['Crix']),
];

describe('layoutOrg', () => {
  const layout = layoutOrg(buildOrgTree(team));
  const at = (id: string) => layout.nodes.find((n) => n.member.devId === id)!;
  const cx = (id: string) => at(id).x + NODE_W / 2;

  it('pone a quien reporta a dos personas entre ellas', () => {
    const mid = (cx('Alan') + cx('Sebas')) / 2;
    expect(mid).toBeCloseTo((cx('Crix') + cx('Manuel')) / 2, 0);
    expect(cx('Alan')).toBeLessThan(cx('Sebas'));
  });

  it('conecta el grupo con ambos jefes en un solo travesaño', () => {
    const bus = layout.buses.find((b) => b.from.length === 2)!;
    expect(bus).toBeTruthy();
    expect(bus.from.map((f) => f.x).sort((a, b) => a - b)).toEqual([cx('Crix'), cx('Manuel')].sort((a, b) => a - b));
    expect(bus.to.map((t) => t.x).sort((a, b) => a - b)).toEqual([cx('Alan'), cx('Sebas')].sort((a, b) => a - b));
    expect(bus.y).toBeLessThan(at('Alan').y);
  });

  it('nadie se encima en su fila', () => {
    const rows = new Map<number, number[]>();
    for (const n of layout.nodes) rows.set(n.y, [...(rows.get(n.y) ?? []), n.x]);
    for (const xs of rows.values()) {
      const sorted = xs.sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(NODE_W);
    }
  });

  it('sin líneas punteadas es un árbol normal: cada jefe sobre su gente', () => {
    const plain = layoutOrg(buildOrgTree([m('A', null), m('B', 'A'), m('C', 'A')]));
    expect(plain.buses).toHaveLength(1);
    expect(plain.buses[0]!.from).toHaveLength(1);
  });
});
