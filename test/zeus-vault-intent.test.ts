// Dar acceso desde la web: "aprobar en la web, cifrar en el CLI" (migración 0043). La web solo
// registra la decisión; el acceso de verdad lo da un CLI con acceso al envolver la DEK. Aquí se
// prueba el lado del servidor contra Postgres real (PGlite): quién puede aprobar, que no se dupliquen,
// que se cumplan al dar acceso y que la bandeja del destinatario reciba el aviso.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createZeusPg, type ZeusPg } from './zeus-pg.js';
import { generateDek, generateDeviceKey, wrapAad, wrapDek } from '../cli/src/crypto.js';

const holder = vi.hoisted(() => {
  process.env.ROZ_LOG_LEVEL = 'silent';
  return { pg: null as unknown as { client: unknown } };
});
vi.mock('../src/db/supabase.js', () => ({ db: () => holder.pg.client, dbPublic: () => holder.pg.client }));
vi.mock('../src/notify/push.js', () => ({ pushToDev: vi.fn(), pushBroadcast: vi.fn(), pushToEmail: vi.fn() }));

import { actorForDev } from '../src/zeus/core.js';
import {
  cancelGrantIntent,
  createEnv,
  createGrantIntent,
  grantAccess,
  listGrantIntentsForCli,
  registerKey,
  revokeKey,
  vaultOverview,
} from '../src/zeus/vault.js';
import { drainBackground } from '../src/utils/background.js';

let pg: ZeusPg;
const P = 'HUB';
const E = 'api-hyperhub-production';
const dek = generateDek();
const ids = { fer: '', ana: '', beto: '', caro: '' };
const keys = { fer: generateDeviceKey(), ana: generateDeviceKey(), anaDesk: generateDeviceKey(), beto: generateDeviceKey() };
const keyIds = { fer: '', ana: '', anaDesk: '', beto: '' };
let envId = '';

async function dev(name: string, role = 'dev'): Promise<string> {
  const [row] = await pg.sql<{ id: string }>(`insert into roz.dev (name, email, role) values ($1, $2, $3) returning id`, [name, `${name.toLowerCase()}@hyper.test`, role]);
  return row!.id;
}
const actor = (id: string) => actorForDev(id, 'web');
const wrapFor = (publicKey: string) => wrapDek(dek, publicKey, wrapAad(P, E, 1));

beforeAll(async () => {
  pg = await createZeusPg();
  holder.pg = pg;
  await pg.sql(`insert into roz.project (name, key) values ('HyperHub', 'HUB')`);
  ids.fer = await dev('Fer', 'ceo');
  ids.ana = await dev('Ana');
  ids.beto = await dev('Beto');
  ids.caro = await dev('Caro');
  keyIds.fer = (await registerKey({ name: 'pc-fer', publicKey: keys.fer.publicKey }, await actor(ids.fer))).id;
  keyIds.ana = (await registerKey({ name: 'laptop-ana', publicKey: keys.ana.publicKey }, await actor(ids.ana))).id;
  keyIds.beto = (await registerKey({ name: 'laptop-beto', publicKey: keys.beto.publicKey }, await actor(ids.beto))).id;
  envId = (await createEnv({ projectKey: P, env: E, keyId: keyIds.fer, wrappedDek: wrapFor(keys.fer.publicKey) }, await actor(ids.fer))).envId;
});

afterAll(async () => {
  await drainBackground(2000);
  await pg.close();
});

describe('accesos aprobados en la web (zeus_vault_grant_intent)', () => {
  it('solo quien tiene acceso vigente al entorno puede aprobar', async () => {
    // Beto no tiene acceso: no puede aprobarse ni aprobar a otro.
    await expect(createGrantIntent({ envId, toDevId: ids.ana }, await actor(ids.beto))).rejects.toMatchObject({ code: 'ZEUS_VAULT_NO_ACCESS', status: 403 });
    await expect(createGrantIntent({ envId, toDevId: ids.beto }, await actor(ids.beto))).rejects.toMatchObject({ code: 'ZEUS_VAULT_NO_ACCESS' });
    expect(await pg.sql(`select id from roz.zeus_vault_grant_intent`)).toEqual([]);
  });

  it('rechaza a quien no tiene llave registrada o ya tiene acceso en todos sus equipos', async () => {
    const fer = await actor(ids.fer);
    await expect(createGrantIntent({ envId, toDevId: ids.caro }, fer)).rejects.toMatchObject({ code: 'ZEUS_VAULT_NO_KEY', message: expect.stringContaining('zeus key init') });
    await expect(createGrantIntent({ envId, toDevId: ids.fer }, fer)).rejects.toMatchObject({ code: 'ZEUS_VAULT_ALREADY_GRANTED' });
    await expect(createGrantIntent({ envId, toDevId: 'no-es-uuid' }, fer)).rejects.toMatchObject({ status: 400 });
  });

  it('aprobar dos veces no duplica (también por proyecto + nombre del entorno)', async () => {
    const fer = await actor(ids.fer);
    const a = await createGrantIntent({ envId, toDevId: ids.ana }, fer);
    expect(a).toMatchObject({ envId, toDevId: ids.ana, toDevName: 'Ana', approvedByName: 'Fer', pendingKeys: 1 });
    const b = await createGrantIntent({ projectKey: P, env: E, toDevId: ids.ana }, fer);
    expect(b.id).toBe(a.id);
    expect(await pg.sql(`select count(*)::int as n from roz.zeus_vault_grant_intent`)).toEqual([{ n: 1 }]);
    // Y la base lo garantiza aunque dos aprobaciones lleguen a la vez.
    await expect(pg.sql(`insert into roz.zeus_vault_grant_intent (env_id, to_dev_id) values ($1, $2)`, [envId, ids.ana])).rejects.toThrow();
  });

  it('el overview lo muestra abierto; el CLI de quien tiene acceso lo ve con las públicas a envolver', async () => {
    const o = await vaultOverview();
    expect(o.intents).toEqual([expect.objectContaining({ envId, toDevName: 'Ana', approvedByName: 'Fer', pendingKeys: 1 })]);
    const forFer = await listGrantIntentsForCli(await actor(ids.fer));
    expect(forFer).toEqual([
      expect.objectContaining({ projectKey: P, env: E, dekVersion: 1, toDevName: 'Ana', approvedByName: 'Fer', keys: [expect.objectContaining({ keyId: keyIds.ana, name: 'laptop-ana', publicKey: keys.ana.publicKey })] }),
    ]);
    // Beto no tiene acceso: no le toca cifrarlo (ni podría).
    expect(await listGrantIntentsForCli(await actor(ids.beto))).toEqual([]);
    // Nada criptográfico en la tabla.
    expect(JSON.stringify(await pg.sql(`select * from roz.zeus_vault_grant_intent`))).not.toContain('zv1.');
  });

  it('se cumple al dar acceso a TODOS los equipos vigentes de la persona, y le avisa en su bandeja', async () => {
    // Ana registra un segundo equipo: dar acceso solo al primero no cierra la aprobación.
    keyIds.anaDesk = (await registerKey({ name: 'desk-ana', publicKey: keys.anaDesk.publicKey }, await actor(ids.ana))).id;
    const fer = await actor(ids.fer);
    await grantAccess(P, E, { keyId: keyIds.fer, grants: [{ keyId: keyIds.ana, wrappedDek: wrapFor(keys.ana.publicKey) }] }, fer);
    expect((await vaultOverview()).intents).toEqual([expect.objectContaining({ toDevName: 'Ana', pendingKeys: 1 })]);
    const pending = await listGrantIntentsForCli(fer);
    expect(pending[0]!.keys.map((k) => k.name)).toEqual(['desk-ana']);
    expect(await pg.sql(`select count(*)::int as n from roz.zeus_message where to_dev_id = $1`, [ids.ana])).toEqual([{ n: 0 }]);

    await grantAccess(P, E, { keyId: keyIds.fer, grants: [{ keyId: keyIds.anaDesk, wrappedDek: wrapFor(keys.anaDesk.publicKey) }] }, fer);
    const [row] = await pg.sql<{ fulfilled_at: string | null; fulfilled_by: string | null }>(`select fulfilled_at, fulfilled_by from roz.zeus_vault_grant_intent`);
    expect(row!.fulfilled_at).toBeTruthy();
    expect(row!.fulfilled_by).toBe(ids.fer);
    expect((await vaultOverview()).intents).toEqual([]);
    expect(await listGrantIntentsForCli(fer)).toEqual([]);
    const inbox = await pg.sql<{ subject: string; body: string }>(`select subject, body from roz.zeus_message where to_dev_id = $1`, [ids.ana]);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.subject).toBe(`Ya tienes acceso a ${P}/${E}`);
    expect(inbox[0]!.body).toContain(`zeus env pull ${P} ${E}`);
    // Una vez cifrada, ya no se cancela (para quitarla está `zeus env revoke`) y aprobar de nuevo se rechaza.
    const [{ id }] = (await pg.sql<{ id: string }>(`select id from roz.zeus_vault_grant_intent`)) as [{ id: string }];
    await expect(cancelGrantIntent(id, fer)).rejects.toMatchObject({ code: 'ZEUS_VAULT_INTENT_DONE' });
    await expect(createGrantIntent({ envId, toDevId: ids.ana }, fer)).rejects.toMatchObject({ code: 'ZEUS_VAULT_ALREADY_GRANTED' });
  });

  it('cancelar: quien aprobó o el destinatario sí; alguien sin acceso, no. Tras cancelar se puede aprobar de nuevo', async () => {
    const fer = await actor(ids.fer);
    const intent = await createGrantIntent({ envId, toDevId: ids.beto }, fer);
    await expect(cancelGrantIntent(intent.id, await actor(ids.caro))).rejects.toMatchObject({ code: 'ZEUS_VAULT_NO_ACCESS' });
    // Ana ya tiene acceso al entorno: también puede cancelarla.
    expect(await cancelGrantIntent(intent.id, await actor(ids.ana))).toEqual({ ok: true });
    expect((await vaultOverview()).intents).toEqual([]);
    const again = await createGrantIntent({ envId, toDevId: ids.beto }, fer);
    expect(again.id).not.toBe(intent.id);
    expect(await cancelGrantIntent(again.id, await actor(ids.beto))).toEqual({ ok: true });
    const actions = (await vaultOverview()).audit.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['grant.approve', 'grant.cancel']));
  });

  it('una aprobación de alguien que se queda sin llave vigente sigue visible, sin equipos por cifrar', async () => {
    const fer = await actor(ids.fer);
    await createGrantIntent({ envId, toDevId: ids.beto }, fer);
    await revokeKey(keyIds.beto, await actor(ids.beto));
    expect((await vaultOverview()).intents).toEqual([expect.objectContaining({ toDevName: 'Beto', pendingKeys: 0 })]);
    expect((await listGrantIntentsForCli(fer))[0]).toMatchObject({ toDevName: 'Beto', keys: [] });
  });
});
