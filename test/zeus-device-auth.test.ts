// Conectar una PC aprobando en el navegador (`zeus setup`, migración 0044) contra Postgres real
// (PGlite): abrir → aprobar en la web → el poll entrega el token UNA vez; vencida y rechazada no
// entregan nada; el device_code solo vive hasheado y el token entregado autentica de verdad.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createZeusPg, type ZeusPg } from './zeus-pg.js';

const holder = vi.hoisted(() => {
  process.env.ROZ_LOG_LEVEL = 'silent';
  return { pg: null as unknown as { client: unknown } };
});
vi.mock('../src/db/supabase.js', () => ({ db: () => holder.pg.client, dbPublic: () => holder.pg.client }));
vi.mock('../src/notify/push.js', () => ({ pushToDev: vi.fn(), pushBroadcast: vi.fn(), pushToEmail: vi.fn() }));

import { actorForDev, authenticateZeusToken } from '../src/zeus/core.js';
import {
  DEVICE_INTERVAL_SEC,
  decideDeviceRequest,
  getDeviceRequest,
  hashDeviceCode,
  normalizeUserCode,
  pollDeviceAuth,
  resetDeviceRateLimits,
  startDeviceAuth,
} from '../src/zeus/device-auth.js';
import { drainBackground } from '../src/utils/background.js';

let pg: ZeusPg;
const ids = { ana: '', beto: '' };
const BASE = 'https://roz.example.test';
const ip = '203.0.113.7';

async function dev(name: string): Promise<string> {
  const [row] = await pg.sql<{ id: string }>(`insert into roz.dev (name, email) values ($1, $2) returning id`, [name, `${name.toLowerCase()}@hyper.test`]);
  return row!.id;
}
const actor = (id: string) => actorForDev(id, 'web');
const start = (clientName = 'laptop-ana') => startDeviceAuth({ clientName, platform: 'win32', version: '0.3.0' }, { ip, approveBase: BASE });
/** El intervalo se respeta en las pruebas moviendo last_poll_at al pasado (sin esperar de verdad). */
const ageLastPoll = (deviceCode: string) =>
  pg.sql(`update roz.zeus_device_auth set last_poll_at = now() - interval '1 minute' where device_code_hash = $1`, [hashDeviceCode(deviceCode)]);

beforeAll(async () => {
  pg = await createZeusPg();
  holder.pg = pg;
  ids.ana = await dev('Ana');
  ids.beto = await dev('Beto');
});
beforeEach(() => resetDeviceRateLimits());
afterAll(async () => {
  await drainBackground(2000);
});

describe('device auth de zeus setup', () => {
  it('abre una solicitud con código legible y URL de aprobación; el device_code solo vive hasheado', async () => {
    const s = await start();
    expect(s.userCode).toMatch(/^[BCDFGHJKMNPQRSTVWXZ2-9]{4}-[BCDFGHJKMNPQRSTVWXZ2-9]{4}$/);
    expect(s.deviceCode).toMatch(/^zdc_[A-Za-z0-9_-]{43}$/);
    expect(s.verificationUriComplete).toBe(`${BASE}/conectar?code=${s.userCode}`);
    expect(s.expiresIn).toBe(600);
    expect(s.interval).toBe(DEVICE_INTERVAL_SEC);
    const rows = await pg.sql<Record<string, unknown>>(`select * from roz.zeus_device_auth where user_code = $1`, [s.userCode]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(s.deviceCode);
    expect(rows[0]!.device_code_hash).toBe(hashDeviceCode(s.deviceCode));
    expect(rows[0]!.client_ip).toBe(ip);
  });

  it('start → aprobar → el poll entrega el token una vez; el segundo ya no', async () => {
    const s = await start();
    expect((await pollDeviceAuth(s.deviceCode, { ip })).status).toBe('pending');

    // La web lo lee con el código escrito como sea (minúsculas, sin guion).
    const seen = await getDeviceRequest(s.userCode.toLowerCase().replace('-', ' '), await actor(ids.ana));
    expect(seen).toMatchObject({ userCode: s.userCode, clientName: 'laptop-ana', clientPlatform: 'win32', status: 'pending', clientIp: ip });

    const approved = await decideDeviceRequest(s.userCode, 'approve', await actor(ids.ana));
    expect(approved).toMatchObject({ status: 'approved', decidedBy: 'Ana' });

    await ageLastPoll(s.deviceCode);
    const first = await pollDeviceAuth(s.deviceCode, { ip });
    expect(first.status).toBe('approved');
    if (first.status !== 'approved') throw new Error('sin token');
    expect(first.token).toMatch(/^zeus_[A-Za-z0-9_-]{43}$/);
    expect(first.dev).toMatchObject({ id: ids.ana, name: 'Ana' });

    // El token es uno normal: autentica al dev que aprobó y queda con el nombre del equipo.
    const who = await authenticateZeusToken(first.token, 'cli');
    expect(who?.devId).toBe(ids.ana);
    const [tok] = await pg.sql<{ name: string }>(`select name from roz.zeus_token where dev_id = $1 and revoked_at is null`, [ids.ana]);
    expect(tok!.name).toBe('laptop-ana (setup)');
    // En la tabla de la solicitud no queda el token en claro.
    const [row] = await pg.sql<Record<string, unknown>>(`select * from roz.zeus_device_auth where user_code = $1`, [s.userCode]);
    expect(row!.status).toBe('delivered');
    expect(JSON.stringify(row)).not.toContain(first.token);

    const second = await pollDeviceAuth(s.deviceCode, { ip });
    expect(second).toEqual({ status: 'delivered' });
    await expect(decideDeviceRequest(s.userCode, 'approve', await actor(ids.ana))).rejects.toMatchObject({ code: 'ZEUS_DEVICE_DECIDED' });
  });

  it('repetir setup en el mismo equipo reemplaza su token anterior', async () => {
    const s = await start('pc-beto');
    await decideDeviceRequest(s.userCode, 'approve', await actor(ids.beto));
    const a = await pollDeviceAuth(s.deviceCode, { ip });
    const s2 = await start('pc-beto');
    await decideDeviceRequest(s2.userCode, 'approve', await actor(ids.beto));
    const b = await pollDeviceAuth(s2.deviceCode, { ip });
    if (a.status !== 'approved' || b.status !== 'approved') throw new Error('sin token');
    expect(await authenticateZeusToken(a.token, 'cli')).toBeNull();
    expect((await authenticateZeusToken(b.token, 'cli'))?.devId).toBe(ids.beto);
    const live = await pg.sql(`select id from roz.zeus_token where dev_id = $1 and revoked_at is null`, [ids.beto]);
    expect(live).toHaveLength(1);
  });

  it('rechazada: el poll dice denied y no hay token', async () => {
    const s = await start('pc-ajena');
    const denied = await decideDeviceRequest(s.userCode, 'deny', await actor(ids.beto));
    expect(denied.status).toBe('denied');
    expect(await pollDeviceAuth(s.deviceCode, { ip })).toEqual({ status: 'denied' });
    // Una ya decidida no se le muestra a otra persona.
    await expect(getDeviceRequest(s.userCode, await actor(ids.ana))).rejects.toMatchObject({ status: 404 });
  });

  it('vencida: no se aprueba ni se cobra', async () => {
    const s = await start();
    await pg.sql(`update roz.zeus_device_auth set expires_at = now() - interval '1 second' where user_code = $1`, [s.userCode]);
    expect((await getDeviceRequest(s.userCode, await actor(ids.ana))).status).toBe('expired');
    await expect(decideDeviceRequest(s.userCode, 'approve', await actor(ids.ana))).rejects.toMatchObject({ code: 'ZEUS_DEVICE_EXPIRED' });
    expect(await pollDeviceAuth(s.deviceCode, { ip })).toEqual({ status: 'expired' });

    // Aprobada a tiempo pero cobrada tarde: tampoco.
    const late = await start();
    await decideDeviceRequest(late.userCode, 'approve', await actor(ids.ana));
    await pg.sql(`update roz.zeus_device_auth set expires_at = now() - interval '1 second' where user_code = $1`, [late.userCode]);
    expect(await pollDeviceAuth(late.deviceCode, { ip })).toEqual({ status: 'expired' });
  });

  it('device_code desconocido o mal formado no da nada', async () => {
    expect(await pollDeviceAuth(`zdc_${'A'.repeat(43)}`, { ip })).toEqual({ status: 'expired' });
    await expect(pollDeviceAuth('zeus_algo', { ip })).rejects.toMatchObject({ status: 400 });
  });

  it('consultar más rápido que el intervalo pide frenar', async () => {
    const s = await start();
    expect((await pollDeviceAuth(s.deviceCode, { ip })).status).toBe('pending');
    const fast = await pollDeviceAuth(s.deviceCode, { ip });
    expect(fast).toEqual({ status: 'slow_down', interval: DEVICE_INTERVAL_SEC + 5 });
  });

  it('límite de solicitudes por IP', async () => {
    for (let i = 0; i < 10; i++) await startDeviceAuth({ clientName: 'x' }, { ip: '198.51.100.1', approveBase: BASE });
    await expect(startDeviceAuth({ clientName: 'x' }, { ip: '198.51.100.1', approveBase: BASE })).rejects.toMatchObject({ status: 429 });
    // Otra IP no se ve afectada.
    await expect(startDeviceAuth({ clientName: 'x' }, { ip: '198.51.100.2', approveBase: BASE })).resolves.toBeTruthy();
  });

  it('normaliza códigos y descarta los que traen caracteres ambiguos', () => {
    expect(normalizeUserCode('bcdf 2345')).toBe('BCDF-2345');
    expect(normalizeUserCode('BCDF-2345')).toBe('BCDF-2345');
    expect(normalizeUserCode('ABCD-1234')).toBeNull();
    expect(normalizeUserCode('BCD')).toBeNull();
  });
});
