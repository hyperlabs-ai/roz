// Registro de decisiones de la asignación automática (roz.assignment_decision, migraciones 0031 y
// 0032). Cada corrida deja una fila: qué se le preguntó a Jev, cómo se clasificó la tarea, a quién
// se evaluó con qué motivos, a quién se eligió — y, si alguien lo corrigió, con qué categoría.
// La vista previa de un ticket es una fila `preview` sin tarea; al crear el ticket se completa.
import { db } from '../db/supabase.js';
import { STALE_PENDING_MS, summarizeAutoAssign, type AutoAssignOrigin, type AutoAssignSummary, type DecisionOutcome } from './rules.js';

export const DECISION_COLUMNS =
  'id, work_item_id, origin, requested_by, outcome, reason, policy_version, questions_version, jev_model, jev_request, jev_response, classification, candidates, tie_breaks, chosen_dev_id, effective_hours, suggestion, error, attempts, created_at, decided_at, overridden_at, overridden_by, override_dev_id, override_category, override_note';

export interface DecisionRow {
  id: string;
  /** null solo en una vista previa de ticket (`outcome='preview'`). */
  work_item_id: string | null;
  origin: AutoAssignOrigin;
  requested_by: string | null;
  outcome: DecisionOutcome;
  reason: string | null;
  policy_version: string;
  questions_version: string | null;
  jev_model: string | null;
  jev_request: unknown;
  jev_response: unknown;
  classification: unknown;
  candidates: unknown;
  tie_breaks: unknown;
  chosen_dev_id: string | null;
  effective_hours: number | null;
  suggestion: { suggested?: string; options?: unknown[] } | null;
  error: string | null;
  attempts: number;
  created_at: string;
  decided_at: string | null;
  overridden_at: string | null;
  overridden_by: string | null;
  override_dev_id: string | null;
  override_category: string | null;
  override_note: string | null;
}

/**
 * Abre una corrida (`pending`). El índice único parcial impide dos en curso para la misma tarea:
 * si ya hay una, devuelve null (23505) y quien llama decide si la reusa (reintento) o se va.
 */
export async function insertPending(input: {
  workItemId: string;
  origin: AutoAssignOrigin;
  requestedBy: string | null;
  policyVersion: string;
}): Promise<DecisionRow | null> {
  const { data, error } = await db()
    .from('assignment_decision')
    .insert({
      work_item_id: input.workItemId,
      origin: input.origin,
      requested_by: input.requestedBy,
      outcome: 'pending',
      policy_version: input.policyVersion,
    })
    .select(DECISION_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') return null;
    throw error;
  }
  return data as unknown as DecisionRow;
}

export async function pendingFor(workItemId: string): Promise<DecisionRow | null> {
  const { data, error } = await db()
    .from('assignment_decision')
    .select(DECISION_COLUMNS)
    .eq('work_item_id', workItemId)
    .eq('outcome', 'pending')
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as DecisionRow) ?? null;
}

/** Una corrida `pending` vieja (la función murió a media ejecución) se cierra como fallida. */
export async function failIfStale(row: DecisionRow, now = Date.now()): Promise<boolean> {
  if (now - Date.parse(row.created_at) <= STALE_PENDING_MS) return false;
  await finishDecision(row.id, { outcome: 'failed', reason: 'abandonada', error: 'la corrida no terminó en 2 h' });
  return true;
}

export async function updateDecision(id: string, patch: Partial<Omit<DecisionRow, 'id' | 'work_item_id' | 'created_at'>>): Promise<void> {
  const { error } = await db().from('assignment_decision').update(patch).eq('id', id);
  if (error) throw error;
}

/** Cierra una corrida con su resultado. */
export async function finishDecision(
  id: string,
  patch: Partial<Omit<DecisionRow, 'id' | 'work_item_id' | 'created_at' | 'outcome'>> & { outcome: Exclude<DecisionOutcome, 'pending'> },
): Promise<void> {
  await updateDecision(id, { ...patch, decided_at: new Date().toISOString() });
}

/** Deja constancia de que no se corrió (y por qué): ya tenía responsable, no es nativa, está cerrada. */
export async function recordSkipped(input: {
  workItemId: string;
  origin: AutoAssignOrigin;
  requestedBy: string | null;
  policyVersion: string;
  reason: string;
}): Promise<void> {
  await db().from('assignment_decision').insert({
    work_item_id: input.workItemId,
    origin: input.origin,
    requested_by: input.requestedBy,
    outcome: 'skipped',
    reason: input.reason,
    policy_version: input.policyVersion,
    decided_at: new Date().toISOString(),
  });
}

/** Última decisión que cuenta (las omitidas no: no hubo elección que corregir ni que mostrar). */
export async function latestDecision(workItemId: string): Promise<DecisionRow | null> {
  const { data, error } = await db()
    .from('assignment_decision')
    .select(DECISION_COLUMNS)
    .eq('work_item_id', workItemId)
    .neq('outcome', 'skipped')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as DecisionRow) ?? null;
}

export async function countDecisions(workItemId: string): Promise<number> {
  const { count } = await db()
    .from('assignment_decision')
    .select('id', { count: 'exact', head: true })
    .eq('work_item_id', workItemId)
    .neq('outcome', 'skipped');
  return count ?? 0;
}

// ---------------------------------------------------------------- vista previa de ticket

export type PreviewFields = Pick<
  DecisionRow,
  'questions_version' | 'jev_model' | 'jev_request' | 'jev_response' | 'classification' | 'candidates' | 'tie_breaks' | 'chosen_dev_id' | 'effective_hours' | 'suggestion' | 'reason'
>;

/** Guarda una vista previa (todavía sin tarea). */
export async function insertPreview(input: { requestedBy: string | null; policyVersion: string } & PreviewFields): Promise<DecisionRow> {
  const { requestedBy, policyVersion, ...fields } = input;
  const { data, error } = await db()
    .from('assignment_decision')
    .insert({ ...fields, work_item_id: null, origin: 'ticket', requested_by: requestedBy, outcome: 'preview', policy_version: policyVersion, attempts: 1 })
    .select(DECISION_COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as DecisionRow;
}

export async function loadDecision(id: string): Promise<DecisionRow | null> {
  const { data, error } = await db().from('assignment_decision').select(DECISION_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as unknown as DecisionRow) ?? null;
}

/**
 * Reclama una vista previa para crear su ticket. Atómico (`decided_at is null`): dos "Crear ticket"
 * con la misma vista previa no pueden crear dos tareas. Devuelve false si ya la reclamó otro.
 */
export async function claimPreview(id: string): Promise<boolean> {
  const { data, error } = await db()
    .from('assignment_decision')
    .update({ decided_at: new Date().toISOString() })
    .eq('id', id)
    .eq('outcome', 'preview')
    .is('decided_at', null)
    .select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Suelta el reclamo si crear la tarea falló: la vista previa se puede volver a usar. */
export async function releasePreview(id: string): Promise<void> {
  await db().from('assignment_decision').update({ decided_at: null }).eq('id', id).eq('outcome', 'preview');
}

/** La vista previa reclamada pasa a ser la decisión de la tarea recién creada. */
export async function finishPreview(
  id: string,
  workItemId: string,
  patch: Partial<Omit<DecisionRow, 'id' | 'work_item_id' | 'created_at' | 'outcome'>> & { outcome: 'assigned' | 'escalated' },
): Promise<void> {
  const { error } = await db()
    .from('assignment_decision')
    .update({ ...patch, work_item_id: workItemId, decided_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/** Registra la corrección humana sobre la decisión de roz. Solo la primera (las demás son ediciones). */
export async function recordOverride(
  decisionId: string,
  input: { userId: string | null; devId: string | null; category: string; note: string | null },
): Promise<void> {
  const { error } = await db()
    .from('assignment_decision')
    .update({
      overridden_at: new Date().toISOString(),
      overridden_by: input.userId,
      override_dev_id: input.devId,
      override_category: input.category,
      override_note: input.note,
    })
    .eq('id', decisionId)
    .is('overridden_at', null);
  if (error) throw error;
}

const IN_CHUNK = 100;

/**
 * Estado de la última decisión por tarea, para la lista. TOLERANTE: si la tabla aún no existe
 * (migración 0031 sin aplicar) o la consulta falla, devuelve vacío — la lista de tareas es la vista
 * central de la app y no debe depender de esta función.
 */
export async function loadAutoAssign(ids: string[]): Promise<Map<string, AutoAssignSummary>> {
  const out = new Map<string, AutoAssignSummary>();
  if (!ids.length) return out;
  try {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) chunks.push(ids.slice(i, i + IN_CHUNK));
    const results = await Promise.all(
      chunks.map((c) =>
        db()
          .from('assignment_decision')
          .select('id, work_item_id, outcome, chosen_dev_id, overridden_at, suggestion, created_at, decided_at')
          .in('work_item_id', c)
          .neq('outcome', 'skipped')
          .order('created_at', { ascending: false }),
      ),
    );
    const now = Date.now();
    for (const r of results) {
      if (r.error) return new Map();
      type Row = Parameters<typeof summarizeAutoAssign>[0] & { work_item_id: string };
      for (const row of (r.data ?? []) as unknown as Row[]) {
        if (out.has(row.work_item_id)) continue; // ya tomamos la más reciente
        const s = summarizeAutoAssign(row, now);
        if (s) out.set(row.work_item_id, s);
      }
    }
  } catch {
    return new Map();
  }
  return out;
}
