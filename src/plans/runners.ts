// Runners (roz-runner en la PC de cada dev): alta y revocación del token desde el dashboard, y la
// API que habla el CLI (/v1/runner/*): registro, latido, siguiente trabajo, avance y jalar. El runner
// NUNCA toca Supabase ni Linear: todo pasa por aquí, autenticado con su token (solo guardamos el hash).
import { z } from 'zod';
import { db } from '../db/supabase.js';
import { config } from '../config.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import {
  PLAN_MAX_ATTEMPTS,
  PLAN_RUNNING,
  RUNNER_ALLOWED_TOOLS_IMPLEMENT,
  RUNNER_ALLOWED_TOOLS_PLAN,
  RUNNER_HEARTBEAT_INTERVAL_MS,
  type PlanProgress,
  type RunnerHeartbeatRequest,
  type RunnerHeartbeatResponse,
  type RunnerJob,
  type RunnerNextJobResponse,
  type RunnerProgressRequest,
  type RunnerProgressResponse,
  type RunnerPullRequest,
  type RunnerPullResponse,
  type RunnerRegisterRequest,
  type RunnerRegisterResponse,
  type RunnerSchedule,
  type RunnerSummary,
} from '../types/roz-v2.js';
import { inSchedule, isValidTimeZone, nextJobRetryAfter, normalizeSchedule, NEXT_JOB_IDLE_MS, shouldLogProgress, suggestedBranch } from './rules.js';
import { buildRunnerPrompt, MAX_TURNS } from './prompt.js';
import { generateRunnerToken, hashRunnerToken, looksLikeRunnerToken, runnerTokenPrefix } from './tokens.js';
import {
  assertPlansEnabled,
  getDev,
  getPlan,
  getWorkItem,
  insertPlanEvent,
  isUuid,
  toRunnerSummaries,
  toRunnerSummary,
  transitionPlan,
  type PlanRow,
  type RunnerRow,
} from './store.js';
import { planByIdentifier, pullPlan } from './service.js';

/** Cada cuánto pregunta el runner por trabajo nuevo. */
export const RUNNER_POLL_INTERVAL_MS = 30_000;

// ================================================================ validación

export const scheduleSchema = z.object({
  tz: z.string().min(1).max(64).refine(isValidTimeZone, 'zona horaria inválida'),
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora inválida (HH:MM)'),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora inválida (HH:MM)'),
});
export const maxConcurrentSchema = z.number().int().min(1).max(8);
export const runnerNameSchema = z.string().trim().min(1).max(80);

/** z.infer marca requeridos como opcionales en el build de prod: se destructura y se fija aquí. */
function toSchedule(s: z.infer<typeof scheduleSchema>): RunnerSchedule {
  const { tz, days, start, end } = s;
  return normalizeSchedule({ tz: tz!, days: days!, start: start!, end: end! });
}

// ================================================================ dashboard: alta, lista, edición, revocación

export async function createRunner(input: {
  devId: string;
  userId: string;
  name: string;
  schedule?: z.infer<typeof scheduleSchema>;
  maxConcurrent?: number;
}): Promise<{ runner: RunnerSummary; token: string }> {
  assertPlansEnabled();
  const token = generateRunnerToken();
  const schedule = input.schedule ? toSchedule(input.schedule) : normalizeSchedule(null);
  const { data, error } = await db()
    .from('runner')
    .insert({
      dev_id: input.devId,
      name: input.name.trim(),
      token_hash: hashRunnerToken(token),
      token_prefix: runnerTokenPrefix(token),
      schedule,
      max_concurrent: input.maxConcurrent ?? 1,
      created_by: input.userId,
    })
    .select('*')
    .single();
  if (error) throw error;
  const [runner] = await toRunnerSummaries([data as RunnerRow]);
  return { runner: runner!, token };
}

export async function listRunners(input: { devId: string; all: boolean }): Promise<RunnerSummary[]> {
  assertPlansEnabled();
  let q = db().from('runner').select('*').order('created_at', { ascending: false }).limit(200);
  if (!input.all) q = q.eq('dev_id', input.devId);
  const { data, error } = await q;
  if (error) throw error;
  return toRunnerSummaries((data ?? []) as RunnerRow[]);
}

async function runnerOrThrow(id: string): Promise<RunnerRow> {
  if (!isUuid(id)) throw new NotFoundError('Ese runner no existe.');
  const { data, error } = await db().from('runner').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Ese runner no existe.');
  return data as RunnerRow;
}

/** Quién actúa sobre un runner desde el dashboard. */
export interface RunnerActor {
  devId: string;
  /** user_profiles.role: 'admin' | 'superadmin' pueden revocar runners ajenos. */
  role: string | null;
}

function isAdminRole(role: string | null): boolean {
  return role === 'admin' || role === 'superadmin';
}

/**
 * Un runner es de la PC de un dev: solo él cambia su nombre, horario o máximo. Revocar lo puede
 * hacer además un admin (token filtrado de alguien que no está). Lo ajeno responde 404, igual que
 * lo que no existe.
 */
function assertRunnerAccess(runner: RunnerRow, actor: RunnerActor, action: 'editar' | 'revocar'): void {
  if (runner.dev_id === actor.devId) return;
  if (action === 'revocar' && isAdminRole(actor.role)) return;
  throw new NotFoundError('Ese runner no existe.');
}

export async function updateRunner(
  id: string,
  patch: { name?: string; schedule?: z.infer<typeof scheduleSchema>; maxConcurrent?: number },
  actor: RunnerActor,
): Promise<RunnerSummary> {
  assertPlansEnabled();
  const current = await runnerOrThrow(id);
  assertRunnerAccess(current, actor, 'editar');
  if (current.revoked_at) throw new AppError('RUNNER_REVOKED', 'Ese runner está revocado: crea uno nuevo.', 409);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.schedule !== undefined) update.schedule = toSchedule(patch.schedule);
  if (patch.maxConcurrent !== undefined) update.max_concurrent = patch.maxConcurrent;
  const { data, error } = await db().from('runner').update(update).eq('id', id).select('*').single();
  if (error) throw error;
  const [runner] = await toRunnerSummaries([data as RunnerRow]);
  return runner!;
}

/**
 * Revoca el token (revoked_at = now). Lo que ese runner tenía corriendo vuelve a la cola en el
 * momento (sin esperar al watchdog): su siguiente latido ya no autentica.
 */
export async function revokeRunner(id: string, actor: RunnerActor): Promise<RunnerSummary> {
  assertPlansEnabled();
  const current = await runnerOrThrow(id);
  assertRunnerAccess(current, actor, 'revocar');
  const actorDevId = actor.devId;
  let row = current;
  if (!current.revoked_at) {
    const { data, error } = await db()
      .from('runner')
      .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id)
      .is('revoked_at', null)
      .select('*');
    if (error) throw error;
    row = ((data ?? []) as RunnerRow[])[0] ?? (await runnerOrThrow(id));

    const { data: running, error: runErr } = await db()
      .from('agent_plan')
      .select('*')
      .eq('runner_id', id)
      .in('status', [...PLAN_RUNNING]);
    if (runErr) throw runErr;
    for (const plan of (running ?? []) as PlanRow[]) {
      try {
        await transitionPlan(plan, 'liberar', {
          actorDevId,
          runnerId: id,
          event: 'released',
          guard: 'lease',
          data: { reason: 'runner_revocado' },
        });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
      }
    }
  }
  const [runner] = await toRunnerSummaries([row]);
  return runner!;
}

// ================================================================ API del runner: auth

export interface AuthedRunner {
  runner: RunnerRow;
  dev: { id: string; name: string; githubLogin: string | null };
}

export class RunnerUnauthorizedError extends AppError {
  constructor() {
    super('RUNNER_UNAUTHORIZED', 'Token de runner inválido o revocado.', 401);
  }
}

/** Bearer → sha256 → runner vigente. Sella last_seen_at (cada request válida cuenta como "en línea"). */
export async function authenticateRunner(token: string): Promise<AuthedRunner> {
  if (!looksLikeRunnerToken(token)) throw new RunnerUnauthorizedError();
  const { data, error } = await db()
    .from('runner')
    .select('*')
    .eq('token_hash', hashRunnerToken(token))
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new RunnerUnauthorizedError();
  const runner = data as RunnerRow;
  const dev = await getDev(runner.dev_id);
  if (!dev || dev.active === false) throw new RunnerUnauthorizedError();
  const now = new Date().toISOString();
  await db().from('runner').update({ last_seen_at: now }).eq('id', runner.id);
  return { runner: { ...runner, last_seen_at: now }, dev: { id: dev.id, name: dev.name, githubLogin: dev.github_login } };
}

// ================================================================ API del runner: register / heartbeat

export const registerSchema = z.object({
  name: runnerNameSchema,
  version: z.string().trim().min(1).max(40),
  platform: z.string().trim().min(1).max(80),
  schedule: scheduleSchema.optional(),
  maxConcurrent: maxConcurrentSchema.optional(),
});

/** Saludo inicial del CLI (idempotente): actualiza nombre, versión, plataforma y, si vienen, horario y máximo. */
export async function registerRunner(auth: AuthedRunner, body: RunnerRegisterRequest): Promise<RunnerRegisterResponse> {
  assertPlansEnabled();
  const update: Record<string, unknown> = {
    name: body.name.trim(),
    version: body.version,
    platform: body.platform,
    updated_at: new Date().toISOString(),
  };
  if (body.schedule) update.schedule = normalizeSchedule(body.schedule);
  if (body.maxConcurrent !== undefined) update.max_concurrent = body.maxConcurrent;
  const { data, error } = await db().from('runner').update(update).eq('id', auth.runner.id).select('*').single();
  if (error) throw error;
  const row = data as RunnerRow;
  const { count } = await db()
    .from('agent_plan')
    .select('id', { count: 'exact', head: true })
    .eq('runner_id', row.id)
    .in('status', [...PLAN_RUNNING]);
  return {
    runner: toRunnerSummary(row, auth.dev.name, count ?? 0),
    dev: auth.dev,
    mcpUrl: `${config.dashboard.url}/mcp`,
    heartbeatIntervalMs: RUNNER_HEARTBEAT_INTERVAL_MS,
    pollIntervalMs: RUNNER_POLL_INTERVAL_MS,
  };
}

const progressInputSchema = z.object({
  step: z.string().max(200).nullish(),
  message: z.string().max(2000).nullish(),
  pct: z.number().min(0).max(100).nullish(),
});

export const heartbeatSchema = z.object({
  running: z
    .array(
      z.object({
        planId: z.string().uuid(),
        leaseId: z.string().uuid(),
        progress: progressInputSchema.optional(),
      }),
    )
    .max(16),
  version: z.string().trim().min(1).max(40).optional(),
});

function toProgress(p: { step?: string | null; message?: string | null; pct?: number | null } | undefined, at: string): PlanProgress | null {
  if (!p) return null;
  return { step: p.step ?? null, message: p.message ?? null, pct: p.pct ?? null, at };
}

/**
 * Latido: refresca heartbeat_at (y el avance) de lo que el runner dice tener corriendo, y le dice
 * qué detener: cancelado/terminado → 'cancelado'; el lease ya no es suyo → 'lease_perdido' (o
 * 'reasignado' si cambió el dueño); el issue se reasignó en Linear mientras corría → se regresa a la
 * cola del nuevo dueño y 'reasignado'.
 */
export async function runnerHeartbeat(auth: AuthedRunner, body: RunnerHeartbeatRequest): Promise<RunnerHeartbeatResponse> {
  assertPlansEnabled();
  const now = new Date();
  const at = now.toISOString();
  const stop: RunnerHeartbeatResponse['stop'] = [];
  const schedule = normalizeSchedule(auth.runner.schedule);
  if (body.version && body.version !== auth.runner.version) {
    await db().from('runner').update({ version: body.version }).eq('id', auth.runner.id);
  }

  for (const r of body.running) {
    const plan = await getPlan(r.planId);
    if (!plan || !PLAN_RUNNING.includes(plan.status)) {
      stop.push({ planId: r.planId, reason: plan && plan.status === 'en_cola' ? 'lease_perdido' : 'cancelado' });
      continue;
    }
    if (plan.lease_id !== r.leaseId || plan.runner_id !== auth.runner.id) {
      stop.push({ planId: r.planId, reason: plan.owner_dev_id !== auth.dev.id ? 'reasignado' : 'lease_perdido' });
      continue;
    }
    if (plan.owner_dev_id !== auth.dev.id) {
      await releaseReassigned(plan, auth.runner.id);
      stop.push({ planId: r.planId, reason: 'reasignado' });
      continue;
    }
    const patch: Record<string, unknown> = { heartbeat_at: at };
    const progress = toProgress(r.progress, at);
    if (progress) patch.progress = progress;
    const { error } = await db().from('agent_plan').update(patch).eq('id', plan.id).eq('lease_id', r.leaseId);
    if (error) throw error;
  }
  return { now: at, inSchedule: inSchedule(schedule, now), stop };
}

/** El dueño cambió (Linear) mientras el plan corría: vuelve a la cola, ya del dueño nuevo. */
async function releaseReassigned(plan: PlanRow, runnerId: string): Promise<void> {
  try {
    await transitionPlan(plan, 'liberar', {
      runnerId,
      event: 'requeued',
      guard: 'lease',
      data: { reason: 'reasignado' },
    });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
}

// ================================================================ API del runner: next-job

/**
 * Siguiente plan de la cola del dueño. Fuera de horario → nada y cuánto esperar. Dentro, la toma es
 * atómica en la base (agent_plan_next: FOR UPDATE SKIP LOCKED + max_concurrent del runner).
 */
export async function runnerNextJob(auth: AuthedRunner, now: Date = new Date()): Promise<RunnerNextJobResponse> {
  assertPlansEnabled();
  const schedule = normalizeSchedule(auth.runner.schedule);
  if (!inSchedule(schedule, now)) return { job: null, retryAfterMs: nextJobRetryAfter(schedule, now) };

  const { data, error } = await db().rpc('agent_plan_next', { p_runner_id: auth.runner.id, p_max_attempts: PLAN_MAX_ATTEMPTS });
  if (error) throw error;
  const taken = ((Array.isArray(data) ? data : data ? [data] : []) as PlanRow[])[0];
  if (!taken) return { job: null, retryAfterMs: NEXT_JOB_IDLE_MS };

  const item = await getWorkItem(taken.work_item_id);
  const title = item?.name ?? taken.identifier;
  const branch = taken.branch ?? suggestedBranch(taken.identifier, title, item?.linear_branch_name);
  // Tomado por su dueño: deja de estar a disposición de otros. La rama queda fija desde ya.
  await db()
    .from('agent_plan')
    .update({ branch, claimable: false, claimable_reason: null, claimable_at: null })
    .eq('id', taken.id)
    .eq('lease_id', taken.lease_id!);
  await insertPlanEvent({
    planId: taken.id,
    kind: 'started',
    fromStatus: 'en_cola',
    toStatus: taken.status,
    actorDevId: null,
    runnerId: auth.runner.id,
    data: { phase: taken.phase, attempt: taken.attempts + 1 },
  });

  let projectName: string | null = null;
  if (item?.project_id) {
    const { data: proj } = await db().from('project').select('name').eq('id', item.project_id).maybeSingle();
    projectName = (proj as { name: string } | null)?.name ?? null;
  }
  const job: RunnerJob = {
    planId: taken.id,
    leaseId: taken.lease_id!,
    phase: taken.phase,
    risk: taken.risk,
    riskReasons: taken.risk_reasons ?? [],
    identifier: taken.identifier,
    issue: { title, description: item?.description ?? null, url: item?.url ?? null, projectName },
    repo: taken.repo,
    baseBranch: taken.base_branch,
    branch,
    planMd: taken.plan_md,
    feedback: taken.feedback,
    prompt: buildRunnerPrompt({
      planId: taken.id,
      leaseId: taken.lease_id!,
      phase: taken.phase,
      risk: taken.risk,
      riskReasons: taken.risk_reasons ?? [],
      identifier: taken.identifier,
      title,
      description: item?.description ?? null,
      url: item?.url ?? null,
      projectName,
      repo: taken.repo,
      branch,
      planMd: taken.plan_md,
      feedback: taken.feedback,
    }),
    allowedTools: [...(taken.phase === 'implementar' ? RUNNER_ALLOWED_TOOLS_IMPLEMENT : RUNNER_ALLOWED_TOOLS_PLAN)],
    maxTurns: MAX_TURNS[taken.phase],
  };
  return { job, retryAfterMs: 0 };
}

// ================================================================ API del runner: progress

export const progressSchema = z.object({
  planId: z.string().uuid(),
  leaseId: z.string().uuid(),
  kind: z.enum(['progress', 'plan_ready', 'pr_opened', 'failed', 'released']),
  step: z.string().max(200).optional(),
  message: z.string().max(2000).optional(),
  pct: z.number().min(0).max(100).optional(),
  planMd: z.string().max(200_000).optional(),
  branch: z.string().trim().min(1).max(250).optional(),
  prNumber: z.number().int().positive().optional(),
  prUrl: z.string().url().max(500).optional(),
  error: z.string().max(4000).optional(),
});

function leaseLost(): AppError {
  return new AppError('LEASE_LOST', 'Este plan ya no es de este runner: detenlo.', 409);
}

/**
 * Avance del runner. Exige que el lease siga siendo suyo (si no → 409 LEASE_LOST). `runnerId` null
 * = viene del MCP (report_progress), que solo conoce el lease.
 */
export async function runnerProgress(
  runnerId: string | null,
  runnerDevId: string | null,
  body: RunnerProgressRequest,
  now: Date = new Date(),
): Promise<RunnerProgressResponse> {
  assertPlansEnabled();
  const plan = await getPlan(body.planId);
  if (!plan || !PLAN_RUNNING.includes(plan.status) || plan.lease_id !== body.leaseId) throw leaseLost();
  if (runnerId && plan.runner_id !== runnerId) throw leaseLost();
  if (runnerDevId && plan.owner_dev_id !== runnerDevId) {
    await releaseReassigned(plan, runnerId ?? plan.runner_id!);
    throw leaseLost();
  }
  const by = runnerId ?? plan.runner_id;
  const at = now.toISOString();
  const progress: PlanProgress = { step: body.step ?? null, message: body.message ?? null, pct: body.pct ?? null, at };

  switch (body.kind) {
    case 'progress': {
      const { data, error } = await db()
        .from('agent_plan')
        .update({ heartbeat_at: at, progress })
        .eq('id', plan.id)
        .eq('lease_id', body.leaseId)
        .select('id');
      if (error) throw error;
      if (!(data ?? []).length) throw leaseLost();
      const { data: last } = await db()
        .from('agent_plan_event')
        .select('created_at')
        .eq('plan_id', plan.id)
        .eq('kind', 'progress')
        .order('created_at', { ascending: false })
        .limit(1);
      const lastAt = ((last ?? []) as { created_at: string }[])[0]?.created_at ?? null;
      if (shouldLogProgress(lastAt, now)) {
        await insertPlanEvent({
          planId: plan.id,
          kind: 'progress',
          fromStatus: plan.status,
          toStatus: plan.status,
          actorDevId: null,
          runnerId: by,
          data: { step: progress.step, message: progress.message, pct: progress.pct },
        });
      }
      return { status: plan.status, phase: plan.phase, continue: true };
    }
    case 'plan_ready': {
      if (!body.planMd?.trim()) throw new ValidationError('plan_ready necesita planMd');
      const updated = await transitionPlan(plan, 'plan_listo', {
        runnerId: by,
        event: 'plan_ready',
        guard: 'lease',
        patch: { plan_md: body.planMd, plan_version: plan.plan_version + 1, feedback: null, progress, heartbeat_at: plan.risk === 0 ? at : null },
        data: { planVersion: plan.plan_version + 1, risk: plan.risk },
        now,
      });
      // Riesgo 0 sigue con el mismo lease a implementar; 1-2 sueltan el runner y esperan a una persona.
      return { status: updated.status, phase: updated.phase, continue: updated.status === 'implementando' };
    }
    case 'pr_opened': {
      if (!body.prNumber || !body.prUrl || !body.branch) throw new ValidationError('pr_opened necesita prNumber, prUrl y branch');
      const updated = await transitionPlan(plan, 'pr_abierto', {
        runnerId: by,
        event: 'pr_opened',
        guard: 'lease',
        patch: { pr_number: body.prNumber, pr_url: body.prUrl, branch: body.branch, progress, error: null },
        data: { prNumber: body.prNumber, prUrl: body.prUrl, branch: body.branch },
        now,
      });
      return { status: updated.status, phase: updated.phase, continue: false };
    }
    case 'failed': {
      if (!body.error?.trim()) throw new ValidationError('failed necesita error');
      const attempts = plan.attempts + 1;
      const exhausted = attempts >= PLAN_MAX_ATTEMPTS;
      const updated = await transitionPlan(plan, 'fallo', {
        runnerId: by,
        event: 'failed',
        guard: 'lease',
        patch: {
          attempts,
          error: body.error.trim(),
          progress,
          ...(exhausted ? { claimable: true, claimable_reason: 'fallos', claimable_at: at } : {}),
        },
        data: { error: body.error.trim(), attempts, exhausted },
        now,
      });
      return { status: updated.status, phase: updated.phase, continue: false };
    }
    case 'released': {
      const updated = await transitionPlan(plan, 'liberar', {
        runnerId: by,
        event: 'released',
        guard: 'lease',
        patch: { progress },
        data: { reason: body.message ?? 'runner' },
        now,
      });
      return { status: updated.status, phase: updated.phase, continue: false };
    }
  }
}

// ================================================================ API del runner: pull

export const pullSchema = z
  .object({
    planId: z.string().uuid().optional(),
    identifier: z.string().trim().min(1).max(40).optional(),
  })
  .refine((b) => !!b.planId || !!b.identifier, 'manda planId o identifier');

/** "Jalar" desde la terminal: el dev implementa él mismo; el runner crea la rama y escribe PLAN.md. */
export async function runnerPull(auth: AuthedRunner, body: RunnerPullRequest): Promise<RunnerPullResponse> {
  assertPlansEnabled();
  let planId = body.planId ?? null;
  if (!planId && body.identifier) {
    const row = await planByIdentifier(body.identifier);
    if (!row) throw new NotFoundError(`No hay plan para ${body.identifier}.`);
    planId = row.id;
  }
  if (!planId) throw new ValidationError('manda planId o identifier');
  const { pull } = await pullPlan(planId, auth.dev.id);
  return pull;
}
