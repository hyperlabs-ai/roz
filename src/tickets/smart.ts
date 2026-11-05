// Tickets inteligentes (/ticket): la persona escribe nombre, proyecto y descripción; roz completa lo
// demás con Jev (tipo de solución → skill, nivel, puntos; urgencia), propone responsable con la
// política de asignación y, al confirmar, crea la tarea asignada y le manda un DM al responsable
// DESDE EL PERFIL de quien pidió el ticket.
//
//   previewTicket → una request a Jev + política (sin escribir la tarea). Queda una fila `preview`
//                   en assignment_decision. Corregir tipo/puntos/prioridad/fecha NO vuelve a llamar
//                   a Jev: se reusa su respuesta y solo se recalcula la política.
//   createTicket  → reclama la vista previa (atómico), recalcula con la carga actual, crea la tarea,
//                   completa la misma fila como la decisión de esa tarea y manda el DM.
import { config } from '../config.js';
import { systemOne, TypeSafeError, type SystemOneRequest, type SystemOneResponse } from '../adapters/typesafe.js';
import { buildJevRequest, needsHuman, readClassification, type Classification, type TaskInput } from '../assign/classify.js';
import { loadActiveProjects, loadCatalog, loadDevFacts, loadSolutionTypes } from '../assign/context.js';
import {
  claimPreview,
  finishPreview,
  insertPreview,
  loadDecision,
  releasePreview,
  updateDecision,
  type DecisionRow,
} from '../assign/decisions.js';
import { NEEDS_HUMAN_DETAIL } from '../assign/index.js';
import { QUESTIONS_VERSION } from '../assign/jev-questions.js';
import { POLICY_VERSION, decide, type CandidateEval, type Suggestion, type TieBreak } from '../assign/policy.js';
import { validateOverride } from '../assign/rules.js';
import { openDm } from '../chat/conversations.js';
import { sendMessage } from '../chat/messages.js';
import { db } from '../db/supabase.js';
import { createTask, getTicketById } from '../dashboard/queries.js';
import { AppError, ValidationError } from '../utils/errors.js';
import { todayLocal } from '../utils/team-time.js';
import {
  applyCorrections,
  assignmentMessage,
  canReuseAnswers,
  checkPreview,
  needsOverrideOnCreate,
  normalizeTicket,
  shouldMessage,
  suggestedPriority,
  type TicketCorrections,
  type TicketInput,
} from './rules.js';

export interface TicketUser {
  /** auth.users.id (requested_by / created_by). */
  userId: string;
  /** roz.dev.id: el perfil desde el que sale el DM. */
  devId: string;
}

type Log = (msg: string, data: Record<string, unknown>) => void;

/** Lo que se guarda en `classification` de la fila: la clasificación + contexto de la decisión. */
type StoredClassification = Classification & {
  today: string;
  deadline: string | null;
  horizonDays: number | null;
  ticket: TicketInput;
  suggestedPriority: 'urgent' | 'medium';
};

export interface TicketPlan {
  /** Lo que haría roz: asignar a alguien o escalar (sin candidatos / no está claro el tipo). */
  outcome: 'assigned' | 'escalated';
  reason: string | null;
  chosenDevId: string | null;
  effectiveHours: number | null;
  candidates: CandidateEval[];
  tieBreaks: TieBreak[];
  suggestion: Suggestion | { suggested: 'clasificar'; options: { kind: 'clasificar'; detail: string }[] } | null;
  classification: StoredClassification;
}

export interface TicketPreviewResult extends TicketPlan {
  previewId: string;
  jevModel: string | null;
  /** Se reutilizó la respuesta de Jev (solo cambiaron las correcciones). */
  reused: boolean;
  devNames: Record<string, string>;
}

// ---------------------------------------------------------------- piezas

async function activeProject(projectId: string) {
  const project = (await loadActiveProjects()).find((p) => p.id === projectId);
  if (!project) throw new ValidationError('el proyecto no existe o no está activo');
  return project;
}

function baseTaskInput(
  t: TicketInput,
  project: { name: string; kind: string | null; type?: string | null; description?: string | null; typeKey?: string | null },
): TaskInput {
  return {
    id: 'ticket',
    name: t.title,
    description: t.description || null,
    projectId: t.projectId,
    projectName: project.name,
    projectKind: project.kind,
    projectType: project.type ?? null,
    projectDescription: project.description ?? null,
    projectTypeKey: project.typeKey ?? null,
    priority: null,
    prioritySource: 'humano',
    dueDate: null,
    estimate: null,
    solutionTypeId: null,
  };
}

function jevFailure(err: unknown): never {
  if (err instanceof TypeSafeError) {
    const detail = err.detail ? `: ${typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail)}` : '';
    throw new AppError(
      err.retryable ? 'JEV_UNAVAILABLE' : 'JEV_ERROR',
      `roz no pudo leer el ticket (${err.message}${detail}). ${err.retryable ? 'Intenta de nuevo en un momento.' : ''}`.trim(),
      502,
    );
  }
  throw err;
}

/** Clasificación + política para un ticket, con la carga del equipo de AHORA. Sin escrituras. */
async function plan(
  ticket: TicketInput,
  corrections: TicketCorrections | undefined,
  response: SystemOneResponse,
): Promise<TicketPlan> {
  const project = await activeProject(ticket.projectId);
  const catalog = await loadCatalog();
  const types = await loadSolutionTypes(catalog);
  if (corrections?.solutionTypeId && !types.some((t) => t.id === corrections.solutionTypeId)) {
    throw new ValidationError('ese tipo de solución no existe');
  }
  const task = applyCorrections(baseTaskInput(ticket, project), corrections);
  const today = todayLocal();
  const classification = readClassification(response.answers, task, catalog, types, null, today);
  const stored = (extra: { deadline: string | null; horizonDays: number | null }): StoredClassification => ({
    ...classification,
    today,
    ...extra,
    ticket,
    suggestedPriority: suggestedPriority(classification.urgency),
  });

  const human = needsHuman(classification, task, false);
  if (human) {
    return {
      outcome: 'escalated',
      reason: human,
      chosenDevId: null,
      effectiveHours: null,
      candidates: [],
      tieBreaks: [],
      suggestion: { suggested: 'clasificar', options: [{ kind: 'clasificar', detail: NEEDS_HUMAN_DETAIL[human] ?? human }] },
      classification: stored({ deadline: null, horizonDays: null }),
    };
  }

  const devs = await loadDevFacts(ticket.projectId, null);
  const decision = decide({
    task: {
      id: 'ticket',
      projectId: ticket.projectId,
      priority: classification.priority,
      dueDate: classification.dueDate,
      points: classification.points,
      urgency: classification.urgency,
      skill: classification.skill,
      secondarySkill: classification.secondarySkill,
    },
    devs,
    today,
  });
  return {
    outcome: decision.outcome,
    reason: decision.outcome === 'assigned' ? null : 'sin_candidatos',
    chosenDevId: decision.chosen?.devId ?? null,
    effectiveHours: decision.chosen?.effectiveHours ?? null,
    candidates: decision.candidates,
    tieBreaks: decision.tieBreaks,
    suggestion: decision.suggestion,
    classification: stored({ deadline: decision.deadline, horizonDays: decision.horizonDays }),
  };
}

function planFields(p: TicketPlan) {
  return {
    classification: p.classification,
    candidates: p.candidates,
    tie_breaks: p.tieBreaks,
    chosen_dev_id: p.chosenDevId,
    effective_hours: p.effectiveHours,
    suggestion: p.suggestion,
    reason: p.reason,
  };
}

function storedTicket(row: DecisionRow): TicketInput | null {
  const c = row.classification as { ticket?: TicketInput } | null;
  return c?.ticket ?? null;
}

async function devNames(): Promise<Record<string, string>> {
  const { data } = await db().from('dev').select('id, name');
  return Object.fromEntries(((data ?? []) as { id: string; name: string }[]).map((d) => [d.id, d.name]));
}

// ---------------------------------------------------------------- vista previa

export async function previewTicket(
  user: TicketUser,
  rawInput: TicketInput,
  opts: { previewId?: string | null; corrections?: TicketCorrections; log?: Log } = {},
): Promise<TicketPreviewResult> {
  const input = normalizeTicket(rawInput);
  if (!input.title) throw new ValidationError('el ticket necesita un nombre');
  const log = opts.log ?? (() => {});

  // ¿Hay una vista previa del mismo texto? Entonces Jev ya respondió: solo se recalcula la política.
  const prev = opts.previewId ? await loadDecision(opts.previewId) : null;
  const check = prev ? checkPreview({ ...prev, ticket: storedTicket(prev) }, input, user.userId) : null;
  let request: SystemOneRequest;
  let response: SystemOneResponse;
  let model: string | null;
  const reused = !!prev && !!check && canReuseAnswers(check);
  if (reused) {
    request = prev!.jev_request as SystemOneRequest;
    response = prev!.jev_response as SystemOneResponse;
    model = prev!.jev_model;
  } else {
    const project = await activeProject(input.projectId);
    const catalog = await loadCatalog();
    const types = await loadSolutionTypes(catalog);
    request = buildJevRequest(baseTaskInput(input, project), catalog, types, null, config.typesafe.model);
    try {
      response = await systemOne(request);
    } catch (err) {
      log('ticket: Jev falló en la vista previa', { error: String(err) });
      jevFailure(err);
    }
    model = response.model;
    log('ticket: clasificado', { model: response.model, inputTokens: response.usage.input_tokens });
  }

  const p = await plan(input, opts.corrections, response);
  let previewId: string;
  if (prev && check === 'ok') {
    await updateDecision(prev.id, planFields(p));
    previewId = prev.id;
  } else {
    const row = await insertPreview({
      requestedBy: user.userId,
      policyVersion: POLICY_VERSION,
      questions_version: QUESTIONS_VERSION,
      jev_model: model,
      jev_request: request,
      jev_response: response,
      ...planFields(p),
    });
    previewId = row.id;
  }
  return { ...p, previewId, jevModel: model, reused, devNames: await devNames() };
}

// ---------------------------------------------------------------- crear

export interface CreateTicketInput extends TicketInput {
  previewId: string;
  corrections?: TicketCorrections;
  /** Responsable final (el que propuso roz u otro). null = crear sin responsable. */
  assigneeDevId: string | null;
  override?: { category: string; note?: string | null };
}

export interface CreateTicketResult {
  task: Awaited<ReturnType<typeof getTicketById>>;
  identifier: string;
  conversationId: string | null;
  messageSent: boolean;
}

export async function createTicket(user: TicketUser, body: CreateTicketInput, opts: { log?: Log } = {}): Promise<CreateTicketResult> {
  const log = opts.log ?? (() => {});
  const input = normalizeTicket(body);
  if (!input.title) throw new ValidationError('el ticket necesita un nombre');

  const row = await loadDecision(body.previewId);
  if (!row) throw new AppError('PREVIEW_STALE', 'La vista previa ya no existe: vuelve a previsualizar', 409);
  const check = checkPreview({ ...row, ticket: storedTicket(row) }, input, user.userId);
  if (check === 'ya_usada' || check === 'no_es_vista_previa') throw new AppError('PREVIEW_USED', 'Este ticket ya se creó', 409);
  if (check === 'otro_autor' || check === 'texto_cambio') {
    throw new AppError('PREVIEW_STALE', 'El ticket cambió desde la vista previa: vuelve a previsualizar', 409);
  }

  // Lo que haría roz AHORA (la carga pudo cambiar desde la vista previa). Sin volver a llamar a Jev.
  const p = await plan(input, body.corrections, row.jev_response as SystemOneResponse);
  const rozChoice = p.chosenDevId;

  const assignee = body.assigneeDevId ?? null;
  if (assignee) {
    const { data } = await db().from('dev').select('id, active').eq('id', assignee).maybeSingle();
    if (!data || (data as { active: boolean }).active === false) throw new ValidationError('el responsable no existe o no está activo');
  }
  let override: { category: string; note: string | null } | null = null;
  if (needsOverrideOnCreate(rozChoice, assignee)) {
    if (!body.override) throw new AppError('OVERRIDE_REASON_REQUIRED', 'Cuéntanos por qué cambias al responsable que propuso roz', 409);
    override = validateOverride(body.override);
  }

  // Reclamo atómico: dos "Crear ticket" con la misma vista previa no crean dos tareas.
  if (!(await claimPreview(row.id))) throw new AppError('PREVIEW_USED', 'Este ticket ya se creó', 409);

  let created: { id: string; identifier: string };
  try {
    created = await createTask({
      projectId: input.projectId,
      name: input.title,
      description: input.description || null,
      priority: body.corrections?.priority ?? p.classification.suggestedPriority,
      dueDate: body.corrections?.dueDate ?? null,
      estimate: p.classification.points,
      solutionTypeId: p.classification.solutionType?.id ?? null,
      assigneeDevIds: assignee ? [assignee] : [],
      createdBy: user.userId,
    });
  } catch (err) {
    await releasePreview(row.id).catch(() => {});
    throw err;
  }

  // La vista previa pasa a ser la decisión de la tarea (lo que se ve en "¿Por qué?").
  await finishPreview(row.id, created.id, {
    ...planFields(p),
    outcome: rozChoice ? 'assigned' : 'escalated',
    ...(override
      ? {
          overridden_at: new Date().toISOString(),
          overridden_by: user.userId,
          override_dev_id: assignee,
          override_category: override.category,
          override_note: override.note,
        }
      : {}),
  }).catch((err) => log('ticket: no se pudo cerrar la decisión', { taskId: created.id, error: String(err) }));

  // DM desde el perfil de quien pidió el ticket. Si falla, la tarea igual queda creada.
  let conversationId: string | null = null;
  let messageSent = false;
  if (shouldMessage(user.devId, assignee)) {
    try {
      const dm = await openDm(user.devId, [assignee]);
      conversationId = dm.id;
      await sendMessage(user.devId, dm.id, { body: assignmentMessage(created.identifier) }, (err) =>
        log('ticket: el aviso del DM falló en segundo plano', { taskId: created.id, error: String(err) }),
      );
      messageSent = true;
    } catch (err) {
      log('ticket: no se pudo mandar el DM', { taskId: created.id, error: String(err) });
    }
  }

  return { task: await getTicketById(created.id), identifier: created.identifier, conversationId, messageSent };
}
