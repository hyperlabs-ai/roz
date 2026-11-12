// Notificaciones de roz. Efectos disparados por el drain del outbox (asignación, cierre, cambios
// documentados, repo nuevo) y avisos directos por push (PR integrada/revisada, junta lista, fechas).
//
// El TEXTO de cada aviso vive en ./copy.ts (puro, con pruebas): aquí solo se junta el contexto del
// evento (quién, qué tarea, qué proyecto), se respeta cada interruptor y se entrega.
//
// Canal correo (Resend): cada envío deja un registro en `notification`. La idempotencia la da el
// outbox: el evento solo se marca `done` si el efecto no lanzó; si el envío falla, se lanza para que
// el drain reintente (backoff). Los avisos solo-push son best-effort y nunca lanzan.
import { db } from '../db/supabase.js';
import { config } from '../config.js';
import { sendEmail } from '../adapters/email.js';
import { pushToDev, pushToEmail } from './push.js';
import { emailAllowed, emailEnabled } from './switches.js';
import { claimOnce, releaseOnce } from '../events/outbox.js';
import {
  assignedNotice,
  documentedNotice,
  dueNotice,
  meetingReadyNotice,
  prMergedNotice,
  prReviewedNotice,
  renderEmail,
  repoDetectedNotice,
  toPush,
  workDoneNotice,
  type DueItem,
  type PrRef,
  type ReviewState,
} from './copy.js';

export interface AssignedPayload {
  workItemId?: string;
  devId?: string;
  identifier?: string;
  /** Quien asignó (dev de roz). Ausente = no se sabe. */
  actorDevId?: string | null;
  /** A quién se le quitó la tarea para dársela a `devId`. */
  previousDevId?: string | null;
  /** La asignó roz por reglas (asignación automática). */
  auto?: boolean;
}

interface DevRow { id: string; name: string | null; email: string | null }

const OPEN_STATUSES = ['planificada', 'pendiente', 'en_progreso', 'revision'];

/** Deep-link a la tarea nativa en el dashboard de roz (abre el detalle vía ?task=<id>). */
function taskUrl(id?: string | null): string | null {
  return id && config.dashboard.url ? `${config.dashboard.url}/app/tasks?task=${id}` : null;
}

async function devById(id?: string | null): Promise<DevRow | null> {
  if (!id) return null;
  const { data } = await db().from('dev').select('id, name, email').eq('id', id).maybeSingle();
  return (data as DevRow | null) ?? null;
}

async function projectName(id?: string | null): Promise<string | null> {
  if (!id) return null;
  const { data } = await db().from('project').select('name').eq('id', id).maybeSingle();
  return (data as { name: string } | null)?.name ?? null;
}

/** Avisa a quien propuso (requester) que su cambio cerró. Registra el envío en `notification`. */
export async function notifyProposerDone(opts: {
  to: string;
  identifier: string;
  name: string;
  url?: string | null;
}): Promise<void> {
  // Killswitch: se omite el aviso sin lanzar, para que el evento del outbox cierre en vez de
  // reintentar hasta morir. El destinatario es un correo suelto (quien reportó), no un dev: solo
  // aplica el interruptor global.
  if (!(await emailEnabled())) return;
  const supabase = db();
  // Quien reportó suele ser del equipo: si lo es, se le habla por su nombre.
  const { data: who } = await supabase.from('dev').select('name').ilike('email', opts.to).limit(1);
  const recipient = (who as { name: string | null }[] | null)?.[0]?.name ?? null;
  const notice = workDoneNotice({ seed: `done:${opts.identifier}`, recipient, identifier: opts.identifier, name: opts.name, url: opts.url });
  const { subject, html, text } = renderEmail(notice, config.dashboard.url);
  try {
    const res = await sendEmail({ to: opts.to, subject, html, text });
    await supabase.from('notification').insert({
      channel: 'email',
      to_address: opts.to,
      template: 'work_done',
      body: text,
      status: 'sent',
      provider_id: res.id,
    });
    await pushToEmail(opts.to, toPush(notice, { url: `${config.dashboard.url}/app/tickets`, tag: `done:${opts.identifier}` }), 'work_done');
  } catch (err) {
    await supabase.from('notification').insert({
      channel: 'email',
      to_address: opts.to,
      template: 'work_done',
      body: text,
      status: 'failed',
      error: String(err),
    });
    throw err; // que el drain reintente
  }
}

/** Avisa al dev que le asignaron una tarea (correo + push), con quién, qué y para cuándo. */
export async function notifyAssignment(payload: AssignedPayload): Promise<void> {
  const { workItemId, devId, identifier } = payload;
  if (!devId || !identifier) return;
  // Tomar una tarea uno mismo no necesita aviso.
  if (payload.actorDevId && payload.actorDevId === devId) return;

  // Interruptores (global + el del dev) ANTES del guard anti-duplicado: si se consumiera el claim
  // con los avisos apagados, al reencenderlos este dev ya nunca recibiría el correo.
  if (!(await emailAllowed(devId))) return;

  const supabase = db();

  // Guard anti-duplicado: el evento del outbox puede reintentarse (p.ej. si el envío fue OK
  // pero el insert en `notification` falló). Reclamar aquí asegura UN solo correo por
  // (issue, dev); si el efecto falla se libera para que el reintento sí pueda enviar.
  const notifyKey = `notify-assign:${identifier}:${devId}`;
  const firstTime = await claimOnce(notifyKey, 'notify-assign');
  if (!firstTime) return;

  const dev = await devById(devId);
  const { data: wiData } = workItemId
    ? await supabase.from('work_item').select('name, url, priority, due_date, estimate, project_id').eq('id', workItemId).maybeSingle()
    : { data: null };
  const wi = wiData as { name: string | null; url: string | null; priority: string | null; due_date: string | null; estimate: number | null; project_id: string | null } | null;

  // Contexto que hace el aviso concreto. Todo tolerante: si algo falla, el aviso sale más corto.
  const [actor, previous, project, openBefore] = await Promise.all([
    devById(payload.actorDevId).catch(() => null),
    devById(payload.previousDevId).catch(() => null),
    projectName(wi?.project_id).catch(() => null),
    (async () => {
      let q = supabase.from('work_item').select('id', { count: 'exact', head: true }).eq('assignee_dev_id', devId).in('status', OPEN_STATUSES);
      if (workItemId) q = q.neq('id', workItemId);
      const { count, error } = await q;
      return error ? null : count ?? null;
    })().catch(() => null),
  ]);

  // Tareas nativas no tienen url externa → deep-link al detalle en roz; cae a la url del ticket si existiera.
  const url = taskUrl(workItemId) ?? wi?.url ?? null;
  const notice = assignedNotice({
    seed: `assign:${identifier}:${devId}`,
    recipient: dev?.name,
    actor: actor?.name,
    auto: !!payload.auto,
    previous: previous?.name,
    task: { identifier, name: wi?.name, project, priority: wi?.priority, dueDate: wi?.due_date, estimate: wi?.estimate },
    openBefore,
    url,
  });
  const { subject, html, text } = renderEmail(notice, config.dashboard.url);

  if (!dev?.email) {
    await supabase.from('notification').insert({
      channel: 'email',
      to_dev_id: devId,
      template: 'assigned',
      body: text,
      status: 'failed',
      error: 'dev sin email',
    });
    return; // no hay a quién mandar; no es reintentable
  }

  try {
    const res = await sendEmail({ to: dev.email, subject, html, text });
    await supabase.from('notification').insert({
      channel: 'email',
      to_dev_id: devId,
      to_address: dev.email,
      template: 'assigned',
      body: text,
      status: 'sent',
      provider_id: res.id,
    });
    await pushToDev(
      devId,
      dev.email,
      toPush(notice, {
        url: url ?? `${config.dashboard.url}/app/tasks`,
        tag: `assign:${identifier}`,
        requireInteraction: wi?.priority === 'urgent',
        data: { kind: 'assigned', workItemId: workItemId ?? null },
      }),
      'assigned',
      { urgency: 'high' },
    );
  } catch (err) {
    await supabase.from('notification').insert({
      channel: 'email',
      to_dev_id: devId,
      to_address: dev.email,
      template: 'assigned',
      body: text,
      status: 'failed',
      error: String(err),
    });
    await releaseOnce(notifyKey); // libera el guard y relanza para que el drain reintente
    throw err;
  }
}

/**
 * Notifica al dev, en UN solo correo, los cambios que roz auto-documentó recientemente.
 * Agrupa por estado (change_notified=false), así una PR con muchos commits genera un único correo.
 */
export async function notifyChangesDocumented(devId: string): Promise<void> {
  if (!devId) return;
  const supabase = db();
  // Interruptor apagado: los pendientes se DESCARTAN (se marcan notificados sin enviar), igual que el
  // resto de los avisos. Si solo se omitiera, se acumulaban y al reencender los avisos llegaba todo
  // lo retroactivo de golpe, en correos de 50 en 50.
  if (!(await emailAllowed(devId))) {
    await supabase
      .from('work_item')
      .update({ change_notified: true })
      .eq('assignee_dev_id', devId)
      .eq('documented', true)
      .eq('change_notified', false);
    return;
  }

  const dev = await devById(devId);

  // Cambios auto-documentados PENDIENTES de notificar (change_notified=false). Agrupa por estado,
  // no por tiempo: cada PR genera nuevos pendientes (siempre notifica) y el primer evento del
  // push agarra todos; los siguientes ven 0 y no envían.
  const { data: items } = await supabase
    .from('work_item')
    .select('id, identifier, name, url, repo')
    .eq('assignee_dev_id', devId)
    .eq('documented', true)
    .eq('change_notified', false)
    .order('completed_at', { ascending: false })
    .limit(50);

  const list = (items ?? []) as { id: string; identifier: string; name: string; url: string | null; repo: string | null }[];
  if (!list.length) return; // nada pendiente (otro evento del mismo push ya notificó)

  const ids = list.map((i) => i.id);

  // Sin email: igual marcamos como notificados para no reintentar para siempre.
  if (!dev?.email) {
    await supabase.from('work_item').update({ change_notified: true }).in('id', ids);
    return;
  }

  const listUrl = `${config.dashboard.url}/app/tasks`;
  const notice = documentedNotice({
    seed: `documented:${devId}:${ids[0]}`,
    recipient: dev.name,
    // Deep-link a la tarea nativa (url del work_item es null en nativas).
    items: list.map((i) => ({ identifier: i.identifier, name: i.name, url: taskUrl(i.id) ?? i.url, repo: i.repo })),
    listUrl,
  });
  const { subject, html, text } = renderEmail(notice, config.dashboard.url);

  const res = await sendEmail({ to: dev.email, subject, html, text }); // si falla, lanza → reintento (pendientes intactos)
  // Marca como notificados SOLO tras enviar OK, para que un fallo reintente sin perder el aviso.
  await supabase.from('work_item').update({ change_notified: true }).in('id', ids);
  await supabase.from('notification').insert({ channel: 'email', to_dev_id: devId, to_address: dev.email, template: 'change_documented', body: text, status: 'sent', provider_id: res.id });
  await pushToDev(
    devId,
    dev.email,
    toPush(notice, {
      // Un solo cambio → deep-link directo a esa tarea; varios → la vista de tareas.
      url: (list.length === 1 ? taskUrl(list[0]!.id) : null) ?? listUrl,
      tag: `documented:${devId}`,
    }),
    'change_documented',
  );
}

interface RepoNotifyPayload {
  repo?: string;
  repoUrl?: string | null;
  projectName?: string | null;
  linked?: boolean;
}

/**
 * Avisa a TODOS los devs activos con email que se detectó un repo nuevo (vinculado o pendiente de
 * vincular). Idempotente por (repo, dev) vía claimOnce: si el envío a algún dev falla, se relanza
 * para que el drain reintente y los ya notificados se saltan.
 */
export async function notifyRepoDetected(payload: RepoNotifyPayload): Promise<void> {
  const repo = payload.repo;
  if (!repo) return;
  if (!(await emailEnabled())) return; // killswitch de equipo: nada que enviar, nada que reintentar
  const supabase = db();

  const { data } = await supabase.from('dev').select('id, name, email').eq('active', true).not('email', 'is', null);
  const devs = (data ?? []) as DevRow[];

  for (const dev of devs) {
    if (!dev.email) continue;
    if (!(await emailAllowed(dev.id))) continue; // silenciado por esta persona (no consume el claim)
    const key = `notify-repo:${repo}:${dev.id}`;
    const firstTime = await claimOnce(key, 'notify-repo');
    if (!firstTime) continue; // ya notificado en un intento previo

    const notice = repoDetectedNotice({
      seed: `repo:${repo}:${dev.id}`,
      recipient: dev.name,
      repo,
      repoUrl: payload.repoUrl ?? null,
      projectName: payload.projectName ?? null,
      linked: !!payload.linked,
    });
    const { subject, html, text } = renderEmail(notice, config.dashboard.url);

    try {
      const res = await sendEmail({ to: dev.email, subject, html, text });
      await supabase.from('notification').insert({
        channel: 'email',
        to_dev_id: dev.id,
        to_address: dev.email,
        template: 'repo_detected',
        body: text,
        status: 'sent',
        provider_id: res.id,
      });
      await pushToDev(dev.id, dev.email, toPush(notice, { url: `${config.dashboard.url}/app/projects`, tag: `repo:${repo}` }), 'repo_detected');
    } catch (err) {
      await supabase.from('notification').insert({
        channel: 'email',
        to_dev_id: dev.id,
        to_address: dev.email,
        template: 'repo_detected',
        body: text,
        status: 'failed',
        error: String(err),
      });
      await releaseOnce(key); // libera el claim para que el reintento sí pueda enviar a este dev
      throw err; // que el drain reintente (los devs ya enviados se saltan por su claim)
    }
  }
}

// ------------------------------------------------------------------ avisos solo-push
// Best-effort: nunca lanzan (no deben tumbar la reconciliación que los dispara) y son idempotentes
// por llave. pushToDev ya respeta los interruptores (global y por dev): apagado = se omite.

type LoginDev = DevRow & { github_login: string };

async function devsByLogin(logins: (string | null | undefined)[]): Promise<LoginDev[]> {
  const out: LoginDev[] = [];
  for (const login of [...new Set(logins.filter((l): l is string => !!l))]) {
    // Los logins de GitHub son case-insensitive (ilike sin comodines = igualdad sin distinguir mayúsculas).
    const { data } = await db().from('dev').select('id, name, email, github_login').ilike('github_login', login).maybeSingle();
    if (data) out.push(data as unknown as LoginDev);
  }
  return out;
}

const prUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;

/** Tu PR se integró y la integró OTRA persona (si la integraste tú, ya lo sabes). */
export async function notifyPrMerged(input: {
  pr: Omit<PrRef, 'url'>;
  authorLogins: (string | null | undefined)[];
  mergedByLogin: string | null;
  reviewerLogins?: (string | null | undefined)[];
}): Promise<void> {
  try {
    const { pr } = input;
    const authors = await devsByLogin(input.authorLogins);
    if (!authors.length) return;
    const [merger] = await devsByLogin([input.mergedByLogin]);
    const reviewers = await devsByLogin(input.reviewerLogins ?? []);
    for (const dev of authors) {
      if (!merger || merger.id === dev.id) continue;
      if (!(await claimOnce(`notify-pr-merged:${pr.repo}:${pr.number}:${dev.id}`, 'notify-pr'))) continue;
      const notice = prMergedNotice({
        seed: `pr-merged:${pr.repo}:${pr.number}:${dev.id}`,
        recipient: dev.name,
        merger: merger.name ?? input.mergedByLogin,
        pr: { ...pr, url: prUrl(pr.repo, pr.number) },
        reviewers: reviewers.filter((r) => r.id !== dev.id).map((r) => r.name ?? r.github_login),
      });
      await pushToDev(dev.id, dev.email, toPush(notice, { url: prUrl(pr.repo, pr.number), tag: `pr:${pr.repo}#${pr.number}` }), 'pr_merged');
    }
  } catch { /* best-effort */ }
}

const REVIEW_STATES: readonly string[] = ['approved', 'changes_requested', 'commented'];

/** Alguien revisó tu PR. Un aviso por (PR, revisor, veredicto): re-aprobar tras cambios vuelve a avisar. */
export async function notifyPrReviewed(input: {
  pr: Omit<PrRef, 'url'>;
  authorLogins: (string | null | undefined)[];
  reviews: { login: string | null; state: string }[];
}): Promise<void> {
  try {
    const { pr } = input;
    const authors = await devsByLogin(input.authorLogins);
    if (!authors.length) return;
    for (const review of input.reviews) {
      const state = review.state.toLowerCase();
      if (!review.login || !REVIEW_STATES.includes(state)) continue;
      const [reviewer] = await devsByLogin([review.login]);
      for (const dev of authors) {
        if (reviewer?.id === dev.id || review.login.toLowerCase() === dev.github_login.toLowerCase()) continue; // comentar tu propia PR no es noticia
        if (!(await claimOnce(`notify-pr-review:${pr.repo}:${pr.number}:${review.login.toLowerCase()}:${state}:${dev.id}`, 'notify-pr'))) continue;
        const notice = prReviewedNotice({
          seed: `pr-review:${pr.repo}:${pr.number}:${review.login}:${state}`,
          recipient: dev.name,
          reviewer: reviewer?.name ?? review.login,
          state: state as ReviewState,
          pr: { ...pr, url: prUrl(pr.repo, pr.number) },
        });
        await pushToDev(
          dev.id,
          dev.email,
          toPush(notice, { url: prUrl(pr.repo, pr.number), tag: `pr:${pr.repo}#${pr.number}` }),
          'pr_reviewed',
          { urgency: state === 'commented' ? 'normal' : 'high' },
        );
      }
    }
  } catch { /* best-effort */ }
}

/** La junta que subiste ya está leída: N candidatas te esperan en la bandeja. */
export async function notifyMeetingReady(input: {
  meetingId: string;
  title: string;
  createdByDevId: string | null;
  projectId?: string | null;
  candidates: number;
  decisions?: number;
  duplicates?: number;
}): Promise<void> {
  try {
    if (!input.createdByDevId) return;
    if (!(await claimOnce(`notify-meeting:${input.meetingId}`, 'notify-meeting'))) return;
    const [dev, project] = await Promise.all([devById(input.createdByDevId), projectName(input.projectId)]);
    if (!dev) return;
    const url = `${config.dashboard.url}/app/meetings?meeting=${input.meetingId}`;
    const notice = meetingReadyNotice({
      seed: `meeting:${input.meetingId}`,
      recipient: dev.name,
      title: input.title,
      candidates: input.candidates,
      decisions: input.decisions,
      duplicates: input.duplicates,
      project,
      url,
    });
    await pushToDev(dev.id, dev.email, toPush(notice, { url, tag: `meeting:${input.meetingId}`, data: { kind: 'meeting_ready', meetingId: input.meetingId } }), 'meeting_ready');
  } catch { /* best-effort */ }
}

export interface DueReminderResult { devs: number; tasks: number }

/**
 * Recordatorio diario de fechas (cron /v1/internal/task-reminders): a cada dev, UN push con lo que
 * le vence hoy y lo ya vencido (hasta 14 días atrás: más viejo que eso ya no es un recordatorio,
 * es ruido). Idempotente por (dev, día).
 */
export async function notifyDueTasks(now: Date = new Date()): Promise<DueReminderResult> {
  const supabase = db();
  const day = now.toISOString().slice(0, 10);
  const floor = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('work_item')
    .select('id, identifier, name, due_date, project_id, assignee_dev_id')
    .in('status', OPEN_STATUSES)
    .not('assignee_dev_id', 'is', null)
    .not('due_date', 'is', null)
    .gte('due_date', floor)
    .lte('due_date', `${day}T23:59:59Z`)
    .order('due_date', { ascending: true })
    .limit(500);
  if (error) throw error;
  type Row = { id: string; identifier: string; name: string; due_date: string; project_id: string | null; assignee_dev_id: string };
  const rows = (data ?? []) as unknown as Row[];
  if (!rows.length) return { devs: 0, tasks: 0 };

  const projectIds = [...new Set(rows.map((r) => r.project_id).filter(Boolean))] as string[];
  const { data: projects } = projectIds.length ? await supabase.from('project').select('id, name').in('id', projectIds) : { data: [] };
  const projName = new Map(((projects ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));

  const byDev = new Map<string, Row[]>();
  for (const r of rows) byDev.set(r.assignee_dev_id, [...(byDev.get(r.assignee_dev_id) ?? []), r]);

  let devs = 0;
  let tasks = 0;
  for (const [devId, list] of byDev) {
    try {
      if (!(await claimOnce(`notify-due:${devId}:${day}`, 'notify-due'))) continue;
      const dev = await devById(devId);
      if (!dev) continue;
      const items: DueItem[] = list.map((r) => ({ identifier: r.identifier, name: r.name, dueDate: r.due_date, project: r.project_id ? projName.get(r.project_id) ?? null : null, url: taskUrl(r.id) }));
      const listUrl = `${config.dashboard.url}/app/tasks`;
      const notice = dueNotice({ seed: `due:${devId}:${day}`, recipient: dev.name, items, now, listUrl });
      await pushToDev(devId, dev.email, toPush(notice, { url: (items.length === 1 ? items[0]!.url : null) ?? listUrl, tag: `due:${devId}` }), 'task_due', { urgency: 'high' });
      devs++;
      tasks += list.length;
    } catch { /* best-effort por dev */ }
  }
  return { devs, tasks };
}
