import { beforeEach, describe, expect, it, vi } from 'vitest';

// Atomicidad de las transiciones del plan contra un doble de Supabase: lo que importa es QUÉ
// condiciones lleva el update (estado + versión leída + dueño al reclamar), que el perdedor de una
// carrera reciba PLAN_TAKEN con quién lo tiene, y que reclamar deje override y reasignación en Linear.

type Filter = [string, ...unknown[]];
interface Query {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'rpc';
  payload: unknown;
  filters: Filter[];
}

const queries: Query[] = [];
let respond: (q: Query) => { data: unknown; error: unknown } = () => ({ data: null, error: null });

function makeQuery(table: string): unknown {
  const q: Query = { table, op: 'select', payload: null, filters: [] };
  let opSet = false;
  const self: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          queries.push(q);
          const res = respond(q);
          return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(res).then(ok, ko);
        }
        return (...args: unknown[]) => {
          if ((prop === 'insert' || prop === 'update' || prop === 'delete') && !opSet) {
            q.op = prop;
            q.payload = args[0];
            opSet = true;
          } else if (prop === 'select' && !opSet) {
            opSet = true;
          } else {
            q.filters.push([prop, ...args]);
          }
          return self;
        };
      },
    },
  );
  return self;
}

vi.mock('../src/db/supabase.js', () => ({
  db: () => ({ from: (t: string) => makeQuery(t), rpc: () => makeQuery('rpc') }),
  dbPublic: () => ({}),
}));
vi.mock('../src/config.js', () => ({ config: { dashboard: { url: 'https://roz.test' }, linear: { sourceOfTruth: true } } }));
vi.mock('../src/linear/enabled.js', () => ({ linearSourceOfTruth: () => true }));
vi.mock('../src/dashboard/queries.js', () => ({ avatarFor: (l: string | null) => (l ? `https://github.com/${l}.png` : null) }));
const emitMock = vi.fn(async () => 'ev-1');
vi.mock('../src/events/outbox.js', () => ({ emit: (...a: unknown[]) => (emitMock as any)(...a) }));
const latestDecisionMock = vi.fn();
const updateDecisionMock = vi.fn(async () => undefined);
vi.mock('../src/assign/decisions.js', () => ({
  latestDecision: (...a: unknown[]) => latestDecisionMock(...a),
  updateDecision: (...a: unknown[]) => (updateDecisionMock as any)(...a),
}));
vi.mock('../src/notify/push.js', () => ({ pushBroadcast: vi.fn(), pushToDev: vi.fn() }));
const linearUserForDevMock = vi.fn(async (_devId: string): Promise<string | null> => 'lin-user-1');
vi.mock('../src/linear/links.js', () => ({ linearUserForDev: (id: string) => linearUserForDevMock(id) }));

const { transitionPlan } = await import('../src/plans/store.js');
const { claimPlan, enqueuePlan } = await import('../src/plans/service.js');

const PLAN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ME = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const THIRD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function planRow(over: Record<string, unknown> = {}) {
  return {
    id: PLAN_ID,
    work_item_id: WI,
    linear_issue_id: 'lin-1',
    identifier: 'HYP-1',
    owner_dev_id: OWNER,
    status: 'en_cola',
    phase: 'planear',
    risk: 1,
    risk_reasons: [],
    repo: 'org/app',
    base_branch: null,
    branch: 'hyp-1-x',
    plan_md: null,
    plan_version: 0,
    feedback: null,
    pr_number: null,
    pr_url: null,
    runner_id: null,
    lease_id: null,
    heartbeat_at: null,
    progress: null,
    attempts: 0,
    error: null,
    claimable: true,
    claimable_reason: 'mucho_en_cola',
    claimable_at: '2026-11-10T00:00:00Z',
    approved_by: null,
    approved_at: null,
    pulled_by_dev_id: null,
    pulled_at: null,
    enqueued_at: '2026-11-09T00:00:00Z',
    started_at: null,
    finished_at: null,
    created_at: '2026-11-09T00:00:00Z',
    updated_at: '2026-11-10T00:00:00.123456+00:00',
    ...over,
  };
}

const eqs = (q: Query) => Object.fromEntries(q.filters.filter((f) => f[0] === 'eq').map((f) => [f[1], f[2]]));

beforeEach(() => {
  queries.length = 0;
  emitMock.mockClear();
  latestDecisionMock.mockReset();
  updateDecisionMock.mockClear();
});

describe('transitionPlan', () => {
  it('condiciona el update al estado y la versión leídos, y suelta el runner si toca', async () => {
    const row = planRow({ status: 'planeando', runner_id: 'r1', lease_id: 'l1', heartbeat_at: '2026-11-10T00:00:00Z' });
    respond = (q) => (q.table === 'agent_plan' && q.op === 'update' ? { data: [{ ...row, status: 'en_cola' }], error: null } : { data: null, error: null });
    const out = await transitionPlan(row as any, 'liberar', { event: 'released', guard: 'lease', runnerId: 'r1' });
    expect(out.status).toBe('en_cola');
    const upd = queries.find((q) => q.op === 'update')!;
    expect(eqs(upd)).toMatchObject({ id: PLAN_ID, status: 'planeando', lease_id: 'l1' });
    expect(upd.payload).toMatchObject({ status: 'en_cola', runner_id: null, lease_id: null, heartbeat_at: null });
    const ev = queries.find((q) => q.table === 'agent_plan_event' && q.op === 'insert')!;
    expect(ev.payload).toMatchObject({ plan_id: PLAN_ID, kind: 'released', from_status: 'planeando', to_status: 'en_cola', runner_id: 'r1' });
  });

  it('transición imposible → PLAN_CONFLICT sin tocar la base', async () => {
    await expect(transitionPlan(planRow({ status: 'hecho' }) as any, 'aprobar', { event: 'approved', guard: 'updated_at' })).rejects.toMatchObject({
      code: 'PLAN_CONFLICT',
      status: 409,
      details: { status: 'hecho', phase: 'planear' },
    });
    expect(queries.filter((q) => q.op === 'update')).toHaveLength(0);
  });

  it('terminar sella finished_at', async () => {
    const row = planRow();
    respond = (q) => (q.op === 'update' ? { data: [{ ...row, status: 'cancelado' }], error: null } : { data: null, error: null });
    await transitionPlan(row as any, 'cancelar', { event: 'canceled', guard: 'updated_at' });
    const upd = queries.find((q) => q.op === 'update')!;
    expect((upd.payload as Record<string, unknown>).finished_at).toEqual(expect.any(String));
  });
});

describe('claimPlan', () => {
  it('gana: update condicionado al dueño leído, override "reclamado" y reasignación en Linear', async () => {
    const row = planRow();
    latestDecisionMock.mockResolvedValue({ id: 'dec-1', outcome: 'assigned', overridden_at: null });
    respond = (q) => {
      if (q.table === 'agent_plan' && q.op === 'select') return { data: row, error: null };
      if (q.table === 'agent_plan' && q.op === 'update') return { data: [{ ...row, owner_dev_id: ME, claimable: false }], error: null };
      return { data: [], error: null };
    };
    const out = await claimPlan(PLAN_ID, { userId: 'user-me', devId: ME }, '  lo tengo  ');
    expect(out.owner.id).toBe(ME);

    const upd = queries.find((q) => q.table === 'agent_plan' && q.op === 'update')!;
    expect(eqs(upd)).toMatchObject({ id: PLAN_ID, status: 'en_cola', updated_at: row.updated_at, owner_dev_id: OWNER });
    expect(upd.payload).toMatchObject({ owner_dev_id: ME, claimable: false, claimable_reason: null });

    expect(updateDecisionMock).toHaveBeenCalledWith('dec-1', expect.objectContaining({
      override_category: 'reclamado',
      override_dev_id: ME,
      overridden_by: 'user-me',
      override_note: 'lo tengo',
    }));
    expect(emitMock).toHaveBeenCalledWith(
      'plan.reassign_linear',
      { planId: PLAN_ID, workItemId: WI, fromDevId: OWNER, toDevId: ME, reason: 'reclamado' },
      { idempotencyKey: `plan-reassign:${PLAN_ID}:${ME}:${row.updated_at}` },
    );
    const ev = queries.find((q) => q.table === 'agent_plan_event')!;
    expect(ev.payload).toMatchObject({ kind: 'claimed', actor_dev_id: ME });
  });

  it('sin decisión previa inserta una fila manual con el override', async () => {
    const row = planRow();
    latestDecisionMock.mockResolvedValue(null);
    respond = (q) => {
      if (q.table === 'agent_plan' && q.op === 'select') return { data: row, error: null };
      if (q.table === 'agent_plan' && q.op === 'update') return { data: [{ ...row, owner_dev_id: ME }], error: null };
      return { data: [], error: null };
    };
    await claimPlan(PLAN_ID, { userId: 'user-me', devId: ME }, null);
    const ins = queries.find((q) => q.table === 'assignment_decision' && q.op === 'insert')!;
    expect(ins.payload).toMatchObject({
      work_item_id: WI,
      origin: 'manual',
      outcome: 'assigned',
      chosen_dev_id: OWNER,
      override_dev_id: ME,
      override_category: 'reclamado',
    });
  });

  it('pierde la carrera: 409 PLAN_TAKEN con quién lo tiene, sin override ni Linear', async () => {
    const row = planRow();
    let reads = 0;
    respond = (q) => {
      if (q.table === 'agent_plan' && q.op === 'select') {
        reads++;
        // 1ª lectura: lo que vio este dev; 2ª: lo que quedó tras ganar otro.
        return { data: reads === 1 ? row : { ...row, owner_dev_id: THIRD, updated_at: '2026-11-10T00:00:01Z' }, error: null };
      }
      if (q.table === 'agent_plan' && q.op === 'update') return { data: [], error: null };
      if (q.table === 'dev') return { data: [{ id: THIRD, name: 'Lucía', github_login: 'lucia', email: null }], error: null };
      return { data: [], error: null };
    };
    await expect(claimPlan(PLAN_ID, { userId: 'user-me', devId: ME }, null)).rejects.toMatchObject({
      code: 'PLAN_TAKEN',
      status: 409,
      details: { owner: { id: THIRD, name: 'Lucía' } },
    });
    expect(updateDecisionMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('quien no tiene usuario en Linear no puede reclamar (Linear quedaría con el dueño anterior)', async () => {
    linearUserForDevMock.mockResolvedValueOnce(null);
    respond = (q) => (q.table === 'agent_plan' ? { data: planRow(), error: null } : { data: [], error: null });
    await expect(claimPlan(PLAN_ID, { userId: 'user-me', devId: ME }, null)).rejects.toMatchObject({ code: 'LINEAR_USER_MISSING', status: 422 });
    expect(queries.filter((q) => q.op === 'update')).toHaveLength(0);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('el dueño no puede reclamar lo suyo', async () => {
    respond = (q) => (q.table === 'agent_plan' ? { data: planRow(), error: null } : { data: [], error: null });
    await expect(claimPlan(PLAN_ID, { userId: 'u', devId: OWNER }, null)).rejects.toMatchObject({ code: 'PLAN_FORBIDDEN', status: 403 });
  });
});

describe('enqueuePlan', () => {
  const item = {
    id: WI,
    identifier: 'HYP-1',
    name: 'Agregar migración de pedidos',
    description: null,
    labels: [],
    status: 'pendiente',
    url: null,
    project_id: 'proj-1',
    linear_id: 'lin-1',
    linear_branch_name: null,
    assignee_dev_id: OWNER,
  };

  it('sin plan vivo inserta con riesgo por reglas, repo del proyecto y evento enqueued', async () => {
    respond = (q) => {
      if (q.table === 'work_item') return { data: item, error: null };
      if (q.table === 'dev') return { data: { id: OWNER, name: 'Ana', github_login: null, email: null, active: true }, error: null };
      if (q.table === 'agent_plan' && q.op === 'select') return { data: [], error: null };
      if (q.table === 'project') return { data: { client_sla: false, agent_risk_paths: [] }, error: null };
      if (q.table === 'project_repo') return { data: [{ repo: 'org/app' }], error: null };
      if (q.table === 'agent_plan' && q.op === 'insert') return { data: { id: PLAN_ID }, error: null };
      return { data: null, error: null };
    };
    const out = await enqueuePlan({ workItemId: WI, linearIssueId: 'lin-1', ownerDevId: OWNER, reason: 'asignado' });
    expect(out).toEqual({ action: 'creado', planId: PLAN_ID });
    const ins = queries.find((q) => q.table === 'agent_plan' && q.op === 'insert')!;
    expect(ins.payload).toMatchObject({ risk: 2, repo: 'org/app', identifier: 'HYP-1', status: 'en_cola', phase: 'planear', branch: 'hyp-1-agregar-migracion-de-pedidos' });
  });

  it('mismo dueño con plan vivo → sin cambios; 23505 en el insert → sin cambios', async () => {
    respond = (q) => {
      if (q.table === 'work_item') return { data: item, error: null };
      if (q.table === 'dev') return { data: { id: OWNER, name: 'Ana', github_login: null, email: null, active: true }, error: null };
      if (q.table === 'agent_plan' && q.op === 'select') return { data: [planRow()], error: null };
      return { data: null, error: null };
    };
    expect((await enqueuePlan({ workItemId: WI, linearIssueId: null, ownerDevId: OWNER, reason: 'asignado' })).action).toBe('sin_cambios');

    respond = (q) => {
      if (q.table === 'work_item') return { data: { ...item, project_id: null }, error: null };
      if (q.table === 'dev') return { data: { id: OWNER, name: 'Ana', github_login: null, email: null, active: true }, error: null };
      if (q.table === 'agent_plan' && q.op === 'select') return { data: [], error: null };
      if (q.table === 'agent_plan' && q.op === 'insert') return { data: null, error: { code: '23505' } };
      return { data: null, error: null };
    };
    expect((await enqueuePlan({ workItemId: WI, linearIssueId: null, ownerDevId: OWNER, reason: 'asignado' })).action).toBe('sin_cambios');
  });

  it('issue cerrado → omitido', async () => {
    respond = (q) => (q.table === 'work_item' ? { data: { ...item, status: 'completada' }, error: null } : { data: null, error: null });
    expect(await enqueuePlan({ workItemId: WI, linearIssueId: null, ownerDevId: OWNER, reason: 'asignado' })).toMatchObject({
      action: 'omitido',
      reason: 'issue_cerrado',
    });
  });
});
