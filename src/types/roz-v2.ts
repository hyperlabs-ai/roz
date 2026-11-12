// Tipos de dominio compartidos de roz v2 (Linear como fuente de verdad, juntas, planes del agente,
// runners y Pulso). Fuente ÚNICA para backend, runner y —copiados a mano— web/src/lib/api.ts.
// El contrato completo (endpoints, eventos, transiciones) está en docs/roz-v2-contracts.md; si
// cambias algo aquí, cambia el doc y el espejo del front en el mismo cambio.
//
// Convención: lo que viaja por HTTP va en camelCase (igual que el resto del dashboard); las filas
// de la base van en snake_case y se mapean en cada módulo.
//
// Aquí vive además la máquina de estados del plan (pura, sin base): la usan la API del dashboard,
// la del runner y el watchdog, y por eso no puede vivir en uno de ellos.
import type { TaskState } from '../tasks/states.js';

// ================================================================ Linear

/** Prioridad de Linear: 0 sin prioridad, 1 urgente, 2 alta, 3 media, 4 baja. */
export type LinearPriority = 0 | 1 | 2 | 3 | 4;
/** Prioridad de roz (work_item.priority). */
export type RozPriority = 'urgent' | 'high' | 'medium' | 'low';

export const LINEAR_PRIORITY_TO_ROZ: Record<LinearPriority, RozPriority | null> = {
  0: null,
  1: 'urgent',
  2: 'high',
  3: 'medium',
  4: 'low',
};
export const ROZ_PRIORITY_TO_LINEAR: Record<RozPriority, Exclude<LinearPriority, 0>> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

/** Tipo de estado de un workflow de Linear. */
export type LinearStateType = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'triage';

/**
 * Estado de Linear → status de roz. `started` se parte en dos por NOMBRE: Linear no tiene un tipo
 * "review", y los equipos lo modelan como un estado `started` llamado "In Review"/"Revisión".
 */
export function linearStateToStatus(type: LinearStateType, name: string | null | undefined): TaskState {
  switch (type) {
    case 'backlog':
      return 'planificada';
    case 'unstarted':
    case 'triage':
      return 'pendiente';
    case 'started':
      return /review|revisi[oó]n|qa/i.test(name ?? '') ? 'revision' : 'en_progreso';
    case 'completed':
      return 'completada';
    case 'canceled':
      return 'cancelada';
  }
}

export type LinearLinkKind = 'team' | 'project' | 'user' | 'label' | 'state';

/** Fila de roz.linear_link en camelCase. */
export interface LinearLink {
  id: string;
  kind: LinearLinkKind;
  linearId: string;
  rozId: string | null;
  teamId: string | null;
  name: string;
  key: string | null;
  meta: Record<string, unknown>;
  active: boolean;
}

/** Origen de un issue que roz crea en Linear. */
export type IssueOrigin = 'ticket' | 'intake' | 'meeting';

// ================================================================ Juntas

export type MeetingSource = 'manual' | 'granola';
export type MeetingStatus = 'pendiente' | 'extrayendo' | 'lista' | 'error';
export type TranscriptFormat = 'texto' | 'vtt' | 'srt' | 'granola_resumen' | 'granola_api';
/** Formatos que la persona puede subir a mano (granola_api solo lo escribe el poll). */
export type ManualTranscriptFormat = Exclude<TranscriptFormat, 'granola_api'>;
export type MeetingProjectSource = 'dominio' | 'elegido';

export interface MeetingAttendee {
  name: string;
  email: string | null;
}

export type MeetingCandidateKind = 'tarea' | 'compromiso' | 'decision';
export type MeetingCandidateStatus = 'pendiente' | 'aceptada' | 'comentada' | 'descartada' | 'guardada';

/** Límite del texto de una junta (caracteres, después de normalizar). */
export const MEETING_TRANSCRIPT_MAX_CHARS = 400_000;

export interface MeetingSummary {
  id: string;
  source: MeetingSource;
  title: string;
  heldAt: string;
  durationMin: number | null;
  attendees: MeetingAttendee[];
  projectId: string | null;
  projectName: string | null;
  projectSource: MeetingProjectSource | null;
  transcriptFormat: TranscriptFormat;
  status: MeetingStatus;
  error: string | null;
  extractedAt: string | null;
  /** Conteos por estado de sus candidatas (tareas/compromisos) y decisiones guardadas. */
  counts: { pendientes: number; aceptadas: number; descartadas: number; decisiones: number };
  createdAt: string;
}

export interface MeetingDetail extends MeetingSummary {
  transcript: string;
  extractionModel: string | null;
}

export interface MeetingCandidate {
  id: string;
  meetingId: string;
  kind: MeetingCandidateKind;
  title: string;
  description: string | null;
  quote: string;
  quoteStart: number | null;
  ownerHint: string | null;
  dueHint: string | null;
  dueDate: string | null;
  solutionTypeId: string | null;
  solutionTypeName: string | null;
  estimate: number | null;
  priority: Exclude<LinearPriority, 0> | null;
  duplicate: { workItemId: string; identifier: string; name: string; status: TaskState; url: string | null; score: number } | null;
  proposedDev: { id: string; name: string; avatarUrl: string | null } | null;
  assignmentDecisionId: string | null;
  status: MeetingCandidateStatus;
  discardReason: string | null;
  issue: { linearIssueId: string; identifier: string; url: string | null } | null;
  linearCommentId: string | null;
  knowledgeAtomId: string | null;
  decidedAt: string | null;
  decidedBy: { id: string; name: string } | null;
  createdAt: string;
}

/** Candidata en la bandeja (todas las juntas): lleva el contexto mínimo de su junta. */
export interface InboxCandidate extends MeetingCandidate {
  meeting: { id: string; title: string; heldAt: string; projectId: string | null; projectName: string | null };
}

// ================================================================ Planes del agente

export type PlanStatus =
  | 'en_cola'
  | 'planeando'
  | 'esperando_aprobacion'
  | 'implementando'
  | 'pr_abierto'
  | 'hecho'
  | 'jalado'
  | 'cancelado';
export type PlanPhase = 'planear' | 'implementar';
/** 0 = planea e implementa hasta PR; 1 = planea y espera aprobación; 2 = solo plan, implementa una persona. */
export type PlanRisk = 0 | 1 | 2;

export const PLAN_STATUSES: readonly PlanStatus[] = [
  'en_cola',
  'planeando',
  'esperando_aprobacion',
  'implementando',
  'pr_abierto',
  'hecho',
  'jalado',
  'cancelado',
];
export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  en_cola: 'En cola',
  planeando: 'Planeando',
  esperando_aprobacion: 'Esperando aprobación',
  implementando: 'Implementando',
  pr_abierto: 'PR abierto',
  hecho: 'Hecho',
  jalado: 'Lo implementa una persona',
  cancelado: 'Cancelado',
};
export const PLAN_TERMINAL: readonly PlanStatus[] = ['hecho', 'jalado', 'cancelado'];
/** Corriendo en la PC de alguien (tiene runner + lease + latido). */
export const PLAN_RUNNING: readonly PlanStatus[] = ['planeando', 'implementando'];

export type RiskCode = 'ruta_sensible' | 'migracion' | 'auth_rls' | 'pagos' | 'cliente_sla' | 'ruta_proyecto' | 'origen_externo';
export interface RiskReason {
  code: RiskCode;
  /** Qué disparó la regla, legible ("toca migrations/", "cliente con SLA"). */
  detail: string;
}

/** Tiempos del watchdog y de los reintentos. */
export const PLAN_HEARTBEAT_STALE_MS = 10 * 60 * 1000;
export const PLAN_OWNER_OFFLINE_MS = 2 * 60 * 60 * 1000;
export const PLAN_QUEUE_STALE_BUSINESS_DAYS = 1;
export const PLAN_MAX_ATTEMPTS = 3;
/** Cada cuánto debe latir un runner (el watchdog tolera ~10 latidos perdidos). */
export const RUNNER_HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** Acciones de una PERSONA desde el dashboard. */
export type PlanHumanAction = 'aprobar' | 'pedir_cambios' | 'reclamar' | 'jalar' | 'soltar' | 'cancelar';
/** Lo que hace el runner o roz mismo. */
export type PlanSystemTransition =
  | 'tomar' // next-job: en_cola → planeando | implementando (según phase)
  | 'plan_listo' // el runner terminó PLAN.md
  | 'pr_abierto' // el runner abrió la PR
  | 'fallo' // el runner reportó error
  | 'liberar' // el runner suelta el plan sin error (se apagó, salió de horario)
  | 'watchdog' // sin latido > 10 min
  | 'issue_cerrado' // Linear: completed, o PR mergeada
  | 'issue_cancelado'; // Linear: canceled
export type PlanTransition = PlanHumanAction | PlanSystemTransition;

export interface PlanStateLite {
  status: PlanStatus;
  phase: PlanPhase;
  risk: PlanRisk;
}

/** Resultado de una transición: el estado nuevo y la fase con la que queda. */
export interface PlanNext {
  status: PlanStatus;
  phase: PlanPhase;
  /** true = la transición suelta runner/lease (runner_id, lease_id, heartbeat_at → null). */
  releasesRunner: boolean;
}

/**
 * La máquina de estados del plan. Devuelve null si la transición no se permite desde ese estado
 * (la API responde 409 PLAN_CONFLICT). Reglas que no son de estado (quién puede, carreras) viven
 * en el módulo de planes; esto solo dice QUÉ estado sigue.
 *
 *   en_cola ──tomar──▶ planeando ──plan_listo──▶ (riesgo 0) implementando ──pr_abierto──▶ pr_abierto ──issue_cerrado──▶ hecho
 *                           │                    (riesgo 1-2) esperando_aprobacion ──aprobar (solo riesgo 1)──▶ en_cola[implementar]
 *                           │                                        └─pedir_cambios──▶ en_cola[planear]
 *   planeando/implementando ──fallo|liberar|watchdog──▶ en_cola (misma fase)
 *   en_cola/esperando_aprobacion ──jalar──▶ jalado ──soltar──▶ en_cola[planear]
 *   reclamar/soltar en en_cola/esperando_aprobacion: mismo estado (cambia dueño / se marca reclamable)
 *   cualquiera no terminal ──cancelar|issue_cancelado──▶ cancelado; ──issue_cerrado──▶ hecho
 */
export function nextPlanState(plan: PlanStateLite, t: PlanTransition): PlanNext | null {
  const { status, phase, risk } = plan;
  if (PLAN_TERMINAL.includes(status) && status !== 'jalado') return null;
  const running = PLAN_RUNNING.includes(status);
  const same = (): PlanNext => ({ status, phase, releasesRunner: false });

  switch (t) {
    case 'tomar':
      if (status !== 'en_cola') return null;
      if (risk === 2 && phase === 'implementar') return null;
      return { status: phase === 'implementar' ? 'implementando' : 'planeando', phase, releasesRunner: false };
    case 'plan_listo':
      if (status !== 'planeando') return null;
      return risk === 0
        ? { status: 'implementando', phase: 'implementar', releasesRunner: false }
        : { status: 'esperando_aprobacion', phase: 'planear', releasesRunner: true };
    case 'pr_abierto':
      if (status !== 'implementando') return null;
      return { status: 'pr_abierto', phase: 'implementar', releasesRunner: true };
    case 'fallo':
    case 'liberar':
    case 'watchdog':
      if (!running) return null;
      return { status: 'en_cola', phase, releasesRunner: true };
    case 'aprobar':
      if (status !== 'esperando_aprobacion' || risk !== 1) return null;
      return { status: 'en_cola', phase: 'implementar', releasesRunner: false };
    case 'pedir_cambios':
      if (status !== 'esperando_aprobacion') return null;
      return { status: 'en_cola', phase: 'planear', releasesRunner: false };
    case 'reclamar':
      if (status !== 'en_cola' && status !== 'esperando_aprobacion') return null;
      return same();
    case 'jalar':
      if (status !== 'en_cola' && status !== 'esperando_aprobacion') return null;
      return { status: 'jalado', phase, releasesRunner: false };
    case 'soltar':
      if (status === 'jalado') return { status: 'en_cola', phase: 'planear', releasesRunner: false };
      if (status !== 'en_cola' && status !== 'esperando_aprobacion') return null;
      return same();
    case 'cancelar':
    case 'issue_cancelado':
      if (status === 'jalado') return null;
      return { status: 'cancelado', phase, releasesRunner: running };
    case 'issue_cerrado':
      return { status: 'hecho', phase, releasesRunner: running };
  }
}

export type PlanEventKind =
  | 'enqueued'
  | 'started'
  | 'progress'
  | 'plan_ready'
  | 'approved'
  | 'changes_requested'
  | 'claimed'
  | 'pulled'
  | 'released'
  | 'canceled'
  | 'pr_opened'
  | 'done'
  | 'requeued'
  | 'failed'
  | 'claimable';

export interface PlanProgress {
  step: string | null;
  message: string | null;
  /** 0-100, si el runner lo sabe. */
  pct: number | null;
  at: string;
}

export interface PlanDevRef {
  id: string;
  name: string;
  githubLogin: string | null;
  avatarUrl: string | null;
}

export interface AgentPlanSummary {
  id: string;
  workItemId: string;
  identifier: string;
  linearIssueId: string | null;
  issue: { name: string; url: string | null; status: TaskState; projectId: string | null; projectName: string | null };
  owner: PlanDevRef;
  status: PlanStatus;
  phase: PlanPhase;
  risk: PlanRisk;
  riskReasons: RiskReason[];
  repo: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  progress: PlanProgress | null;
  runner: { id: string; name: string } | null;
  heartbeatAt: string | null;
  attempts: number;
  error: string | null;
  claimable: boolean;
  claimableReason: 'dueño_fuera_de_linea' | 'mucho_en_cola' | 'soltado' | 'fallos' | null;
  pulledBy: PlanDevRef | null;
  enqueuedAt: string;
  updatedAt: string;
  /** Acciones que ESTA persona puede hacer ahora (el front pinta solo esos botones). */
  actions: PlanHumanAction[];
}

export interface AgentPlanEvent {
  id: string;
  kind: PlanEventKind;
  fromStatus: PlanStatus | null;
  toStatus: PlanStatus | null;
  actor: { id: string; name: string } | null;
  runner: { id: string; name: string } | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface AgentPlanDetail extends AgentPlanSummary {
  planMd: string | null;
  planVersion: number;
  feedback: string | null;
  baseBranch: string | null;
  events: AgentPlanEvent[];
}

// ================================================================ Runners

/** Horario del runner. days: 1 = lunes … 7 = domingo (ISO). Horas en la zona `tz`. */
export interface RunnerSchedule {
  tz: string;
  days: number[];
  start: string; // 'HH:MM'
  end: string; // 'HH:MM'
}
export const DEFAULT_RUNNER_SCHEDULE: RunnerSchedule = {
  tz: 'America/Mexico_City',
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '19:00',
};

export interface RunnerSummary {
  id: string;
  devId: string;
  devName: string;
  name: string;
  tokenPrefix: string;
  schedule: RunnerSchedule;
  maxConcurrent: number;
  version: string | null;
  platform: string | null;
  lastSeenAt: string | null;
  online: boolean;
  revokedAt: string | null;
  running: number;
  createdAt: string;
}

/** Herramientas que el runner le permite a Claude Code (claude -p --allowedTools). */
export const RUNNER_ALLOWED_TOOLS_PLAN: readonly string[] = ['Read', 'Glob', 'Grep', 'Write(PLAN.md)', 'mcp__roz__*'];
export const RUNNER_ALLOWED_TOOLS_IMPLEMENT: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(npm test:*)',
  'Bash(npm run typecheck:*)',
  'Bash(npx tsc:*)',
  'Bash(npx vitest:*)',
  'mcp__roz__*',
];

// ---- /v1/runner/* (Authorization: Bearer <token del runner>)

export interface RunnerRegisterRequest {
  name: string;
  version: string;
  platform: string;
  schedule?: RunnerSchedule;
  maxConcurrent?: number;
}
export interface RunnerRegisterResponse {
  runner: RunnerSummary;
  dev: { id: string; name: string; githubLogin: string | null };
  /** URL del MCP de roz que el runner configura en Claude Code (con su mismo token). */
  mcpUrl: string;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
}

export interface RunnerHeartbeatRequest {
  /** Planes que el runner tiene corriendo ahora mismo. */
  running: { planId: string; leaseId: string; progress?: Omit<PlanProgress, 'at'> }[];
  version?: string;
}
export interface RunnerHeartbeatResponse {
  now: string;
  inSchedule: boolean;
  /** Planes que el runner debe DETENER ya (cancelados, reclamados o lease vencido). */
  stop: { planId: string; reason: 'cancelado' | 'lease_perdido' | 'reasignado' }[];
}

export interface RunnerJob {
  planId: string;
  leaseId: string;
  phase: PlanPhase;
  risk: PlanRisk;
  riskReasons: RiskReason[];
  identifier: string;
  issue: { title: string; description: string | null; url: string | null; projectName: string | null };
  repo: string | null; // "owner/name"
  baseBranch: string | null;
  /** Rama a crear/usar: `<identifier en minúsculas>-<slug>` (o la branchName de Linear). */
  branch: string;
  /** PLAN.md aprobado (fase implementar) o el borrador anterior (pedir cambios). */
  planMd: string | null;
  feedback: string | null;
  /** Prompt completo para `claude -p`: lo arma el servidor para poder cambiarlo sin actualizar runners. */
  prompt: string;
  allowedTools: string[];
  maxTurns: number;
}
export interface RunnerNextJobResponse {
  job: RunnerJob | null;
  /** Fuera de horario o con max_concurrent ocupado: el runner no debe pedir más hasta este instante. */
  retryAfterMs: number;
}

export type RunnerProgressKind = 'progress' | 'plan_ready' | 'pr_opened' | 'failed' | 'released';
export interface RunnerProgressRequest {
  planId: string;
  leaseId: string;
  kind: RunnerProgressKind;
  step?: string;
  message?: string;
  pct?: number;
  /** plan_ready: el PLAN.md completo. */
  planMd?: string;
  /** pr_opened. */
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  /** failed. */
  error?: string;
}
export interface RunnerProgressResponse {
  status: PlanStatus;
  phase: PlanPhase;
  /** true = el runner sigue con este plan (p.ej. plan_listo con riesgo 0 → implementar con el mismo lease). */
  continue: boolean;
}

export interface RunnerPullRequest {
  /** planId o identificador de Linear ("HYP-123"). */
  planId?: string;
  identifier?: string;
}
export interface RunnerPullResponse {
  planId: string;
  identifier: string;
  repo: string | null;
  baseBranch: string | null;
  branch: string;
  planMd: string;
  issue: { title: string; url: string | null };
}

// ================================================================ Pulso

export type PulseGroupBy = 'persona' | 'proyecto' | 'cliente';
export type PersonState = 'activo' | 'ocupado' | 'inactivo' | 'fuera';

export interface PulseKpis {
  issuesClosed: number;
  issuesOpened: number;
  prsOpened: number;
  prsMerged: number;
  commits: number;
  activeDevs: number;
  plans: { done: number; running: number; waitingApproval: number; claimable: number };
  /** Mismas cifras de la semana anterior, para el delta. */
  previous: { issuesClosed: number; prsMerged: number; commits: number };
}

export interface PulsePerson {
  devId: string;
  name: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  state: PersonState;
  /** "Ocupado hasta las 11:30" (calendario) o null. */
  stateDetail: string | null;
  currentIssue: {
    workItemId: string;
    identifier: string;
    name: string;
    status: TaskState;
    linearStateName: string | null;
    url: string | null;
    projectId: string | null;
  } | null;
  agentPlan: { id: string; identifier: string; status: PlanStatus; phase: PlanPhase; progress: PlanProgress | null } | null;
  cycle: { name: string | null; number: number; progress: number; endsAt: string; issuesDone: number; issuesTotal: number } | null;
  week: { commits: number; lines: number; prsOpened: number; prsMerged: number; issuesClosed: number };
  projects: { id: string; name: string; color: string | null }[];
  lastActivityAt: string | null;
}

/** Celda del mapa de calor: actividad (commits + PRs + eventos de issue) por persona, día y hora. */
export interface PulseHeatCell {
  devId: string;
  day: string; // YYYY-MM-DD en la zona del equipo
  hour: number; // 0-23
  count: number;
}

export type PulseFeedKind =
  | 'commit'
  | 'branch'
  | 'pr_opened'
  | 'pr_merged'
  | 'issue_created'
  | 'issue_closed'
  | 'issue_assigned'
  | 'plan'
  | 'meeting'
  /** Deploy nuevo de un servicio vinculado (Vercel / Railway / Supabase). */
  | 'deploy'
  /** Cambio de salud de un servicio: se cayó / se pausó / se recuperó. */
  | 'infra';

export interface PulseFeedItem {
  /** Estable entre polls (`<tipo>:<id>`), para no duplicar en el front. */
  id: string;
  at: string;
  kind: PulseFeedKind;
  devId: string | null;
  text: string;
  identifier: string | null;
  url: string | null;
  projectId: string | null;
  /** Solo en `deploy` / `infra`: proveedor del servicio, para pintar su ícono oficial. */
  provider?: string | null;
  /** Solo en `deploy` / `infra`: salió bien (`ok`), falló (`bad`) o sigue en curso (`pending`). */
  tone?: 'ok' | 'bad' | 'pending' | null;
}

export interface PulseGroup {
  key: string; // devId | projectId | dominio del cliente ('interno' para proyectos internos)
  label: string;
  devIds: string[];
  kpis: { issuesClosed: number; prsMerged: number; commits: number };
}

export interface PulseResponse {
  generatedAt: string;
  period: { from: string; to: string };
  groupBy: PulseGroupBy;
  kpis: PulseKpis;
  people: PulsePerson[];
  groups: PulseGroup[];
  heatmap: PulseHeatCell[];
  feed: PulseFeedItem[];
}

export interface PulseFeedResponse {
  items: PulseFeedItem[];
}

// ================================================================ Outbox (eventos nuevos)

/** Tipos de evento de outbox de roz v2 (se suman a OutboxEventType en src/events/outbox.ts). */
export type RozV2OutboxEventType =
  | 'linear.webhook'
  | 'linear.reconcile'
  | 'plan.enqueue'
  | 'plan.claimable'
  | 'plan.reassign_linear'
  | 'meeting.extract'
  | 'granola.import';

export interface LinearWebhookPayload {
  /** Header `linear-delivery` (uuid). También es la idempotency key: `linear:<deliveryId>`. */
  deliveryId: string;
  /** Entidad: Issue | Comment | IssueLabel | Project | Cycle | User | … */
  type: string;
  action: 'create' | 'update' | 'remove';
  /** El `data` del webhook tal cual (para Issue: id, identifier, title, stateId, assigneeId, …). */
  data: Record<string, unknown>;
  /** Campos anteriores en un `update` (Linear manda solo los que cambiaron). */
  updatedFrom: Record<string, unknown> | null;
  /** `webhookTimestamp` del cuerpo (ms epoch). */
  webhookTimestamp: number;
  receivedAt: string;
}

export interface LinearReconcilePayload {
  /** Reconciliar issues con updatedAt > since. null = desde el último linear_synced_at (o 7 días). */
  since: string | null;
  reason: 'cron' | 'manual' | 'arranque';
  /** Además refrescar linear_link (equipos, usuarios, etiquetas, estados, proyectos). */
  refreshLinks: boolean;
}

export interface PlanEnqueuePayload {
  workItemId: string;
  linearIssueId: string | null;
  ownerDevId: string;
  reason: 'asignado' | 'reasignado' | 'reencolado';
}

export interface PlanClaimablePayload {
  planId: string;
  reason: 'dueño_fuera_de_linea' | 'mucho_en_cola';
  projectId: string | null;
}

export interface PlanReassignLinearPayload {
  planId: string;
  workItemId: string;
  fromDevId: string;
  toDevId: string;
  reason: 'reclamado';
}

export interface MeetingExtractPayload {
  meetingId: string;
}

export interface GranolaImportPayload {
  /** Id de la nota en Granola (meeting.external_id). */
  noteId: string;
}

/** Estado de las funciones v2 para que el front decida qué mostrar. */
export interface RozV2Status {
  linearSourceOfTruth: boolean;
  linearConfigured: boolean;
  granolaEnabled: boolean;
}
