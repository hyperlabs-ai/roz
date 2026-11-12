import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setLogSink } from '../src/log.js';
import { Notifier, noticeKey } from '../src/notifier.js';
import type { DiscordBridgeEventsBody } from '../src/shared/types.js';

const GUILD = '100000000000000001';
let calls: Array<{ url: string; auth: string | null; body: DiscordBridgeEventsBody }>;
let statuses: number[];

function fakeFetch(): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, auth: headers.authorization ?? null, body: JSON.parse(String(init.body)) });
    const status = statuses.length ? statuses.shift()! : 200;
    if (status === 0) throw new Error('ECONNREFUSED');
    return new Response(status === 200 ? JSON.stringify({ ok: true, processed: 1, skipped: 0 }) : '{}', { status });
  }) as unknown as typeof fetch;
}

function make(over: Partial<ConstructorParameters<typeof Notifier>[0]> = {}) {
  return new Notifier({ rozApiUrl: 'https://roz.test', bridgeSecret: 'secreto-del-puente', guildId: GUILD, fetch: fakeFetch(), ...over });
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  statuses = [];
  __setLogSink(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

const created = (i: number) => ({ kind: 'message.created' as const, channelId: 'c', messageId: String(i) });

describe('Notifier', () => {
  it('agrupa en una ventana de 250 ms, con Bearer y guildId', async () => {
    const n = make();
    n.enqueue(created(1));
    n.enqueue(created(2), { kind: 'bridge.status', status: 'ready' });
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://roz.test/v1/internal/discord/events');
    expect(calls[0]!.auth).toBe('Bearer secreto-del-puente');
    expect(calls[0]!.body).toEqual({ guildId: GUILD, notices: [created(1), created(2), { kind: 'bridge.status', status: 'ready' }] });
  });

  it('manda de inmediato al llegar a 100 y parte en lotes de 100', async () => {
    const n = make();
    n.enqueue(...Array.from({ length: 150 }, (_, i) => created(i)));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.body.notices.length)).toEqual([100, 50]);
  });

  it('quita avisos repetidos que esperan en cola', async () => {
    const n = make();
    n.enqueue(created(1), created(1), { kind: 'message.deleted', channelId: 'c', messageIds: ['2', '1'] });
    n.enqueue({ kind: 'message.deleted', channelId: 'c', messageIds: ['1', '2'] });
    await vi.advanceTimersByTimeAsync(250);
    expect(calls[0]!.body.notices).toHaveLength(2);
  });

  it('reintenta con backoff ante 5xx, red caída o 403', async () => {
    statuses = [500, 0, 403, 200];
    const n = make();
    n.enqueue(created(1));
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls).toHaveLength(4);
    expect(n.getStats()).toMatchObject({ sent: 1, pending: 0 });
  });

  it('404 (flag apagado): descarta todo y no vuelve a avisar', async () => {
    statuses = [404];
    const n = make();
    n.enqueue(created(1), created(2));
    await vi.advanceTimersByTimeAsync(250);
    n.enqueue(created(3));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(n.getStats()).toMatchObject({ disabled: true, dropped: 2, pending: 0 });
  });

  it('400: descarta el lote sin atascar la cola', async () => {
    statuses = [400];
    const n = make();
    n.enqueue(created(1));
    await vi.advanceTimersByTimeAsync(250);
    n.enqueue(created(2));
    await vi.advanceTimersByTimeAsync(250);
    expect(calls.map((c) => c.body.notices[0])).toEqual([created(1), created(2)]);
  });

  it('descarta lo que lleva más de 5 min sin entregarse', async () => {
    statuses = Array(100).fill(500);
    let now = 0;
    const n = make({ now: () => now });
    n.enqueue(created(1));
    now = 6 * 60_000;
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toHaveLength(0);
    expect(n.getStats()).toMatchObject({ dropped: 1, pending: 0 });
  });

  it('close() manda lo pendiente', async () => {
    const n = make();
    n.enqueue(created(1));
    await n.close(1000);
    expect(calls).toHaveLength(1);
    n.enqueue(created(2));
    expect(n.getStats().pending).toBe(0);
  });

  it('noticeKey ignora el orden de ids', () => {
    expect(noticeKey({ kind: 'structure.changed', scope: 'channels', channelIds: ['2', '1'] })).toBe(
      noticeKey({ kind: 'structure.changed', scope: 'channels', channelIds: ['1', '2'] }),
    );
  });
});
