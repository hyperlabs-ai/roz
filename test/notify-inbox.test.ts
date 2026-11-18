// La bandeja de zeus como lista de pendientes: cada evento que pide algo de un dev le deja un
// mensaje (aunque haya silenciado el correo), sin duplicados al reintentarse, y lo que es solo
// informativo no la ensucia. También el layout único de correo: sin caracteres como ícono.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createZeusPg, type ZeusPg } from './zeus-pg.js';

const holder = vi.hoisted(() => {
  process.env.ROZ_LOG_LEVEL = 'silent';
  return { pg: null as unknown as { client: unknown } };
});
vi.mock('../src/db/supabase.js', () => ({ db: () => holder.pg.client, dbPublic: () => holder.pg.client }));
vi.mock('../src/notify/push.js', () => ({ pushToDev: vi.fn(async () => undefined), pushBroadcast: vi.fn(), pushToEmail: vi.fn(async () => undefined) }));
vi.mock('../src/adapters/email.js', () => ({ sendEmail: vi.fn(async () => ({ id: 're_1' })) }));
const claimed = vi.hoisted(() => new Set<string>());
vi.mock('../src/events/outbox.js', () => ({
  claimOnce: vi.fn(async (key: string) => (claimed.has(key) ? false : (claimed.add(key), true))),
  releaseOnce: vi.fn(async (key: string) => void claimed.delete(key)),
}));
// Correo apagado para todos: la bandeja tiene que llegar igual.
vi.mock('../src/notify/switches.js', () => ({ emailAllowed: vi.fn(async () => false), emailEnabled: vi.fn(async () => false) }));

import { notifyAssignment, notifyMeetingReady, notifyPrReviewed, notifyRepoDetected } from '../src/notify/notifications.js';
import { notifyServiceTransitions } from '../src/infra/alerts.js';
import { assignedNotice, renderEmail, repoDetectedNotice } from '../src/notify/copy.js';
import { renderEmailDoc } from '../src/notify/email-layout.js';

let pg: ZeusPg;
const ids: Record<string, string> = {};
let projectId = '';

async function inbox(who: string): Promise<Array<{ subject: string; body: string; ref: string | null; from_dev_id: string | null; via: string }>> {
  return pg.sql(`select subject, body, ref, from_dev_id, via from roz.zeus_message where to_dev_id = $1 order by created_at`, [ids[who]]);
}

beforeAll(async () => {
  pg = await createZeusPg();
  holder.pg = pg;
  projectId = (await pg.sql<{ id: string }>(`insert into roz.project (name, key) values ('HyperHub', 'HYPERHUB') returning id`))[0]!.id;
  for (const [name, role, login, admin] of [['Fer', 'ceo', 'ferhyper', false], ['Alan', 'dev', 'alanvdev', false], ['Crix', 'dev', 'crixdev', false]] as const) {
    const [row] = await pg.sql<{ id: string }>(`insert into roz.dev (name, email, role, github_login) values ($1, $2, $3, $4) returning id`, [name, `${name.toLowerCase()}@hyper.test`, role, login]);
    ids[name] = row!.id;
    if (admin) await pg.sql(`update roz.dev set zeus_admin = true where id = $1`, [row!.id]);
  }
});
afterAll(async () => pg.close());
beforeEach(async () => {
  claimed.clear();
  await pg.sql(`delete from roz.zeus_message`);
});

describe('lo que pide algo de un dev llega a su bandeja', () => {
  it('tarea asignada: aunque el correo esté apagado; un reintento no la duplica; asignarte tú no avisa', async () => {
    await notifyAssignment({ workItemId: null, devId: ids.Alan!, identifier: 'HYPERHUB-21', actorDevId: ids.Fer! });
    await notifyAssignment({ workItemId: null, devId: ids.Alan!, identifier: 'HYPERHUB-21', actorDevId: ids.Fer! });
    await notifyAssignment({ workItemId: null, devId: ids.Crix!, identifier: 'HYPERHUB-22', actorDevId: ids.Crix! });
    const a = await inbox('Alan');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ subject: 'HYPERHUB-21', via: 'system', from_dev_id: ids.Fer });
    expect(await inbox('Crix')).toHaveLength(0);
  });

  it('PR aprobada o con cambios pedidos sí; un comentario no', async () => {
    const pr = { repo: 'hyperlabs-ai/api-hyperhub', number: 128, title: 'Webhook de pagos', branch: 'feat/pagos', identifier: 'HYPERHUB-21' };
    await notifyPrReviewed({ pr, authorLogins: ['alanvdev'], reviews: [{ login: 'crixdev', state: 'CHANGES_REQUESTED' }, { login: 'ferhyper', state: 'COMMENTED' }] });
    await notifyPrReviewed({ pr, authorLogins: ['alanvdev'], reviews: [{ login: 'crixdev', state: 'APPROVED' }] });
    const a = await inbox('Alan');
    expect(a.map((m) => m.subject)).toEqual(['Cambios en tu PR #128 en api-hyperhub', 'PR #128 aprobada en api-hyperhub']);
    expect(a[0]).toMatchObject({ ref: 'repo:hyperlabs-ai/api-hyperhub', from_dev_id: ids.Crix });
    expect(a[0]!.body).toContain('https://github.com/hyperlabs-ai/api-hyperhub/pull/128');
  });

  it('junta con candidatas por decidir le queda a quien la subió', async () => {
    await notifyMeetingReady({ meetingId: '00000000-0000-4000-8000-000000000001', title: 'Kickoff', createdByDevId: ids.Alan!, projectId, candidates: 4 });
    await notifyMeetingReady({ meetingId: '00000000-0000-4000-8000-000000000002', title: 'Daily', createdByDevId: ids.Alan!, projectId, candidates: 0 });
    const a = await inbox('Alan');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ ref: `project:${projectId}` });
  });

  it('repo sin proyecto: a quien administra (CEO o admin de zeus), no a todos; uno vinculado no deja nada', async () => {
    await notifyRepoDetected({ repo: 'hyperlabs-ai/proppie-mobile', linked: false, repoUrl: 'https://github.com/hyperlabs-ai/proppie-mobile' });
    await notifyRepoDetected({ repo: 'hyperlabs-ai/otro', linked: true, projectName: 'HyperHub' });
    expect((await inbox('Fer')).map((m) => m.subject)).toEqual(['El repo proppie-mobile no tiene proyecto']);
    expect(await inbox('Alan')).toHaveLength(0);
  });

  it('deploy fallido: a quien hizo el deploy; la recuperación no deja mensaje', async () => {
    const base = { projectName: 'HyperHub', provider: 'railway', serviceLabel: 'api', externalRef: 'svc-api', status: 'healthy', providerStatus: 'SUCCESS', error: null, deploy: null, lastSeenOkAt: null, downtimeMs: null };
    await notifyServiceTransitions([
      { ...base, kind: 'deploy_failed', lastDeploy: { sha: 'abc1234', branch: 'main', author: 'alanvdev' } as never, authorDevId: ids.Alan!, authorName: 'Alan' },
      { ...base, kind: 'up', externalRef: 'svc-web' },
    ]);
    const a = await inbox('Alan');
    expect(a).toHaveLength(1);
    expect(a[0]!.subject).toBe('Falló un deploy de api en HyperHub');
    expect(a[0]!.body).toMatch(/^Tu deploy/);
    expect(await inbox('Fer')).toHaveLength(0);
  });
});

describe('layout único de correo', () => {
  const ICON_CHARS = /[✓✔✗✘●•→←↑↓▲▼★☆✅❌⚠️]/u;

  it('todos los avisos salen con el mismo encabezado, pie con enlace a Configuración y sin caracteres como ícono', () => {
    const mails = [
      renderEmail(assignedNotice({ seed: 's', recipient: 'Ana', actor: 'Fer', actorLogin: 'ferhyper', task: { identifier: 'X-1', name: 'Algo', priority: 'urgent' } }), 'https://roz.example'),
      renderEmail(repoDetectedNotice({ seed: 's', repo: 'o/r', linked: false }), 'https://roz.example'),
    ];
    for (const m of mails) {
      expect(m.html).toContain('https://roz.example/configuracion');
      expect(m.html).toContain('El bot de tu equipo');
      expect(m.html).toContain('/brand/email/hero-');
      expect(m.html).not.toMatch(ICON_CHARS);
      expect(m.text).not.toMatch(ICON_CHARS);
    }
    // La persona que asignó, con su avatar de GitHub; la prioridad como chip.
    expect(mails[0]!.html).toContain('https://github.com/ferhyper.png');
    expect(mails[0]!.html).toContain('Urgente');
  });

  it('escapa lo que viene de afuera y no deja pasar enlaces que no sean http(s)', () => {
    const m = renderEmailDoc({
      subject: 's', botFile: 'roz-bot.png', section: 'Pruebas', kicker: 'k', tone: 'brand', headline: '<img src=x onerror=alert(1)>',
      blocks: [{ kind: 'list', items: [{ text: 'malo', url: 'javascript:alert(1)' }] }], base: 'https://roz.example',
    });
    expect(m.html).not.toContain('<img src=x');
    expect(m.html).not.toContain('javascript:');
  });
});
