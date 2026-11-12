// Lectura/escritura de roz.meeting y roz.meeting_candidate, y el mapeo fila (snake_case) → lo que
// viaja por HTTP (camelCase, tipos de src/types/roz-v2.ts). Las lecturas relacionadas (proyecto,
// issue duplicado, dev propuesto, tipo de solución) se resuelven en LOTE con `in (…)`, sin joins
// embebidos de PostgREST: meeting_candidate tiene dos FKs a work_item y dos a dev, y el embed
// ambiguo falla en runtime.
import { db } from '../db/supabase.js';
import { avatarFor } from '../dashboard/queries.js';
import type { TaskState } from '../tasks/states.js';
import type {
  InboxCandidate,
  LinearPriority,
  MeetingAttendee,
  MeetingCandidate,
  MeetingCandidateKind,
  MeetingCandidateStatus,
  MeetingDetail,
  MeetingProjectSource,
  MeetingSource,
  MeetingStatus,
  MeetingSummary,
  TranscriptFormat,
} from '../types/roz-v2.js';

// ---------------------------------------------------------------- filas

export const MEETING_COLUMNS =
  'id, source, external_id, title, held_at, duration_min, attendees, project_id, project_source, transcript_format, status, error, extraction_model, extracted_at, created_by, created_by_dev_id, created_at, updated_at';

export interface MeetingRow {
  id: string;
  source: MeetingSource;
  external_id: string | null;
  title: string;
  held_at: string;
  duration_min: number | null;
  attendees: MeetingAttendee[] | null;
  project_id: string | null;
  project_source: MeetingProjectSource | null;
  transcript_format: TranscriptFormat;
  status: MeetingStatus;
  error: string | null;
  extraction_model: string | null;
  extracted_at: string | null;
  created_by: string | null;
  created_by_dev_id: string | null;
  created_at: string;
  updated_at: string;
  /** Solo cuando se pide (detalle / pipeline): puede pesar cientos de KB. */
  transcript?: string;
}

export const CANDIDATE_COLUMNS =
  'id, meeting_id, kind, title, description, quote, quote_start, owner_hint, due_hint, due_date, classification, jev_model, solution_type_id, estimate, priority, duplicate_work_item_id, duplicate_score, proposed_dev_id, assignment_decision_id, status, discard_reason, linear_issue_id, linear_identifier, linear_comment_id, work_item_id, knowledge_atom_id, decided_by, decided_by_dev_id, decided_at, created_at, updated_at';

export interface CandidateRow {
  id: string;
  meeting_id: string;
  kind: MeetingCandidateKind;
  title: string;
  description: string | null;
  quote: string;
  quote_start: number | null;
  owner_hint: string | null;
  due_hint: string | null;
  due_date: string | null;
  classification: unknown;
  jev_model: string | null;
  solution_type_id: string | null;
  estimate: number | null;
  priority: number | null;
  duplicate_work_item_id: string | null;
  duplicate_score: number | null;
  proposed_dev_id: string | null;
  assignment_decision_id: string | null;
  status: MeetingCandidateStatus;
  discard_reason: string | null;
  linear_issue_id: string | null;
  linear_identifier: string | null;
  linear_comment_id: string | null;
  work_item_id: string | null;
  knowledge_atom_id: string | null;
  decided_by: string | null;
  decided_by_dev_id: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

function uniq(ids: (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((x): x is string => !!x))];
}

// ---------------------------------------------------------------- lecturas sueltas

export async function loadMeeting(id: string, withTranscript = false): Promise<MeetingRow | null> {
  const { data, error } = await db()
    .from('meeting')
    .select(withTranscript ? `${MEETING_COLUMNS}, transcript` : MEETING_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as MeetingRow) ?? null;
}

export async function loadCandidate(id: string): Promise<CandidateRow | null> {
  const { data, error } = await db().from('meeting_candidate').select(CANDIDATE_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as unknown as CandidateRow) ?? null;
}

export async function projectNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const list = uniq(ids);
  if (!list.length) return new Map();
  const { data, error } = await db().from('project').select('id, name').in('id', list);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
}

// ---------------------------------------------------------------- juntas → HTTP

type Counts = MeetingSummary['counts'];
const ZERO: Counts = { pendientes: 0, aceptadas: 0, descartadas: 0, decisiones: 0 };

async function countsFor(meetingIds: string[]): Promise<Map<string, Counts>> {
  const out = new Map<string, Counts>();
  if (!meetingIds.length) return out;
  const { data, error } = await db().from('meeting_candidate').select('meeting_id, kind, status').in('meeting_id', meetingIds);
  if (error) throw error;
  for (const r of (data ?? []) as { meeting_id: string; kind: MeetingCandidateKind; status: MeetingCandidateStatus }[]) {
    const c = { ...(out.get(r.meeting_id) ?? ZERO) };
    if (r.kind === 'decision') c.decisiones++;
    else if (r.status === 'pendiente') c.pendientes++;
    else if (r.status === 'aceptada' || r.status === 'comentada') c.aceptadas++;
    else if (r.status === 'descartada') c.descartadas++;
    out.set(r.meeting_id, c);
  }
  return out;
}

function summaryOf(m: MeetingRow, names: Map<string, string>, counts: Map<string, Counts>): MeetingSummary {
  return {
    id: m.id,
    source: m.source,
    title: m.title,
    heldAt: m.held_at,
    durationMin: m.duration_min ?? null,
    attendees: Array.isArray(m.attendees) ? m.attendees : [],
    projectId: m.project_id ?? null,
    projectName: m.project_id ? names.get(m.project_id) ?? null : null,
    projectSource: m.project_source ?? null,
    transcriptFormat: m.transcript_format,
    status: m.status,
    error: m.error ?? null,
    extractedAt: m.extracted_at ?? null,
    counts: counts.get(m.id) ?? { ...ZERO },
    createdAt: m.created_at,
  };
}

export async function toSummaries(rows: MeetingRow[]): Promise<MeetingSummary[]> {
  const [names, counts] = await Promise.all([projectNames(rows.map((r) => r.project_id)), countsFor(rows.map((r) => r.id))]);
  return rows.map((r) => summaryOf(r, names, counts));
}

export async function toSummary(row: MeetingRow): Promise<MeetingSummary> {
  return (await toSummaries([row]))[0]!;
}

export async function toDetail(row: MeetingRow): Promise<MeetingDetail> {
  return { ...(await toSummary(row)), transcript: row.transcript ?? '', extractionModel: row.extraction_model ?? null };
}

// ---------------------------------------------------------------- candidatas → HTTP

export async function toCandidates(rows: CandidateRow[]): Promise<MeetingCandidate[]> {
  if (!rows.length) return [];
  const dupIds = uniq(rows.map((r) => r.duplicate_work_item_id));
  const issueIds = uniq(rows.map((r) => r.work_item_id));
  const devIds = uniq([...rows.map((r) => r.proposed_dev_id), ...rows.map((r) => r.decided_by_dev_id)]);
  const typeIds = uniq(rows.map((r) => r.solution_type_id));

  const [items, devs, types] = await Promise.all([
    uniq([...dupIds, ...issueIds]).length
      ? db().from('work_item').select('id, identifier, name, status, url, linear_id').in('id', uniq([...dupIds, ...issueIds]))
      : Promise.resolve({ data: [], error: null }),
    devIds.length ? db().from('dev').select('id, name, github_login').in('id', devIds) : Promise.resolve({ data: [], error: null }),
    typeIds.length ? db().from('solution_type').select('id, name').in('id', typeIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (items.error) throw items.error;
  if (devs.error) throw devs.error;
  if (types.error) throw types.error;

  type Item = { id: string; identifier: string; name: string; status: TaskState; url: string | null; linear_id: string | null };
  const itemById = new Map(((items.data ?? []) as Item[]).map((w) => [w.id, w]));
  const devById = new Map(((devs.data ?? []) as { id: string; name: string; github_login: string | null }[]).map((d) => [d.id, d]));
  const typeById = new Map(((types.data ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]));

  return rows.map((r): MeetingCandidate => {
    const dup = r.duplicate_work_item_id ? itemById.get(r.duplicate_work_item_id) : undefined;
    const proposed = r.proposed_dev_id ? devById.get(r.proposed_dev_id) : undefined;
    const decider = r.decided_by_dev_id ? devById.get(r.decided_by_dev_id) : undefined;
    const created = r.work_item_id ? itemById.get(r.work_item_id) : undefined;
    return {
      id: r.id,
      meetingId: r.meeting_id,
      kind: r.kind,
      title: r.title,
      description: r.description ?? null,
      quote: r.quote,
      quoteStart: r.quote_start ?? null,
      ownerHint: r.owner_hint ?? null,
      dueHint: r.due_hint ?? null,
      dueDate: r.due_date ?? null,
      solutionTypeId: r.solution_type_id ?? null,
      solutionTypeName: r.solution_type_id ? typeById.get(r.solution_type_id) ?? null : null,
      estimate: r.estimate ?? null,
      priority: (r.priority ?? null) as Exclude<LinearPriority, 0> | null,
      duplicate: dup
        ? { workItemId: dup.id, identifier: dup.identifier, name: dup.name, status: dup.status, url: dup.url ?? null, score: r.duplicate_score ?? 0 }
        : null,
      proposedDev: proposed ? { id: proposed.id, name: proposed.name, avatarUrl: avatarFor(proposed.github_login ?? null) } : null,
      assignmentDecisionId: r.assignment_decision_id ?? null,
      status: r.status,
      discardReason: r.discard_reason ?? null,
      issue: r.linear_issue_id || r.work_item_id
        ? {
            linearIssueId: r.linear_issue_id ?? created?.linear_id ?? '',
            identifier: r.linear_identifier ?? created?.identifier ?? '',
            url: created?.url ?? null,
          }
        : null,
      linearCommentId: r.linear_comment_id ?? null,
      knowledgeAtomId: r.knowledge_atom_id ?? null,
      decidedAt: r.decided_at ?? null,
      decidedBy: decider ? { id: decider.id, name: decider.name } : null,
      createdAt: r.created_at,
    };
  });
}

export async function toCandidate(row: CandidateRow): Promise<MeetingCandidate> {
  return (await toCandidates([row]))[0]!;
}

export async function toInbox(rows: CandidateRow[], meetings: MeetingRow[]): Promise<InboxCandidate[]> {
  const [cands, names] = await Promise.all([toCandidates(rows), projectNames(meetings.map((m) => m.project_id))]);
  const byId = new Map(meetings.map((m) => [m.id, m]));
  return cands
    .filter((c) => byId.has(c.meetingId))
    .map((c) => {
      const m = byId.get(c.meetingId)!;
      return {
        ...c,
        meeting: {
          id: m.id,
          title: m.title,
          heldAt: m.held_at,
          projectId: m.project_id ?? null,
          projectName: m.project_id ? names.get(m.project_id) ?? null : null,
        },
      };
    });
}
