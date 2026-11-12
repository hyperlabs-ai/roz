import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthReport } from '../src/bridge.js';
import { createHealthServer } from '../src/health.js';

let close: (() => void) | null = null;
afterEach(() => close?.());

async function serve(report: HealthReport): Promise<string> {
  const server = createHealthServer(() => report);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('/health', () => {
  it('200 con el estado, sin secretos', async () => {
    const base = await serve({
      code: 200,
      body: { ok: true, status: 'ready', guildId: '1', wsPing: 30, lastEventAt: null, backfill: { pending: 0, done: 3 } },
    });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'ready', backfill: { done: 3 } });
  });

  it('503 si está caído; 404 en otras rutas', async () => {
    const base = await serve({ code: 503, body: { ok: false, status: 'disconnected', lastError: 'x' } });
    expect((await fetch(`${base}/health`)).status).toBe(503);
    expect((await fetch(`${base}/otra`)).status).toBe(404);
  });
});
