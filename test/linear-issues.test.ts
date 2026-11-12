import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from './linear-fake-db.js';

// Lo que roz escribe en Linear. Importa: el mapeo (equipo, proyecto, etiqueta, prioridad 1-4,
// asignado por correo), que lo no mapeable se cree igual con warning en vez de fallar, que lo que no
// tiene arreglo falle con código claro, y que el espejo quede escrito EN EL MOMENTO.

const h = vi.hoisted(() => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  process.env.LINEAR_WEBHOOK_SECRET = 'whsec_test';
  process.env.LINEAR_TEAM_ID = '';
  return {
    fake: null as unknown as FakeDb,
    created: [] as Record<string, unknown>[],
    updated: [] as { id: string; input: Record<string, unknown> }[],
    comments: [] as { issueId: string; body: string }[],
  };
});

function issueFrom(input: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id: 'iss-9',
    identifier: 'HYP-9',
    number: 9,
    title: String(input.title ?? 'x'),
    description: (input.description as string) ?? null,
    url: 'https://linear.app/acme/issue/HYP-9',
    priority: (input.priority as number) ?? 0,
    estimate: (input.estimate as number) ?? null,
    dueDate: (input.dueDate as string) ?? null,
    branchName: 'hyp-9',
    createdAt: '2026-11-10T10:00:00.000Z',
    updatedAt: '2026-11-10T10:00:00.000Z',
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    state: { id: 'st-todo', name: 'Todo', type: 'unstarted' as const },
    assignee: input.assigneeId ? { id: String(input.assigneeId), name: 'Ana', displayName: 'ana', email: 'ana@acme.com' } : null,
    creator: null,
    team: { id: String(input.teamId), key: 'HYP', name: 'Hyper' },
    project: input.projectId ? { id: String(input.projectId), name: 'Portal' } : null,
    labels: ((input.labelIds as string[]) ?? []).map((id) => ({ id, name: 'Maquetación' })),
    cycle: null,
    ...over,
  };
}

vi.mock('../src/db/supabase.js', () => ({ db: () => h.fake, dbPublic: () => h.fake }));
vi.mock('../src/events/outbox.js', () => ({ emit: async () => 'ev' }));
vi.mock('../src/plans/service.js', () => ({ applyIssueTransition: async () => ({ planId: null, status: null }) }));
vi.mock('../src/adapters/linear.js', async (orig) => ({
  ...(await orig<typeof import('../src/adapters/linear.js')>()),
  createIssue: async (input: Record<string, unknown>) => {
    h.created.push(input);
    return issueFrom(input);
  },
  updateIssue: async (id: string, input: Record<string, unknown>) => {
    h.updated.push({ id, input });
    return issueFrom({ teamId: 't-hyp', assigneeId: input.assigneeId, title: 'Arreglar' }, { id, updatedAt: '2026-11-11T10:00:00.000Z' });
  },
  createComment: async (issueId: string, body: string) => {
    h.comments.push({ issueId, body });
    return { id: 'c-1', body, url: 'https://linear.app/c-1', createdAt: '2026-11-11T10:00:00.000Z' };
  },
}));

import { commentOnIssue, createIssueFromTicket, issueDescription, reassignIssue } from '../src/linear/issues.js';

function seed() {
  h.fake = createFakeDb({ work_item: ['linear_id', 'identifier'] });
  h.fake.table('project').push(
    { id: 'p1', linear_team_id: 't-hyp', linear_project_id: 'lp-1' },
    { id: 'p-sin-equipo', linear_team_id: null, linear_project_id: null },
  );
  h.fake.table('dev').push(
    { id: 'ana', email: 'ana@acme.com', github_email: null },
    { id: 'sin-linear', email: 'nadie@acme.com', github_email: null },
  );
  h.fake.table('linear_link').push(
    { kind: 'team', linear_id: 't-hyp', key: 'HYP', active: true },
    { kind: 'user', linear_id: 'u-ana', roz_id: null, key: 'ana@acme.com', active: true },
    { kind: 'label', linear_id: 'l-ui', roz_id: 'st-ui', team_id: 't-hyp', active: true },
  );
}

const base = {
  projectId: 'p1',
  title: '  Nueva pantalla  ',
  description: 'Hacer la pantalla',
  solutionTypeId: 'st-ui',
  estimate: 3,
  priority: 1 as const,
  assigneeDevId: 'ana',
  dueDate: '2026-11-20',
  origin: 'ticket' as const,
  requestedBy: 'user-1',
};

beforeEach(() => {
  seed();
  h.created = [];
  h.updated = [];
  h.comments = [];
});

describe('createIssueFromTicket', () => {
  it('mapea equipo, proyecto, etiqueta, prioridad, estimación y asignado por correo; escribe el espejo ya', async () => {
    const r = await createIssueFromTicket(base);
    expect(h.created[0]).toMatchObject({
      teamId: 't-hyp',
      title: 'Nueva pantalla',
      projectId: 'lp-1',
      labelIds: ['l-ui'],
      estimate: 3,
      priority: 1,
      assigneeId: 'u-ana',
      dueDate: '2026-11-20',
    });
    expect(String(h.created[0]!.description)).toContain('Hacer la pantalla');
    expect(r).toMatchObject({ linearIssueId: 'iss-9', identifier: 'HYP-9', assigneeDevId: 'ana', warnings: [] });
    const w = h.fake.table('work_item').find((x) => x.id === r.workItemId)!;
    expect(w).toMatchObject({ linear_id: 'iss-9', assignee_dev_id: 'ana', solution_type_id: 'st-ui', created_by: 'user-1' });
  });

  it('sin etiqueta ni usuario en Linear: se crea igual, con warnings', async () => {
    const r = await createIssueFromTicket({ ...base, solutionTypeId: 'st-sin-etiqueta', assigneeDevId: 'sin-linear', priority: null });
    expect(h.created[0]).toMatchObject({ labelIds: [], assigneeId: null, priority: 0 });
    expect(r.warnings).toHaveLength(2);
    expect(r.assigneeDevId).toBeNull();
  });

  it('proyecto sin equipo y sin LINEAR_TEAM_ID → 422 LINEAR_TEAM_MISSING sin llamar a Linear', async () => {
    await expect(createIssueFromTicket({ ...base, projectId: 'p-sin-equipo' })).rejects.toMatchObject({ code: 'LINEAR_TEAM_MISSING', status: 422 });
    expect(h.created).toEqual([]);
  });

  it('descripción de una junta: cita literal y título de la junta', () => {
    const d = issueDescription({ description: 'Mandar cotización', origin: 'meeting', source: { quote: 'Ana manda la\ncotización el viernes' } }, 'Kickoff Acme');
    expect(d).toContain('Mandar cotización');
    expect(d).toContain('Desde la junta «Kickoff Acme»');
    expect(d).toContain('> Ana manda la\n> cotización el viernes');
  });
});

describe('comentar y reasignar', () => {
  beforeEach(() => {
    h.fake.table('work_item').push(
      { id: 'w1', linear_id: 'iss-9', identifier: 'HYP-9', status: 'pendiente', assignee_dev_id: null, linear_updated_at: '2026-11-10T10:00:00.000Z' },
      { id: 'w-nativa', linear_id: null, identifier: 'ROZ-1', status: 'pendiente' },
    );
  });

  it('comenta el duplicado por workItemId', async () => {
    const r = await commentOnIssue({ workItemId: 'w1', body: ' Lo pidieron otra vez en la junta ' });
    expect(h.comments).toEqual([{ issueId: 'iss-9', body: 'Lo pidieron otra vez en la junta' }]);
    expect(r).toEqual({ commentId: 'c-1', url: 'https://linear.app/c-1', identifier: 'HYP-9' });
  });

  it('una tarea que no está en Linear no se puede comentar ahí', async () => {
    await expect(commentOnIssue({ workItemId: 'w-nativa', body: 'x' })).rejects.toMatchObject({ code: 'NOT_IN_LINEAR' });
  });

  it('reasignar: usuario por correo → issueUpdate → espejo al día', async () => {
    const r = await reassignIssue({ workItemId: 'w1', toDevId: 'ana', reason: 'reclamado' });
    expect(h.updated).toEqual([{ id: 'iss-9', input: { assigneeId: 'u-ana' } }]);
    expect(r).toEqual({ assigneeLinearId: 'u-ana', identifier: 'HYP-9' });
    expect(h.fake.table('work_item').find((x) => x.id === 'w1')!.assignee_dev_id).toBe('ana');
  });

  it('reasignar a alguien sin usuario en Linear → 422 LINEAR_USER_MISSING', async () => {
    await expect(reassignIssue({ workItemId: 'w1', toDevId: 'sin-linear', reason: 'reclamado' })).rejects.toMatchObject({
      code: 'LINEAR_USER_MISSING',
      status: 422,
    });
    expect(h.updated).toEqual([]);
  });
});
