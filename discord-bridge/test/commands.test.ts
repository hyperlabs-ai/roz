// Registro de comandos: el puente le pide a roz el sync (roz compara el hash y decide), con reintentos
// al arrancar y el script `npm run register-commands`. fetch simulado: nunca roz ni Discord reales.
import { beforeEach, describe, expect, it } from 'vitest';
import { CommandSync } from '../src/commands.js';
import { __setLogSink } from '../src/log.js';
import { runRegisterCommands } from '../src/register-commands.js';

const SECRET = 'secreto-del-puente-123';
let calls: Array<{ url: string; method: string; auth: string | null }>;
let replies: Array<{ status: number; json?: unknown } | 'error'>;

const OK = (changed: boolean, dryRun = false) => ({
  status: 200,
  json: { ok: true, changed, dryRun, hash: 'a'.repeat(64), remoteHash: (changed ? 'b' : 'a').repeat(64), count: 4 },
});

function fakeFetch(): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: String(init.method), auth: headers.authorization ?? null });
    const r = replies.length ? replies.shift()! : OK(false);
    if (r === 'error') throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
}

function make(over: Partial<ConstructorParameters<typeof CommandSync>[0]> = {}) {
  return new CommandSync({ rozApiUrl: 'https://roz.test/', bridgeSecret: SECRET, fetch: fakeFetch(), sleep: async () => undefined, ...over });
}

beforeEach(() => {
  calls = [];
  replies = [];
  __setLogSink(() => undefined);
});

describe('CommandSync', () => {
  it('POST /v1/internal/discord/commands/sync con Bearer; ?force=1 y ?dryRun=1', async () => {
    const s = make();
    replies = [OK(true)];
    expect(await s.attempt()).toMatchObject({ kind: 'ok', result: { changed: true, count: 4 } });
    await s.attempt({ force: true });
    await s.attempt({ dryRun: true });
    expect(calls.map((c) => c.url)).toEqual([
      'https://roz.test/v1/internal/discord/commands/sync',
      'https://roz.test/v1/internal/discord/commands/sync?force=1',
      'https://roz.test/v1/internal/discord/commands/sync?dryRun=1',
    ]);
    expect(calls.every((c) => c.method === 'POST' && c.auth === `Bearer ${SECRET}`)).toBe(true);
  });

  it('clasifica las respuestas de roz', async () => {
    const s = make();
    replies = [
      { status: 404, json: { error: { code: 'DISCORD_CHAT_DISABLED' } } },
      { status: 403, json: { error: 'forbidden' } },
      { status: 503, json: { error: { code: 'DISCORD_NOT_CONFIGURED' } } },
      { status: 502, json: { error: { code: 'DISCORD_COMMANDS_SYNC_FAILED' } } },
      'error',
    ];
    expect(await s.attempt()).toEqual({ kind: 'disabled' });
    expect(await s.attempt()).toEqual({ kind: 'rejected', status: 403, code: null });
    expect(await s.attempt()).toEqual({ kind: 'rejected', status: 503, code: 'DISCORD_NOT_CONFIGURED' });
    expect(await s.attempt()).toEqual({ kind: 'retry', status: 502, code: 'DISCORD_COMMANDS_SYNC_FAILED' });
    expect(await s.attempt()).toEqual({ kind: 'retry', status: null, code: null });
  });

  it('syncOnce: reintenta 3 veces con backoff y luego se queda quieto', async () => {
    const waits: number[] = [];
    const s = make({ sleep: async (ms) => void waits.push(ms), backoffMs: 100 });
    replies = ['error', { status: 500 }, OK(true)];
    expect(await s.syncOnce()).toMatchObject({ kind: 'ok' });
    expect(waits).toEqual([100, 200]);
    expect(s.isDone()).toBe(true);
    await s.syncOnce();
    expect(calls).toHaveLength(3);
  });

  it('syncOnce: agotados los reintentos, permite intentar de nuevo en el próximo READY', async () => {
    const s = make();
    replies = Array(4).fill('error');
    expect(await s.syncOnce()).toMatchObject({ kind: 'retry' });
    expect(calls).toHaveLength(4);
    expect(s.isDone()).toBe(false);
    replies = [OK(false)];
    expect(await s.syncOnce()).toMatchObject({ kind: 'ok' });
    expect(s.isDone()).toBe(true);
  });

  it('syncOnce: un rechazo (403/503) no se reintenta', async () => {
    const s = make();
    replies = [{ status: 403 }];
    expect(await s.syncOnce()).toMatchObject({ kind: 'rejected', status: 403 });
    expect(calls).toHaveLength(1);
  });
});

describe('npm run register-commands', () => {
  const env = { ROZ_API_URL: 'https://roz.test', ROZ_BRIDGE_SECRET: SECRET };
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  }

  it('registra si cambió; --check no escribe; --force fuerza', async () => {
    let r = io();
    replies = [OK(true)];
    expect(await runRegisterCommands([], env, r.io, fakeFetch())).toBe(0);
    expect(r.out.join('\n')).toContain('Registrados 4 comandos');
    r = io();
    replies = [OK(false)];
    expect(await runRegisterCommands([], env, r.io, fakeFetch())).toBe(0);
    expect(r.out.join('\n')).toContain('Sin cambios');
    r = io();
    replies = [OK(true, true)];
    expect(await runRegisterCommands(['--check'], env, r.io, fakeFetch())).toBe(0);
    expect(r.out.join('\n')).toContain('Cambiaría');
    await runRegisterCommands(['--force'], env, io().io, fakeFetch());
    expect(calls.map((c) => c.url.split('sync')[1])).toEqual(['', '', '?dryRun=1', '?force=1']);
  });

  it('falla con código 1 y mensaje claro, sin el secreto', async () => {
    let r = io();
    expect(await runRegisterCommands([], {}, r.io, fakeFetch())).toBe(1);
    expect(r.err[0]).toContain('ROZ_API_URL');
    r = io();
    replies = [{ status: 403 }];
    expect(await runRegisterCommands([], env, r.io, fakeFetch())).toBe(1);
    expect(r.err[0]).toContain('403');
    expect(r.err.join('')).not.toContain(SECRET);
    r = io();
    replies = [{ status: 404 }];
    expect(await runRegisterCommands([], env, r.io, fakeFetch())).toBe(1);
    expect(r.err[0]).toContain('ROZ_DISCORD_CHAT');
  });
});
