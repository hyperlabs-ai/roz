// Planes del agente (roz v2): encolar (outbox 'plan.enqueue'), listar, las acciones de personas
// (aprobar, pedir cambios, reclamar, jalar, soltar, cancelar), el watchdog y el aviso de reclamable.
// Cada cambio de estado pasa por transitionPlan (store.ts): update condicional + agent_plan_event.
import { db } from '../db/supabase.js';
import { emit, type EmitOptions, type OutboxEventType } from '../events/outbox.js';
import { latestDecision, updateDecision } from '../assign/decisions.js';
import { CLAIM_OVERRIDE_CATEGORY } from '../assign/rules.js';
import { POLICY_VERSION } from '../assign/policy.js';
import { pushBroadcast, pushToDev } from '../notify/push.js';
import { planClaimableNotice, toPush } from '../notify/copy.js';
import { config } from '../config.js';
import { linearSourceOfTruth } from '../linear/enabled.js';
import { linearUserForDev } from '../linear/links.js';
import { AppError, ValidationError } from '../utils/errors.js';
import {
  type ActionCheck,
  checkAction,
  claimableReason,
  computeRisk,
  isHeartbeatStale,
  normalizeSchedule,
  planTemplate,
  suggestedBranch,
} from './rules.js';
import {
  assertPlansEnabled,
  devsById,
  getDev,
  getPlanOrThrow,
  getWorkItem,
  insertPlanEvent,
  planConflict,
  toDetail,
  toSummaries,
  toSummaryOne,
  transitionPlan,
  type PlanRow,
  type RunnerRow,
} from './store.js';
import {
  PLAN_HEARTBEAT_STALE_MS,
  PLAN_RUNNING,
  PLAN_STATUSES,
  PLAN_TERMINAL,
  type AgentPlanDetail,
  type AgentPlanSummary,
  type PlanClaimablePayload,
  type PlanEnqueuePayload,
  type PlanHumanAction,
  type PlanReassignLinearPayload,
  type PlanStatus,
  type RozV2OutboxEventType,
  type RunnerPullResponse,
} from '../types/roz-v2.js';

/**
 * emit() con los tipos de evento de roz v2. OutboxEventType todavía no los incluye (se suman al
 * integrar src/events/outbox.ts); cuando estén, esto es solo `emit`.
 */
const emitV2 = emit as (
  type: OutboxEventType | RozV2OutboxEventType,
  payload: Record<string, unknown>,
  opts?: EmitOptions,
) => Promise<string | null>;

/** Planes "vivos" para el índice uq_roz_agent_plan_live. */
const LIVE_STATUSES: PlanStatus[] = PLAN_STATUSES.filter((s) => !PLAN_TERMINAL.includes(s));
const OPEN_ISSUE: string[] = ['planificada', 'pendiente', 'en_progreso', 'revision'];

// ================================================================ encolar

export interface EnqueueResult {
  action: 'creado' | 'sin_cambios' | 'reasignado' | 'omitido';
  planId: string | null;
  reason?: string;
}

/**
 * Handler del evento 'plan.enqueue' (lo emite el espejo de Linear al cambiar el asignado).
 * Idempotente por issue: con un plan vivo del mismo dueño no hace nada; de otro dueño, le cambia la
 * cola (si está corriendo, el latido del runner recibe `stop: reasignado` y lo regresa a la cola).
 * Sin plan vivo inserta uno con riesgo por reglas; un 23505 = otro tick ganó → no-op.
 */
export async function enqueuePlan(p: PlanEnqueuePayload): Promise<EnqueueResult> {
  if (!linearSourceOfTruth()) return { action: 'omitido', planId: null, reason: 'flag' };
  const { workItemId, ownerDevId } = p;
  const supabase = db();

  const item = await getWorkItem(workItemId);
  if (!item) return { action: 'omitido', planId: null, reason: 'issue_inexistente' };
  if (!OPEN_ISSUE.includes(item.status)) return { action: 'omitido', planId: null, reason: 'issue_cerrado' };
  const owner = await getDev(ownerDevId);
  if (!owner || owner.active === false) return { action: 'omitido', planId: null, reason: 'dueño_inactivo' };

  const { data: liveData, error: liveErr } = await supabase
    .from('agent_plan')
    .select('*')
    .eq('work_item_id', workItemId)
    .in('status', LIVE_STATUSES)
    .limit(1);
  if (liveErr) throw liveErr;
  const live = ((liveData ?? []) as PlanRow[])[0];

  if (live) {
    if (live.owner_dev_id === ownerDevId) return { action: 'sin_cambios', planId: live.id };
    const running = PLAN_RUNNING.includes(live.status);
    let q = supabase
      .from('agent_plan')
      .update({ owner_dev_id: ownerDevId, claimable: false, claimable_reason: null, claimable_at: null, updated_at: new Date().toISOString() })
      .eq('id', live.id)
      .eq('status', live.status)
      .eq('owner_dev_id', live.owner_dev_id);
    // Corriendo: el latido no toca updated_at, así que basta el lease; en cola, la versión leída.
    q = running && live.lease_id ? q.eq('lease_id', live.lease_id) : q.eq('updated_at', live.updated_at);
    const { data: upd, error: updErr } = await q.select('id');
    if (updErr) throw updErr;
    // Otro cambio ganó: el outbox reintenta y vuelve a leer.
    if (!(upd ?? []).length) throw new Error(`plan ${live.id} cambió mientras se reasignaba`);
    await insertPlanEvent({
      planId: live.id,
      kind: 'claimed',
      fromStatus: live.status,
      toStatus: live.status,
      actorDevId: null,
      runnerId: null,
      data: { reason: 'reasignado_en_linear', fromDevId: live.owner_dev_id, toDevId: ownerDevId },
    });
    return { action: 'reasignado', planId: live.id };
  }

  // Una persona ya lo jaló: lo está implementando ella, el agente no vuelve a empezar.
  const { data: pulled, error: pulledErr } = await supabase
    .from('agent_plan')
    .select('id')
    .eq('work_item_id', workItemId)
    .eq('status', 'jalado')
    .limit(1);
  if (pulledErr) throw pulledErr;
  if ((pulled ?? []).length) return { action: 'omitido', planId: null, reason: 'jalado' };

  let clientSla = false;
  let riskPaths: string[] = [];
  let repo: string | null = null;
  if (item.project_id) {
    const [projRes, repoRes] = await Promise.all([
      supabase.from('project').select('client_sla, agent_risk_paths').eq('id', item.project_id).maybeSingle(),
      supabase.from('project_repo').select('repo').eq('project_id', item.project_id).order('created_at', { ascending: true }).limit(1),
    ]);
    if (projRes.error) throw projRes.error;
    if (repoRes.error) throw repoRes.error;
    const proj = projRes.data as { client_sla: boolean | null; agent_risk_paths: string[] | null } | null;
    clientSla = !!proj?.client_sla;
    riskPaths = proj?.agent_risk_paths ?? [];
    repo = ((repoRes.data ?? []) as { repo: string }[])[0]?.repo ?? null;
  }
  const { risk, reasons } = computeRisk({
    title: item.name,
    description: item.description,
    labels: item.labels ?? [],
    clientSla,
    riskPaths,
  });

  const { data: ins, error: insErr } = await supabase
    .from('agent_plan')
    .insert({
      work_item_id: workItemId,
      linear_issue_id: p.linearIssueId ?? item.linear_id,
      identifier: item.identifier,
      owner_dev_id: ownerDevId,
      status: 'en_cola',
      phase: 'planear',
      risk,
      risk_reasons: reasons,
      repo,
      branch: suggestedBranch(item.identifier, item.name, item.linear_branch_name),
    })
    .select('id')
    .single();
  if (insErr) {
    if ((insErr as { code?: string }).code === '23505') return { action: 'sin_cambios', planId: null, reason: 'carrera' };
    throw insErr;
  }
  const planId = (ins as { id: string }).id;
  await insertPlanEvent({
    planId,
    kind: 'enqueued',
    fromStatus: null,
    toStatus: 'en_cola',
    actorDevId: null,
    runnerId: null,
    data: { reason: p.reason, risk, riskReasons: reasons },
  });
  return { action: 'creado', planId };
}

// ================================================================ lectura

export type PlanScope = 'mine' | 'team' | 'claimable';

export interface ListPlansInput {
  viewerDevId: string;
  scope: PlanScope;
  status?: PlanStatus;
  devId?: string;
  projectId?: string;
}

/** Terminados que se siguen viendo en la lista (después solo en el detalle). */
const RECENT_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;

export async function listPlans(input: ListPlansInput): Promise<{ plans: AgentPlanSummary[]; counts: Record<PlanStatus, number> }> {
  assertPlansEnabled();
  const since = new Date(Date.now() - RECENT_FINISHED_MS).toISOString();
  let q = db()
    .from('agent_plan')
    .select('*')
    .or(`finished_at.is.null,finished_at.gte.${since}`)
    .order('enqueued_at', { ascending: true })
    .limit(500);
  if (input.scope === 'mine') q = q.or(`owner_dev_id.eq.${input.viewerDevId},pulled_by_dev_id.eq.${input.viewerDevId}`);
  if (input.scope === 'claimable') q = q.eq('claimable', true).in('status', ['en_cola', 'esperando_aprobacion']);
  if (input.devId) q = q.or(`owner_dev_id.eq.${input.devId},pulled_by_dev_id.eq.${input.devId}`);
  const { data, error } = await q;
  if (error) throw error;

  let summaries = await toSummaries((data ?? []) as PlanRow[], input.viewerDevId);
  if (input.projectId) summaries = summaries.filter((s) => s.issue.projectId === input.projectId);

  // Los conteos son del alcance completo (sin el filtro de estado): son las pestañas del front.
  const counts = Object.fromEntries(PLAN_STATUSES.map((s) => [s, 0])) as Record<PlanStatus, number>;
  for (const s of summaries) counts[s.status]++;
  if (input.status) summaries = summaries.filter((s) => s.status === input.status);
  return { plans: summaries, counts };
}

export async function getPlanDetail(planId: string, viewerDevId: string): Promise<AgentPlanDetail> {
  assertPlansEnabled();
  return toDetail(await getPlanOrThrow(planId), viewerDevId);
}

// ================================================================ acciones de personas

export interface Actor {
  /** auth.users.id */
  userId: string;
  devId: string;
}

/** Revisa quién puede (rules.checkAction) y lanza el error que corresponde. */
function guardAction(row: PlanRow, action: PlanHumanAction, actorDevId: string): void {
  const check = checkAction(
    { status: row.status, phase: row.phase, risk: row.risk, ownerDevId: row.owner_dev_id, pulledByDevId: row.pulled_by_dev_id },
    action,
    actorDevId,
  );
  if (check.ok) return;
  // Cast explícito: sin strict (build de Vercel) el `ok` booleano no estrecha la unión.
  const denied = check as Extract<ActionCheck, { ok: false }>;
  if (denied.code === 'PLAN_CONFLICT') throw planConflict(row, denied.message);
  throw new AppError('PLAN_FORBIDDEN', denied.message, 403, { status: row.status, phase: row.phase });
}

export async function approvePlan(planId: string, actor: Actor): Promise<AgentPlanSummary> {
  assertPlansEnabled();
  const row = await getPlanOrThrow(planId);
  guardAction(row, 'aprobar', actor.devId);
  const now = new Date().toISOString();
  const updated = await transitionPlan(row, 'aprobar', {
    actorDevId: actor.devId,
    event: 'approved',
    guard: 'updated_at',
    patch: { approved_by: actor.userId, approved_at: now, claimable: false, claimable_reason: null, claimable_at: null },
    data: { planVersion: row.plan_version },
  });
  return toSummaryOne(updated, actor.devId);
}

export const FEEDBACK_MAX = 4000;

export async function requestChanges(planId: string, actor: Actor, feedback: string): Promise<AgentPlanSummary> {
  assertPlansEnabled();
  const text = feedback.trim();
  if (!text) throw new ValidationError('Escribe qué cambios necesita el plan.');
  if (text.length > FEEDBACK_MAX) throw new ValidationError(`El comentario no puede pasar de ${FEEDBACK_MAX} caracteres.`);
  const row = await getPlanOrThrow(planId);
  guardAction(row, 'pedir_cambios', actor.devId);
  const updated = await transitionPlan(row, 'pedir_cambios', {
    actorDevId: actor.devId,
    event: 'changes_requested',
    guard: 'updated_at',
    patch: { feedback: text, approved_by: null, approved_at: null },
    data: { feedback: text, planVersion: row.plan_version },
  });
  return toSummaryOne(updated, actor.devId);
}

/**
 * Reclamar: el plan pasa a MI cola. Atómico: el update se condiciona al estado, la versión y el
 * dueño leídos; si otro reclamó primero, el perdedor recibe 409 PLAN_TAKEN con quién lo tiene.
 * Después: override 'reclamado' en assignment_decision y reasignación en Linear vía outbox.
 */
export async function claimPlan(planId: string, actor: Actor, note: string | null): Promise<AgentPlanSummary> {
  assertPlansEnabled();
  const row = await getPlanOrThrow(planId);
  guardAction(row, 'reclamar', actor.devId);
  // Reclamar también cambia el asignado en Linear (outbox). Sin usuario de Linear para quien
  // reclama, ese paso falla en cada reintento y roz y Linear quedan con dueños distintos para
  // siempre: se rechaza antes de tocar nada.
  if (!(await linearUserForDev(actor.devId))) {
    throw new AppError('LINEAR_USER_MISSING', 'No tienes usuario en Linear (no coincide tu correo): no puedes reclamar el plan.', 422);
  }
  const fromDevId = row.owner_dev_id;
  const cleanNote = note?.trim() || null;

  const updated = await transitionPlan(row, 'reclamar', {
    actorDevId: actor.devId,
    event: 'claimed',
    guard: 'updated_at',
    extraEq: { owner_dev_id: fromDevId },
    patch: { owner_dev_id: actor.devId, claimable: false, claimable_reason: null, claimable_at: null },
    data: { fromDevId, toDevId: actor.devId, note: cleanNote, wasClaimable: row.claimable, claimableReason: row.claimable_reason },
  });

  await recordClaimOverride({ workItemId: row.work_item_id, fromDevId, toDevId: actor.devId, userId: actor.userId, note: cleanNote });

  const payload: PlanReassignLinearPayload = {
    planId: row.id,
    workItemId: row.work_item_id,
    fromDevId,
    toDevId: actor.devId,
    reason: 'reclamado',
  };
  // La llave lleva la versión que dejó ESTE reclamo: con solo plan+dev, un ida y vuelta (A reclama,
  // B lo recupera, A lo reclama otra vez) chocaba con el evento del primer reclamo y Linear se
  // quedaba con B.
  await emitV2('plan.reassign_linear', { ...payload }, { idempotencyKey: `plan-reassign:${row.id}:${actor.devId}:${updated.updated_at}` });
  return toSummaryOne(updated, actor.devId);
}

/**
 * Deja constancia del reclamo como corrección de la asignación: si la última decisión del issue es
 * una asignación de roz sin corregir, se le escribe el override; si no, se inserta una fila manual
 * (quién la tenía → quién la reclamó). Así el aprendizaje de la política ve el reclamo.
 */
export async function recordClaimOverride(input: {
  workItemId: string;
  fromDevId: string;
  toDevId: string;
  userId: string;
  note: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const override = {
    overridden_at: now,
    overridden_by: input.userId,
    override_dev_id: input.toDevId,
    override_category: CLAIM_OVERRIDE_CATEGORY,
    override_note: input.note,
  };
  const latest = await latestDecision(input.workItemId);
  if (latest && latest.outcome === 'assigned' && !latest.overridden_at) {
    await updateDecision(latest.id, override);
    return;
  }
  const { error } = await db().from('assignment_decision').insert({
    work_item_id: input.workItemId,
    origin: 'manual',
    requested_by: input.userId,
    outcome: 'assigned',
    reason: 'reclamado desde la cola del agente',
    policy_version: POLICY_VERSION,
    chosen_dev_id: input.fromDevId,
    decided_at: now,
    ...override,
  });
  if (error) throw error;
}

/** Jalar: una persona lo implementa (el agente no corre). Idempotente si ya lo jaló la misma persona. */
export async function pullPlan(planId: string, actorDevId: string): Promise<{ plan: PlanRow; pull: RunnerPullResponse }> {
  assertPlansEnabled();
  let row = await getPlanOrThrow(planId);
  if (!(row.status === 'jalado' && row.pulled_by_dev_id === actorDevId)) {
    guardAction(row, 'jalar', actorDevId);
    const item = await getWorkItem(row.work_item_id);
    const now = new Date().toISOString();
    row = await transitionPlan(row, 'jalar', {
      actorDevId,
      event: 'pulled',
      guard: 'updated_at',
      patch: {
        pulled_by_dev_id: actorDevId,
        pulled_at: now,
        claimable: false,
        claimable_reason: null,
        claimable_at: null,
        branch: row.branch ?? suggestedBranch(row.identifier, item?.name ?? row.identifier, item?.linear_branch_name),
      },
      data: { ownerDevId: row.owner_dev_id },
    });
  }
  return { plan: row, pull: await pullResponse(row) };
}

export async function pullResponse(row: PlanRow): Promise<RunnerPullResponse> {
  const item = await getWorkItem(row.work_item_id);
  const title = item?.name ?? row.identifier;
  return {
    planId: row.id,
    identifier: row.identifier,
    repo: row.repo,
    baseBranch: row.base_branch,
    branch: row.branch ?? suggestedBranch(row.identifier, title, item?.linear_branch_name),
    planMd:
      row.plan_md ?? planTemplate({ identifier: row.identifier, title, description: item?.description ?? null, url: item?.url ?? null }),
    issue: { title, url: item?.url ?? null },
  };
}

/** Plan vivo (o jalado) por identificador de Linear, para `pull` por "HYP-123". */
export async function planByIdentifier(identifier: string): Promise<PlanRow | null> {
  const { data, error } = await db()
    .from('agent_plan')
    .select('*')
    .ilike('identifier', identifier.trim())
    .in('status', [...LIVE_STATUSES, 'jalado'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as PlanRow[])[0] ?? null;
}

/**
 * Soltar: el dueño lo deja en la cola marcado como reclamable (otro puede tomarlo); quien lo jaló lo
 * devuelve a la cola para replanear, también reclamable.
 */
export async function releasePlan(planId: string, actor: Actor): Promise<AgentPlanSummary> {
  assertPlansEnabled();
  const row = await getPlanOrThrow(planId);
  guardAction(row, 'soltar', actor.devId);
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { claimable: true, claimable_reason: 'soltado', claimable_at: now };
  if (row.status === 'jalado') {
    patch.pulled_by_dev_id = null;
    patch.pulled_at = null;
  }
  const updated = await transitionPlan(row, 'soltar', {
    actorDevId: actor.devId,
    event: 'released',
    guard: 'updated_at',
    patch,
    data: { by: row.status === 'jalado' ? 'quien_jalo' : 'dueño' },
  });
  return toSummaryOne(updated, actor.devId);
}

export async function cancelPlan(planId: string, actor: Actor, reason: string | null): Promise<AgentPlanSummary> {
  assertPlansEnabled();
  const row = await getPlanOrThrow(planId);
  guardAction(row, 'cancelar', actor.devId);
  const updated = await transitionPlan(row, 'cancelar', {
    actorDevId: actor.devId,
    event: 'canceled',
    guard: 'updated_at',
    patch: { claimable: false, claimable_reason: null, claimable_at: null },
    data: { reason: reason?.trim() || null },
  });
  return toSummaryOne(updated, actor.devId);
}

// ================================================================ cierre desde Linear

/**
 * El espejo de Linear llama esto cuando el issue se completa (`issue_cerrado`) o se cancela
 * (`issue_cancelado`): mueve el plan vivo (o jalado, si se cerró) a hecho/cancelado. Sin plan → no-op.
 */
export async function applyIssueTransition(
  workItemId: string,
  t: 'issue_cerrado' | 'issue_cancelado',
): Promise<{ planId: string | null; status: PlanStatus | null }> {
  if (!linearSourceOfTruth()) return { planId: null, status: null };
  const statuses = t === 'issue_cerrado' ? [...LIVE_STATUSES, 'jalado'] : LIVE_STATUSES;
  const { data, error } = await db()
    .from('agent_plan')
    .select('*')
    .eq('work_item_id', workItemId)
    .in('status', statuses)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = ((data ?? []) as PlanRow[])[0];
  if (!row) return { planId: null, status: null };
  const updated = await transitionPlan(row, t, {
    event: t === 'issue_cerrado' ? 'done' : 'canceled',
    guard: 'updated_at',
    data: { reason: t },
  });
  return { planId: updated.id, status: updated.status };
}

// ================================================================ watchdog

export interface WatchdogResult {
  requeued: number;
  claimable: number;
  skipped?: 'flag';
}

/**
 * Cada 5 min (cron /v1/internal/plan-watchdog):
 *  1. planeando/implementando sin latido en 10 min → de vuelta a la cola con lo que ya escribió.
 *  2. en cola / esperando aprobación cuyo dueño está fuera de línea en su horario, o que lleva más
 *     de un día hábil ahí → reclamable + push al equipo del proyecto (outbox 'plan.claimable').
 */
export async function runPlanWatchdog(now: Date = new Date()): Promise<WatchdogResult> {
  if (!linearSourceOfTruth()) return { requeued: 0, claimable: 0, skipped: 'flag' };
  const supabase = db();
  let requeued = 0;
  let claimable = 0;

  // 1) latidos vencidos
  const staleBefore = new Date(now.getTime() - PLAN_HEARTBEAT_STALE_MS).toISOString();
  const { data: stale, error: staleErr } = await supabase
    .from('agent_plan')
    .select('*')
    .in('status', [...PLAN_RUNNING])
    .or(`heartbeat_at.is.null,heartbeat_at.lt.${staleBefore}`)
    .limit(100);
  if (staleErr) throw staleErr;
  for (const row of (stale ?? []) as PlanRow[]) {
    if (!isHeartbeatStale(row.status, row.heartbeat_at, now)) continue;
    try {
      await transitionPlan(row, 'watchdog', {
        runnerId: row.runner_id,
        event: 'requeued',
        guard: 'heartbeat',
        data: { reason: 'sin_latido', lastHeartbeatAt: row.heartbeat_at },
        now,
      });
      requeued++;
    } catch (err) {
      // Un latido llegó entre la lectura y el update: el runner sigue vivo.
      if (!(err instanceof AppError)) throw err;
    }
  }

  // 2) reclamables
  const { data: waiting, error: waitErr } = await supabase
    .from('agent_plan')
    .select('*')
    .in('status', ['en_cola', 'esperando_aprobacion'])
    .eq('claimable', false)
    .limit(500);
  if (waitErr) throw waitErr;
  const rows = (waiting ?? []) as PlanRow[];
  if (rows.length) {
    const owners = [...new Set(rows.map((r) => r.owner_dev_id))];
    const { data: runnerData, error: runnerErr } = await supabase
      .from('runner')
      .select('dev_id, last_seen_at, schedule, revoked_at')
      .in('dev_id', owners);
    if (runnerErr) throw runnerErr;
    const byDev = new Map<string, Pick<RunnerRow, 'last_seen_at' | 'schedule' | 'revoked_at'>[]>();
    for (const r of (runnerData ?? []) as Pick<RunnerRow, 'dev_id' | 'last_seen_at' | 'schedule' | 'revoked_at'>[]) {
      const list = byDev.get(r.dev_id) ?? [];
      list.push(r);
      byDev.set(r.dev_id, list);
    }

    for (const row of rows) {
      const reason = claimableReason({
        status: row.status,
        claimable: row.claimable,
        since: row.updated_at,
        ownerRunners: (byDev.get(row.owner_dev_id) ?? []).map((r) => ({
          lastSeenAt: r.last_seen_at,
          schedule: normalizeSchedule(r.schedule),
          revoked: !!r.revoked_at,
        })),
        now,
      });
      if (!reason) continue;
      const at = now.toISOString();
      const { data: upd, error: updErr } = await supabase
        .from('agent_plan')
        .update({ claimable: true, claimable_reason: reason, claimable_at: at, updated_at: at })
        .eq('id', row.id)
        .eq('status', row.status)
        .eq('updated_at', row.updated_at)
        .eq('claimable', false)
        .select('id');
      if (updErr) throw updErr;
      if (!(upd ?? []).length) continue;
      claimable++;
      await insertPlanEvent({
        planId: row.id,
        kind: 'claimable',
        fromStatus: row.status,
        toStatus: row.status,
        actorDevId: null,
        runnerId: null,
        data: { reason },
      });
      const item = await getWorkItem(row.work_item_id);
      const payload: PlanClaimablePayload = { planId: row.id, reason, projectId: item?.project_id ?? null };
      await emitV2('plan.claimable', { ...payload }, { idempotencyKey: `plan-claimable:${row.id}:${at}` });
    }
  }
  return { requeued, claimable };
}

// ================================================================ aviso de reclamable

/**
 * Handler del evento 'plan.claimable': push al equipo del proyecto (devs con dev_assignment en él;
 * sin proyecto o sin equipo → a todos), sin el dueño. Best-effort como todo el push.
 */
export async function notifyPlanClaimable(p: PlanClaimablePayload): Promise<{ sent: 'equipo' | 'todos' | 'nadie' }> {
  const row = await getPlanOrThrow(p.planId);
  if (!row.claimable || !['en_cola', 'esperando_aprobacion'].includes(row.status)) return { sent: 'nadie' };
  const item = await getWorkItem(row.work_item_id);
  const owner = (await devsById([row.owner_dev_id])).get(row.owner_dev_id);
  const url = `${config.dashboard.url}/app/plans?plan=${row.id}`;
  const notice = planClaimableNotice({ seed: `plan-claimable:${row.id}`, identifier: row.identifier, name: item?.name, owner: owner?.name, reason: p.reason, url });
  const payload = toPush(notice, { url, tag: `plan-claimable:${row.id}`, data: { kind: 'plan_claimable', planId: row.id } });

  let team: string[] = [];
  if (p.projectId) {
    const { data, error } = await db().from('dev_assignment').select('dev_id').eq('project_id', p.projectId);
    if (error) throw error;
    team = [...new Set(((data ?? []) as { dev_id: string }[]).map((r) => r.dev_id))].filter((id) => id !== row.owner_dev_id);
  }
  if (!team.length) {
    await pushBroadcast(payload, 'plan_claimable');
    return { sent: 'todos' };
  }
  const devs = await devsById(team);
  for (const id of team) await pushToDev(id, devs.get(id)?.email ?? null, payload, 'plan_claimable');
  return { sent: 'equipo' };
}
