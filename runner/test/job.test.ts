import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RozApiError } from '../src/api.js';
import type { RunnerConfig } from '../src/config.js';
import type { Exec, ExecOptions, ExecResult } from '../src/exec.js';
import { silentLogger, type FileOps } from '../src/fsops.js';
import { SHUTDOWN, runJob, type JobDeps } from '../src/job.js';
import type { RunnerJob, RunnerProgressRequest, RunnerProgressResponse } from '../src/types.js';

const HOME = path.resolve('/home/dev/.roz-runner');
const REPO = path.resolve('/src/roz');
const WT = path.join(HOME, 'worktrees', 'hyperlabs__roz', 'hyp-7');

function memFs(initial: Record<string, string> = {}): FileOps & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    exists: (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(p + path.sep)),
    read: async (p) => files.get(p) ?? null,
    write: async (p, c) => void files.set(p, c),
    append: async (p, c) => void files.set(p, (files.get(p) ?? '') + c),
    mkdirp: async () => undefined,
    rm: async (p) => {
      for (const k of [...files.keys()]) if (k === p || k.startsWith(p + path.sep)) files.delete(k);
    },
  };
}

type Call = { cmd: string; args: string[]; opts?: ExecOptions };
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', aborted: false });
const fail = (stderr = 'x', code = 1): ExecResult => ({ code, stdout: '', stderr, aborted: false });

/** Exec falso: git/gh/claude con respuestas razonables; `override` cambia las que interesan. */
function fakeExec(fs: ReturnType<typeof memFs>, override?: (c: Call) => ExecResult | Promise<ExecResult> | undefined) {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    const o = await override?.(call);
    if (o) return o;
    const joined = args.join(' ');
    if (cmd === 'git') {
      if (joined.includes('symbolic-ref')) return ok('origin/main\n');
      if (joined.includes('rev-parse --verify')) return fail('', 1);
      if (joined.includes('rev-parse --git-path')) return ok('../../.git/info/exclude\n');
      if (joined.includes('worktree add')) {
        fs.files.set(path.join(WT, '.git'), 'gitdir: …');
        return ok();
      }
      if (joined.includes('status --porcelain')) return ok('');
      if (joined.includes('rev-list --count')) return ok('2\n');
      return ok();
    }
    if (cmd === 'claude') {
      // En fase plan, Claude escribe PLAN.md.
      if (args.includes('Write(PLAN.md)')) fs.files.set(path.join(opts!.cwd!, 'PLAN.md'), '# Plan\n- paso 1\n');
      return ok(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hecho', num_turns: 3 }));
    }
    if (cmd === 'gh') return ok('https://github.com/hyperlabs/roz/pull/77\n');
    return fail('desconocido', 127);
  };
  return { exec, calls };
}

function fakeApi(responses: Partial<Record<RunnerProgressRequest['kind'], RunnerProgressResponse | Error>> = {}) {
  const sent: RunnerProgressRequest[] = [];
  return {
    sent,
    api: {
      progress: async (body: RunnerProgressRequest): Promise<RunnerProgressResponse> => {
        sent.push(body);
        const r = responses[body.kind];
        if (r instanceof Error) throw r;
        return r ?? { status: 'planeando', phase: 'planear', continue: false };
      },
    },
  };
}

const cfg: RunnerConfig = { url: 'https://roz.test', token: 'rozr_secreto', name: 'laptop', repos: { 'hyperlabs/roz': REPO } };

function job(over: Partial<RunnerJob> = {}): RunnerJob {
  return {
    planId: 'p-1',
    leaseId: 'l-1',
    phase: 'planear',
    risk: 0,
    riskReasons: [],
    identifier: 'HYP-7',
    issue: { title: 'Agregar filtro', description: null, url: 'https://linear.app/h/HYP-7', projectName: 'roz' },
    repo: 'HyperLabs/roz',
    baseBranch: 'main',
    branch: 'hyp-7-agregar-filtro',
    planMd: null,
    feedback: null,
    prompt: 'Escribe el plan en PLAN.md',
    allowedTools: ['Read', 'Glob', 'Grep', 'Write(PLAN.md)', 'mcp__roz__*'],
    maxTurns: 40,
    ...over,
  };
}

function deps(fs: ReturnType<typeof memFs>, exec: Exec, api: JobDeps['api']): JobDeps {
  return { exec, fs, api, cfg, home: HOME, mcpUrl: 'https://roz.test/mcp', log: silentLogger };
}

const repoFs = () => memFs({ [path.join(REPO, '.git', 'HEAD')]: 'ref: refs/heads/main' });

describe('runJob', () => {
  it('riesgo 0: planea, sigue (continue) e implementa hasta abrir la PR', async () => {
    const fs = repoFs();
    const { exec, calls } = fakeExec(fs);
    const { api, sent } = fakeApi({
      plan_ready: { status: 'implementando', phase: 'implementar', continue: true },
      pr_opened: { status: 'pr_abierto', phase: 'implementar', continue: false },
    });

    const out = await runJob(job(), deps(fs, exec, api), new AbortController().signal);
    expect(out).toBe('pr_opened');

    const kinds = sent.map((s) => s.kind).filter((k) => k !== 'progress');
    expect(kinds).toEqual(['plan_ready', 'pr_opened']);
    expect(sent.find((s) => s.kind === 'plan_ready')!.planMd).toContain('paso 1');
    expect(sent.find((s) => s.kind === 'pr_opened')).toMatchObject({
      branch: 'hyp-7-agregar-filtro',
      prNumber: 77,
      prUrl: 'https://github.com/hyperlabs/roz/pull/77',
      leaseId: 'l-1',
    });

    // worktree nuevo desde origin/main con la rama del ID de Linear
    const add = calls.find((c) => c.cmd === 'git' && c.args.includes('worktree') && c.args.includes('add'))!;
    expect(add.args).toEqual(['-C', REPO, 'worktree', 'add', '--no-track', '-b', 'hyp-7-agregar-filtro', WT, 'origin/main']);

    // dos corridas de Claude: plan (lista del servidor) e implementación (lista local con Edit)
    const claude = calls.filter((c) => c.cmd === 'claude');
    expect(claude).toHaveLength(2);
    expect(claude[0]!.opts!.input).toBe('Escribe el plan en PLAN.md');
    expect(claude[0]!.args).toContain('Write(PLAN.md)');
    expect(claude[1]!.args).toContain('Edit');
    expect(claude[1]!.opts!.input).toContain('paso 1');
    expect(claude.every((c) => c.opts!.cwd === WT)).toBe(true);

    // push y PR por gh
    expect(calls.some((c) => c.cmd === 'git' && c.args.join(' ').includes('push -u origin hyp-7-agregar-filtro'))).toBe(true);
    const gh = calls.find((c) => c.cmd === 'gh')!;
    expect(gh.args.slice(0, 2)).toEqual(['pr', 'create']);
    expect(gh.args).toContain('HYP-7: Agregar filtro');

    // PLAN.md ignorado; el archivo MCP con el token se borra al terminar
    const exclude = [...fs.files.entries()].find(([k]) => k.endsWith(path.join('info', 'exclude')));
    expect(exclude?.[1]).toContain('/PLAN.md');
    expect([...fs.files.keys()].some((k) => k.includes('mcp-p-1.json'))).toBe(false);
  });

  it('riesgo 1: reporta plan_ready y se detiene (continue: false)', async () => {
    const fs = repoFs();
    const { exec, calls } = fakeExec(fs);
    const { api, sent } = fakeApi({ plan_ready: { status: 'esperando_aprobacion', phase: 'planear', continue: false } });
    const out = await runJob(job({ risk: 1 }), deps(fs, exec, api), new AbortController().signal);
    expect(out).toBe('plan_ready');
    expect(calls.filter((c) => c.cmd === 'claude')).toHaveLength(1);
    expect(calls.some((c) => c.cmd === 'gh')).toBe(false);
    expect(sent.at(-1)!.kind).toBe('plan_ready');
  });

  it('plan aprobado (fase implementar): no vuelve a planear, escribe PLAN.md y abre PR', async () => {
    const fs = repoFs();
    const { exec, calls } = fakeExec(fs);
    const { api, sent } = fakeApi();
    const out = await runJob(
      job({ phase: 'implementar', risk: 1, planMd: '# Aprobado', prompt: 'Implementa', allowedTools: ['Read', 'Edit'], maxTurns: 120 }),
      deps(fs, exec, api),
      new AbortController().signal,
    );
    expect(out).toBe('pr_opened');
    const claude = calls.filter((c) => c.cmd === 'claude');
    expect(claude).toHaveLength(1);
    expect(claude[0]!.opts!.input).toBe('Implementa');
    expect(claude[0]!.args).toEqual(expect.arrayContaining(['--max-turns', '120', '--allowedTools', 'Read', 'Edit']));
    expect(fs.files.get(path.join(WT, 'PLAN.md'))).toBe('# Aprobado');
    expect(sent.some((s) => s.kind === 'pr_opened')).toBe(true);
  });

  it('repo sin mapear: reporta failed con instrucción clara y no toca git', async () => {
    const fs = memFs();
    const { exec, calls } = fakeExec(fs);
    const { api, sent } = fakeApi();
    const out = await runJob(job({ repo: 'otra/cosa' }), deps(fs, exec, api), new AbortController().signal);
    expect(out).toBe('failed');
    const failed = sent.find((s) => s.kind === 'failed')!;
    expect(failed.error).toContain('roz-runner repo add otra/cosa');
    expect(calls).toHaveLength(0);
  });

  it('Claude sin PLAN.md o sin commits → failed', async () => {
    const fs = repoFs();
    const { exec } = fakeExec(fs, (c) =>
      c.cmd === 'claude' ? ok(JSON.stringify({ type: 'result', subtype: 'success', result: 'nada' })) : undefined,
    );
    const { api, sent } = fakeApi();
    expect(await runJob(job(), deps(fs, exec, api), new AbortController().signal)).toBe('failed');
    expect(sent.at(-1)).toMatchObject({ kind: 'failed', error: 'Claude Code terminó sin escribir PLAN.md' });

    const fs2 = repoFs();
    const { exec: exec2 } = fakeExec(fs2, (c) => (c.cmd === 'git' && c.args.includes('rev-list') ? ok('0\n') : undefined));
    const api2 = fakeApi();
    expect(await runJob(job({ phase: 'implementar', planMd: 'x' }), deps(fs2, exec2, api2.api), new AbortController().signal)).toBe(
      'failed',
    );
    expect(api2.sent.at(-1)).toMatchObject({ kind: 'failed', error: 'la implementación no produjo ningún commit' });
  });

  it('PR ya existente: la consulta con gh pr view', async () => {
    const fs = repoFs();
    const { exec } = fakeExec(fs, (c) => {
      if (c.cmd !== 'gh') return undefined;
      if (c.args[1] === 'create') return fail('a pull request for branch "hyp-7" already exists');
      return ok(JSON.stringify({ number: 12, url: 'https://github.com/hyperlabs/roz/pull/12' }));
    });
    const { api, sent } = fakeApi();
    expect(await runJob(job({ phase: 'implementar', planMd: 'x' }), deps(fs, exec, api), new AbortController().signal)).toBe('pr_opened');
    expect(sent.at(-1)).toMatchObject({ kind: 'pr_opened', prNumber: 12 });
  });

  it('Ctrl+C (shutdown) durante Claude: regresa el plan a la cola con released', async () => {
    const fs = repoFs();
    const controller = new AbortController();
    const { exec } = fakeExec(fs, (c) => {
      if (c.cmd !== 'claude') return undefined;
      controller.abort(SHUTDOWN);
      return { code: null, stdout: '', stderr: '', aborted: true };
    });
    const { api, sent } = fakeApi();
    expect(await runJob(job(), deps(fs, exec, api), controller.signal)).toBe('released');
    expect(sent.at(-1)!.kind).toBe('released');
  });

  it('stop del latido (cancelado): se detiene sin reportar nada más', async () => {
    const fs = repoFs();
    const controller = new AbortController();
    const { exec } = fakeExec(fs, (c) => {
      if (c.cmd !== 'claude') return undefined;
      controller.abort('stop:cancelado');
      return { code: null, stdout: '', stderr: '', aborted: true };
    });
    const { api, sent } = fakeApi();
    expect(await runJob(job(), deps(fs, exec, api), controller.signal)).toBe('stopped');
    expect(sent.every((s) => s.kind === 'progress')).toBe(true);
  });

  it('lease perdido al reportar: deja de trabajar sin reportar failed', async () => {
    const fs = repoFs();
    const { exec } = fakeExec(fs);
    const { api, sent } = fakeApi({ plan_ready: new RozApiError('lease', 409, 'LEASE_LOST', false) });
    expect(await runJob(job(), deps(fs, exec, api), new AbortController().signal)).toBe('lease_lost');
    expect(sent.some((s) => s.kind === 'failed')).toBe(false);
  });

  it('reusa la rama local de un intento anterior', async () => {
    const fs = repoFs();
    const { exec, calls } = fakeExec(fs, (c) =>
      c.cmd === 'git' && c.args.join(' ').includes('--verify --quiet refs/heads/') ? ok('abc\n') : undefined,
    );
    const { api } = fakeApi();
    await runJob(job({ phase: 'implementar', planMd: 'x' }), deps(fs, exec, api), new AbortController().signal);
    const add = calls.find((c) => c.args.includes('worktree') && c.args.includes('add'))!;
    expect(add.args).toEqual(['-C', REPO, 'worktree', 'add', WT, 'hyp-7-agregar-filtro']);
  });
});
