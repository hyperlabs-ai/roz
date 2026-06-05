// Auto-ingesta [endpoint de apps de clientes]: sin humano en el loop. roz documenta con
// Claude (título, spec, tipo y prioridad inferidos), AUTO-ASIGNA al mejor dev y crea el
// issue en Linear, dejando constancia en la descripción de que vino de una app externa.
// Reutiliza evaluateProposal (documentar + rankear) y confirmProposal (crear en Linear).
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

  // 2. Elegir asignado automáticamente. Preferimos un dev VINCULADO a Linear (para que el
  // issue quede asignado a la persona real); si ninguno lo está, tomamos el mejor score.
  const linked = verdict.candidates.find((c) => c.linked);
  const chosen = linked ?? verdict.candidates[0];
  if (!chosen) {
    throw new ValidationError(
      'No hay devs activos para auto-asignar. Registra/activa devs antes de usar el endpoint.',
    );
  }

  // 3. Crear el issue en Linear (asignado) + espejo + notificación — mismo camino que el chat.
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
