// Ciclo de vida: READY → backfilling → ready, RESUMED sin backfill, desconexión y /health.
import { beforeEach, describe, expect, it } from 'vitest';
import { Bridge, HEALTH_DOWN_GRACE_MS } from '../src/bridge.js';
import { __setLogSink } from '../src/log.js';
import type { DiscordBridgeNotice } from '../src/shared/types.js';
import { FakeGateway, FakeSource, GUILD, msg, textChannel } from './fakes/discord.js';
import { MemoryStore } from './fakes/memory-store.js';

const CH = '300000000000000001';
let store: MemoryStore;
let source: FakeSource;
let gateway: FakeGateway;
let notices: DiscordBridgeNotice[];
let now: number;
let bridge: Bridge;

beforeEach(async () => {
  __setLogSink(() => undefined);
  store = new MemoryStore();
  source = new FakeSource();
  source.channels = [textChannel(CH)];
  source.addMessages(CH, [msg(CH, 1), msg(CH, 2)]);
  gateway = new FakeGateway();
  notices = [];
  now = Date.parse('2026-06-01T00:00:00Z');
  bridge = new Bridge({
    guildId: GUILD,
    version: 'test',
    backfillMessages: 200,
    catchupMaxPages: 5,
    store,
    source,
    gateway,
    notifier: { enqueue: (...n: DiscordBridgeNotice[]) => void notices.push(...n), close: async () => undefined },
    now: () => now,
    heartbeatMs: 60_000,
    retryDelayMs: 0,
  });
  await bridge.start();
});

const statuses = () => notices.filter((n) => n.kind === 'bridge.status').map((n) => (n as { status: string }).status);

describe('Bridge', () => {
  it('arranca en connecting y se loguea', () => {
    expect(gateway.loggedIn).toBe(true);
    expect(store.bridge.get(GUILD)).toMatchObject({ status: 'connecting', bridge_version: 'test' });
    expect(statuses()).toEqual(['connecting']);
  });

  it('READY: backfill completo y luego ready', async () => {
    gateway.dispatch('READY', { session_id: 'x' });
    await bridge.runFullSync();
    await bridge.lane.idle();
    expect(statuses()).toEqual(['connecting', 'backfilling', 'ready']);
    expect(store.aliveIn(CH)).toHaveLength(2);
    expect(store.bridge.get(GUILD)).toMatchObject({ status: 'ready', last_error: null });
    expect(bridge.health()).toMatchObject({ code: 200, body: { ok: true, status: 'ready', wsPing: 42, backfill: { pending: 0, done: 1 } } });
  });

  it('eventos en vivo pasan por el carril y se reflejan', async () => {
    gateway.dispatch('READY', {});
    await bridge.runFullSync();
    const m = msg(CH, 99);
    gateway.dispatch('MESSAGE_CREATE', m);
    await bridge.lane.idle();
    expect(store.messages.get(m.id)).toBeTruthy();
    expect(notices).toContainEqual({ kind: 'message.created', channelId: CH, messageId: m.id });
  });

  it('reintenta una escritura que falla', async () => {
    store.failNext = 1;
    const m = msg(CH, 99);
    gateway.dispatch('MESSAGE_CREATE', m);
    await bridge.lane.idle();
    await new Promise((r) => setTimeout(r, 5));
    expect(store.messages.get(m.id)).toBeTruthy();
  });

  it('desconexión → disconnected; 503 pasados 60 s; RESUMED → ready sin backfill', async () => {
    gateway.dispatch('READY', {});
    await bridge.runFullSync();
    source.calls = [];
    gateway.emit('disconnect', { code: 1006 });
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.getStatus()).toBe('disconnected');
    expect(bridge.health().code).toBe(200);
    now += HEALTH_DOWN_GRACE_MS + 1;
    expect(bridge.health()).toMatchObject({ code: 503, body: { ok: false, status: 'disconnected' } });
    gateway.dispatch('RESUMED', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.getStatus()).toBe('ready');
    expect(bridge.health().code).toBe(200);
    expect(source.calls).toEqual([]);
  });

  it('un READY durante el backfill lo repite al terminar (re-identify)', async () => {
    gateway.dispatch('READY', {});
    gateway.dispatch('READY', {});
    await bridge.runFullSync();
    await new Promise((r) => setTimeout(r, 0));
    expect(source.calls.filter((c) => c === 'guild')).toHaveLength(2);
    expect(bridge.getStatus()).toBe('ready');
  });

  it('stop(): disconnected, cierra el gateway y ya no procesa eventos', async () => {
    await bridge.stop();
    expect(gateway.destroyed).toBe(true);
    expect(store.bridge.get(GUILD)!.status).toBe('disconnected');
    gateway.dispatch('MESSAGE_CREATE', msg(CH, 5));
    await bridge.lane.idle();
    expect(store.messages.size).toBe(0);
  });
});

describe('Bridge: interacciones y registro de comandos', () => {
  function withExtras() {
    const handled: unknown[] = [];
    let syncs = 0;
    let done = false;
    let closed = false;
    const b = new Bridge({
      guildId: GUILD,
      version: 'test',
      backfillMessages: 200,
      catchupMaxPages: 5,
      store,
      source,
      gateway: new FakeGateway(),
      notifier: { enqueue: () => undefined, close: async () => undefined },
      interactions: {
        handle: (d: unknown) => void handled.push(d),
        close: async () => void (closed = true),
        getStats: () => ({ forwarded: handled.length, fallbacks: 0, callbackErrors: 0, inFlight: 0 }),
      },
      commandSync: {
        syncOnce: async () => {
          syncs += 1;
          done = true;
          return { kind: 'disabled' as const };
        },
        isDone: () => done,
      },
      now: () => now,
      heartbeatMs: 60_000,
      retryDelayMs: 0,
    });
    return { b, handled, syncs: () => syncs, closed: () => closed };
  }

  it('INTERACTION_CREATE va directo al reenviador, sin pasar por el carril ni por la base', async () => {
    const { b, handled } = withExtras();
    let laneRuns = 0;
    const run = b.lane.run.bind(b.lane);
    b.lane.run = ((fn: () => Promise<unknown>) => {
      laneRuns += 1;
      return run(fn);
    }) as typeof b.lane.run;
    const payload = { id: '1', type: 2, token: 't' };
    b.onDispatch('INTERACTION_CREATE', payload);
    expect(handled).toEqual([payload]);
    expect(laneRuns).toBe(0);
    expect(b.health().body).toMatchObject({ interactions: { forwarded: 1 } });
  });

  it('el primer READY pide el registro de comandos; los siguientes no', async () => {
    const { b, syncs } = withExtras();
    b.onDispatch('READY', {});
    await b.runFullSync();
    b.onDispatch('READY', {});
    await b.runFullSync();
    expect(syncs()).toBe(1);
  });

  it('stop() espera las interacciones en vuelo', async () => {
    const { b, closed } = withExtras();
    await b.stop();
    expect(closed()).toBe(true);
  });
});
