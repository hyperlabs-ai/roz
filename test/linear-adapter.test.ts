import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Transporte a Linear. Como con TypeSafe, lo que importa es cómo FALLA: un error de la API nunca se
// lee como "no hay issues", y quien llama (el outbox) necesita saber si reintentar. Además: la
// paginación no se detiene en la primera página, y el webhook solo pasa con firma válida y reciente.

const KEY = 'lin_api_test_123';

async function load() {
  process.env.LINEAR_API_KEY = KEY;
  vi.resetModules();
  return import('../src/adapters/linear.js');
}

function issueNode(over: Record<string, unknown> = {}) {
  return {
    id: 'iss-1',
    identifier: 'HYP-12',
    number: 12,
    title: 'Arreglar login',
    description: null,
    url: 'https://linear.app/acme/issue/HYP-12',
    priority: 2,
    estimate: 3,
    dueDate: null,
    branchName: 'hyp-12-arreglar-login',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    state: { id: 'st-1', name: 'In Progress', type: 'started' },
    assignee: { id: 'u-1', name: 'Ana', displayName: 'ana', email: 'ana@acme.com' },
    creator: null,
    team: { id: 't-1', key: 'HYP', name: 'Hyper' },
    project: null,
    labels: { nodes: [{ id: 'l-1', name: 'Bug' }] },
    cycle: null,
    ...over,
  };
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function respond(...replies: Reply[]) {
  let i = 0;
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      text: async () => text,
      json: async () => r.body,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof respond>, call = 0): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(fetchMock.mock.calls[call]![1].body as string);
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LINEAR_API_KEY;
});

describe('linearGraphql', () => {
  it('sin llave no llama a la red y el error no es reintentable', async () => {
    delete process.env.LINEAR_API_KEY;
    vi.resetModules();
    const { linearGraphql, LinearError } = await import('../src/adapters/linear.js');
    const fetchMock = respond({ status: 200, body: { data: {} } });
    await expect(linearGraphql('{ viewer { id } }')).rejects.toBeInstanceOf(LinearError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('la llave personal va tal cual en authorization (sin Bearer)', async () => {
    const { viewer } = await load();
    const fetchMock = respond({ status: 200, body: { data: { viewer: { id: 'u', name: 'Ana', email: 'a@x.com', organization: null } } } });
    await viewer();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.linear.app/graphql');
    expect((init.headers as Record<string, string>).authorization).toBe(KEY);
  });

  it('rate limit (400 + RATELIMITED): reintentable con retry-after', async () => {
    const { linearGraphql } = await load();
    respond({
      status: 400,
      body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] },
      headers: { 'retry-after': '30' },
    });
    await expect(linearGraphql('{ viewer { id } }')).rejects.toMatchObject({ retryable: true, code: 'RATELIMITED', retryAfterSec: 30 });
  });

  it('429 también es rate limit', async () => {
    const { linearGraphql } = await load();
    respond({ status: 429, body: 'slow down' });
    await expect(linearGraphql('{ viewer { id } }')).rejects.toMatchObject({ retryable: true, status: 429 });
  });

  it('401: no reintentable (llave mala no se arregla esperando)', async () => {
    const { linearGraphql } = await load();
    respond({ status: 401, body: { errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] } });
    await expect(linearGraphql('{ viewer { id } }')).rejects.toMatchObject({ retryable: false, status: 401, code: 'AUTHENTICATION_ERROR' });
  });

  it('5xx y red caída: reintentables', async () => {
    const { linearGraphql } = await load();
    respond({ status: 503, body: 'unavailable' });
    await expect(linearGraphql('{ viewer { id } }')).rejects.toMatchObject({ retryable: true, status: 503 });

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    await expect(linearGraphql('{ viewer { id } }')).rejects.toMatchObject({ retryable: true, status: null, code: 'network' });
  });

  it('200 con errors GraphQL: error, nunca datos parciales', async () => {
    const { linearGraphql } = await load();
    respond({ status: 200, body: { data: null, errors: [{ message: 'Argument Validation Error', extensions: { code: 'INVALID_INPUT' } }] } });
    await expect(linearGraphql('{ x }')).rejects.toMatchObject({ retryable: false, code: 'INVALID_INPUT' });
  });

  it('200 sin data: cambio de contrato, no reintentable', async () => {
    const { linearGraphql } = await load();
    respond({ status: 200, body: 'no es json' });
    await expect(linearGraphql('{ x }')).rejects.toMatchObject({ retryable: false, code: 'respuesta_invalida' });
  });
});

describe('issues', () => {
  it('createIssue manda solo los campos con valor y normaliza el issue', async () => {
    const { createIssue } = await load();
    const fetchMock = respond({ status: 200, body: { data: { issueCreate: { success: true, issue: issueNode() } } } });
    const issue = await createIssue({
      teamId: 't-1',
      title: 'Arreglar login',
      description: 'No entra con Google',
      labelIds: ['l-1'],
      priority: 2,
      estimate: 3,
      assigneeId: 'u-1',
      projectId: null,
    });
    const { variables, query } = sentBody(fetchMock);
    expect(query).toContain('issueCreate');
    expect(variables.input).toEqual({
      teamId: 't-1',
      title: 'Arreglar login',
      description: 'No entra con Google',
      labelIds: ['l-1'],
      priority: 2,
      estimate: 3,
      assigneeId: 'u-1',
    });
    expect(issue.identifier).toBe('HYP-12');
    expect(issue.labels).toEqual([{ id: 'l-1', name: 'Bug' }]);
    expect(issue.assignee?.email).toBe('ana@acme.com');
    expect(issue.project).toBeNull();
  });

  it('success:false en la mutación es error', async () => {
    const { createIssue } = await load();
    respond({ status: 200, body: { data: { issueCreate: { success: false, issue: null } } } });
    await expect(createIssue({ teamId: 't', title: 'x' })).rejects.toMatchObject({ code: 'mutation_failed', retryable: false });
  });

  it('updateIssue: assigneeId null quita el asignado; undefined no se manda', async () => {
    const { updateIssue } = await load();
    const fetchMock = respond({ status: 200, body: { data: { issueUpdate: { success: true, issue: issueNode({ assignee: null }) } } } });
    const issue = await updateIssue('iss-1', { assigneeId: null });
    expect(sentBody(fetchMock).variables).toEqual({ id: 'iss-1', input: { assigneeId: null } });
    expect(issue.assignee).toBeNull();
  });

  it('updateIssue sin cambios no llama a la red', async () => {
    const { updateIssue } = await load();
    const fetchMock = respond({ status: 200, body: {} });
    await expect(updateIssue('iss-1', {})).rejects.toMatchObject({ code: 'sin_cambios' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('createComment devuelve el comentario', async () => {
    const { createComment } = await load();
    const fetchMock = respond({
      status: 200,
      body: { data: { commentCreate: { success: true, comment: { id: 'c-1', body: 'dup', url: 'https://l/c-1', createdAt: '2026-11-02T00:00:00Z' } } } },
    });
    const c = await createComment('iss-1', 'dup');
    expect(sentBody(fetchMock).variables).toEqual({ input: { issueId: 'iss-1', body: 'dup' } });
    expect(c).toEqual({ id: 'c-1', body: 'dup', url: 'https://l/c-1', createdAt: '2026-11-02T00:00:00Z' });
  });

  it('un issue con otra forma es respuesta_invalida', async () => {
    const { createIssue } = await load();
    respond({ status: 200, body: { data: { issueCreate: { success: true, issue: { id: 'x' } } } } });
    await expect(createIssue({ teamId: 't', title: 'x' })).rejects.toMatchObject({ code: 'respuesta_invalida' });
  });

  it('getIssue: "not found" es null, no error', async () => {
    const { getIssue } = await load();
    respond({ status: 200, body: { data: null, errors: [{ message: 'Entity not found: Issue', extensions: { code: 'INVALID_INPUT' } }] } });
    await expect(getIssue('HYP-999')).resolves.toBeNull();
  });

  it('issuesUpdatedSince recorre todas las páginas, filtra por equipo y ordena por updatedAt', async () => {
    const { issuesUpdatedSince } = await load();
    const fetchMock = respond(
      {
        status: 200,
        body: {
          data: {
            issues: {
              nodes: [issueNode({ id: 'b', updatedAt: '2026-11-03T00:00:00Z' })],
              pageInfo: { hasNextPage: true, endCursor: 'cur-1' },
            },
          },
        },
      },
      {
        status: 200,
        body: {
          data: {
            issues: {
              nodes: [issueNode({ id: 'a', updatedAt: '2026-11-02T00:00:00Z' })],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    );
    const { issues, truncated } = await issuesUpdatedSince('2026-11-01T00:00:00Z', { teamId: 't-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock, 0).variables).toMatchObject({
      filter: { updatedAt: { gt: '2026-11-01T00:00:00Z' }, team: { id: { eq: 't-1' } } },
      after: null,
    });
    expect(sentBody(fetchMock, 1).variables.after).toBe('cur-1');
    expect(issues.map((i) => i.id)).toEqual(['a', 'b']);
    expect(truncated).toBe(false);
  });

  it('issuesUpdatedSince avisa cuando corta por maxPages', async () => {
    const { issuesUpdatedSince } = await load();
    respond({ status: 200, body: { data: { issues: { nodes: [issueNode()], pageInfo: { hasNextPage: true, endCursor: 'c' } } } } });
    const res = await issuesUpdatedSince('2026-11-01T00:00:00Z', { maxPages: 2 });
    expect(res.truncated).toBe(true);
    expect(res.issues).toHaveLength(2);
  });

  it('un error a media paginación se propaga (no devuelve la mitad como si fuera todo)', async () => {
    const { issuesUpdatedSince } = await load();
    respond(
      { status: 200, body: { data: { issues: { nodes: [issueNode()], pageInfo: { hasNextPage: true, endCursor: 'c' } } } } },
      { status: 502, body: 'bad gateway' },
    );
    await expect(issuesUpdatedSince('2026-11-01T00:00:00Z')).rejects.toMatchObject({ retryable: true, status: 502 });
  });
});

describe('catálogos', () => {
  it('listUsers baja el correo a minúsculas', async () => {
    const { listUsers } = await load();
    respond({
      status: 200,
      body: {
        data: {
          users: {
            nodes: [{ id: 'u-1', name: 'Ana', displayName: 'ana', email: 'Ana@ACME.com', active: true, avatarUrl: null }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    expect(await listUsers()).toEqual([{ id: 'u-1', name: 'Ana', displayName: 'ana', email: 'ana@acme.com', active: true, avatarUrl: null }]);
  });

  it('listWorkflowStates aplana el equipo', async () => {
    const { listWorkflowStates } = await load();
    const fetchMock = respond({
      status: 200,
      body: {
        data: {
          workflowStates: {
            nodes: [{ id: 's-1', name: 'Todo', type: 'unstarted', position: 1, team: { id: 't-1' } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    expect(await listWorkflowStates('t-1')).toEqual([{ id: 's-1', name: 'Todo', type: 'unstarted', position: 1, teamId: 't-1' }]);
    expect(sentBody(fetchMock).variables.filter).toEqual({ team: { id: { eq: 't-1' } } });
  });

  it('listLabels incluye las del workspace (teamId null)', async () => {
    const { listLabels } = await load();
    respond({
      status: 200,
      body: {
        data: {
          issueLabels: {
            nodes: [
              { id: 'l-1', name: 'Bug', color: '#f00', team: { id: 't-1' } },
              { id: 'l-2', name: 'Cliente', color: null, team: null },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    const labels = await listLabels('t-1');
    expect(labels.map((l) => l.teamId)).toEqual(['t-1', null]);
  });
});

describe('webhook', () => {
  const SECRET = 'whsec_linear';
  const body = JSON.stringify({ action: 'update', type: 'Issue', data: { id: 'iss-1' }, webhookTimestamp: 1_700_000_000_000 });
  const sign = (b: string, s = SECRET) => createHmac('sha256', s).update(b).digest('hex');

  it('acepta la firma correcta del cuerpo crudo', async () => {
    const { verifyLinearSignature } = await load();
    expect(verifyLinearSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rechaza firma de otro secreto, cuerpo alterado, firma vacía o secreto vacío', async () => {
    const { verifyLinearSignature } = await load();
    expect(verifyLinearSignature(body, sign(body, 'otro'), SECRET)).toBe(false);
    expect(verifyLinearSignature(body + ' ', sign(body), SECRET)).toBe(false);
    expect(verifyLinearSignature(body, null, SECRET)).toBe(false);
    expect(verifyLinearSignature(body, sign(body), '')).toBe(false);
    expect(verifyLinearSignature(body, 'abc', SECRET)).toBe(false);
  });

  it('anti-replay: solo webhooks de hace menos de 60 s', async () => {
    const { isFreshLinearWebhook } = await load();
    const now = 1_700_000_000_000;
    expect(isFreshLinearWebhook(now - 30_000, now)).toBe(true);
    expect(isFreshLinearWebhook(now - 61_000, now)).toBe(false);
    expect(isFreshLinearWebhook(now + 61_000, now)).toBe(false);
    expect(isFreshLinearWebhook(undefined, now)).toBe(false);
    expect(isFreshLinearWebhook('no', now)).toBe(false);
  });
});
