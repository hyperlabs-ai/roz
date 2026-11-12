import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from './linear-fake-db.js';

// Intake con el flag: confirmProposal crea el issue en Linear (con la prioridad 1-4 y lo que ya sabe
// el intake); con el flag apagado sigue creando la tarea nativa exactamente como antes.

const h = vi.hoisted(() => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  process.env.LINEAR_WEBHOOK_SECRET = 'whsec_test';
  return {
    sot: true,
    fake: null as unknown as FakeDb,
    native: [] as Record<string, unknown>[],
    linear: [] as Record<string, unknown>[],
  };
});

vi.mock('../src/db/supabase.js', () => ({ db: () => h.fake, dbPublic: () => h.fake }));
vi.mock('../src/linear/enabled.js', () => ({ linearSourceOfTruth: () => h.sot, assertTasksWritable: () => {}, TASKS_READ_ONLY_CODE: 'TASKS_READ_ONLY' }));
vi.mock('../src/adapters/anthropic.js', () => ({ complete: async () => '{}' }));
vi.mock('../src/brain/retrieval.js', () => ({ getProjectContext: async () => [] }));
vi.mock('../src/router/assign.js', () => ({ rankAssignees: async () => [] }));
vi.mock('../src/dashboard/queries.js', () => ({
  createTask: async (input: Record<string, unknown>) => {
    h.native.push(input);
    return { id: 'w-native', identifier: 'ROZ-7' };
  },
}));
vi.mock('../src/linear/issues.js', () => ({
  createIssueFromTicket: async (input: Record<string, unknown>) => {
    h.linear.push(input);
    return { linearIssueId: 'iss-1', identifier: 'HYP-1', url: 'https://linear.app/x/HYP-1', workItemId: 'w-1', assigneeDevId: 'ana', warnings: [] };
  },
}));

import { confirmProposal } from '../src/intake/proposal.js';

beforeEach(() => {
  h.sot = true;
  h.native = [];
  h.linear = [];
  h.fake = createFakeDb();
  h.fake.table('proposal').push({
    id: 'prop-1',
    name: 'Botón roto',
    description: 'El botón de pago no responde',
    priority: 'high',
    requester: 'cliente@acme.com',
    status: 'evaluated',
    project: { id: 'p1', key: 'ACME', name: 'Acme' },
  });
  h.fake.table('dev').push({ id: 'ana', active: true });
});

describe('confirmProposal', () => {
  it('flag encendido: issue en Linear con prioridad 2, tipo y puntos del intake; propuesta promovida', async () => {
    const r = await confirmProposal('prop-1', 'ana', { estimate: 3, solutionTypeId: 'st-1' });
    expect(h.native).toEqual([]);
    expect(h.linear[0]).toMatchObject({
      projectId: 'p1',
      title: 'Botón roto',
      priority: 2,
      estimate: 3,
      solutionTypeId: 'st-1',
      assigneeDevId: 'ana',
      origin: 'intake',
      requestedBy: null,
      source: { requester: 'cliente@acme.com' },
    });
    expect(r).toEqual({ workItemId: 'w-1', identifier: 'HYP-1', url: 'https://linear.app/x/HYP-1', warnings: [], assigneeDevId: 'ana' });
    expect(h.fake.table('proposal')[0]!.status).toBe('promoted');
  });

  it('flag apagado: tarea nativa como siempre', async () => {
    h.sot = false;
    const r = await confirmProposal('prop-1', 'ana');
    expect(h.linear).toEqual([]);
    expect(h.native[0]).toMatchObject({ projectId: 'p1', name: 'Botón roto', status: 'pendiente', priority: 'high', assigneeDevId: 'ana' });
    expect(r.identifier).toBe('ROZ-7');
  });
});
