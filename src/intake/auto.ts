// Auto-ingesta [endpoint de apps de clientes]: sin humano en el loop. roz documenta con
// Claude (título, spec, tipo y prioridad inferidos), crea la tarea NATIVA y le busca responsable,
// dejando constancia en la descripción de que vino de una app externa.
//
// Dos caminos para el responsable, según CONFIGURACIÓN (nunca según un fallo en caliente):
//   · Asignación automática encendida (hay TYPESAFE_API_KEY): la tarea nace sin responsable y la
//     política de src/assign la asigna EN LÍNEA (con registro de por qué). Si Jev está saturado o
//     caído, se encola un reintento y la respuesta dice `autoAssign: 'pending'`.
//   · Apagada: el router de embeddings de siempre (rankAssignees) elige al mejor score.
//
// roz v2 (ROZ_LINEAR_SOT encendido): el issue nace en Linear. Con la asignación automática, Jev y la
// política corren ANTES de crearlo (misma clasificación que /ticket) y el issue nace ya asignado: el
// espejo es de solo lectura y roz no puede "asignar después" escribiendo work_item. La decisión
// queda en assignment_decision ligada al work_item del espejo, igual que hoy. Si Jev falla, el issue
// se crea sin asignado y la decisión queda `failed` (visible), sin caer en silencio a otra vía.
import { evaluateProposal, confirmProposal, type ProposalSource, type ProposalVerdict } from './proposal.js';
import { ValidationError } from '../utils/errors.js';
import { autoAssign, autoAssignEnabled, enqueueAutoAssign } from '../assign/index.js';
import { finishDecision, insertPending } from '../assign/decisions.js';
import { QUESTIONS_VERSION } from '../assign/jev-questions.js';
import { POLICY_VERSION } from '../assign/policy.js';
import { TypeSafeError } from '../adapters/typesafe.js';
import { linearSourceOfTruth } from '../linear/enabled.js';
import { classifyNewIssue, decisionFields } from '../tickets/smart.js';
import { db } from '../db/supabase.js';

export interface AutoIngestInput {
  projectKey: string;
  description: string;
  app: string; // proyecto/app de origen (obligatorio: para la procedencia)
  customer?: string; // quién lo envía (nombre/email)
  title?: string;
  attachments?: string[];
}

export type AutoAssignStatus = 'assigned' | 'escalated' | 'pending' | 'failed' | 'legacy';

export interface AutoIngestResult {
  identifier: string;
  url: string;
  title: string;
  kind: string;
  priority: string;
  assignedTo: { devId: string; name: string } | null;
  /** Cómo se eligió (o no) responsable. 'legacy' = router de embeddings (asignación automática apagada). */
  autoAssign: AutoAssignStatus;
  missing: string[];
}

async function devName(devId: string): Promise<string> {
  const { data } = await db().from('dev').select('name').eq('id', devId).maybeSingle();
  return (data as { name?: string } | null)?.name ?? '—';
}

export async function autoIngest(input: AutoIngestInput): Promise<AutoIngestResult> {
  const source: ProposalSource = { channel: 'app', app: input.app, customer: input.customer };
  const useAutoAssign = autoAssignEnabled();

  // 1. Documentar + inferir tipo/prioridad (+ rankear candidatos solo en el camino viejo).
  const verdict = await evaluateProposal({
    projectKey: input.projectKey,
    description: input.description,
    name: input.title,
    attachments: input.attachments,
    requester: input.customer,
    source,
    skipRanking: useAutoAssign,
  });

  const base = { title: verdict.name, kind: verdict.kind, priority: verdict.priority, missing: verdict.missing };

  if (!useAutoAssign) {
    // Camino viejo: el mejor score del ranker (skill × disponibilidad ÷ carga).
    const chosen = verdict.candidates[0];
    if (!chosen) {
      throw new ValidationError('No hay devs activos para auto-asignar. Registra/activa devs antes de usar el endpoint.');
    }
    const created = await confirmProposal(verdict.proposalId, chosen.devId);
    return { ...base, identifier: created.identifier, url: created.url, assignedTo: { devId: chosen.devId, name: chosen.name }, autoAssign: 'legacy' };
  }

  if (linearSourceOfTruth()) return ingestToLinear(input, verdict, base);

  // 2. Crear sin responsable y asignar con la política (en línea).
  const created = await confirmProposal(verdict.proposalId, null);
  const result = await autoAssign(created.workItemId, 'intake');

  if (result.outcome === 'assigned' && result.chosenDevId) {
    return {
      ...base,
      identifier: created.identifier,
      url: created.url,
      assignedTo: { devId: result.chosenDevId, name: await devName(result.chosenDevId) },
      autoAssign: 'assigned',
    };
  }
  if (result.outcome === 'failed' && result.retryable) {
    // Jev saturado o caído: la tarea ya existe; se reintenta desde la cola.
    await enqueueAutoAssign(
      { taskId: created.workItemId, identifier: created.identifier, origin: 'intake', requestedBy: null },
      'intake-retry',
    );
    return { ...base, identifier: created.identifier, url: created.url, assignedTo: null, autoAssign: 'pending' };
  }
  return {
    ...base,
    identifier: created.identifier,
    url: created.url,
    assignedTo: null,
    autoAssign: result.outcome === 'escalated' ? 'escalated' : 'failed',
  };
}

// ---------------------------------------------------------------- roz v2: Linear como fuente de verdad

type Decided = Awaited<ReturnType<typeof classifyNewIssue>>;

function errorMessage(err: unknown): string {
  if (err instanceof TypeSafeError) {
    return `${err.message}${err.detail ? `: ${typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail)}` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Deja la decisión de la política ligada al work_item del espejo (lo que se ve en "¿Por qué?").
 * Best-effort: si no se puede escribir, el issue ya existe y eso es lo que importa.
 */
async function recordIntakeDecision(
  workItemId: string,
  decided: Decided | null,
  failure: unknown,
  applied: boolean,
  warning: string | null,
): Promise<void> {
  const run = await insertPending({ workItemId, origin: 'intake', requestedBy: null, policyVersion: POLICY_VERSION });
  if (!run) return;
  if (!decided) {
    await finishDecision(run.id, {
      attempts: 1,
      outcome: 'failed',
      reason: failure instanceof TypeSafeError ? 'error_jev' : 'error_interno',
      error: errorMessage(failure),
    });
    return;
  }
  const jev = { attempts: 1, questions_version: QUESTIONS_VERSION, jev_model: decided.model, jev_request: decided.request, jev_response: decided.response };
  if (decided.plan.outcome === 'assigned' && !applied) {
    // roz eligió a alguien, pero no se le pudo asignar en Linear (sin usuario por correo).
    await finishDecision(run.id, { ...jev, ...decisionFields(decided.plan), outcome: 'failed', reason: 'sin_usuario_linear', error: warning });
    return;
  }
  await finishDecision(run.id, { ...jev, ...decisionFields(decided.plan), outcome: decided.plan.outcome });
}

async function ingestToLinear(
  input: AutoIngestInput,
  verdict: ProposalVerdict,
  base: { title: string; kind: string; priority: string; missing: string[] },
): Promise<AutoIngestResult> {
  const { data: project } = await db().from('project').select('id').eq('key', input.projectKey).maybeSingle();
  const projectId = (project as { id: string } | null)?.id;
  if (!projectId) throw new ValidationError(`Proyecto desconocido: ${input.projectKey}`);

  let decided: Decided | null = null;
  let failure: unknown = null;
  try {
    decided = await classifyNewIssue({ title: verdict.name, projectId, description: verdict.description });
  } catch (err) {
    failure = err;
  }
  const chosen = decided?.plan.outcome === 'assigned' ? decided.plan.chosenDevId : null;

  const created = await confirmProposal(verdict.proposalId, chosen, {
    estimate: decided?.plan.classification.points ?? null,
    solutionTypeId: decided?.plan.classification.solutionType?.id ?? null,
  });
  const applied = !!chosen && created.assigneeDevId === chosen;
  const warning = created.warnings?.find((w) => /responsable/i.test(w)) ?? null;
  await recordIntakeDecision(created.workItemId, decided, failure, applied, warning).catch(() => {});

  const out = { ...base, identifier: created.identifier, url: created.url };
  if (applied && chosen) return { ...out, assignedTo: { devId: chosen, name: await devName(chosen) }, autoAssign: 'assigned' };
  if (decided?.plan.outcome === 'escalated') return { ...out, assignedTo: null, autoAssign: 'escalated' };
  return { ...out, assignedTo: null, autoAssign: 'failed' };
}
