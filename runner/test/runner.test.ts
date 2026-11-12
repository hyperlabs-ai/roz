import { describe, expect, it } from 'vitest';
import { RozApiError } from '../src/api.js';
import type { Exec } from '../src/exec.js';
import { silentLogger, type FileOps } from '../src/fsops.js';
import { Runner } from '../src/runner.js';
import type { RunnerJob, RunnerProgressRequest, RunnerRegisterResponse } from '../src/types.js';

const memFs: FileOps = {
  exists: () => false,
  read: async () => null,
  write: async () => undefined,
  append: async () => undefined,
  mkdirp: async () => undefined,
  rm: async () => undefined,
};

const registration: RunnerRegisterResponse = {
  runner: {
    id: 'r-1',
    devId: 'd-1',
    devName: 'Dev',
    name: 'laptop',
    tokenPrefix: 'rozr_abcdefg',
    schedule: { tz: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '19:00' },
    maxConcurrent: 1,
    version: '0.1.0',
    platform: 'test',
    lastSeenAt: null,
    online: true,
    revokedAt: null,
    running: 0,
    createdAt: '2026-11-11T00:00:00Z',
  },
  dev: { id: 'd-1', name: 'Dev', githubLogin: 'dev' },
  mcpUrl: 'https://roz.test/mcp',
  heartbeatIntervalMs: 60_000,
  pollIntervalMs: 30_000,
};

const job: RunnerJob = {
  planId: 'p-1',
  leaseId: 'l-1',
  phase: 'planear',
  risk: 0,
  riskReasons: [],
  identifier: 'HYP-1',
  issue: { title: 't', description: null, url: null, projectName: null },
  repo: 'sin/mapear',
  baseBranch: 'main',
  branch: 'hyp-1-t',
  planMd: null,
  feedback: null,
  prompt: 'p',
  allowedTools: [],
  maxTurns: 40,
};

const noExec: Exec = async () => ({ code: 0, stdout: '', stderr: '', aborted: false });

describe('Runner', () => {
  it('registra, toma un trabajo, y se detiene con un 401 (token revocado)', async () => {
    const progress: RunnerProgressRequest[] = [];
    const waits: number[] = [];
    let calls = 0;
    const runner = new Runner(
      {
        api: {
          register: async () => registration,
          heartbeat: async () => ({ now: '', inSchedule: true, stop: [] }),
          nextJob: async () => {
            calls++;
            if (calls === 1) return { job, retryAfterMs: 0 };
            if (calls === 2) return { job: null, retryAfterMs: 30_000 };
            throw new RozApiError('token revocado', 401, 'RUNNER_UNAUTHORIZED', false);
          },
          progress: async (b) => {
            progress.push(b);
            return { status: 'en_cola', phase: 'planear', continue: false };
          },
        },
        exec: noExec,
        fs: memFs,
        log: silentLogger,
        cfg: { url: 'https://roz.test', token: 'rozr_x', name: 'laptop', repos: {} },
        home: '/h',
        sleep: async (ms) => void waits.push(ms),
      },
      { maxConcurrent: 1 },
    );

    const fatal = await runner.start();
    expect(fatal).toBe('token revocado');
    expect(waits).toEqual([1_000, 30_000]);
    // El trabajo con repo sin mapear terminó como failed con mensaje claro.
    expect(progress.find((p) => p.kind === 'failed')?.error).toContain('roz-runner repo add sin/mapear');
    expect(runner.running).toBe(0);
  });

  it('el latido detiene los planes que roz pide parar', async () => {
    let aborted: unknown = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = new Runner(
      {
        api: {
          register: async () => registration,
          heartbeat: async (b) => ({ now: '', inSchedule: true, stop: b.running.map((r) => ({ planId: r.planId, reason: 'cancelado' as const })) }),
          nextJob: async () => {
            await gate;
            throw new RozApiError('fin', 401, 'RUNNER_UNAUTHORIZED', false);
          },
          progress: async () => ({ status: 'planeando', phase: 'planear', continue: false }),
        },
        exec: async (_c, _a, o) => {
          // git se queda "colgado" hasta que lo aborten
          await new Promise<void>((r) => o?.signal?.addEventListener('abort', () => r(), { once: true }));
          aborted = o?.signal?.reason;
          return { code: null, stdout: '', stderr: '', aborted: true };
        },
        fs: { ...memFs, exists: () => true },
        log: silentLogger,
        cfg: { url: 'https://roz.test', token: 'rozr_x', name: 'laptop', repos: { 'sin/mapear': '/src/x' } },
        home: '/h',
        sleep: async () => undefined,
      },
      { maxConcurrent: 2 },
    );
    // Primer next-job entrega el trabajo; el segundo espera la compuerta.
    let first = true;
    const api = (runner as unknown as { deps: { api: { nextJob: () => Promise<unknown> } } }).deps.api;
    const original = api.nextJob;
    api.nextJob = async () => {
      if (first) {
        first = false;
        return { job, retryAfterMs: 0 };
      }
      return original();
    };

    const done = runner.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.running).toBe(1);
    await runner.heartbeat();
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe('stop:cancelado');
    expect(runner.running).toBe(0);
    release();
    await done;
  });
});
