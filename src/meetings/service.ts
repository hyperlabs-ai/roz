// Juntas: lo que llaman las rutas del dashboard (src/routes/meetings.ts). Crear una junta solo
// guarda el texto normalizado y encola `meeting.extract`; el trabajo pesado (Claude, Jev, dedup)
// corre en el outbox (pipeline.ts). Aceptar una candidata crea el issue en Linear (o, con el flag
// apagado, la tarea nativa por el mismo camino que /ticket) o comenta el duplicado.
import { config } from '../config.js';
import { finishPreview } from '../assign/decisions.js';
import { validateOverride, type OverrideCategory } from '../assign/rules.js';
import { db } from '../db/supabase.js';
import { addTaskComment, createTask } from '../dashboard/queries.js';
import { emitMeetingExtract } from './events.js';
import { commentOnIssue, createIssueFromTicket } from '../linear/index.js';
import { linearSourceOfTruth } from '../linear/enabled.js';
import { needsOverrideOnCreate } from '../tickets/rules.js';
import type {
  InboxCandidate,
  ManualTranscriptFormat,
  MeetingAttendee,
  MeetingCandidate,
  MeetingDetail,
  MeetingStatus,
  MeetingSummary,
} from '../types/roz-v2.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { emailDomain, resolveProjectByDomains, type DomainResolution } from './domains.js';
import { relinkMeetingAtoms } from './pipeline.js';
import { acceptMode, duplicateComment, inboxKind, meetingTrail, rozPriorityOf } from './rules.js';
import {
  CANDIDATE_COLUMNS,
  MEETING_COLUMNS,
  loadCandidate,
  loadMeeting,
  toCandidate,
  toCandidates,
  toDetail,
  toInbox,
  toSummaries,
  toSummary,
  type CandidateRow,
  type MeetingRow,
} from './store.js';
import { normalizeTranscript } from './transcript.js';

type Log = (msg: string, data: Record<string, unknown>) => void;

/** Quién hace la acción (sale de la sesión, nunca del body). */
export interface MeetingUser {
  /** auth.users.id */
  id: string;
  devId: string;
  devName: string;
}

// ---- Contrato HTTP (docs/roz-v2-contracts.md §b; espejo en web/src/lib/api.ts)

export interface CreateMeetingRequest {
  title: string;
  heldAt: string;
  durationMin?: number | null;
  attendees: MeetingAttendee[];
  projectId?: string | null;
  format: ManualTranscriptFormat;
  content: string;
  fileName?: string | null;
}

export interface AcceptCandidateRequest {
  mode?: 'crear' | 'comentar';
  title?: string;
  description?: string | null;
  assigneeDevId?: string | null;
  priority?: 1 | 2 | 3 | 4 | null;
  estimate?: number | null;
  solutionTypeId?: string | null;
  dueDate?: string | null;
  override?: { category: OverrideCategory; note?: string | null };
}

export interface AcceptCandidateResponse {
  candidate: MeetingCandidate;
  issue: { linearIssueId: string; identifier: string; url: string; workItemId: string } | null;
  comment: { commentId: string; url: string | null; identifier: string } | null;
  warnings: string[];
}

// ---------------------------------------------------------------- piezas

/** Asistentes limpios: correo en minúsculas, nombre o (si falta) la parte local del correo. */
export function cleanAttendees(list: MeetingAttendee[]): MeetingAttendee[] {
  const out: MeetingAttendee[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    const email = a.email?.trim().toLowerCase() || null;
    const name = a.name?.trim() || email?.split('@')[0] || '';
    if (!name) continue;
    const key = email ?? `name:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name.slice(0, 200), email: email && emailDomain(email) ? email : null });
  }
  return out.slice(0, 100);
}

async function assertProject(projectId: string): Promise<void> {
  const { data, error } = await db().from('project').select('id').eq('id', projectId).maybeSingle();
  if (error) throw error;
  if (!data) throw new ValidationError('el proyecto no existe');
}

/** Dominios del equipo (los de los devs y los permitidos del dashboard): no dicen de qué cliente es la junta. */
async function teamDomains(): Promise<string[]> {
  const { data, error } = await db().from('dev').select('email, github_email');
  if (error) throw error;
  const domains = new Set<string>(config.dashboard.allowedDomains);
  for (const d of (data ?? []) as { email: string | null; github_email: string | null }[]) {
    for (const e of [d.email, d.github_email]) {
      const dom = emailDomain(e);
      if (dom && !dom.endsWith('users.noreply.github.com')) domains.add(dom);
    }
  }
  return [...domains];
}

/** Proyecto por dominio del correo de los asistentes (project.client_email_domains). */
export async function resolveProjectForEmails(emails: string[]): Promise<DomainResolution> {
  const { data, error } = await db().from('project').select('id, name, active, client_email_domains');
  if (error) throw error;
  const projects = ((data ?? []) as { id: string; name: string; active: boolean | null; client_email_domains: string[] | null }[])
    .filter((p) => p.active !== false && (p.client_email_domains ?? []).length > 0)
    .map((p) => ({ id: p.id, name: p.name, domains: p.client_email_domains ?? [] }));
  if (!projects.length) return { projectId: null, matches: [] };
  return resolveProjectByDomains(emails, projects, await teamDomains());
}

function extractKey(meetingId: string, n: string | number): string {
  return `meeting-extract:${meetingId}:${n}`;
}

// ---------------------------------------------------------------- juntas

export async function createMeeting(user: MeetingUser, req: CreateMeetingRequest, opts: { log?: Log } = {}): Promise<MeetingSummary> {
  const title = req.title.trim();
  if (!title) throw new ValidationError('la junta necesita un título');
  const heldAt = new Date(req.heldAt);
  if (Number.isNaN(heldAt.getTime())) throw new ValidationError('fecha de la junta inválida');
  const transcript = normalizeTranscript(req.format, req.content, req.fileName ?? null);
  const attendees = cleanAttendees(req.attendees ?? []);

  let projectId: string | null = null;
  let projectSource: 'dominio' | 'elegido' | null = null;
  if (req.projectId) {
    await assertProject(req.projectId);
    projectId = req.projectId;
    projectSource = 'elegido';
  } else {
    const r = await resolveProjectForEmails(attendees.map((a) => a.email).filter((e): e is string => !!e));
    if (r.projectId) {
      projectId = r.projectId;
      projectSource = 'dominio';
    }
  }

  const { data, error } = await db()
    .from('meeting')
    .insert({
      source: 'manual',
      title: title.slice(0, 200),
      held_at: heldAt.toISOString(),
      duration_min: req.durationMin ?? null,
      attendees,
      project_id: projectId,
      project_source: projectSource,
      transcript_format: req.format,
      transcript,
      status: 'pendiente',
      created_by: user.id,
      created_by_dev_id: user.devId,
    })
    .select(MEETING_COLUMNS)
    .single();
  if (error) throw error;
  const row = data as unknown as MeetingRow;
  await emitMeetingExtract({ meetingId: row.id }, extractKey(row.id, 0));
  opts.log?.('juntas: creada', { meetingId: row.id, projectId, projectSource, chars: transcript.length });
  return toSummary(row);
}

export async function listMeetings(opts: { status?: MeetingStatus | null; projectId?: string | null; limit?: number }): Promise<MeetingSummary[]> {
  let q = db()
    .from('meeting')
    .select(MEETING_COLUMNS)
    .order('held_at', { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 30, 1), 100));
  if (opts.status) q = q.eq('status', opts.status);
  if (opts.projectId) q = q.eq('project_id', opts.projectId);
  const { data, error } = await q;
  if (error) throw error;
  return toSummaries((data ?? []) as unknown as MeetingRow[]);
}

export async function getMeeting(id: string): Promise<{ meeting: MeetingDetail; candidates: MeetingCandidate[] }> {
  const row = await loadMeeting(id, true);
  if (!row) throw new NotFoundError('la junta no existe');
  const { data, error } = await db().from('meeting_candidate').select(CANDIDATE_COLUMNS).eq('meeting_id', id).order('created_at');
  if (error) throw error;
  const [meeting, candidates] = await Promise.all([toDetail(row), toCandidates((data ?? []) as unknown as CandidateRow[])]);
  return { meeting, candidates };
}

export async function setMeetingProject(id: string, projectId: string | null): Promise<MeetingSummary> {
  if (projectId) await assertProject(projectId);
  const { data, error } = await db()
    .from('meeting')
    .update({ project_id: projectId, project_source: projectId ? 'elegido' : null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(MEETING_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('la junta no existe');
  await relinkMeetingAtoms(id, projectId);
  return toSummary(data as unknown as MeetingRow);
}

/** Solo una junta en 'error'. El paso a 'pendiente' es condicional: dos clics no encolan dos veces. */
export async function retryMeeting(id: string): Promise<MeetingSummary> {
  const { data, error } = await db()
    .from('meeting')
    .update({ status: 'pendiente', error: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'error')
    .select(MEETING_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const exists = await loadMeeting(id);
    if (!exists) throw new NotFoundError('la junta no existe');
    throw new AppError('MEETING_NOT_FAILED', 'Solo se reintenta una junta con error', 409);
  }
  const row = data as unknown as MeetingRow;
  await emitMeetingExtract({ meetingId: id }, extractKey(id, Date.parse(row.updated_at) || Date.now()));
  return toSummary(row);
}

export async function deleteMeeting(id: string): Promise<void> {
  const { data, error } = await db().from('meeting').delete().eq('id', id).select('id');
  if (error) throw error;
  if (!(data ?? []).length) throw new NotFoundError('la junta no existe');
}

/** La bandeja: tareas y compromisos pendientes de todas las juntas (o de un proyecto). */
export async function listInbox(opts: { projectId?: string | null } = {}): Promise<InboxCandidate[]> {
  let meetingIds: string[] | null = null;
  if (opts.projectId) {
    const { data, error } = await db().from('meeting').select('id').eq('project_id', opts.projectId);
    if (error) throw error;
    meetingIds = ((data ?? []) as { id: string }[]).map((m) => m.id);
    if (!meetingIds.length) return [];
  }
  let q = db()
    .from('meeting_candidate')
    .select(CANDIDATE_COLUMNS)
    .eq('status', 'pendiente')
    .in('kind', ['tarea', 'compromiso'])
    .order('created_at', { ascending: false })
    .limit(200);
  if (meetingIds) q = q.in('meeting_id', meetingIds.slice(0, 300));
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as CandidateRow[];
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.meeting_id))];
  const { data: ms, error: mErr } = await db().from('meeting').select(MEETING_COLUMNS).in('id', ids);
  if (mErr) throw mErr;
  return toInbox(rows, (ms ?? []) as unknown as MeetingRow[]);
}

// ---------------------------------------------------------------- bandeja: decidir

/**
 * Reclamo atómico de una candidata: `decided_at` pasa de null a ahora solo si sigue pendiente. Dos
 * "Aceptar" a la vez → uno gana, el otro recibe 409 CANDIDATE_DECIDED.
 */
async function claimCandidate(id: string, user: MeetingUser): Promise<CandidateRow> {
  const { data, error } = await db()
    .from('meeting_candidate')
    .update({ decided_at: new Date().toISOString(), decided_by: user.id, decided_by_dev_id: user.devId })
    .eq('id', id)
    .eq('status', 'pendiente')
    .is('decided_at', null)
    .select(CANDIDATE_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError('CANDIDATE_DECIDED', 'Alguien ya decidió esta candidata', 409);
  return data as unknown as CandidateRow;
}

async function releaseCandidate(id: string): Promise<void> {
  await db().from('meeting_candidate').update({ decided_at: null, decided_by: null, decided_by_dev_id: null }).eq('id', id).eq('status', 'pendiente');
}

async function finishCandidate(id: string, patch: Record<string, unknown>): Promise<CandidateRow> {
  const { data, error } = await db()
    .from('meeting_candidate')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(CANDIDATE_COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as CandidateRow;
}

async function loadPending(id: string): Promise<{ cand: CandidateRow; meeting: MeetingRow }> {
  const cand = await loadCandidate(id);
  if (!cand) throw new NotFoundError('la candidata no existe');
  if (cand.status !== 'pendiente' || cand.decided_at || !inboxKind(cand.kind)) {
    throw new AppError('CANDIDATE_DECIDED', 'Esta candidata ya se decidió', 409);
  }
  const meeting = await loadMeeting(cand.meeting_id);
  if (!meeting) throw new NotFoundError('la junta no existe');
  return { cand, meeting };
}

async function assertActiveDev(devId: string): Promise<void> {
  const { data, error } = await db().from('dev').select('id, active').eq('id', devId).maybeSingle();
  if (error) throw error;
  if (!data || (data as { active: boolean }).active === false) throw new ValidationError('el responsable no existe o no está activo');
}

export async function acceptCandidate(
  user: MeetingUser,
  candidateId: string,
  body: AcceptCandidateRequest,
  opts: { log?: Log } = {},
): Promise<AcceptCandidateResponse> {
  const log: Log = opts.log ?? (() => {});
  const { cand, meeting } = await loadPending(candidateId);
  const mode = acceptMode(body.mode, !!cand.duplicate_work_item_id);
  const meetingRef = { title: meeting.title, heldAt: meeting.held_at };

  // ---- comentar el duplicado
  if (mode === 'comentar') {
    if (!cand.duplicate_work_item_id) {
      throw new AppError('NO_DUPLICATE', 'Esta candidata no tiene un issue duplicado que comentar', 422);
    }
    const workItemId = cand.duplicate_work_item_id;
    await claimCandidate(cand.id, user);
    let comment: AcceptCandidateResponse['comment'];
    try {
      const text = duplicateComment(meetingRef, { title: cand.title, description: cand.description, quote: cand.quote });
      if (linearSourceOfTruth()) {
        comment = await commentOnIssue({ workItemId, body: text });
      } else {
        const { data: wi } = await db().from('work_item').select('identifier').eq('id', workItemId).maybeSingle();
        const c = await addTaskComment(workItemId, { authorId: user.id, authorName: user.devName, body: text });
        comment = { commentId: c.id, url: null, identifier: (wi as { identifier: string } | null)?.identifier ?? '' };
      }
    } catch (err) {
      await releaseCandidate(cand.id).catch(() => {});
      throw err;
    }
    const row = await finishCandidate(cand.id, {
      status: 'comentada',
      linear_comment_id: linearSourceOfTruth() ? comment!.commentId : null,
      work_item_id: workItemId,
      linear_identifier: comment!.identifier || null,
    });
    return { candidate: await toCandidate(row), issue: null, comment: comment!, warnings: [] };
  }

  // ---- crear el issue
  if (!meeting.project_id) {
    throw new AppError('MEETING_PROJECT_MISSING', 'Elige el proyecto de la junta antes de crear issues', 422);
  }
  const proposed = cand.proposed_dev_id;
  const assignee = body.assigneeDevId !== undefined ? body.assigneeDevId : proposed;
  if (assignee) await assertActiveDev(assignee);
  let override: { category: string; note: string | null } | null = null;
  if (needsOverrideOnCreate(proposed, assignee ?? null)) {
    if (!body.override) throw new AppError('OVERRIDE_REASON_REQUIRED', 'Cuéntanos por qué cambias al responsable que propuso roz', 409);
    override = validateOverride(body.override);
  }

  const title = (body.title ?? cand.title).trim();
  if (!title) throw new ValidationError('el issue necesita un título');
  const description = body.description !== undefined ? body.description?.trim() || null : cand.description;
  const priority = body.priority !== undefined ? body.priority : ((cand.priority ?? null) as 1 | 2 | 3 | 4 | null);
  const estimate = body.estimate !== undefined ? body.estimate : cand.estimate;
  const solutionTypeId = body.solutionTypeId !== undefined ? body.solutionTypeId : cand.solution_type_id;
  const dueDate = body.dueDate !== undefined ? body.dueDate : cand.due_date;

  await claimCandidate(cand.id, user);
  let issue: NonNullable<AcceptCandidateResponse['issue']>;
  let warnings: string[] = [];
  try {
    if (linearSourceOfTruth()) {
      const created = await createIssueFromTicket({
        projectId: meeting.project_id,
        title,
        description,
        solutionTypeId: solutionTypeId ?? null,
        estimate: estimate ?? null,
        priority: priority ?? null,
        assigneeDevId: assignee ?? null,
        dueDate: dueDate ?? null,
        origin: 'meeting',
        source: { meetingId: meeting.id, candidateId: cand.id, quote: cand.quote, requester: null },
        requestedBy: user.id,
      });
      issue = { linearIssueId: created.linearIssueId, identifier: created.identifier, url: created.url, workItemId: created.workItemId };
      warnings = created.warnings ?? [];
    } else {
      // Flag apagado: tarea nativa por el mismo camino que /ticket (createTask), con el rastro de la junta.
      const created = await createTask({
        projectId: meeting.project_id,
        name: title,
        description: [description, meetingTrail(meetingRef, cand.quote)].filter(Boolean).join('\n\n'),
        priority: rozPriorityOf(priority ?? null) ?? 'medium',
        dueDate: dueDate ?? null,
        estimate: estimate ?? null,
        solutionTypeId: solutionTypeId ?? null,
        assigneeDevIds: assignee ? [assignee] : [],
        createdBy: user.id,
      });
      const { data: wi } = await db().from('work_item').select('url').eq('id', created.id).maybeSingle();
      issue = { linearIssueId: '', identifier: created.identifier, url: (wi as { url: string | null } | null)?.url ?? '', workItemId: created.id };
    }
  } catch (err) {
    await releaseCandidate(cand.id).catch(() => {});
    throw err;
  }

  // La decisión de la vista previa pasa a ser la del issue (lo que se ve en "¿Por qué?").
  if (cand.assignment_decision_id) {
    await finishPreview(cand.assignment_decision_id, issue.workItemId, {
      outcome: proposed ? 'assigned' : 'escalated',
      ...(override
        ? {
            overridden_at: new Date().toISOString(),
            overridden_by: user.id,
            override_dev_id: assignee ?? null,
            override_category: override.category,
            override_note: override.note,
          }
        : {}),
    }).catch((err) => log('juntas: no se pudo cerrar la decisión de asignación', { candidateId: cand.id, error: String(err) }));
  }

  const row = await finishCandidate(cand.id, {
    status: 'aceptada',
    linear_issue_id: issue.linearIssueId || null,
    linear_identifier: issue.identifier,
    work_item_id: issue.workItemId,
  });
  return { candidate: await toCandidate(row), issue, comment: null, warnings };
}

export async function discardCandidate(user: MeetingUser, candidateId: string, reason: string | null): Promise<MeetingCandidate> {
  await loadPending(candidateId);
  const { data, error } = await db()
    .from('meeting_candidate')
    .update({
      status: 'descartada',
      discard_reason: reason?.trim() || null,
      decided_at: new Date().toISOString(),
      decided_by: user.id,
      decided_by_dev_id: user.devId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', candidateId)
    .eq('status', 'pendiente')
    .is('decided_at', null)
    .select(CANDIDATE_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError('CANDIDATE_DECIDED', 'Alguien ya decidió esta candidata', 409);
  return toCandidate(data as unknown as CandidateRow);
}
