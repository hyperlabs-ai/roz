// Espejo de Linear en roz.work_item (roz v2). Con ROZ_LINEAR_SOT encendido es la ÚNICA escritura
// de work_item: webhook, reconciliación y lo que roz crea/reasigna en Linear pasan todos por
// upsertMirrorFromLinear con el issue completo que devolvió Linear.
//
// Reglas (docs/roz-v2-contracts.md §a):
//   · Llave: work_item.linear_id = issue.id.
//   · MONÓTONO: un issue con updatedAt <= linear_updated_at guardado no escribe nada. Webhook y
//     reconciliación llegan en cualquier orden; el update además es condicional en la base, así dos
//     escrituras simultáneas no se pisan hacia atrás.
//   · Un identificador que choca con una tarea nativa (mismo HYP-305, sin linear_id) no la pisa:
//     la nativa se renombra a HYP-305-1 (solo pasa con tareas creadas antes de encender el flag).
//   · Efectos (los emite el espejo, no quien llama): plan.enqueue cuando el issue queda asignado a
//     un dev; work_item.assigned (aviso, misma llave que las tareas nativas → sin doble aviso);
//     work_item.done al completarse; transición del plan vivo al cerrarse o cancelarse; y un cambio
//     de asignado hecho EN LINEAR se registra como corrección en assignment_decision, igual que hoy
//     cuando se cambia en el dashboard.
import { db } from '../db/supabase.js';
import type { LinearIssue } from '../adapters/linear.js';
import { latestDecision, recordOverride } from '../assign/decisions.js';
import { isOverride } from '../assign/rules.js';
import { emit } from '../events/outbox.js';
import { OPEN_STATES, type TaskState } from '../tasks/states.js';
import {
  LINEAR_PRIORITY_TO_ROZ,
  linearStateToStatus,
  type PlanEnqueuePayload,
  type PlanStatus,
} from '../types/roz-v2.js';
import { emitV2 } from './emit.js';
import { devForLinearUser, projectForLinear, solutionTypeForLabels } from './links.js';

export type MirrorSource = 'webhook' | 'reconcile' | 'create';

export interface MirrorResult {
  workItemId: string;
  created: boolean;
  status: TaskState;
  statusChanged: boolean;
  previousStatus: TaskState | null;
  assigneeDevId: string | null;
  previousAssigneeDevId: string | null;
  assigneeChanged: boolean;
  /** true = el issue venía con updatedAt <= linear_updated_at guardado: no se escribió nada. */
  stale: boolean;
}

export interface MirrorOptions {
  source: MirrorSource;
  /**
   * false = solo escribe el espejo, sin efectos (plan, avisos, correcciones). Lo usa la migración de
   * tareas nativas: re-encolar 100 planes y mandar 100 avisos de un golpe no es lo que se quiere.
   */
  effects?: boolean;
}

/** Columnas del work_item que el espejo necesita leer antes de escribir. */
const EXISTING_COLUMNS =
  'id, identifier, status, assignee_dev_id, linear_updated_at, started_at, completed_at, canceled_at, project_id, solution_type_id';

export interface ExistingMirror {
  id: string;
  identifier: string;
  status: TaskState;
  assignee_dev_id: string | null;
  linear_updated_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  project_id: string | null;
  solution_type_id: string | null;
}

export interface ResolvedRefs {
  projectId: string | null;
  assigneeDevId: string | null;
  solutionTypeId: string | null;
}

// ---------------------------------------------------------------- piezas puras (probadas)

/**
 * status de roz para un issue. Un issue ARCHIVADO sale del trabajo vivo: si estaba completado sigue
 * `completada` (Linear archiva solo lo cerrado viejo, y eso no debe contar como cancelado); si no,
 * `cancelada`.
 */
export function mirrorStatus(issue: Pick<LinearIssue, 'state' | 'archivedAt'>): TaskState {
  const status = linearStateToStatus(issue.state.type, issue.state.name);
  if (issue.archivedAt && status !== 'completada') return 'cancelada';
  return status;
}

/** ¿El issue es más nuevo que lo guardado? Sin fecha guardada, siempre. */
export function isNewer(issueUpdatedAt: string, storedUpdatedAt: string | null | undefined): boolean {
  if (!storedUpdatedAt) return true;
  return Date.parse(issueUpdatedAt) > Date.parse(storedUpdatedAt);
}

/** Primer `<base>-N` (N = 1, 2…) que no está tomado. */
export function renamedIdentifier(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** La fila del espejo. Los timestamps de roz (started/completed/canceled) se conservan si ya había. */
export function buildMirrorRow(issue: LinearIssue, refs: ResolvedRefs, existing: ExistingMirror | null, now = new Date().toISOString()) {
  const status = mirrorStatus(issue);
  return {
    linear_id: issue.id,
    identifier: issue.identifier,
    number: issue.number,
    name: issue.title,
    description: issue.description,
    status,
    priority: LINEAR_PRIORITY_TO_ROZ[issue.priority],
    linear_priority: issue.priority,
    estimate: issue.estimate === null ? null : Math.round(issue.estimate),
    due_date: issue.dueDate,
    labels: issue.labels.map((l) => l.name),
    url: issue.url,
    // Un issue que ya no se sabe a qué proyecto va no pierde el que tenía.
    project_id: refs.projectId ?? existing?.project_id ?? null,
    assignee_dev_id: refs.assigneeDevId,
    // Sin etiqueta ligada se conserva el que había (lo pudo fijar Jev o una persona al crear).
    solution_type_id: refs.solutionTypeId ?? existing?.solution_type_id ?? null,
    linear_team_id: issue.team.id,
    linear_project_id: issue.project?.id ?? null,
    linear_state_id: issue.state.id,
    linear_state_type: issue.state.type,
    linear_state_name: issue.state.name,
    linear_assignee_id: issue.assignee?.id ?? null,
    linear_cycle: issue.cycle,
    linear_branch_name: issue.branchName,
    linear_created_at: issue.createdAt,
    linear_updated_at: issue.updatedAt,
    linear_completed_at: issue.completedAt,
    linear_canceled_at: issue.canceledAt,
    started_at: existing?.started_at ?? issue.startedAt,
    completed_at: status === 'completada' ? existing?.completed_at ?? issue.completedAt ?? now : existing?.completed_at ?? null,
    canceled_at: status === 'cancelada' ? existing?.canceled_at ?? issue.canceledAt ?? issue.archivedAt ?? now : existing?.canceled_at ?? null,
    creator_name: issue.creator ? issue.creator.displayName || issue.creator.name : null,
    source: 'linear',
    linear_synced_at: now,
    updated_at: now,
  };
}

// ---------------------------------------------------------------- base

async function loadByLinearId(linearId: string): Promise<ExistingMirror | null> {
  const { data, error } = await db().from('work_item').select(EXISTING_COLUMNS).eq('linear_id', linearId).maybeSingle();
  if (error) throw error;
  return (data as unknown as ExistingMirror) ?? null;
}

/**
 * Si `identifier` lo tiene una tarea NATIVA (sin linear_id) distinta de `selfId`, la renombra a
 * `<identifier>-N`. Una fila que ya es espejo de otro issue no se toca: es un movimiento de equipo en
 * Linear a medio reconciliar y el siguiente upsert de ese issue lo corrige.
 */
async function freeIdentifier(identifier: string, selfId: string | null, log: (m: string, d: Record<string, unknown>) => void): Promise<void> {
  const supabase = db();
  const { data } = await supabase.from('work_item').select('id, linear_id').eq('identifier', identifier).maybeSingle();
  const holder = data as { id: string; linear_id: string | null } | null;
  if (!holder || holder.id === selfId || holder.linear_id) return;
  const { data: similar } = await supabase.from('work_item').select('identifier').like('identifier', `${identifier}-%`);
  const next = renamedIdentifier(identifier, ((similar ?? []) as { identifier: string }[]).map((r) => r.identifier));
  const { error } = await supabase.from('work_item').update({ identifier: next, updated_at: new Date().toISOString() }).eq('id', holder.id);
  if (error) throw error;
  log('linear: identificador en conflicto con una tarea nativa; la nativa se renombró', { identifier, renamedTo: next, workItemId: holder.id });
}

async function syncAssignee(workItemId: string, devId: string | null): Promise<void> {
  const supabase = db();
  await supabase.from('work_item_assignee').delete().eq('work_item_id', workItemId);
  if (devId) await supabase.from('work_item_assignee').insert({ work_item_id: workItemId, dev_id: devId });
}

const defaultLog = (msg: string, data: Record<string, unknown>) => console.warn(msg, data);

export async function upsertMirrorFromLinear(
  issue: LinearIssue,
  opts: MirrorOptions,
  log: (msg: string, data: Record<string, unknown>) => void = defaultLog,
): Promise<MirrorResult> {
  const supabase = db();
  const existing = await loadByLinearId(issue.id);

  if (existing && !isNewer(issue.updatedAt, existing.linear_updated_at)) {
    return {
      workItemId: existing.id,
      created: false,
      status: existing.status,
      statusChanged: false,
      previousStatus: existing.status,
      assigneeDevId: existing.assignee_dev_id,
      previousAssigneeDevId: existing.assignee_dev_id,
      assigneeChanged: false,
      stale: true,
    };
  }

  const [projectId, assigneeDevId, solutionTypeId] = await Promise.all([
    projectForLinear(issue.team.id, issue.project?.id ?? null),
    issue.assignee ? devForLinearUser(issue.assignee.id) : Promise.resolve(null),
    solutionTypeForLabels(issue.labels.map((l) => l.id)),
  ]);
  const row = buildMirrorRow(issue, { projectId, assigneeDevId, solutionTypeId }, existing);

  if (!existing || existing.identifier !== issue.identifier) await freeIdentifier(issue.identifier, existing?.id ?? null, log);

  let workItemId: string;
  let created = false;
  if (existing) {
    // Condicional: si otra escritura más nueva ganó mientras resolvíamos, esta no la pisa.
    let q = supabase.from('work_item').update(row).eq('id', existing.id);
    q = existing.linear_updated_at ? q.lt('linear_updated_at', issue.updatedAt) : q.is('linear_updated_at', null);
    const { data, error } = await q.select('id');
    if (error) throw error;
    if (!data || (data as unknown[]).length === 0) {
      const fresh = await loadByLinearId(issue.id);
      return {
        workItemId: existing.id,
        created: false,
        status: fresh?.status ?? existing.status,
        statusChanged: false,
        previousStatus: existing.status,
        assigneeDevId: fresh?.assignee_dev_id ?? existing.assignee_dev_id,
        previousAssigneeDevId: existing.assignee_dev_id,
        assigneeChanged: false,
        stale: true,
      };
    }
    workItemId = existing.id;
  } else {
    const { data, error } = await supabase.from('work_item').insert(row).select('id').single();
    if (error) {
      // 23505 sobre linear_id: otro webhook/tick creó la fila en el mismo instante. Se reintenta
      // como update (una sola vez: la fila ya existe).
      if ((error as { code?: string }).code === '23505' && (await loadByLinearId(issue.id))) {
        return upsertMirrorFromLinear(issue, opts, log);
      }
      throw error;
    }
    workItemId = (data as { id: string }).id;
    created = true;
  }

  const previousAssigneeDevId = existing?.assignee_dev_id ?? null;
  const previousStatus = existing?.status ?? null;
  const assigneeChanged = previousAssigneeDevId !== assigneeDevId;
  const statusChanged = previousStatus !== row.status;
  if (assigneeChanged || created) await syncAssignee(workItemId, assigneeDevId);

  const result: MirrorResult = {
    workItemId,
    created,
    status: row.status,
    statusChanged,
    previousStatus,
    assigneeDevId,
    previousAssigneeDevId,
    assigneeChanged,
    stale: false,
  };
  if (opts.effects !== false) await mirrorEffects(issue, result, opts.source, log);
  return result;
}

// ---------------------------------------------------------------- efectos

async function mirrorEffects(issue: LinearIssue, r: MirrorResult, source: MirrorSource, log: (m: string, d: Record<string, unknown>) => void): Promise<void> {
  const open = OPEN_STATES.includes(r.status);

  if (r.assigneeChanged && r.assigneeDevId && open) {
    const payload: PlanEnqueuePayload = {
      workItemId: r.workItemId,
      linearIssueId: issue.id,
      ownerDevId: r.assigneeDevId,
      reason: r.previousAssigneeDevId ? 'reasignado' : 'asignado',
    };
    await emitV2('plan.enqueue', payload, { idempotencyKey: `plan:${r.workItemId}:${r.assigneeDevId}:${issue.updatedAt}` });
    // El aviso de asignación de siempre (correo/push). Misma llave que createTask/updateTask.
    await emit(
      'work_item.assigned',
      { workItemId: r.workItemId, devId: r.assigneeDevId, identifier: issue.identifier },
      { idempotencyKey: `assigned:${r.workItemId}:${r.assigneeDevId}` },
    );
  }

  // Un cambio de asignado hecho en Linear corrige a roz igual que uno hecho en el dashboard. Lo que
  // roz mismo hizo (crear, reclamar) llega con source 'create' y ya dejó su propio registro.
  if (r.assigneeChanged && !r.created && source !== 'create') {
    await recordLinearReassignment(r.workItemId, r.previousAssigneeDevId, r.assigneeDevId).catch((err) =>
      log('linear: no se pudo registrar la corrección de asignado', { workItemId: r.workItemId, error: String(err) }),
    );
  }

  if (r.statusChanged && r.status === 'completada') {
    await emit('work_item.done', { identifier: issue.identifier }, { idempotencyKey: `done:${issue.identifier}` }).catch(() => {});
    await transitionLivePlan(r.workItemId, 'issue_cerrado').catch((err) =>
      log('linear: no se pudo cerrar el plan del issue', { workItemId: r.workItemId, error: String(err) }),
    );
  } else if (r.statusChanged && r.status === 'cancelada') {
    await transitionLivePlan(r.workItemId, 'issue_cancelado').catch((err) =>
      log('linear: no se pudo cancelar el plan del issue', { workItemId: r.workItemId, error: String(err) }),
    );
  }
}

/** Nota de la corrección cuando el cambio de responsable se hizo directo en Linear. */
export const LINEAR_REASSIGN_NOTE = 'Cambiado directamente en Linear';

/**
 * Registra como override (categoría 'otro' + nota) un cambio de asignado hecho en Linear, con la
 * MISMA regla que el dashboard (isOverride): solo si la última decisión fue una asignación de roz,
 * aún sin corregir, y el responsable anterior era el que roz eligió.
 */
export async function recordLinearReassignment(workItemId: string, previousDevId: string | null, nextDevId: string | null): Promise<boolean> {
  const latest = await latestDecision(workItemId);
  if (!latest) return false;
  const lite = { outcome: latest.outcome, chosenDevId: latest.chosen_dev_id, overriddenAt: latest.overridden_at };
  if (!isOverride(lite, previousDevId, nextDevId ? [nextDevId] : [])) return false;
  await recordOverride(latest.id, { userId: null, devId: nextDevId, category: 'otro', note: LINEAR_REASSIGN_NOTE });
  return true;
}

/**
 * Transición del plan vivo del issue por lo que pasó en Linear (cerrado/cancelado). La máquina de
 * estados y la atomicidad viven en src/plans (applyIssueTransition): aquí solo se le avisa. Import
 * dinámico: src/plans importa piezas de este módulo y así no se forma un ciclo al cargar.
 */
export async function transitionLivePlan(workItemId: string, t: 'issue_cerrado' | 'issue_cancelado'): Promise<PlanStatus | null> {
  const { applyIssueTransition } = await import('../plans/service.js');
  const r = await applyIssueTransition(workItemId, t);
  return r.status;
}

/** Issue borrado en Linear (webhook 'remove'): sale del trabajo vivo como `cancelada`. */
export async function retireMirror(linearIssueId: string): Promise<{ workItemId: string | null }> {
  const existing = await loadByLinearId(linearIssueId);
  if (!existing) return { workItemId: null };
  if (existing.status !== 'cancelada') {
    const now = new Date().toISOString();
    const { error } = await db()
      .from('work_item')
      .update({ status: 'cancelada', canceled_at: existing.canceled_at ?? now, linear_synced_at: now, updated_at: now })
      .eq('id', existing.id);
    if (error) throw error;
    await transitionLivePlan(existing.id, 'issue_cancelado').catch(() => null);
  }
  return { workItemId: existing.id };
}
