// Lo que roz ESCRIBE en Linear (roz v2): crear issues (/ticket, intake, juntas), comentar un
// duplicado y reasignar (reclamar un plan). Cada escritura deja el espejo al día EN EL MOMENTO con
// el issue que devolvió Linear (source 'create'), así quien llama tiene su work_item sin esperar al
// webhook, y el webhook que llega después es un no-op (mismo updatedAt).
//
// Lo que no se puede mapear (etiqueta, asignado) NO falla: se crea igual y se devuelve como
// warning para la UI. Lo que no tiene arreglo (sin equipo de Linear, sin usuario para reasignar)
// es un error claro con código.
import { db } from '../db/supabase.js';
import { createComment, createIssue, updateIssue } from '../adapters/linear.js';
import { AppError } from '../utils/errors.js';
import type { IssueOrigin, LinearPriority, PlanReassignLinearPayload } from '../types/roz-v2.js';
import { labelForSolutionType, linearUserForDev, teamForProject } from './links.js';
import { upsertMirrorFromLinear } from './mirror.js';

export interface CreateIssueFromTicketInput {
  /** roz.project.id. El equipo de Linear sale de project.linear_team_id ?? config.linear.teamId. */
  projectId: string;
  title: string;
  description: string | null;
  /** → etiqueta de Linear vía linear_link(kind='label'). Sin vínculo: se omite + warning. */
  solutionTypeId: string | null;
  /** Puntos (1,2,3,5,8,13). */
  estimate: number | null;
  /** 1 urgente … 4 baja. null = sin prioridad (0). */
  priority: Exclude<LinearPriority, 0> | null;
  /** roz.dev.id → usuario de Linear por correo. Sin match: se crea sin asignado + warning. */
  assigneeDevId: string | null;
  dueDate: string | null; // YYYY-MM-DD
  origin: IssueOrigin;
  /** Rastro en la descripción del issue ("Desde la junta X: «cita»"). */
  source?: { meetingId?: string; candidateId?: string; quote?: string; requester?: string | null };
  /** auth.users.id de quien lo pidió (null en intake). */
  requestedBy: string | null;
  /** Estado inicial (id de estado de Linear). Solo lo usa la migración de tareas nativas. */
  stateId?: string | null;
}

export interface CreatedIssue {
  linearIssueId: string;
  identifier: string; // "HYP-123"
  url: string;
  workItemId: string;
  assigneeDevId: string | null;
  warnings: string[];
}

const ORIGIN_LABEL: Record<IssueOrigin, string> = {
  ticket: 'un ticket de roz (/ticket)',
  intake: 'una solicitud externa (intake)',
  meeting: 'una junta',
};

/** Pie de la descripción: de dónde vino el issue. Puro (probado). */
export function issueDescription(input: Pick<CreateIssueFromTicketInput, 'description' | 'origin' | 'source'>, meetingTitle?: string | null): string {
  const parts: string[] = [];
  const body = input.description?.trim();
  if (body) parts.push(body);
  const trail: string[] = [];
  if (input.origin === 'meeting') {
    const head = meetingTitle ? `Desde la junta «${meetingTitle}»` : 'Desde una junta';
    const quote = input.source?.quote?.trim();
    trail.push(quote ? `${head}:\n\n> ${quote.replace(/\n+/g, '\n> ')}` : `${head}.`);
  } else {
    trail.push(`Creado por roz desde ${ORIGIN_LABEL[input.origin]}.`);
  }
  if (input.source?.requester) trail.push(`Lo pidió: ${input.source.requester}`);
  parts.push(`---\n${trail.join('\n\n')}`);
  return parts.join('\n\n');
}

async function meetingTitle(meetingId: string | undefined): Promise<string | null> {
  if (!meetingId) return null;
  const { data } = await db().from('meeting').select('title').eq('id', meetingId).maybeSingle();
  return (data as { title: string } | null)?.title ?? null;
}

export async function createIssueFromTicket(input: CreateIssueFromTicketInput): Promise<CreatedIssue> {
  const team = await teamForProject(input.projectId);
  if (!team) {
    throw new AppError(
      'LINEAR_TEAM_MISSING',
      'Este proyecto no tiene equipo de Linear (ni hay LINEAR_TEAM_ID por defecto): ligalo a un equipo antes de crear issues.',
      422,
    );
  }
  const { data: p } = await db().from('project').select('linear_project_id').eq('id', input.projectId).maybeSingle();
  const linearProjectId = (p as { linear_project_id: string | null } | null)?.linear_project_id ?? null;

  const warnings: string[] = [];
  let labelIds: string[] = [];
  if (input.solutionTypeId) {
    const label = await labelForSolutionType(input.solutionTypeId, team.teamId);
    if (label) labelIds = [label];
    else warnings.push('El tipo de solución no tiene etiqueta en Linear: el issue se creó sin etiqueta.');
  }
  let assigneeId: string | null = null;
  if (input.assigneeDevId) {
    assigneeId = await linearUserForDev(input.assigneeDevId);
    if (!assigneeId) warnings.push('El responsable no tiene usuario en Linear (no coincide su correo): el issue se creó sin asignado.');
  }

  const issue = await createIssue({
    teamId: team.teamId,
    title: input.title.trim(),
    description: issueDescription(input, await meetingTitle(input.source?.meetingId)),
    projectId: linearProjectId,
    labelIds,
    estimate: input.estimate,
    priority: input.priority ?? 0,
    assigneeId,
    stateId: input.stateId ?? null,
    dueDate: input.dueDate,
  });

  const mirror = await upsertMirrorFromLinear(issue, { source: 'create' });
  if (input.requestedBy) {
    // Quién lo pidió en roz (el issue en Linear lo firma la llave de API).
    await db().from('work_item').update({ created_by: input.requestedBy }).eq('id', mirror.workItemId).is('created_by', null);
  }
  return {
    linearIssueId: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    workItemId: mirror.workItemId,
    assigneeDevId: mirror.assigneeDevId,
    warnings,
  };
}

// ---------------------------------------------------------------- comentar (duplicados)

export async function commentOnIssue(input: {
  workItemId?: string;
  linearIssueId?: string;
  body: string;
}): Promise<{ commentId: string; url: string | null; identifier: string }> {
  const supabase = db();
  let linearId = input.linearIssueId ?? null;
  let identifier: string | null = null;
  if (input.workItemId) {
    const { data } = await supabase.from('work_item').select('linear_id, identifier').eq('id', input.workItemId).maybeSingle();
    const w = data as { linear_id: string | null; identifier: string } | null;
    if (!w) throw new AppError('NOT_FOUND', 'El issue no existe en roz', 404);
    if (!w.linear_id) throw new AppError('NOT_IN_LINEAR', `${w.identifier} no está en Linear: no se puede comentar ahí`, 409);
    linearId = w.linear_id;
    identifier = w.identifier;
  } else if (linearId) {
    const { data } = await supabase.from('work_item').select('identifier').eq('linear_id', linearId).maybeSingle();
    identifier = (data as { identifier: string } | null)?.identifier ?? null;
  }
  if (!linearId) throw new AppError('VALIDATION_ERROR', 'commentOnIssue necesita workItemId o linearIssueId', 400);
  const body = input.body.trim();
  if (!body) throw new AppError('VALIDATION_ERROR', 'El comentario está vacío', 400);
  const c = await createComment(linearId, body);
  return { commentId: c.id, url: c.url, identifier: identifier ?? linearId };
}

// ---------------------------------------------------------------- reasignar (reclamar)

export async function reassignIssue(input: {
  workItemId: string;
  toDevId: string;
  reason: 'reclamado' | 'manual';
}): Promise<{ assigneeLinearId: string; identifier: string }> {
  const { data } = await db().from('work_item').select('linear_id, identifier').eq('id', input.workItemId).maybeSingle();
  const w = data as { linear_id: string | null; identifier: string } | null;
  if (!w) throw new AppError('NOT_FOUND', 'El issue no existe en roz', 404);
  if (!w.linear_id) throw new AppError('NOT_IN_LINEAR', `${w.identifier} no está en Linear: no se puede reasignar ahí`, 409);
  const assigneeLinearId = await linearUserForDev(input.toDevId);
  if (!assigneeLinearId) {
    throw new AppError('LINEAR_USER_MISSING', 'Esa persona no tiene usuario en Linear (no coincide su correo)', 422);
  }
  const issue = await updateIssue(w.linear_id, { assigneeId: assigneeLinearId });
  // source 'create': lo hizo roz; la corrección ('reclamado') ya la registró la acción de reclamar.
  await upsertMirrorFromLinear(issue, { source: 'create' });
  return { assigneeLinearId, identifier: issue.identifier };
}

/** Outbox 'plan.reassign_linear' → cambia el asignado en Linear. Los errores de Linear se relanzan (reintenta el outbox). */
export async function reassignFromEvent(payload: Record<string, unknown>): Promise<void> {
  const p = payload as unknown as Partial<PlanReassignLinearPayload>;
  if (!p.workItemId || !p.toDevId) return;
  await reassignIssue({ workItemId: p.workItemId, toDevId: p.toDevId, reason: 'reclamado' });
}
