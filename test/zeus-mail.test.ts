// Correo de la bandeja de zeus contra Postgres en memoria: qué manda correo (encargos, planes,
// ajustes pedidos, rechazos), mensajes directos; qué no (aceptado/hecho), el resumen diario de
// variables (uno por dev y día, solo lo no leído) y los interruptores de notificación.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createZeusPg, type ZeusPg } from './zeus-pg.js';

const holder = vi.hoisted(() => {
  process.env.ROZ_LOG_LEVEL = 'silent';
  return { pg: null as unknown as { client: unknown } };
});
vi.mock('../src/db/supabase.js', () => ({ db: () => holder.pg.client, dbPublic: () => holder.pg.client }));
vi.mock('../src/notify/push.js', () => ({ pushToDev: vi.fn(async () => undefined), pushBroadcast: vi.fn(), pushToEmail: vi.fn() }));
const mail = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; subject: string; text?: string; html?: string }>,
  claimed: new Set<string>(),
  muted: new Set<string>(),
}));
vi.mock('../src/adapters/email.js', () => ({
  sendEmail: vi.fn(async (m: { to: string; subject: string; text?: string; html?: string }) => {
    mail.sent.push(m);
    return { id: `re_${mail.sent.length}` };
  }),
}));
vi.mock('../src/events/outbox.js', () => ({
  claimOnce: vi.fn(async (key: string) => (mail.claimed.has(key) ? false : (mail.claimed.add(key), true))),
  releaseOnce: vi.fn(async (key: string) => void mail.claimed.delete(key)),
}));
vi.mock('../src/notify/switches.js', () => ({ emailAllowed: vi.fn(async (devId?: string | null) => !mail.muted.has(devId ?? '')) }));

import { actorForDev, type ZeusActor } from '../src/zeus/core.js';
import { notifyEnvChange, sendMessage, setMessageStatus, sharePlan } from '../src/zeus/inbox.js';
import { parseEnvNotice, sendZeusEnvDigests } from '../src/zeus/mail.js';
import { drainBackground } from '../src/utils/background.js';
import { zeusEnvDigestNotice, zeusWorkNotice } from '../src/notify/copy.js';

let pg: ZeusPg;
let fer: ZeusActor;
let alan: ZeusActor;
let crix: ZeusActor;

async function dev(name: string): Promise<ZeusActor> {
  const [row] = await pg.sql<{ id: string }>(`insert into roz.dev (name, email, role) values ($1, $2, 'dev') returning id`, [name, `${name.toLowerCase()}@hyper.test`]);
  return actorForDev(row!.id, 'mcp');
}
const settle = () => drainBackground(2000);
const to = (who: string) => mail.sent.filter((m) => m.to === `${who}@hyper.test`);

beforeAll(async () => {
  pg = await createZeusPg();
  holder.pg = pg;
  await pg.sql(`insert into roz.project (name, key) values ('HyperHub', 'HYPERHUB')`);
  fer = await dev('Fer');
  alan = await dev('Alan');
  crix = await dev('Crix');
});
afterAll(async () => {
  await settle();
  await pg.close();
});
beforeEach(async () => {
  await settle();
  mail.sent.length = 0;
  mail.muted.clear();
});

describe('correo inmediato de la bandeja', () => {
  it('encargos y mensajes le llegan por correo a quien los recibe; un mensaje lleva su texto completo', async () => {
    await sendMessage({ to: 'Alan', kind: 'task', subject: 'Implementar webhook de pagos', body: 'Con la cola de outbox.', projectKey: 'HYPERHUB' }, fer);
    await sendMessage({ to: 'Alan', body: '¿ya viste el deploy? Revisa los logs de api antes de las 5.' }, fer);
    await settle();
    expect(to('alan').map((m) => m.subject)).toEqual(['Encargo nuevo: Implementar webhook de pagos', 'Fer te escribió']);
    expect(to('alan')[0]!.text).toMatch(/Fer te dejó un encargo/);
    expect(to('alan')[0]!.text).toMatch(/Proyecto: HyperHub/);
    expect(to('alan')[1]!.text).toMatch(/¿ya viste el deploy\? Revisa los logs de api antes de las 5\./);
    expect(to('alan')[1]!.html).toContain('Responder en mi bandeja');
  });

  it('un mensaje a uno mismo no manda correo', async () => {
    await sendMessage({ to: 'Fer', body: 'nota para mí' }, fer);
    await settle();
    expect(to('fer')).toHaveLength(0);
  });

  it('plan nuevo, plan ajustado y ajustes pedidos: cada uno a quien le toca actuar', async () => {
    const v1 = await sharePlan({ to: 'Alan', title: 'Migrar pagos', plan: '# Plan\n1. SDK\n2. Webhooks', projectKey: 'HYPERHUB' }, fer);
    await settle();
    expect(to('alan').map((m) => m.subject)).toEqual(['Plan compartido: Migrar pagos']);
    expect(to('alan')[0]!.text).toMatch(/Resumen: Plan 1\. SDK 2\. Webhooks/);

    await setMessageStatus(v1.id, 'changes_requested', 'Falta el rollback', alan);
    await settle();
    expect(to('fer').map((m) => m.subject)).toEqual(['Ajustes pedidos: Migrar pagos']);
    expect(to('fer')[0]!.text).toMatch(/Nota: Falta el rollback/);

    const v2 = await sharePlan({ to: 'Alan', title: 'Migrar pagos', plan: '# Plan\n1. SDK\n2. Webhooks\n3. Rollback', revises: v1.id }, fer);
    await settle();
    expect(to('alan').map((m) => m.subject)).toEqual(['Plan compartido: Migrar pagos', 'Plan ajustado: Migrar pagos']);

    // Aceptar o terminar no manda correo (se ve en la bandeja y el push).
    await setMessageStatus(v2.id, 'accepted', null, alan);
    await setMessageStatus(v2.id, 'done', 'PR #40', alan);
    await settle();
    expect(to('fer')).toHaveLength(1);
  });

  it('un rechazo le llega a quien lo mandó, con el motivo', async () => {
    const t = await sendMessage({ to: 'Crix', kind: 'task', subject: 'Revisar caché', body: 'Ver invalidación' }, fer);
    await setMessageStatus(t.id, 'declined', 'Lo tiene Alan', crix);
    await settle();
    expect(to('fer').map((m) => m.subject)).toEqual(['Encargo rechazado: Revisar caché']);
    expect(to('fer')[0]!.text).toMatch(/Nota: Lo tiene Alan/);
  });

  it('respeta el interruptor del dev: con sus correos apagados no se manda', async () => {
    mail.muted.add(alan.devId);
    await sendMessage({ to: 'Alan', kind: 'task', subject: 'Algo', body: 'x' }, fer);
    await sendMessage({ to: 'Alan', body: 'y' }, fer);
    await settle();
    expect(to('alan')).toHaveLength(0);
  });
});

describe('resumen diario de variables', () => {
  it('un correo por dev con lo no leído de las últimas 24 h, solo nombres; no se repite el mismo día', async () => {
    await pg.sql(`delete from roz.zeus_message where kind = 'env_change'`);
    const base = { projectId: (await pg.sql<{ id: string }>(`select id from roz.project where key = 'HYPERHUB'`))[0]!.id, projectKey: 'HYPERHUB' };
    await notifyEnvChange({ ...base, actor: fer, devIds: [alan.devId, crix.devId], env: 'api-hyperhub-production', added: ['REDIS_URL'], changed: ['STRIPE_KEY'], deleted: [] });
    await notifyEnvChange({ ...base, actor: crix, devIds: [alan.devId], env: 'site-hyperhub-production', added: [], changed: [], deleted: ['OLD_FLAG'], rotated: false });
    // Crix ya lo leyó en roz: a él no le llega resumen.
    await pg.sql(`update roz.zeus_message set read_at = now() where to_dev_id = $1`, [crix.devId]);

    const now = new Date(Date.now() + 60_000);
    expect(await sendZeusEnvDigests(now)).toEqual({ devs: 1, notices: 2 });
    expect(to('alan')).toHaveLength(1);
    const m = to('alan')[0]!;
    expect(m.subject).toBe('Cambiaron variables en 2 entornos');
    expect(m.text).toMatch(/api-hyperhub \(Prod\): Nuevas: REDIS_URL; cambiaron: STRIPE_KEY \(Lo cambió Fer\)/);
    expect(m.text).toMatch(/site-hyperhub \(Prod\): Se quitaron: OLD_FLAG \(Lo cambió Crix\)/);
    expect(m.text).toMatch(/zeus env status/);
    expect(to('crix')).toHaveLength(0);

    expect(await sendZeusEnvDigests(now)).toEqual({ devs: 0, notices: 0 });
    expect(to('alan')).toHaveLength(1);
  });

  it('parseEnvNotice lee el aviso que escribe notifyEnvChange', () => {
    const body = 'Nuevas: A, B\nCambiaron: C\n\nPonte al día: zeus env pull HYPERHUB api-hyperhub-production   (o `zeus env status`)';
    expect(parseEnvNotice('Fer cambió 3 variables de HYPERHUB/api-hyperhub-production', body, 'Fer')).toEqual({
      label: 'api-hyperhub (Prod)',
      actor: 'Fer',
      added: ['A', 'B'],
      changed: ['C'],
      deleted: [],
      rotated: false,
    });
  });
});

describe('textos', () => {
  it('nunca llevan guiones largos y el asunto nombra lo que pide acción', () => {
    const n = zeusWorkNotice({ seed: 's', recipient: 'Alan Vega', actor: 'Fer — CEO', kind: 'plan', event: 'new', title: 'Migrar — pagos', url: 'https://roz/bandeja' });
    expect(n.subject).toBe('Plan compartido: Migrar, pagos');
    expect(JSON.stringify(n)).not.toMatch(/—/);
    expect(n.cta?.url).toBe('https://roz/bandeja');
    const d = zeusEnvDigestNotice({ seed: 's', recipient: 'Alan', url: 'u', changes: [{ label: 'P/api-production', actor: 'Fer', added: ['X'], changed: [], deleted: [], rotated: true }] });
    expect(d.subject).toBe('Cambiaron variables en P/api-production');
    expect(d.items?.[0]).toMatchObject({ text: 'Nuevas: X; rotó la llave (los valores no cambiaron)', meta: 'Lo cambió Fer' });
  });
});
