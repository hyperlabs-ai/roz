// Intake [fase 1]: propuesta -> evaluación de optimalidad -> (al confirmar) tarea NATIVA en roz.
// evaluateProposal NO crea nada: valida estrictamente, compone una description bien documentada (según el
// tipo), guarda el borrador, recupera contexto, pide el veredicto de Claude y rankea candidatos.
// confirmProposal materializa la tarea nativa en roz (asignada + con prioridad).
import { db } from '../db/supabase.js';
import { config } from '../config.js';
import { complete } from '../adapters/anthropic.js';
import { getProjectContext } from '../brain/retrieval.js';
import { rankAssignees, type AssigneeSuggestion } from '../router/assign.js';
import { createTask } from '../dashboard/queries.js';
import { ValidationError } from '../utils/errors.js';

export type ProposalKind = 'feature' | 'bug' | 'chore' | 'ticket' | 'refactor';
export type Priority = 'urgent' | 'high' | 'medium' | 'low';

/** Procedencia de la propuesta: de dónde vino (para documentarlo en la tarea). */
export interface ProposalSource {
  channel: 'chat' | 'app';
  app?: string; // nombre del proyecto/app que la originó
  customer?: string; // identificador del cliente que la envió (nombre/email)
}

export interface ProposeInput {
  projectKey: string;
  /** Opcional: en apps no hay humano que elija → roz lo infiere con Claude. */
  kind?: ProposalKind;
  /** Opcional: idem. roz infiere prioridad cuando no se da. */
  priority?: Priority;
  /** Lo que el usuario quiere o lo que falla, en sus palabras. roz documenta el resto. */
  description: string;
  /** Opcional: si el usuario ya lo dio, se respeta; si no, roz lo genera. */
  name?: string;
  requester?: string;
  /** Opcional: refs de capturas/logs/video (bugs). */
  attachments?: string[];
  /** Opcional: procedencia (apps de clientes). */
  source?: ProposalSource;
}

export interface ProposalVerdict {
  proposalId: string;
  name: string; // generado por roz si no se dio
  kind: ProposalKind; // resuelto (dado o inferido)
  priority: Priority; // resuelto (dado o inferido)
  description: string; // descripción documentada (markdown) de la tarea
  optimality: string;
  missing: string[]; // info crítica que falta — preguntar DESPUÉS, no antes
  suggestedAssignee: AssigneeSuggestion | null;
  candidates: AssigneeSuggestion[];
  note: string;
}

const KINDS: ProposalKind[] = ['feature', 'bug', 'chore', 'ticket', 'refactor'];
const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low'];

const KIND_GUIDE: Record<ProposalKind, string> = {
  feature: 'Secciones: ## Objetivo (el "para qué"), ## Criterio de aceptación, ## Alcance.',
  bug: 'Secciones: ## Pasos para reproducir, ## Resultado esperado, ## Resultado actual, ## Adjuntos.',
  refactor: 'Secciones: ## Motivación (deuda técnica), ## Alcance, ## Criterio (sin cambiar comportamiento).',
  chore: 'Secciones: ## Descripción, ## Criterio de aceptación.',
  ticket: 'Secciones: ## Descripción, ## Criterio de aceptación.',
};

function extractJson(s: string): any | null {
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

export async function evaluateProposal(input: ProposeInput): Promise<ProposalVerdict> {
  const supabase = db();

  // Único requisito de fondo: una descripción mínima. Lo demás lo redacta roz.
  const rawDescription = (input.description ?? '').trim();
  if (rawDescription.length < 8) {
    throw new ValidationError(
      'Necesito una frase de qué se quiere o qué falla. Pídesela al usuario (no la inventes).',
    );
  }

  // Proyecto canónico (selector).
  const { data: project } = await supabase
    .from('project')
    .select('id, key, name')
    .eq('key', input.projectKey)
    .single();
  if (!project) {
    throw new ValidationError(
      `Proyecto desconocido: ${input.projectKey}. Usa list_projects para elegir uno válido.`,
    );
  }

  // Contexto del brain.
  const context = await getProjectContext(input.projectKey, rawDescription);

  // ¿Hay que inferir tipo/prioridad? (apps de clientes: no hay humano que elija).
  const inferKind = !input.kind;
  const inferPriority = !input.priority;
  const kindGuide = input.kind
    ? KIND_GUIDE[input.kind]
    : 'Primero elige el "kind" más adecuado y usa SUS secciones — feature: Objetivo/Criterio de ' +
      'aceptación/Alcance; bug: Pasos para reproducir/Resultado esperado/Resultado actual/Adjuntos; ' +
      'refactor: Motivación/Alcance/Criterio; chore|ticket: Descripción/Criterio de aceptación.';

  // Una sola pasada de Claude: (infiere tipo/prioridad si faltan), genera título, DOCUMENTA
  // según el tipo marcando lo asumido con «(a confirmar)», lista lo que falta y da veredicto.
  const attachmentsBlock = input.attachments?.length
    ? `\nAdjuntos provistos:\n${input.attachments.map((a) => `- ${a}`).join('\n')}`
    : '';
  const raw = await complete({
    system:
      'Eres roz. Conviertes una propuesta CRUDA en un ticket bien documentado, con CERO ' +
      'fricción. A partir de una descripción libre, redacta. Reglas:\n' +
      (inferKind ? '- Decide "kind" ∈ [feature,bug,chore,ticket,refactor] según la descripción.\n' : '') +
      (inferPriority
        ? '- Decide "priority" ∈ [urgent,high,medium,low]: urgent solo si algo está caído/bloquea.\n'
        : '') +
      '- Genera un "name" corto y claro (si te dieron uno, respétalo).\n' +
      '- Escribe "description" en markdown con las secciones del tipo. ' +
      kindGuide +
      '\n- Infiere un borrador razonable a partir de la descripción; marca lo que asumes con ' +
      '«(a confirmar)». NO inventes datos como números de versión o nombres específicos.\n' +
      '- "missing": lista CORTA (máx 3) de info crítica que de verdad falta para que un dev ' +
      'arranque. Vacío si está suficiente.\n' +
      '- "verdict": 2-4 líneas: ¿es óptima/debe hacerse?, ¿colisiona?, ¿riesgos?\n' +
      'Responde SOLO con JSON: {"kind":"","priority":"","name":"","description":"","missing":[],"verdict":""}.',
    cachedContext: context.map((c) => `# ${c.title}\n${c.body}`).join('\n\n'),
    user:
      `Proyecto: ${project.name}\n` +
      (input.kind ? `Tipo: ${input.kind}\n` : '') +
      (input.priority ? `Prioridad: ${input.priority}\n` : '') +
      (input.name ? `Título sugerido: ${input.name}\n` : '') +
      `Descripción del usuario:\n${rawDescription}${attachmentsBlock}`,
    maxTokens: 1500,
  });

  const parsed = extractJson(raw) ?? {};
  const kind: ProposalKind =
    input.kind ?? (KINDS.includes(parsed.kind) ? parsed.kind : 'ticket');
  const priority: Priority =
    input.priority ?? (PRIORITIES.includes(parsed.priority) ? parsed.priority : 'medium');
  const name: string = (parsed.name || input.name || rawDescription.slice(0, 60)).trim();
  const body: string = (parsed.description || rawDescription).trim();
  const missing: string[] = Array.isArray(parsed.missing) ? parsed.missing.slice(0, 3) : [];
  const optimality: string = (parsed.verdict || '').trim();

  // Bloque de procedencia (apps de clientes) — queda documentado en la descripción de la tarea.
  const provenance =
    input.source?.channel === 'app'
      ? `> 📥 **Solicitud externa** recibida vía ${input.source.app ?? 'app de cliente'}` +
        (input.source.customer ? ` · Cliente: ${input.source.customer}` : '') +
        `\n> Documentada, priorizada y enrutada automáticamente por roz.\n\n`
      : '';

  // Spec final documentada (procedencia + encabezado + cuerpo + adjuntos).
  const header = `**Tipo:** ${kind}  ·  **Prioridad:** ${priority}`;
  const attachMd = input.attachments?.length
    ? `\n\n## Adjuntos\n${input.attachments.map((a) => `- ${a}`).join('\n')}`
    : '';
  const description = `${provenance}${header}\n\n${body}${attachMd}`;

  // Persistir borrador.
  const { data: proposal, error } = await supabase
    .from('proposal')
    .insert({
      project_id: project.id,
      name,
      description,
      priority,
      requester: input.requester ?? input.source?.customer ?? null,
      optimality,
      status: 'evaluated',
    })
    .select('id')
    .single();
  if (error) throw error;

  // Candidatos (varios) — recomendación, no decisión.
  const candidates = await rankAssignees(project.id, `${name}\n${description}`, 3);

  return {
    proposalId: proposal.id,
    name,
    kind,
    priority,
    description,
    optimality,
    missing,
    suggestedAssignee: candidates[0] ?? null,
    candidates,
    note:
      'roz ya documentó la propuesta (título + description). Muestra el borrador al usuario para ' +
      'confirmar/editar. Si "missing" trae algo, pregúntalo AHORA (breve). "candidates" son ' +
      'sugerencias ordenadas; nada se asigna hasta confirm_proposal con un dev elegido.',
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
    .select('*, project:project_id(id, key, name)')
    .eq('id', proposalId)
    .single();
  if (!proposal) throw new ValidationError(`Propuesta no encontrada: ${proposalId}`);

  if (proposal.status === 'promoted') {
    throw new ValidationError(
      `La propuesta ${proposalId} ya fue promovida; no se crea una tarea duplicada.`,
    );
  }
  if (!proposal.project?.id) {
    throw new ValidationError(`La propuesta ${proposalId} no tiene proyecto asociado.`);
  }

  const { data: dev } = await supabase
    .from('dev')
    .select('id, active')
    .eq('id', assigneeDevId)
    .single();
  if (!dev) throw new ValidationError(`Dev no encontrado: ${assigneeDevId}`);
  if (dev.active === false) throw new ValidationError(`El dev ${assigneeDevId} está inactivo.`);

  // Materializa la tarea NATIVA: asignada, con prioridad, estado inicial "Por hacer".
  // createTask genera el identificador local (KEY-N), fija source='native' y emite el aviso de
  // asignación (misma clave de idempotencia que el espejo → sin doble notificación).
  const task = await createTask({
    projectId: proposal.project.id,
    name: proposal.name,
    description: proposal.description,
    status: 'pendiente',
    priority: proposal.priority ?? null,
    assigneeDevId: dev.id,
  });

  await supabase.from('proposal').update({ status: 'promoted' }).eq('id', proposalId);

  const url = config.dashboard.url ? `${config.dashboard.url}/app/tasks` : '';
  return { workItemId: task.id, identifier: task.identifier, url };
}
