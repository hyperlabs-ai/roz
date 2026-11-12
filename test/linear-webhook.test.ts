import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Webhook de Linear y reconciliación. La ruta: con el flag apagado responde 200 sin emitir (Linear no
// reintenta en bucle); sin firma válida o con timestamp viejo, 401 y nada encolado; si pasa, UN evento
// con llave por entrega. El handler: un Issue se relee completo antes de ir al espejo; un borrado lo
// retira. La reconciliación: ventana con traslape y un tick por media hora.

const SECRET = 'whsec_test';

const h = vi.hoisted(() => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  process.env.LINEAR_WEBHOOK_SECRET = 'whsec_test';
  process.env.LINEAR_TEAM_ID = '';
  return {
    sot: true,
    emitted: [] as { type: string; payload: Record<string, unknown>; key: string | null }[],
    upserts: [] as { id: string; source: string }[],
    retired: [] as string[],
    synced: 0,
    issue: null as null | Record<string, unknown>,
    since: [] as string[],
    issues: [] as Record<string, unknown>[],
  };
});

vi.mock('../src/db/supabase.js', () => ({ db: () => ({}), dbPublic: () => ({}) }));
vi.mock('../src/linear/enabled.js', () => ({ linearSourceOfTruth: () => h.sot, assertTasksWritable: () => {}, TASKS_READ_ONLY_CODE: 'TASKS_READ_ONLY' }));
vi.mock('../src/events/outbox.js', () => ({
  emit: async (type: string, payload: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
    h.emitted.push({ type, payload, key: opts?.idempotencyKey ?? null });
    return 'ev';
  },
}));
vi.mock('../src/linear/mirror.js', () => ({
  upsertMirrorFromLinear: async (issue: { id: string; updatedAt: string }, opts: { source: string }) => {
    h.upserts.push({ id: issue.id, source: opts.source });
    return { stale: issue.updatedAt === 'viejo' };
  },
  retireMirror: async (id: string) => {
    h.retired.push(id);
    return { workItemId: null };
  },
}));
vi.mock('../src/linear/links.js', () => ({
  syncLinearLinks: async () => {
    h.synced++;
    return { teams: 0, users: 0, labels: 0, states: 0, projects: 0 };
  },
}));
vi.mock('../src/adapters/linear.js', async (orig) => ({
  ...(await orig<typeof import('../src/adapters/linear.js')>()),
  getIssue: async () => h.issue,
  issuesUpdatedSince: async (since: string) => {
    h.since.push(since);
    return { issues: h.issues, truncated: false };
  },
}));

import { linearWebhookRoutes } from '../src/routes/linear.js';
import { handleLinearWebhook, toWebhookPayload } from '../src/linear/webhook.js';
import { reconcileLinear, reconcileSince, reconcileTickKey, scheduleLinearReconcile, RECONCILE_OVERLAP_MS } from '../src/linear/reconcile.js';

const app = new Hono().route('/webhooks', linearWebhookRoutes);

function post(body: unknown, opts: { secret?: string; delivery?: string } = {}) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(raw).digest('hex');
  return app.request('/webhooks/linear', {
    method: 'POST',
    body: raw,
    headers: { 'content-type': 'application/json', 'linear-signature': sig, ...(opts.delivery ? { 'linear-delivery': opts.delivery } : {}) },
  });
}

const issueBody = (over: Record<string, unknown> = {}) => ({
  action: 'update',
  type: 'Issue',
  data: { id: 'iss-1', identifier: 'HYP-1' },
  updatedFrom: { assigneeId: 'u-old' },
  webhookTimestamp: Date.now(),
  ...over,
});

beforeEach(() => {
  h.sot = true;
  h.emitted = [];
  h.upserts = [];
  h.retired = [];
  h.synced = 0;
  h.issue = null;
  h.since = [];
  h.issues = [];
});

describe('POST /webhooks/linear', () => {
  it('flag apagado: 200 skipped, sin emitir (ni verificar)', async () => {
    h.sot = false;
    const res = await post(issueBody(), { secret: 'otra' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'flag' });
    expect(h.emitted).toEqual([]);
  });

  it('firma inválida → 401 y nada encolado', async () => {
    const res = await post(issueBody(), { secret: 'otra' });
    expect(res.status).toBe(401);
    expect(h.emitted).toEqual([]);
  });

  it('timestamp viejo (repetición) → 401', async () => {
    const res = await post(issueBody({ webhookTimestamp: Date.now() - 5 * 60_000 }));
    expect(res.status).toBe(401);
    expect(h.emitted).toEqual([]);
  });

  it('válido → UN linear.webhook con llave por entrega', async () => {
    const res = await post(issueBody(), { delivery: 'dlv-1' });
    expect(res.status).toBe(200);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({ type: 'linear.webhook', key: 'linear:dlv-1' });
    expect(h.emitted[0]!.payload).toMatchObject({ deliveryId: 'dlv-1', type: 'Issue', action: 'update', data: { id: 'iss-1' }, updatedFrom: { assigneeId: 'u-old' } });
  });

  it('sin header de entrega: la llave es el hash del cuerpo (mismo cuerpo, misma llave)', () => {
    const raw = '{"a":1}';
    const a = toWebhookPayload(issueBody(), null, raw);
    const b = toWebhookPayload(issueBody(), undefined, raw);
    expect(a!.deliveryId).toMatch(/^[0-9a-f]{64}$/);
    expect(a!.deliveryId).toBe(b!.deliveryId);
    expect(toWebhookPayload({ action: 'otra', type: 'Issue', data: {} }, 'x', raw)).toBeNull();
  });
});

describe('handleLinearWebhook', () => {
  const payload = (over: Record<string, unknown> = {}) => ({ ...toWebhookPayload(issueBody(over), 'd', '{}')! });

  it('Issue: relee el issue completo y lo pasa al espejo como webhook', async () => {
    h.issue = { id: 'iss-1', updatedAt: '2026-11-11T00:00:00.000Z' };
    await handleLinearWebhook(payload());
    expect(h.upserts).toEqual([{ id: 'iss-1', source: 'webhook' }]);
  });

  it('Issue borrado (remove) o ya inexistente → retirar del espejo', async () => {
    await handleLinearWebhook(payload({ action: 'remove' }));
    await handleLinearWebhook(payload()); // getIssue → null
    expect(h.retired).toEqual(['iss-1', 'iss-1']);
    expect(h.upserts).toEqual([]);
  });

  it('etiquetas/usuarios refrescan los vínculos; comentarios se ignoran', async () => {
    await handleLinearWebhook(payload({ type: 'IssueLabel' }));
    await handleLinearWebhook(payload({ type: 'Comment' }));
    expect(h.synced).toBe(1);
    expect(h.upserts).toEqual([]);
  });

  it('flag apagado: no hace nada', async () => {
    h.sot = false;
    h.issue = { id: 'iss-1', updatedAt: 'x' };
    await handleLinearWebhook(payload());
    expect(h.upserts).toEqual([]);
  });
});

describe('reconciliación', () => {
  it('ventana: último sync menos el traslape; sin espejo, una semana', () => {
    const now = Date.parse('2026-11-11T12:00:00.000Z');
    expect(reconcileSince('2026-11-11T11:50:00.000Z', now)).toBe(new Date(Date.parse('2026-11-11T11:50:00.000Z') - RECONCILE_OVERLAP_MS).toISOString());
    expect(reconcileSince(null, now)).toBe('2026-11-04T12:00:00.000Z');
  });

  it('un tick por media hora', () => {
    expect(reconcileTickKey(new Date('2026-11-11T12:07:31.000Z'))).toBe('linear-reconcile:2026-11-11T12:00:00.000Z');
    expect(reconcileTickKey(new Date('2026-11-11T12:59:59.000Z'))).toBe('linear-reconcile:2026-11-11T12:30:00.000Z');
  });

  it('el cron se salta con el flag apagado y si no, encola el tick', async () => {
    h.sot = false;
    expect(await scheduleLinearReconcile()).toEqual({ ok: true, skipped: 'flag' });
    expect(h.emitted).toEqual([]);
    h.sot = true;
    await scheduleLinearReconcile(new Date('2026-11-11T12:07:00.000Z'));
    expect(h.emitted[0]).toMatchObject({ type: 'linear.reconcile', key: 'linear-reconcile:2026-11-11T12:00:00.000Z', payload: { since: null, reason: 'cron', refreshLinks: true } });
  });

  it('pasa cada issue por el espejo y cuenta solo lo que escribió', async () => {
    h.issues = [
      { id: 'a', updatedAt: '2026-11-11T00:00:00.000Z' },
      { id: 'b', updatedAt: 'viejo' },
    ];
    const r = await reconcileLinear({ since: '2026-11-10T00:00:00.000Z', reason: 'manual', refreshLinks: true });
    expect(h.synced).toBe(1);
    expect(h.since).toEqual(['2026-11-10T00:00:00.000Z']);
    expect(h.upserts.map((u) => u.source)).toEqual(['reconcile', 'reconcile']);
    expect(r).toEqual({ upserted: 1, truncated: false });
  });
});
