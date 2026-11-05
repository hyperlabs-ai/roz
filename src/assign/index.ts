// Asignación automática de tareas: orquesta los pasos y deja registro de cada decisión.
//
//   guardas → corrida `pending` → Jev clasifica (una request) → ¿hace falta una persona? →
//   política (filtros, orden, desempate, capacidad) → asignar SOLO si sigue sin responsable →
//   cerrar la corrida con todo el porqué.
//
// Jev solo JUZGA (classify.ts); la decisión es código puro (policy.ts). Un fallo de Jev es un error
// visible —la tarea queda sin asignar y marcada—, nunca un "no" ni una caída silenciosa al router
// viejo (src/router/assign.ts sigue solo para el intake con la función apagada y el MCP).
import { config } from '../config.js';
import { emit } from '../events/outbox.js';
import { systemOne, TypeSafeError, type SystemOneRequest, type SystemOneResponse } from '../adapters/typesafe.js';
import { assignIfUnassigned, setEstimateIfNull } from '../dashboard/queries.js';
import { OPEN_STATES } from '../tasks/states.js';
import { todayLocal } from '../utils/team-time.js';
import { buildJevRequest, needsHuman, readClassification, type Classification } from './classify.js';
import {
  hasAnyAssignee,
  loadActiveProjects,
  loadCatalog,
  loadDevFacts,
  loadProject,
  loadSolutionTypes,
  loadTask,
  toTaskInput,
} from './context.js';
import { failIfStale, finishDecision, insertPending, pendingFor, recordSkipped, updateDecision, type DecisionRow } from './decisions.js';
import { QUESTIONS_VERSION } from './jev-questions.js';
import { POLICY_VERSION, decide, type TaskFacts } from './policy.js';
import type { AutoAssignOrigin } from './rules.js';

export { autoAssignEnabled } from './enabled.js';

export interface AutoAssignOptions {
  requestedBy?: string | null;
  /** Intento del outbox (1..maxAttempts). Solo en segundo plano. */
  attempt?: number;
  maxAttempts?: number;
  /** true = corre en segundo plano (outbox): un error reintentable se relanza para que reintente. */
  background?: boolean;
  log?: (msg: string, data: Record<string, unknown>) => void;
}

export interface AutoAssignResult {
  outcome: 'assigned' | 'escalated' | 'failed' | 'skipped' | 'running';
  decisionId: string | null;
  chosenDevId: string | null;
  reason: string | null;
  /** Solo si falló: vale la pena reintentar más tarde (Jev saturado / caído). */
  retryable?: boolean;
}

/** Sugerencias cuando roz no puede decidir sin una persona. */
export const NEEDS_HUMAN_DETAIL: Record<string, string> = {
  clasificacion_incierta:
    'roz no pudo saber qué clase de trabajo es (o qué parte del sistema toca). Elige el tipo de solución en la tarea y vuelve a intentar, o asigna a mano.',
  proyecto_incierto: 'no está claro a qué proyecto pertenece la tarea. Ponle proyecto y vuelve a intentar.',
};

async function openRun(taskId: string, origin: AutoAssignOrigin, opts: AutoAssignOptions): Promise<DecisionRow | 'running'> {
  const row = await insertPending({ workItemId: taskId, origin, requestedBy: opts.requestedBy ?? null, policyVersion: POLICY_VERSION });
  if (row) return row;
  const existing = await pendingFor(taskId);
  if (!existing) return (await insertPending({ workItemId: taskId, origin, requestedBy: opts.requestedBy ?? null, policyVersion: POLICY_VERSION })) ?? 'running';
  // Reintento del outbox: retoma su propia corrida.
  if ((opts.attempt ?? 1) > 1) return existing;
  // Una corrida vieja que nunca terminó se cierra y se abre otra.
  if (await failIfStale(existing)) {
    return (await insertPending({ workItemId: taskId, origin, requestedBy: opts.requestedBy ?? null, policyVersion: POLICY_VERSION })) ?? 'running';
  }
  return 'running';
}

export async function autoAssign(taskId: string, origin: AutoAssignOrigin, opts: AutoAssignOptions = {}): Promise<AutoAssignResult> {
  const log = opts.log ?? (() => {});
  const task = await loadTask(taskId);
  if (!task) return { outcome: 'skipped', decisionId: null, chosenDevId: null, reason: 'no_existe' };

  // Guardas: solo tareas nativas, abiertas y sin nadie. Lo que llega del puente de HyperOps o se
  // documenta desde un PR/commit ya trae dueño por otra vía.
  const skipReason =
    task.source !== 'native'
      ? 'no_nativa'
      : !OPEN_STATES.includes(task.status)
        ? 'cerrada'
        : (await hasAnyAssignee(task))
          ? 'ya_asignada'
          : null;
  if (skipReason) {
    // Un reintento que encuentra la tarea ya resuelta (p.ej. falló después de asignar) cierra su
    // propia corrida en vez de dejarla colgada en `pending`.
    if ((opts.attempt ?? 1) > 1) {
      const stuck = await pendingFor(task.id);
      if (stuck) await finishDecision(stuck.id, { outcome: 'skipped', reason: skipReason });
    }
    await recordSkipped({ workItemId: task.id, origin, requestedBy: opts.requestedBy ?? null, policyVersion: POLICY_VERSION, reason: skipReason });
    return { outcome: 'skipped', decisionId: null, chosenDevId: null, reason: skipReason };
  }

  const run = await openRun(task.id, origin, opts);
  if (run === 'running') return { outcome: 'running', decisionId: null, chosenDevId: null, reason: 'en_curso' };

  let request: SystemOneRequest | null = null;
  try {
    // 1. Clasificar (Jev).
    const [project, catalog] = await Promise.all([task.project_id ? loadProject(task.project_id) : null, loadCatalog()]);
    const [types, projects] = await Promise.all([loadSolutionTypes(catalog), task.project_id ? null : loadActiveProjects()]);
    const taskInput = toTaskInput(task, project, origin === 'intake' ? 'intake' : 'humano');
    request = buildJevRequest(taskInput, catalog, types, projects, config.typesafe.model);
    await updateDecision(run.id, { attempts: run.attempts + 1, jev_request: request, questions_version: QUESTIONS_VERSION });

    const response: SystemOneResponse = await systemOne(request);
    const today = todayLocal();
    const classification = readClassification(response.answers, taskInput, catalog, types, projects, today);
    const jevFields = { jev_model: response.model, jev_response: response, classification };
    log('auto-assign: clasificada', { taskId: task.id, model: response.model, inputTokens: response.usage.input_tokens });

    // 2. ¿Hace falta una persona antes de decidir?
    const human = needsHuman(classification, taskInput, !!projects?.length);
    if (human) {
      await finishDecision(run.id, {
        ...jevFields,
        outcome: 'escalated',
        reason: human,
        suggestion: { suggested: 'clasificar', options: [{ kind: 'clasificar', detail: NEEDS_HUMAN_DETAIL[human] }] },
      });
      return { outcome: 'escalated', decisionId: run.id, chosenDevId: null, reason: human };
    }

    // 3. Decidir (política pura).
    const devs = await loadDevFacts(classification.projectId, task.id);
    const facts: TaskFacts = {
      id: task.id,
      projectId: classification.projectId,
      priority: classification.priority,
      dueDate: classification.dueDate,
      points: classification.points,
      urgency: classification.urgency,
      skill: classification.skill,
      secondarySkill: classification.secondarySkill,
    };
    const decision = decide({ task: facts, devs, today });
    const record = {
      ...jevFields,
      classification: { ...classification, today, deadline: decision.deadline, horizonDays: decision.horizonDays } as Classification & Record<string, unknown>,
      candidates: decision.candidates,
      tie_breaks: decision.tieBreaks,
    };
    const estimateToSave = classification.pointsSource === 'jev' ? classification.points : null;

    // 4. Aplicar.
    if (decision.outcome === 'assigned' && decision.chosen) {
      const applied = await assignIfUnassigned(task.id, decision.chosen.devId, estimateToSave);
      if (!applied) {
        // Una persona asignó a mano mientras roz decidía: gana la persona.
        await finishDecision(run.id, { ...record, outcome: 'skipped', reason: 'ya_asignada' });
        return { outcome: 'skipped', decisionId: run.id, chosenDevId: null, reason: 'ya_asignada' };
      }
      await finishDecision(run.id, {
        ...record,
        outcome: 'assigned',
        chosen_dev_id: decision.chosen.devId,
        effective_hours: decision.chosen.effectiveHours,
      });
      log('auto-assign: asignada', { taskId: task.id, devId: decision.chosen.devId, tier: decision.chosen.tier });
      return { outcome: 'assigned', decisionId: run.id, chosenDevId: decision.chosen.devId, reason: null };
    }

    if (estimateToSave) await setEstimateIfNull(task.id, estimateToSave);
    await finishDecision(run.id, { ...record, outcome: 'escalated', reason: 'sin_candidatos', suggestion: decision.suggestion });
    log('auto-assign: escalada', { taskId: task.id, suggested: decision.suggestion?.suggested });
    return { outcome: 'escalated', decisionId: run.id, chosenDevId: null, reason: 'sin_candidatos' };
  } catch (err) {
    const isJev = err instanceof TypeSafeError;
    const retryable = isJev ? err.retryable : true;
    const message = isJev
      ? `${err.message}${err.detail ? `: ${typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail)}` : ''}`
      : err instanceof Error
        ? err.message
        : String(err);
    const attempt = opts.attempt ?? 1;
    const canRetry = !!opts.background && retryable && attempt < (opts.maxAttempts ?? 1);

    if (canRetry) {
      // La corrida sigue `pending`: el reintento del outbox la retoma.
      await updateDecision(run.id, { error: message, ...(request ? { jev_request: request } : {}) }).catch(() => {});
      throw err;
    }
    await finishDecision(run.id, {
      outcome: 'failed',
      reason: isJev ? 'error_jev' : 'error_interno',
      error: message,
      ...(request ? { jev_request: request } : {}),
    }).catch(() => {});
    log('auto-assign: falló', { taskId: task.id, error: message, retryable });
    // En segundo plano se relanza para que la cola lo muestre como muerto; en línea se devuelve.
    if (opts.background) throw err;
    return { outcome: 'failed', decisionId: run.id, chosenDevId: null, reason: isJev ? 'error_jev' : 'error_interno', retryable };
  }
}

// ---------------------------------------------------------------- segundo plano (outbox)

export interface AutoAssignEventPayload {
  taskId: string;
  identifier: string;
  origin: AutoAssignOrigin;
  requestedBy: string | null;
}

/**
 * Encola la asignación (outbox): reintentos con backoff y visible en la consola de la cola. Quien
 * llama puede además procesarla al instante con `consume(id)` en segundo plano para no esperar al
 * cron. Devuelve el id del evento, o null si ya estaba encolado.
 */
export async function enqueueAutoAssign(p: AutoAssignEventPayload, key: string = p.origin): Promise<string | null> {
  return emit('work_item.auto_assign', { ...p }, { idempotencyKey: `auto-assign:${p.taskId}:${key}` });
}

export async function autoAssignFromEvent(
  payload: Record<string, unknown>,
  ctx: { attempt: number; maxAttempts: number },
): Promise<void> {
  const taskId = String(payload.taskId ?? '');
  if (!taskId) return;
  await autoAssign(taskId, (payload.origin as AutoAssignOrigin) ?? 'create', {
    requestedBy: (payload.requestedBy as string | null) ?? null,
    attempt: ctx.attempt,
    maxAttempts: ctx.maxAttempts,
    background: true,
  });
}
