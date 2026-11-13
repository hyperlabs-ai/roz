// El CLI REAL (cli/src/commands) contra el servidor REAL (rutas /v1/zeus sobre Postgres en memoria).
// Cada lado tiene sus pruebas contra un doble del otro; esta es la que detecta que se desalinearon:
// rutas, nombres de campos, códigos de error y los validadores de los sobres cifrados.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createZeusPg, type ZeusPg } from './zeus-pg.js';
import { machine, type FakeZeus, type Machine } from '../cli/test/helpers.js';
import { envGrant, envInit, envRevoke, envRotate } from '../cli/src/commands/admin.js';
import { whoami } from '../cli/src/commands/auth.js';
import { envLs, envPull, envPush, envRm, envSet } from '../cli/src/commands/env.js';
import { keyInit } from '../cli/src/commands/key.js';
import { run } from '../cli/src/commands/run.js';

const holder = vi.hoisted(() => {
  process.env.ROZ_LOG_LEVEL = 'silent';
  return { pg: null as unknown as { client: unknown } };
});
vi.mock('../src/db/supabase.js', () => ({ db: () => holder.pg.client, dbPublic: () => holder.pg.client }));
vi.mock('../src/notify/push.js', () => ({ pushToDev: vi.fn(), pushBroadcast: vi.fn(), pushToEmail: vi.fn() }));

import app from '../src/app.js';
import { actorForDev } from '../src/zeus/core.js';
import { createToken } from '../src/zeus/inbox.js';
import { drainBackground } from '../src/utils/background.js';

let pg: ZeusPg;
let fer: Machine;
let ana: Machine;
let beto: Machine;
/** Todo cuerpo que el CLI le mandó al servidor, para afirmar que nunca viaja un valor en claro. */
const sent: string[] = [];

const SECRETS = { DATABASE_URL: 'postgres://app:Clave-Muy_Secreta@db.interna:5432/orwel', API_KEY: 'sk_live_9f8e7d "con comillas" y $dolar', MULTILINEA: 'linea uno\nlinea dos' };

// El "zeus" del CLI: en vez de salir a la red, sus requests entran al app de Hono.
const realZeus = {
  fetch: async (url: string, init: RequestInit) => {
    if (typeof init.body === 'string') sent.push(init.body);
    const u = new URL(url);
    return app.request(u.pathname + u.search, init);
  },
} as unknown as FakeZeus;

async function dev(name: string, role: string): Promise<string> {
  const [row] = await pg.sql<{ id: string }>(`insert into roz.dev (name, email, role) values ($1, $2, $3) returning id`, [name, `${name.toLowerCase()}@hyper.test`, role]);
  return row!.id;
}
const tokenFor = async (devId: string) => (await createToken('cli', await actorForDev(devId, 'web'))).token;
const env = (m: Machine, name = '.env') => m.fs.files.get(m.file(name)) ?? null;

beforeAll(async () => {
  pg = await createZeusPg();
  holder.pg = pg;
  await pg.sql(`insert into roz.project (name, key) values ('Orwel', 'ORWEL')`);
  fer = machine(realZeus, await tokenFor(await dev('Fer', 'ceo')), 'pc-fer');
  ana = machine(realZeus, await tokenFor(await dev('Ana', 'dev')), 'laptop-ana');
  beto = machine(realZeus, await tokenFor(await dev('Beto', 'dev')), 'laptop-beto');
});

afterAll(async () => {
  await drainBackground(2000);
  await pg.close();
});

describe('CLI de zeus contra el servidor', () => {
  it('whoami y registro de la llave de cada equipo', async () => {
    expect(await whoami(fer.ctx)).toBe(0);
    expect(fer.printed()).toContain('Fer');
    for (const m of [fer, ana, beto]) expect(await keyInit(m.ctx, [])).toBe(0);
    const keys = await pg.sql<{ name: string; fingerprint: string }>(`select name, fingerprint from roz.zeus_vault_key order by name`);
    expect(keys.map((k) => k.name)).toEqual(['laptop-ana', 'laptop-beto', 'pc-fer']);
    // La huella que el dev lee en voz alta es la misma que guardó el servidor.
    for (const k of keys) expect([fer, ana, beto].some((m) => m.printed().includes(k.fingerprint)), k.name).toBe(true);
    // La privada se quedó en el equipo, con permisos restringidos.
    const keyFile = path.resolve(ana.ctx.home, 'key.json');
    expect(ana.fs.modes.get(keyFile)).toBe(0o600);
    const priv = JSON.parse(ana.fs.files.get(keyFile)!).privateKey as string;
    expect(sent.join('\n')).not.toContain(priv);
  });

  it('un dev sin rol de admin no puede crear el entorno; el admin sí', async () => {
    await expect(envInit(ana.ctx, ['orwel'])).rejects.toThrow();
    expect(await pg.sql(`select 1 from roz.zeus_vault_env`)).toHaveLength(0);
    expect(await envInit(fer.ctx, ['orwel'])).toBe(0);
    expect(await pg.sql(`select name, dek_version from roz.zeus_vault_env`)).toEqual([{ name: 'development', dek_version: 1 }]);
  });

  it('push sube todo cifrado: ni la base ni la red ven un valor', async () => {
    fer.fs.files.set(fer.file('.env'), ['# base de datos', `DATABASE_URL=${SECRETS.DATABASE_URL}`, `API_KEY='${SECRETS.API_KEY}'`, `MULTILINEA="linea uno\\nlinea dos"`, ''].join('\n'));
    expect(await envPush(fer.ctx, ['ORWEL', '--yes'])).toBe(0);
    const rows = await pg.sql<{ name: string; ciphertext: string }>(`select name, ciphertext from roz.zeus_vault_secret order by name`);
    expect(rows.map((r) => r.name)).toEqual(['API_KEY', 'DATABASE_URL', 'MULTILINEA']);
    expect(rows.every((r) => r.ciphertext.startsWith('zs1.'))).toBe(true);
    const everything = JSON.stringify(await pg.sql(`select * from roz.zeus_vault_secret`)) + JSON.stringify(await pg.sql(`select * from roz.zeus_vault_audit`)) + sent.join('\n');
    for (const leak of ['Clave-Muy_Secreta', 'sk_live_9f8e7d', 'linea dos']) expect(everything, leak).not.toContain(leak);
  });

  it('sin acceso no se baja nada; con acceso, el .env queda idéntico a lo que se subió', async () => {
    await expect(envPull(ana.ctx, ['ORWEL', '--yes'])).rejects.toThrow(/acceso/i);
    expect(env(ana)).toBeNull();
    // Ana no puede darse acceso sola.
    await expect(envGrant(ana.ctx, ['ORWEL', '--to', 'Ana', '--yes'])).rejects.toThrow();

    expect(await envGrant(fer.ctx, ['ORWEL', '--to', 'Ana', '--yes'])).toBe(0);
    expect(await envPull(ana.ctx, ['ORWEL', '--yes'])).toBe(0);
    expect(await envPull(ana.ctx, ['ORWEL', '--stdout', '--format', 'json'])).toBe(0);
    expect(JSON.parse(ana.out[ana.out.length - 1]!)).toEqual(SECRETS);
    // Y el archivo .env que escribió se vuelve a leer igual (comillas, $, saltos de línea).
    ana.fs.files.set(ana.file('copia.env'), env(ana)!);
    expect(await envPush(ana.ctx, ['ORWEL', '--from', 'copia.env', '--yes'])).toBe(0);
    expect((await pg.sql<{ v: number }>(`select max(version) as v from roz.zeus_vault_secret`))[0]!.v).toBe(1); // nada cambió: no hubo reescritura
  });

  it('env ls refleja quién tiene acceso', async () => {
    ana.out.length = 0;
    beto.out.length = 0;
    await envLs(ana.ctx);
    await envLs(beto.ctx);
    expect(ana.out.join('\n')).toMatch(/development/);
    expect(ana.out.join('\n')).not.toBe(beto.out.join('\n'));
  });

  it('set y rm de una variable, y el otro equipo las ve al bajar', async () => {
    ana.prompt.secretValue = 'valor-nuevo-de-ana';
    expect(await envSet(ana.ctx, ['ORWEL', 'development', 'FEATURE_FLAG'])).toBe(0);
    expect(await envRm(ana.ctx, ['ORWEL', 'development', 'MULTILINEA', '--yes'])).toBe(0);
    expect(await envPull(fer.ctx, ['ORWEL', '--stdout', '--format', 'json'])).toBe(0);
    expect(JSON.parse(fer.out[fer.out.length - 1]!)).toEqual({ DATABASE_URL: SECRETS.DATABASE_URL, API_KEY: SECRETS.API_KEY, FEATURE_FLAG: 'valor-nuevo-de-ana' });
    expect(sent.join('\n')).not.toContain('valor-nuevo-de-ana');
  });

  it('run inyecta los secretos al proceso sin escribirlos a disco', async () => {
    const before = [...ana.fs.files.keys()].sort();
    expect(await run(ana.ctx, ['ORWEL', '--', 'node', 'server.js'])).toBe(7);
    expect(ana.spawned[0]).toMatchObject({ command: 'node', args: ['server.js'] });
    expect(ana.spawned[0]!.env).toMatchObject({ DATABASE_URL: SECRETS.DATABASE_URL, FEATURE_FLAG: 'valor-nuevo-de-ana' });
    expect([...ana.fs.files.keys()].sort()).toEqual(before);
  });

  it('quitar el acceso y rotar: Ana queda fuera, Fer y Beto leen con la llave nueva', async () => {
    const [anaKey] = await pg.sql<{ id: string }>(`select id from roz.zeus_vault_key where name = 'laptop-ana'`);
    expect(await envGrant(fer.ctx, ['ORWEL', '--to', 'Beto', '--yes'])).toBe(0);
    expect(await envRevoke(fer.ctx, ['ORWEL', '--key', anaKey!.id, '--yes'])).toBe(0);
    expect(fer.printed()).toMatch(/rota/i);
    expect((await pg.sql(`select needs_rotation from roz.zeus_vault_env`))[0]).toEqual({ needs_rotation: true });
    await expect(envPull(ana.ctx, ['ORWEL', '--stdout'])).rejects.toThrow(/acceso/i);

    await expect(envRotate(beto.ctx, ['ORWEL', '--yes'])).rejects.toThrow();
    expect(await envRotate(fer.ctx, ['ORWEL', '--yes'])).toBe(0);
    expect((await pg.sql(`select dek_version, needs_rotation from roz.zeus_vault_env`))[0]).toEqual({ dek_version: 2, needs_rotation: false });
    expect(await pg.sql(`select distinct dek_version from roz.zeus_vault_secret`)).toEqual([{ dek_version: 2 }]);

    expect(await envPull(beto.ctx, ['ORWEL', '--stdout', '--format', 'json'])).toBe(0);
    expect(JSON.parse(beto.out[beto.out.length - 1]!)).toEqual({ DATABASE_URL: SECRETS.DATABASE_URL, API_KEY: SECRETS.API_KEY, FEATURE_FLAG: 'valor-nuevo-de-ana' });
    await expect(envPull(ana.ctx, ['ORWEL', '--stdout'])).rejects.toThrow(/acceso/i);
  });

  it('un push con datos viejos tras la rotación pide bajar de nuevo, sin pisar nada', async () => {
    // Beto bajó con la versión 2; Fer rota otra vez; el push de Beto sigue funcionando porque el CLI
    // siempre relee antes de subir. Lo que NO debe pasar es que algo quede con la llave anterior.
    expect(await envRotate(fer.ctx, ['ORWEL', '--yes'])).toBe(0);
    beto.fs.files.set(beto.file('.env'), `DATABASE_URL=${SECRETS.DATABASE_URL}\nAPI_KEY=otra\nFEATURE_FLAG=valor-nuevo-de-ana\n`);
    expect(await envPush(beto.ctx, ['ORWEL', '--yes'])).toBe(0);
    expect(await pg.sql(`select distinct dek_version from roz.zeus_vault_secret`)).toEqual([{ dek_version: 3 }]);
    expect(await envPull(fer.ctx, ['ORWEL', '--stdout', '--format', 'json'])).toBe(0);
    expect(JSON.parse(fer.out[fer.out.length - 1]!).API_KEY).toBe('otra');
  });
});
