// Aviso de "te asignaron un ticket" cuando el cambio pasa EN Linear (lo crearon o lo reasignaron
// desde Linear, o desde zeus, que también escribe en Linear). Llega por el webhook y sale como los
// demás avisos de roz: correo con la plantilla de asignación + push, respetando los interruptores
// de notificación de cada persona.
//
// No avisa:
//   · si quien asignó es la misma persona (tomarse un ticket uno mismo no necesita aviso). Como zeus
//     usa UNA llave de Linear, Linear dice que todo lo hizo el dueño de la llave; por eso, para lo
//     que crea zeus, quién fue se lee de la firma "— vía zeus · <nombre>" de la descripción;
//   · un ticket ya cerrado o cancelado;
//   · dos veces el mismo (ticket, persona): Linear reintenta los webhooks.
// Con el espejo de roz v2 encendido (ROZ_LINEAR_SOT) esto no corre: ese camino ya avisa.
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { getIssue, listUsers, type LinearIssue, type LinearUser } from '../adapters/linear.js';
import { sendEmail } from '../adapters/email.js';
import { claimOnce, releaseOnce } from '../events/outbox.js';
import { assignedNotice, renderEmail, toPush } from '../notify/copy.js';
import { pushToDev } from '../notify/push.js';
import { emailAllowed } from '../notify/switches.js';
import { cached } from './linear-cache.js';

interface DevRow {
  id: string;
  name: string;
  email: string | null;
  github_email: string | null;
  github_login: string | null;
  linear_user_id: string | null;
}

const PRIORITY = [null, 'urgent', 'high', 'medium', 'low'] as const;

/** "— vía zeus · Sebas" al final de la descripción: quién lo creó de verdad por zeus. */
export function zeusAuthor(description: string | null | undefined): string | null {
  const m = /—\s*vía zeus · ([^\n]+?)\s*$/.exec(description ?? '');
  return m?.[1]?.trim() || null;
}

/** ¿Este aviso del webhook es un ticket nuevo con asignado o un cambio de asignado? Puro. */
export function isAssignmentEvent(p: { type: string; action: string; data: Record<string, unknown>; updatedFrom: Record<string, unknown> | null }): boolean {
  if (p.type !== 'Issue' || !p.data.assigneeId) return false;
  if (p.action === 'create') return true;
  return p.action === 'update' && !!p.updatedFrom && 'assigneeId' in p.updatedFrom;
}

async function activeDevs(): Promise<DevRow[]> {
  const { data, error } = await db().from('dev').select('id, name, email, github_email, github_login, linear_user_id').eq('active', true);
  if (error) throw error;
  return (data ?? []) as DevRow[];
}

/** El dev de roz de un usuario de Linear: por vínculo directo o por correo. */
function devOf(user: { id: string; email?: string | null } | null | undefined, devs: DevRow[], users: LinearUser[]): DevRow | null {
  if (!user) return null;
  const direct = devs.find((d) => d.linear_user_id === user.id);
  if (direct) return direct;
  const email = (user.email ?? users.find((u) => u.id === user.id)?.email ?? '').toLowerCase();
  if (!email) return null;
  return devs.find((d) => d.email?.toLowerCase() === email || d.github_email?.toLowerCase() === email) ?? null;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export async function notifyLinearAssignment(issueId: string, actorLinearUserId: string | null): Promise<'sent' | 'skipped'> {
  const issue: LinearIssue | null = await getIssue(issueId);
  if (!issue?.assignee || ['completed', 'canceled'].includes(issue.state.type)) return 'skipped';
  const [devs, users] = await Promise.all([activeDevs(), cached('users', listUsers)]);
  const dev = devOf(issue.assignee, devs, users);
  if (!dev?.email) return 'skipped';

  // Quién asignó: la firma de zeus gana sobre el actor de Linear (que con la llave compartida es
  // siempre su dueño).
  const signed = zeusAuthor(issue.description);
  const actor = signed
    ? (devs.find((d) => norm(d.name) === norm(signed)) ?? null)
    : devOf(actorLinearUserId ? { id: actorLinearUserId } : (issue.creator ?? null), devs, users);
  if (actor?.id === dev.id) return 'skipped';

  // Interruptores ANTES del guard: con los avisos apagados no se consume el aviso.
  if (!(await emailAllowed(dev.id))) return 'skipped';
  const key = `notify-linear:${issue.id}:${dev.id}`;
  if (!(await claimOnce(key, 'notify-linear'))) return 'skipped';

  const notice = assignedNotice({
    seed: `linear-assign:${issue.identifier}:${dev.id}`,
    recipient: dev.name,
    actor: actor?.name ?? signed ?? null,
    actorLogin: actor?.github_login ?? null,
    task: {
      identifier: issue.identifier,
      name: issue.title,
      project: issue.project?.name ?? null,
      priority: PRIORITY[issue.priority] ?? null,
      dueDate: issue.dueDate,
      estimate: issue.estimate,
    },
    url: issue.url,
  });
  const mail = renderEmail(notice, config.dashboard.url);
  try {
    const res = await sendEmail({ to: dev.email, ...mail });
    await db()
      .from('notification')
      .insert({ channel: 'email', to_dev_id: dev.id, to_address: dev.email, template: 'assigned', body: mail.text, status: res.suppressed ? 'suppressed' : 'sent', provider_id: res.id })
      .then(() => undefined, () => undefined);
    await pushToDev(dev.id, dev.email, toPush(notice, { url: issue.url, tag: `assign:${issue.identifier}`, requireInteraction: issue.priority === 1 }), 'assigned', { urgency: 'high' }).catch(() => undefined);
    return 'sent';
  } catch (err) {
    await db()
      .from('notification')
      .insert({ channel: 'email', to_dev_id: dev.id, to_address: dev.email, template: 'assigned', body: mail.text, status: 'failed', error: String(err) })
      .then(() => undefined, () => undefined);
    await releaseOnce(key).catch(() => undefined);
    return 'skipped';
  }
}
