// Integración de zeus contra un Postgres real en memoria (test/zeus-pg.ts) con la migración 0040
// aplicada: nodos y búsqueda, importación desde git, organización, bandeja y enrutado de solicitudes,
// el MCP por HTTP y la bóveda de punta a punta con el cifrado REAL del CLI.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createZeusPg, type ZeusPg } from './zeus-pg.js';
import {
  decryptSecret,
  encryptSecret,
  generateDek,
  generateDeviceKey,
  secretAad,
  unwrapDek,
  wrapAad,
  wrapDek,
} from '../cli/src/crypto.js';

const holder = vi.hoisted(() => {
  process.env.ROZ_LOG_LEVEL = 'silent';
  process.env.ROZ_MCP_TOKEN = 'token-compartido-de-prueba';
  process.env.CRON_SECRET = 'cron-de-prueba';
  process.env.GITHUB_TOKEN = 'gh-de-prueba';
  return { pg: null as unknown as { client: unknown } };
});

vi.mock('../src/db/supabase.js', () => ({ db: () => holder.pg.client, dbPublic: () => holder.pg.client }));
const pushToDev = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../src/notify/push.js', () => ({ pushToDev, pushBroadcast: vi.fn(), pushToEmail: vi.fn() }));

import app from '../src/app.js';
import { actorForDev, type ZeusActor } from '../src/zeus/core.js';
import { bootstrapAdmin, getGraph, getOrg, updateOrgMember } from '../src/zeus/graph.js';
import { cancelRequest, createRequest, createToken, getInbox, listRequests, markRead, resolveRequest, revokeToken, routeFor, sendMessage } from '../src/zeus/inbox.js';
import { ingestRepo, listSources, markSourceDirty, reimportNode, zeusSweep, type GitSource } from '../src/zeus/ingest.js';
import { archiveNode, buildContextPack, contextIndex, createEdge, createNode, deleteEdge, getNodeDetail, listNodes, searchNodes, updateNode } from '../src/zeus/nodes.js';
import { drainBackground } from '../src/utils/background.js';

let pg: ZeusPg;
const ids = { orwel: '', hub: '', ceo: '', pm: '', ana: '', beto: '', caro: '' };

async function dev(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const cols = { name, email: `${name.toLowerCase()}@hyper.test`, ...extra };
  const keys = Object.keys(cols);
  const [row] = await pg.sql<{ id: string }>(
    `insert into roz.dev (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(cols),
  );
  return row!.id;
}
const actor = (id: string, via: ZeusActor['via'] = 'web') => actorForDev(id, via);

beforeAll(async () => {
  pg = await createZeusPg();
  holder.pg = pg;
  const [orwel] = await pg.sql<{ id: string }>(`insert into roz.project (name, key) values ('Orwel', 'ORWEL') returning id`);
  const [hub] = await pg.sql<{ id: string }>(`insert into roz.project (name, key) values ('HyperHub', 'HUB') returning id`);
  ids.orwel = orwel!.id;
  ids.hub = hub!.id;
  ids.ceo = await dev('Fer', { role: 'ceo' });
  ids.pm = await dev('Paula', { role: 'pm' });
  ids.ana = await dev('Ana', { role: 'dev', github_login: 'ana-gh' });
  ids.beto = await dev('Beto', { role: 'dev' });
  ids.caro = await dev('Caro', { role: 'intern' });
  await pg.sql(`update roz.dev set reports_to = $1 where id in ($2, $3)`, [ids.pm, ids.ana, ids.beto]);
  await pg.sql(`update roz.dev set reports_to = $1 where id = $2`, [ids.ana, ids.caro]);
  await pg.sql(`insert into roz.dev_assignment (dev_id, project_id, kind, sort_order) values ($1, $3, 'principal', 0), ($2, $3, 'principal', 1)`, [ids.ana, ids.pm, ids.orwel]);
  await pg.sql(`insert into roz.project_repo (project_id, repo) values ($1, 'hyperlabs-ai/orwel')`, [ids.orwel]);
  await pg.sql(`insert into roz.runner (dev_id, name, platform, last_seen_at) values ($1, 'laptop-ana', 'win32', now())`, [ids.ana]);
});

afterAll(async () => {
  await drainBackground(2000);
  await pg.close();
});

// ================================================================ nodos

describe('nodos, historial y búsqueda', () => {
  let ruleId = '';

  it('crea con dueño, resumen derivado y revisión 1', async () => {
    const a = await actor(ids.ana);
    const d = await createNode({ kind: 'rule', title: 'No subir secretos al repo', body: '# Regla\n\nLos secretos viven en la bóveda de zeus, nunca en un commit.', pinned: true }, a);
    ruleId = d.id;
    expect(d).toMatchObject({ slug: 'no-subir-secretos-al-repo', ownerDevId: ids.ana, version: 1, status: 'active', source: 'manual', projectId: null });
    expect(d.summary).toBe('Los secretos viven en la bóveda de zeus, nunca en un commit.');
    expect(d.revisions).toHaveLength(1);
    expect(d.revisions[0]).toMatchObject({ version: 1, editedByName: 'Ana', editedVia: 'web' });
  });

  it('ante un título repetido en el mismo alcance agrega sufijo en vez de fallar', async () => {
    const d = await createNode({ kind: 'rule', title: 'No subir secretos al repo' }, await actor(ids.beto));
    expect(d.slug).toBe('no-subir-secretos-al-repo-2');
  });

  it('editar el contenido sube versión y guarda historial; cambiar solo metadatos no', async () => {
    const a = await actor(ids.beto, 'mcp');
    const v2 = await updateNode(ruleId, { body: 'Texto nuevo sobre secretos y la bóveda.' }, a);
    expect(v2.version).toBe(2);
    expect(v2.revisions.map((r) => r.version)).toEqual([2, 1]);
    expect(v2.revisions[0]).toMatchObject({ editedByName: 'Beto', editedVia: 'mcp' });
    const meta = await updateNode(ruleId, { tags: ['Seguridad', ' seguridad ', 'llaves'], reviewAfter: '2027-01-01' }, a);
    expect(meta.version).toBe(2);
    expect(meta.tags).toEqual(['seguridad', 'llaves']);
    expect(meta.reviewAfter).toBe('2027-01-01');
  });

  it('valida la entrada', async () => {
    const a = await actor(ids.ana);
    await expect(createNode({ kind: 'otro' as never, title: 'x' }, a)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(createNode({ kind: 'doc', title: '  ' }, a)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(createNode({ kind: 'doc', title: 'x', summary: 'y'.repeat(300) }, a)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(updateNode(ruleId, { reviewAfter: 'mañana' }, a)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(getNodeDetail('no-es-uuid')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(getNodeDetail('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('"A reemplaza a B" deja a B como reemplazado y la arista se ve desde ambos lados', async () => {
    const a = await actor(ids.ana);
    const viejo = await createNode({ kind: 'adr', title: 'Usar Mongo', projectId: ids.orwel, body: 'Decidimos Mongo.' }, a);
    const nuevo = await createNode({ kind: 'adr', title: 'Usar Postgres', projectId: ids.orwel, body: 'Postgres por transacciones y pgvector.' }, a);
    await createEdge({ src: nuevo.ref, dst: viejo.ref, kind: 'supersedes', note: 'migración 2026' }, a);
    expect((await getNodeDetail(viejo.id)).status).toBe('superseded');
    const out = (await getNodeDetail(nuevo.id)).edges;
    expect(out).toEqual([expect.objectContaining({ kind: 'supersedes', direction: 'out', otherTitle: 'Usar Mongo', note: 'migración 2026' })]);
    expect((await getNodeDetail(viejo.id)).edges[0]).toMatchObject({ direction: 'in', otherTitle: 'Usar Postgres' });
    // Repetir la misma arista no duplica.
    await createEdge({ src: nuevo.ref, dst: viejo.ref, kind: 'supersedes' }, a);
    expect((await getNodeDetail(nuevo.id)).edges).toHaveLength(1);
  });

  it('las aristas exigen extremos que existan', async () => {
    const a = await actor(ids.ana);
    await expect(createEdge({ src: `node:${ruleId}`, dst: 'node:3f2504e0-4f89-41d3-9a0c-0305e82c3301', kind: 'relates_to' }, a)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createEdge({ src: `node:${ruleId}`, dst: `node:${ruleId}`, kind: 'relates_to' }, a)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(createEdge({ src: `node:${ruleId}`, dst: `dev:${ids.ana}`, kind: 'inventada' }, a)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(createEdge({ src: `node:${ruleId}`, dst: `project:${ids.orwel}`, kind: 'applies_to' }, a)).resolves.toMatchObject({ derived: false });
  });

  it('busca por proyecto incluyendo lo de la organización, sin lo reemplazado', async () => {
    const hits = await searchNodes({ query: 'postgres', projectId: ids.orwel });
    expect(hits.map((h) => h.title)).toEqual(['Usar Postgres']);
    const org = await searchNodes({ query: 'secretos bóveda', projectId: ids.orwel });
    expect(org[0]).toMatchObject({ title: 'No subir secretos al repo', projectId: null, pinned: true });
    expect(await searchNodes({ query: 'secretos', projectId: ids.orwel, includeOrg: false })).toEqual([]);
    expect(await searchNodes({ query: 'x' })).toEqual([]);
  });

  it('el índice pone lo fijado primero y solo lo vigente', async () => {
    const idx = await contextIndex({ id: ids.orwel, key: 'ORWEL', name: 'Orwel' });
    expect(idx.entries[0]).toMatchObject({ title: 'No subir secretos al repo', pinned: true, scope: 'organización' });
    expect(idx.entries.map((e) => e.title)).toContain('Usar Postgres');
    expect(idx.entries.map((e) => e.title)).not.toContain('Usar Mongo');
    // Sin proyecto: solo lo de la organización.
    expect((await contextIndex(null)).entries.every((e) => e.scope === 'organización')).toBe(true);
    // El tope deja constancia de lo que quedó fuera.
    const small = await contextIndex({ id: ids.orwel, key: 'ORWEL', name: 'Orwel' }, 1);
    expect(small.entries).toHaveLength(1);
    expect(small.omitted).toBeGreaterThan(0);
  });

  it('el paquete de contexto de una tarea trae lo fijado y lo que coincide', async () => {
    const pack = await buildContextPack(ids.orwel, 'Migrar la tabla de sesiones a Postgres con transacciones');
    const by = new Map(pack.items.map((i) => [i.title, i.why]));
    expect(by.get('No subir secretos al repo')).toBe('fijado');
    expect(by.get('Usar Postgres')).toBe('coincide');
    expect(by.has('Usar Mongo')).toBe(false);
    expect((await buildContextPack(ids.hub, 'algo sin relación alguna')).items.map((i) => i.why)).toEqual(['fijado']);
  });

  it('archivar saca del índice y de la lista, sin borrar', async () => {
    const a = await actor(ids.ana);
    const d = await createNode({ kind: 'doc', title: 'Temporal para archivar', pinned: true }, a);
    await archiveNode(d.id, a);
    expect((await listNodes({})).some((n) => n.id === d.id)).toBe(false);
    expect((await listNodes({ status: 'archived' })).some((n) => n.id === d.id)).toBe(true);
    expect((await getNodeDetail(d.id)).pinned).toBe(false);
  });
});

// ================================================================ ingesta

describe('importación desde git (zeus es la fuente de verdad)', () => {
  const REPO = 'hyperlabs-ai/orwel';
  let files: Record<string, string>;
  let blobReads: string[];
  let truncated = false;

  const sha = (text: string) => `sha-${text.length}-${[...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}`;
  const source: GitSource = {
    async snapshot() {
      return { defaultBranch: 'main', commitSha: 'c0ffee', truncated, files: Object.entries(files).map(([path, text]) => ({ path, sha: sha(text), size: text.length })) };
    },
    async blob(_repo, wanted) {
      const hit = Object.entries(files).find(([, text]) => sha(text) === wanted);
      if (!hit) throw new Error(`blob ${wanted} no existe`);
      blobReads.push(hit[0]);
      return hit[1];
    },
  };
  type GitNode = { id: string; kind: string; slug: string; title: string; status: string; pinned: boolean; source_path: string; body: string; version: number; project_id: string; updated_at: string };
  const gitNodes = () =>
    pg.sql<GitNode>(
      `select id, kind, slug, title, status, pinned, source_path, body, version, project_id, updated_at from roz.zeus_node where source = 'git' and source_repo = $1 order by source_path`,
      [REPO],
    );
  const bySlug = async (slug: string) => (await gitNodes()).find((n) => n.slug === slug)!;
  const gitEdges = () => pg.sql<{ id: string; src_ref: string; dst_ref: string; kind: string }>(`select id, src_ref, dst_ref, kind from roz.zeus_edge where source = 'git' order by kind, src_ref`);

  beforeAll(() => {
    blobReads = [];
    files = {
      'AGENTS.md': '# Guía para agentes\n\nCorre las pruebas antes de abrir una PR.',
      'README.md': '# Orwel\n\nNo es contexto.',
      'src/index.ts': 'export {}',
      'docs/adr/0001-usar-sveltekit.md': '# ADR-0001: Usar SvelteKit\n\nStatus: Accepted\n\nEl front es SvelteKit sobre Vercel.',
      'docs/adr/0002-ingesta-por-lotes.md':
        '# ADR-0002: Ingesta por lotes\n\n## Status\n\nAccepted\n\nSupersedes ADR-0001\n\nLos eventos entran por lotes. Ver el [spec de ingesta](../../openspec/specs/ingest/spec.md).',
      'openspec/specs/ingest/spec.md': '# Ingest\n\n### Requirement: batch\nThe system SHALL accept batches of up to 500 events.',
      'openspec/changes/add-replay/proposal.md': '# Agregar replay de sesiones\n\nGrabar y reproducir sesiones del visitante.',
      'openspec/changes/add-replay/tasks.md': '# Tasks\n\n- [ ] 1.1 Capturar eventos del DOM',
      'openspec/changes/add-replay/specs/replay/spec.md': '## ADDED Requirements\n\ndelta que no es un documento aparte',
      'openspec/changes/archive/2026-01-01-viejo/proposal.md': '# Cambio ya archivado',
    };
  });

  it('la primera lectura crea un nodo por documento, con su tipo y proyecto', async () => {
    const r = await ingestRepo(REPO, source);
    expect(r).toMatchObject({ documents: 5, created: 5, kept: 0 });
    const nodes = await gitNodes();
    expect(nodes.map((n) => [n.source_path, n.kind, n.slug])).toEqual([
      ['AGENTS.md', 'doc', 'agents'],
      ['docs/adr/0001-usar-sveltekit.md', 'adr', '0001-usar-sveltekit'],
      ['docs/adr/0002-ingesta-por-lotes.md', 'adr', '0002-ingesta-por-lotes'],
      ['openspec/changes/add-replay/proposal.md', 'change', 'add-replay'],
      ['openspec/specs/ingest/spec.md', 'spec', 'ingest'],
    ]);
    expect(nodes.every((n) => n.project_id === ids.orwel)).toBe(true);
    expect(nodes.find((n) => n.slug === 'agents')!.pinned).toBe(true);
    // Entra con su primera revisión, marcada como venida de git.
    expect((await getNodeDetail(nodes[0]!.id)).revisions).toEqual([expect.objectContaining({ version: 1, editedVia: 'git', editedBy: null })]);
  });

  it('un cambio de OpenSpec es un solo documento con sus tareas como sección', async () => {
    const change = (await gitNodes()).find((n) => n.kind === 'change')!;
    expect(change.title).toBe('Agregar replay de sesiones');
    expect(change.body).toContain('Grabar y reproducir sesiones');
    expect(change.body).toContain('## Tareas');
    expect(change.body).toContain('1.1 Capturar eventos del DOM');
    expect(change.body).not.toContain('delta que no es');
  });

  it('al importar saca las aristas del texto: reemplaza a (y lo marca) y enlaces entre documentos', async () => {
    const nodes = await gitNodes();
    const adr1 = nodes.find((n) => n.slug === '0001-usar-sveltekit')!;
    const adr2 = nodes.find((n) => n.slug === '0002-ingesta-por-lotes')!;
    const spec = nodes.find((n) => n.kind === 'spec')!;
    expect((await gitEdges()).map(({ id: _id, ...e }) => e)).toEqual([
      { src_ref: `node:${adr2.id}`, dst_ref: `node:${spec.id}`, kind: 'relates_to' },
      { src_ref: `node:${adr2.id}`, dst_ref: `node:${adr1.id}`, kind: 'supersedes' },
    ]);
    expect(adr1.status).toBe('superseded');
    expect(adr2.status).toBe('active');
    expect((await getNodeDetail(adr2.id)).edges.every((e) => e.source === 'git')).toBe(true);
  });

  it('sin documentos nuevos no baja ningún archivo', async () => {
    blobReads = [];
    const r = await ingestRepo(REPO, source);
    expect(r).toMatchObject({ documents: 5, created: 0, kept: 5, edges: 0 });
    expect(blobReads).toEqual([]);
  });

  it('un documento importado se edita desde zeus como cualquiera y conserva su procedencia', async () => {
    const adr = await bySlug('0002-ingesta-por-lotes');
    const d = await updateNode(
      adr.id,
      { title: 'ADR-0002: Lotes de 200', body: '# ADR-0002\n\nEditado en zeus: los lotes son de 200.', status: 'draft', tags: ['ingesta'] },
      await actor(ids.ana),
    );
    expect(d).toMatchObject({ title: 'ADR-0002: Lotes de 200', status: 'draft', version: 2, tags: ['ingesta'] });
    expect(d.body).toContain('los lotes son de 200');
    expect(d.revisions[0]).toMatchObject({ version: 2, editedVia: 'web', editedByName: 'Ana' });
    // La procedencia queda como dato ("importado de…"), ya no como candado.
    expect(d).toMatchObject({ source: 'git', sourceRepo: REPO, sourcePath: 'docs/adr/0002-ingesta-por-lotes.md' });
    expect(d.sourceUrl).toContain('/blob/main/docs/adr/0002-ingesta-por-lotes.md');
  });

  it('la ingesta no pisa un nodo editado en zeus aunque su archivo cambie en el repo', async () => {
    files['docs/adr/0002-ingesta-por-lotes.md'] = '# ADR-0002: Ingesta por lotes\n\nStatus: Accepted\n\nSupersedes ADR-0001\n\nLos eventos entran por lotes de 1000.';
    blobReads = [];
    const before = await bySlug('0002-ingesta-por-lotes');
    expect(await ingestRepo(REPO, source)).toMatchObject({ created: 0, kept: 5 });
    expect(blobReads).toEqual([]);
    const after = await bySlug('0002-ingesta-por-lotes');
    expect(after).toEqual(before);
    expect(after).toMatchObject({ title: 'ADR-0002: Lotes de 200', status: 'draft', version: 2 });
    expect(after.body).toContain('los lotes son de 200');
    expect((await getNodeDetail(after.id)).revisions.map((r) => r.editedVia)).toEqual(['web', 'git']);
  });

  it('tampoco pisa uno que nadie ha editado: lo que ya está en zeus no se vuelve a leer', async () => {
    files['AGENTS.md'] = '# Guía para agentes\n\nCorre las pruebas Y el typecheck antes de abrir una PR.';
    files['openspec/changes/add-replay/tasks.md'] = '# Tasks\n\n- [x] 1.1 Capturar eventos del DOM\n- [ ] 1.2 Reproducir';
    const before = await gitNodes();
    blobReads = [];
    expect(await ingestRepo(REPO, source)).toMatchObject({ created: 0, kept: 5 });
    expect(blobReads).toEqual([]);
    const after = await gitNodes();
    expect(after).toEqual(before);
    const agents = after.find((n) => n.slug === 'agents')!;
    expect(agents.version).toBe(1);
    expect(agents.body).not.toContain('typecheck');
    expect(after.find((n) => n.kind === 'change')!.body).not.toContain('1.2 Reproducir');
    expect((await getNodeDetail(agents.id)).revisions).toHaveLength(1);
  });

  it('una conexión que vino de la importación se quita desde zeus y no regresa', async () => {
    const adr2 = await bySlug('0002-ingesta-por-lotes');
    const edge = (await gitEdges()).find((e) => e.kind === 'relates_to')!;
    await expect(deleteEdge({ id: edge.id }, await actor(ids.ana))).resolves.toBeUndefined();
    expect((await gitEdges()).map((e) => e.kind)).toEqual(['supersedes']);
    await ingestRepo(REPO, source);
    expect((await gitEdges()).map((e) => e.kind)).toEqual(['supersedes']);
    expect((await getNodeDetail(adr2.id)).edges.map((e) => e.kind)).toEqual(['supersedes']);
  });

  it('importa un documento nuevo, con sus aristas iniciales, sin tocar los que ya estaban', async () => {
    files['docs/adr/0003-colas.md'] = '# ADR-0003: Colas con pgmq\n\nStatus: Accepted\n\nSupersedes ADR-0002\n\nLas colas viven en Postgres. Ver la [guía](../../AGENTS.md).';
    const before = await gitNodes();
    blobReads = [];
    const r = await ingestRepo(REPO, source);
    expect(r).toMatchObject({ documents: 6, created: 1, kept: 5, edges: 2 });
    expect(blobReads).toEqual(['docs/adr/0003-colas.md']);
    const adr3 = await bySlug('0003-colas');
    expect(adr3).toMatchObject({ kind: 'adr', title: 'ADR-0003: Colas con pgmq', status: 'active', version: 1, project_id: ids.orwel, source_path: 'docs/adr/0003-colas.md' });
    const adr2 = await bySlug('0002-ingesta-por-lotes');
    const agents = await bySlug('agents');
    expect((await gitEdges()).filter((e) => e.src_ref === `node:${adr3.id}`).map((e) => [e.kind, e.dst_ref])).toEqual([
      ['relates_to', `node:${agents.id}`],
      ['supersedes', `node:${adr2.id}`],
    ]);
    // Los demás quedan idénticos: el ADR-0002 sigue en borrador porque así lo dejaron en zeus.
    expect((await gitNodes()).filter((n) => n.id !== adr3.id)).toEqual(before);
    expect(adr2.status).toBe('draft');
    // Ya importado, la siguiente lectura no lo duplica.
    expect(await ingestRepo(REPO, source)).toMatchObject({ documents: 6, created: 0, kept: 6 });
    expect((await gitNodes()).filter((n) => n.source_path === 'docs/adr/0003-colas.md')).toHaveLength(1);
  });

  it('un archivo borrado del repo no archiva su nodo, y si regresa tampoco lo pisa', async () => {
    const before = await bySlug('ingest');
    const text = files['openspec/specs/ingest/spec.md']!;
    delete files['openspec/specs/ingest/spec.md'];
    const r = await ingestRepo(REPO, source);
    expect(r).toMatchObject({ documents: 5, created: 0, kept: 5 });
    expect(r).not.toHaveProperty('archived');
    expect(await bySlug('ingest')).toEqual(before);
    expect(before.status).toBe('active');
    files['openspec/specs/ingest/spec.md'] = text.replace('500', '1000');
    expect(await ingestRepo(REPO, source)).toMatchObject({ documents: 6, created: 0, kept: 6 });
    const after = await bySlug('ingest');
    expect(after).toEqual(before);
    expect(after.body).toContain('up to 500 events');
  });

  it('un documento archivado en zeus no resucita en la siguiente ingesta', async () => {
    const agents = await bySlug('agents');
    const a = await actor(ids.ana);
    // Un documento importado se archiva desde zeus igual que uno manual.
    await expect(archiveNode(agents.id, a)).resolves.toBeUndefined();
    files['AGENTS.md'] = '# Guía para agentes\n\nVersión del repo posterior al archivado.';
    blobReads = [];
    expect(await ingestRepo(REPO, source)).toMatchObject({ created: 0, kept: 6 });
    expect(blobReads).toEqual([]);
    const rows = (await gitNodes()).filter((n) => n.source_path === 'AGENTS.md');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: agents.id, status: 'archived', version: 1 });
    expect(rows[0]!.body).not.toContain('posterior al archivado');
    expect((await listNodes({ projectId: ids.orwel })).some((n) => n.id === agents.id)).toBe(false);
    // Y se restaura desde zeus, no desde git.
    expect((await updateNode(agents.id, { status: 'active' }, a)).status).toBe('active');
  });

  it('un cambio que gana o pierde archivos en el repo sigue siendo el mismo documento', async () => {
    const before = await bySlug('add-replay');
    const proposal = files['openspec/changes/add-replay/proposal.md']!;
    files['openspec/changes/add-replay/design.md'] = '# Design\n\nGrabamos con rrweb.';
    // Sin la propuesta, la ruta principal del grupo pasa a ser design.md: sigue siendo el mismo nodo.
    delete files['openspec/changes/add-replay/proposal.md'];
    expect(await ingestRepo(REPO, source)).toMatchObject({ created: 0, kept: 6 });
    expect((await gitNodes()).filter((n) => n.kind === 'change')).toEqual([before]);
    files['openspec/changes/add-replay/proposal.md'] = proposal.replace('del visitante', 'del visitante, con consentimiento');
    expect(await ingestRepo(REPO, source)).toMatchObject({ created: 0, kept: 6 });
    expect((await gitNodes()).filter((n) => n.kind === 'change')).toEqual([before]);
  });

  it('"traer la versión del repo" aplica el archivo como una edición más y deja revisión', async () => {
    const adr = await bySlug('0002-ingesta-por-lotes');
    const r = await reimportNode(adr.id, await actor(ids.beto), source);
    expect(r.changed).toBe(true);
    expect(r.node).toMatchObject({ title: 'ADR-0002: Ingesta por lotes', version: 3, source: 'git', sourcePath: 'docs/adr/0002-ingesta-por-lotes.md' });
    expect(r.node.body).toContain('lotes de 1000');
    expect(r.node.body).not.toContain('los lotes son de 200');
    expect(r.node.revisions.map((x) => [x.version, x.editedVia, x.editedByName])).toEqual([[3, 'git', 'Beto'], [2, 'web', 'Ana'], [1, 'git', null]]);
    // Solo trae contenido: el estado, las etiquetas y las conexiones siguen siendo los de zeus.
    expect(r.node).toMatchObject({ status: 'draft', tags: ['ingesta'] });
    expect(r.node.edges.map((e) => [e.direction, e.kind]).sort()).toEqual([['in', 'supersedes'], ['out', 'supersedes']]);
    // La edición anterior sigue en el historial.
    const [v2] = await pg.sql<{ body: string }>('select body from roz.zeus_node_revision where node_id = $1 and version = 2', [adr.id]);
    expect(v2!.body).toContain('los lotes son de 200');
    const [v3] = await pg.sql<{ body: string }>('select body from roz.zeus_node_revision where node_id = $1 and version = 3', [adr.id]);
    expect(v3!.body).toContain('lotes de 1000');

    // Sin diferencias con el repo no inventa una versión.
    const again = await reimportNode(adr.id, await actor(ids.beto), source);
    expect(again.changed).toBe(false);
    expect(again.node.version).toBe(3);
    expect(again.node.revisions).toHaveLength(3);

    // Un documento de varios archivos se rearma completo.
    const change = await reimportNode((await bySlug('add-replay')).id, await actor(ids.ana), source);
    expect(change.node.version).toBe(2);
    for (const piece of ['con consentimiento', '## Diseño', 'Grabamos con rrweb', '1.2 Reproducir']) expect(change.node.body, piece).toContain(piece);
    expect(change.node.sourcePath).toBe('openspec/changes/add-replay/proposal.md');
    expect(change.node.meta.files).toEqual(['openspec/changes/add-replay/proposal.md', 'openspec/changes/add-replay/design.md', 'openspec/changes/add-replay/tasks.md']);
  });

  it('"traer la versión del repo" falla limpio si el archivo ya no existe o el documento no es importado', async () => {
    const spec = await bySlug('ingest');
    delete files['openspec/specs/ingest/spec.md'];
    const a = await actor(ids.ana);
    await expect(reimportNode(spec.id, a, source)).rejects.toMatchObject({
      code: 'ZEUS_SOURCE_GONE',
      status: 404,
      message: expect.stringContaining('ya no existe en hyperlabs-ai/orwel'),
      details: { repo: REPO, path: 'openspec/specs/ingest/spec.md', branch: 'main' },
    });
    // Con el árbol truncado no se puede afirmar que desapareció.
    truncated = true;
    await expect(reimportNode(spec.id, a, source)).rejects.toMatchObject({ code: 'ZEUS_SOURCE_TRUNCATED', status: 409 });
    truncated = false;
    // El documento queda exactamente como estaba.
    expect(await bySlug('ingest')).toEqual(spec);
    expect((await getNodeDetail(spec.id)).revisions).toHaveLength(1);

    const [manual] = await pg.sql<{ id: string }>("select id from roz.zeus_node where source = 'manual' limit 1");
    await expect(reimportNode(manual!.id, a, source)).rejects.toMatchObject({ code: 'ZEUS_NOT_IMPORTED', status: 409 });
    await expect(reimportNode('3f2504e0-4f89-41d3-9a0c-0305e82c3301', a, source)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('varios repos del mismo proyecto con el mismo archivo no chocan: el nodo lleva el nombre de su repo', async () => {
    await pg.sql("insert into roz.project_repo (project_id, repo) values ($1, 'hyperlabs-ai/orwel-api'), ($1, 'hyperlabs-ai/orwel-sdk'), ($1, 'hyperlabs-ai/orwel-llm')", [ids.orwel]);
    const one: GitSource = {
      snapshot: async () => ({ defaultBranch: 'main', commitSha: 'x', truncated: false, files: [{ path: 'AGENTS.md', sha: 'a1', size: 10 }, { path: 'docs/adr/0001-usar-sveltekit.md', sha: 'a2', size: 10 }] }),
      blob: async (_r, s) => (s === 'a1' ? '# Guía de este repo\n\nTexto propio de este repositorio.' : '# ADR-0001 de este repo\n\nOtra decisión con el mismo número.'),
    };
    for (const repo of ['hyperlabs-ai/orwel-api', 'hyperlabs-ai/orwel-sdk', 'hyperlabs-ai/orwel-llm']) {
      expect(await ingestRepo(repo, one)).toMatchObject({ created: 2, kept: 0 });
    }
    const slugs = await pg.sql<{ slug: string }>("select slug from roz.zeus_node where source = 'git' and source_path = 'AGENTS.md' order by slug");
    expect(slugs.map((r) => r.slug)).toEqual(['agents', 'agents-orwel-api', 'agents-orwel-llm', 'agents-orwel-sdk']);
    // Releer no duplica ni renombra.
    expect(await ingestRepo('hyperlabs-ai/orwel-sdk', one)).toMatchObject({ created: 0, kept: 2 });
    await pg.sql("delete from roz.zeus_node where source_repo in ('hyperlabs-ai/orwel-api', 'hyperlabs-ai/orwel-sdk', 'hyperlabs-ai/orwel-llm')");
    await pg.sql("delete from roz.zeus_source where repo <> 'hyperlabs-ai/orwel'");
    await pg.sql("delete from roz.project_repo where repo <> 'hyperlabs-ai/orwel'");
  });

  it('rechaza repos sin proyecto o mal formados', async () => {
    await expect(ingestRepo('hyperlabs-ai/desconocido', source)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(ingestRepo('../../etc', source)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await markSourceDirty('hyperlabs-ai/desconocido')).toBe(false);
  });

  it('la barrida atiende lo pendiente y deja el error a la vista sin reintentar en bucle', async () => {
    expect(await markSourceDirty(REPO)).toBe(true);
    expect((await listSources())[0]).toMatchObject({ repo: REPO, pending: true, projectKey: 'ORWEL' });
    const before = await gitNodes();
    const ok = await zeusSweep(source);
    expect(ok.ingested.map((r) => r.repo)).toEqual([REPO]);
    expect(ok.ingested[0]).toMatchObject({ documents: 5, created: 0, kept: 5 });
    expect((await listSources())[0]).toMatchObject({ pending: false, lastError: null, nodeCount: 5, defaultBranch: 'main' });
    // La barrida tampoco toca lo que ya está en zeus.
    expect(await gitNodes()).toEqual(before);
    // Nada pendiente y leído hace un momento: la barrida no hace nada.
    expect((await zeusSweep(source)).ingested).toEqual([]);

    await markSourceDirty(REPO);
    const broken: GitSource = { snapshot: async () => { throw new Error('GitHub 502'); }, blob: source.blob };
    const bad = await zeusSweep(broken);
    expect(bad.failed).toEqual([{ repo: REPO, error: 'GitHub 502' }]);
    expect((await listSources())[0]).toMatchObject({ pending: false, lastError: 'GitHub 502' });
    expect((await zeusSweep(broken)).failed).toEqual([]);
  });
});

// ================================================================ organización y grafo

describe('organización y grafo', () => {
  it('arma el organigrama con proyectos y quién está en línea', async () => {
    const org = await getOrg();
    const ana = org.members.find((m) => m.devId === ids.ana)!;
    expect(ana).toMatchObject({ name: 'Ana', reportsTo: ids.pm, projects: ['ORWEL'], online: true, zeusAdmin: false });
    expect(org.members.find((m) => m.devId === ids.ceo)!.zeusAdmin).toBe(true);
    expect(org.needsAdmin).toBe(false);
  });

  it('solo un admin cambia la jerarquía, y no se pueden cerrar ciclos', async () => {
    await expect(updateOrgMember(ids.caro, { reportsTo: ids.beto }, await actor(ids.ana))).rejects.toMatchObject({ code: 'ZEUS_ADMIN_ONLY' });
    const admin = await actor(ids.ceo);
    // Paula ← Ana ← Caro: Paula no puede reportar a Caro.
    await expect(updateOrgMember(ids.pm, { reportsTo: ids.caro }, admin)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(updateOrgMember(ids.pm, { reportsTo: ids.pm }, admin)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await updateOrgMember(ids.pm, { reportsTo: ids.ceo }, admin)).toMatchObject({ reportsTo: ids.ceo });
  });

  it('nombrar y quitar administradores, sin dejar a zeus sin ninguno', async () => {
    const admin = await actor(ids.ceo);
    expect(await updateOrgMember(ids.pm, { zeusAdmin: true }, admin)).toMatchObject({ zeusAdmin: true });
    expect((await actor(ids.pm)).admin).toBe(true);
    await expect(updateOrgMember(ids.ceo, { zeusAdmin: false }, admin)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await updateOrgMember(ids.pm, { zeusAdmin: false }, admin)).toMatchObject({ zeusAdmin: false });
    await expect(bootstrapAdmin(await actor(ids.ana))).rejects.toMatchObject({ code: 'ZEUS_HAS_ADMIN' });
  });

  it('el grafo mezcla documentos con personas, proyectos, repos y equipos, con aristas derivadas', async () => {
    const g = await getGraph();
    const kinds = new Set(g.nodes.map((n) => n.kind));
    for (const k of ['project', 'dev', 'repo', 'runner', 'adr', 'rule', 'change']) expect(kinds, k).toContain(k);
    const has = (src: string, kind: string, dst: string) => g.edges.some((e) => e.src === src && e.kind === kind && e.dst === dst);
    expect(has(`dev:${ids.ana}`, 'reports_to', `dev:${ids.pm}`)).toBe(true);
    expect(has(`dev:${ids.ana}`, 'part_of', `project:${ids.orwel}`)).toBe(true);
    expect(has('repo:hyperlabs-ai/orwel', 'part_of', `project:${ids.orwel}`)).toBe(true);
    expect(g.edges.some((e) => e.src.startsWith('runner:') && e.kind === 'part_of' && e.dst === `dev:${ids.ana}`)).toBe(true);
    expect(g.edges.some((e) => e.kind === 'supersedes' && !e.derived)).toBe(true);
    // Toda arista apunta a nodos presentes, y no hay refs repetidas.
    const refs = new Set(g.nodes.map((n) => n.ref));
    expect(refs.size).toBe(g.nodes.length);
    expect(g.edges.every((e) => refs.has(e.src) && refs.has(e.dst))).toBe(true);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
    expect(g.counts.dev).toBe(5);
    expect(g.nodes.find((n) => n.ref === `dev:${ids.ana}`)!.meta).toMatchObject({ online: true, role: 'dev' });
  });

  it('filtrado por proyecto: su gente, sus documentos y lo de la organización', async () => {
    const g = await getGraph({ projectId: ids.orwel });
    expect(g.nodes.filter((n) => n.kind === 'project').map((n) => n.title)).toEqual(['Orwel']);
    expect(g.nodes.filter((n) => n.kind === 'dev').map((n) => n.title).sort()).toEqual(['Ana', 'Paula']);
    expect(g.nodes.some((n) => n.title === 'No subir secretos al repo')).toBe(true);
    const empty = await getGraph({ projectId: ids.hub });
    expect(empty.nodes.filter((n) => n.kind === 'dev')).toEqual([]);
    const refs = new Set(empty.nodes.map((n) => n.ref));
    expect(empty.edges.every((e) => refs.has(e.src) && refs.has(e.dst))).toBe(true);
  });
});

// ================================================================ bandeja

describe('solicitudes: a quién le toca', () => {
  let resourceId = '';

  beforeAll(async () => {
    const d = await createNode({ kind: 'resource', title: 'Proyecto de Vercel de Orwel', projectId: ids.orwel, ownerDevId: ids.beto, meta: { type: 'vercel' } }, await actor(ids.ceo));
    resourceId = d.id;
  });

  it('dueño del recurso → líder del proyecto → jefe directo → admin', async () => {
    expect(await routeFor(ids.caro, `node:${resourceId}`)).toMatchObject({ approver: { id: ids.beto }, because: expect.stringContaining('dueño') });
    // Proyecto sin recurso: quien lo lleva (rol pm asignado).
    expect(await routeFor(ids.caro, `project:${ids.orwel}`)).toMatchObject({ approver: { id: ids.pm }, because: expect.stringContaining('proyecto') });
    expect(await routeFor(ids.caro, 'repo:hyperlabs-ai/orwel')).toMatchObject({ approver: { id: ids.pm } });
    // Proyecto sin nadie asignado: el jefe directo.
    expect(await routeFor(ids.caro, `project:${ids.hub}`)).toMatchObject({ approver: { id: ids.ana }, because: expect.stringContaining('jefe') });
    // Sin recurso y sin jefe: un admin.
    expect(await routeFor(ids.pm, null)).toMatchObject({ approver: { id: ids.ceo } });
    expect(await routeFor(ids.ceo, null)).toMatchObject({ approver: null });
  });

  it('nunca se enruta a quien pide', async () => {
    // Beto es el dueño: su propia solicitud sube al líder del proyecto.
    expect(await routeFor(ids.beto, `node:${resourceId}`)).toMatchObject({ approver: { id: ids.pm } });
    // Paula lleva el proyecto: la suya va con el otro del equipo.
    expect((await routeFor(ids.pm, `project:${ids.orwel}`)).approver?.id).toBe(ids.ana);
  });

  it('ciclo completo: abrir, avisar, aprobar, y que el solicitante se entere', async () => {
    pushToDev.mockClear();
    const caro = await actor(ids.caro, 'mcp');
    const req = await createRequest({ title: 'Acceso de lectura a Vercel de Orwel', detail: 'Para revisar logs', resourceRef: `node:${resourceId}` }, caro);
    expect(req).toMatchObject({ status: 'pending', approverName: 'Beto', resourceTitle: 'Proyecto de Vercel de Orwel', via: 'mcp', canResolve: false });
    await drainBackground();
    expect(pushToDev).toHaveBeenCalledWith(ids.beto, 'beto@hyper.test', expect.objectContaining({ title: 'Caro te pide algo' }), 'zeus');

    // No la resuelve quien la abrió ni un tercero sin rol.
    await expect(resolveRequest(req.id, 'approved', null, caro)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(resolveRequest(req.id, 'approved', null, await actor(ids.ana))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(resolveRequest(req.id, 'quizás' as never, null, await actor(ids.beto))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const beto = await actor(ids.beto);
    expect((await listRequests('to_me', beto)).map((r) => r.id)).toEqual([req.id]);
    expect((await listRequests('to_me', beto))[0]!.canResolve).toBe(true);
    const done = await resolveRequest(req.id, 'approved', 'Solo lectura, 30 días', beto);
    expect(done).toMatchObject({ status: 'approved', resolvedByName: 'Beto', resolutionNote: 'Solo lectura, 30 días' });
    await expect(resolveRequest(req.id, 'denied', null, beto)).rejects.toMatchObject({ code: 'ZEUS_REQUEST_CLOSED' });

    const inbox = await getInbox(caro);
    expect(inbox.unread).toBe(1);
    expect(inbox.messages[0]).toMatchObject({ fromName: 'zeus', via: 'system', requestId: req.id, subject: 'Beto aprobó tu solicitud' });
    // Aprobar no es dar el acceso: el aviso lo dice.
    expect(inbox.messages[0]!.body).toContain('Falta que te dé el acceso');
    expect(inbox.mine[0]).toMatchObject({ id: req.id, status: 'approved' });
  });

  it('un admin resuelve lo ajeno y lo que quedó sin aprobador; el dueño cancela lo suyo', async () => {
    const req = await createRequest({ title: 'Permiso para borrar una rama protegida', kind: 'permission', resourceRef: `node:${resourceId}` }, await actor(ids.caro));
    const ceo = await actor(ids.ceo);
    expect((await listRequests('all', ceo)).some((r) => r.id === req.id && r.canResolve)).toBe(true);
    expect(await resolveRequest(req.id, 'denied', 'No por ahora', ceo)).toMatchObject({ status: 'denied' });

    const own = await createRequest({ title: 'Algo que ya no necesito' }, await actor(ids.ana));
    await expect(cancelRequest(own.id, await actor(ids.beto))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await cancelRequest(own.id, await actor(ids.ana))).toMatchObject({ status: 'cancelled' });
    await expect(cancelRequest(own.id, await actor(ids.ana))).rejects.toMatchObject({ code: 'ZEUS_REQUEST_CLOSED' });
  });

  it('valida la solicitud', async () => {
    const a = await actor(ids.ana);
    await expect(createRequest({ title: ' ' }, a)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(createRequest({ title: 'x', kind: 'otra' as never }, a)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(createRequest({ title: 'x', resourceRef: 'cosa:1' }, a)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('mensajes', () => {
  it('llegan a la bandeja del destinatario, por nombre, correo o login', async () => {
    const beto = await actor(ids.beto, 'mcp');
    const m = await sendMessage({ to: 'ana', subject: 'Plan HUB-12', body: 'Te dejé el plan a medias, falta el paso 3.' }, beto);
    expect(m).toMatchObject({ fromName: 'Beto', toName: 'Ana', via: 'mcp', readAt: null });
    await sendMessage({ to: 'ana@hyper.test', body: 'por correo' }, beto);
    await sendMessage({ to: 'ana-gh', body: 'por login' }, beto);
    const inbox = await getInbox(await actor(ids.ana));
    expect(inbox.messages.map((x) => x.body)).toEqual(['por login', 'por correo', 'Te dejé el plan a medias, falta el paso 3.']);
    expect(inbox.unread).toBe(3);
    expect((await getInbox(beto)).sent).toHaveLength(3);
  });

  it('marcar leído solo afecta lo propio', async () => {
    const ana = await actor(ids.ana);
    const first = (await getInbox(ana)).messages[0]!;
    // Beto no puede marcar como leído un mensaje de Ana.
    expect(await markRead([first.id], await actor(ids.beto))).toBe(0);
    expect(await markRead([first.id, 'basura'], ana)).toBe(1);
    expect((await getInbox(ana)).unread).toBe(2);
    expect((await getInbox(ana, { unreadOnly: true })).messages).toHaveLength(2);
    expect(await markRead('all', ana)).toBe(2);
    expect((await getInbox(ana)).unread).toBe(0);
  });

  it('destinatario ambiguo, inexistente o mensaje inválido', async () => {
    await dev('Ana María');
    const beto = await actor(ids.beto);
    await expect(sendMessage({ to: 'ana', body: 'hola' }, beto)).resolves.toMatchObject({ toName: 'Ana' }); // coincidencia exacta gana
    await expect(sendMessage({ to: 'an', body: 'hola' }, beto)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('ambiguo') });
    await expect(sendMessage({ to: 'zoe', body: 'hola' }, beto)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(sendMessage({ to: 'ana', body: '   ' }, beto)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(sendMessage({ to: 'ana', body: 'x'.repeat(9000) }, beto)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

// ================================================================ HTTP: MCP y CLI

const rpc = async (token: string, method: string, params?: unknown) => {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, json: (await res.json()) as any };
};
const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const { json } = await rpc(token, 'tools/call', { name, arguments: args });
  const text = json.result?.content?.[0]?.text as string | undefined;
  return { isError: !!json.result?.isError, text: text ?? '', data: text && !json.result?.isError ? JSON.parse(text) : null, raw: json };
};

describe('MCP por HTTP', () => {
  let anaToken = '';
  let caroToken = '';

  beforeAll(async () => {
    anaToken = (await createToken('claude code', await actor(ids.ana))).token;
    caroToken = (await createToken('claude code', await actor(ids.caro))).token;
  });

  it('rechaza tokens inválidos o revocados', async () => {
    expect((await rpc('nada', 'tools/list')).status).toBe(401);
    expect((await rpc('zeus_' + 'a'.repeat(43), 'tools/list')).status).toBe(401);
    const tmp = await createToken('temporal', await actor(ids.beto));
    expect((await rpc(tmp.token, 'tools/list')).status).toBe(200);
    await revokeToken(tmp.summary.id, await actor(ids.beto));
    expect((await rpc(tmp.token, 'tools/list')).status).toBe(401);
  });

  it('un dev inactivo pierde el acceso aunque su token siga vigente', async () => {
    const id = await dev('Temporal');
    const { token } = await createToken('x', await actor(id));
    expect((await rpc(token, 'tools/list')).status).toBe(200);
    await pg.sql(`update roz.dev set active = false where id = $1`, [id]);
    expect((await rpc(token, 'tools/list')).status).toBe(401);
  });

  it('con token de dev se ven las herramientas de zeus; con el compartido, no', async () => {
    const mine = (await rpc(anaToken, 'tools/list')).json.result.tools.map((t: any) => t.name) as string[];
    expect(mine).toEqual(expect.arrayContaining(['zeus_context_index', 'zeus_search', 'zeus_get', 'zeus_write', 'zeus_reimport', 'zeus_unlink', 'zeus_request', 'zeus_send_message', 'zeus_env_status', 'list_projects']));
    // Dar de alta devs o cambiar disponibilidad no es de un token personal.
    expect(mine).not.toContain('upsert_dev');
    expect(mine).not.toContain('set_availability');
    const shared = (await rpc('token-compartido-de-prueba', 'tools/list')).json.result.tools.map((t: any) => t.name) as string[];
    expect(shared).toContain('upsert_dev');
    expect(shared.some((n) => n.startsWith('zeus_'))).toBe(false);
    // Y tampoco puede llamarlas adivinando el nombre.
    expect((await rpc('token-compartido-de-prueba', 'tools/call', { name: 'zeus_inbox', arguments: {} })).status).toBe(400);
    expect((await rpc(anaToken, 'tools/call', { name: 'upsert_dev', arguments: { name: 'x' } })).status).toBe(400);
  });

  it('todas las herramientas publican un esquema de entrada válido', async () => {
    const tools = (await rpc(anaToken, 'tools/list')).json.result.tools as Array<{ name: string; description: string; inputSchema: any }>;
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.description.length, t.name).toBeGreaterThan(20);
    }
    const write = tools.find((t) => t.name === 'zeus_write')!;
    expect(write.inputSchema.properties.kind.enum).toContain('adr');
    // El agente tiene que entender que se edita en el registro central, no en el repo.
    expect(write.description).toContain('fuente de verdad');
    expect(write.description).toContain('también los importados de un repo');
    expect(tools.map((t) => t.description).join('\n')).not.toMatch(/NO se editan aquí|vive en git/);
    expect(tools.find((t) => t.name === 'zeus_search')!.inputSchema.required).toEqual(['query']);
  });

  it('flujo de contexto: índice → búsqueda → documento', async () => {
    const idx = await call(anaToken, 'zeus_context_index', { projectKey: 'orwel' });
    expect(idx.data.project.key).toBe('ORWEL');
    expect(idx.data.entries[0].title).toBe('No subir secretos al repo');
    const found = await call(anaToken, 'zeus_search', { query: 'postgres', projectKey: 'ORWEL' });
    expect(found.data.hits[0]).toMatchObject({ title: 'Usar Postgres', kind: 'adr' });
    const doc = await call(anaToken, 'zeus_get', { ref: found.data.hits[0].ref });
    expect(doc.data).toMatchObject({ title: 'Usar Postgres', project: 'ORWEL', source: 'manual (se edita en zeus)' });
    expect(doc.data.body).toContain('pgvector');
    expect(doc.data.connections[0]).toMatchObject({ relation: 'supersedes', title: 'Usar Mongo' });
    expect((await call(anaToken, 'zeus_search', { query: 'inexistentexyz' })).data.hint).toBeTruthy();
  });

  it('un documento reemplazado avisa que ya no está vigente; uno largo se pagina', async () => {
    const old = (await listNodes({ status: 'superseded' })).find((n) => n.title === 'Usar Mongo')!;
    expect((await call(anaToken, 'zeus_get', { ref: old.ref })).data.warning).toContain('superseded');
    const big = await createNode({ kind: 'doc', title: 'Documento largo', body: 'a'.repeat(3000) + 'FIN' }, await actor(ids.ana));
    const p1 = await call(anaToken, 'zeus_get', { ref: big.id, maxChars: 1000 });
    expect(p1.data.body).toHaveLength(1000);
    expect(p1.data.truncated).toContain('offset 1000');
    const p3 = await call(anaToken, 'zeus_get', { ref: big.ref, maxChars: 2000, offset: 2000 });
    expect(p3.data.body.endsWith('FIN')).toBe(true);
    expect(p3.data.truncated).toBeUndefined();
  });

  it('escribir por MCP queda atribuido al dev del token', async () => {
    const w = await call(caroToken, 'zeus_write', { kind: 'rule', title: 'Commits en español', summary: 'Los mensajes de commit van en español.', projectKey: 'ORWEL', owner: 'Ana' });
    expect(w.data).toMatchObject({ ok: true, version: 1, project: 'ORWEL' });
    const d = await getNodeDetail(w.data.ref.slice(5));
    expect(d.revisions[0]).toMatchObject({ editedByName: 'Caro', editedVia: 'mcp' });
    expect(d.ownerDevId).toBe(ids.ana);
    const upd = await call(caroToken, 'zeus_write', { ref: w.data.ref, body: 'Detalle de la regla.' });
    expect(upd.data.version).toBe(2);
  });

  it('un documento importado de un repo se edita, se desconecta, se re-importa y se archiva por MCP', async () => {
    const git = (await listNodes({ kind: 'adr' })).find((n) => n.source === 'git' && n.slug === '0003-colas')!;
    const w = await call(anaToken, 'zeus_write', { ref: git.ref, body: '# ADR-0003\n\nEditado por el agente en el registro central.', summary: 'Las colas viven en Postgres (pgmq).' });
    expect(w.isError).toBe(false);
    expect(w.data).toMatchObject({ ok: true, ref: git.ref, version: 2 });
    const d = await getNodeDetail(git.id);
    expect(d.body).toContain('Editado por el agente en el registro central');
    expect(d).toMatchObject({ summary: 'Las colas viven en Postgres (pgmq).', source: 'git', sourcePath: 'docs/adr/0003-colas.md' });
    expect(d.revisions[0]).toMatchObject({ version: 2, editedVia: 'mcp', editedByName: 'Ana' });
    // Al leerlo, el agente ve de dónde se importó y que la versión vigente es la de zeus.
    const doc = await call(anaToken, 'zeus_get', { ref: git.ref });
    expect(doc.data.source.importedFrom).toMatchObject({ repo: 'hyperlabs-ai/orwel', path: 'docs/adr/0003-colas.md' });
    expect(doc.data.source.note).toContain('se edita en zeus');
    expect(doc.data.body).toContain('Editado por el agente');

    // Una conexión que salió de la importación también se quita por MCP.
    const out = d.edges.find((e) => e.direction === 'out' && e.kind === 'supersedes')!;
    expect(out.source).toBe('git');
    expect((await call(anaToken, 'zeus_unlink', { from: git.ref, to: out.otherRef, kind: 'supersedes' })).data).toEqual({ ok: true });
    expect((await getNodeDetail(git.id)).edges.some((e) => e.kind === 'supersedes')).toBe(false);

    // "Traer la versión del repo" por MCP, contra un GitHub de mentira (la herramienta usa la fuente real).
    const gh = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const base = '/repos/hyperlabs-ai/orwel';
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = new URL(String(url));
      asked.push(u.host);
      if (u.pathname === base) return gh({ default_branch: 'main' });
      if (u.pathname === `${base}/branches/main`) return gh({ commit: { sha: 'c1', commit: { tree: { sha: 't1' } } } });
      if (u.pathname === `${base}/git/trees/t1`) return gh({ truncated: false, tree: [{ path: 'docs/adr/0003-colas.md', type: 'blob', sha: 'b1', size: 60 }] });
      if (u.pathname === `${base}/git/blobs/b1`) return gh({ encoding: 'base64', content: Buffer.from('# ADR-0003: Colas con pgmq\n\nTexto del repo, versión nueva.').toString('base64') });
      return new Response('no encontrado', { status: 404 });
    });
    try {
      const re = await call(anaToken, 'zeus_reimport', { ref: git.ref });
      expect(re.isError).toBe(false);
      expect(re.data).toMatchObject({ ok: true, changed: true, version: 3, from: { repo: 'hyperlabs-ai/orwel', path: 'docs/adr/0003-colas.md' } });
      const after = await getNodeDetail(git.id);
      expect(after.body).toContain('Texto del repo, versión nueva');
      expect(after.revisions[0]).toMatchObject({ version: 3, editedVia: 'git', editedByName: 'Ana' });
      expect(new Set(asked)).toEqual(new Set(['api.github.com']));
      // Mismo archivo otra vez: no cambia nada y lo dice.
      expect((await call(anaToken, 'zeus_reimport', { ref: git.ref })).data).toMatchObject({ changed: false, version: 3 });
      // El archivo ya no está en el repo: error limpio con el dato.
      const other = (await listNodes({ kind: 'adr' })).find((n) => n.source === 'git' && n.slug === '0001-usar-sveltekit')!;
      const gone = await call(anaToken, 'zeus_reimport', { ref: other.ref });
      expect(gone.isError).toBe(true);
      expect(gone.text).toContain('ZEUS_SOURCE_GONE');
      expect(gone.text).toContain('docs/adr/0001-usar-sveltekit.md');
    } finally {
      vi.unstubAllGlobals();
    }

    expect((await call(anaToken, 'zeus_write', { ref: git.ref, status: 'archived' })).data).toMatchObject({ ok: true, status: 'archived' });
    expect((await getNodeDetail(git.id)).status).toBe('archived');
  });

  it('los errores de dominio llegan limpios, con el dato que el agente necesita', async () => {
    const manual = (await listNodes({ kind: 'adr' })).find((n) => n.source === 'manual')!;
    const r = await call(anaToken, 'zeus_reimport', { ref: manual.ref });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('ZEUS_NOT_IMPORTED');
    expect((await call(anaToken, 'zeus_write', { title: 'sin tipo' })).text).toContain('VALIDATION_ERROR');
    expect((await call(anaToken, 'zeus_context_index', { projectKey: 'NOEXISTE' })).text).toContain('NOT_FOUND');
    expect((await rpc(anaToken, 'tools/call', { name: 'zeus_search', arguments: {} })).status).toBe(400);
  });

  it('a quién pedirle, pedirlo y verlo en la bandeja del otro, todo por MCP', async () => {
    const who = await call(caroToken, 'zeus_who_owns', { query: 'vercel', projectKey: 'ORWEL' });
    expect(who.data).toMatchObject({ matched: 'Proyecto de Vercel de Orwel', askTo: { name: 'Beto' } });
    const req = await call(caroToken, 'zeus_request', { title: 'Acceso a los logs de Vercel', resourceRef: who.data.resource });
    expect(req.data).toMatchObject({ ok: true, sentTo: 'Beto' });
    const betoToken = (await createToken('cc', await actor(ids.beto))).token;
    const inbox = await call(betoToken, 'zeus_inbox');
    expect(inbox.data.toResolve.map((r: any) => r.title)).toContain('Acceso a los logs de Vercel');
    // Caro no puede aprobarse a sí misma por MCP.
    expect((await call(caroToken, 'zeus_resolve_request', { id: req.data.id, decision: 'approved' })).text).toContain('FORBIDDEN');
    expect((await call(betoToken, 'zeus_resolve_request', { id: req.data.id, decision: 'approved', note: 'ok' })).data.status).toBe('approved');
    const org = await call(caroToken, 'zeus_org', { query: 'orwel' });
    expect(org.data.members.map((m: any) => m.name).sort()).toEqual(['Ana', 'Paula']);
    expect(org.data.members.find((m: any) => m.name === 'Ana')).toMatchObject({ reportsTo: 'Paula', online: true });
  });

  it('deja rastro de quién consultó qué', async () => {
    const rows = await pg.sql<{ action: string; actor: string; dev_id: string }>(`select action, actor, dev_id from roz.zeus_activity where actor = 'mcp' order by id`);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['index', 'search', 'get', 'write', 'request']) expect(actions, a).toContain(a);
    expect(rows.every((r) => !!r.dev_id)).toBe(true);
  });
});

describe('bóveda de punta a punta (cifrado real del CLI contra el servidor)', () => {
  const P = 'ORWEL';
  const E = 'development';
  let adminToken = '';
  let anaToken = '';
  let betoToken = '';
  const adminKey = generateDeviceKey();
  const anaKey = generateDeviceKey();
  const betoKey = generateDeviceKey();
  const keyIds = { admin: '', ana: '', beto: '' };
  let dek = generateDek();

  const http = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1/zeus${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const enc = (name: string, value: string, key = dek, version = 1) => ({ name, ciphertext: encryptSecret(key, value, secretAad(P, E, name, version)) });

  beforeAll(async () => {
    adminToken = (await createToken('cli', await actor(ids.ceo))).token;
    anaToken = (await createToken('cli', await actor(ids.ana))).token;
    betoToken = (await createToken('cli', await actor(ids.beto))).token;
  });

  it('whoami y registro de la llave de cada equipo', async () => {
    expect((await http('zeus_' + 'x'.repeat(43), 'GET', '/whoami')).status).toBe(401);
    expect((await http(adminToken, 'GET', '/whoami')).json).toMatchObject({ dev: { name: 'Fer' }, zeusAdmin: true });
    for (const [who, token, key, name] of [['admin', adminToken, adminKey, 'pc-fer'], ['ana', anaToken, anaKey, 'laptop-ana'], ['beto', betoToken, betoKey, 'laptop-beto']] as const) {
      const r = await http(token, 'POST', '/vault/keys', { name, publicKey: key.publicKey });
      expect(r.status).toBe(200);
      expect(r.json.key.fingerprint).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
      keyIds[who] = r.json.key.id;
    }
    expect((await http(anaToken, 'POST', '/vault/keys', { name: 'otra', publicKey: anaKey.publicKey })).json.error.code).toBe('ZEUS_VAULT_KEY_EXISTS');
    expect((await http(anaToken, 'POST', '/vault/keys', { name: 'mala', publicKey: 'no-es-una-llave' })).status).toBe(400);
    // Cada quien ve sus llaves; solo un admin ve las de todos.
    expect((await http(anaToken, 'GET', '/vault/keys')).json.keys.map((k: any) => k.name)).toEqual(['laptop-ana']);
    expect((await http(anaToken, 'GET', '/vault/keys?all=1')).status).toBe(403);
    expect((await http(adminToken, 'GET', '/vault/keys?all=1')).json.keys).toHaveLength(3);
  });

  it('solo un admin crea el entorno, con la DEK envuelta para su propio equipo', async () => {
    const wrapped = wrapDek(dek, adminKey.publicKey, wrapAad(P, E, 1));
    expect((await http(anaToken, 'POST', '/vault/envs', { projectKey: P, env: E, keyId: keyIds.ana, wrappedDek: wrapDek(dek, anaKey.publicKey, wrapAad(P, E, 1)) })).status).toBe(403);
    // No puede usar la llave de otro.
    expect((await http(adminToken, 'POST', '/vault/envs', { projectKey: P, env: E, keyId: keyIds.ana, wrappedDek: wrapped })).json.error.code).toBe('ZEUS_VAULT_NO_ACCESS');
    expect((await http(adminToken, 'POST', '/vault/envs', { projectKey: P, env: 'Producción', keyId: keyIds.admin, wrappedDek: wrapped })).status).toBe(400);
    expect((await http(adminToken, 'POST', '/vault/envs', { projectKey: P, env: E, keyId: keyIds.admin, wrappedDek: 'zv1.falso' })).status).toBe(400);
    const ok = await http(adminToken, 'POST', '/vault/envs', { projectKey: P, env: E, keyId: keyIds.admin, wrappedDek: wrapped });
    expect(ok.json).toMatchObject({ dekVersion: 1 });
    expect((await http(adminToken, 'POST', '/vault/envs', { projectKey: P, env: E, keyId: keyIds.admin, wrappedDek: wrapped })).json.error.code).toBe('ZEUS_VAULT_ENV_EXISTS');
  });

  it('el servidor rechaza un valor en claro y nunca guarda nada legible', async () => {
    const plain = await http(adminToken, 'PUT', `/vault/envs/${P}/${E}/secrets`, { keyId: keyIds.admin, dekVersion: 1, set: [{ name: 'DATABASE_URL', ciphertext: 'postgres://u:supersecreto@h/db' }] });
    expect(plain.status).toBe(400);
    // El error no repite el valor.
    expect(JSON.stringify(plain.json)).not.toContain('supersecreto');
    expect((await http(adminToken, 'PUT', `/vault/envs/${P}/${E}/secrets`, { keyId: keyIds.admin, dekVersion: 1, set: [{ name: 'MAL NOMBRE', ciphertext: enc('X', 'v').ciphertext }] })).status).toBe(400);

    const push = await http(adminToken, 'PUT', `/vault/envs/${P}/${E}/secrets`, {
      keyId: keyIds.admin,
      dekVersion: 1,
      set: [enc('DATABASE_URL', 'postgres://u:supersecreto@h/db'), enc('STRIPE_KEY', 'sk_live_ñandú "con" comillas\ny salto'), enc('VACIA', '')],
    });
    expect(push.json).toMatchObject({ ok: true, written: 3, deleted: 0 });
    const dump = JSON.stringify(await pg.sql(`select * from roz.zeus_vault_secret`)) + JSON.stringify(await pg.sql(`select * from roz.zeus_vault_grant`)) + JSON.stringify(await pg.sql(`select * from roz.zeus_vault_audit`));
    for (const leak of ['supersecreto', 'sk_live', 'ñandú', Buffer.from(dek).toString('base64url'), Buffer.from(dek).toString('hex')]) expect(dump, leak).not.toContain(leak);
  });

  it('quien no tiene acceso no baja nada; tras recibirlo, descifra lo mismo que se subió', async () => {
    expect((await http(anaToken, 'GET', `/vault/envs/${P}/${E}?keyId=${keyIds.ana}`)).json.error.code).toBe('ZEUS_VAULT_NO_ACCESS');
    // Ni usando la llave de otro.
    expect((await http(anaToken, 'GET', `/vault/envs/${P}/${E}?keyId=${keyIds.admin}`)).json.error.code).toBe('ZEUS_VAULT_NO_ACCESS');
    expect((await http(anaToken, 'GET', `/vault/envs/${P}/noexiste?keyId=${keyIds.ana}`)).status).toBe(404);

    // Un dev no puede darse acceso a sí mismo.
    const selfGrant = { keyId: keyIds.ana, grants: [{ keyId: keyIds.ana, wrappedDek: wrapDek(dek, anaKey.publicKey, wrapAad(P, E, 1)) }] };
    expect((await http(anaToken, 'POST', `/vault/envs/${P}/${E}/grants`, selfGrant)).status).toBe(403);

    const grant = await http(adminToken, 'POST', `/vault/envs/${P}/${E}/grants`, { keyId: keyIds.admin, grants: [{ keyId: keyIds.ana, wrappedDek: wrapDek(dek, anaKey.publicKey, wrapAad(P, E, 1)) }] });
    expect(grant.json).toMatchObject({ ok: true, granted: 1 });

    const pull = await http(anaToken, 'GET', `/vault/envs/${P}/${E}?keyId=${keyIds.ana}`);
    expect(pull.status).toBe(200);
    const anaDek = unwrapDek(pull.json.wrappedDek, anaKey.privateKey, anaKey.publicKey, wrapAad(P, E, pull.json.dekVersion));
    const values = Object.fromEntries(pull.json.secrets.map((s: any) => [s.name, decryptSecret(anaDek, s.ciphertext, secretAad(P, E, s.name, s.dekVersion))]));
    expect(values).toEqual({ DATABASE_URL: 'postgres://u:supersecreto@h/db', STRIPE_KEY: 'sk_live_ñandú "con" comillas\ny salto', VACIA: '' });
    expect(pull.json.grants.map((g: any) => g.keyName).sort()).toEqual(['laptop-ana', 'pc-fer']);

    // La caja de Ana no la abre Beto, y un secreto movido de nombre no descifra.
    expect(() => unwrapDek(pull.json.wrappedDek, betoKey.privateKey, betoKey.publicKey, wrapAad(P, E, 1))).toThrow();
    const db = pull.json.secrets.find((s: any) => s.name === 'DATABASE_URL');
    expect(() => decryptSecret(anaDek, db.ciphertext, secretAad(P, E, 'STRIPE_KEY', 1))).toThrow();
  });

  it('un dev con acceso sube cambios y borra; las versiones avanzan', async () => {
    const r = await http(anaToken, 'PUT', `/vault/envs/${P}/${E}/secrets`, { keyId: keyIds.ana, dekVersion: 1, set: [enc('STRIPE_KEY', 'sk_live_nueva'), enc('NUEVA', '1')], delete: ['VACIA', 'NO_EXISTE'] });
    expect(r.json).toMatchObject({ written: 2, deleted: 1 });
    const rows = await pg.sql<{ name: string; version: number }>(`select name, version from roz.zeus_vault_secret order by name`);
    expect(rows).toEqual([{ name: 'DATABASE_URL', version: 1 }, { name: 'NUEVA', version: 1 }, { name: 'STRIPE_KEY', version: 2 }]);
    expect((await http(anaToken, 'PUT', `/vault/envs/${P}/${E}/secrets`, { keyId: keyIds.ana, dekVersion: 7, set: [enc('X', '1')] })).json.error.code).toBe('ZEUS_VAULT_STALE');
    expect((await http(anaToken, 'PUT', `/vault/envs/${P}/${E}/secrets`, { keyId: keyIds.ana, dekVersion: 1, set: [enc('A', '1'), enc('A', '2')] })).status).toBe(400);
  });

  it('el agente ve nombres y si tiene acceso, nunca valores', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${betoToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zeus_env_status', arguments: { projectKey: P } } }),
    });
    const text = ((await res.json()) as any).result.content[0].text as string;
    const data = JSON.parse(text);
    expect(data.envs[0]).toMatchObject({ name: E, variables: ['DATABASE_URL', 'NUEVA', 'STRIPE_KEY'], youHaveAccess: false, pull: 'zeus env pull ORWEL development' });
    expect(text).not.toContain('zs1.');
  });

  it('quitar un acceso marca el entorno para rotar; el último acceso no se puede quitar', async () => {
    expect((await http(anaToken, 'DELETE', `/vault/envs/${P}/${E}/grants/${keyIds.admin}`)).status).toBe(403);
    expect((await http(adminToken, 'DELETE', `/vault/envs/${P}/${E}/grants/${keyIds.beto}`)).status).toBe(404);
    expect((await http(adminToken, 'DELETE', `/vault/envs/${P}/${E}/grants/${keyIds.ana}`)).json).toEqual({ ok: true });
    expect((await http(anaToken, 'GET', `/vault/envs/${P}/${E}?keyId=${keyIds.ana}`)).json.error.code).toBe('ZEUS_VAULT_NO_ACCESS');
    expect((await pg.sql(`select needs_rotation from roz.zeus_vault_env`))[0]).toEqual({ needs_rotation: true });
    expect((await http(adminToken, 'DELETE', `/vault/envs/${P}/${E}/grants/${keyIds.admin}`)).json.error.code).toBe('ZEUS_VAULT_LAST_GRANT');
  });

  it('rotar: llave nueva para quien sigue, todo re-cifrado, y la llave vieja deja de servir', async () => {
    const before = await http(adminToken, 'GET', `/vault/envs/${P}/${E}?keyId=${keyIds.admin}`);
    const oldDek = unwrapDek(before.json.wrappedDek, adminKey.privateKey, adminKey.publicKey, wrapAad(P, E, 1));
    const plain = before.json.secrets.map((s: any) => ({ name: s.name, value: decryptSecret(oldDek, s.ciphertext, secretAad(P, E, s.name, s.dekVersion)) }));
    const newDek = generateDek();
    const body = {
      keyId: keyIds.admin,
      dekVersion: 2,
      grants: [
        { keyId: keyIds.admin, wrappedDek: wrapDek(newDek, adminKey.publicKey, wrapAad(P, E, 2)) },
        { keyId: keyIds.beto, wrappedDek: wrapDek(newDek, betoKey.publicKey, wrapAad(P, E, 2)) },
      ],
      secrets: plain.map((s: any) => enc(s.name, s.value, newDek, 2)),
    };
    expect((await http(anaToken, 'POST', `/vault/envs/${P}/${E}/rotate`, body)).status).toBe(403);
    expect((await http(adminToken, 'POST', `/vault/envs/${P}/${E}/rotate`, { ...body, dekVersion: 5 })).json.error.code).toBe('ZEUS_VAULT_STALE');
    expect((await http(adminToken, 'POST', `/vault/envs/${P}/${E}/rotate`, { ...body, secrets: body.secrets.slice(1) })).json.error.code).toBe('ZEUS_VAULT_INCOMPLETE');
    // Una rotación que te deja fuera se rechaza.
    expect((await http(adminToken, 'POST', `/vault/envs/${P}/${E}/rotate`, { ...body, grants: body.grants.slice(1) })).status).toBe(400);
    // Nada cambió con los intentos fallidos.
    expect((await pg.sql(`select dek_version from roz.zeus_vault_env`))[0]).toEqual({ dek_version: 1 });

    expect((await http(adminToken, 'POST', `/vault/envs/${P}/${E}/rotate`, body)).json).toEqual({ ok: true, dekVersion: 2 });
    dek = newDek;
    expect((await pg.sql(`select dek_version, needs_rotation from roz.zeus_vault_env`))[0]).toEqual({ dek_version: 2, needs_rotation: false });

    // Beto entra con la llave nueva y lee todo.
    const pull = await http(betoToken, 'GET', `/vault/envs/${P}/${E}?keyId=${keyIds.beto}`);
    const betoDek = unwrapDek(pull.json.wrappedDek, betoKey.privateKey, betoKey.publicKey, wrapAad(P, E, 2));
    expect(pull.json.secrets.map((s: any) => [s.name, decryptSecret(betoDek, s.ciphertext, secretAad(P, E, s.name, 2))])).toEqual([
      ['DATABASE_URL', 'postgres://u:supersecreto@h/db'],
      ['NUEVA', '1'],
      ['STRIPE_KEY', 'sk_live_nueva'],
    ]);
    // La DEK vieja (la que Ana alcanzó a ver) ya no abre nada, y Ana sigue fuera.
    expect(() => decryptSecret(oldDek, pull.json.secrets[0].ciphertext, secretAad(P, E, 'DATABASE_URL', 2))).toThrow();
    expect((await http(anaToken, 'GET', `/vault/envs/${P}/${E}?keyId=${keyIds.ana}`)).json.error.code).toBe('ZEUS_VAULT_NO_ACCESS');
    // Subir con la versión anterior se rechaza.
    expect((await http(adminToken, 'PUT', `/vault/envs/${P}/${E}/secrets`, { keyId: keyIds.admin, dekVersion: 1, set: [enc('X', '1')] })).json.error.code).toBe('ZEUS_VAULT_STALE');
  });

  it('revocar la llave de un equipo le quita todo y deja constancia', async () => {
    const { revokeKey, vaultOverview } = await import('../src/zeus/vault.js');
    await expect(revokeKey(keyIds.beto, await actor(ids.ana))).rejects.toMatchObject({ code: 'ZEUS_ADMIN_ONLY' });
    await revokeKey(keyIds.beto, await actor(ids.beto));
    expect((await http(betoToken, 'GET', `/vault/envs/${P}/${E}?keyId=${keyIds.beto}`)).json.error.code).toBe('ZEUS_VAULT_NO_ACCESS');
    const o = await vaultOverview();
    expect(o.envs[0]).toMatchObject({ projectKey: P, name: E, dekVersion: 2, needsRotation: true });
    expect(o.envs[0]!.secrets.map((s) => s.name)).toEqual(['DATABASE_URL', 'NUEVA', 'STRIPE_KEY']);
    expect(o.envs[0]!.secrets.every((s) => !s.stale)).toBe(true);
    expect(o.envs[0]!.grants.map((g) => g.keyName)).toEqual(['pc-fer']);
    expect(o.keys.find((k) => k.id === keyIds.beto)!.revokedAt).toBeTruthy();
    const actions = o.audit.map((a) => a.action);
    for (const a of ['key.add', 'env.create', 'push', 'pull', 'grant', 'revoke', 'rotate', 'key.revoke']) expect(actions, a).toContain(a);
    // La auditoría registra nombres de variables, nunca valores ni sobres.
    expect(JSON.stringify(o)).not.toContain('zs1.');
    expect(JSON.stringify(o)).not.toContain('sk_live');
  });
});
