import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Range } from './period';

// ---- Token de acceso, cacheado en memoria ----
// Antes cada petición hacía `supabase.auth.getSession()`. Parece inofensivo (lee de localStorage),
// pero auth-js lo serializa detrás de un lock interno, y al volver a la pestaña ese lock lo tiene su
// propio refresh: la ráfaga de peticiones que dispara el dashboard al regresar se quedaba encolada
// esperando. Aquí el token lo EMPUJA el store de auth en cada cambio de sesión, así que el caso
// normal no toca auth-js en absoluto.
let cachedToken: string | null = null;
let expiresAtSec = 0;
// Margen: nunca mandar un token que caduque en vuelo.
const SKEW_SEC = 30;

/** Lo llama `auth/store.ts` en cada cambio de sesión (incluida la inicial y el cierre). */
export function setAuthToken(session: Session | null): void {
  cachedToken = session?.access_token ?? null;
  expiresAtSec = session?.expires_at ?? 0;
}

/** Invalida el token cacheado. Se usa tras un 401 para forzar una relectura. */
export function clearAuthToken(): void {
  cachedToken = null;
  expiresAtSec = 0;
}

async function authHeader(): Promise<Record<string, string>> {
  if (cachedToken && expiresAtSec - SKEW_SEC > Date.now() / 1000) {
    return { authorization: `Bearer ${cachedToken}` };
  }
  // Camino lento: arranque en frío (una petición antes del primer efecto del provider) o token
  // vencido. Se relee UNA vez y se vuelve a cachear.
  const { data } = await supabase.auth.getSession();
  setAuthToken(data.session);
  return cachedToken ? { authorization: `Bearer ${cachedToken}` } : {};
}

/**
 * Ejecuta la petición y, si el token cacheado ya no vale (401), lo tira y reintenta UNA vez.
 * Sin este reintento, un token desfasado convertiría la app entera en una tormenta de 401 y todas
 * las pantallas se vaciarían a la vez. El reintento es único por construcción: `run` se llama a lo
 * sumo dos veces, así que no hay forma de entrar en bucle.
 */
async function withAuth(run: (headers: Record<string, string>) => Promise<Response>): Promise<Response> {
  const res = await run(await authHeader());
  if (res.status !== 401 || !cachedToken) return res;
  clearAuthToken();
  return run(await authHeader());
}

/** Error de la API que conserva el status y el código del backend. Sin esto, quien llama solo
 *  recibe un mensaje suelto y no puede distinguir "no tienes acceso" de "se cayó el servidor". */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'ApiError';
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body?.error?.message ?? `HTTP ${res.status}`, res.status, body?.error?.code ?? null);
  }
  return res.json() as Promise<T>;
}

function qs(range?: Range, compare?: Range | null): string {
  if (!range) return '';
  const p = new URLSearchParams({ from: range.from, to: range.to });
  if (compare) {
    p.set('compareFrom', compare.from);
    p.set('compareTo', compare.to);
  }
  return `?${p.toString()}`;
}

export async function apiGet<T>(path: string, range?: Range, compare?: Range | null): Promise<T> {
  const res = await withAuth((headers) => fetch(`/api/dashboard${path}${qs(range, compare)}`, { headers }));
  return handle<T>(res);
}

export async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await withAuth((headers) =>
    fetch(`/api/dashboard${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  return handle<T>(res);
}

/** Subida de archivo (multipart). No fijamos content-type: el navegador pone el boundary. */
export async function apiUpload<T>(path: string, file: File, field = 'file'): Promise<T> {
  const form = new FormData();
  form.append(field, file);
  const res = await withAuth((headers) => fetch(`/api/dashboard${path}`, { method: 'POST', headers, body: form }));
  return handle<T>(res);
}

// ---- Tipos compartidos con el backend (src/dashboard/queries.ts) ----
export interface Metric {
  value: number;
  compare: number | null;
  changePct: number | null;
  direction: 'up' | 'down' | 'flat' | 'none';
}
export interface AuthedUser {
  id: string; email: string; name: string | null; role: string | null;
  // Su registro en roz.dev — el backend exige que exista para dejar entrar.
  devId: string; devName: string; devActive: boolean;
  githubLogin?: string | null;
}

export interface Overview {
  kpis: { commits: Metric; ticketsResolved: Metric; activeContributors: Metric; avgCycleTimeHours: Metric; linesChanged: Metric };
  byProject: { projectId: string | null; name: string; commits: number; ticketsResolved: number }[];
  byDeveloper: { devId: string; name: string; avatarUrl: string | null; commits: number; ticketsResolved: number; lines: number }[];
  split: { client: { commits: number; ticketsResolved: number }; internal: { commits: number; ticketsResolved: number } };
  completedByPriority: { priority: string; count: number }[];
  workload: { devId: string; name: string; avatarUrl: string | null; completedTickets: number; weighted: number }[];
  skillsCoverage: SkillCatalogItem[];
  trend: { date: string; commits: number; ticketsResolved: number }[];
}

/** Franja de tamaño de commit (conteo y líneas): describe el estilo de trabajo de un dev.
 *  Los hyper points salen de los totales del período, no del empaquetado. */
export interface SizeBucket { key: 'micro' | 'chico' | 'mediano' | 'grande'; commits: number; lines: number }

export interface DeveloperListItem {
  id: string; name: string; githubLogin: string | null; avatarUrl: string | null; email?: string | null;
  active: boolean; availability: number; commits: number; ticketsResolved: number;
  openTickets: number; linesChanged: number; hyperPoints: number; projects: number;
  sizeDist: SizeBucket[];
  topSkills: { tag: string; level: number }[];
}

export interface Ticket { id: string; identifier: string; name: string; status: string; priority: string | null; url: string | null; }

/** Credenciales editables de un developer (formulario de alta/edición). */
export interface DeveloperCredentials {
  id: string; name: string; email: string | null;
  githubLogin: string | null; githubEmail: string | null;
  availability: number; active: boolean;
}

export interface DeveloperProfile {
  dev: { id: string; name: string; email: string | null; githubLogin: string | null; avatarUrl: string | null; active: boolean; availability: number };
  kpis: { commits: Metric; hyperPoints: Metric; ticketsResolved: Metric; avgCycleTimeHours: Metric; linesChanged: Metric; reviews: Metric };
  commitTrend: { date: string; commits: number }[];
  projects: { projectId: string | null; name: string; commits: number }[];
  repos: { repo: string; commits: number }[];
  sizeDist: SizeBucket[];
  tickets: { open: Ticket[]; inProgress: Ticket[]; resolved: Ticket[] };
  skills: { skillId: string; tag: string; level: number }[];
}

export interface ActivityItem {
  type: 'commit' | 'ticket_resolved' | 'revision';
  ts: string; name: string; url: string | null; repo: string | null;
  additions: number | null; deletions: number | null;
}

/** Feed de actividad del perfil: ventana propia (days) anclada al fin del período visto. */
export interface DeveloperActivity {
  days: number; from: string; to: string;
  truncated: boolean;
  activity: ActivityItem[];
}

/** Cuadrícula de contribuciones de GitHub (la del perfil público), traída vía GraphQL API. */
export interface GithubContributions {
  linked: boolean;
  login: string | null;
  totalContributions: number;
  weeks: { days: { date: string; count: number; level: 0 | 1 | 2 | 3 | 4; weekday: number }[] }[];
}

export type ProjectKind = 'client' | 'internal';

// Tipos de proyecto: módulo puro aparte (se prueba en Node sin cargar el cliente de Supabase).
export { PROJECT_TYPES, PROJECT_TYPE_LABEL } from './project-types';

/** Perfil del proyecto (0033). profileSource 'ia' = lo propuso roz leyendo GitHub, sin revisar. */
export interface ProjectProfileFields {
  projectType?: string | null;
  description?: string | null;
  profileSource?: 'ia' | 'humano' | null;
}
export interface ProjectProfileSuggestion {
  projectType: string | null;
  description: string | null;
  repos: string[];
  typeBy: 'jev' | 'claude' | null;
  descriptionBy: 'claude' | 'github' | null;
}

export interface ProjectListItem extends ProjectProfileFields {
  projectId: string; name: string; key: string; kind: ProjectKind; color: string | null; commits: number; additions: number; deletions: number;
  contributors: string[]; repos: string[]; ticketsResolved: number;
  /** false = archivado (GET /projects devuelve también los archivados). */
  active?: boolean;
}

export interface CommitHistoryItem {
  sha: string; message: string; author: string | null; avatarUrl: string | null; devId?: string | null;
  committedAt: string | null; additions: number | null; deletions: number | null; repo: string; url: string | null;
}

/**
 * Estados de `roz.project_repo.sync_status` (migración 0014). El backend los escribe crudos en
 * `src/reconcile/backfill.ts` — OJO: el terminal es `'done'`, NO `'completada'`. Ese literal es del
 * dominio de TAREAS (`lib/labels.ts`) y estuvo aquí por copy-paste: como el tipo terminaba en
 * `| string`, comparar contra él compilaba sin chistar y el front nunca reconocía una
 * sincronización terminada (ni pintaba el ✓, ni recargaba el detalle del proyecto).
 *
 * `(string & {})` mantiene el autocompletado de la unión y sigue aceptando en runtime un estado
 * nuevo del backend, pero un literal que NO esté en la unión ya no compila.
 */
export type RepoSyncState = 'idle' | 'queued' | 'syncing' | 'done' | 'error';

export interface RepoSyncStatus {
  repo: string;
  status: RepoSyncState | (string & {});
  pages: number;
  commits: number;
  totalPages: number | null;
  error: string | null;
  updatedAt: string | null;
}

/** Progreso de una sincronización (backfill) para el widget global; repo + estado + progreso. */
export interface SyncItem extends RepoSyncStatus {
  projectId: string | null;
}

export interface ProjectDetail {
  project: { id: string; name: string; key: string; kind: ProjectKind; color: string | null; active?: boolean } & ProjectProfileFields;
  repos: string[];
  repoSync: RepoSyncStatus[];
  totals: { commits: number; additions: number; deletions: number; ticketsResolved: number; contributors: number };
  contributors: { name: string; avatarUrl: string | null; devId?: string | null; commits: number; lines: number }[];
  resolvedTickets: { id: string; identifier: string; name: string; status: string; statusLabel: string; priority: string | null; url: string | null; assignee: { id?: string; name: string; avatarUrl: string | null } | null }[];
  byRepo: { repo: string; commits: number }[];
  ticketsByStatus: { status: string; label: string; count: number }[];
  history: CommitHistoryItem[];
  trend: { date: string; additions: number; deletions: number }[];
}

/** Persona atribuida a un ticket vía PR (autor / revisor / merger). `login` viene siempre; `devId` solo si está mapeado a un roz.dev. */
export interface TicketPerson {
  name: string; avatarUrl: string | null; login: string | null;
  devId?: string | null; reviewState?: string | null;
}
export interface Ticket {
  id: string; identifier: string; number: number | null; name: string;
  description: string | null;
  status: string; statusLabel: string; priority: string | null;
  projectId: string | null; projectName: string | null;
  assignee: { id: string; name: string; avatarUrl: string | null } | null; // primary (compat) = primer assignee
  assignees: { id: string; name: string; avatarUrl: string | null }[]; // lista completa de responsables
  createdBy: { name: string; avatarUrl: string | null; email?: string | null } | null; // quién creó/asignó (usuario del dashboard)
  estimate: number | null; dueDate: string | null; overdue: boolean;
  labels: string[]; creatorName: string | null; url: string | null;
  updatedAt: string | null; ageDays: number | null;
  parentId: string | null;
  /** Mensaje del chat del que salió la tarea (migración 0030). */
  chatMessageId?: string | null;
  /** Última decisión de la asignación automática (migración 0031); null si nunca corrió. */
  autoAssign?: AutoAssignSummary | null;
  /** Tipo de solución que fijó una persona o se confirmó en /ticket (migración 0032). */
  solutionTypeId?: string | null;
  // Agendado (calendario) + resolución
  scheduledStart: string | null; scheduledEnd: string | null;
  completedAt: string | null;
  // Conexión con código (migraciones 0011 + 0016)
  source: 'pr' | 'commit' | 'native' | null;
  headRef: string | null;
  prState: 'open' | 'merged' | 'closed' | null;
  pr: { repo: string; number: number; url: string } | null;
  effort: { commits: number; lines: number; points: number };
  authors: TicketPerson[]; reviewers: TicketPerson[]; merger: TicketPerson | null;
}
// ---- Asignación automática (espejo de src/assign: rules.ts / policy.ts / routes) ----
export type AutoAssignState = 'pending' | 'assigned' | 'escalated' | 'failed' | 'overridden';
export interface AutoAssignSummary {
  decisionId: string;
  state: AutoAssignState;
  chosenDevId: string | null;
  suggestion: string | null;
  decidedAt: string | null;
}
export interface AssignCandidate {
  devId: string;
  name: string;
  relation: 'encargado' | 'subencargado' | 'externo' | 'externo_sin_historial';
  tier: 'encargado' | 'subencargado' | 'especialista' | 'pool' | null;
  position: number | null;
  skillLevel: number | null;
  /** Nivel en la skill secundaria del tipo de solución (ordena, no filtra). */
  secondaryLevel?: number | null;
  multiplier: number;
  effectiveHours: number;
  capacity: {
    horizonDays: number; capacityHours: number; limitHours: number; loadHours: number;
    effectiveHours: number; fits: boolean; unestimated: number;
    counted: { id: string; identifier: string; hours: number; status: string; priority: string | null }[];
  } | null;
  status: 'elegido' | 'alternativa' | 'descartado';
  reasons: { code: string; detail: string }[];
}
export interface AssignClassification {
  projectId: string | null; projectSource: string;
  /** q2: tipo de solución (Skills → Tipos de solución). Ausente en decisiones viejas (q1). */
  typeState?: 'definido' | 'ninguno' | 'incierto';
  solutionType?: { id: string; slug: string; name: string; minLevel: number; module: boolean; sizeMin: number; sizeMax: number } | null;
  typeSource?: string;
  skillState: 'requerida' | 'ninguna' | 'incierta';
  skill: { id: string; tag: string; minLevel: number } | null; skillSource: string;
  secondarySkill?: { id: string; tag: string } | null;
  /** Bug/refactor en un proyecto con backend sin claridad de si es solo interfaz: sin filtro de skill. */
  moduleOpen?: boolean;
  points: number; pointsSource: string;
  priority: string | null; dueDate: string | null;
  urgency: 'urgente' | 'no_urgente' | 'incierta'; urgencyWhy: string;
  signals: {
    sizeSplit: boolean; jevPoints: number | null;
    jevType?: string | null; fitsSolutionType?: number | null;
    jevSkill?: string | null; serverSide?: number | null;
    sizeRaisedToMin?: boolean; sizeAboveTypical?: boolean;
  };
  today?: string; deadline?: string | null; horizonDays?: number | null;
}
export interface AssignmentDecisionDetail {
  id: string;
  origin: 'create' | 'chat' | 'intake' | 'manual' | 'ticket';
  outcome: 'preview' | 'pending' | 'assigned' | 'escalated' | 'failed' | 'skipped';
  reason: string | null;
  createdAt: string; decidedAt: string | null;
  policyVersion: string; questionsVersion: string | null; jevModel: string | null;
  request: unknown;
  classification: AssignClassification | null;
  candidates: AssignCandidate[];
  tieBreaks: { tier: string; promotedDevId: string; overDevIds: string[]; reviewerDevId: string }[];
  chosenDevId: string | null;
  effectiveHours: number | null;
  suggestion: { suggested: string; options: { kind: string; detail: string }[] } | null;
  error: string | null;
  overriddenAt: string | null; overrideDevId: string | null; overrideCategory: string | null; overrideNote: string | null;
}
export interface AssignmentDetailResponse {
  decision: AssignmentDecisionDetail | null;
  previous?: number;
  devNames?: Record<string, string>;
}

// ---- Tipos de solución (Skills → Tipos de solución; espejo de src/dashboard/solution-types.ts) ----
export interface SolutionType {
  id: string; slug: string; name: string;
  /** Lo que lee roz (Jev) para clasificar. */
  description: string;
  /** null = "la skill del módulo afectado". */
  primarySkillId: string | null; primarySkillTag: string | null;
  minLevel: number;
  secondarySkillId: string | null; secondarySkillTag: string | null;
  sizeMin: number; sizeMax: number;
  active: boolean; sortOrder: number;
  taskCount: number;
}

// ---- Tickets inteligentes (/ticket; espejo de src/tickets/smart.ts) ----
export interface TicketCorrections {
  solutionTypeId?: string | null;
  points?: number | null;
  priority?: string | null;
  dueDate?: string | null;
}
export interface TicketPreviewResponse {
  previewId: string;
  /** Lo que haría roz: asignar o escalar. */
  outcome: 'assigned' | 'escalated';
  reason: string | null;
  chosenDevId: string | null;
  effectiveHours: number | null;
  candidates: AssignCandidate[];
  tieBreaks: AssignmentDecisionDetail['tieBreaks'];
  suggestion: { suggested: string; options: { kind: string; detail: string }[] } | null;
  classification: AssignClassification & { suggestedPriority: 'urgent' | 'medium' };
  jevModel: string | null;
  reused: boolean;
  devNames: Record<string, string>;
}
export interface TicketCreateResponse {
  task: Ticket | null;
  identifier: string;
  conversationId: string | null;
  messageSent: boolean;
  /** Solo con Linear como fuente de verdad: el issue creado y lo que no se pudo mapear. null = tarea nativa. */
  linear: { linearIssueId: string; url: string; warnings: string[] } | null;
}

export interface TicketsResponse {
  total: number; overdue: number; unassigned: number;
  /** true = la consulta topó su techo de filas y hay trabajo más viejo fuera de la lista. */
  truncated: boolean;
  summary: { total: number; open: number; inProgress: number; completed: number; unassigned: number; overdue: number };
  byState: { label: string; value: number }[];
  byPriority: { label: string; value: number }[];
  byProject: { label: string; value: number }[];
  bySource: { label: string; value: number }[];
  developers: { name: string; avatarUrl: string | null; devId?: string | null; count: number }[];
  topReviewers: { name: string; avatarUrl: string | null; devId?: string | null; count: number }[];
  topMergers: { name: string; avatarUrl: string | null; devId?: string | null; count: number }[];
  attributionMismatch: number; // tickets mergeados por alguien distinto al autor
  withoutPr: number;           // tickets cerrados sin PR vinculado
  tickets: Ticket[];
}
/** Adjunto (imagen) de una tarea en Supabase Storage. Nombre calza con el backend. */
export interface Attachment {
  id: string;
  url: string;
  name: string;
  contentType: string | null;
  size: number | null;
  createdAt: string;
}

export interface TicketFilterOptions {
  projects: { id: string; name: string }[];
  allProjects: { id: string; name: string }[];
  devs: { id: string; name: string; avatarUrl: string | null }[];
  states: { value: string; label: string }[];
  allStates: { value: string; label: string }[];
  priorities: { value: string; label: string }[];
  /** Asignación automática encendida (hay llave de TypeSafe): muestra la casilla y el botón. */
  autoAssignEnabled?: boolean;
  /** Motivos cerrados para corregir a roz (override). */
  overrideCategories?: { value: string; label: string; hint: string }[];
  /** Escala de story points (1 pt = 2 h). */
  estimatePoints?: number[];
  /** Tipos de solución para el select de la tarea (migración 0032). */
  solutionTypes?: { id: string; name: string; active: boolean }[];
}

export type ServiceProvider = 'vercel' | 'railway' | 'supabase';
export type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'paused' | 'unknown';

export interface InfraDeploy {
  /** Estado nativo del proveedor (READY, SUCCESS, ERROR…). El backend lo llama `state` (src/infra/types.ts). */
  state: string;
  url: string | null;
  sha: string | null;
  createdAt: string | null;
  commitMessage?: string | null;
  branch?: string | null;
  author?: string | null;
  repo?: string | null;
  durationMs?: number | null;
}
/** Resultado normalizado de un intento de deploy (espejo de src/infra/types.ts). */
export type InfraDeployState = 'building' | 'ready' | 'failed' | 'canceled' | 'unknown';
/** Un deploy concreto: el último intento o el que atiende producción. */
export interface InfraDeployRef {
  id: string | null;
  state: InfraDeployState;
  nativeState: string;
  sha: string | null;
  branch: string | null;
  message: string | null;
  author: string | null;
  createdAt: string | null;
  durationMs: number | null;
  url: string | null;
  inspectorUrl: string | null;
}
/** Por qué falló, tal cual lo reporta el proveedor. Lo que no se pudo leer llega en null. */
export interface InfraFailure {
  scope: 'deploy' | 'runtime' | 'platform';
  deployId: string | null;
  step: string | null;
  code: string | null;
  message: string | null;
  logTail: string[];
  helpUrl: string | null;
}
export interface InfraServiceDetails {
  /** Último intento de deploy. OJO: no es la salud del servicio (eso es `status`). Los snapshots
   *  anteriores al cambio no lo traen. */
  lastDeploy?: InfraDeployRef | null;
  /** El deploy que atiende producción ahora. */
  serving?: InfraDeployRef | null;
  failure?: InfraFailure | null;
  framework?: string | null;
  productionUrl?: string | null;
  region?: string | null;
  dbVersion?: string | null;
  postgresEngine?: string | null;
  replicas?: number | null;
  runtime?: string | null;
  plan?: string | null;
  subsystems?: { name: string; healthy: boolean }[];
  recent?: { state: string; sha: string | null; createdAt: string | null }[];
}
export interface InfraService {
  id: string;
  provider: ServiceProvider;
  externalRef: string;
  label: string | null;
  config: Record<string, unknown>;
  capturedAt: string | null;
  ok: boolean | null;
  status: ServiceStatus;
  providerStatus: string | null;
  active: boolean | null;
  deploy: InfraDeploy | null;
  metrics: Record<string, number> | null;
  details: InfraServiceDetails | null;
  error: string | null;
}
export interface InfraProject { projectId: string; name: string; kind: ProjectKind; services: InfraService[]; }
export interface InfraResponse { projects: InfraProject[]; }

/** Timeline de disponibilidad agregado (status page): un bucket por día, peor estado del día. */
export interface InfraUptimeResponse {
  buckets: { start: string; status: ServiceStatus; up: number; total: number }[];
  days: number;
  uptimePct: number | null;
}

// ---- Cola de procesamiento (outbox) ----
// Espejo manual de src/dashboard/queue.ts. Los nombres deben calzar EXACTO: TypeScript no compara
// las dos declaraciones, así que un campo renombrado compila igual y llega vacío en runtime.

export type QueueStatus = 'pending' | 'processing' | 'done' | 'failed' | 'dead';
export type QueuePhase = 'inflight' | 'resolved' | 'failed';
/** `unknown` lo produce SOLO el cliente, tras varios sondeos fallidos. El backend nunca lo manda. */
export type QueueHealth = 'idle' | 'working' | 'delayed' | 'failing' | 'unknown';

/** Persona de un evento. `devId` solo si el login está mapeado a un dev de roz. */
export interface QueuePerson { login: string | null; name: string; avatarUrl: string | null; devId: string | null }
export interface QueueTask { identifier: string; title: string | null; url: string | null }

export interface QueueEvent {
  id: string;
  /** `string` a propósito: un tipo nuevo en el backend no debe romper la fila. */
  type: string;
  status: QueueStatus | string;
  phase: QueuePhase;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: string;
  /** Cuándo terminó. null mientras sigue en vuelo. */
  resolvedAt: string | null;
  nextAttemptAt: string | null;
  latencyMs: number | null;
  // Contexto derivado del payload
  repo: string | null;
  sha: string | null;
  prNumber: number | null;
  page: number | null;
  subject: string | null;
  url: string | null;
  projectName: string | null;
  // Las dos personas de un evento: quién lo originó y a quién se le acreditó. Pueden diferir.
  actor: QueuePerson | null;
  dev: QueuePerson | null;
  // Resultado
  additions: number | null;
  deletions: number | null;
  task: QueueTask | null;
}

export interface QueueCounts {
  pending: number; processing: number; failed: number; dead: number;
  ready: number; scheduled: number; stuck: number;
  doneLastHour: number;
}

/** Un bucket por minuto (más viejo primero) para el latido del cron. */
export interface QueueBeat { minute: string; done: number; failed: number }

/** Sondeo ligero: alimenta el indicador del header. */
export interface QueuePulse {
  health: QueueHealth;
  counts: QueueCounts;
  lastDrainAt: string | null;
  drainStale: boolean;
  oldestPendingSec: number | null;
  inflight: QueueEvent[];
}

/** Snapshot completo de la sección. */
export interface QueueResponse extends QueuePulse {
  beat: QueueBeat[];
  events: QueueEvent[];
  truncated: boolean;
}

export interface SkillCatalogItem { skillId: string; tag: string; description: string | null; devCount: number; avgLevel: number; busFactorRisk: boolean; }
export interface SkillMatrix {
  devs: { id: string; name: string; avatarUrl: string | null }[];
  skills: { id: string; tag: string }[];
  cells: { devId: string; skillId: string; level: number }[];
}

// ---- Presencia desde Google Calendar (espejo manual de src/calendar/presence.ts) ----
// Los nombres deben calzar EXACTO con lo que devuelve el backend: TypeScript no compara las dos
// declaraciones, así que un campo mal escrito compila igual y llega `undefined` en runtime.

export type PresenceStatus = 'busy' | 'free' | 'unknown';

/** Un bloque de la agenda para el desglose al pasar el mouse. */
export interface UpcomingBlock {
  title: string | null;
  startsAt: string;
  endsAt: string;
  /** En curso ahora mismo. */
  current: boolean;
}

export interface DevPresence {
  devId: string;
  status: PresenceStatus;
  /** Título del evento en curso (o del próximo, si está libre). */
  title: string | null;
  /** Fin de la racha de ocupación, con las juntas pegadas ya colapsadas. */
  busyUntil: string | null;
  nextStartsAt: string | null;
  nextTitle: string | null;
  /**
   * Lo que queda del día. El resumen colapsa juntas pegadas a propósito, así que por sí solo no
   * responde "¿a qué horas exactamente?" — esta lista sí, y es la que alimenta el hover.
   */
  upcoming: UpcomingBlock[];
  /** El sondeo lleva demasiado sin correr: el indicador se apaga en vez de mentir. */
  stale: boolean;
}

export interface PresenceResponse { devs: DevPresence[] }

/** Estado de MI conexión con Google (tarjeta de Configuración). */
export interface CalendarConnection {
  /** Si este deploy tiene credenciales de Google. Sin esto no hay nada que conectar. */
  available: boolean;
  connected: boolean;
  googleEmail: string | null;
  /** 'active' | 'revoked' | 'error' — `revoked` es el que pide reconectar. */
  status: string | null;
  lastSyncedAt: string | null;
}

// ---- Interruptores de notificaciones (espejo manual de src/notify/switches.ts) ----
// Mismos nombres que devuelve el backend, exacto: un campo mal escrito compila igual y llega
// `undefined` en runtime (se vería como "apagado" sin estarlo).

export interface NotificationSwitch {
  emailEnabled: boolean;
  pushEnabled: boolean;
  /** Quién movió el interruptor global y cuándo (null si nadie lo ha tocado). */
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface NotificationSwitches {
  /** Killswitch de todo el entorno: apaga el correo (Resend) y/o el push para el equipo entero. */
  global: NotificationSwitch;
  /** Mis propios avisos. */
  me: { emailEnabled: boolean; pushEnabled: boolean };
  /** Cuántas personas se silenciaron por su cuenta. */
  mutedDevs: number;
}

/** Cambio parcial: se manda emailEnabled y/o pushEnabled. */
export interface SwitchPatch {
  emailEnabled?: boolean;
  pushEnabled?: boolean;
}

// ---- Capacidad del equipo ----
// Espeja src/dashboard/capacity.ts. Todo lo derivado (`load`) llega ya calculado del backend: la
// regla de negocio vive en un solo sitio, y la tabla solo la pinta.

export type CapacityRole = 'ceo' | 'pm' | 'account_manager' | 'dev' | 'designer' | 'intern';
export type CapacityCommitment = 'full_time' | 'part_time';
export type AssignmentKind = 'principal' | 'secondary';
export type LoadState = 'libre' | 'disponible' | 'optima' | 'completa' | 'saturada';

export interface CapacityAssignment {
  id: string;
  kind: AssignmentKind;
  projectId: string | null;
  projectName: string | null;
  repoId: string | null;
  repo: string | null;
  focus: string | null;
  loadPct: number;
  position: number;
}

export interface CapacitySkill { skillId: string; tag: string; level: number }

export interface CapacityDev {
  id: string;
  name: string;
  avatarUrl: string | null;
  active: boolean;
  role: CapacityRole;
  commitment: CapacityCommitment;
  profile: string | null;
  weeklyHours: number;
  /** null = hereda el default de su dedicación. Distinto de "0 horas". */
  weeklyHoursOverride: number | null;
  continuousWork: string | null;
  loadNote: string | null;
  principal: CapacityAssignment[];
  secondary: CapacityAssignment[];
  skills: CapacitySkill[];
  load: {
    pct: number;
    state: LoadState;
    hoursUsed: number;
    hoursFree: number;
    maxPrincipal: number;
    overAssigned: boolean;
  };
}

export interface CapacityProject {
  id: string;
  name: string;
  key: string;
  repos: { id: string; repo: string }[];
}

export interface CapacityResponse {
  devs: CapacityDev[];
  projects: CapacityProject[];
  totals: { people: number; hours: number; hoursUsed: number; saturated: number; free: number };
}

// ---- roz v2: Linear como fuente de verdad, juntas, planes del agente, runners y Pulso ----
// Espejo manual de src/types/roz-v2.ts (contrato en docs/roz-v2-contracts.md). Los nombres deben
// calzar EXACTO: TypeScript no compara las dos declaraciones, así que un campo renombrado compila
// igual y llega vacío en runtime.

/** Estados de una tarea (espejo de src/tasks/states.ts). */
export type TaskState = 'planificada' | 'pendiente' | 'en_progreso' | 'revision' | 'completada' | 'cancelada';

/** GET /roz-v2/status: qué partes de roz v2 están encendidas. */
export interface RozV2Status {
  linearSourceOfTruth: boolean;
  linearConfigured: boolean;
  granolaEnabled: boolean;
}

// ---- Juntas

export type MeetingSource = 'manual' | 'granola';
export type MeetingStatus = 'pendiente' | 'extrayendo' | 'lista' | 'error';
export type TranscriptFormat = 'texto' | 'vtt' | 'srt' | 'granola_resumen' | 'granola_api';
export type ManualTranscriptFormat = Exclude<TranscriptFormat, 'granola_api'>;
export type MeetingProjectSource = 'dominio' | 'elegido';
export interface MeetingAttendee { name: string; email: string | null }
export type MeetingCandidateKind = 'tarea' | 'compromiso' | 'decision';
export type MeetingCandidateStatus = 'pendiente' | 'aceptada' | 'comentada' | 'descartada' | 'guardada';
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
  priority: 1 | 2 | 3 | 4 | null;
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
export interface InboxCandidate extends MeetingCandidate {
  meeting: { id: string; title: string; heldAt: string; projectId: string | null; projectName: string | null };
}
export interface MeetingsResponse { meetings: MeetingSummary[]; granolaEnabled: boolean }
export interface MeetingDetailResponse { meeting: MeetingDetail; candidates: MeetingCandidate[] }
export interface InboxResponse { candidates: InboxCandidate[] }
export interface ResolveProjectResponse {
  projectId: string | null;
  matches: { projectId: string; projectName: string; domain: string }[];
}
export interface CreateMeetingRequest {
  title: string;
  heldAt: string;
  durationMin?: number | null;
  attendees: MeetingAttendee[];
  projectId?: string | null;
  format: ManualTranscriptFormat;
  content: string;
  fileName?: string | null;
}
export interface AcceptCandidateRequest {
  mode?: 'crear' | 'comentar';
  title?: string;
  description?: string | null;
  assigneeDevId?: string | null;
  priority?: 1 | 2 | 3 | 4 | null;
  estimate?: number | null;
  solutionTypeId?: string | null;
  dueDate?: string | null;
  override?: { category: string; note?: string | null };
}
export interface AcceptCandidateResponse {
  candidate: MeetingCandidate;
  issue: { linearIssueId: string; identifier: string; url: string; workItemId: string } | null;
  comment: { commentId: string; url: string | null; identifier: string } | null;
  warnings: string[];
}

// ---- Planes del agente

export type PlanStatus =
  | 'en_cola' | 'planeando' | 'esperando_aprobacion' | 'implementando' | 'pr_abierto' | 'hecho' | 'jalado' | 'cancelado';
export type PlanPhase = 'planear' | 'implementar';
export type PlanRisk = 0 | 1 | 2;
export const PLAN_STATUSES: readonly PlanStatus[] = [
  'en_cola', 'planeando', 'esperando_aprobacion', 'implementando', 'pr_abierto', 'hecho', 'jalado', 'cancelado',
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
export const PLAN_RUNNING: readonly PlanStatus[] = ['planeando', 'implementando'];
export type RiskCode = 'ruta_sensible' | 'migracion' | 'auth_rls' | 'pagos' | 'cliente_sla' | 'ruta_proyecto' | 'origen_externo';
export interface RiskReason { code: RiskCode; detail: string }
export type PlanHumanAction = 'aprobar' | 'pedir_cambios' | 'reclamar' | 'jalar' | 'soltar' | 'cancelar';
export type PlanEventKind =
  | 'enqueued' | 'started' | 'progress' | 'plan_ready' | 'approved' | 'changes_requested' | 'claimed' | 'pulled'
  | 'released' | 'canceled' | 'pr_opened' | 'done' | 'requeued' | 'failed' | 'claimable';
export interface PlanProgress { step: string | null; message: string | null; pct: number | null; at: string }
export interface PlanDevRef { id: string; name: string; githubLogin: string | null; avatarUrl: string | null }
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
export type PlanScope = 'mine' | 'team' | 'claimable';
export interface PlansResponse { plans: AgentPlanSummary[]; counts: Record<PlanStatus, number> }
export interface RunnerPullResponse {
  planId: string;
  identifier: string;
  repo: string | null;
  baseBranch: string | null;
  branch: string;
  planMd: string;
  issue: { title: string; url: string | null };
}

// ---- Runners

export interface RunnerSchedule { tz: string; days: number[]; start: string; end: string }
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
export interface RunnersResponse { runners: RunnerSummary[] }
export interface CreateRunnerResponse { runner: RunnerSummary; token: string }

// ---- Pulso

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
  previous: { issuesClosed: number; prsMerged: number; commits: number };
}
export interface PulsePerson {
  devId: string;
  name: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  state: PersonState;
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
export interface PulseHeatCell { devId: string; day: string; hour: number; count: number }
export type PulseFeedKind =
  | 'commit' | 'branch' | 'pr_opened' | 'pr_merged' | 'issue_created' | 'issue_closed' | 'issue_assigned' | 'plan' | 'meeting'
  /** Deploy de un servicio vinculado y cambio de salud de un servicio (src/dashboard/pulse.ts). */
  | 'deploy' | 'infra';
export interface PulseFeedItem {
  id: string;
  at: string;
  kind: PulseFeedKind;
  devId: string | null;
  text: string;
  identifier: string | null;
  url: string | null;
  projectId: string | null;
  /** Solo en `deploy` / `infra`: proveedor del servicio (para su ícono oficial). */
  provider?: string | null;
  /** Solo en `deploy` / `infra`: salió bien, falló o sigue en curso. */
  tone?: 'ok' | 'bad' | 'pending' | null;
}
export interface PulseGroup {
  key: string;
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
export interface PulseFeedResponse { items: PulseFeedItem[] }

// ---- Llamadas de roz v2

const enc = encodeURIComponent;

export const rozV2Api = {
  status: () => apiGet<RozV2Status>('/roz-v2/status'),

  pulse: (groupBy: PulseGroupBy, weekStart: string | null) =>
    apiGet<PulseResponse>(`/pulse?groupBy=${groupBy}${weekStart ? `&weekStart=${weekStart}` : ''}`),
  pulseFeed: (after: string, limit = 50) => apiGet<PulseFeedResponse>(`/pulse/feed?after=${enc(after)}&limit=${limit}`),

  meetings: (opts: { status?: MeetingStatus; projectId?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.status) p.set('status', opts.status);
    if (opts.projectId) p.set('projectId', opts.projectId);
    if (opts.limit) p.set('limit', String(opts.limit));
    const q = p.toString();
    return apiGet<MeetingsResponse>(`/meetings${q ? `?${q}` : ''}`);
  },
  meeting: (id: string) => apiGet<MeetingDetailResponse>(`/meetings/${id}`),
  createMeeting: (body: CreateMeetingRequest) => apiSend<{ meeting: MeetingSummary }>('POST', '/meetings', body),
  resolveProject: (emails: string[]) =>
    apiGet<ResolveProjectResponse>(`/meetings/resolve-project?emails=${enc(emails.join(','))}`),
  inbox: (projectId?: string) => apiGet<InboxResponse>(`/meetings/inbox${projectId ? `?projectId=${projectId}` : ''}`),
  setMeetingProject: (id: string, projectId: string | null) =>
    apiSend<{ meeting: MeetingSummary }>('PATCH', `/meetings/${id}`, { projectId }),
  retryMeeting: (id: string) => apiSend<{ meeting: MeetingSummary }>('POST', `/meetings/${id}/retry`),
  deleteMeeting: (id: string) => apiSend<{ ok: true }>('DELETE', `/meetings/${id}`),
  acceptCandidate: (id: string, body: AcceptCandidateRequest) =>
    apiSend<AcceptCandidateResponse>('POST', `/meetings/candidates/${id}/accept`, body),
  discardCandidate: (id: string, reason: string | null) =>
    apiSend<{ candidate: MeetingCandidate }>('POST', `/meetings/candidates/${id}/discard`, { reason }),

  plans: (scope: PlanScope, status?: PlanStatus | null) =>
    apiGet<PlansResponse>(`/plans?scope=${scope}${status ? `&status=${status}` : ''}`),
  plan: (id: string) => apiGet<{ plan: AgentPlanDetail }>(`/plans/${id}`),
  approvePlan: (id: string) => apiSend<{ plan: AgentPlanSummary }>('POST', `/plans/${id}/approve`, {}),
  requestPlanChanges: (id: string, feedback: string) =>
    apiSend<{ plan: AgentPlanSummary }>('POST', `/plans/${id}/request-changes`, { feedback }),
  claimPlan: (id: string, note: string | null) => apiSend<{ plan: AgentPlanSummary }>('POST', `/plans/${id}/claim`, { note }),
  pullPlan: (id: string) => apiSend<{ plan: AgentPlanSummary; pull: RunnerPullResponse }>('POST', `/plans/${id}/pull`, {}),
  releasePlan: (id: string) => apiSend<{ plan: AgentPlanSummary }>('POST', `/plans/${id}/release`, {}),
  cancelPlan: (id: string, reason: string | null) => apiSend<{ plan: AgentPlanSummary }>('POST', `/plans/${id}/cancel`, { reason }),

  runners: (all = false) => apiGet<RunnersResponse>(`/runners${all ? '?all=1' : ''}`),
  createRunner: (body: { name: string; schedule?: RunnerSchedule; maxConcurrent?: number }) =>
    apiSend<CreateRunnerResponse>('POST', '/runners', body),
  updateRunner: (id: string, body: { name?: string; schedule?: RunnerSchedule; maxConcurrent?: number }) =>
    apiSend<{ runner: RunnerSummary }>('PATCH', `/runners/${id}`, body),
  revokeRunner: (id: string) => apiSend<{ runner: RunnerSummary }>('DELETE', `/runners/${id}`),
};

// ================================================================================================
// Chat sobre Discord (ROZ_DISCORD_CHAT). Espejo a mano, campo por campo, de las VISTAS de
// src/types/discord.ts; el contrato completo vive en docs/discord-chat-contracts.md. Si cambias un
// campo allá, cámbialo aquí en el mismo cambio: TypeScript no cruza la frontera y un nombre
// distinto compila igual y deja la UI vacía en runtime.
// Ids de Discord = snowflakes en STRING.
// ================================================================================================

/** Tipos de canal de Discord que la UI distingue (https://discord.com/developers/docs/resources/channel). */
export const DISCORD_CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE_VOICE: 13,
  GUILD_DIRECTORY: 14,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
} as const;

export type DiscordBridgeStatus = 'connecting' | 'backfilling' | 'ready' | 'disconnected';

export type DiscordUnavailableReason = 'disabled' | 'not_configured' | 'not_linked' | 'not_member';

export interface DiscordAttachment {
  id: string;
  filename: string;
  contentType: string | null;
  size: number;
  url: string;
  proxyUrl: string | null;
  width: number | null;
  height: number | null;
  description: string | null;
  durationSecs: number | null;
  spoiler: boolean;
}

export interface DiscordEmbed {
  type: string | null;
  title: string | null;
  description: string | null;
  url: string | null;
  color: number | null;
  timestamp: string | null;
  author: { name: string; url: string | null; iconUrl: string | null } | null;
  footer: { text: string; iconUrl: string | null } | null;
  image: { url: string; width: number | null; height: number | null } | null;
  thumbnail: { url: string; width: number | null; height: number | null } | null;
  video: { url: string; width: number | null; height: number | null } | null;
  provider: { name: string | null; url: string | null } | null;
  fields: { name: string; value: string; inline: boolean }[];
}

export interface DiscordSticker {
  id: string;
  name: string;
  /** 1 PNG, 2 APNG, 3 Lottie, 4 GIF. */
  formatType: number;
}

export interface DiscordEmojiRef {
  id: string | null;
  name: string | null;
  animated: boolean;
}

/** Solo lectura en roz (contrato §B.7). */
export interface DiscordReaction {
  emoji: DiscordEmojiRef;
  count: number;
  burstCount: number;
  userIds: string[];
}

export interface DiscordMentionedUser {
  id: string;
  username: string;
  globalName: string | null;
}

export interface DiscordLinkView {
  discordUserId: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
  linkedAt: string;
}

export interface DiscordGuildView {
  id: string;
  name: string;
  iconUrl: string | null;
}

export interface DiscordBridgeView {
  status: DiscordBridgeStatus;
  healthy: boolean;
  lastHeartbeatAt: string | null;
  lastReadyAt: string | null;
}

/** GET /discord/status — responde también con el flag apagado (`enabled: false`). */
export interface DiscordStatusView {
  enabled: boolean;
  unavailable: DiscordUnavailableReason | null;
  link: DiscordLinkView | null;
  guild: DiscordGuildView | null;
  bridge: DiscordBridgeView | null;
  maxUploadBytes: number;
  limits: string[];
}

export interface DiscordChannelAbilities {
  send: boolean;
  attach: boolean;
  mentionEveryone: boolean;
  readHistory: boolean;
}

export interface DiscordThreadView {
  id: string;
  parentId: string;
  name: string;
  type: number;
  archived: boolean;
  locked: boolean;
  private: boolean;
  starterMessageId: string | null;
  messageCount: number | null;
  lastMessageAt: string | null;
  /** Cuándo se archivó (null si está activo). Es la llave de `before` al paginar los archivados. */
  archivedAt: string | null;
  abilities: DiscordChannelAbilities;
}

export interface DiscordChannelView {
  id: string;
  type: number;
  name: string;
  topic: string | null;
  position: number;
  parentId: string | null;
  nsfw: boolean;
  syncedWithCategory: boolean;
  supported: boolean;
  lastMessageId: string | null;
  lastMessageAt: string | null;
  abilities: DiscordChannelAbilities;
  threads: DiscordThreadView[];
}

export interface DiscordCategoryView {
  id: string;
  name: string;
  position: number;
  channels: DiscordChannelView[];
}

/** GET /discord/channels */
export interface DiscordChannelTreeView {
  uncategorized: DiscordChannelView[];
  categories: DiscordCategoryView[];
}

export interface DiscordAuthorView {
  discordUserId: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  bot: boolean;
  webhook: boolean;
  devId: string | null;
  /** El propio bot de roz: se pinta a Roz-bot. */
  rozBot?: boolean;
}

export interface DiscordTaskRef {
  identifier: string;
  workItemId: string | null;
  name: string | null;
  status: string | null;
  url: string | null;
}

export interface DiscordReplyView {
  id: string;
  author: DiscordAuthorView | null;
  excerpt: string | null;
  deleted: boolean;
}

export interface DiscordMessageView {
  id: string;
  channelId: string;
  guildId: string;
  type: number;
  author: DiscordAuthorView;
  /** Markdown de Discord SIN la línea de respuesta de roz. */
  content: string;
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
  stickers: DiscordSticker[];
  mentions: DiscordMentionedUser[];
  mentionRoles: string[];
  mentionEveryone: boolean;
  reactions: DiscordReaction[];
  replyTo: DiscordReplyView | null;
  thread: { id: string; name: string; messageCount: number | null; lastMessageAt: string | null } | null;
  tasks: DiscordTaskRef[];
  pinned: boolean;
  createdAt: string;
  editedAt: string | null;
  fromRoz: boolean;
  clientNonce: string | null;
}

/** GET /discord/channels/:channelId/messages (orden DESCENDENTE: más nuevo primero). */
export interface DiscordMessagePage {
  messages: DiscordMessageView[];
  hasMore: boolean;
  backfillComplete: boolean;
}

export interface DiscordMemberView {
  discordUserId: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  bot: boolean;
  devId: string | null;
}

export interface DiscordEmojiView {
  id: string;
  name: string;
  animated: boolean;
  url: string;
}

export interface DiscordRoleView {
  id: string;
  name: string;
  color: number;
  position: number;
}

export interface DiscordUploadView {
  id: string;
  name: string;
  contentType: string | null;
  size: number | null;
}

export interface DiscordProjectChannelView {
  projectId: string;
  projectName: string;
  channelId: string | null;
  channelName: string | null;
}

export type DiscordStructureScope = 'guild' | 'channels' | 'roles' | 'members' | 'emojis' | 'threads';

export type DiscordRealtimeEvent =
  | 'discord.message.created'
  | 'discord.message.updated'
  | 'discord.message.deleted'
  | 'discord.channels.changed'
  | 'discord.link.changed'
  | 'discord.bridge.status';

/** Eventos del buzón `chat:dev:<devId>` (contrato §C). */
export interface DiscordRealtimePayloads {
  'discord.message.created': { channelId: string; message: DiscordMessageView };
  'discord.message.updated': { channelId: string; message: DiscordMessageView };
  'discord.message.deleted': { channelId: string; messageIds: string[] };
  'discord.channels.changed': { reason: DiscordStructureScope };
  'discord.link.changed': { linked: boolean };
  'discord.bridge.status': { status: DiscordBridgeStatus };
}

export const DISCORD_REALTIME_EVENTS: readonly DiscordRealtimeEvent[] = [
  'discord.message.created',
  'discord.message.updated',
  'discord.message.deleted',
  'discord.channels.changed',
  'discord.link.changed',
  'discord.bridge.status',
];

/** Cuerpo de POST /discord/channels/:channelId/messages (contrato §B.4). */
export interface DiscordSendBody {
  content: string;
  replyToId?: string;
  uploadIds?: string[];
  clientNonce?: string;
}

/** Respuesta de POST /discord/channels/:channelId/uploads (contrato §B.6). */
export interface DiscordUploadTicket {
  upload: DiscordUploadView;
  uploadUrl: string;
  token: string;
  path: string;
}

/** Cuerpo de "Crear issue desde un mensaje": el mismo de la creación de tareas (TaskCreateBody). */
export interface DiscordTaskCreateBody {
  name: string;
  description: string | null;
  projectId: string;
  status?: string;
  priority?: string | null;
  assigneeDevIds?: string[];
  labels?: string[];
  dueDate?: string | null;
}

// ---- Comandos de /roz desde el compositor (docs/discord-commands-contract.md §9) ----
// Espejo a mano de src/discord/commands/definitions.ts (CommandMenuItem) y from-roz.ts.

export type DiscordRozSubcommand = 'tarea' | 'ticket' | 'status' | 'plan' | 'pulso' | 'infra' | 'junta';

/** Una entrada del menú "/" (misma lista y descripciones que el desplegable de Discord). */
export interface DiscordCommandMenuItem {
  /** "/roz tarea" */
  command: string;
  subcommand: DiscordRozSubcommand;
  description: string;
  options: { name: string; description: string; required: boolean }[];
}

/** Cuerpo de POST /discord/channels/:channelId/commands. */
export interface DiscordCommandRunBody {
  subcommand: DiscordRozSubcommand;
  options?: Record<string, string>;
  /** Lo que en Discord es el modal: ticket (titulo, descripcion), junta (titulo, notas), status (tareas, nota). */
  fields?: Record<string, string | string[]>;
}

/** Lo que solo ve quien usó el comando (en Discord sería efímero). */
export interface DiscordCommandEphemeral {
  content: string;
  embeds: DiscordEmbed[];
  links: { label: string; url: string }[];
}

export interface DiscordCommandResult {
  published: DiscordMessageView[];
  ephemeral: DiscordCommandEphemeral[];
}

export interface DiscordCommandChoice {
  name: string;
  value: string;
}

export const discordApi = {
  status: () => apiGet<DiscordStatusView>('/discord/status'),
  channels: () => apiGet<DiscordChannelTreeView>('/discord/channels'),
  archivedThreads: (channelId: string, opts: { before?: string; limit?: number } = {}) => {
    const p = new URLSearchParams({ archived: 'true', limit: String(opts.limit ?? 25) });
    if (opts.before) p.set('before', opts.before);
    return apiGet<{ threads: DiscordThreadView[]; hasMore: boolean }>(`/discord/channels/${enc(channelId)}/threads?${p}`);
  },
  messages: (channelId: string, opts: { before?: string; around?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.before) p.set('before', opts.before);
    else if (opts.around) p.set('around', opts.around);
    if (opts.limit) p.set('limit', String(opts.limit));
    const q = p.toString();
    return apiGet<DiscordMessagePage>(`/discord/channels/${enc(channelId)}/messages${q ? `?${q}` : ''}`);
  },
  send: (channelId: string, body: DiscordSendBody) =>
    apiSend<{ message: DiscordMessageView }>('POST', `/discord/channels/${enc(channelId)}/messages`, body),
  edit: (messageId: string, content: string) =>
    apiSend<{ message: DiscordMessageView }>('PATCH', `/discord/messages/${enc(messageId)}`, { content }),
  remove: (messageId: string) => apiSend<{ ok: true }>('DELETE', `/discord/messages/${enc(messageId)}`),
  startUpload: (channelId: string, body: { name: string; size: number; contentType: string | null }) =>
    apiSend<DiscordUploadTicket>('POST', `/discord/channels/${enc(channelId)}/uploads`, body),
  completeUpload: (uploadId: string) =>
    apiSend<{ upload: DiscordUploadView }>('POST', `/discord/uploads/${enc(uploadId)}/complete`, {}),
  members: (q: string, limit = 20) =>
    apiGet<{ members: DiscordMemberView[] }>(`/discord/members?q=${enc(q)}&limit=${limit}`),
  emojis: () => apiGet<{ emojis: DiscordEmojiView[] }>('/discord/emojis'),
  roles: () => apiGet<{ roles: DiscordRoleView[] }>('/discord/roles'),
  linkStart: () => apiSend<{ url: string }>('POST', '/discord/link/start', {}),
  unlink: () => apiSend<{ ok: true }>('DELETE', '/discord/link'),
  projectChannels: () => apiGet<{ items: DiscordProjectChannelView[] }>('/discord/project-channels'),
  setProjectChannel: (projectId: string, channelId: string | null) =>
    apiSend<{ item: DiscordProjectChannelView }>('PUT', `/discord/project-channels/${enc(projectId)}`, { channelId }),
  /** Crear issue/tarea desde un mensaje (contrato §B.11). */
  createTask: (messageId: string, body: DiscordTaskCreateBody) =>
    apiSend<{ task: Ticket }>('POST', `/discord/messages/${enc(messageId)}/task`, body),
  /** Menú "/" del compositor: subcomandos de /roz (contrato de comandos §9). */
  commands: () => apiGet<{ items: DiscordCommandMenuItem[] }>('/discord/commands'),
  /** Ejecuta un subcomando de /roz como el dev de la sesión; lo público sale en el canal. */
  runCommand: (channelId: string, body: DiscordCommandRunBody) =>
    apiSend<DiscordCommandResult>('POST', `/discord/channels/${enc(channelId)}/commands`, body),
  /** El mismo autocompletado que Discord para una opción del subcomando. */
  commandChoices: (channelId: string, body: { subcommand: DiscordRozSubcommand; option: string; value: string; options?: Record<string, string> }) =>
    apiSend<{ choices: DiscordCommandChoice[] }>('POST', `/discord/channels/${enc(channelId)}/commands/autocomplete`, body),
};

// ---- Reportes: trabajo y enfoque (src/dashboard/reports.ts) ----
export interface WorkReportShare {
  projectId: string | null;
  name: string;
  color: string | null;
  /** % del reparto de esa persona (0–100). */
  share: number;
  commits?: number;
}
export interface WorkReportProject {
  projectId: string | null;
  name: string;
  kind: string | null;
  color: string | null;
  client: string;
  clientKey: string;
  commits: number;
  lines: number;
  /** Esfuerzo del proyecto: √(commits × líneas) / 10 sobre sus commits del período. */
  points: number;
  closed: number;
  opened: number;
  open: number;
  people: number;
  /** Commits por cubo de tiempo, alineado con `trend`. */
  spark: number[];
  share: number;
}
export interface WorkReportPerson {
  devId: string;
  name: string;
  avatarUrl: string | null;
  commits: number;
  lines: number;
  points: number;
  closed: number;
  open: number;
  projectCount: number;
  topProject: string | null;
  topShare: number;
  actual: WorkReportShare[];
  planned: WorkReportShare[];
  /** Traslape entre reparto real y plan de Capacidad (0–100). null = sin plan o sin código. */
  alignment: number | null;
  offPlan: number;
}
export interface WorkReport {
  period: { from: string; to: string };
  compare: { from: string; to: string } | null;
  granularity: 'day' | 'week';
  kpis: {
    hyperPoints: Metric; commits: Metric; linesChanged: Metric; closed: Metric; opened: Metric;
    cycleHours: Metric; activeProjects: Metric; focusTop3: Metric;
  };
  focus: { top1: number; top3: number; activeProjects: number; topProject: string | null; teamAlignment: number | null };
  trend: { date: string; commits: number; lines: number; opened: number; closed: number; net: number; previous: number | null }[];
  byProject: WorkReportProject[];
  byClient: { label: string; commits: number; lines: number; closed: number; projects: number; points: number; share: number }[];
  split: { client: number; internal: number; unassigned: number };
  byType: { type: string; commits: number; lines: number }[];
  /** Commits por día de la semana, lunes primero. */
  weekday: number[];
  cycle: { medianHours: number; dist: { label: string; value: number }[] };
  backlog: { open: number; overdue: number; unassigned: number; age: { label: string; value: number }[] };
  people: WorkReportPerson[];
}
