// Reenvío de interacciones: roz decide, el puente manda el callback; fallback si roz tarda o falla.
// Todo con fetch simulado: nunca se llama a Discord ni a roz reales.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InteractionForwarder,
  ROZ_TIMEOUT_MS,
  TEXT_DISABLED,
  TEXT_TIMEOUT,
  TEXT_UNAVAILABLE,
  fallbackCallback,
  rozTimeoutMs,
} from '../src/interactions.js';
import { __setLogSink, type LogLevel } from '../src/log.js';
import { snowflakeFromTime } from '../src/snowflake.js';

const GUILD = '100000000000000001';
const TOKEN = 'aW50ZXJhY3Rpb246MTIzNDU2Nzg5OnNlY3JldG8tZGUtbGEtaW50ZXJhY2Npb24';
const SECRET = 'secreto-del-puente-123';
const NOW = Date.parse('2026-11-11T12:00:00Z');

interface Call {
  url: string;
  auth: string | null;
  body: any;
}

let calls: Call[];
let lines: string[];
/** Respuesta de roz por llamada: status + json, o 'hang' (no contesta hasta el abort), o 'error'. */
let rozReply: { status: number; json?: unknown } | 'hang' | 'error';
let discordReply: { status: number; json?: unknown };

function fakeFetch(): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.authorization ?? null, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith('https://roz.test/')) {
      if (rozReply === 'error') throw new Error('ECONNREFUSED');
      if (rozReply === 'hang') {
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      return new Response(JSON.stringify(rozReply.json ?? {}), { status: rozReply.status });
    }
    return new Response(discordReply.json === undefined ? null : JSON.stringify(discordReply.json), { status: discordReply.status });
  }) as unknown as typeof fetch;
}

function make() {
  return new InteractionForwarder({
    rozApiUrl: 'https://roz.test/',
    bridgeSecret: SECRET,
    guildId: GUILD,
    discordApiBase: 'https://discord.test/api/v10',
    fetch: fakeFetch(),
    now: () => NOW,
  });
}

function interaction(type = 2, extra: Record<string, unknown> = {}) {
  return {
    id: snowflakeFromTime(NOW - 100),
    application_id: '400000000000000001',
    type,
    token: TOKEN,
    guild_id: GUILD,
    channel_id: '300000000000000001',
    member: { user: { id: '200000000000000001', username: 'dev' } },
    data: { name: 'roz', options: [{ type: 1, name: 'status' }] },
    ...extra,
  };
}

const discordCalls = () => calls.filter((c) => c.url.startsWith('https://discord.test/'));
const rozCalls = () => calls.filter((c) => c.url.startsWith('https://roz.test/'));

beforeEach(() => {
  calls = [];
  lines = [];
  rozReply = { status: 200, json: { callback: { type: 4, data: { content: 'hola', flags: 64 } } } };
  discordReply = { status: 204 };
  __setLogSink((line: string, _l: LogLevel) => lines.push(line));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('InteractionForwarder', () => {
  it('reenvía el payload crudo a roz con Bearer y manda su callback tal cual a Discord', async () => {
    const f = make();
    const i = interaction();
    const out = await f.process(i);
    expect(out).toEqual({ kind: 'roz', callbackType: 4 });
    expect(rozCalls()).toHaveLength(1);
    expect(rozCalls()[0]).toMatchObject({
      url: 'https://roz.test/v1/internal/discord/interactions',
      auth: `Bearer ${SECRET}`,
      body: { guildId: GUILD, receivedAt: NOW, interaction: i },
    });
    expect(discordCalls()).toHaveLength(1);
    expect(discordCalls()[0]!.url).toBe(`https://discord.test/api/v10/interactions/${i.id}/${TOKEN}/callback`);
    expect(discordCalls()[0]!.auth).toBeNull();
    expect(discordCalls()[0]!.body).toEqual({ type: 4, data: { content: 'hola', flags: 64 } });
    expect(f.getStats()).toMatchObject({ forwarded: 1, fallbacks: 0 });
  });

  it('modales, autocompletado y diferidos pasan sin tocarse', async () => {
    const f = make();
    for (const cb of [
      { type: 9, data: { custom_id: 'roz1:ticket.modal:_', title: 'Nuevo ticket', components: [] } },
      { type: 8, data: { choices: [{ name: 'WAT-44 · Algo', value: 'uuid' }] } },
      { type: 5, data: { flags: 64 } },
      { type: 6 },
    ]) {
      rozReply = { status: 200, json: { callback: cb } };
      await f.process(interaction(cb.type === 8 ? 4 : 2));
      expect(discordCalls().at(-1)!.body).toEqual(cb);
    }
  });

  it('roz tarda más del presupuesto → fallback efímero "no respondió a tiempo"', async () => {
    vi.useFakeTimers();
    rozReply = 'hang';
    const f = make();
    const p = f.process(interaction(2));
    await vi.advanceTimersByTimeAsync(ROZ_TIMEOUT_MS + 10);
    expect(await p).toEqual({ kind: 'fallback', reason: 'timeout', status: null });
    expect(discordCalls()[0]!.body).toEqual({
      type: 4,
      data: { content: TEXT_TIMEOUT, flags: 64, allowed_mentions: { parse: [] } },
    });
  });

  it('autocompletado sin respuesta de roz → choices vacío', async () => {
    rozReply = 'error';
    await make().process(interaction(4));
    expect(discordCalls()[0]!.body).toEqual({ type: 8, data: { choices: [] } });
  });

  it('roz caído, 5xx, 403 o 400 → "roz no está disponible"; 404 → "no tiene activado Discord"', async () => {
    const cases: Array<[typeof rozReply, string, number | null]> = [
      ['error', TEXT_UNAVAILABLE, null],
      [{ status: 502 }, TEXT_UNAVAILABLE, 502],
      [{ status: 403, json: { error: 'forbidden' } }, TEXT_UNAVAILABLE, 403],
      [{ status: 400, json: { error: { code: 'VALIDATION_ERROR' } } }, TEXT_UNAVAILABLE, 400],
      [{ status: 404, json: { error: { code: 'DISCORD_CHAT_DISABLED' } } }, TEXT_DISABLED, 404],
      [{ status: 200, json: { nada: true } }, TEXT_UNAVAILABLE, 200],
    ];
    for (const [reply, text, status] of cases) {
      calls = [];
      rozReply = reply;
      const out = await make().process(interaction(3));
      expect(out).toMatchObject({ kind: 'fallback', status });
      expect(discordCalls()[0]!.body.data.content).toBe(text);
      expect(discordCalls()[0]!.body.data.flags).toBe(64);
    }
  });

  it('nunca reintenta el callback; 40060 (ya reconocida) y 10062 (vencida) solo se loguean', async () => {
    const f = make();
    discordReply = { status: 400, json: { code: 40060, message: 'Interaction has already been acknowledged.' } };
    await f.process(interaction());
    discordReply = { status: 404, json: { code: 10062, message: 'Unknown interaction' } };
    await f.process(interaction());
    expect(discordCalls()).toHaveLength(2);
    expect(f.getStats().callbackErrors).toBe(2);
    expect(lines.some((l) => l.includes('40060'))).toBe(true);
    expect(lines.some((l) => l.includes('10062'))).toBe(true);
  });

  it('ignora payloads sin id/tipo/token sin llamar a nadie', async () => {
    const f = make();
    expect(await f.process({ id: 'x', type: 2 })).toBeNull();
    expect(await f.process(null)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('los logs nunca llevan el token, el secreto ni el contenido', async () => {
    const f = make();
    await f.process(interaction(2, { data: { name: 'roz', options: [{ name: 'buscar', value: 'texto privado' }] } }));
    rozReply = 'error';
    await f.process(interaction(2));
    const all = lines.join('\n');
    expect(all).toContain('interactionId');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('texto privado');
  });

  it('handle() corre en paralelo y close() espera lo que está en vuelo', async () => {
    const f = make();
    f.handle(interaction());
    f.handle(interaction());
    expect(f.getStats().inFlight).toBe(2);
    await f.close(1000);
    expect(f.getStats()).toMatchObject({ inFlight: 0, forwarded: 2 });
    f.handle(interaction());
    expect(f.getStats().inFlight).toBe(0);
  });
});

describe('presupuesto y fallback', () => {
  it('rozTimeoutMs descuenta lo que ya pasó desde el snowflake', () => {
    expect(rozTimeoutMs(snowflakeFromTime(NOW), NOW)).toBe(ROZ_TIMEOUT_MS);
    expect(rozTimeoutMs(snowflakeFromTime(NOW - 1000), NOW)).toBe(1700);
    expect(rozTimeoutMs(snowflakeFromTime(NOW - 2900), NOW)).toBe(250);
    // Reloj no creíble: 2500.
    expect(rozTimeoutMs(snowflakeFromTime(NOW + 5000), NOW)).toBe(ROZ_TIMEOUT_MS);
    expect(rozTimeoutMs(snowflakeFromTime(NOW - 60_000), NOW)).toBe(ROZ_TIMEOUT_MS);
  });

  it('fallbackCallback según el tipo de interacción', () => {
    expect(fallbackCallback(4)).toEqual({ type: 8, data: { choices: [] } });
    for (const t of [2, 3, 5]) {
      expect(fallbackCallback(t)).toMatchObject({ type: 4, data: { content: TEXT_TIMEOUT, flags: 64, allowed_mentions: { parse: [] } } });
    }
    expect(fallbackCallback(2, 'disabled').data!.content).toBe(TEXT_DISABLED);
  });
});
