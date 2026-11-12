import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// El Pulso es la pantalla principal y tiene que pintarse aunque la migración 0036 no esté aplicada
// (agent_plan, meeting y las columnas linear_* faltan): cada consulta a lo nuevo es tolerante. Se
// prueba contra un doble del cliente de Supabase que responde por tabla y falla en las de v2.

const NOW = new Date();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const TABLES: Record<string, unknown[] | 'missing'> = {
  dev: [
    { id: 'd1', name: 'Ana', github_login: 'ana', active: true },
    { id: 'd2', name: 'Beto', github_login: null, active: true },
    { id: 'd3', name: 'Inactiva', github_login: 'x', active: false },
  ],
  project: [{ id: 'p1', name: 'Acme', kind: 'client', color: null, client_email_domains: ['acme.com'] }],
  commit: [
    { sha: 'a1', repo: 'org/acme', project_id: 'p1', dev_id: 'd1', author_login: 'ana', message: 'fix: algo', url: null, additions: 10, deletions: 2, committed_at: minutesAgo(5) },
    // Mismo sha en otro repo: cuenta una vez.
    { sha: 'a1', repo: 'org/acme-fork', project_id: 'p1', dev_id: 'd1', author_login: 'ana', message: 'fix: algo', url: null, additions: 10, deletions: 2, committed_at: minutesAgo(5) },
  ],
  work_item: [
    { id: 'w1', identifier: 'ACME-1', name: 'Login', status: 'en_progreso', project_id: 'p1', assignee_dev_id: 'd1', url: null, source: 'native', pr_number: null, pr_state: null, created_at: minutesAgo(30), completed_at: null, started_at: null, updated_at: minutesAgo(10), linear_created_at: null, linear_updated_at: null },
    { id: 'w2', identifier: 'ACME-2', name: 'Pago', status: 'completada', project_id: 'p1', assignee_dev_id: 'd2', url: null, source: 'native', pr_number: null, pr_state: null, created_at: minutesAgo(40), completed_at: minutesAgo(20), started_at: null, updated_at: minutesAgo(20), linear_created_at: null, linear_updated_at: null },
  ],
  work_item_actor: [],
  dev_assignment: [{ dev_id: 'd2', project_id: 'p1' }],
  agent_plan: 'missing',
  agent_plan_event: 'missing',
  meeting: 'missing',
  dev_calendar_account: [],
  calendar_block: [],
};

function query(table: string) {
  const rows = TABLES[table];
  const result = rows === 'missing'
    ? { data: null, error: { message: `relation "roz.${table}" does not exist`, code: '42P01' } }
    : { data: rows ?? [], error: null };
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  for (const m of ['select', 'eq', 'neq', 'gte', 'lt', 'gt', 'in', 'not', 'or', 'is', 'order', 'limit']) chain[m] = passthrough;
  chain.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, ko);
  return chain;
}

vi.mock('../src/db/supabase.js', () => ({
  db: () => ({ from: (t: string) => query(t) }),
  dbPublic: () => ({ from: (t: string) => query(t) }),
}));

const { pulseRoutes, rozV2StatusRoutes } = await import('../src/routes/pulse.js');
const app = new Hono();
app.route('/pulse', pulseRoutes);
app.route('/roz-v2', rozV2StatusRoutes);

describe('GET /pulse', () => {
  it('responde sin la migración 0036 y arma personas, KPIs y feed', async () => {
    const res = await app.request('/pulse');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groupBy).toBe('persona');
    // Solo devs activos.
    expect(body.people.map((p: { devId: string }) => p.devId).sort()).toEqual(['d1', 'd2']);
    const ana = body.people.find((p: { devId: string }) => p.devId === 'd1');
    expect(ana.avatarUrl).toBe('https://github.com/ana.png?size=96');
    expect(ana.state).toBe('activo');
    expect(ana.currentIssue.identifier).toBe('ACME-1');
    expect(ana.agentPlan).toBeNull();
    expect(ana.week.commits).toBe(1);
    expect(body.kpis.commits).toBe(1);
    expect(body.kpis.issuesClosed).toBe(1);
    expect(body.kpis.plans).toEqual({ done: 0, running: 0, waitingApproval: 0, claimable: 0 });
    expect(body.feed.some((f: { id: string }) => f.id === 'commit:a1')).toBe(true);
    expect(body.heatmap.length).toBeGreaterThan(0);
  });

  it('agrupa por cliente con el dominio del proyecto', async () => {
    const body = await (await app.request('/pulse?groupBy=cliente')).json();
    expect(body.groupBy).toBe('cliente');
    expect(body.groups[0].key).toBe('acme.com');
    expect(body.groups[0].devIds.sort()).toEqual(['d1', 'd2']);
  });

  it('groupBy inválido cae a persona', async () => {
    const body = await (await app.request('/pulse?groupBy=otro')).json();
    expect(body.groupBy).toBe('persona');
  });

  it('feed: solo lo posterior a `after`', async () => {
    const res = await app.request(`/pulse/feed?after=${encodeURIComponent(minutesAgo(25))}&limit=10`);
    const body = await res.json();
    const ids = body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain('commit:a1');
    expect(ids).toContain('issue_closed:w2');
    expect(ids).not.toContain('issue_created:w2');
  });
});

describe('GET /roz-v2/status', () => {
  it('expone los tres interruptores como booleanos', async () => {
    const body = await (await app.request('/roz-v2/status')).json();
    expect(typeof body.linearSourceOfTruth).toBe('boolean');
    expect(typeof body.linearConfigured).toBe('boolean');
    expect(typeof body.granolaEnabled).toBe('boolean');
  });
});
