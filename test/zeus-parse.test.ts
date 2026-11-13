// Lectura de documentos de un repo (src/zeus/parse.ts) y agrupado de archivos (src/zeus/ingest.ts):
// qué rutas son contexto, de qué tipo, y qué se saca del markdown. Todo puro.
import { describe, expect, it } from 'vitest';
import { adrNumber, classifyPath, mapStatus, parseDoc, resolveLink } from '../src/zeus/parse.js';
import { groupFiles } from '../src/zeus/ingest.js';

describe('classifyPath', () => {
  it('reconoce los specs de OpenSpec por capacidad', () => {
    expect(classifyPath('openspec/specs/auth/spec.md')).toMatchObject({ kind: 'spec', slug: 'auth', pinned: false });
    expect(classifyPath('openspec/specs/billing/invoices/spec.md')).toMatchObject({ kind: 'spec', slug: 'billing-invoices' });
  });

  it('junta proposal, design y tasks de un cambio en un solo documento', () => {
    const p = classifyPath('openspec/changes/add-2fa/proposal.md')!;
    const d = classifyPath('openspec/changes/add-2fa/design.md')!;
    const t = classifyPath('openspec/changes/add-2fa/tasks.md')!;
    expect(p).toMatchObject({ kind: 'change', slug: 'add-2fa', part: 0 });
    expect(new Set([p.group, d.group, t.group]).size).toBe(1);
    expect([p.part, d.part, t.part]).toEqual([0, 1, 2]);
    expect(d.partTitle).toBe('Diseño');
  });

  it('ignora lo archivado y las deltas de specs dentro de un cambio', () => {
    expect(classifyPath('openspec/changes/archive/2026-01-02-add-2fa/proposal.md')).toBeNull();
    expect(classifyPath('openspec/changes/add-2fa/specs/auth/spec.md')).toBeNull();
  });

  it('soporta openspec dentro de un paquete de un monorepo, sin chocar slugs', () => {
    expect(classifyPath('packages/api/openspec/specs/auth/spec.md')).toMatchObject({ kind: 'spec', slug: 'packages-api-auth' });
    // "myopenspec/" no es OpenSpec.
    expect(classifyPath('myopenspec/specs/auth/spec.md')).toBeNull();
  });

  it('reconoce ADR en sus carpetas habituales y salta plantillas e índices', () => {
    expect(classifyPath('docs/adr/0003-usar-postgres.md')).toMatchObject({ kind: 'adr', slug: '0003-usar-postgres' });
    expect(classifyPath('adr/0001-record-decisions.md')?.kind).toBe('adr');
    expect(classifyPath('docs/decisions/elegir-hono.md')?.kind).toBe('adr');
    expect(classifyPath('docs/adr/README.md')).toBeNull();
    expect(classifyPath('docs/adr/template.md')).toBeNull();
    expect(classifyPath('docs/adr/0000-template.md')).toBeNull();
  });

  it('fija los documentos que todo agente debe ver', () => {
    expect(classifyPath('AGENTS.md')).toMatchObject({ kind: 'doc', pinned: true });
    expect(classifyPath('CLAUDE.md')).toMatchObject({ kind: 'doc', pinned: true });
    expect(classifyPath('openspec/project.md')).toMatchObject({ kind: 'doc', pinned: true });
    expect(classifyPath('ARCHITECTURE.md')).toMatchObject({ kind: 'doc', pinned: false });
    expect(classifyPath('DESIGN.md')).toMatchObject({ kind: 'design', slug: 'design', pinned: true });
    expect(classifyPath('web/src/DESIGN.md')).toMatchObject({ kind: 'design', slug: 'design-web-src', pinned: false });
  });

  it('reglas y design system', () => {
    expect(classifyPath('docs/rules/commits.md')).toMatchObject({ kind: 'rule', slug: 'commits' });
    expect(classifyPath('.claude/rules/testing.md')?.kind).toBe('rule');
    expect(classifyPath('docs/design-system/colores.md')).toMatchObject({ kind: 'design', slug: 'design-colores' });
  });

  it('no ingiere lo que no es contexto', () => {
    for (const p of ['README.md', 'src/index.ts', 'docs/guia.md', 'node_modules/x/AGENTS.md', 'dist/DESIGN.md', 'docs/adr/diagrama.png', 'CHANGELOG.md']) {
      expect(classifyPath(p), p).toBeNull();
    }
  });
});

describe('parseDoc', () => {
  it('saca título, resumen y estado de un ADR típico', () => {
    const d = parseDoc(
      'docs/adr/0003-usar-postgres.md',
      ['# ADR-0003: Usar Postgres', '', '## Status', '', 'Accepted', '', '## Context', '', 'Necesitamos transacciones y búsqueda vectorial en la misma base.'].join('\n'),
    );
    expect(d.title).toBe('ADR-0003: Usar Postgres');
    expect(d.nativeStatus).toBe('Accepted');
    expect(d.status).toBe('active');
    expect(d.summary).toBe('Necesitamos transacciones y búsqueda vectorial en la misma base.');
  });

  it('lee el estado en línea, en español y con negritas', () => {
    expect(parseDoc('a.md', '# X\n\n**Estado:** Propuesto\n\nTexto del documento aquí.').status).toBe('draft');
    expect(parseDoc('a.md', '# X\n\n- Status: Superseded by ADR-0009\n').status).toBe('superseded');
    expect(parseDoc('a.md', '# X\n\nStatus: Deprecated\n').status).toBe('archived');
    expect(parseDoc('a.md', '# X\n\nSin estado declarado en ningún lado.').status).toBe('active');
  });

  it('respeta el frontmatter', () => {
    const d = parseDoc('a.md', '---\ntitle: "Cola con outbox"\nstatus: proposed\nsummary: Outbox sobre Postgres, sin broker.\n---\n\n# Otro título\n\nCuerpo.');
    expect(d.title).toBe('Cola con outbox');
    expect(d.status).toBe('draft');
    expect(d.summary).toBe('Outbox sobre Postgres, sin broker.');
  });

  it('cae al nombre del archivo si no hay título', () => {
    expect(parseDoc('docs/adr/0007-usar_hono.md', 'Solo un párrafo sin encabezado alguno.').title).toBe('0007 usar hono');
  });

  it('detecta a qué reemplaza (y no confunde "superseded by")', () => {
    const d = parseDoc('docs/adr/0009.md', '# ADR-0009\n\nSupersedes ADR-0003, [ADR-0004](./0004-colas.md) y ADR-0005\n\nSuperseded by ADR-0012\n');
    expect(d.supersedes).toEqual(['ADR-0003', '0004-colas', 'ADR-0005']);
  });

  it('reemplazos en español y en frontmatter', () => {
    expect(parseDoc('a.md', '# X\n\nReemplaza a: 0003-usar-postgres\n').supersedes).toEqual(['0003-usar-postgres']);
    expect(parseDoc('a.md', '---\nsupersedes: [ADR-0001, ADR-0002]\n---\n# X\n').supersedes).toEqual(['ADR-0001', 'ADR-0002']);
  });

  it('resuelve enlaces relativos a otros markdown y descarta externos, imágenes y anclas', () => {
    const d = parseDoc(
      'docs/adr/0009.md',
      '# X\n\nVer [colas](./0004-colas.md#contexto), [spec](../../openspec/specs/auth/spec.md), [fuera](https://x.dev/a.md), ![img](./d.md), [ancla](#abajo) y [código](../src/x.ts).',
    );
    expect(d.links).toEqual(['docs/adr/0004-colas.md', 'openspec/specs/auth/spec.md']);
  });

  it('normaliza CRLF', () => {
    expect(parseDoc('a.md', '# Título\r\n\r\nStatus: Accepted\r\n\r\nUn párrafo de contexto suficiente.\r\n').title).toBe('Título');
  });
});

describe('resolveLink', () => {
  it('no deja salir del repo', () => {
    expect(resolveLink('docs/a.md', '../../../etc/passwd.md')).toBeNull();
    expect(resolveLink('docs/a.md', '/AGENTS.md')).toBe('AGENTS.md');
    expect(resolveLink('docs/a.md', 'mailto:x@y.z')).toBeNull();
    expect(resolveLink('docs/a.md', '//cdn.x/y.md')).toBeNull();
  });
});

describe('mapStatus / adrNumber', () => {
  it('lo desconocido queda vigente', () => {
    expect(mapStatus('algo raro')).toBe('active');
    expect(mapStatus(null)).toBe('active');
    expect(mapStatus('Aceptado')).toBe('active');
  });

  it('compara ADR por número, sin importar el formato', () => {
    expect(adrNumber('ADR-0003')).toBe('3');
    expect(adrNumber('0003-usar-postgres')).toBe('3');
    expect(adrNumber('adr 12')).toBe('12');
    expect(adrNumber('usar-postgres')).toBeNull();
  });
});

describe('groupFiles', () => {
  const f = (path: string, sha = path, size = 100) => ({ path, sha, size });

  it('un cambio de OpenSpec es un documento con su ruta principal en el proposal', () => {
    const g = groupFiles([f('openspec/changes/add-2fa/tasks.md'), f('openspec/changes/add-2fa/proposal.md'), f('openspec/changes/add-2fa/design.md'), f('src/x.ts')]);
    expect(g).toHaveLength(1);
    expect(g[0]!.path).toBe('openspec/changes/add-2fa/proposal.md');
    expect(g[0]!.parts.map((p) => p.part)).toEqual([0, 1, 2]);
    expect(g[0]!.cls.kind).toBe('change');
  });

  it('un cambio sin proposal usa la primera parte que exista', () => {
    const g = groupFiles([f('openspec/changes/x/tasks.md'), f('openspec/changes/x/design.md')]);
    expect(g[0]!.path).toBe('openspec/changes/x/design.md');
  });

  it('descarta archivos enormes y ordena estable', () => {
    const g = groupFiles([f('docs/adr/0002-b.md'), f('docs/adr/0001-a.md'), f('docs/adr/0003-gigante.md', 'x', 5_000_000)]);
    expect(g.map((x) => x.path)).toEqual(['docs/adr/0001-a.md', 'docs/adr/0002-b.md']);
  });
});
