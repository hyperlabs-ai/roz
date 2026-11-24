// Bandeja de zeus: mensajes entre devs (y sus agentes) y solicitudes de acceso/permiso que se
// enrutan solas a quien le toca decidir. También: tokens por persona y el feed de actividad.
import { db } from '../db/supabase.js';
import { config } from '../config.js';
import { pushToDev } from '../notify/push.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { inBackground } from '../utils/background.js';
import { mailWorkEvent } from './mail.js';
import { envDisplay } from './env-label.js';
import { ZEUS_DUTIES, holdersOf, isDuty, loadDuties, type ZeusDuty } from './duties.js';
import { claimOnce, releaseOnce } from '../events/outbox.js';
import {
  ZEUS_OPEN_STATUSES,
  type ZeusActivityEvent,
  type ZeusInbox,
  type ZeusMe,
  type ZeusMessage,
  type ZeusMessageKind,
  type ZeusMessageStatus,
  type ZeusRequest,
  type ZeusRequestKind,
  type ZeusTokenSummary,
} from '../types/zeus.js';
import {
  actorActivity,
  describeRefs,
  generateZeusToken,
  hashZeusToken,
  isUuid,
  isZeusAdmin,
  logActivity,
  needsAdmin,
  parseRef,
  resolveProject,
  zeusTokenPrefix,
  type ZeusActor,
} from './core.js';

const MAX_MESSAGE_CHARS = 8000;
/** Un plan de implementación es un documento, no un mensaje: cabe bastante más. */
export const MAX_PLAN_CHARS = 60_000;

interface DevLite {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  github_login: string | null;
  reports_to: string | null;
  also_reports_to?: string[] | null;
  zeus_admin: boolean | null;
}

async function activeDevs(): Promise<DevLite[]> {
  const { data, error } = await db().from('dev').select('id, name, email, role, github_login, reports_to, also_reports_to, zeus_admin').eq('active', true).order('name');
  if (error) throw error;
  return (data ?? []) as DevLite[];
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Encuentra a una persona por id, correo, login de GitHub o nombre. Un agente escribe "Ana", no un
 * uuid; si el nombre es ambiguo se le dice entre quiénes, en vez de adivinar.
 */
export async function findDev(query: string): Promise<DevLite> {
  const devs = await activeDevs();
  const q = norm(query.replace(/^dev:/, ''));
  if (!q) throw new ValidationError('falta a quién');
  const exact = devs.filter((d) => d.id === q || norm(d.email ?? '') === q || norm(d.github_login ?? '') === q || norm(d.name) === q);
  if (exact.length === 1) return exact[0]!;
  const partial = devs.filter((d) => norm(d.name).split(/\s+/).includes(q) || norm(d.name).startsWith(q));
  if (partial.length === 1) return partial[0]!;
  const pool = exact.length ? exact : partial;
  if (pool.length > 1) throw new ValidationError(`"${query}" es ambiguo: ${pool.map((d) => d.name).join(', ')}. Usa el correo o el id.`);
  throw new NotFoundError(`no encontré a "${query}" en el equipo (usa zeus_org para ver quién hay)`);
}

function notify(devId: string, email: string | null, title: string, body: string, tab: string): void {
  inBackground(() =>
    pushToDev(
      devId,
      email,
      { title: title.slice(0, 50), body: body.replace(/\s+/g, ' ').slice(0, 120), url: `${config.dashboard.url}/${tab}`, tag: `zeus-${tab}` },
      'zeus',
    ),
  );
}

// ---------------------------------------------------------------- mensajes

interface MessageRow {
  id: string;
  kind: ZeusMessageKind;
  from_dev_id: string | null;
  to_dev_id: string;
  subject: string | null;
  body: string;
  ref: string | null;
  request_id: string | null;
  via: ZeusMessage['via'];
  read_at: string | null;
  created_at: string;
  status: ZeusMessageStatus | null;
  status_note: string | null;
  status_at: string | null;
  parent_id: string | null;
  project_id: string | null;
}

const MESSAGE_COLS =
  'id, kind, from_dev_id, to_dev_id, subject, body, ref, request_id, via, read_at, created_at, status, status_note, status_at, parent_id, project_id';

function toMessage(m: MessageRow, names: Map<string, string>, projects: Map<string, string> = new Map()): ZeusMessage {
  return {
    id: m.id,
    kind: m.kind ?? 'message',
    fromDevId: m.from_dev_id,
    fromName: m.from_dev_id ? (names.get(m.from_dev_id) ?? 'alguien') : 'zeus',
    toDevId: m.to_dev_id,
    toName: names.get(m.to_dev_id) ?? 'alguien',
    subject: m.subject,
    body: m.body,
    ref: m.ref,
    requestId: m.request_id,
    via: m.via,
    readAt: m.read_at,
    createdAt: m.created_at,
    status: m.status ?? null,
    statusNote: m.status_note ?? null,
    statusAt: m.status_at ?? null,
    parentId: m.parent_id ?? null,
    projectKey: m.project_id ? (projects.get(m.project_id) ?? null) : null,
  };
}

async function projectKeys(ids: Array<string | null>): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const { data, error } = await db().from('project').select('id, key').in('id', uniq);
  if (error) throw error;
  return new Map(((data ?? []) as Array<{ id: string; key: string }>).map((p) => [p.id, p.key]));
}

/** Mensajes listos para devolver: nombres de personas y claves de proyecto resueltos. */
async function hydrate(rows: MessageRow[]): Promise<ZeusMessage[]> {
  const [names, projects] = await Promise.all([devNames(rows.flatMap((m) => [m.from_dev_id, m.to_dev_id])), projectKeys(rows.map((m) => m.project_id))]);
  return rows.map((m) => toMessage(m, names, projects));
}

async function devNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const { data, error } = await db().from('dev').select('id, name').in('id', uniq);
  if (error) throw error;
  return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]));
}

export interface SendMessageInput {
  to: string;
  subject?: string | null;
  body: string;
  ref?: string | null;
  /** 'task' = encargo: queda pendiente en la bandeja de quien lo recibe hasta que lo cierre. */
  kind?: 'message' | 'task';
  projectKey?: string | null;
}

const viaOf = (actor: ZeusActor): ZeusMessage['via'] => (actor.via === 'runner' ? 'mcp' : actor.via);

export async function sendMessage(input: SendMessageInput, actor: ZeusActor): Promise<ZeusMessage> {
  const body = input.body?.trim();
  if (!body) throw new ValidationError('el mensaje está vacío');
  if (body.length > MAX_MESSAGE_CHARS) throw new ValidationError(`el mensaje pasa de ${MAX_MESSAGE_CHARS} caracteres`);
  if (input.ref && !parseRef(input.ref)) throw new ValidationError('ref inválida');
  const kind = input.kind ?? 'message';
  if (kind !== 'message' && kind !== 'task') throw new ValidationError('kind debe ser message o task');
  const to = await findDev(input.to);
  const project = input.projectKey ? await resolveProject(input.projectKey) : null;
  const subject = input.subject?.trim().slice(0, 160) || null;
  if (kind === 'task' && !subject) throw new ValidationError('un encargo necesita título (subject): es lo que se ve en la lista de pendientes');
  const { data, error } = await db()
    .from('zeus_message')
    .insert({
      kind,
      status: kind === 'task' ? 'pending' : null,
      from_dev_id: actor.devId,
      to_dev_id: to.id,
      subject,
      body,
      ref: input.ref ?? null,
      project_id: project?.id ?? null,
      via: viaOf(actor),
    })
    .select(MESSAGE_COLS)
    .single();
  if (error) throw error;
  logActivity(actorActivity(actor), kind === 'task' ? 'task' : 'message', `dev:${to.id}`, { to: to.name });
  if (to.id !== actor.devId) {
    notify(to.id, to.email, kind === 'task' ? `${actor.name} te encargó algo` : `${actor.name} te escribió`, subject || body, 'bandeja');
    // Mensajes y encargos también van por correo (respeta los interruptores de cada persona).
    const id = (data as MessageRow).id;
    inBackground(() => mailWorkEvent(id, 'new'));
  }
  return toMessage(data as MessageRow, new Map([[actor.devId, actor.name], [to.id, to.name]]), new Map(project ? [[project.id, project.key]] : []));
}

/** Aviso del sistema (resolución de una solicitud, etc.). No falla la operación que lo dispara. */
async function systemMessage(toDevId: string, subject: string, body: string, requestId: string | null, extra: { parentId?: string; fromDevId?: string } = {}): Promise<void> {
  const { error } = await db()
    .from('zeus_message')
    .insert({ from_dev_id: extra.fromDevId ?? null, to_dev_id: toDevId, subject, body, request_id: requestId, parent_id: extra.parentId ?? null, via: 'system' });
  if (error) throw error;
}

export interface InboxNoticeInput {
  toDevId: string;
  subject: string;
  body: string;
  /** Quien originó el evento (asignó, revisó…); null = lo avisa zeus. */
  fromDevId?: string | null;
  /** Referencia del grafo (`project:<id>`, `repo:<owner/name>`…); una inválida se descarta. */
  ref?: string | null;
  projectId?: string | null;
  /** Llave de idempotencia: el mismo evento no deja dos mensajes aunque se reintente. */
  dedupeKey?: string | null;
}

/**
 * Deja un aviso del sistema en la bandeja de un dev (tarea asignada, PR revisada, deploy caído…):
 * lo que tiene pendiente debe estar ahí al entrar, aunque haya silenciado el correo o el push.
 * Nunca lanza: el aviso es un extra y no puede tumbar el efecto que lo dispara.
 */
export async function inboxNotice(input: InboxNoticeInput): Promise<boolean> {
  try {
    if (!input.toDevId || !isUuid(input.toDevId)) return false;
    if (input.dedupeKey && !(await claimOnce(`inbox:${input.dedupeKey}`, 'zeus-inbox'))) return false;
    const ref = input.ref && parseRef(input.ref) ? input.ref : null;
    const { error } = await db()
      .from('zeus_message')
      .insert({
        kind: 'message',
        from_dev_id: input.fromDevId && input.fromDevId !== input.toDevId ? input.fromDevId : null,
        to_dev_id: input.toDevId,
        subject: input.subject.trim().slice(0, 160) || null,
        body: input.body.trim().slice(0, MAX_MESSAGE_CHARS) || input.subject.trim(),
        ref,
        project_id: input.projectId && isUuid(input.projectId) ? input.projectId : null,
        via: 'system',
      });
    if (error) {
      if (input.dedupeKey) await releaseOnce(`inbox:${input.dedupeKey}`).catch(() => undefined);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function loadMessage(id: string): Promise<MessageRow> {
  if (!isUuid(id)) throw new ValidationError('id de mensaje inválido');
  const { data, error } = await db().from('zeus_message').select(MESSAGE_COLS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('ese mensaje no existe');
  return data as MessageRow;
}

/** Un mensaje completo (p. ej. el texto entero de un plan). Solo quien lo mandó o lo recibió. */
export async function getMessage(id: string, actor: ZeusActor): Promise<ZeusMessage & { history: ZeusMessage[] }> {
  const row = await loadMessage(id);
  if (row.to_dev_id !== actor.devId && row.from_dev_id !== actor.devId) throw new AppError('FORBIDDEN', 'ese mensaje no es tuyo', 403);
  // Las versiones anteriores de un plan (para ver qué cambió entre una y otra).
  const chain: MessageRow[] = [];
  let parent = row.kind === 'plan' ? row.parent_id : null;
  while (parent && chain.length < 10) {
    const p = await loadMessage(parent).catch(() => null);
    if (!p || p.kind !== 'plan') break;
    chain.push(p);
    parent = p.parent_id;
  }
  const [main, ...history] = await hydrate([row, ...chain]);
  return { ...main!, history };
}

// ---------------------------------------------------------------- planes compartidos

export interface SharePlanInput {
  to: string;
  title: string;
  plan: string;
  projectKey?: string | null;
  ref?: string | null;
  /** id del plan que este reemplaza (la versión ajustada). La anterior queda "superseded". */
  revises?: string | null;
}

export async function sharePlan(input: SharePlanInput, actor: ZeusActor): Promise<ZeusMessage> {
  const title = input.title?.trim();
  const plan = input.plan?.trim();
  if (!title) throw new ValidationError('el plan necesita título');
  if (!plan) throw new ValidationError('el plan está vacío');
  if (plan.length > MAX_PLAN_CHARS) throw new ValidationError(`el plan pasa de ${MAX_PLAN_CHARS} caracteres: resúmelo o guárdalo como documento en zeus (zeus_write) y manda la ref`);
  if (input.ref && !parseRef(input.ref)) throw new ValidationError('ref inválida');
  const to = await findDev(input.to);
  const project = input.projectKey ? await resolveProject(input.projectKey) : null;

  let previous: MessageRow | null = null;
  if (input.revises) {
    previous = await loadMessage(input.revises);
    if (previous.kind !== 'plan') throw new ValidationError('revises debe ser el id de un plan');
    if (previous.from_dev_id !== actor.devId && previous.to_dev_id !== actor.devId) throw new AppError('FORBIDDEN', 'ese plan no es tuyo', 403);
  }
  // La versión ajustada hereda el proyecto de la anterior si no se dice otro.
  const projectId = project?.id ?? previous?.project_id ?? null;

  const { data, error } = await db()
    .from('zeus_message')
    .insert({
      kind: 'plan',
      status: 'pending',
      from_dev_id: actor.devId,
      to_dev_id: to.id,
      subject: title.slice(0, 160),
      body: plan,
      ref: input.ref ?? null,
      parent_id: previous?.id ?? null,
      project_id: projectId,
      via: viaOf(actor),
    })
    .select(MESSAGE_COLS)
    .single();
  if (error) throw error;
  if (previous && previous.status && (ZEUS_OPEN_STATUSES as readonly string[]).includes(previous.status)) {
    const now = new Date().toISOString();
    const { error: supErr } = await db()
      .from('zeus_message')
      .update({ status: 'superseded', status_at: now, status_by: actor.devId, status_note: 'hay una versión nueva del plan' })
      .eq('id', previous.id);
    if (supErr) throw supErr;
  }
  logActivity(actorActivity(actor), 'plan.share', `dev:${to.id}`, { to: to.name, title });
  if (to.id !== actor.devId) {
    notify(to.id, to.email, previous ? `${actor.name} ajustó un plan` : `${actor.name} te compartió un plan`, title, 'bandeja');
    const id = (data as MessageRow).id;
    inBackground(() => mailWorkEvent(id, previous ? 'revised' : 'new'));
  }
  return (await hydrate([data as MessageRow]))[0]!;
}

// ---------------------------------------------------------------- estado de encargos y planes

/** Qué puede hacer cada lado. Quien recibe decide; quien manda solo puede retirarlo. */
const RECIPIENT_STATUSES: readonly ZeusMessageStatus[] = ['accepted', 'changes_requested', 'declined', 'done'];
const SENDER_STATUSES: readonly ZeusMessageStatus[] = ['cancelled'];
const CLOSED_STATUSES: readonly ZeusMessageStatus[] = ['declined', 'done', 'cancelled', 'superseded'];

const STATUS_VERB: Record<ZeusMessageStatus, string> = {
  pending: 'dejó pendiente',
  accepted: 'aceptó',
  changes_requested: 'pidió ajustes a',
  declined: 'rechazó',
  done: 'terminó',
  cancelled: 'retiró',
  superseded: 'reemplazó',
};

export async function setMessageStatus(id: string, status: ZeusMessageStatus, note: string | null, actor: ZeusActor): Promise<ZeusMessage> {
  const row = await loadMessage(id);
  if (row.kind !== 'task' && row.kind !== 'plan') throw new ValidationError('solo los encargos y planes tienen estado');
  const isRecipient = row.to_dev_id === actor.devId;
  const isSender = row.from_dev_id === actor.devId;
  const allowed = [...(isRecipient ? RECIPIENT_STATUSES : []), ...(isSender ? SENDER_STATUSES : [])];
  if (!allowed.includes(status)) {
    if (!isRecipient && !isSender) throw new AppError('FORBIDDEN', 'ese encargo no es tuyo', 403);
    throw new ValidationError(`no puedes marcarlo como "${status}" (puedes: ${allowed.join(', ') || 'nada'})`);
  }
  if (row.status && CLOSED_STATUSES.includes(row.status)) throw new AppError('ZEUS_MESSAGE_CLOSED', `ya está cerrado (${row.status})`, 409);
  if (status === 'changes_requested' && !note?.trim()) throw new ValidationError('di qué ajustes necesita (note)');
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from('zeus_message')
    .update({ status, status_note: note?.trim().slice(0, MAX_MESSAGE_CHARS) || null, status_at: now, status_by: actor.devId, read_at: row.read_at ?? (isRecipient ? now : null) })
    .eq('id', id)
    .select(MESSAGE_COLS)
    .single();
  if (error) throw error;

  // El otro lado se entera en su bandeja (y su Claude lo ve en zeus_inbox).
  const otherId = isRecipient ? row.from_dev_id : row.to_dev_id;
  if (otherId && otherId !== actor.devId) {
    const what = row.kind === 'plan' ? 'tu plan' : 'tu encargo';
    const subject = `${actor.name} ${STATUS_VERB[status]} ${isRecipient ? what : 'un encargo'}`;
    const body = `"${row.subject ?? '(sin título)'}"${note?.trim() ? `\n\n${note.trim()}` : ''}${
      status === 'changes_requested' ? `\n\nPara mandar la versión ajustada: zeus_share_plan con revises="${row.id}".` : ''
    }`;
    await systemMessage(otherId, subject, body, null, { parentId: row.id, fromDevId: actor.devId }).catch(() => undefined);
    const { data: other } = await db().from('dev').select('email').eq('id', otherId).maybeSingle();
    notify(otherId, (other as { email: string | null } | null)?.email ?? null, subject, row.subject ?? '', 'bandeja');
    // Que te pidan ajustes o te rechacen algo pide acción tuya: va por correo a quien lo mandó.
    if (isRecipient && (status === 'changes_requested' || status === 'declined')) inBackground(() => mailWorkEvent(row.id, status));
  }
  logActivity(actorActivity(actor), `${row.kind}.${status}`, null, { title: row.subject });
  return (await hydrate([data as MessageRow]))[0]!;
}

// ---------------------------------------------------------------- avisos de la bóveda

export interface EnvChangeNotice {
  actor: ZeusActor;
  devIds: string[];
  projectId: string;
  projectKey: string;
  env: string;
  added: string[];
  changed: string[];
  deleted: string[];
  rotated?: boolean;
}

/** Ventana en la que cambios seguidos del mismo entorno se juntan en un solo aviso sin leer. */
const ENV_MERGE_MS = 2 * 60 * 60_000;

const ENV_GROUPS = [
  ['added', 'Nuevas:'],
  ['changed', 'Cambiaron:'],
  ['deleted', 'Se quitaron:'],
] as const;

type EnvNames = Record<(typeof ENV_GROUPS)[number][0], string[]>;

/** Lee los nombres de un aviso ya guardado ("Nuevas: A, B" …). Pura, para probarla. */
export function parseEnvNotice(body: string): EnvNames & { rotated: boolean } {
  const out: EnvNames = { added: [], changed: [], deleted: [] };
  for (const [key, prefix] of ENV_GROUPS) {
    const line = body.split('\n').find((l) => l.startsWith(prefix));
    if (line) out[key] = line.slice(prefix.length).split(',').map((n) => n.trim()).filter(Boolean);
  }
  return { ...out, rotated: /rotó la llave/i.test(body) };
}

/**
 * Junta dos tandas de cambios del mismo entorno. Lo que se agregó y luego se quitó desaparece; lo
 * que se agregó y luego cambió sigue siendo "nueva". Pura, para probarla.
 */
export function mergeEnvNames(prev: EnvNames, next: EnvNames): EnvNames {
  const added = new Set(prev.added);
  const changed = new Set(prev.changed);
  const deleted = new Set(prev.deleted);
  for (const n of next.added) {
    if (deleted.delete(n)) changed.add(n);
    else added.add(n);
  }
  for (const n of next.changed) if (!added.has(n)) changed.add(n);
  for (const n of next.deleted) {
    if (added.delete(n)) continue;
    changed.delete(n);
    deleted.add(n);
  }
  const sort = (s: Set<string>) => [...s].sort();
  return { added: sort(added), changed: sort(changed), deleted: sort(deleted) };
}

function envNoticeText(actorName: string, projectKey: string, env: string, names: EnvNames, rotated: boolean): { subject: string; body: string } | null {
  // A la persona se le nombra como en Variables: "api-hyperhub (Prod)". El comando sí lleva el nombre real.
  const label = envDisplay(env, projectKey);
  const lines: string[] = [];
  if (rotated) lines.push(`Se rotó la llave del entorno. Los valores no cambiaron; vuelve a bajar para seguir pudiendo subir cambios.`);
  if (names.added.length) lines.push(`Nuevas: ${names.added.join(', ')}`);
  if (names.changed.length) lines.push(`Cambiaron: ${names.changed.join(', ')}`);
  if (names.deleted.length) lines.push(`Se quitaron: ${names.deleted.join(', ')}`);
  if (!lines.length) return null;
  lines.push('', `Ponte al día: zeus env pull ${projectKey} ${env}   (o \`zeus env status\` para ver qué te falta)`);
  const total = names.added.length + names.changed.length + names.deleted.length;
  const subject = rotated && !total ? `${actorName} rotó la llave de ${label}` : `${actorName} cambió ${total} variable${total === 1 ? '' : 's'} de ${label}`;
  return { subject, body: lines.join('\n') };
}

/**
 * Un aviso por persona con acceso: qué NOMBRES cambiaron y cómo ponerse al día. Nunca valores.
 * Si esa persona aún no leyó un aviso reciente del MISMO entorno y de la misma persona, se le suma
 * a ese en vez de dejarle otro: subir variables una por una no debe llenar la bandeja de avisos.
 */
export async function notifyEnvChange(n: EnvChangeNotice): Promise<void> {
  const incoming: EnvNames = { added: n.added, changed: n.changed, deleted: n.deleted };
  if (!n.rotated && !n.added.length && !n.changed.length && !n.deleted.length) return;
  const supabase = db();
  const since = new Date(Date.now() - ENV_MERGE_MS).toISOString();
  const { data: openRows, error: openErr } = await supabase
    .from('zeus_message')
    .select('id, to_dev_id, subject, body')
    .eq('kind', 'env_change')
    .eq('from_dev_id', n.actor.devId)
    .eq('project_id', n.projectId)
    .is('read_at', null)
    .gte('created_at', since)
    .in('to_dev_id', n.devIds);
  if (openErr) throw openErr;
  // El entorno exacto sale del comando del cuerpo ("zeus env pull PROYECTO entorno"); los avisos
  // viejos lo traían al final del asunto. Se compara aquí, no con LIKE (`_` es comodín).
  const cmd = `zeus env pull ${n.projectKey} ${n.env} `;
  const oldSuffix = ` de ${n.projectKey}/${n.env}`;
  const openByDev = new Map(
    ((openRows ?? []) as Array<{ id: string; to_dev_id: string; subject: string | null; body: string }>)
      .filter((r) => r.body.includes(cmd) || r.subject?.endsWith(oldSuffix))
      .map((r) => [r.to_dev_id, r]),
  );

  const fresh = envNoticeText(n.actor.name, n.projectKey, n.env, incoming, !!n.rotated);
  const inserts: Array<Record<string, unknown>> = [];
  for (const devId of n.devIds) {
    const prev = openByDev.get(devId);
    if (!prev) {
      if (fresh) inserts.push({ kind: 'env_change', from_dev_id: n.actor.devId, to_dev_id: devId, subject: fresh.subject, body: fresh.body, project_id: n.projectId, via: 'system' });
      continue;
    }
    const old = parseEnvNotice(prev.body);
    const merged = envNoticeText(n.actor.name, n.projectKey, n.env, mergeEnvNames(old, incoming), old.rotated || !!n.rotated);
    // Si todo se canceló (se agregó y se quitó), el aviso deja de tener sentido: se da por leído.
    const { error } = merged
      ? await supabase.from('zeus_message').update({ subject: merged.subject, body: merged.body, created_at: new Date().toISOString() }).eq('id', prev.id)
      : await supabase.from('zeus_message').update({ read_at: new Date().toISOString() }).eq('id', prev.id);
    if (error) throw error;
  }
  if (inserts.length) {
    const { error } = await supabase.from('zeus_message').insert(inserts);
    if (error) throw error;
  }
  // El push sí va cada vez: es lo que avisa "acaba de cambiar".
  if (!fresh) return;
  const { data } = await supabase.from('dev').select('id, email').in('id', n.devIds);
  for (const d of (data ?? []) as Array<{ id: string; email: string | null }>) notify(d.id, d.email, fresh.subject, fresh.body.split('\n')[0] ?? '', 'bandeja');
}

export async function markRead(ids: string[] | 'all', actor: ZeusActor): Promise<number> {
  let q = db().from('zeus_message').update({ read_at: new Date().toISOString() }).eq('to_dev_id', actor.devId).is('read_at', null);
  if (ids !== 'all') {
    const valid = ids.filter(isUuid);
    if (!valid.length) return 0;
    q = q.in('id', valid);
  }
  const { data, error } = await q.select('id');
  if (error) throw error;
  return (data ?? []).length;
}

// ---------------------------------------------------------------- solicitudes

interface RequestRow {
  id: string;
  kind: ZeusRequestKind;
  requester_dev_id: string;
  approver_dev_id: string | null;
  resource_ref: string | null;
  title: string;
  detail: string;
  routed_because: string | null;
  status: ZeusRequest['status'];
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  via: ZeusRequest['via'];
  created_at: string;
}

const REQUEST_COLS =
  'id, kind, requester_dev_id, approver_dev_id, resource_ref, title, detail, routed_because, status, resolution_note, resolved_by, resolved_at, via, created_at';

async function toRequests(rows: RequestRow[], actor: ZeusActor): Promise<ZeusRequest[]> {
  const [names, refs] = await Promise.all([
    devNames(rows.flatMap((r) => [r.requester_dev_id, r.approver_dev_id, r.resolved_by])),
    describeRefs(rows.map((r) => r.resource_ref).filter((r): r is string => !!r)),
  ]);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    status: r.status,
    requesterDevId: r.requester_dev_id,
    requesterName: names.get(r.requester_dev_id) ?? 'alguien',
    approverDevId: r.approver_dev_id,
    approverName: r.approver_dev_id ? (names.get(r.approver_dev_id) ?? null) : null,
    resourceRef: r.resource_ref,
    resourceTitle: r.resource_ref ? (refs.get(r.resource_ref)?.title ?? null) : null,
    routedBecause: r.routed_because,
    resolutionNote: r.resolution_note,
    resolvedByName: r.resolved_by ? (names.get(r.resolved_by) ?? null) : null,
    resolvedAt: r.resolved_at,
    via: r.via,
    createdAt: r.created_at,
    canResolve: r.status === 'pending' && r.requester_dev_id !== actor.devId && (r.approver_dev_id === actor.devId || actor.admin),
  }));
}

export interface Route {
  approver: DevLite | null;
  because: string;
}

const LEAD_ROLES = ['pm', 'ceo', 'account_manager'];

/** "Revisión de código y merge de PRs" → "revisión de código y merge de PRs" (siglas intactas). */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** El tema de una solicitud: el que se pidió, o el implícito de su tipo ("review" = revisión de código). */
export function topicFor(kind: ZeusRequestKind | null | undefined, topic: string | null | undefined): ZeusDuty | null {
  if (topic && isDuty(topic)) return topic;
  return kind === 'review' ? 'code_review' : null;
}

/**
 * A quién le toca decidir sobre un recurso, y por qué. Orden: quien atiende el TEMA (si la solicitud
 * trae uno: revisión de código, deploys, accesos avanzados…) → el dueño del recurso → quien lidera el
 * proyecto → el jefe directo de quien pide (o, si no tiene, a quien más reporta) → un administrador de
 * zeus. Nunca se le enruta a uno mismo: pedirse permiso a sí mismo no es un control.
 */
export async function routeFor(requesterId: string, resourceRef: string | null, topic: ZeusDuty | null = null): Promise<Route> {
  const devs = await activeDevs();
  const byId = new Map(devs.map((d) => [d.id, d]));
  const usable = (id: string | null | undefined): DevLite | null => (id && id !== requesterId ? (byId.get(id) ?? null) : null);
  const supabase = db();

  if (topic) {
    const holders = holdersOf(await loadDuties(), topic, requesterId).map((r) => usable(r.dev_id)).filter((d): d is DevLite => !!d);
    const first = holders[0];
    if (first) {
      const next = holders.slice(1, 3).map((d) => d.name);
      return {
        approver: first,
        because: `${first.name} se encarga de ${lowerFirst(ZEUS_DUTIES[topic].label)}${next.length ? ` (si no está: ${next.join(', luego ')})` : ''}`,
      };
    }
  }

  let projectId: string | null = null;
  const parsed = resourceRef ? parseRef(resourceRef) : null;
  if (parsed?.type === 'node') {
    const { data, error } = await supabase.from('zeus_node').select('title, owner_dev_id, project_id').eq('id', parsed.id).maybeSingle();
    if (error) throw error;
    const n = data as { title: string; owner_dev_id: string | null; project_id: string | null } | null;
    const owner = usable(n?.owner_dev_id);
    if (owner) return { approver: owner, because: `${owner.name} es dueño de "${n!.title}"` };
    projectId = n?.project_id ?? null;
  } else if (parsed?.type === 'project') {
    projectId = parsed.id;
  } else if (parsed?.type === 'repo') {
    const { data, error } = await supabase.from('project_repo').select('project_id').eq('repo', parsed.id).maybeSingle();
    if (error) throw error;
    projectId = (data as { project_id: string } | null)?.project_id ?? null;
  } else if (parsed?.type === 'dev') {
    const person = usable(parsed.id);
    if (person) return { approver: person, because: `es directamente con ${person.name}` };
  }

  if (projectId) {
    const { data, error } = await supabase.from('dev_assignment').select('dev_id, kind, sort_order').eq('project_id', projectId).order('sort_order');
    if (error) throw error;
    const team = ((data ?? []) as Array<{ dev_id: string; kind: string }>).map((a) => ({ a, d: usable(a.dev_id) })).filter((x): x is { a: { dev_id: string; kind: string }; d: DevLite } => !!x.d);
    const lead = team.find((x) => LEAD_ROLES.includes(x.d.role ?? ''))?.d ?? team.find((x) => x.a.kind === 'principal')?.d;
    if (lead) return { approver: lead, because: `${lead.name} lleva ese proyecto` };
  }

  const me = byId.get(requesterId);
  const boss = usable(me?.reports_to);
  if (boss) return { approver: boss, because: `le reportas directamente a ${boss.name} y el recurso no tiene dueño asignado` };
  const dotted = (me?.also_reports_to ?? []).map(usable).find((d): d is DevLite => !!d);
  if (dotted) return { approver: dotted, because: `también le reportas a ${dotted.name} y el recurso no tiene dueño asignado` };

  const admin = devs.find((d) => d.id !== requesterId && isZeusAdmin(d));
  if (admin) return { approver: admin, because: `${admin.name} administra zeus y no hay un dueño más específico` };
  return { approver: null, because: 'no hay dueño, jefe ni administrador asignado: queda abierta para quien administre zeus' };
}

export interface CreateRequestInput {
  kind?: ZeusRequestKind;
  /** Tema (code_review, deploys, architecture, client_feedback, clients, advanced_access): enruta a quien lo atiende. */
  topic?: string | null;
  title: string;
  detail?: string;
  resourceRef?: string | null;
}

const REQUEST_KINDS: readonly ZeusRequestKind[] = ['access', 'permission', 'review', 'change', 'other'];

export async function createRequest(input: CreateRequestInput, actor: ZeusActor): Promise<ZeusRequest> {
  const title = input.title?.trim();
  if (!title) throw new ValidationError('falta qué se está pidiendo (title)');
  if (title.length > 200) throw new ValidationError('el título no puede pasar de 200 caracteres');
  const kind = input.kind ?? 'access';
  if (!REQUEST_KINDS.includes(kind)) throw new ValidationError(`tipo inválido (usa: ${REQUEST_KINDS.join(', ')})`);
  if (input.resourceRef && !parseRef(input.resourceRef)) throw new ValidationError('resourceRef inválida');
  if (input.topic && !isDuty(input.topic)) throw new ValidationError(`tema desconocido (usa: ${Object.keys(ZEUS_DUTIES).join(', ')})`);
  const route = await routeFor(actor.devId, input.resourceRef ?? null, topicFor(kind, input.topic));
  const { data, error } = await db()
    .from('zeus_request')
    .insert({
      kind,
      requester_dev_id: actor.devId,
      approver_dev_id: route.approver?.id ?? null,
      resource_ref: input.resourceRef ?? null,
      title,
      detail: (input.detail ?? '').trim().slice(0, MAX_MESSAGE_CHARS),
      routed_because: route.because,
      via: actor.via === 'runner' ? 'mcp' : actor.via,
    })
    .select(REQUEST_COLS)
    .single();
  if (error) throw error;
  const row = data as RequestRow;
  logActivity(actorActivity(actor), 'request', input.resourceRef ?? null, { title, to: route.approver?.name ?? null });
  if (route.approver) notify(route.approver.id, route.approver.email, `${actor.name} te pide algo`, title, 'bandeja');
  return (await toRequests([row], actor))[0]!;
}

async function loadRequest(id: string): Promise<RequestRow> {
  if (!isUuid(id)) throw new ValidationError('id de solicitud inválido');
  const { data, error } = await db().from('zeus_request').select(REQUEST_COLS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('esa solicitud no existe');
  return data as RequestRow;
}

export async function resolveRequest(id: string, decision: 'approved' | 'denied', note: string | null, actor: ZeusActor): Promise<ZeusRequest> {
  if (decision !== 'approved' && decision !== 'denied') throw new ValidationError('decision debe ser approved o denied');
  const row = await loadRequest(id);
  if (row.status !== 'pending') throw new AppError('ZEUS_REQUEST_CLOSED', `esa solicitud ya está ${row.status}`, 409);
  if (row.requester_dev_id === actor.devId) throw new AppError('FORBIDDEN', 'no puedes resolver tu propia solicitud', 403);
  if (row.approver_dev_id !== actor.devId && !actor.admin) {
    throw new AppError('FORBIDDEN', 'esta solicitud le toca a otra persona (o a un administrador de zeus)', 403);
  }
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from('zeus_request')
    .update({ status: decision, resolution_note: note?.trim().slice(0, 2000) || null, resolved_by: actor.devId, resolved_at: now, updated_at: now })
    .eq('id', id)
    .eq('status', 'pending')
    .select(REQUEST_COLS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError('ZEUS_REQUEST_CLOSED', 'alguien más la resolvió primero', 409);
  const verdict = decision === 'approved' ? 'aprobó' : 'rechazó';
  // Aprobar aquí es una DECISIÓN registrada, no un cambio de permisos: quien aprueba todavía tiene
  // que dar el acceso donde corresponda (GitHub, Vercel, la bóveda…). Se dice explícito para que
  // nadie crea que ya quedó hecho.
  const tail = decision === 'approved' ? ' Falta que te dé el acceso en el sistema correspondiente.' : '';
  await systemMessage(row.requester_dev_id, `${actor.name} ${verdict} tu solicitud`, `"${row.title}"${note?.trim() ? `\n\n${note.trim()}` : ''}${tail}`, row.id);
  const { data: requester } = await db().from('dev').select('email').eq('id', row.requester_dev_id).maybeSingle();
  notify(row.requester_dev_id, (requester as { email: string | null } | null)?.email ?? null, `${actor.name} ${verdict} tu solicitud`, row.title, 'bandeja');
  logActivity(actorActivity(actor), 'resolve', row.resource_ref, { decision, title: row.title });
  return (await toRequests([data as RequestRow], actor))[0]!;
}

export async function cancelRequest(id: string, actor: ZeusActor): Promise<ZeusRequest> {
  const row = await loadRequest(id);
  if (row.requester_dev_id !== actor.devId) throw new AppError('FORBIDDEN', 'solo quien la abrió puede cancelarla', 403);
  if (row.status !== 'pending') throw new AppError('ZEUS_REQUEST_CLOSED', `esa solicitud ya está ${row.status}`, 409);
  const { data, error } = await db()
    .from('zeus_request')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select(REQUEST_COLS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError('ZEUS_REQUEST_CLOSED', 'la solicitud ya cambió de estado', 409);
  return (await toRequests([data as RequestRow], actor))[0]!;
}

export async function listRequests(scope: 'mine' | 'to_me' | 'all', actor: ZeusActor, limit = 50): Promise<ZeusRequest[]> {
  let q = db().from('zeus_request').select(REQUEST_COLS);
  if (scope === 'mine') q = q.eq('requester_dev_id', actor.devId);
  else if (scope === 'to_me') {
    // Lo que me asignaron y, si administro, lo que quedó sin aprobador.
    q = actor.admin ? q.eq('status', 'pending').or(`approver_dev_id.eq.${actor.devId},approver_dev_id.is.null`) : q.eq('status', 'pending').eq('approver_dev_id', actor.devId);
    q = q.neq('requester_dev_id', actor.devId);
  } else if (!actor.admin) {
    q = q.or(`requester_dev_id.eq.${actor.devId},approver_dev_id.eq.${actor.devId}`);
  }
  const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return toRequests((data ?? []) as RequestRow[], actor);
}

// ---------------------------------------------------------------- bandeja

export async function getInbox(actor: ZeusActor, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<ZeusInbox> {
  const supabase = db();
  const limit = Math.min(opts.limit ?? 50, 200);
  // Mensajes y avisos de variables van en consultas separadas: los avisos son muchos y, juntos,
  // empujaban fuera del tope a los mensajes de personas (y los dejaban enterrados al leerlos).
  let received = supabase.from('zeus_message').select(MESSAGE_COLS).eq('to_dev_id', actor.devId).in('kind', ['message', 'task', 'plan']);
  if (opts.unreadOnly) received = received.is('read_at', null);
  let envReceived = supabase.from('zeus_message').select(MESSAGE_COLS).eq('to_dev_id', actor.devId).eq('kind', 'env_change');
  if (opts.unreadOnly) envReceived = envReceived.is('read_at', null);
  const open = [...ZEUS_OPEN_STATUSES];
  const [inbox, envs, sent, openForMe, waiting, unread, toResolve, mine] = await Promise.all([
    received.order('created_at', { ascending: false }).limit(limit),
    envReceived.order('created_at', { ascending: false }).limit(30),
    // Un aviso de variables se guarda una vez por destinatario: en "enviados" saldría N veces.
    supabase.from('zeus_message').select(MESSAGE_COLS).eq('from_dev_id', actor.devId).neq('kind', 'env_change').neq('via', 'system').order('created_at', { ascending: false }).limit(20),
    supabase.from('zeus_message').select(MESSAGE_COLS).eq('to_dev_id', actor.devId).in('status', open).order('created_at', { ascending: false }).limit(100),
    supabase.from('zeus_message').select(MESSAGE_COLS).eq('from_dev_id', actor.devId).in('status', open).order('created_at', { ascending: false }).limit(100),
    supabase.from('zeus_message').select('id', { count: 'exact', head: true }).eq('to_dev_id', actor.devId).is('read_at', null),
    listRequests('to_me', actor),
    listRequests('mine', actor, 30),
  ]);
  for (const r of [inbox, envs, sent, openForMe, waiting, unread]) if (r.error) throw r.error;
  const lists = [inbox, envs, sent, openForMe, waiting].map((r) => (r.data ?? []) as MessageRow[]);
  const all = await hydrate(lists.flat());
  const byId = new Map(all.map((m) => [m.id, m]));
  const [messages, envMsgs, sentMsgs, openMsgs, waitingMsgs] = lists.map((rows) => rows.map((r) => byId.get(r.id)!));
  return {
    messages: messages!,
    envChanges: envMsgs!,
    sent: sentMsgs!,
    open: openMsgs!,
    waiting: waitingMsgs!,
    toResolve,
    mine,
    unread: unread.count ?? 0,
  };
}

export interface MessageHistoryQuery {
  /** received = lo que me mandaron; sent = lo que mandé. */
  box?: 'received' | 'sent';
  kind?: ZeusMessageKind | null;
  /** La otra persona (quien lo mandó si box=received, a quien si box=sent): id, nombre o correo. */
  with?: string | null;
  projectKey?: string | null;
  /** Texto en el asunto o el cuerpo. */
  q?: string | null;
  /** Paginación: trae lo anterior a esta fecha (ISO). */
  before?: string | null;
  limit?: number;
}

/**
 * Historial completo de la bandeja, leído y no leído, con filtros. Es lo que permite volver a abrir
 * un mensaje viejo: la bandeja muestra lo reciente y lo pendiente; esto, todo.
 */
export async function messageHistory(query: MessageHistoryQuery, actor: ZeusActor): Promise<{ messages: ZeusMessage[]; nextBefore: string | null }> {
  const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
  const box = query.box ?? 'received';
  let q = db().from('zeus_message').select(MESSAGE_COLS);
  q = box === 'sent' ? q.eq('from_dev_id', actor.devId).neq('kind', 'env_change').neq('via', 'system') : q.eq('to_dev_id', actor.devId);
  if (query.kind) q = q.eq('kind', query.kind);
  if (query.with?.trim()) {
    const other = await findDev(query.with);
    q = box === 'sent' ? q.eq('to_dev_id', other.id) : q.eq('from_dev_id', other.id);
  }
  if (query.projectKey?.trim()) q = q.eq('project_id', (await resolveProject(query.projectKey)).id);
  const text = query.q?.trim().replace(/[%_,()\\]/g, ' ').trim();
  if (text) q = q.or(`subject.ilike.%${text}%,body.ilike.%${text}%`);
  if (query.before && !Number.isNaN(Date.parse(query.before))) q = q.lt('created_at', new Date(query.before).toISOString());
  const { data, error } = await q.order('created_at', { ascending: false }).limit(limit + 1);
  if (error) throw error;
  const rows = (data ?? []) as MessageRow[];
  const page = rows.slice(0, limit);
  return { messages: await hydrate(page), nextBefore: rows.length > limit ? page[page.length - 1]!.created_at : null };
}

/** Origen público de zeus, tal como lo ve quien llama (detrás del proxy de Railway o del rewrite). */
export function publicOrigin(req: { url: string; header: (k: string) => string | undefined }): string {
  if (config.zeus.publicUrl) return config.zeus.publicUrl;
  const u = new URL(req.url);
  const proto = req.header('x-forwarded-proto')?.split(',')[0]?.trim() || u.protocol.replace(':', '');
  const host = req.header('x-forwarded-host')?.split(',')[0]?.trim() || req.header('host') || u.host;
  return `${proto}://${host}`;
}

export async function getMe(actor: ZeusActor, origin: string): Promise<ZeusMe> {
  const supabase = db();
  const [unread, openForMe, pending, noAdmin] = await Promise.all([
    supabase.from('zeus_message').select('id', { count: 'exact', head: true }).eq('to_dev_id', actor.devId).is('read_at', null),
    supabase.from('zeus_message').select('id', { count: 'exact', head: true }).eq('to_dev_id', actor.devId).in('status', [...ZEUS_OPEN_STATUSES]),
    listRequests('to_me', actor),
    needsAdmin(),
  ]);
  if (unread.error) throw unread.error;
  if (openForMe.error) throw openForMe.error;
  return {
    devId: actor.devId,
    name: actor.name,
    zeusAdmin: actor.admin,
    needsAdmin: noAdmin,
    unreadMessages: unread.count ?? 0,
    pendingForMe: pending.length,
    openForMe: openForMe.count ?? 0,
    mcpUrl: `${origin}/mcp`,
    apiUrl: origin,
  };
}

// ---------------------------------------------------------------- tokens

function toToken(r: { id: string; name: string; token_prefix: string; last_used_at: string | null; created_at: string }): ZeusTokenSummary {
  return { id: r.id, name: r.name, prefix: r.token_prefix, lastUsedAt: r.last_used_at, createdAt: r.created_at };
}

const TOKEN_COLS = 'id, name, token_prefix, last_used_at, created_at';
const MAX_TOKENS_PER_DEV = 10;

export async function listTokens(actor: ZeusActor): Promise<ZeusTokenSummary[]> {
  const { data, error } = await db().from('zeus_token').select(TOKEN_COLS).eq('dev_id', actor.devId).is('revoked_at', null).order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Parameters<typeof toToken>[0][]).map(toToken);
}

export async function createToken(name: string, actor: ZeusActor): Promise<{ token: string; summary: ZeusTokenSummary }> {
  const clean = name?.trim().slice(0, 60);
  if (!clean) throw new ValidationError('ponle un nombre al token (dónde lo vas a usar)');
  if ((await listTokens(actor)).length >= MAX_TOKENS_PER_DEV) {
    throw new AppError('ZEUS_TOKEN_LIMIT', `ya tienes ${MAX_TOKENS_PER_DEV} tokens: revoca alguno que no uses`, 409);
  }
  const token = generateZeusToken();
  const { data, error } = await db()
    .from('zeus_token')
    .insert({ dev_id: actor.devId, name: clean, token_hash: hashZeusToken(token), token_prefix: zeusTokenPrefix(token) })
    .select(TOKEN_COLS)
    .single();
  if (error) throw error;
  logActivity(actorActivity(actor), 'token.create', `dev:${actor.devId}`, { name: clean });
  return { token, summary: toToken(data as Parameters<typeof toToken>[0]) };
}

export async function revokeToken(id: string, actor: ZeusActor): Promise<void> {
  if (!isUuid(id)) throw new ValidationError('id de token inválido');
  const { data, error } = await db()
    .from('zeus_token')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('dev_id', actor.devId)
    .is('revoked_at', null)
    .select('id');
  if (error) throw error;
  if (!(data ?? []).length) throw new NotFoundError('ese token no existe o ya estaba revocado');
  logActivity(actorActivity(actor), 'token.revoke', `dev:${actor.devId}`);
}

// ---------------------------------------------------------------- actividad

export async function listActivity(sinceISO: string | null, limit = 60): Promise<{ events: ZeusActivityEvent[]; now: string }> {
  let q = db().from('zeus_activity').select('id, at, dev_id, actor, action, ref, detail');
  const since = sinceISO && !Number.isNaN(Date.parse(sinceISO)) ? new Date(sinceISO).toISOString() : null;
  if (since) q = q.gt('at', since);
  const { data, error } = await q.order('at', { ascending: false }).limit(Math.min(limit, 200));
  if (error) throw error;
  type Row = { id: number; at: string; dev_id: string | null; actor: ZeusActivityEvent['actor']; action: string; ref: string | null; detail: Record<string, unknown> | null };
  const rows = (data ?? []) as Row[];
  const names = await devNames(rows.map((r) => r.dev_id));
  return {
    events: rows.map((r) => ({
      id: Number(r.id),
      at: r.at,
      devId: r.dev_id,
      devName: r.dev_id ? (names.get(r.dev_id) ?? null) : null,
      actor: r.actor,
      action: r.action,
      ref: r.ref,
      detail: r.detail ?? {},
    })),
    now: new Date().toISOString(),
  };
}
