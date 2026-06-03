// Intake [fase 1]: propuesta -> evaluación de optimalidad -> (al confirmar) issue en Linear.
// evaluateProposal NO crea nada en Linear: guarda un borrador de propuesta, recupera
// contexto, pide a Claude un veredicto y corre el router. confirmProposal materializa.
import { db } from '../db/supabase.js';
import { complete } from '../adapters/anthropic.js';
import { getProjectContext } from '../brain/retrieval.js';
import { suggestAssignee } from '../router/assign.js';
import { createIssue } from '../adapters/linear.js';
import { emit } from '../events/outbox.js';
import { ValidationError } from '../utils/errors.js';

export type ProposalKind = 'feature' | 'bug' | 'chore' | 'ticket' | 'refactor';

export interface ProposeInput {
  projectKey: string;
  kind: ProposalKind;
  title: string;
  spec: string;
  requester?: string;
}

export interface ProposalVerdict {
  proposalId: string;
  optimality: string; // veredicto en prosa de Claude
  suggestedAssignee: { devId: string; name: string; score: number; reason: string } | null;
  context: { id: string; title: string }[];
  note: string;
}

// Estrictez: roz rechaza propuestas vagas. El que propone (el chat) debe traer algo
// concreto; no se infiere el alcance. Umbrales mínimos deliberados.
const MIN_TITLE = 6;
const MIN_SPEC = 30;

export async function evaluateProposal(input: ProposeInput): Promise<ProposalVerdict> {
  const supabase = db();

  // 0. Validación estricta de la entrada (no inferir lo que falta).
  const title = (input.title ?? '').trim();
  const spec = (input.spec ?? '').trim();
  if (title.length < MIN_TITLE) {
    throw new ValidationError(
      `Título demasiado corto (mín ${MIN_TITLE}). Pide al usuario un título concreto; no lo inventes.`,
    );
  }
  if (spec.length < MIN_SPEC) {
    throw new ValidationError(
      `Spec demasiado vaga (mín ${MIN_SPEC} caracteres). roz no infiere el alcance: pide al ` +
        `usuario qué se quiere, criterio de aceptación y contexto antes de proponer.`,
    );
  }

  // 1. Proyecto canónico.
  const { data: project } = await supabase
    .from('project')
    .select('id, key, name')
    .eq('key', input.projectKey)
    .single();
  if (!project) throw new ValidationError(`Proyecto desconocido: ${input.projectKey}`);

  // Spec persistida con encabezado de tipo (fluye a Linear como descripción).
  const storedSpec = `Tipo: ${input.kind}\n\n${spec}`;

  // 2. Contexto relevante del brain.
  const context = await getProjectContext(input.projectKey, `${title}\n${spec}`);

  // 3. Veredicto de optimalidad (Claude). El contexto va como bloque cacheado.
  const optimality = await complete({
    system:
      'Eres roz. Evalúa si una propuesta de cambio es coherente con el contexto del ' +
      'proyecto. Responde con secciones: ¿es óptima?, ¿debe/puede hacerse?, ¿colisiona con ' +
      'algo existente?, ¿riesgos? Sé breve y directo. Si la propuesta es ambigua, dilo ' +
      'explícitamente y enumera qué falta definir.',
    cachedContext: context.map((c) => `# ${c.title}\n${c.body}`).join('\n\n'),
    user: `Propuesta para ${project.name} (tipo: ${input.kind}):\nTítulo: ${title}\nSpec:\n${spec}`,
  });

  // 4. Persistir borrador de propuesta (no es Linear todavía).
  const { data: proposal, error } = await supabase
    .from('proposal')
    .insert({
      project_id: project.id,
      title,
      spec: storedSpec,
      requester: input.requester ?? null,
      optimality,
      status: 'evaluated',
    })
    .select('id')
    .single();
  if (error) throw error;

  // 5. Sugerencia de asignado (router). Es SOLO sugerencia: la asignación se decide
  // explícitamente con confirm_proposal(proposalId, assigneeDevId).
  const suggestedAssignee = await suggestAssignee(project.id, `${title}\n${spec}`);

  return {
    proposalId: proposal.id,
    optimality,
    suggestedAssignee,
    context: context.map((c) => ({ id: c.id, title: c.title })),
    note:
      'suggestedAssignee es SOLO una sugerencia del router (skill×disponibilidad÷carga). ' +
      'NADA se asigna hasta llamar confirm_proposal con un assigneeDevId explícito elegido ' +
      'por el usuario.',
  };
}

export interface ConfirmResult {
  workItemId: string;
  identifier: string;
  url: string;
}

export async function confirmProposal(
  proposalId: string,
  assigneeDevId: string,
): Promise<ConfirmResult> {
  const supabase = db();

  const { data: proposal } = await supabase
    .from('proposal')
    .select('*, project:project_id(id, key, name, linear_team_id)')
    .eq('id', proposalId)
    .single();
  if (!proposal) throw new ValidationError(`Propuesta no encontrada: ${proposalId}`);

  // Guarda: no re-promover una propuesta ya convertida en issue.
  if (proposal.status === 'promoted') {
    throw new ValidationError(
      `La propuesta ${proposalId} ya fue promovida a Linear; no se crea un issue duplicado.`,
    );
  }
  if (!proposal.project?.linear_team_id) {
    throw new ValidationError(
      `El proyecto ${proposal.project?.key} no tiene linear_team_id configurado; no se puede crear el issue.`,
    );
  }

  const { data: dev } = await supabase
    .from('dev')
    .select('id, linear_user_id, active')
    .eq('id', assigneeDevId)
    .single();
  if (!dev) throw new ValidationError(`Dev no encontrado: ${assigneeDevId}`);
  if (dev.active === false) throw new ValidationError(`El dev ${assigneeDevId} está inactivo.`);

  // Crear el issue en Linear, ya asignado.
  const issue = await createIssue({
    teamId: proposal.project.linear_team_id,
    title: proposal.title,
    description: proposal.spec,
    assigneeId: dev.linear_user_id ?? undefined,
  });

  // Espejo local del WorkItem.
  const { data: workItem, error } = await supabase
    .from('work_item')
    .insert({
      linear_id: issue.id,
      identifier: issue.identifier,
      project_id: proposal.project.id,
      title: proposal.title,
      spec: proposal.spec,
      state: 'backlog',
      requester: proposal.requester,
      assignee_dev_id: dev.id,
    })
    .select('id')
    .single();
  if (error) throw error;

  await supabase.from('proposal').update({ status: 'promoted' }).eq('id', proposalId);

  // Efecto async: notificar asignación.
  await emit(
    'work_item.assigned',
    { workItemId: workItem.id, devId: dev.id, identifier: issue.identifier },
    { idempotencyKey: `assigned:${issue.id}` },
  );

  return { workItemId: workItem.id, identifier: issue.identifier, url: issue.url };
}
