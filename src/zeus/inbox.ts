// Bandeja de zeus: mensajes entre devs (y sus agentes) y solicitudes de acceso/permiso que se
// enrutan solas a quien le toca decidir. También: tokens por persona y el feed de actividad.
import { db } from '../db/supabase.js';
import { config } from '../config.js';
import { pushToDev } from '../notify/push.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { inBackground } from '../utils/background.js';
import type {
  ZeusActivityEvent,
  ZeusInbox,
  ZeusMe,
  ZeusMessage,
  ZeusRequest,
  ZeusRequestKind,
  ZeusTokenSummary,
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
  zeusTokenPrefix,
  type ZeusActor,
} from './core.js';

const MAX_MESSAGE_CHARS = 8000;

interface DevLite {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  github_login: string | null;
  reports_to: string | null;
  zeus_admin: boolean | null;
}

async function activeDevs(): Promise<DevLite[]> {
  const { data, error } = await db().from('dev').select('id, name, email, role, github_login, reports_to, zeus_admin').eq('active', true).order('name');
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
  from_dev_id: string | null;
  to_dev_id: string;
  subject: string | null;
  body: string;
  ref: string | null;
  request_id: string | null;
  via: ZeusMessage['via'];
  read_at: string | null;
  created_at: string;
}

const MESSAGE_COLS = 'id, from_dev_id, to_dev_id, subject, body, ref, request_id, via, read_at, created_at';

function toMessage(m: MessageRow, names: Map<string, string>): ZeusMessage {
  return {
    id: m.id,
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
  };
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
}

export async function sendMessage(input: SendMessageInput, actor: ZeusActor): Promise<ZeusMessage> {
  const body = input.body?.trim();
  if (!body) throw new ValidationError('el mensaje está vacío');
  if (body.length > MAX_MESSAGE_CHARS) throw new ValidationError(`el mensaje pasa de ${MAX_MESSAGE_CHARS} caracteres`);
  if (input.ref && !parseRef(input.ref)) throw new ValidationError('ref inválida');
  const to = await findDev(input.to);
  const { data, error } = await db()
    .from('zeus_message')
    .insert({ from_dev_id: actor.devId, to_dev_id: to.id, subject: input.subject?.trim().slice(0, 160) || null, body, ref: input.ref ?? null, via: actor.via === 'runner' ? 'mcp' : actor.via })
    .select(MESSAGE_COLS)
    .single();
  if (error) throw error;
  logActivity(actorActivity(actor), 'message', `dev:${to.id}`, { to: to.name });
  if (to.id !== actor.devId) notify(to.id, to.email, `${actor.name} te escribió`, input.subject?.trim() || body, 'bandeja');
  return toMessage(data as MessageRow, new Map([[actor.devId, actor.name], [to.id, to.name]]));
}

/** Aviso del sistema (resolución de una solicitud, etc.). No falla la operación que lo dispara. */
async function systemMessage(toDevId: string, subject: string, body: string, requestId: string | null): Promise<void> {
  const { error } = await db().from('zeus_message').insert({ from_dev_id: null, to_dev_id: toDevId, subject, body, request_id: requestId, via: 'system' });
  if (error) throw error;
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

/**
 * A quién le toca decidir sobre un recurso, y por qué. Orden: el dueño del recurso → quien lidera
 * el proyecto → el jefe directo de quien pide → un administrador de zeus. Nunca se le enruta a uno
 * mismo: pedirse permiso a sí mismo no es un control.
 */
export async function routeFor(requesterId: string, resourceRef: string | null): Promise<Route> {
  const devs = await activeDevs();
  const byId = new Map(devs.map((d) => [d.id, d]));
  const usable = (id: string | null | undefined): DevLite | null => (id && id !== requesterId ? (byId.get(id) ?? null) : null);
  const supabase = db();

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

  const boss = usable(byId.get(requesterId)?.reports_to);
  if (boss) return { approver: boss, because: `${boss.name} es tu jefe directo y el recurso no tiene dueño asignado` };

  const admin = devs.find((d) => d.id !== requesterId && isZeusAdmin(d));
  if (admin) return { approver: admin, because: `${admin.name} administra zeus y no hay un dueño más específico` };
  return { approver: null, because: 'no hay dueño, jefe ni administrador asignado: queda abierta para quien administre zeus' };
}

export interface CreateRequestInput {
  kind?: ZeusRequestKind;
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
  const route = await routeFor(actor.devId, input.resourceRef ?? null);
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
  let received = supabase.from('zeus_message').select(MESSAGE_COLS).eq('to_dev_id', actor.devId);
  if (opts.unreadOnly) received = received.is('read_at', null);
  const [inbox, sent, unread, toResolve, mine] = await Promise.all([
    received.order('created_at', { ascending: false }).limit(limit),
    supabase.from('zeus_message').select(MESSAGE_COLS).eq('from_dev_id', actor.devId).order('created_at', { ascending: false }).limit(20),
    supabase.from('zeus_message').select('id', { count: 'exact', head: true }).eq('to_dev_id', actor.devId).is('read_at', null),
    listRequests('to_me', actor),
    listRequests('mine', actor, 30),
  ]);
  if (inbox.error) throw inbox.error;
  if (sent.error) throw sent.error;
  if (unread.error) throw unread.error;
  const rows = [...((inbox.data ?? []) as MessageRow[]), ...((sent.data ?? []) as MessageRow[])];
  const names = await devNames(rows.flatMap((m) => [m.from_dev_id, m.to_dev_id]));
  return {
    messages: ((inbox.data ?? []) as MessageRow[]).map((m) => toMessage(m, names)),
    sent: ((sent.data ?? []) as MessageRow[]).map((m) => toMessage(m, names)),
    toResolve,
    mine,
    unread: unread.count ?? 0,
  };
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
  const [unread, pending, noAdmin] = await Promise.all([
    supabase.from('zeus_message').select('id', { count: 'exact', head: true }).eq('to_dev_id', actor.devId).is('read_at', null),
    listRequests('to_me', actor),
    needsAdmin(),
  ]);
  if (unread.error) throw unread.error;
  return {
    devId: actor.devId,
    name: actor.name,
    zeusAdmin: actor.admin,
    needsAdmin: noAdmin,
    unreadMessages: unread.count ?? 0,
    pendingForMe: pending.length,
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
