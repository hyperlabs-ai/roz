// Reglas de la asignación automática que no dependen de la base: cuándo se dispara, qué cuenta como
// override y con qué categorías. Viven aparte para probarlas sin dobles de Supabase (mismo patrón
// que src/chat/rules.ts).
import { ValidationError } from '../utils/errors.js';
import { OPEN_STATES } from '../tasks/states.js';

/** create/chat = tareas viejas de antes de /ticket (el diálogo normal ya no autoasigna). */
export type AutoAssignOrigin = 'create' | 'chat' | 'intake' | 'manual' | 'ticket';
/** preview = vista previa de un ticket que todavía no se crea. */
export type DecisionOutcome = 'preview' | 'pending' | 'assigned' | 'escalated' | 'failed' | 'skipped';

/**
 * ¿Se autoasigna una tarea recién creada por POST /tickets? Solo si quien llama lo pide EXPLÍCITO
 * (`autoAssign: true`): el diálogo normal de "Nueva tarea" ya no autoasigna —para eso está /ticket—.
 * Además: nadie eligió responsable, la tarea está abierta y la función está encendida. Un
 * responsable explícito SIEMPRE gana.
 */
export function shouldAutoAssign(
  body: { assigneeDevId?: string | null; assigneeDevIds?: string[] | null; autoAssign?: boolean | null; status?: string | null },
  enabled: boolean,
): boolean {
  if (!enabled) return false;
  if (body.autoAssign !== true) return false;
  if (body.assigneeDevId) return false;
  if (body.assigneeDevIds && body.assigneeDevIds.length > 0) return false;
  const status = body.status ?? 'planificada';
  return OPEN_STATES.includes(status);
}

// ---------------------------------------------------------------- override

/**
 * Categorías CERRADAS del override. Cada una apunta a la palanca del algoritmo que habría que mover
 * si se repite — por eso son pocas y concretas, y "otro" exige explicar.
 */
export const OVERRIDE_CATEGORIES = [
  { value: 'clasificacion_erronea', label: 'roz entendió mal la tarea', hint: 'Skill, tamaño o urgencia equivocados.' },
  { value: 'carga_real', label: 'La carga real es otra', hint: 'Las estimaciones o la carga no reflejan la realidad.' },
  { value: 'ausencia', label: 'Vacaciones o ausencia', hint: 'La persona elegida no va a estar.' },
  { value: 'contexto_cliente', label: 'Conoce al cliente o el contexto', hint: 'Otra persona tiene contexto que roz no ve.' },
  { value: 'continuidad', label: 'Ya trabaja en algo relacionado', hint: 'Conviene que lo siga quien ya está en eso.' },
  { value: 'desarrollo_persona', label: 'Para que alguien aprenda o crezca', hint: 'Se elige a propósito a alguien con menos nivel.' },
  { value: 'urgencia', label: 'La urgencia es distinta', hint: 'Es más (o menos) urgente de lo que roz leyó.' },
  { value: 'preferencia', label: 'Preferencia del equipo o de la persona', hint: 'Acuerdo del equipo.' },
  { value: 'otro', label: 'Otro (explica en la nota)', hint: 'Requiere nota.' },
] as const;

export type OverrideCategory = (typeof OVERRIDE_CATEGORIES)[number]['value'];
export const OVERRIDE_CATEGORY_VALUES = OVERRIDE_CATEGORIES.map((c) => c.value) as [OverrideCategory, ...OverrideCategory[]];

/**
 * Categoría que escribe roz, no una persona: un dev RECLAMÓ el plan del agente de otro (roz v2,
 * src/plans). No está en OVERRIDE_CATEGORIES a propósito: no se elige en el selector de corrección —
 * la registra la acción de reclamar— y validateOverride la rechaza si alguien la manda a mano.
 */
export const CLAIM_OVERRIDE_CATEGORY = 'reclamado' as const;
export const CLAIM_OVERRIDE_LABEL = 'Reclamado por otra persona';

/** Todo lo que puede quedar guardado en override_category (espejo del check de la migración 0036). */
export type StoredOverrideCategory = OverrideCategory | typeof CLAIM_OVERRIDE_CATEGORY;
export const STORED_OVERRIDE_CATEGORY_VALUES: readonly StoredOverrideCategory[] = [
  ...OVERRIDE_CATEGORY_VALUES,
  CLAIM_OVERRIDE_CATEGORY,
];

export interface LatestDecisionLite {
  outcome: DecisionOutcome;
  chosenDevId: string | null;
  overriddenAt: string | null;
}

/**
 * ¿Este cambio de responsables es un override? Solo cuando la última decisión fue una asignación de
 * roz, todavía no corregida, el responsable actual es el que eligió roz y el nuevo principal es otro
 * (o nadie). Agregar gente de apoyo no cuenta; una tarea escalada o fallida tampoco (ahí no hubo
 * elección que corregir).
 */
export function isOverride(latest: LatestDecisionLite | null, prevPrimary: string | null, nextIds: string[] | undefined): boolean {
  if (!latest || nextIds === undefined) return false;
  if (latest.outcome !== 'assigned' || latest.overriddenAt || !latest.chosenDevId) return false;
  if (prevPrimary !== latest.chosenDevId) return false;
  return (nextIds[0] ?? null) !== latest.chosenDevId;
}

export function validateOverride(o: { category: string; note?: string | null }): { category: OverrideCategory; note: string | null } {
  if (!OVERRIDE_CATEGORY_VALUES.includes(o.category as OverrideCategory)) {
    throw new ValidationError(`categoría de override inválida: ${o.category}`);
  }
  const note = o.note?.trim() || null;
  if (o.category === 'otro' && !note) throw new ValidationError('"Otro" necesita una nota que explique el cambio');
  return { category: o.category as OverrideCategory, note };
}

// ---------------------------------------------------------------- estado para la UI

export type AutoAssignState = 'pending' | 'assigned' | 'escalated' | 'failed' | 'overridden';

export interface AutoAssignSummary {
  decisionId: string;
  state: AutoAssignState;
  chosenDevId: string | null;
  /** Acción sugerida al escalar (dividir / repriorizar / backlog / clasificar). */
  suggestion: string | null;
  decidedAt: string | null;
}

/** Una corrida `pending` de más de 2 h ya no va a terminar: se muestra como fallida. */
export const STALE_PENDING_MS = 2 * 60 * 60 * 1000;

export function summarizeAutoAssign(
  row: {
    id: string;
    outcome: DecisionOutcome;
    chosen_dev_id: string | null;
    overridden_at: string | null;
    suggestion: { suggested?: string } | null;
    created_at: string;
    decided_at: string | null;
  },
  now = Date.now(),
): AutoAssignSummary | null {
  if (row.outcome === 'skipped' || row.outcome === 'preview') return null;
  let state: AutoAssignState;
  if (row.outcome === 'pending') state = now - Date.parse(row.created_at) > STALE_PENDING_MS ? 'failed' : 'pending';
  else if (row.outcome === 'assigned') state = row.overridden_at ? 'overridden' : 'assigned';
  else state = row.outcome;
  return {
    decisionId: row.id,
    state,
    chosenDevId: row.chosen_dev_id,
    suggestion: row.suggestion?.suggested ?? null,
    decidedAt: row.decided_at,
  };
}
