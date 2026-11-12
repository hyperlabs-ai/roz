// Acceso a la base de los planes del agente (roz.agent_plan, agent_plan_event, runner) y su mapeo a
// los tipos HTTP de src/types/roz-v2.ts. Aquí vive la ÚNICA forma de cambiar el estado de un plan:
// `transitionPlan`, un update condicional que pregunta a nextPlanState y deja su evento.
import { db } from '../db/supabase.js';
import { AppError, NotFoundError } from '../utils/errors.js';
import { linearSourceOfTruth } from '../linear/enabled.js';
import { avatarFor } from '../dashboard/queries.js';
import { availableActions, normalizeSchedule, runnerOnline } from './rules.js';
import {
  PLAN_RUNNING,
  PLAN_TERMINAL,
  nextPlanState,
  type AgentPlanDetail,
  type AgentPlanEvent,
  type AgentPlanSummary,
  type PlanDevRef,
  type PlanEventKind,
  type PlanPhase,
  type PlanProgress,
  type PlanRisk,
  type PlanStatus,
  type PlanTransition,
  type RiskReason,
  type RunnerSchedule,
  type RunnerSummary,
} from '../types/roz-v2.js';
import type { TaskState } from '../tasks/states.js';

// ================================================================ flag

export const LINEAR_SOT_OFF_CODE = 'LINEAR_SOT_OFF';

/** Planes, runners y juntas solo existen con Linear como fuente de verdad (ROZ_LINEAR_SOT). */
export function assertPlansEnabled(): void {
  if (linearSourceOfTruth()) return;
  throw new AppError(
    LINEAR_SOT_OFF_CODE,
    'Los planes del agente están apagados: requieren Linear como fuente de verdad (ROZ_LINEAR_SOT).',
    409,
  );
}

// ================================================================ filas

export type ClaimableReasonValue = AgentPlanSummary['claimableReason'];

export interface PlanRow {
  id: string;
  work_item_id: string;
  linear_issue_id: string | null;
  identifier: string;
  owner_dev_id: string;
  status: PlanStatus;
  phase: PlanPhase;
  risk: PlanRisk;
  risk_reasons: RiskReason[] | null;
  repo: string | null;
  base_branch: string | null;
  branch: string | null;
  plan_md: string | null;
  plan_version: number;
  feedback: string | null;
  pr_number: number | null;
  pr_url: string | null;
  runner_id: string | null;
  lease_id: string | null;
  heartbeat_at: string | null;
  progress: PlanProgress | null;
  attempts: number;
  error: string | null;
  claimable: boolean;
  claimable_reason: ClaimableReasonValue;
  claimable_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  pulled_by_dev_id: string | null;
  pulled_at: string | null;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunnerRow {
  id: string;
  dev_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  schedule: unknown;
  max_concurrent: number;
  version: string | null;
  platform: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkItemLite {
  id: string;
  identifier: string;
  name: string;
  description: string | null;
  labels: string[] | null;
  status: TaskState;
  url: string | null;
  project_id: string | null;
  linear_id: string | null;
  linear_branch_name: string | null;
  assignee_dev_id: string | null;
}

export const WORK_ITEM_LITE = 'id, identifier, name, description, labels, status, url, project_id, linear_id, linear_branch_name, assignee_dev_id';

interface DevRow {
  id: string;
  name: string;
  github_login: string | null;
  email: string | null;
  active?: boolean;
}

// ================================================================ errores

export function planNotFound(): NotFoundError {
  return new NotFoundError('Ese plan no existe.');
}

export function planConflict(plan: Pick<PlanRow, 'status' | 'phase'>, message?: string): AppError {
  return new AppError(
    'PLAN_CONFLICT',
    message ?? `El plan está en "${plan.status}": esa acción ya no aplica.`,
    409,
    { status: plan.status, phase: plan.phase },
  );
}

// ================================================================ lecturas

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Un id que no es uuid no existe (y así no llega a Postgres como error 22P02 → 500). */
export function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

export async function getPlan(id: string): Promise<PlanRow | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await db().from('agent_plan').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as PlanRow | null) ?? null;
}

export async function getPlanOrThrow(id: string): Promise<PlanRow> {
  const row = await getPlan(id);
  if (!row) throw planNotFound();
  return row;
}

export async function getWorkItem(id: string): Promise<WorkItemLite | null> {
  const { data, error } = await db().from('work_item').select(WORK_ITEM_LITE).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as unknown as WorkItemLite | null) ?? null;
}

export async function getDev(id: string): Promise<DevRow | null> {
  const { data, error } = await db().from('dev').select('id, name, github_login, email, active').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as DevRow | null) ?? null;
}

async function devsById(ids: string[]): Promise<Map<string, DevRow>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const { data, error } = await db().from('dev').select('id, name, github_login, email').in('id', uniq);
  if (error) throw error;
  return new Map(((data ?? []) as DevRow[]).map((d) => [d.id, d]));
}

function devRef(d: DevRow | undefined, id: string): PlanDevRef {
  return d
    ? { id: d.id, name: d.name, githubLogin: d.github_login, avatarUrl: avatarFor(d.github_login) }
    : { id, name: 'Persona desconocida', githubLogin: null, avatarUrl: null };
}

// ================================================================ transiciones

export interface TransitionOpts {
  /** Persona que actúa (dashboard) o null (runner / roz). */
  actorDevId?: string | null;
  runnerId?: string | null;
  event: PlanEventKind;
  data?: Record<string, unknown>;
  /** Columnas extra a escribir junto con status/phase. */
  patch?: Record<string, unknown>;
  /**
   * Con qué se condiciona el update (la "versión" leída):
   *  · 'updated_at' — acciones de personas y encolado: nadie tocó el plan desde que se leyó.
   *  · 'lease'      — el runner: sigue siendo SU lease (el latido no cambia updated_at).
   *  · 'heartbeat'  — el watchdog: ningún latido llegó desde que se leyó.
   */
  guard: 'updated_at' | 'lease' | 'heartbeat';
  /** Igualdades extra (p.ej. owner_dev_id leído al reclamar). */
  extraEq?: Record<string, string>;
  now?: Date;
}

/**
 * Aplica una transición del plan. El estado nuevo lo decide nextPlanState (null → 409 PLAN_CONFLICT).
 * Update condicional: si 0 filas cambiaron, otro llegó primero → 409 PLAN_TAKEN con quién lo tiene.
 * Si la transición suelta el runner, limpia runner/lease/latido (lo exige agent_plan_running_check);
 * si termina (hecho/jalado/cancelado), sella finished_at. Deja SIEMPRE su agent_plan_event.
 */
export async function transitionPlan(row: PlanRow, t: PlanTransition, opts: TransitionOpts): Promise<PlanRow> {
  const next = nextPlanState(row, t);
  if (!next) throw planConflict(row);
  const now = (opts.now ?? new Date()).toISOString();

  const update: Record<string, unknown> = {
    status: next.status,
    phase: next.phase,
    updated_at: now,
    ...opts.patch,
  };
  if (next.releasesRunner) {
    update.runner_id = null;
    update.lease_id = null;
    update.heartbeat_at = null;
  }
  if (PLAN_TERMINAL.includes(next.status)) update.finished_at = now;
  else if (next.status === 'en_cola' || next.status === 'esperando_aprobacion') update.finished_at = null;

  let q = db().from('agent_plan').update(update).eq('id', row.id).eq('status', row.status);
  if (opts.guard === 'updated_at') q = q.eq('updated_at', row.updated_at);
  if (opts.guard === 'lease' || opts.guard === 'heartbeat') {
    if (!row.lease_id) throw planConflict(row);
    q = q.eq('lease_id', row.lease_id);
  }
  if (opts.guard === 'heartbeat') q = row.heartbeat_at ? q.eq('heartbeat_at', row.heartbeat_at) : q.is('heartbeat_at', null);
  for (const [k, v] of Object.entries(opts.extraEq ?? {})) q = q.eq(k, v);

  const { data, error } = await q.select('*');
  if (error) {
    // Soltar un plan jalado lo devuelve a la cola: si mientras tanto se encoló otro para el mismo
    // issue, el índice de "un plan vivo por issue" lo impide.
    if ((error as { code?: string }).code === '23505') {
      throw planConflict(row, 'Ese issue ya tiene otro plan en curso.');
    }
    throw error;
  }
  const updated = ((data ?? []) as PlanRow[])[0];
  if (!updated) throw await planTaken(row.id);

  await insertPlanEvent({
    planId: row.id,
    kind: opts.event,
    fromStatus: row.status,
    toStatus: updated.status,
    actorDevId: opts.actorDevId ?? null,
    runnerId: opts.runnerId ?? null,
    data: opts.data ?? {},
  });
  return updated;
}

/** 409 PLAN_TAKEN con el estado actual y quién lo tiene ahora (para el mensaje del perdedor). */
export async function planTaken(planId: string): Promise<AppError> {
  const current = await getPlan(planId);
  if (!current) return planNotFound();
  const devs = await devsById([current.owner_dev_id, current.pulled_by_dev_id ?? '']);
  const owner = devs.get(current.owner_dev_id);
  const pulled = current.pulled_by_dev_id ? devs.get(current.pulled_by_dev_id) : undefined;
  const who = current.status === 'jalado' ? pulled : owner;
  return new AppError(
    'PLAN_TAKEN',
    who ? `Alguien llegó primero: ahora lo tiene ${who.name} (${current.status}).` : 'Alguien cambió el plan primero.',
    409,
    {
      status: current.status,
      phase: current.phase,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      pulledBy: pulled ? { id: pulled.id, name: pulled.name } : null,
    },
  );
}

export async function insertPlanEvent(e: {
  planId: string;
  kind: PlanEventKind;
  fromStatus: PlanStatus | null;
  toStatus: PlanStatus | null;
  actorDevId: string | null;
  runnerId: string | null;
  data: Record<string, unknown>;
}): Promise<void> {
  const { error } = await db().from('agent_plan_event').insert({
    plan_id: e.planId,
    kind: e.kind,
    from_status: e.fromStatus,
    to_status: e.toStatus,
    actor_dev_id: e.actorDevId,
    runner_id: e.runnerId,
    data: e.data,
  });
  if (error) throw error;
}

// ================================================================ mapeo → HTTP

interface Hydration {
  items: Map<string, WorkItemLite>;
  projects: Map<string, string>;
  devs: Map<string, DevRow>;
  runners: Map<string, string>;
}

async function hydrate(rows: PlanRow[]): Promise<Hydration> {
  const supabase = db();
  const itemIds = [...new Set(rows.map((r) => r.work_item_id))];
  const runnerIds = [...new Set(rows.map((r) => r.runner_id).filter((x): x is string => !!x))];

  const [itemsRes, runnersRes] = await Promise.all([
    itemIds.length ? supabase.from('work_item').select(WORK_ITEM_LITE).in('id', itemIds) : Promise.resolve({ data: [], error: null }),
    runnerIds.length ? supabase.from('runner').select('id, name').in('id', runnerIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (itemsRes.error) throw itemsRes.error;
  if (runnersRes.error) throw runnersRes.error;
  const items = new Map(((itemsRes.data ?? []) as unknown as WorkItemLite[]).map((w) => [w.id, w]));

  const projectIds = [...new Set([...items.values()].map((w) => w.project_id).filter((x): x is string => !!x))];
  const projRes = projectIds.length
    ? await supabase.from('project').select('id, name').in('id', projectIds)
    : { data: [], error: null };
  if (projRes.error) throw projRes.error;

  const devs = await devsById(rows.flatMap((r) => [r.owner_dev_id, r.pulled_by_dev_id ?? '']));
  return {
    items,
    projects: new Map(((projRes.data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name])),
    devs,
    runners: new Map(((runnersRes.data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name])),
  };
}

function toSummary(row: PlanRow, h: Hydration, viewerDevId: string): AgentPlanSummary {
  const item = h.items.get(row.work_item_id);
  const projectId = item?.project_id ?? null;
  return {
    id: row.id,
    workItemId: row.work_item_id,
    identifier: row.identifier,
    linearIssueId: row.linear_issue_id,
    issue: {
      name: item?.name ?? row.identifier,
      url: item?.url ?? null,
      status: item?.status ?? 'pendiente',
      projectId,
      projectName: projectId ? h.projects.get(projectId) ?? null : null,
    },
    owner: devRef(h.devs.get(row.owner_dev_id), row.owner_dev_id),
    status: row.status,
    phase: row.phase,
    risk: row.risk,
    riskReasons: row.risk_reasons ?? [],
    repo: row.repo,
    branch: row.branch,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    progress: row.progress,
    runner: row.runner_id ? { id: row.runner_id, name: h.runners.get(row.runner_id) ?? 'runner' } : null,
    heartbeatAt: row.heartbeat_at,
    attempts: row.attempts,
    error: row.error,
    claimable: row.claimable,
    claimableReason: row.claimable_reason,
    pulledBy: row.pulled_by_dev_id ? devRef(h.devs.get(row.pulled_by_dev_id), row.pulled_by_dev_id) : null,
    enqueuedAt: row.enqueued_at,
    updatedAt: row.updated_at,
    actions: availableActions(
      { status: row.status, phase: row.phase, risk: row.risk, ownerDevId: row.owner_dev_id, pulledByDevId: row.pulled_by_dev_id },
      viewerDevId,
    ),
  };
}

export async function toSummaries(rows: PlanRow[], viewerDevId: string): Promise<AgentPlanSummary[]> {
  if (!rows.length) return [];
  const h = await hydrate(rows);
  return rows.map((r) => toSummary(r, h, viewerDevId));
}

export async function toSummaryOne(row: PlanRow, viewerDevId: string): Promise<AgentPlanSummary> {
  const [s] = await toSummaries([row], viewerDevId);
  return s!;
}

export async function toDetail(row: PlanRow, viewerDevId: string): Promise<AgentPlanDetail> {
  const summary = await toSummaryOne(row, viewerDevId);
  const { data, error } = await db()
    .from('agent_plan_event')
    .select('id, kind, from_status, to_status, actor_dev_id, runner_id, data, created_at')
    .eq('plan_id', row.id)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  type EvRow = {
    id: string;
    kind: PlanEventKind;
    from_status: PlanStatus | null;
    to_status: PlanStatus | null;
    actor_dev_id: string | null;
    runner_id: string | null;
    data: Record<string, unknown> | null;
    created_at: string;
  };
  const evs = (data ?? []) as EvRow[];
  const devs = await devsById(evs.map((e) => e.actor_dev_id ?? ''));
  const runnerIds = [...new Set(evs.map((e) => e.runner_id).filter((x): x is string => !!x))];
  const runnersRes = runnerIds.length ? await db().from('runner').select('id, name').in('id', runnerIds) : { data: [], error: null };
  if (runnersRes.error) throw runnersRes.error;
  const runners = new Map(((runnersRes.data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name]));

  const events: AgentPlanEvent[] = evs.map((e) => ({
    id: e.id,
    kind: e.kind,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    actor: e.actor_dev_id ? { id: e.actor_dev_id, name: devs.get(e.actor_dev_id)?.name ?? 'Persona desconocida' } : null,
    runner: e.runner_id ? { id: e.runner_id, name: runners.get(e.runner_id) ?? 'runner' } : null,
    data: e.data ?? {},
    createdAt: e.created_at,
  }));
  return {
    ...summary,
    planMd: row.plan_md,
    planVersion: row.plan_version,
    feedback: row.feedback,
    baseBranch: row.base_branch,
    events,
  };
}

// ---------------------------------------------------------------- runners

export async function toRunnerSummaries(rows: RunnerRow[], now: Date = new Date()): Promise<RunnerSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [devs, runningRes] = await Promise.all([
    devsById(rows.map((r) => r.dev_id)),
    db().from('agent_plan').select('runner_id').in('runner_id', ids).in('status', [...PLAN_RUNNING]),
  ]);
  if (runningRes.error) throw runningRes.error;
  const running = new Map<string, number>();
  for (const r of (runningRes.data ?? []) as { runner_id: string }[]) running.set(r.runner_id, (running.get(r.runner_id) ?? 0) + 1);
  return rows.map((r) => toRunnerSummary(r, devs.get(r.dev_id)?.name ?? 'Persona desconocida', running.get(r.id) ?? 0, now));
}

export function toRunnerSummary(r: RunnerRow, devName: string, running: number, now: Date = new Date()): RunnerSummary {
  const schedule: RunnerSchedule = normalizeSchedule(r.schedule);
  return {
    id: r.id,
    devId: r.dev_id,
    devName,
    name: r.name,
    tokenPrefix: r.token_prefix,
    schedule,
    maxConcurrent: r.max_concurrent,
    version: r.version,
    platform: r.platform,
    lastSeenAt: r.last_seen_at,
    online: !r.revoked_at && runnerOnline(r.last_seen_at, now),
    revokedAt: r.revoked_at,
    running,
    createdAt: r.created_at,
  };
}

export { devsById };
