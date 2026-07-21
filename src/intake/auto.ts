// Auto-ingesta [endpoint de apps de clientes]: sin humano en el loop. roz documenta con
// Claude (título, spec, tipo y prioridad inferidos), AUTO-ASIGNA al mejor dev y crea la
// tarea NATIVA, dejando constancia en la descripción de que vino de una app externa.
// Reutiliza evaluateProposal (documentar + rankear) y confirmProposal (crear tarea nativa).
import { evaluateProposal, confirmProposal, type ProposalSource } from './proposal.js';
import { ValidationError } from '../utils/errors.js';

export interface AutoIngestInput {
  projectKey: string;
  description: string;
  app: string; // proyecto/app de origen (obligatorio: para la procedencia)
  customer?: string; // quién lo envía (nombre/email)
  title?: string;
  attachments?: string[];
}

export interface AutoIngestResult {
  identifier: string;
  url: string;
  title: string;
  kind: string;
  priority: string;
  assignedTo: { devId: string; name: string } | null;
  missing: string[];
}

export async function autoIngest(input: AutoIngestInput): Promise<AutoIngestResult> {
  const source: ProposalSource = { channel: 'app', app: input.app, customer: input.customer };

  // 1. Documentar + inferir tipo/prioridad + rankear candidatos.
  const verdict = await evaluateProposal({
    projectKey: input.projectKey,
    description: input.description,
    title: input.title,
    attachments: input.attachments,
    requester: input.customer,
    source,
  });

  // 2. Elegir asignado automáticamente: el mejor score del ranker (skill × disponibilidad ÷ carga).
  const chosen = verdict.candidates[0];
  if (!chosen) {
    throw new ValidationError(
      'No hay devs activos para auto-asignar. Registra/activa devs antes de usar el endpoint.',
    );
  }

  // 3. Crear la tarea nativa (asignada) + notificación — mismo camino que el chat.
  const created = await confirmProposal(verdict.proposalId, chosen.devId);

  return {
    identifier: created.identifier,
    url: created.url,
    title: verdict.title,
    kind: verdict.kind,
    priority: verdict.priority,
    assignedTo: { devId: chosen.devId, name: chosen.name },
    missing: verdict.missing,
  };
}
