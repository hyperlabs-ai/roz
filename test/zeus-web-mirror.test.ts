// El front copia A MANO los tipos de zeus (web/src/lib/zeus.ts ← src/types/zeus.ts). Si un campo se
// renombra en un lado y no en el otro, todo compila y la UI muestra el dato vacío en runtime. Esta
// prueba compara los campos de cada interfaz compartida para que ese desfase rompa aquí.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** nombre de interfaz → sus campos de primer nivel (con `?` si es opcional). */
function interfaces(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /export interface (\w+)(?:\s+extends\s+[^{]+)?\s*\{/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    let body = '';
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i]!;
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      // Solo el primer nivel: lo anidado (objetos en línea) se compara por su campo contenedor.
      if (depth === 1 && !(ch === '}' && depth === 1)) body += ch;
      else if (depth > 1 && ch === '\n') body += '\n';
    }
    const fields = [...body.matchAll(/^\s{2}(\w+)(\??):/gm)].map((f) => f[1]! + f[2]!);
    out.set(m[1]!, fields.sort());
  }
  return out;
}

/** Miembros de un `as const` de strings: ZEUS_NODE_KINDS, ZEUS_EDGE_KINDS… */
function constList(source: string, name: string): string[] {
  const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]+)\\]`).exec(source);
  return m ? [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort() : [];
}

const back = read('../src/types/zeus.ts');
const front = read('../web/src/lib/zeus.ts');
const backTypes = interfaces(back);
const frontTypes = interfaces(front);

describe('espejo de tipos de zeus (back ↔ front)', () => {
  const shared = [...backTypes.keys()].filter((n) => frontTypes.has(n));

  it('el front refleja las interfaces del contrato', () => {
    // Las que el front de verdad consume. Si se agrega una al contrato, se agrega aquí y allá.
    for (const name of [
      'ZeusGraph', 'ZeusGraphNode', 'ZeusGraphEdge', 'ZeusNodeSummary', 'ZeusNodeDetail', 'ZeusNodeInput', 'ZeusSearchHit',
      'ZeusOrg', 'ZeusOrgMember', 'ZeusMe', 'ZeusTokenSummary', 'ZeusRequest', 'ZeusMessage', 'ZeusInbox', 'ZeusSource',
      'ZeusActivityEvent', 'ZeusVaultKey', 'ZeusVaultOverview',
    ]) {
      expect(shared, name).toContain(name);
    }
  });

  it.each(shared.map((n) => [n]))('%s tiene los mismos campos en ambos lados', (name) => {
    expect(frontTypes.get(name)).toEqual(backTypes.get(name));
  });

  it('los catálogos (tipos de nodo, de arista, estados) coinciden', () => {
    for (const list of ['ZEUS_NODE_KINDS', 'ZEUS_EDGE_KINDS', 'ZEUS_NODE_STATUSES']) {
      const b = constList(back, list);
      expect(b.length, list).toBeGreaterThan(0);
      const f = constList(front, list);
      // El front puede no declarar la constante; si la declara, tiene que ser igual.
      if (f.length) expect(f, list).toEqual(b);
    }
  });
});
