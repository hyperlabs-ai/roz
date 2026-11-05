// Auto-ingesta [endpoint de apps de clientes]: sin humano en el loop. roz documenta con
// Claude (título, spec, tipo y prioridad inferidos), crea la tarea NATIVA y le busca responsable,
// dejando constancia en la descripción de que vino de una app externa.
//
// Dos caminos para el responsable, según CONFIGURACIÓN (nunca según un fallo en caliente):
//   · Asignación automática encendida (hay TYPESAFE_API_KEY): la tarea nace sin responsable y la
//     política de src/assign la asigna EN LÍNEA (con registro de por qué). Si Jev está saturado o
//     caído, se encola un reintento y la respuesta dice `autoAssign: 'pending'`.
//   · Apagada: el router de embeddings de siempre (rankAssignees) elige al mejor score.
import { evaluateProposal, confirmProposal, type ProposalSource } from './proposal.js';
import { ValidationError } from '../utils/errors.js';
import { autoAssign, autoAssignEnabled, enqueueAutoAssign } from '../assign/index.js';
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
