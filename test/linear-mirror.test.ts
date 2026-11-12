import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from './linear-fake-db.js';

// El espejo es la ÚNICA escritura de work_item con Linear como fuente de verdad. Lo que importa:
// es monótono (un issue viejo nunca pisa uno nuevo), no pisa tareas nativas con el mismo
// identificador, y sus efectos salen una vez y con la llave correcta (plan, aviso, corrección,
// cierre del plan). Se prueba contra un doble en memoria de Supabase.

const h = vi.hoisted(() => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  process.env.LINEAR_WEBHOOK_SECRET = 'whsec_test';
  process.env.LINEAR_TEAM_ID = '';
  return {
    fake: null as unknown as FakeDb,
    emitted: [] as { type: string; payload: Record<string, unknown>; key: string | null }[],
    plans: [] as { workItemId: string; t: string }[],
  };
});

vi.mock('../src/db/supabase.js', () => ({ db: () => h.fake, dbPublic: () => h.fake }));
vi.mock('../src/events/outbox.js', () => ({
  emit: async (type: string, payload: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
    h.emitted.push({ type, payload, key: opts?.idempotencyKey ?? null });
    return 'ev';
  },
}));
vi.mock('../src/plans/service.js', () => ({
  applyIssueTransition: async (workItemId: string, t: string) => {
    h.plans.push({ workItemId, t });
    return { planId: null, status: null };
  },
}));
vi.mock('../src/linear/enabled.js', () => ({ linearSourceOfTruth: () => true, assertTasksWritable: () => {}, TASKS_READ_ONLY_CODE: 'TASKS_READ_ONLY' }));

import type { LinearIssue } from '../src/adapters/linear.js';
import {
  buildMirrorRow,
  isNewer,
  LINEAR_REASSIGN_NOTE,
  mirrorStatus,
  renamedIdentifier,
  retireMirror,
  upsertMirrorFromLinear,
} from '../src/linear/mirror.js';

const ANA = 'dev-ana';
const BETO = 'dev-beto';
const PROJECT = 'proj-1';
const silent = () => {};

function issue(over: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'iss-1',
    identifier: 'HYP-12',
    number: 12,
    title: 'Arreglar login',
    description: 'El login truena',
    url: 'https://linear.app/acme/issue/HYP-12',
    priority: 2,
    estimate: 3,
    dueDate: null,
    branchName: 'hyp-12-arreglar-login',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    startedAt: '2026-11-02T09:00:00.000Z',
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    state: { id: 'st-started', name: 'In Progress', type: 'started' },
    assignee: { id: 'u-ana', name: 'Ana', displayName: 'ana', email: 'ana@acme.com' },
    creator: { id: 'u-beto', name: 'Beto', displayName: 'beto', email: 'beto@acme.com' },
    team: { id: 't-hyp', key: 'HYP', name: 'Hyper' },
    project: { id: 'lp-1', name: 'Portal' },
    labels: [{ id: 'l-bug', name: 'Bug' }],
    cycle: null,
    ...over,
  };
}

function seed() {
  h.fake = createFakeDb({ work_item: ['linear_id', 'identifier'] });
  h.fake.table('project').push({ id: PROJECT, linear_team_id: 't-hyp', linear_project_id: 'lp-1' });
  h.fake.table('dev').push(
    { id: ANA, email: 'ana@acme.com', github_email: null },
    { id: BETO, email: 'beto@acme.com', github_email: null },
  );
  h.fake.table('linear_link').push(
    { kind: 'user', linear_id: 'u-ana', roz_id: ANA, key: 'ana@acme.com', active: true },
    { kind: 'user', linear_id: 'u-beto', roz_id: BETO, key: 'beto@acme.com', active: true },
    { kind: 'label', linear_id: 'l-bug', roz_id: 'st-bug', team_id: null, active: true },
  );
}

const ofType = (t: string) => h.emitted.filter((e) => e.type === t);

beforeEach(() => {
  seed();
  h.emitted = [];
  h.plans = [];
});

describe('piezas puras del espejo', () => {
  it('estado: started se parte por nombre; archivado sale del trabajo vivo salvo si estaba completado', () => {
    expect(mirrorStatus({ state: { id: 's', name: 'In Review', type: 'started' }, archivedAt: null })).toBe('revision');
    expect(mirrorStatus({ state: { id: 's', name: 'Todo', type: 'unstarted' }, archivedAt: '2026-11-03T00:00:00Z' })).toBe('cancelada');
    expect(mirrorStatus({ state: { id: 's', name: 'Done', type: 'completed' }, archivedAt: '2026-11-03T00:00:00Z' })).toBe('completada');
  });

  it('isNewer: sin fecha guardada siempre escribe; igual o más viejo no', () => {
    expect(isNewer('2026-11-02T10:00:00.000Z', null)).toBe(true);
    expect(isNewer('2026-11-02T10:00:00.000Z', '2026-11-02T10:00:00.000Z')).toBe(false);
    expect(isNewer('2026-11-02T09:00:00.000Z', '2026-11-02T10:00:00.000Z')).toBe(false);
    expect(isNewer('2026-11-02T11:00:00.000Z', '2026-11-02T10:00:00.000Z')).toBe(true);
  });

  it('renamedIdentifier: el primer sufijo libre', () => {
    expect(renamedIdentifier('HYP-12', [])).toBe('HYP-12-1');
    expect(renamedIdentifier('HYP-12', ['HYP-12-1', 'HYP-12-2'])).toBe('HYP-12-3');
  });

  it('buildMirrorRow: prioridad 1-4 → roz, conserva started_at de roz y marca source linear', () => {
    const existing = {
      id: 'w1',
      identifier: 'HYP-12',
      status: 'pendiente' as const,
      assignee_dev_id: null,
      linear_updated_at: null,
      started_at: '2026-10-01T00:00:00.000Z',
      completed_at: null,
      canceled_at: null,
      project_id: PROJECT,
      solution_type_id: 'st-x',
    };
    const row = buildMirrorRow(issue({ priority: 1 }), { projectId: null, assigneeDevId: ANA, solutionTypeId: null }, existing);
    expect(row.priority).toBe('urgent');
    expect(row.linear_priority).toBe(1);
    expect(row.started_at).toBe('2026-10-01T00:00:00.000Z');
    expect(row.project_id).toBe(PROJECT); // sin proyecto resuelto conserva el que tenía
    expect(row.solution_type_id).toBe('st-x'); // sin etiqueta ligada conserva el tipo
    expect(row.source).toBe('linear');
    expect(row.labels).toEqual(['Bug']);
  });
});

describe('upsertMirrorFromLinear', () => {
  it('crea el espejo, resuelve proyecto/dev/tipo y encola el plan + aviso una vez', async () => {
    const r = await upsertMirrorFromLinear(issue(), { source: 'webhook' }, silent);
    expect(r).toMatchObject({ created: true, status: 'en_progreso', assigneeDevId: ANA, assigneeChanged: true, stale: false });

    const w = h.fake.table('work_item')[0]!;
    expect(w).toMatchObject({ linear_id: 'iss-1', identifier: 'HYP-12', project_id: PROJECT, assignee_dev_id: ANA, solution_type_id: 'st-bug', priority: 'high' });
    expect(h.fake.table('work_item_assignee')).toEqual([expect.objectContaining({ work_item_id: w.id, dev_id: ANA })]);

    const enq = ofType('plan.enqueue');
    expect(enq).toHaveLength(1);
    expect(enq[0]!.payload).toEqual({ workItemId: w.id, linearIssueId: 'iss-1', ownerDevId: ANA, reason: 'asignado' });
    expect(enq[0]!.key).toBe(`plan:${w.id}:${ANA}:2026-11-02T10:00:00.000Z`);
    expect(ofType('work_item.assigned')[0]!.key).toBe(`assigned:${w.id}:${ANA}`);
  });

  it('es monótono: el mismo updatedAt (o uno viejo) no escribe ni emite', async () => {
    await upsertMirrorFromLinear(issue(), { source: 'webhook' }, silent);
    h.emitted = [];
    const same = await upsertMirrorFromLinear(issue({ title: 'otro título' }), { source: 'reconcile' }, silent);
    expect(same.stale).toBe(true);
    const old = await upsertMirrorFromLinear(issue({ title: 'viejo', updatedAt: '2026-11-01T00:00:00.000Z' }), { source: 'reconcile' }, silent);
    expect(old.stale).toBe(true);
    expect(h.fake.table('work_item')[0]!.name).toBe('Arreglar login');
    expect(h.emitted).toEqual([]);
  });

  it('un issue sin asignado no encola plan', async () => {
    await upsertMirrorFromLinear(issue({ assignee: null }), { source: 'webhook' }, silent);
    expect(ofType('plan.enqueue')).toEqual([]);
  });

  it('cambio de asignado hecho en Linear → corrección de la decisión de roz + plan reasignado', async () => {
    await upsertMirrorFromLinear(issue(), { source: 'create' }, silent);
    const w = h.fake.table('work_item')[0]!;
    h.fake.table('assignment_decision').push({
      id: 'dec-1',
      work_item_id: w.id,
      outcome: 'assigned',
      chosen_dev_id: ANA,
      overridden_at: null,
      created_at: '2026-11-01T10:00:00.000Z',
    });
    h.emitted = [];

    const r = await upsertMirrorFromLinear(
      issue({ updatedAt: '2026-11-03T10:00:00.000Z', assignee: { id: 'u-beto', name: 'Beto', displayName: 'beto', email: 'beto@acme.com' } }),
      { source: 'webhook' },
      silent,
    );
    expect(r).toMatchObject({ assigneeChanged: true, previousAssigneeDevId: ANA, assigneeDevId: BETO });
    const dec = h.fake.table('assignment_decision')[0]!;
    expect(dec).toMatchObject({ override_dev_id: BETO, override_category: 'otro', override_note: LINEAR_REASSIGN_NOTE, overridden_by: null });
    expect(ofType('plan.enqueue')[0]!.payload.reason).toBe('reasignado');
    expect(h.fake.table('work_item_assignee').map((a) => a.dev_id)).toEqual([BETO]);
  });

  it('una reasignación que hizo roz (source create) no se registra como corrección', async () => {
    await upsertMirrorFromLinear(issue(), { source: 'create' }, silent);
    const w = h.fake.table('work_item')[0]!;
    h.fake.table('assignment_decision').push({ id: 'dec-1', work_item_id: w.id, outcome: 'assigned', chosen_dev_id: ANA, overridden_at: null, created_at: '2026-11-01T10:00:00.000Z' });
    await upsertMirrorFromLinear(
      issue({ updatedAt: '2026-11-03T10:00:00.000Z', assignee: { id: 'u-beto', name: 'Beto', displayName: 'beto', email: 'beto@acme.com' } }),
      { source: 'create' },
      silent,
    );
    expect(h.fake.table('assignment_decision')[0]!.override_category).toBeUndefined();
  });

  it('al completarse: work_item.done + cierre del plan; al cancelarse: cancelación del plan', async () => {
    await upsertMirrorFromLinear(issue(), { source: 'webhook' }, silent);
    const w = h.fake.table('work_item')[0]!;
    await upsertMirrorFromLinear(
      issue({ updatedAt: '2026-11-04T10:00:00.000Z', state: { id: 'st-done', name: 'Done', type: 'completed' }, completedAt: '2026-11-04T10:00:00.000Z' }),
      { source: 'webhook' },
      silent,
    );
    expect(ofType('work_item.done')).toEqual([{ type: 'work_item.done', payload: { identifier: 'HYP-12' }, key: 'done:HYP-12' }]);
    expect(h.plans).toEqual([{ workItemId: w.id, t: 'issue_cerrado' }]);
    expect(h.fake.table('work_item')[0]!.completed_at).toBe('2026-11-04T10:00:00.000Z');

    await upsertMirrorFromLinear(
      issue({ updatedAt: '2026-11-05T10:00:00.000Z', state: { id: 'st-x', name: 'Canceled', type: 'canceled' } }),
      { source: 'webhook' },
      silent,
    );
    expect(h.plans[1]).toEqual({ workItemId: w.id, t: 'issue_cancelado' });
  });

  it('no pisa una tarea nativa con el mismo identificador: la renombra', async () => {
    h.fake.table('work_item').push({ id: 'native-1', linear_id: null, identifier: 'HYP-12', name: 'nativa', status: 'pendiente' });
    const r = await upsertMirrorFromLinear(issue(), { source: 'webhook' }, silent);
    const rows = h.fake.table('work_item');
    expect(rows.find((x) => x.id === 'native-1')!.identifier).toBe('HYP-12-1');
    expect(rows.find((x) => x.id === r.workItemId)!.identifier).toBe('HYP-12');
  });

  it('una fila nativa ya ligada (migración) se convierte en el espejo y conserva su identificador viejo', async () => {
    h.fake.table('work_item').push({
      id: 'native-1',
      linear_id: 'iss-1',
      identifier: 'ROZ-123',
      legacy_identifier: 'ROZ-123',
      status: 'pendiente',
      assignee_dev_id: ANA,
      linear_updated_at: null,
      source: 'native',
    });
    const r = await upsertMirrorFromLinear(issue(), { source: 'create', effects: false }, silent);
    expect(r).toMatchObject({ workItemId: 'native-1', created: false, assigneeChanged: false });
    expect(h.fake.table('work_item')[0]).toMatchObject({ identifier: 'HYP-12', legacy_identifier: 'ROZ-123', source: 'linear' });
    expect(h.emitted).toEqual([]);
  });

  it('retireMirror: un issue borrado queda cancelado y cancela su plan', async () => {
    await upsertMirrorFromLinear(issue(), { source: 'webhook' }, silent);
    const res = await retireMirror('iss-1');
    expect(h.fake.table('work_item')[0]!.status).toBe('cancelada');
    expect(h.plans).toEqual([{ workItemId: res.workItemId, t: 'issue_cancelado' }]);
    expect(await retireMirror('no-existe')).toEqual({ workItemId: null });
  });
});
