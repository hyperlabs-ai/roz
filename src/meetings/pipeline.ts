// Pipeline de una junta (evento de outbox `meeting.extract`):
//
//   1. meeting.status = 'extrayendo'
//   2. Claude extrae tareas / compromisos / decisiones, cada una con cita (extract.ts)
//   3. el CÓDIGO verifica que cada cita exista en el texto; la que no, se descarta (quotes.ts)
//   4. decisiones → átomo del brain del proyecto + candidata 'guardada' (no pasan por la bandeja)
//   5. tareas/compromisos → Jev (preguntas q3) → tipo, puntos, urgencia → prioridad 1-4
//   6. dedup contra el espejo de work_item con search_work_items_hybrid (rules.ts: pickDuplicate)
//   7. política p2 → responsable propuesto + fila assignment_decision (origin 'meeting', 'preview')
//   8. meeting.status = 'lista'
//
// Idempotente: una junta 'lista' no se reprocesa, y un reintento tras una corrida a medias borra las
// candidatas que esa corrida dejó sin decidir antes de volver a extraer (las decisiones del brain se
// deduplican por content_hash, así que no se duplican átomos).
//
// Fallas: Claude responde mal dos veces → status 'error' ("revisar: …") y NO se relanza (reintentar
// no lo arregla). Error de red/API → se relanza para que el outbox reintente; en el ÚLTIMO intento,
// la junta queda en 'error' con el motivo (no se queda "extrayendo" para siempre).
// Jev o la búsqueda de duplicados fallan para UNA candidata → la candidata queda sin clasificar o
// sin duplicado (la persona decide igual en la bandeja); no se pierde la extracción ya pagada.
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { embed, embeddingModel } from '../adapters/embeddings.js';
import { systemOne, type SystemOneRequest, type SystemOneResponse } from '../adapters/typesafe.js';
import { buildJevRequest, needsHuman, readClassification, type CatalogSkill, type SolutionTypeDef, type TaskInput } from '../assign/classify.js';
import { loadCatalog, loadDevFacts, loadProject, loadSolutionTypes } from '../assign/context.js';
import { autoAssignEnabled } from '../assign/enabled.js';
import { QUESTIONS_VERSION } from '../assign/jev-questions.js';
import { POLICY_VERSION, decide, type DevFacts } from '../assign/policy.js';
import type { ProjectOption } from '../assign/classify.js';
import { db } from '../db/supabase.js';
import type { MeetingCandidateKind, MeetingExtractPayload } from '../types/roz-v2.js';
import { todayLocal } from '../utils/team-time.js';
import { ExtractionError, extractFromTranscript, type CompleteFn, type ExtractedDecision, type ExtractedItem } from './extract.js';
import { keepVerified } from './quotes.js';
import { decisionAtomBody, pickDuplicate, priorityFromUrgency, type DuplicateHit } from './rules.js';
import { loadMeeting, projectNames, type MeetingRow } from './store.js';

type Log = (msg: string, data: Record<string, unknown>) => void;

export interface ExtractContext {
  attempt: number;
  maxAttempts: number;
  log?: Log;
  /** Solo tests: Claude simulado. */
  completeFn?: CompleteFn;
}

export interface ExtractResult {
  status: 'lista' | 'error' | 'omitida';
  candidates: number;
  decisions: number;
  dropped: number;
}

/** Cuántas candidatas se clasifican con Jev a la vez (cada una es una request). */
const JEV_CONCURRENCY = 3;

async function setStatus(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db()
    .from('meeting')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function embeddingLiteral(v: number[] | null): string | null {
  return v ? `[${v.join(',')}]` : null;
}

async function tryEmbed(text: string): Promise<number[] | null> {
  if (!config.openai.apiKey) return null;
  try {
    return await embed(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 4. decisiones → brain

/**
 * Átomo del brain para una decisión. Procedencia `meeting:<id>`; dedup por content_hash dentro de esa
 * procedencia (reprocesar la junta no duplica). Sin proyecto, el átomo queda sin proyecto y se liga
 * cuando la persona elige el proyecto (relinkMeetingAtoms).
 */
export async function saveDecisionAtom(meeting: Pick<MeetingRow, 'id' | 'title' | 'held_at' | 'project_id'>, d: ExtractedDecision): Promise<string> {
  const title = d.title.trim();
  const body = decisionAtomBody({ title: meeting.title, heldAt: meeting.held_at }, d);
  const hash = createHash('sha256').update(`${title}\n${body}`).digest('hex');
  const provenance = `meeting:${meeting.id}`;

  const { data: existing, error: exErr } = await db()
    .from('knowledge_atom')
    .select('id')
    .contains('provenance', [provenance])
    .eq('content_hash', hash)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();
  if (exErr) throw exErr;
  if (existing) return (existing as { id: string }).id;

  const vector = await tryEmbed(`${title}\n${body}`);
  const { data, error } = await db()
    .from('knowledge_atom')
    .insert({
      scope: 'project',
      project_id: meeting.project_id,
      status: 'active',
      title,
      body,
      provenance: [provenance],
      embedding: embeddingLiteral(vector),
      embedding_model: vector ? embeddingModel : null,
      content_hash: hash,
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/** Al elegir proyecto para una junta, sus decisiones (átomos sin proyecto) pasan a ese proyecto. */
export async function relinkMeetingAtoms(meetingId: string, projectId: string | null): Promise<void> {
  if (!projectId) return;
  const { error } = await db()
    .from('knowledge_atom')
    .update({ project_id: projectId, updated_at: new Date().toISOString() })
    .contains('provenance', [`meeting:${meetingId}`])
    .is('project_id', null);
  if (error) throw error;
}

// ---------------------------------------------------------------- 6. duplicados

/** El issue abierto del espejo más parecido, si pasa el umbral. Best-effort: si falla, null. */
export async function findDuplicate(
  projectId: string,
  title: string,
  description: string | null,
  log: Log,
): Promise<{ workItemId: string; score: number } | null> {
  const query = `${title} ${description ?? ''}`.trim();
  const vector = await tryEmbed(query);
  const { data, error } = await db().rpc('search_work_items_hybrid', {
    p_project_id: projectId,
    p_query: query,
    p_embedding: embeddingLiteral(vector),
    p_limit: 3,
  });
  if (error) {
    log('juntas: la búsqueda de duplicados falló', { projectId, error: errText(error) });
    return null;
  }
  const hit = pickDuplicate((data ?? []) as DuplicateHit[], title);
  return hit ? { workItemId: hit.id, score: Number(hit.score) } : null;
}

// ---------------------------------------------------------------- 5 y 7. Jev + política

interface AssignContext {
  enabled: boolean;
  catalog: CatalogSkill[];
  types: SolutionTypeDef[];
  devs: DevFacts[];
  project: ProjectOption | null;
  today: string;
}

async function assignContext(projectId: string | null): Promise<AssignContext> {
  const today = todayLocal();
  if (!autoAssignEnabled()) return { enabled: false, catalog: [], types: [], devs: [], project: null, today };
  const catalog = await loadCatalog();
  const [types, devs, project] = await Promise.all([
    loadSolutionTypes(catalog),
    loadDevFacts(projectId, null),
    projectId ? loadProject(projectId) : Promise.resolve(null),
  ]);
  return { enabled: true, catalog, types, devs, project, today };
}

interface Classified {
  classification: unknown;
  jevModel: string | null;
  solutionTypeId: string | null;
  estimate: number | null;
  priority: 1 | 2 | 3 | 4 | null;
  proposedDevId: string | null;
  assignmentDecisionId: string | null;
}

const UNCLASSIFIED: Classified = {
  classification: null,
  jevModel: null,
  solutionTypeId: null,
  estimate: null,
  priority: null,
  proposedDevId: null,
  assignmentDecisionId: null,
};

async function classifyAndPropose(
  meeting: MeetingRow,
  item: ExtractedItem,
  ctx: AssignContext,
  log: Log,
): Promise<Classified> {
  if (!ctx.enabled) return UNCLASSIFIED;
  const p = ctx.project;
  const task: TaskInput = {
    id: 'meeting',
    name: item.title,
    description: item.description,
    projectId: meeting.project_id,
    projectName: p?.name ?? null,
    projectKind: p?.kind ?? null,
    projectType: p?.type ?? null,
    projectDescription: p?.description ?? null,
    projectTypeKey: p?.typeKey ?? null,
    priority: null,
    prioritySource: 'humano',
    dueDate: item.dueDate,
    estimate: null,
    solutionTypeId: null,
  };

  let request: SystemOneRequest;
  let response: SystemOneResponse;
  try {
    request = buildJevRequest(task, ctx.catalog, ctx.types, null, config.typesafe.model);
    response = await systemOne(request);
  } catch (err) {
    log('juntas: Jev no pudo clasificar una candidata', { meetingId: meeting.id, title: item.title, error: errText(err) });
    return UNCLASSIFIED;
  }

  const c = readClassification(response.answers, task, ctx.catalog, ctx.types, null, ctx.today);
  const human = needsHuman(c, task, false);
  const decision = human
    ? null
    : decide({
        task: {
          id: 'meeting',
          projectId: meeting.project_id,
          priority: c.priority,
          dueDate: c.dueDate,
          points: c.points,
          urgency: c.urgency,
          skill: c.skill,
          secondarySkill: c.secondarySkill,
        },
        devs: ctx.devs,
        today: ctx.today,
      });
  const chosen = decision?.chosen?.devId ?? null;
  const stored = {
    ...c,
    today: ctx.today,
    deadline: decision?.deadline ?? null,
    horizonDays: decision?.horizonDays ?? null,
    meeting: { id: meeting.id, title: meeting.title },
    candidate: { title: item.title, description: item.description, quote: item.quote },
  };

  let assignmentDecisionId: string | null = null;
  const { data, error } = await db()
    .from('assignment_decision')
    .insert({
      work_item_id: null,
      origin: 'meeting',
      requested_by: meeting.created_by,
      outcome: 'preview',
      reason: human ?? (decision && decision.outcome !== 'assigned' ? 'sin_candidatos' : null),
      policy_version: POLICY_VERSION,
      questions_version: QUESTIONS_VERSION,
      jev_model: response.model,
      jev_request: request,
      jev_response: response,
      classification: stored,
      candidates: decision?.candidates ?? [],
      tie_breaks: decision?.tieBreaks ?? [],
      chosen_dev_id: chosen,
      effective_hours: decision?.chosen?.effectiveHours ?? null,
      suggestion: decision?.suggestion ?? null,
      attempts: 1,
    })
    .select('id')
    .single();
  if (error) log('juntas: no se pudo guardar la decisión de asignación', { meetingId: meeting.id, error: errText(error) });
  else assignmentDecisionId = (data as { id: string }).id;

  return {
    classification: stored,
    jevModel: response.model,
    solutionTypeId: c.solutionType?.id ?? null,
    estimate: c.points,
    priority: priorityFromUrgency(c.urgency),
    proposedDevId: chosen,
    assignmentDecisionId,
  };
}

// ---------------------------------------------------------------- el pipeline

export async function processMeetingExtract(p: MeetingExtractPayload, ctx: ExtractContext = { attempt: 1, maxAttempts: 1 }): Promise<ExtractResult> {
  const log: Log = ctx.log ?? (() => {});
  const meetingId = String(p.meetingId ?? '');
  const empty: ExtractResult = { status: 'omitida', candidates: 0, decisions: 0, dropped: 0 };
  if (!meetingId) return empty;
  const meeting = await loadMeeting(meetingId, true);
  if (!meeting) return empty; // la borraron mientras esperaba en la cola
  if (meeting.status === 'lista') return { ...empty, status: 'lista' };

  await setStatus(meeting.id, { status: 'extrayendo', error: null });

  // Cualquier falla después de marcarla 'extrayendo' (base, brain, Jev) la deja reintentable: vuelve
  // a 'pendiente' si el outbox reintentará y a 'error' en el último intento. Sin esto la junta se
  // quedaba en 'extrayendo' para siempre y "Reintentar" (solo acepta 'error') no la rescataba.
  try {
    return await extractBody(meeting, ctx, log, empty);
  } catch (err) {
    if (err && typeof err === 'object' && statusAlreadySet.has(err)) throw err;
    const last = ctx.attempt >= ctx.maxAttempts;
    await setStatus(
      meeting.id,
      last ? { status: 'error', error: `No se pudo procesar la junta: ${errText(err)}` } : { status: 'pendiente' },
    ).catch(() => {});
    throw err;
  }
}

/** Errores cuyo estado de la junta ya quedó escrito (el de Claude trae su propio mensaje). */
const statusAlreadySet = new WeakSet<object>();

async function extractBody(
  meeting: MeetingRow,
  ctx: ExtractContext,
  log: Log,
  empty: ExtractResult,
): Promise<ExtractResult> {
  // Restos de una corrida anterior a medias: se rehacen. Las decisiones ('guardada') las escribe solo
  // este pipeline (sus átomos se reusan por content_hash); de las tareas, solo las que nadie tomó.
  const leftovers = await Promise.all([
    db().from('meeting_candidate').delete().eq('meeting_id', meeting.id).eq('status', 'guardada'),
    db().from('meeting_candidate').delete().eq('meeting_id', meeting.id).eq('status', 'pendiente').is('decided_at', null),
  ]);
  for (const r of leftovers) if (r.error) throw r.error;

  const transcript = meeting.transcript ?? '';
  const projectName = meeting.project_id ? (await projectNames([meeting.project_id])).get(meeting.project_id) ?? null : null;

  let extraction;
  try {
    extraction = (
      await extractFromTranscript(
        {
          title: meeting.title,
          heldAt: meeting.held_at,
          attendees: Array.isArray(meeting.attendees) ? meeting.attendees : [],
          projectName,
          transcript,
        },
        ctx.completeFn,
      )
    ).extraction;
  } catch (err) {
    if (err instanceof ExtractionError) {
      await setStatus(meeting.id, { status: 'error', error: err.message });
      log('juntas: extracción inválida', { meetingId: meeting.id, error: err.message });
      return { ...empty, status: 'error' };
    }
    const last = ctx.attempt >= ctx.maxAttempts;
    await setStatus(meeting.id, last ? { status: 'error', error: `Claude no respondió: ${errText(err)}` } : { status: 'pendiente' });
    if (err && typeof err === 'object') statusAlreadySet.add(err);
    throw err;
  }

  // 3. Solo lo que tiene cita verificada.
  const tasks = keepVerified<ExtractedItem & { kind: MeetingCandidateKind }>(transcript, [
    ...extraction.tareas.map((i) => ({ ...i, kind: 'tarea' as MeetingCandidateKind })),
    ...extraction.compromisos.map((i) => ({ ...i, kind: 'compromiso' as MeetingCandidateKind })),
  ]);
  const decisions = keepVerified<ExtractedDecision>(transcript, extraction.decisiones);
  const dropped = tasks.dropped.length + decisions.dropped.length;
  if (dropped) {
    log('juntas: candidatas descartadas por cita no verificada', {
      meetingId: meeting.id,
      dropped: [...tasks.dropped, ...decisions.dropped].map((d) => ({ title: (d.item as { title: string }).title, reason: d.reason })),
    });
  }

  // 4. Decisiones → brain.
  const now = new Date().toISOString();
  for (const d of decisions.kept) {
    const atomId = await saveDecisionAtom(meeting, d);
    const { error } = await db().from('meeting_candidate').insert({
      meeting_id: meeting.id,
      kind: 'decision',
      title: d.title,
      description: d.description,
      quote: d.quote,
      quote_start: d.quoteStart,
      status: 'guardada',
      knowledge_atom_id: atomId,
      decided_at: now,
    });
    if (error) throw error;
  }

  // 5-7. Tareas y compromisos → Jev, duplicados y política.
  const assign = await assignContext(meeting.project_id);
  const rows = await pool(tasks.kept, JEV_CONCURRENCY, async (item) => {
    const [classified, duplicate] = await Promise.all([
      classifyAndPropose(meeting, item, assign, log),
      meeting.project_id ? findDuplicate(meeting.project_id, item.title, item.description, log) : Promise.resolve(null),
    ]);
    return {
      meeting_id: meeting.id,
      kind: item.kind,
      title: item.title,
      description: item.description,
      quote: item.quote,
      quote_start: item.quoteStart,
      owner_hint: item.owner,
      due_hint: item.due,
      due_date: item.dueDate,
      classification: classified.classification,
      jev_model: classified.jevModel,
      solution_type_id: classified.solutionTypeId,
      estimate: classified.estimate,
      priority: classified.priority,
      duplicate_work_item_id: duplicate?.workItemId ?? null,
      duplicate_score: duplicate?.score ?? null,
      proposed_dev_id: classified.proposedDevId,
      assignment_decision_id: classified.assignmentDecisionId,
      status: 'pendiente',
    };
  });
  if (rows.length) {
    const { error } = await db().from('meeting_candidate').insert(rows);
    if (error) throw error;
  }

  await setStatus(meeting.id, {
    status: 'lista',
    error: null,
    extracted_at: new Date().toISOString(),
    extraction_model: config.anthropic.model,
  });
  // Aviso a quien subió la junta (best-effort, idempotente por junta; import dinámico: sin ciclo).
  await import('../notify/notifications.js')
    .then((m) => m.notifyMeetingReady({
      meetingId: meeting.id,
      title: meeting.title ?? '',
      createdByDevId: meeting.created_by_dev_id,
      projectId: meeting.project_id,
      candidates: rows.length,
      decisions: decisions.kept.length,
      duplicates: rows.filter((r) => r.duplicate_work_item_id).length,
    }))
    .catch(() => {});
  log('juntas: extraída', { meetingId: meeting.id, candidates: rows.length, decisions: decisions.kept.length, dropped });
  return { status: 'lista', candidates: rows.length, decisions: decisions.kept.length, dropped };
}
