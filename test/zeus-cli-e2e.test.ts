// El CLI REAL (cli/src/commands) contra el servidor REAL (rutas /v1/zeus sobre Postgres en memoria).
// Cada lado tiene sus pruebas contra un doble del otro; esta es la que detecta que se desalinearon:
// rutas, nombres de campos, códigos de error y los validadores de los sobres cifrados.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createZeusPg, type ZeusPg } from './zeus-pg.js';
import { machine, type FakeZeus, type Machine } from '../cli/test/helpers.js';
import { envGrant, envInit, envRevoke, envRotate } from '../cli/src/commands/admin.js';
import { whoami } from '../cli/src/commands/auth.js';
import { doctorReport } from '../cli/src/commands/doctor.js';
import { envHistory, envLs, envPull, envPush, envRestore, envRm, envSet, envStatus } from '../cli/src/commands/env.js';
import { keyInit, keyRotate } from '../cli/src/commands/key.js';
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
import { envHistoryMeta } from '../src/zeus/vault.js';
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

  it('cualquier dev crea un entorno (sin ser admin); el mismo entorno no se crea dos veces', async () => {
    expect(await envInit(fer.ctx, ['orwel'])).toBe(0);
    expect(await pg.sql(`select name, dek_version from roz.zeus_vault_env`)).toEqual([{ name: 'development', dek_version: 1 }]);
    await expect(envInit(ana.ctx, ['orwel'])).rejects.toThrow(/ya existe/);
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

    // Rota quien tiene acceso; Ana ya no lo tiene.
    await expect(envRotate(ana.ctx, ['ORWEL', '--yes'])).rejects.toThrow(/acceso/i);
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

// ---------------------------------------------------------------- historial, avisos y flujo con Claude

async function mcpCall(token: string, method: string, params: unknown = {}): Promise<any> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}
async function tool(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const out = await mcpCall(token, 'tools/call', { name, arguments: args });
  const text = out.result.content[0].text as string;
  if (out.result.isError) throw new Error(text);
  return JSON.parse(text);
}
const devId = async (name: string) => (await pg.sql<{ id: string }>(`select id from roz.dev where name = $1`, [name]))[0]!.id;

describe('historial y avisos de la bóveda (CLI real contra servidor real)', () => {
  it('cada cambio deja la versión anterior (cifrada) y le avisa a los demás con acceso, solo con nombres', async () => {
    await drainBackground(2000);
    await pg.sql(`delete from roz.zeus_message`);
    beto.io.clipboard = 'sk_live_rotada_por_beto_7777';
    expect(await envSet(beto.ctx, ['ORWEL', 'dev', 'API_KEY', '--from-clipboard'])).toBe(0);

    const revs = await pg.sql<{ name: string; version: number; ciphertext: string }>(`select name, version, ciphertext from roz.zeus_vault_secret_revision where name = 'API_KEY' order by version`);
    expect(revs.length).toBeGreaterThan(0);
    expect(revs.every((r) => r.ciphertext.startsWith('zs1.'))).toBe(true);

    const notices = await pg.sql<{ kind: string; subject: string; body: string; to_dev_id: string }>(`select kind, subject, body, to_dev_id from roz.zeus_message`);
    expect(notices).toHaveLength(1); // solo Fer: Beto hizo el cambio y Ana ya no tiene acceso
    expect(notices[0]).toMatchObject({ kind: 'env_change', to_dev_id: await devId('Fer') });
    expect(notices[0]!.subject).toMatch(/Beto cambió 1 variable de ORWEL \(Local\)/);
    expect(notices[0]!.body).toMatch(/Cambiaron: API_KEY/);
    expect(JSON.stringify(notices)).not.toContain('rotada_por_beto');
  });

  it('history y restore desde el CLI; rotar re-cifra el historial y lo deja usable', async () => {
    fer.out.length = 0;
    expect(await envHistory(fer.ctx, ['ORWEL', 'development', 'API_KEY', '--json'])).toBe(0);
    const rows = JSON.parse(fer.out.at(-1)!) as Array<{ version: number; current: boolean; setBy: string | null; readable: boolean }>;
    expect(rows[0]).toMatchObject({ current: true, setBy: 'Beto' });
    const previous = rows.find((r) => !r.current && r.readable)!;
    expect(previous).toBeTruthy();

    expect(await envRotate(fer.ctx, ['ORWEL', '--yes'])).toBe(0);
    const env = (await pg.sql<{ dek_version: number }>(`select dek_version from roz.zeus_vault_env`))[0]!;
    const stale = await pg.sql(`select 1 from roz.zeus_vault_secret_revision where ciphertext is not null and dek_version <> $1`, [env.dek_version]);
    expect(stale).toHaveLength(0);

    // Lo que ve el dashboard tras rotar: el historial sigue restaurable y sin texto cifrado.
    const meta = await envHistoryMeta('ORWEL', 'development', 'API_KEY');
    expect(meta.revisions.find((r) => r.version === previous.version)).toMatchObject({ current: false, deleted: false, readable: true });
    expect(meta.revisions[0]).toMatchObject({ current: true, setByName: 'Fer' });
    expect(JSON.stringify(meta)).not.toContain('zs1.');

    expect(await envRestore(fer.ctx, ['ORWEL', 'development', 'API_KEY', '--version', String(previous.version), '--yes'])).toBe(0);
    expect(await envPull(beto.ctx, ['ORWEL', '--stdout', '--format', 'json'])).toBe(0);
    expect(JSON.parse(beto.out.at(-1)!).API_KEY).toBe('otra');
  });

  it('status compara el .env con la bóveda sin mostrar valores', async () => {
    expect(await envPull(beto.ctx, ['ORWEL', '--yes'])).toBe(0);
    fer.io.clipboard = 'nuevo-valor-de-fer-424242';
    expect(await envSet(fer.ctx, ['ORWEL', 'dev', 'NUEVA_DE_FER', '--from-clipboard'])).toBe(0);
    beto.out.length = 0;
    expect(await envStatus(beto.ctx, ['--json'])).toBe(0);
    const [s] = JSON.parse(beto.out.at(-1)!);
    expect(s.missing).toMatchObject([{ name: 'NUEVA_DE_FER', by: 'Fer' }]);
    expect(beto.out.join('\n')).not.toContain('nuevo-valor-de-fer');
  });

  it('key rotate: llave nueva, mismos accesos, la vieja revocada', async () => {
    const before = await pg.sql<{ id: string }>(`select id from roz.zeus_vault_key where name = 'laptop-beto' and revoked_at is null`);
    expect(await keyRotate(beto.ctx, ['--yes'])).toBe(0);
    const keys = await pg.sql<{ id: string; revoked: boolean }>(`select id, revoked_at is not null as revoked from roz.zeus_vault_key where name = 'laptop-beto' order by created_at`);
    expect(keys.find((k) => k.id === before[0]!.id)?.revoked).toBe(true);
    expect(keys.filter((k) => !k.revoked)).toHaveLength(1);
    expect(await envPull(beto.ctx, ['ORWEL', '--stdout', '--format', 'json'])).toBe(0);
    expect(JSON.parse(beto.out.at(-1)!).NUEVA_DE_FER).toBe('nuevo-valor-de-fer-424242');
  });
});

describe('Claude con zeus: instrucciones, encargos y planes compartidos', () => {
  let ferToken: string;
  let betoToken: string;
  beforeAll(async () => {
    ferToken = await tokenFor(await devId('Fer'));
    betoToken = await tokenFor(await devId('Beto'));
  });

  it('el MCP trae instrucciones (hacen de skill sin instalar nada) y prompts', async () => {
    const init = await mcpCall(betoToken, 'initialize', {});
    expect(init.result.capabilities).toMatchObject({ tools: {}, prompts: {} });
    expect(init.result.instructions).toMatch(/--from-clipboard/);
    expect(init.result.instructions).toMatch(/zeus_share_plan/);
    const list = await mcpCall(betoToken, 'prompts/list');
    expect(list.result.prompts.map((p: { name: string }) => p.name)).toEqual(['pendientes', 'compartir-plan', 'variables']);
    const got = await mcpCall(betoToken, 'prompts/get', { name: 'compartir-plan', arguments: { para: 'Ana' } });
    expect(got.result.messages[0].content.text).toMatch(/Comparte con Ana/);
  });

  it('un encargo queda pendiente en la bandeja de quien lo recibe hasta que lo cierra', async () => {
    await expect(tool(ferToken, 'zeus_send_message', { to: 'Beto', kind: 'task', body: 'Sin título no' })).rejects.toThrow(/título/);
    const sent = await tool(ferToken, 'zeus_send_message', { to: 'Beto', kind: 'task', subject: 'Implementar webhook de pagos', body: 'Usa la cola de outbox, no llames a Stripe en línea.', projectKey: 'ORWEL' });
    expect(sent).toMatchObject({ kind: 'task', status: 'pending' });
    const inbox = await tool(betoToken, 'zeus_inbox', {});
    expect(inbox.open).toMatchObject([{ id: sent.id, kind: 'task', from: 'Fer', subject: 'Implementar webhook de pagos', status: 'pending', project: 'ORWEL' }]);
    expect((await tool(ferToken, 'zeus_inbox', {})).waiting).toMatchObject([{ id: sent.id, to: 'Beto', status: 'pending' }]);

    await expect(tool(ferToken, 'zeus_respond', { id: sent.id, status: 'done' })).rejects.toThrow(/no puedes/);
    expect(await tool(betoToken, 'zeus_respond', { id: sent.id, status: 'accepted' })).toMatchObject({ status: 'accepted' });
    expect(await tool(betoToken, 'zeus_respond', { id: sent.id, status: 'done', note: 'Listo en el PR #40' })).toMatchObject({ status: 'done' });
    expect((await tool(betoToken, 'zeus_inbox', {})).open).toEqual([]);
    const ferInbox = await tool(ferToken, 'zeus_inbox', {});
    expect(ferInbox.messages.map((m: { subject: string }) => m.subject)).toContain('Beto terminó tu encargo');
  });

  it('un plan compartido: pedir ajustes, mandar la versión ajustada, aceptarlo', async () => {
    const v1 = await tool(ferToken, 'zeus_share_plan', { to: 'Beto', title: 'Migrar pagos a Stripe v2', plan: '# Plan\n1. Cambiar SDK\n2. Probar webhooks', projectKey: 'ORWEL' });
    const pending = (await tool(betoToken, 'zeus_inbox', {})).open.find((m: { id: string }) => m.id === v1.id);
    expect(pending).toMatchObject({ kind: 'plan', status: 'pending', subject: 'Migrar pagos a Stripe v2' });

    await expect(tool(betoToken, 'zeus_respond', { id: v1.id, status: 'changes_requested' })).rejects.toThrow(/qué ajustes/);
    await tool(betoToken, 'zeus_respond', { id: v1.id, status: 'changes_requested', note: 'Falta el rollback' });
    const ferInbox = await tool(ferToken, 'zeus_inbox', {});
    const notice = ferInbox.messages.find((m: { subject: string }) => /pidió ajustes/.test(m.subject));
    expect(notice.body).toMatch(/Falta el rollback/);
    expect(notice.body).toContain(`revises="${v1.id}"`);

    const v2 = await tool(ferToken, 'zeus_share_plan', { to: 'Beto', title: 'Migrar pagos a Stripe v2', plan: '# Plan\n1. Cambiar SDK\n2. Probar webhooks\n3. Rollback: feature flag', revises: v1.id });
    expect(v2.revises).toBe(v1.id);
    const full = await tool(betoToken, 'zeus_get_message', { id: v2.id });
    expect(full).toMatchObject({ status: 'pending', projectKey: 'ORWEL' });
    expect(full.history.map((h: { id: string; status: string }) => [h.id, h.status])).toEqual([[v1.id, 'superseded']]);
    const open = (await tool(betoToken, 'zeus_inbox', {})).open.map((m: { id: string }) => m.id);
    expect(open).toContain(v2.id);
    expect(open).not.toContain(v1.id);
    expect(await tool(betoToken, 'zeus_respond', { id: v2.id, status: 'accepted' })).toMatchObject({ status: 'accepted' });
    // Otra persona no puede leerlo.
    const anaToken = await tokenFor(await devId('Ana'));
    await expect(tool(anaToken, 'zeus_get_message', { id: v2.id })).rejects.toThrow(/no es tuyo/);
  });

  it('doctor (y el inicio de sesión de Claude) resume pendientes y avisos', async () => {
    const lines = (await doctorReport(beto.ctx, { brief: true })).join('\n');
    expect(lines).toMatch(/\[plan · accepted\] Migrar pagos a Stripe v2 — de Fer/);
  });
});

// ---------------------------------------------------------------- dar acceso desde la web

describe('acceso aprobado en la web y cifrado con `zeus env grant --pending`', () => {
  it('doctor avisa sin cifrar; el CLI muestra la huella, respeta un "no" y cifra con un "sí"', async () => {
    const { createGrantIntent } = await import('../src/zeus/vault.js');
    const [envRow] = await pg.sql<{ id: string }>(`select id from roz.zeus_vault_env where name = 'development'`);
    const anaId = await devId('Ana');
    await pg.sql(`delete from roz.zeus_message where to_dev_id = $1`, [anaId]);
    await expect(envPull(ana.ctx, ['ORWEL', '--stdout'])).rejects.toThrow(/acceso/i);
    // Fer (con acceso) aprueba en la web; nada se cifra todavía.
    await createGrantIntent({ envId: envRow!.id, toDevId: anaId }, await actorForDev(await devId('Fer'), 'web'));
    const grantsBefore = await pg.sql(`select key_id from roz.zeus_vault_grant`);

    // doctor solo avisa, y solo a quien puede cifrarlo.
    expect((await doctorReport(fer.ctx, { brief: true })).join('\n')).toContain('1 acceso(s) aprobado(s) por cifrar: `zeus env grant --pending`');
    expect((await doctorReport(ana.ctx, { brief: true })).join('\n')).not.toContain('por cifrar');
    expect(await pg.sql(`select key_id from roz.zeus_vault_grant`)).toEqual(grantsBefore);

    // Sin terminal y sin --yes no cifra nada.
    fer.prompt.interactive = false;
    await expect(envGrant(fer.ctx, ['--pending'])).rejects.toThrow(/terminal/);
    fer.prompt.interactive = true;
    // --pending no se mezcla con --to.
    await expect(envGrant(fer.ctx, ['--pending', '--to', 'Ana'])).rejects.toThrow(/uso/);

    // "No": la aprobación sigue abierta y Ana sigue fuera.
    fer.log.length = 0;
    fer.prompt.answers = [false];
    expect(await envGrant(fer.ctx, ['--pending'])).toBe(0);
    const [anaKey] = await pg.sql<{ id: string; fingerprint: string }>(`select id, fingerprint from roz.zeus_vault_key where name = 'laptop-ana' and revoked_at is null`);
    expect(fer.log.join('\n')).toContain(`huella ${anaKey!.fingerprint}`);
    expect(fer.prompt.questions.at(-1)).toMatch(/canal distinto a zeus/);
    expect(await pg.sql(`select fulfilled_at from roz.zeus_vault_grant_intent where cancelled_at is null`)).toEqual([{ fulfilled_at: null }]);
    await expect(envPull(ana.ctx, ['ORWEL', '--stdout'])).rejects.toThrow(/acceso/i);

    // "Sí": se envuelve la DEK para el equipo de Ana, la aprobación se cierra y le llega el aviso.
    fer.prompt.answers = [true];
    expect(await envGrant(fer.ctx, ['--pending'])).toBe(0);
    expect(await envPull(ana.ctx, ['ORWEL', '--stdout', '--format', 'json'])).toBe(0);
    expect(JSON.parse(ana.out[ana.out.length - 1]!)).toHaveProperty('DATABASE_URL', SECRETS.DATABASE_URL);
    expect((await pg.sql<{ fulfilled_at: string | null }>(`select fulfilled_at from roz.zeus_vault_grant_intent`))[0]!.fulfilled_at).toBeTruthy();
    expect((await pg.sql<{ subject: string }>(`select subject from roz.zeus_message where to_dev_id = $1`, [anaId])).map((m) => m.subject)).toContain('Ya tienes acceso a ORWEL (Local)');
    // Ya no queda nada por cifrar.
    fer.out.length = 0;
    expect(await envGrant(fer.ctx, ['--pending'])).toBe(0);
    expect(fer.out.join('\n')).toMatch(/no hay accesos aprobados/);
  });
});
