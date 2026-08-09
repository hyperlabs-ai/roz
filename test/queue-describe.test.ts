import { describe, it, expect } from 'vitest';
import { describeEvent, type QueueLookups } from '../src/dashboard/queue.js';

// `describeEvent` es pura: recibe la fila cruda del outbox y los índices ya resueltos. Se prueba
// entera sin base de datos, que es justo lo que hace falta — es la superficie con más riesgo
// (15 tipos de evento × con y sin enriquecimiento) y la que rompe la UI si degrada mal.

const row = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  type: 'commit.received',
  payload: {},
  status: 'pending',
  attempts: 0,
  next_attempt_at: '2026-08-09T12:00:00.000Z',
  started_at: null,
  error: null,
  created_at: '2026-08-09T12:00:00.000Z',
  updated_at: '2026-08-09T12:00:00.000Z',
  ...over,
}) as Parameters<typeof describeEvent>[0];

const lookups = (): QueueLookups => ({
  commits: new Map(),
  tasks: new Map(),
  devs: new Map(),
  devsByLogin: new Map(),
  projects: new Map(),
  reposToProject: new Map(),
});

describe('describeEvent — fases', () => {
  it('mapea el status a la fase que usa la UI', () => {
    expect(describeEvent(row({ status: 'pending' })).phase).toBe('inflight');
    expect(describeEvent(row({ status: 'processing' })).phase).toBe('inflight');
    expect(describeEvent(row({ status: 'done' })).phase).toBe('resolved');
    expect(describeEvent(row({ status: 'failed' })).phase).toBe('failed');
    expect(describeEvent(row({ status: 'dead' })).phase).toBe('failed');
  });

  it('solo expone resolvedAt/latencyMs cuando el estado es terminal', () => {
    const live = describeEvent(row({ status: 'processing' }));
    expect(live.resolvedAt).toBeNull();
    expect(live.latencyMs).toBeNull();

    const done = describeEvent(row({ status: 'done', updated_at: '2026-08-09T12:00:03.000Z' }));
    expect(done.resolvedAt).toBe('2026-08-09T12:00:03.000Z');
    expect(done.latencyMs).toBe(3000);
  });
});

describe('describeEvent — el actor viene del payload, sin tocar la base', () => {
  it('nombra al autor de un commit que aún no se ha procesado', () => {
    const ev = describeEvent(
      row({
        payload: { repo: 'org/roz', sha: 'a1b2c3d4e5f6', actor: { login: 'sebas', name: 'Sebastián' }, subject: 'fix: retry del webhook' },
      }),
      lookups(),
    );
    // Este es el requisito central: se puede decir "commit de Sebas" ANTES de que corra el drain.
    expect(ev.actor).toEqual({ login: 'sebas', name: 'Sebastián', avatarUrl: 'https://github.com/sebas.png?size=96', devId: null });
    expect(ev.subject).toBe('fix: retry del webhook');
    expect(ev.sha).toBe('a1b2c3d4');
    expect(ev.dev).toBeNull(); // todavía no hay atribución
  });

  it('prefiere el registro de roz cuando el login sí está dado de alta', () => {
    const l = lookups();
    l.devsByLogin.set('sebas', { id: 'd1', name: 'Sebastián Cortez', github_login: 'sebas' });
    const ev = describeEvent(row({ payload: { repo: 'org/roz', actor: { login: 'sebas', name: 'sebas' } } }), l);
    expect(ev.actor?.name).toBe('Sebastián Cortez');
    expect(ev.actor?.devId).toBe('d1');
  });

  it('tolera los eventos encolados antes del cambio (sin actor)', () => {
    const ev = describeEvent(row({ payload: { repo: 'org/roz', sha: 'abc1234567' } }), lookups());
    expect(ev.actor).toBeNull();
    expect(ev.repo).toBe('org/roz'); // el repo queda como sujeto — nunca un hueco
    expect(ev.subject).toBeNull();
  });
});

describe('describeEvent — atribución una vez resuelto', () => {
  it('trae dev acreditado, líneas y url desde roz.commit', () => {
    const l = lookups();
    l.devs.set('d1', { id: 'd1', name: 'Sebastián Cortez', github_login: 'sebas' });
    l.commits.set('org/roz::a1b2c3d4e5f6', {
      repo: 'org/roz', sha: 'a1b2c3d4e5f6', dev_id: 'd1', author_login: 'sebas',
      message: 'fix: retry del webhook\n\ncuerpo largo', url: 'https://github.com/org/roz/commit/a1b2',
      additions: 124, deletions: 18,
    });
    l.reposToProject.set('org/roz', 'roz');

    const ev = describeEvent(row({ status: 'done', payload: { repo: 'org/roz', sha: 'a1b2c3d4e5f6' } }), l);
    expect(ev.dev?.name).toBe('Sebastián Cortez');
    expect(ev.additions).toBe(124);
    expect(ev.deletions).toBe(18);
    expect(ev.subject).toBe('fix: retry del webhook'); // solo la primera línea
    expect(ev.projectName).toBe('roz');
  });

  it('distingue quién lo hizo de a quién se acreditó (el caso squash-merge)', () => {
    const l = lookups();
    l.devs.set('d2', { id: 'd2', name: 'Ana Ruiz', github_login: 'ana' });
    l.commits.set('org/roz::aaaa1111bbbb', {
      repo: 'org/roz', sha: 'aaaa1111bbbb', dev_id: 'd2', author_login: 'ana',
      message: 'merge', url: null, additions: 0, deletions: 0,
    });
    const ev = describeEvent(
      row({ status: 'done', payload: { repo: 'org/roz', sha: 'aaaa1111bbbb', actor: { login: 'sebas', name: 'Sebastián' } } }),
      l,
    );
    expect(ev.actor?.login).toBe('sebas');
    expect(ev.dev?.name).toBe('Ana Ruiz');
  });

  it('resuelve una PR contra su work_item por (repo, número)', () => {
    const l = lookups();
    l.tasks.set('org/roz::#218', {
      id: 'w1', identifier: 'ROZ-42', name: 'Arreglar el retry', url: 'https://roz/ROZ-42',
      repo: 'org/roz', pr_number: 218, project_id: 'p1', assignee_dev_id: null,
    });
    l.projects.set('p1', 'roz');

    const ev = describeEvent(row({ type: 'pr.merged', status: 'done', payload: { repo: 'org/roz', number: 218 } }), l);
    expect(ev.prNumber).toBe(218);
    expect(ev.task).toEqual({ identifier: 'ROZ-42', title: 'Arreglar el retry', url: 'https://roz/ROZ-42' });
    expect(ev.projectName).toBe('roz');
  });
});

describe('describeEvent — degradación', () => {
  it('no rompe con un tipo desconocido ni con payload vacío', () => {
    const ev = describeEvent(row({ type: 'algo.nuevo', payload: {} }), lookups());
    expect(ev.type).toBe('algo.nuevo');
    expect(ev.repo).toBeNull();
    expect(ev.actor).toBeNull();
    expect(ev.task).toBeNull();
  });

  it('sobrevive a payload null', () => {
    expect(() => describeEvent(row({ payload: null }), lookups())).not.toThrow();
  });

  it('expone los intentos contra el tope para el dead-letter', () => {
    const ev = describeEvent(row({ status: 'dead', attempts: 5, error: 'boom' }), lookups());
    expect(ev.attempts).toBe(5);
    expect(ev.maxAttempts).toBe(5);
    expect(ev.error).toBe('boom');
  });
});
