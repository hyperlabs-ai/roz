// Estado del MCP (página "MCP" del dashboard) contra Postgres en memoria: conexiones por persona,
// actividad MCP/CLI por hora, último trabajo, pendientes del equipo y salud de la ingesta.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createZeusPg, type ZeusPg } from './zeus-pg.js';

const holder = vi.hoisted(() => {
  process.env.ROZ_LOG_LEVEL = 'silent';
  return { pg: null as unknown as { client: unknown } };
});
vi.mock('../src/db/supabase.js', () => ({ db: () => holder.pg.client, dbPublic: () => holder.pg.client }));

import { mcpStatus } from '../src/zeus/mcp-status.js';
import { zeusTools } from '../src/zeus/mcp.js';

let pg: ZeusPg;
const now = new Date('2026-11-18T12:30:00Z');
const at = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();

beforeAll(async () => {
  pg = await createZeusPg();
  holder.pg = pg;
  const [fer] = await pg.sql<{ id: string }>(`insert into roz.dev (name, email, role, github_login) values ('Fer', 'fer@h.test', 'ceo', 'nitrofd') returning id`);
  const [alan] = await pg.sql<{ id: string }>(`insert into roz.dev (name, email, role) values ('Alan', 'alan@h.test', 'dev') returning id`);
  await pg.sql(`insert into roz.dev (name, email, role) values ('Nadie', 'nadie@h.test', 'dev')`);
  await pg.sql(`insert into roz.zeus_token (dev_id, name, token_hash, token_prefix, last_used_at) values ($1, 'laptop', 'h1', 'zeus_abc', $2), ($1, 'pc', 'h2', 'zeus_def', null)`, [fer!.id, at(0.2)]);
  await pg.sql(
    `insert into roz.zeus_activity (at, dev_id, actor, action, detail) values
      ($1, $3, 'mcp', 'search', '{"q":"pagos"}'), ($2, $3, 'cli', 'env.pull', '{"env":"api-production"}'),
      ($4, $5, 'mcp', 'index', '{}'), ($6, $3, 'web', 'write', '{}'), ($7, $5, 'mcp', 'get', '{}')`,
    [at(0.5), at(1.2), fer!.id, at(3), alan!.id, at(0.1), at(50)],
  );
  await pg.sql(
    `insert into roz.zeus_message (kind, status, from_dev_id, to_dev_id, subject, body) values
      ('task', 'pending', $1, $2, 'Webhook de pagos', 'x'), ('plan', 'accepted', $2, $1, 'Migrar pagos', 'y'), ('task', 'done', $1, $2, 'Ya hecho', 'z')`,
    [fer!.id, alan!.id],
  );
  await pg.sql(`insert into roz.runner (dev_id, name, platform, last_seen_at) values ($1, 'Mark-1', 'win32', $2)`, [fer!.id, at(0.01)]);
});
afterAll(async () => pg.close());

describe('estado del MCP', () => {
  it('servidor, conexiones, actividad, último trabajo, pendientes y runners salen de la base', async () => {
    const s = await mcpStatus(now);
    expect(s.server).toMatchObject({ name: 'zeus', tools: zeusTools.length, prompts: ['pendientes', 'compartir-plan', 'variables'] });

    // Solo quien tiene token o actividad por MCP/CLI; la actividad web no cuenta como MCP.
    expect(s.connections.map((c) => c.name)).toEqual(['Fer', 'Alan']);
    const fer = s.connections[0]!;
    expect(fer).toMatchObject({ tokens: 2, lastTokenUseAt: at(0.2), lastMcpAt: at(0.5), lastCliAt: at(1.2), events24h: 2, events7d: 2, runnerOnline: true, githubLogin: 'nitrofd' });
    expect(s.connections[1]).toMatchObject({ events24h: 1, events7d: 2, lastMcpAt: at(3) });

    expect(s.activity).toMatchObject({ events24h: 3, events7d: 4, mcp24h: 2, cli24h: 1, activeDevs24h: 2, activeDevs7d: 2 });
    expect(s.activity.hourly).toHaveLength(24);
    expect(s.activity.hourly.reduce((a, b) => a + b, 0)).toBe(3);
    expect(s.activity.hourly[23]).toBe(1);
    expect(s.recent.map((e) => e.action)).toEqual(['search', 'env.pull', 'index', 'get']);
    expect(s.recent[0]).toMatchObject({ devName: 'Fer', actor: 'mcp', detail: { q: 'pagos' } });

    expect(s.pending).toMatchObject({ tasks: 1, plans: 1, requests: 0 });
    expect(s.pending.items.map((i) => [i.kind, i.title, i.from, i.to])).toEqual(
      expect.arrayContaining([['task', 'Webhook de pagos', 'Fer', 'Alan'], ['plan', 'Migrar pagos', 'Alan', 'Fer']]),
    );
    expect(s.runners).toMatchObject([{ devName: 'Fer', name: 'Mark-1', online: true }]);
    // Sin repos vinculados la ingesta sale vacía, sin romper el resto.
    expect(s.sources).toMatchObject({ total: 0, attention: [] });
  });
});
