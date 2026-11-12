// Pulso del equipo (roz v2): la pantalla principal del dashboard. Una sola lectura que junta lo que
// ya existe —commits, PRs, el espejo de issues, el calendario, los planes del agente y sus runners—
// en una tarjeta por persona, KPIs de la semana, un mapa de calor y un feed en vivo.
//
// No escribe nada y funciona con el flag ROZ_LINEAR_SOT apagado: es lectura pura (contrato (b)).
// Por eso TODA consulta a lo nuevo de la migración 0036 (columnas linear_*, agent_plan, meeting,
// client_email_domains) es TOLERANTE: si la migración aún no se aplicó, esa parte llega vacía y el
// resto del Pulso se pinta igual, en vez de tumbar la pantalla principal con un 500.
//
// Las funciones de tiempo y de derivación (semana, estado de la persona, grupos) son puras y se
// prueban sin base en test/pulse.test.ts.
import { db } from '../db/supabase.js';
import { config } from '../config.js';
import { TEAM_TZ, todayLocal } from '../utils/team-time.js';
import { getTeamPresence, type DevPresence } from '../calendar/presence.js';
import { avatarFor } from './queries.js';
import type { TaskState } from '../tasks/states.js';
import {
  PLAN_RUNNING,
  PLAN_TERMINAL,
  type PersonState,
  type PlanPhase,
  type PlanProgress,
  type PlanStatus,
  type PulseFeedItem,
  type PulseFeedKind,
  type PulseFeedResponse,
  type PulseGroup,
  type PulseGroupBy,
  type PulseHeatCell,
  type PulseKpis,
  type PulsePerson,
  type PulseResponse,
  type RozV2Status,
} from '../types/roz-v2.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** "activo" = hubo commit o evento de plan en esta ventana. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const FEED_DEFAULT_LIMIT = 50;

// ================================================================ estado de roz v2

/** Qué partes de roz v2 están encendidas. Lectura de configuración: no toca la base. */
export function getRozV2Status(): RozV2Status {
  return {
    linearSourceOfTruth: config.linear.sourceOfTruth,
    linearConfigured: Boolean(config.linear.apiKey),
    granolaEnabled: Boolean(config.granola.apiKey),
  };
}

// ================================================================ tiempo (zona del equipo)

/** Diferencia (ms) entre la hora local del equipo y UTC en un instante. México hoy es fijo (-6), pero
 *  se calcula con Intl para no casar el código con una zona sin horario de verano. */
function tzOffsetMs(at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TEAM_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const p: Record<string, number> = {};
  for (const x of parts) if (x.type !== 'literal') p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Medianoche de `day` (YYYY-MM-DD) en la zona del equipo, como instante UTC. */
export function zonedMidnight(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!);
  return new Date(guess - tzOffsetMs(guess));
}

/** Día (YYYY-MM-DD) y hora (0-23) de un instante en la zona del equipo. */
export function localDayHour(iso: string): { day: string; hour: number } {
  const at = new Date(iso).getTime();
  const local = new Date(at + tzOffsetMs(at));
  return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** Lunes (YYYY-MM-DD) de la semana de `now` en la zona del equipo. */
export function weekStartFor(now: Date = new Date()): string {
  const today = todayLocal(now);
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0 = domingo
  return addDays(today, -((dow + 6) % 7));
}

/** Normaliza `weekStart` a un lunes válido; cualquier otra cosa cae al lunes actual. */
export function resolveWeekStart(raw: string | null | undefined, now: Date = new Date()): string {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return weekStartFor(now);
  const [y, m, d] = raw.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== raw) return weekStartFor(now);
  const dow = dt.getUTCDay();
  return addDays(raw, -((dow + 6) % 7));
}

/** "11:30" en la zona del equipo. */
function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-MX', { timeZone: TEAM_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

// ================================================================ derivaciones puras

/**
 * Estado de la persona (contrato): `ocupado` si el calendario la marca busy, `activo` si hubo
 * actividad en 30 min, `inactivo` si hubo actividad hoy, `fuera` si no.
 */
export function derivePersonState(input: {
  now: Date;
  lastActivityAt: string | null;
  presence: Pick<DevPresence, 'status' | 'title' | 'busyUntil' | 'stale'> | null;
}): { state: PersonState; stateDetail: string | null } {
  const { now, lastActivityAt, presence } = input;
  if (presence && presence.status === 'busy' && !presence.stale) {
    const until = presence.busyUntil ? ` hasta las ${hhmm(presence.busyUntil)}` : '';
    const what = presence.title ? `En «${presence.title}»` : 'Ocupado';
    return { state: 'ocupado', stateDetail: `${what}${until}` };
  }
  if (lastActivityAt) {
    const t = new Date(lastActivityAt).getTime();
    if (now.getTime() - t <= ACTIVE_WINDOW_MS) return { state: 'activo', stateDetail: null };
    if (localDayHour(lastActivityAt).day === todayLocal(now)) return { state: 'inactivo', stateDetail: null };
  }
  return { state: 'fuera', stateDetail: null };
}

const STATE_RANK: Record<PersonState, number> = { activo: 0, ocupado: 1, inactivo: 2, fuera: 3 };

/** Orden de las tarjetas: quien está trabajando arriba; dentro del mismo estado, lo más reciente. */
export function sortPeople(people: PulsePerson[]): PulsePerson[] {
  return [...people].sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') ||
      a.name.localeCompare(b.name, 'es'),
  );
}

/** Plan que representa a la persona en su tarjeta: lo que corre, lo que espera de ella, lo que sigue. */
const PLAN_PICK_RANK: Record<PlanStatus, number> = {
  planeando: 0,
  implementando: 0,
  esperando_aprobacion: 1,
  pr_abierto: 2,
  en_cola: 3,
  jalado: 9,
  hecho: 9,
  cancelado: 9,
};
export function pickAgentPlan<T extends { status: PlanStatus; updated_at: string }>(plans: T[]): T | null {
  const live = plans.filter((p) => !PLAN_TERMINAL.includes(p.status));
  live.sort((a, b) => PLAN_PICK_RANK[a.status] - PLAN_PICK_RANK[b.status] || b.updated_at.localeCompare(a.updated_at));
  return live[0] ?? null;
}

/** Llave del grupo `cliente` de un proyecto (contrato): dominio del cliente, el proyecto, o 'interno'. */
export function clientKeyFor(p: { id: string; name: string; kind: string; client_email_domains?: string[] | null }): {
  key: string;
  label: string;
} {
  const domain = p.client_email_domains?.find((d) => d && d.trim());
  if (domain) return { key: domain.trim().toLowerCase(), label: domain.trim().toLowerCase() };
  if (p.kind === 'client') return { key: p.id, label: p.name };
  return { key: 'interno', label: 'Interno' };
}

// ================================================================ lectura tolerante

type Row = Record<string, any>;

/** Corre la consulta; si falla (columna/tabla de 0036 aún sin aplicar), intenta el respaldo y si no, []. */
async function tolerant(primary: () => PromiseLike<{ data: any; error: any }>, fallback?: () => PromiseLike<{ data: any; error: any }>): Promise<Row[]> {
  try {
    const r = await primary();
    if (!r.error) return (r.data ?? []) as Row[];
  } catch {
    /* se intenta el respaldo */
  }
  if (!fallback) return [];
  try {
    const r = await fallback();
    return r.error ? [] : ((r.data ?? []) as Row[]);
  } catch {
    return [];
  }
}

async function inChunks(ids: string[], run: (chunk: string[]) => PromiseLike<{ data: any; error: any }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    out.push(...(await tolerant(() => run(ids.slice(i, i + 150)))));
  }
  return out;
}

// ================================================================ fuentes

interface Sources {
  devs: { id: string; name: string; github_login: string | null; active: boolean }[];
  projects: { id: string; name: string; kind: string; color: string | null; client_email_domains: string[] }[];
  commits: { sha: string; repo: string; project_id: string | null; dev_id: string | null; author_login: string | null; message: string | null; url: string | null; additions: number | null; deletions: number | null; committed_at: string }[];
  /** Issues y PRs tocados en la ventana (creados, cerrados o actualizados). */
  items: Row[];
  /** Autores (dev) de las PRs de la ventana: work_item_id → devIds. */
  prAuthors: Map<string, string[]>;
  planEvents: Row[];
  plansById: Map<string, Row>;
  meetings: Row[];
  assignments: Row[];
}

const ITEM_COLS_V2 =
  'id, identifier, name, status, project_id, assignee_dev_id, url, source, pr_number, pr_state, repo, created_at, completed_at, started_at, updated_at, linear_created_at, linear_updated_at, linear_state_name, linear_cycle';
const ITEM_COLS_V1 =
  'id, identifier, name, status, project_id, assignee_dev_id, url, source, pr_number, pr_state, repo, created_at, completed_at, started_at, updated_at, linear_created_at, linear_updated_at';

async function loadDevs(): Promise<Sources['devs']> {
  const rows = await tolerant(() => db().from('dev').select('id, name, github_login, active'));
  return rows as Sources['devs'];
}

async function loadProjects(): Promise<Sources['projects']> {
  const rows = await tolerant(
    () => db().from('project').select('id, name, kind, color, client_email_domains'),
    () => db().from('project').select('id, name, kind'),
  );
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind ?? 'internal',
    color: p.color ?? null,
    client_email_domains: Array.isArray(p.client_email_domains) ? p.client_email_domains : [],
  }));
}

/** Todo lo que el Pulso necesita desde `from` (incluido) hasta `to` (excluido). */
async function loadSources(from: string, to: string): Promise<Sources> {
  const touched = `created_at.gte.${from},completed_at.gte.${from},updated_at.gte.${from}`;
  const [devs, projects, commitRows, items, planEvents, meetings, assignments] = await Promise.all([
    loadDevs(),
    loadProjects(),
    tolerant(() =>
      db()
        .from('commit')
        .select('sha, repo, project_id, dev_id, author_login, message, url, additions, deletions, committed_at')
        .gte('committed_at', from)
        .lt('committed_at', to)
        .order('committed_at', { ascending: false }),
    ),
    tolerant(
      () => db().from('work_item').select(ITEM_COLS_V2).or(touched),
      () => db().from('work_item').select(ITEM_COLS_V1).or(touched),
    ),
    tolerant(() =>
      db()
        .from('agent_plan_event')
        .select('id, plan_id, kind, from_status, to_status, actor_dev_id, runner_id, data, created_at')
        .gte('created_at', from)
        .lt('created_at', to)
        .neq('kind', 'progress')
        .order('created_at', { ascending: false })
        .limit(500),
    ),
    tolerant(() =>
      db()
        .from('meeting')
        .select('id, title, held_at, project_id, attendees, created_by_dev_id, created_at, source')
        .gte('created_at', from)
        .lt('created_at', to),
    ),
    tolerant(() => db().from('dev_assignment').select('dev_id, project_id')),
  ]);

  // Trabajo real: cada sha una vez (un mismo commit puede vivir en dos repos tras un fork/rename).
  const seen = new Set<string>();
  const commits: Sources['commits'] = [];
  for (const c of commitRows) {
    if (!c.committed_at || seen.has(c.sha)) continue;
    seen.add(c.sha);
    commits.push(c as Sources['commits'][number]);
  }

  const prIds = items.filter((w) => w.pr_number != null).map((w) => w.id as string);
  const actorRows = prIds.length
    ? await inChunks(prIds, (c) => db().from('work_item_actor').select('work_item_id, dev_id').eq('role', 'author').in('work_item_id', c))
    : [];
  const prAuthors = new Map<string, string[]>();
  for (const a of actorRows) {
    if (!a.dev_id) continue;
    const list = prAuthors.get(a.work_item_id) ?? [];
    if (!list.includes(a.dev_id)) list.push(a.dev_id);
    prAuthors.set(a.work_item_id, list);
  }

  const planIds = [...new Set(planEvents.map((e) => e.plan_id as string))];
  const planRows = planIds.length
    ? await inChunks(planIds, (c) => db().from('agent_plan').select('id, identifier, owner_dev_id, work_item_id').in('id', c))
    : [];

  return {
    devs,
    projects,
    commits,
    items,
    prAuthors,
    planEvents,
    plansById: new Map(planRows.map((p) => [p.id as string, p])),
    meetings,
    assignments,
  };
}

// ================================================================ eventos derivados

interface ActivityEvent {
  at: string;
  devIds: string[];
  projectId: string | null;
  kind: PulseFeedKind;
  item: PulseFeedItem;
}

const PLAN_EVENT_TEXT: Record<string, string> = {
  enqueued: 'entró a la cola del agente',
  started: 'el agente empezó a trabajar',
  plan_ready: 'el agente terminó el plan',
  approved: 'plan aprobado',
  changes_requested: 'se pidieron cambios al plan',
  claimed: 'plan reclamado',
  pulled: 'lo implementa una persona',
  released: 'plan soltado',
  canceled: 'plan cancelado',
  pr_opened: 'el agente abrió la PR',
  done: 'plan terminado',
  requeued: 'regresó a la cola (sin latido)',
  failed: 'el agente falló',
  claimable: 'quedó disponible para reclamar',
};

function firstLine(s: string | null | undefined, max = 90): string {
  const line = (s ?? '').split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** PR abierta: la fecha más cercana que tenemos (las de origen PR nacen al mergear). */
function prOpenedAt(w: Row): string | null {
  return (w.started_at as string | null) ?? (w.created_at as string | null);
}

/** Todo lo que pasó en la ventana como eventos con persona, proyecto y texto del feed. */
function buildEvents(s: Sources, from: string, to: string): ActivityEvent[] {
  const name = new Map(s.devs.map((d) => [d.id, d.name]));
  const who = (id: string | null | undefined) => (id ? name.get(id) ?? 'Alguien' : 'Alguien');
  const inWindow = (at: string | null | undefined): at is string => !!at && at >= from && at < to;
  const out: ActivityEvent[] = [];

  for (const c of s.commits) {
    const devIds = c.dev_id ? [c.dev_id] : [];
    out.push({
      at: c.committed_at,
      devIds,
      projectId: c.project_id,
      kind: 'commit',
      item: {
        id: `commit:${c.sha}`,
        at: c.committed_at,
        kind: 'commit',
        devId: c.dev_id,
        text: `${c.dev_id ? who(c.dev_id) : c.author_login ?? 'Alguien'} hizo commit en ${c.repo.split('/').pop()}: ${firstLine(c.message)}`,
        identifier: null,
        url: c.url,
        projectId: c.project_id,
      },
    });
  }

  for (const w of s.items) {
    const isPr = w.pr_number != null;
    const ref = (w.identifier as string | null) ?? null;
    const title = firstLine(w.name as string, 80);
    if (isPr) {
      const authors = s.prAuthors.get(w.id) ?? (w.assignee_dev_id ? [w.assignee_dev_id as string] : []);
      const opened = prOpenedAt(w);
      if (inWindow(opened) && w.source !== 'pr') {
        out.push({
          at: opened,
          devIds: authors,
          projectId: w.project_id,
          kind: 'pr_opened',
          item: { id: `pr_opened:${w.id}`, at: opened, kind: 'pr_opened', devId: authors[0] ?? null, text: `${who(authors[0])} abrió la PR #${w.pr_number}: ${title}`, identifier: ref, url: w.url, projectId: w.project_id },
        });
      }
      if (w.pr_state === 'merged' && inWindow(w.completed_at)) {
        out.push({
          at: w.completed_at,
          devIds: authors,
          projectId: w.project_id,
          kind: 'pr_merged',
          item: { id: `pr_merged:${w.id}`, at: w.completed_at, kind: 'pr_merged', devId: authors[0] ?? null, text: `Se integró la PR #${w.pr_number}: ${title}`, identifier: ref, url: w.url, projectId: w.project_id },
        });
      }
    }
    // Issues: lo que no nació de código (nativas, Linear, histórico). Las de origen PR/commit ya
    // cuentan arriba como PR; contarlas también como issue duplicaría el feed.
    if (w.source === 'pr' || w.source === 'commit') continue;
    const created = (w.linear_created_at as string | null) ?? (w.created_at as string | null);
    const assignee = (w.assignee_dev_id as string | null) ?? null;
    if (inWindow(created)) {
      out.push({
        at: created,
        devIds: assignee ? [assignee] : [],
        projectId: w.project_id,
        kind: 'issue_created',
        item: { id: `issue_created:${w.id}`, at: created, kind: 'issue_created', devId: assignee, text: `Nuevo issue${ref ? ` ${ref}` : ''}: ${title}${assignee ? ` → ${who(assignee)}` : ''}`, identifier: ref, url: w.url, projectId: w.project_id },
      });
    }
    if (w.status === 'completada' && inWindow(w.completed_at)) {
      out.push({
        at: w.completed_at,
        devIds: assignee ? [assignee] : [],
        projectId: w.project_id,
        kind: 'issue_closed',
        item: { id: `issue_closed:${w.id}`, at: w.completed_at, kind: 'issue_closed', devId: assignee, text: `${assignee ? `${who(assignee)} cerró` : 'Se cerró'} ${ref ?? 'un issue'}: ${title}`, identifier: ref, url: w.url, projectId: w.project_id },
      });
    }
  }

  for (const e of s.planEvents) {
    if (!inWindow(e.created_at)) continue;
    const plan = s.plansById.get(e.plan_id);
    const owner = (plan?.owner_dev_id as string | null) ?? null;
    const actor = (e.actor_dev_id as string | null) ?? null;
    const devId = actor ?? owner;
    const what = PLAN_EVENT_TEXT[e.kind as string] ?? (e.kind as string);
    const ident = (plan?.identifier as string | null) ?? null;
    const byWho = actor && e.kind !== 'started' ? ` (${who(actor)})` : '';
    out.push({
      at: e.created_at,
      devIds: [...new Set([owner, actor].filter((x): x is string => !!x))],
      projectId: null,
      kind: 'plan',
      item: { id: `plan:${e.id}`, at: e.created_at, kind: 'plan', devId, text: `${ident ?? 'Plan'}: ${what}${byWho}`, identifier: ident, url: null, projectId: null },
    });
  }

  for (const m of s.meetings) {
    if (!inWindow(m.created_at)) continue;
    const n = Array.isArray(m.attendees) ? m.attendees.length : 0;
    out.push({
      at: m.created_at,
      devIds: m.created_by_dev_id ? [m.created_by_dev_id] : [],
      projectId: m.project_id ?? null,
      kind: 'meeting',
      item: {
        id: `meeting:${m.id}`,
        at: m.created_at,
        kind: 'meeting',
        devId: m.created_by_dev_id ?? null,
        text: `Junta «${firstLine(m.title, 70)}»${n ? ` · ${n} asistente${n === 1 ? '' : 's'}` : ''}${m.source === 'granola' ? ' (Granola)' : ''}`,
        identifier: null,
        url: null,
        projectId: m.project_id ?? null,
      },
    });
  }

  return out.sort((a, b) => b.at.localeCompare(a.at));
}

// ================================================================ infraestructura (historial)

/** Estados de un servicio que cuentan como "caído" (mismo criterio que el sondeo de infra). */
const INFRA_DOWN = new Set(['down', 'paused', 'degraded']);
const DEPLOY_OK = new Set(['READY', 'SUCCESS', 'ACTIVE_HEALTHY', 'COMPLETED']);
const DEPLOY_BAD = new Set(['ERROR', 'FAILED', 'CRASHED', 'CANCELED', 'REMOVED']);
const INFRA_STATUS_TEXT: Record<string, string> = { down: 'se cayó', paused: 'quedó en pausa', degraded: 'está degradado' };

/**
 * Deploys y cambios de salud de los servicios vinculados, como eventos del historial del Pulso.
 *
 * Sale del histórico de sondeos (`service_snapshot`, uno cada 15 min por servicio): un deploy es un
 * `deploy.createdAt` nuevo dentro de la ventana (con el estado del último sondeo que lo vio) y un
 * cambio de salud es una transición entre estados reales (se ignora `unknown` = no se pudo consultar).
 *
 * Estos eventos NO llevan `devIds`: no cuentan para KPIs, mapa de calor ni "última actividad" de
 * nadie. Son contexto del historial, no trabajo de una persona. Tolerante: sin tablas de infra (o
 * sin servicios vinculados) devuelve [].
 */
async function loadInfraEvents(from: string, to: string, devs: Sources['devs']): Promise<ActivityEvent[]> {
  const services = await tolerant(() => db().from('project_service').select('id, project_id, provider, external_ref, label'));
  if (!services.length) return [];
  const byLogin = new Map(devs.filter((d) => d.github_login).map((d) => [d.github_login!.toLowerCase(), d.id]));

  const perService = await Promise.all(
    services.map((s) =>
      tolerant(() =>
        db()
          .from('service_snapshot')
          .select('status, captured_at, deploy_at:deploy->>createdAt, deploy_state:deploy->>state, deploy_sha:deploy->>sha, deploy_msg:deploy->>commitMessage, deploy_url:deploy->>url, deploy_author:deploy->>author')
          .eq('project_service_id', s.id)
          .gte('captured_at', from)
          .lt('captured_at', to)
          .order('captured_at', { ascending: true })
          .limit(1000),
      ),
    ),
  );

  const out: ActivityEvent[] = [];
  services.forEach((s, i) => {
    const rows = perService[i] ?? [];
    const label = (s.label as string | null) || (s.external_ref as string);
    const provider = (s.provider as string) ?? null;
    const projectId = (s.project_id as string | null) ?? null;

    // Deploys: uno por `createdAt`, con el estado del ÚLTIMO sondeo que lo vio (BUILDING → READY).
    const deploys = new Map<string, Row>();
    for (const r of rows) if (r.deploy_at) deploys.set(r.deploy_at as string, r);
    for (const [at, r] of deploys) {
      if (at < from || at >= to) continue;
      const state = String(r.deploy_state ?? '').toUpperCase();
      const tone = DEPLOY_OK.has(state) ? 'ok' : DEPLOY_BAD.has(state) ? 'bad' : 'pending';
      const author = r.deploy_author ? byLogin.get(String(r.deploy_author).toLowerCase()) ?? null : null;
      const verb = tone === 'ok' ? 'Deploy listo' : tone === 'bad' ? 'Falló el deploy' : 'Deploy en curso';
      const msg = firstLine(r.deploy_msg as string | null, 70);
      out.push({
        at,
        devIds: [],
        projectId,
        kind: 'deploy',
        item: {
          id: `deploy:${s.id}:${at}`,
          at,
          kind: 'deploy',
          devId: author,
          text: `${verb} · ${label}${msg ? `: ${msg}` : ''}`,
          identifier: (r.deploy_sha as string | null)?.slice(0, 7) ?? null,
          url: (r.deploy_url as string | null) ?? null,
          projectId,
          provider,
          tone,
        },
      });
    }

    // Salud: transiciones entre estados reales.
    let prev: string | null = null;
    for (const r of rows) {
      const st = r.status as string;
      if (!st || st === 'unknown') continue;
      if (prev && st !== prev) {
        const down = INFRA_DOWN.has(st);
        const recovered = st === 'healthy' && INFRA_DOWN.has(prev);
        if (down || recovered) {
          out.push({
            at: r.captured_at,
            devIds: [],
            projectId,
            kind: 'infra',
            item: {
              id: `infra:${s.id}:${r.captured_at}`,
              at: r.captured_at,
              kind: 'infra',
              devId: null,
              text: recovered ? `${label} se recuperó` : `${label} ${INFRA_STATUS_TEXT[st] ?? st}`,
              identifier: null,
              url: null,
              projectId,
              provider,
              tone: recovered ? 'ok' : 'bad',
            },
          });
        }
      }
      prev = st;
    }
  });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Lo que viaja en el feed del Pulso: los `total` más recientes y, además, hasta `floor` de cada tipo
 * aunque sean más viejos. Sin el piso, una semana con cientos de commits dejaría los filtros del
 * historial (juntas, planes, infra) vacíos.
 */
export function pickFeed<T extends { at: string; kind: string }>(events: T[], total = 120, floor = 25): T[] {
  const picked = events.slice(0, total);
  const per = new Map<string, number>();
  for (const e of picked) per.set(e.kind, (per.get(e.kind) ?? 0) + 1);
  for (const e of events.slice(total)) {
    const n = per.get(e.kind) ?? 0;
    if (n >= floor) continue;
    per.set(e.kind, n + 1);
    picked.push(e);
  }
  return picked.sort((a, b) => b.at.localeCompare(a.at));
}

// ================================================================ Pulso

export interface PulseInput {
  groupBy?: PulseGroupBy;
  weekStart?: string | null;
  now?: Date;
}

export async function getPulse(input: PulseInput = {}): Promise<PulseResponse> {
  const now = input.now ?? new Date();
  const groupBy: PulseGroupBy = input.groupBy ?? 'persona';
  const weekStart = resolveWeekStart(input.weekStart, now);
  const from = zonedMidnight(weekStart).toISOString();
  const to = zonedMidnight(addDays(weekStart, 7)).toISOString();
  const prevFrom = zonedMidnight(addDays(weekStart, -7)).toISOString();
  // El estado de cada persona ("activo", "inactivo") se mide contra AHORA aunque se mire otra semana.
  // Mirando la semana actual, la ventana [semana anterior, fin de semana) ya cubre hoy; mirando una
  // semana pasada se lee aparte lo de hoy, en vez de estirar la ventana semanas enteras.
  const nowIso = now.toISOString();
  const todayFrom = zonedMidnight(todayLocal(now)).toISOString();
  const coversToday = todayFrom >= prevFrom && nowIso < to;
  const activityTo = to;

  const [src, todaySrc, presence, openItems, livePlans, donePlans, infraEvents] = await Promise.all([
    loadSources(prevFrom, activityTo),
    coversToday ? Promise.resolve(null) : loadSources(todayFrom, nowIso),
    getTeamPresence(now).catch(() => [] as DevPresence[]),
    tolerant(
      () => db().from('work_item').select(ITEM_COLS_V2).in('status', ['en_progreso', 'revision']),
      () => db().from('work_item').select(ITEM_COLS_V1).in('status', ['en_progreso', 'revision']),
    ),
    tolerant(() =>
      db()
        .from('agent_plan')
        .select('id, identifier, owner_dev_id, status, phase, progress, claimable, updated_at, work_item_id')
        .not('status', 'in', `(${PLAN_TERMINAL.join(',')})`),
    ),
    tolerant(() =>
      db().from('agent_plan').select('id').eq('status', 'hecho').gte('finished_at', from).lt('finished_at', to),
    ),
    // Solo para el historial: deploys y caídas de la semana vista (no cuentan como trabajo).
    loadDevs().then((devs) => loadInfraEvents(from, to, devs)).catch(() => [] as ActivityEvent[]),
  ]);

  const events = buildEvents(src, prevFrom, activityTo);
  const todayEvents = todaySrc ? buildEvents(todaySrc, todayFrom, nowIso) : events;
  const inWeek = (e: ActivityEvent) => e.at >= from && e.at < to;
  const inPrev = (e: ActivityEvent) => e.at >= prevFrom && e.at < from;
  const weekEvents = events.filter(inWeek);
  const count = (list: ActivityEvent[], kind: PulseFeedKind) => list.filter((e) => e.kind === kind).length;
  const prevEvents = events.filter(inPrev);

  const activeDevIds = new Set(weekEvents.flatMap((e) => e.devIds));
  const kpis: PulseKpis = {
    issuesClosed: count(weekEvents, 'issue_closed'),
    issuesOpened: count(weekEvents, 'issue_created'),
    prsOpened: count(weekEvents, 'pr_opened'),
    prsMerged: count(weekEvents, 'pr_merged'),
    commits: count(weekEvents, 'commit'),
    activeDevs: activeDevIds.size,
    plans: {
      done: donePlans.length,
      running: livePlans.filter((p) => PLAN_RUNNING.includes(p.status)).length,
      waitingApproval: livePlans.filter((p) => p.status === 'esperando_aprobacion').length,
      claimable: livePlans.filter((p) => p.claimable).length,
    },
    previous: {
      issuesClosed: count(prevEvents, 'issue_closed'),
      prsMerged: count(prevEvents, 'pr_merged'),
      commits: count(prevEvents, 'commit'),
    },
  };

  // ---- personas
  const projById = new Map(src.projects.map((p) => [p.id, p]));
  const presenceByDev = new Map(presence.map((p) => [p.devId, p]));
  const lastActivity = new Map<string, string>();
  for (const e of todaySrc ? [...events, ...todayEvents] : events) {
    if (e.at > nowIso) continue;
    for (const d of e.devIds) if (!lastActivity.has(d) || lastActivity.get(d)! < e.at) lastActivity.set(d, e.at);
  }
  // Un plan corriendo con latido reciente también es actividad del dueño (su PC está trabajando).
  for (const p of livePlans) {
    if (!PLAN_RUNNING.includes(p.status) || !p.updated_at) continue;
    const d = p.owner_dev_id as string;
    if (!lastActivity.has(d) || lastActivity.get(d)! < p.updated_at) lastActivity.set(d, p.updated_at);
  }

  // Issue actual: en_progreso más reciente; si no, el de revisión.
  const currentByDev = new Map<string, Row>();
  const rankItem = (w: Row) => (w.status === 'en_progreso' ? 0 : 1);
  const stamp = (w: Row) => ((w.linear_updated_at as string | null) ?? (w.updated_at as string | null) ?? '');
  for (const w of openItems) {
    const d = w.assignee_dev_id as string | null;
    if (!d || w.source === 'pr' || w.source === 'commit') continue;
    const cur = currentByDev.get(d);
    if (!cur || rankItem(w) < rankItem(cur) || (rankItem(w) === rankItem(cur) && stamp(w) > stamp(cur))) currentByDev.set(d, w);
  }

  // Avance del ciclo: los issues de cada persona en el ciclo de su issue actual.
  const cycleIds = [
    ...new Set(
      [...currentByDev.values()].map((w) => (w.linear_cycle as { id?: string } | null)?.id).filter((x): x is string => !!x),
    ),
  ];
  const cycleRows = cycleIds.length
    ? await tolerant(() => db().from('work_item').select('status, assignee_dev_id, linear_cycle').in('linear_cycle->>id', cycleIds))
    : [];

  const plansByOwner = new Map<string, Row[]>();
  for (const p of livePlans) {
    const list = plansByOwner.get(p.owner_dev_id) ?? [];
    list.push(p);
    plansByOwner.set(p.owner_dev_id, list);
  }

  const projectsByDev = new Map<string, Set<string>>();
  const addProj = (d: string | null | undefined, p: string | null | undefined) => {
    if (!d || !p || !projById.has(p)) return;
    const set = projectsByDev.get(d) ?? new Set<string>();
    set.add(p);
    projectsByDev.set(d, set);
  };
  for (const a of src.assignments) addProj(a.dev_id, a.project_id);
  for (const e of weekEvents) for (const d of e.devIds) addProj(d, e.projectId);

  const weekByDev = new Map<string, PulsePerson['week']>();
  const weekOf = (d: string) => {
    let w = weekByDev.get(d);
    if (!w) weekByDev.set(d, (w = { commits: 0, lines: 0, prsOpened: 0, prsMerged: 0, issuesClosed: 0 }));
    return w;
  };
  for (const c of src.commits) {
    if (!c.dev_id || c.committed_at < from || c.committed_at >= to) continue;
    const w = weekOf(c.dev_id);
    w.commits += 1;
    w.lines += (c.additions ?? 0) + (c.deletions ?? 0);
  }
  for (const e of weekEvents) {
    for (const d of e.devIds) {
      if (e.kind === 'pr_opened') weekOf(d).prsOpened += 1;
      else if (e.kind === 'pr_merged') weekOf(d).prsMerged += 1;
      else if (e.kind === 'issue_closed') weekOf(d).issuesClosed += 1;
    }
  }

  const people: PulsePerson[] = src.devs
    .filter((d) => d.active)
    .map((d) => {
      const cur = currentByDev.get(d.id) ?? null;
      const cyc = (cur?.linear_cycle as { id?: string; number?: number; name?: string | null; endsAt?: string; progress?: number } | null) ?? null;
      let cycle: PulsePerson['cycle'] = null;
      if (cyc?.id && cyc.endsAt) {
        const mine = cycleRows.filter((r) => r.assignee_dev_id === d.id && (r.linear_cycle as { id?: string } | null)?.id === cyc.id);
        cycle = {
          name: cyc.name ?? null,
          number: Number(cyc.number ?? 0),
          progress: Math.max(0, Math.min(1, Number(cyc.progress ?? 0))),
          endsAt: cyc.endsAt,
          issuesDone: mine.filter((r) => r.status === 'completada').length,
          issuesTotal: mine.filter((r) => r.status !== 'cancelada').length,
        };
      }
      const plan = pickAgentPlan((plansByOwner.get(d.id) ?? []) as { status: PlanStatus; updated_at: string }[]) as Row | null;
      const last = lastActivity.get(d.id) ?? null;
      const { state, stateDetail } = derivePersonState({ now, lastActivityAt: last, presence: presenceByDev.get(d.id) ?? null });
      return {
        devId: d.id,
        name: d.name,
        githubLogin: d.github_login,
        avatarUrl: avatarFor(d.github_login),
        state,
        stateDetail,
        currentIssue: cur
          ? {
              workItemId: cur.id,
              identifier: cur.identifier,
              name: cur.name,
              status: cur.status as TaskState,
              linearStateName: (cur.linear_state_name as string | null) ?? null,
              url: cur.url ?? null,
              projectId: cur.project_id ?? null,
            }
          : null,
        agentPlan: plan
          ? {
              id: plan.id,
              identifier: plan.identifier,
              status: plan.status as PlanStatus,
              phase: plan.phase as PlanPhase,
              progress: (plan.progress as PlanProgress | null) ?? null,
            }
          : null,
        cycle,
        week: weekByDev.get(d.id) ?? { commits: 0, lines: 0, prsOpened: 0, prsMerged: 0, issuesClosed: 0 },
        projects: [...(projectsByDev.get(d.id) ?? [])].map((id) => {
          const p = projById.get(id)!;
          return { id: p.id, name: p.name, color: p.color };
        }),
        lastActivityAt: last,
      };
    });

  // ---- grupos
  const groups: PulseGroup[] = buildGroups(groupBy, people, weekEvents, src.projects);

  // ---- mapa de calor (semana vista)
  const heat = new Map<string, PulseHeatCell>();
  for (const e of weekEvents) {
    if (e.kind === 'meeting') continue;
    const { day, hour } = localDayHour(e.at);
    for (const d of e.devIds) {
      const k = `${d}|${day}|${hour}`;
      const cell = heat.get(k);
      if (cell) cell.count += 1;
      else heat.set(k, { devId: d, day, hour, count: 1 });
    }
  }

  return {
    generatedAt: now.toISOString(),
    period: { from, to },
    groupBy,
    kpis,
    people: sortPeople(people),
    groups,
    heatmap: [...heat.values()],
    // El feed es el historial filtrable del Pulso: lo reciente + un piso por tipo (ver `pickFeed`).
    feed: pickFeed([...weekEvents, ...infraEvents].sort((a, b) => b.at.localeCompare(a.at))).map((e) => e.item),
  };
}

function buildGroups(
  groupBy: PulseGroupBy,
  people: PulsePerson[],
  weekEvents: ActivityEvent[],
  projects: Sources['projects'],
): PulseGroup[] {
  if (groupBy === 'persona') {
    return people.map((p) => ({
      key: p.devId,
      label: p.name,
      devIds: [p.devId],
      kpis: { issuesClosed: p.week.issuesClosed, prsMerged: p.week.prsMerged, commits: p.week.commits },
    }));
  }

  const projById = new Map(projects.map((p) => [p.id, p]));
  const keyOf = (projectId: string): { key: string; label: string } | null => {
    const p = projById.get(projectId);
    if (!p) return null;
    return groupBy === 'proyecto' ? { key: p.id, label: p.name } : clientKeyFor(p);
  };

  const map = new Map<string, PulseGroup>();
  const ensure = (k: { key: string; label: string }) => {
    let g = map.get(k.key);
    if (!g) map.set(k.key, (g = { key: k.key, label: k.label, devIds: [], kpis: { issuesClosed: 0, prsMerged: 0, commits: 0 } }));
    return g;
  };
  for (const person of people) {
    for (const pr of person.projects) {
      const k = keyOf(pr.id);
      if (!k) continue;
      const g = ensure(k);
      if (!g.devIds.includes(person.devId)) g.devIds.push(person.devId);
    }
  }
  for (const e of weekEvents) {
    if (!e.projectId) continue;
    const k = keyOf(e.projectId);
    if (!k) continue;
    const g = ensure(k);
    if (e.kind === 'commit') g.kpis.commits += 1;
    else if (e.kind === 'pr_merged') g.kpis.prsMerged += 1;
    else if (e.kind === 'issue_closed') g.kpis.issuesClosed += 1;
  }
  return [...map.values()].sort(
    (a, b) => b.kpis.commits + b.kpis.prsMerged + b.kpis.issuesClosed - (a.kpis.commits + a.kpis.prsMerged + a.kpis.issuesClosed) || a.label.localeCompare(b.label, 'es'),
  );
}

// ================================================================ feed (poll cada 20 s)

/**
 * Lo que pasó DESPUÉS de `after`, del más nuevo al más viejo. El front lo sondea con un traslape de
 * algunos minutos y deduplica por `id` (estable entre polls): un commit puede llegar al espejo con su
 * fecha de git, más vieja que el último poll, y con el traslape no se pierde.
 */
export async function getPulseFeed(input: { after?: string | null; limit?: number; now?: Date }): Promise<PulseFeedResponse> {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? FEED_DEFAULT_LIMIT)));
  const parsed = input.after ? new Date(input.after) : null;
  const after = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(now.getTime() - DAY_MS);
  // Nunca más de 7 días hacia atrás: el feed es "en vivo", no un histórico.
  const floor = new Date(Math.max(after.getTime(), now.getTime() - 7 * DAY_MS)).toISOString();
  const upTo = new Date(now.getTime() + 60_000).toISOString();
  const src = await loadSources(floor, upTo);
  const infra = await loadInfraEvents(floor, upTo, src.devs).catch(() => [] as ActivityEvent[]);
  const events = [...buildEvents(src, floor, upTo), ...infra]
    .filter((e) => e.at > floor)
    .sort((a, b) => b.at.localeCompare(a.at));
  return { items: events.slice(0, limit).map((e) => e.item) };
}
