// Contrato de zeus (contexto unificado del equipo) visto desde el front. Los tipos son una COPIA A
// MANO de `src/types/zeus.ts` (mismo criterio que `lib/api.ts`): si el back renombra un campo, esto
// compila igual y la UI pinta el campo vacío, así que cualquier cambio allá se replica aquí.
// Rutas: docs/zeus-contracts.md §3 (base `/api/dashboard/zeus`).
import { apiGet, apiSend } from './api';

// ---------------------------------------------------------------- grafo

/** Tipos de nodo GUARDADO (roz.zeus_node). */
export const ZEUS_NODE_KINDS = ['adr', 'spec', 'change', 'doc', 'design', 'rule', 'resource', 'team'] as const;
export type ZeusNodeKind = (typeof ZEUS_NODE_KINDS)[number];

/** Tipos de nodo DERIVADO: existen en otras tablas y el grafo los dibuja sin duplicarlos. */
export type ZeusEntityKind = 'project' | 'dev' | 'repo' | 'runner';

export type ZeusGraphKind = ZeusNodeKind | ZeusEntityKind;

export const ZEUS_NODE_STATUSES = ['draft', 'active', 'superseded', 'archived'] as const;
export type ZeusNodeStatus = (typeof ZEUS_NODE_STATUSES)[number];

export const ZEUS_EDGE_KINDS = [
  'supersedes',
  'depends_on',
  'relates_to',
  'implements',
  'owns',
  'applies_to',
  'part_of',
  'connects_to',
  'documents',
] as const;
export type ZeusEdgeKind = (typeof ZEUS_EDGE_KINDS)[number];

/**
 * Referencia de un extremo del grafo: `<tipo>:<id>`.
 *   node:<uuid> · dev:<uuid> · project:<uuid> · repo:<owner/name> · runner:<uuid>
 */
export type ZeusRef = string;

export interface ZeusGraphNode {
  ref: ZeusRef;
  kind: ZeusGraphKind;
  title: string;
  /** Una línea. Vacío si no hay. */
  summary: string;
  /** Proyecto al que pertenece (uuid) o null si es de la organización. */
  projectId: string | null;
  status: ZeusNodeStatus;
  pinned: boolean;
  /** Procedencia: manual (creado en zeus) | git (importado de un repo; se edita en zeus igual) para nodos guardados; 'derived' para entidades. */
  source: 'manual' | 'git' | 'derived';
  updatedAt: string | null;
  /** dev → { role, githubLogin, online }, runner → { online, devId }, project → { key, color }, resource → { type, url }. */
  meta: Record<string, unknown>;
}

export interface ZeusGraphEdge {
  /** uuid para aristas guardadas; `d:<src>|<kind>|<dst>` para derivadas (no se pueden borrar). */
  id: string;
  src: ZeusRef;
  dst: ZeusRef;
  kind: ZeusEdgeKind | 'reports_to';
  derived: boolean;
  /** De dónde salió: a mano en zeus, del texto de un documento al importarlo de un repo (se puede quitar y no regresa) o derivada. */
  source: 'manual' | 'git' | 'derived';
  note: string | null;
}

export interface ZeusGraph {
  nodes: ZeusGraphNode[];
  edges: ZeusGraphEdge[];
  /** Conteo por tipo (para las categorías del radial). */
  counts: Partial<Record<ZeusGraphKind, number>>;
  generatedAt: string;
}

export interface ZeusNodeSummary {
  id: string;
  ref: ZeusRef;
  kind: ZeusNodeKind;
  slug: string;
  title: string;
  summary: string;
  projectId: string | null;
  projectKey: string | null;
  status: ZeusNodeStatus;
  source: 'manual' | 'git';
  sourceUrl: string | null;
  ownerDevId: string | null;
  tags: string[];
  pinned: boolean;
  reviewAfter: string | null;
  version: number;
  updatedAt: string;
}

export interface ZeusNodeRevision {
  version: number;
  title: string;
  editedBy: string | null;
  editedByName: string | null;
  editedVia: 'web' | 'mcp' | 'git';
  createdAt: string;
}

export type ZeusNodeEdge = ZeusGraphEdge & {
  otherRef: ZeusRef;
  otherTitle: string;
  otherKind: ZeusGraphKind;
  direction: 'out' | 'in';
};

export interface ZeusNodeDetail extends ZeusNodeSummary {
  body: string;
  sourceRepo: string | null;
  sourcePath: string | null;
  meta: Record<string, unknown>;
  /** Aristas que tocan al nodo, con el título del otro extremo ya resuelto. */
  edges: ZeusNodeEdge[];
  revisions: ZeusNodeRevision[];
}

/** Alta/edición de un nodo. Todos se editan en zeus, también los importados de un repo. */
export interface ZeusNodeInput {
  kind: ZeusNodeKind;
  title: string;
  summary?: string;
  body?: string;
  /** uuid del proyecto, o null/omitido = organización. */
  projectId?: string | null;
  slug?: string;
  status?: ZeusNodeStatus;
  ownerDevId?: string | null;
  tags?: string[];
  pinned?: boolean;
  reviewAfter?: string | null;
  meta?: Record<string, unknown>;
}

export interface ZeusSearchHit {
  id: string;
  ref: ZeusRef;
  kind: ZeusNodeKind;
  title: string;
  summary: string;
  projectId: string | null;
  status: ZeusNodeStatus;
  source: 'manual' | 'git';
  sourceUrl: string | null;
  pinned: boolean;
  updatedAt: string;
  rank: number;
  snippet: string;
}

// ---------------------------------------------------------------- organización

export interface ZeusOrgMember {
  devId: string;
  name: string;
  email: string | null;
  role: string;
  githubLogin: string | null;
  active: boolean;
  reportsTo: string | null;
  /** Puesto visible ("Líder técnico y desarrollador de AI"); `role` es la categoría de capacidad. */
  title: string | null;
  /** Líneas punteadas: a quién más se reporta. */
  alsoReportsTo: string[];
  /** Temas que atiende (code_review, deploys…), de ZeusOrg.duties. */
  duties: string[];
  zeusAdmin: boolean;
  /** Claves de los proyectos donde está asignado. */
  projects: string[];
  skills: string[];
  /** Tiene un runner latiendo ahora. */
  online: boolean;
}

/** Un tema del equipo y quién lo atiende, en orden. */
export interface ZeusOrgDuty {
  duty: string;
  label: string;
  hint: string;
  devIds: string[];
}

export interface ZeusOrg {
  members: ZeusOrgMember[];
  /** Quién se encarga de qué (revisión de código, deploys, clientes…). */
  duties: ZeusOrgDuty[];
  /** True si todavía nadie administra zeus: cualquiera puede tomar el rol una vez. */
  needsAdmin: boolean;
}

export interface ZeusMe {
  devId: string;
  name: string;
  zeusAdmin: boolean;
  needsAdmin: boolean;
  unreadMessages: number;
  pendingForMe: number;
  /** Encargos y planes abiertos que me mandaron. */
  openForMe: number;
  /** URL del MCP para configurar Claude Code (origen público de zeus + /mcp). */
  mcpUrl: string;
  /** Origen público de zeus (para el CLI). */
  apiUrl: string;
}

// ---------------------------------------------------------------- acceso

export interface ZeusTokenSummary {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export type ZeusDeviceStatus = 'pending' | 'approved' | 'denied' | 'delivered' | 'expired';

/** Solicitud de `zeus setup` vista desde /conectar: qué equipo pide entrar y con qué código. */
export interface ZeusDeviceRequest {
  userCode: string;
  /** Nombre del equipo que dio el CLI (hostname). */
  clientName: string;
  clientPlatform: string | null;
  clientVersion: string | null;
  /** IP desde la que el CLI abrió la solicitud. */
  clientIp: string | null;
  status: ZeusDeviceStatus;
  createdAt: string;
  expiresAt: string;
  /** Quién la aprobó o rechazó. */
  decidedBy: string | null;
}

// ---------------------------------------------------------------- bandeja

export const ZEUS_REQUEST_KINDS = ['access', 'permission', 'review', 'change', 'other'] as const;
export type ZeusRequestKind = (typeof ZEUS_REQUEST_KINDS)[number];
export type ZeusRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled';

export interface ZeusRequest {
  id: string;
  kind: ZeusRequestKind;
  title: string;
  detail: string;
  status: ZeusRequestStatus;
  requesterDevId: string;
  requesterName: string;
  approverDevId: string | null;
  approverName: string | null;
  resourceRef: ZeusRef | null;
  resourceTitle: string | null;
  routedBecause: string | null;
  resolutionNote: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  via: 'mcp' | 'web' | 'cli';
  createdAt: string;
  /** El que consulta puede resolverla (es el aprobador o es admin). */
  canResolve: boolean;
}

/** message: aviso · task: encargo · plan: plan de implementación · env_change: cambiaron variables. */
export type ZeusMessageKind = 'message' | 'task' | 'plan' | 'env_change';
export type ZeusMessageStatus = 'pending' | 'accepted' | 'changes_requested' | 'declined' | 'done' | 'cancelled' | 'superseded';
export const ZEUS_OPEN_STATUSES: readonly ZeusMessageStatus[] = ['pending', 'accepted', 'changes_requested'];

export interface ZeusMessage {
  id: string;
  kind: ZeusMessageKind;
  fromDevId: string | null;
  /** "zeus" cuando es un aviso del sistema. */
  fromName: string;
  toDevId: string;
  toName: string;
  subject: string | null;
  body: string;
  ref: ZeusRef | null;
  requestId: string | null;
  via: 'mcp' | 'web' | 'cli' | 'system';
  readAt: string | null;
  createdAt: string;
  /** Solo encargos y planes; null en mensajes y avisos. */
  status: ZeusMessageStatus | null;
  statusNote: string | null;
  statusAt: string | null;
  /** Versión anterior del plan, o el encargo/plan al que responde este aviso. */
  parentId: string | null;
  projectKey: string | null;
}

export interface ZeusInbox {
  messages: ZeusMessage[];
  /** Avisos de cambios de variables (aparte: son muchos y no deben tapar los mensajes). */
  envChanges: ZeusMessage[];
  /** Mensajes que yo envié (los más recientes). */
  sent: ZeusMessage[];
  /** Encargos y planes que me mandaron y siguen abiertos: mis pendientes. */
  open: ZeusMessage[];
  /** Encargos y planes que yo mandé y siguen abiertos: lo que espero de otros. */
  waiting: ZeusMessage[];
  /** Solicitudes que me toca resolver. */
  toResolve: ZeusRequest[];
  /** Solicitudes que yo abrí. */
  mine: ZeusRequest[];
  unread: number;
}

// ---------------------------------------------------------------- Linear (en vivo, sin espejo)

/** Un ticket de Linear como lo ve la bandeja. */
export interface ZeusLinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  stateType: 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'triage';
  /** 0 sin prioridad, 1 urgente … 4 baja. */
  priority: number;
  priorityLabel: string;
  team: string;
  project: string | null;
  assignee: string | null;
  labels: string[];
  dueDate: string | null;
  cycle: string | null;
  branchName: string | null;
  updatedAt: string;
}

/** Lo de Linear para la bandeja: tus tickets en curso y por hacer. */
export interface ZeusLinearBoard {
  /** ok · not_configured (zeus sin llave) · no_user (tu correo no está en Linear) · error. */
  status: 'ok' | 'not_configured' | 'no_user' | 'error';
  user: string | null;
  issues: ZeusLinearIssue[];
  fetchedAt: string;
  error?: string;
}

// ---------------------------------------------------------------- fuentes y actividad

export interface ZeusSource {
  repo: string;
  projectId: string | null;
  projectKey: string | null;
  defaultBranch: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  nodeCount: number;
  /** Hay una lectura del repo pedida (para importar lo nuevo) que la barrida todavía no atiende. */
  pending: boolean;
}

export interface ZeusActivityEvent {
  id: number;
  at: string;
  devId: string | null;
  devName: string | null;
  actor: 'mcp' | 'web' | 'cli' | 'git' | 'runner' | 'system';
  action: string;
  ref: ZeusRef | null;
  detail: Record<string, unknown>;
}

// ---------------------------------------------------------------- estado del MCP (espejo de src/types/zeus.ts)

/** El servidor MCP de zeus tal como lo ve Claude Code al conectarse. */
export interface ZeusMcpServer {
  name: string;
  version: string;
  /** Cuándo arrancó este proceso de zeus. */
  startedAt: string;
  uptimeSec: number;
  tools: number;
  /** Las que también ve un runner (solo lectura). */
  readOnlyTools: number;
  prompts: string[];
  /** Largo de las instrucciones que hacen de "skill". */
  instructionsChars: number;
}

/** Una persona conectada a zeus: sus tokens y cuándo la usó su Claude (MCP) o su CLI. */
export interface ZeusMcpConnection {
  devId: string;
  name: string;
  githubLogin: string | null;
  email: string | null;
  tokens: number;
  lastTokenUseAt: string | null;
  lastMcpAt: string | null;
  lastCliAt: string | null;
  events24h: number;
  events7d: number;
  /** Tiene un runner latiendo ahora. */
  runnerOnline: boolean;
}

export interface ZeusMcpActivityStats {
  events24h: number;
  events7d: number;
  mcp24h: number;
  cli24h: number;
  activeDevs24h: number;
  activeDevs7d: number;
  /** Eventos MCP+CLI por hora en las últimas 24 h (24 cubetas, la última = la hora en curso). */
  hourly: number[];
  topActions: Array<{ action: string; count: number }>;
}

export interface ZeusMcpPendingItem {
  kind: 'task' | 'plan' | 'request' | 'agent_plan';
  id: string;
  title: string;
  from: string | null;
  to: string | null;
  status: string;
  at: string;
}

export interface ZeusMcpPending {
  tasks: number;
  plans: number;
  requests: number;
  /** Planes del planificador esperando un runner. */
  queuedPlans: number;
  /** Planes corriendo ahora en la PC de alguien. */
  runningPlans: number;
  items: ZeusMcpPendingItem[];
}

export interface ZeusMcpRunner {
  id: string;
  devId: string;
  devName: string;
  name: string;
  platform: string | null;
  lastSeenAt: string | null;
  online: boolean;
}

export interface ZeusMcpSources {
  total: number;
  withDocs: number;
  empty: number;
  errored: number;
  pending: number;
  docs: number;
  lastSyncedAt: string | null;
  /** Solo los repos que piden atención (con error o pendientes de leer). */
  attention: ZeusSource[];
}

/** Vista del MCP para el dashboard: estado, conexiones, último trabajo, pendientes, runners, ingesta. */
export interface ZeusMcpStatus {
  server: ZeusMcpServer;
  connections: ZeusMcpConnection[];
  activity: ZeusMcpActivityStats;
  recent: ZeusActivityEvent[];
  pending: ZeusMcpPending;
  runners: ZeusMcpRunner[];
  sources: ZeusMcpSources;
  now: string;
}

export interface ZeusActivityResponse {
  events: ZeusActivityEvent[];
  now: string;
}

// ---------------------------------------------------------------- bóveda

export interface ZeusVaultKey {
  id: string;
  devId: string;
  devName: string;
  /** Solo en el listado de admin del CLI (`?all=1`); el dashboard no lo recibe. */
  devEmail?: string | null;
  name: string;
  publicKey: string;
  fingerprint: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ZeusVaultSecret {
  name: string;
  version: number;
  updatedAt: string;
  updatedByName: string | null;
  stale: boolean;
}

export interface ZeusVaultGrant {
  keyId: string;
  devId: string;
  devName: string;
  keyName: string;
  fingerprint: string;
  grantedAt: string;
}

export interface ZeusVaultEnvSummary {
  id: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  name: string;
  dekVersion: number;
  /** Solo NOMBRES: los valores nunca pasan por el back en claro. */
  secrets: ZeusVaultSecret[];
  /** Equipos con acceso vigente a la DEK actual. */
  grants: ZeusVaultGrant[];
  /** Hay accesos revocados desde la última rotación: conviene rotar la llave del entorno. */
  needsRotation: boolean;
}

export interface ZeusVaultAuditEntry {
  id: number;
  at: string;
  devName: string | null;
  action: string;
  envLabel: string | null;
  detail: Record<string, unknown>;
}

/** Una versión de una variable, sin valor ni texto cifrado (espejo de RevisionMeta en src/zeus/vault.ts). */
export interface ZeusVaultRevisionMeta {
  name: string;
  version: number;
  setAt: string;
  setByName: string | null;
  replacedAt: string | null;
  replacedByName: string | null;
  current: boolean;
  /** En esa versión la variable se borró. */
  deleted: boolean;
  /** Se puede restaurar (está cifrada con la llave vigente del entorno). */
  readable: boolean;
}

/**
 * Acceso aprobado en la web y aún sin cifrar: falta que alguien con acceso corra
 * `zeus env grant --pending` en su PC (el servidor no puede envolver la DEK).
 */
export interface ZeusVaultGrantIntent {
  id: string;
  envId: string;
  toDevId: string;
  toDevName: string;
  approvedByName: string | null;
  createdAt: string;
  /** Equipos vigentes del destinatario que aún no tienen la llave del entorno (0 = sin llave registrada). */
  pendingKeys: number;
}

export interface ZeusVaultOverview {
  envs: ZeusVaultEnvSummary[];
  keys: ZeusVaultKey[];
  intents: ZeusVaultGrantIntent[];
  audit: ZeusVaultAuditEntry[];
}

// ---------------------------------------------------------------- llamadas

const enc = encodeURIComponent;

function query(params: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface ZeusNodeFilter {
  projectId?: string | null;
  kind?: ZeusNodeKind | null;
  status?: ZeusNodeStatus | null;
  q?: string | null;
}

/** Namespace de caché de todo zeus: `invalidate(ZEUS_KEY)` revalida cualquier vista montada. */
export const ZEUS_KEY = '/zeus';

export const zeusApi = {
  me: () => apiGet<ZeusMe>('/zeus/me'),
  bootstrapAdmin: () => apiSend<ZeusMe>('POST', '/zeus/admin/bootstrap', {}),

  graph: (projectId?: string | null) => apiGet<ZeusGraph>(`/zeus/graph${query({ projectId })}`),
  nodes: (f: ZeusNodeFilter = {}) => apiGet<{ nodes: ZeusNodeSummary[] }>(`/zeus/nodes${query({ ...f })}`),
  node: (id: string) => apiGet<ZeusNodeDetail>(`/zeus/nodes/${enc(id)}`),
  createNode: (body: ZeusNodeInput) => apiSend<ZeusNodeDetail>('POST', '/zeus/nodes', body),
  updateNode: (id: string, body: Partial<ZeusNodeInput>) => apiSend<ZeusNodeDetail>('PATCH', `/zeus/nodes/${enc(id)}`, body),
  archiveNode: (id: string) => apiSend<{ ok: true }>('DELETE', `/zeus/nodes/${enc(id)}`),
  /** Trae la versión del repo de un documento importado y la aplica como una edición más (404 `ZEUS_SOURCE_GONE` si el archivo ya no existe). */
  reimportNode: (id: string) => apiSend<ZeusNodeDetail>('POST', `/zeus/nodes/${enc(id)}/reimport`, {}),
  createEdge: (body: { src: ZeusRef; dst: ZeusRef; kind: ZeusEdgeKind; note?: string }) =>
    apiSend<ZeusGraphEdge>('POST', '/zeus/edges', body),
  deleteEdge: (id: string) => apiSend<{ ok: true }>('DELETE', `/zeus/edges/${enc(id)}`),
  search: (q: string, opts: { projectId?: string | null; kinds?: ZeusNodeKind[] } = {}) =>
    apiGet<{ hits: ZeusSearchHit[] }>(`/zeus/search${query({ q, projectId: opts.projectId, kinds: opts.kinds?.join(',') })}`),

  org: () => apiGet<ZeusOrg>('/zeus/org'),
  updateMember: (devId: string, body: { reportsTo?: string | null; zeusAdmin?: boolean; title?: string | null; alsoReportsTo?: string[] }) =>
    apiSend<ZeusOrgMember>('PATCH', `/zeus/org/${enc(devId)}`, body),
  /** Quién atiende un tema, en orden (solo admin de zeus). */
  setDuty: (duty: string, devIds: string[]) => apiSend<ZeusOrg>('PUT', `/zeus/org/duties/${enc(duty)}`, { devIds }),

  tokens: () => apiGet<{ tokens: ZeusTokenSummary[] }>('/zeus/tokens'),
  createToken: (name: string) => apiSend<{ token: string; summary: ZeusTokenSummary }>('POST', '/zeus/tokens', { name }),
  revokeToken: (id: string) => apiSend<{ ok: true }>('DELETE', `/zeus/tokens/${enc(id)}`),
  /** Conectar una PC (`zeus setup`): la solicitud por su código, y aprobarla o rechazarla. */
  deviceRequest: (userCode: string) => apiGet<ZeusDeviceRequest>(`/zeus/device/${enc(userCode)}`),
  approveDevice: (userCode: string) => apiSend<ZeusDeviceRequest>('POST', `/zeus/device/${enc(userCode)}/approve`, {}),
  denyDevice: (userCode: string) => apiSend<ZeusDeviceRequest>('POST', `/zeus/device/${enc(userCode)}/deny`, {}),

  inbox: () => apiGet<ZeusInbox>('/zeus/inbox'),
  linearBoard: () => apiGet<ZeusLinearBoard>('/zeus/linear/board'),
  /** Historial completo de la bandeja (leído y no leído) con filtros. */
  messageHistory: (q: { box?: 'received' | 'sent'; kind?: ZeusMessageKind; with?: string; project?: string; q?: string; before?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    const tail = qs.toString();
    return apiGet<{ messages: ZeusMessage[]; nextBefore: string | null }>(`/zeus/messages${tail ? `?${tail}` : ''}`);
  },
  sendMessage: (body: { toDevId: string; subject?: string; body: string; ref?: ZeusRef; kind?: 'message' | 'task'; projectKey?: string }) =>
    apiSend<ZeusMessage>('POST', '/zeus/messages', body),
  sharePlan: (body: { toDevId: string; title: string; plan: string; projectKey?: string; revises?: string }) =>
    apiSend<ZeusMessage>('POST', '/zeus/plans', body),
  message: (id: string) => apiGet<ZeusMessage & { history: ZeusMessage[] }>(`/zeus/messages/${id}`),
  setMessageStatus: (id: string, status: ZeusMessageStatus, note?: string) =>
    apiSend<ZeusMessage>('POST', `/zeus/messages/${id}/status`, { status, note }),
  markRead: (ids: string[] | 'all') => apiSend<{ ok: true }>('POST', '/zeus/messages/read', { ids }),
  createRequest: (body: { kind: ZeusRequestKind; title: string; detail?: string; resourceRef?: ZeusRef; topic?: string }) =>
    apiSend<ZeusRequest>('POST', '/zeus/requests', body),
  resolveRequest: (id: string, decision: 'approved' | 'denied', note?: string) =>
    apiSend<ZeusRequest>('POST', `/zeus/requests/${enc(id)}/resolve`, { decision, ...(note ? { note } : {}) }),
  cancelRequest: (id: string) => apiSend<ZeusRequest>('POST', `/zeus/requests/${enc(id)}/cancel`, {}),

  sources: () => apiGet<{ sources: ZeusSource[] }>('/zeus/sources'),
  syncSource: (repo: string) => apiSend<{ ok: true }>('POST', '/zeus/sources/sync', { repo }),
  activity: (since?: string | null) => apiGet<ZeusActivityResponse>(`/zeus/activity${query({ since })}`),
  mcp: () => apiGet<ZeusMcpStatus>('/zeus/mcp'),

  vault: () => apiGet<ZeusVaultOverview>('/zeus/vault'),
  vaultHistory: (projectKey: string, env: string, name?: string) =>
    apiGet<{ revisions: ZeusVaultRevisionMeta[] }>(`/zeus/vault/envs/${enc(projectKey)}/${enc(env)}/history${name ? `?name=${enc(name)}` : ''}`),
  revokeVaultKey: (id: string) => apiSend<{ ok: true }>('POST', `/zeus/vault/keys/${enc(id)}/revoke`, {}),
  /** Aprueba que alguien entre a un entorno; lo cifra después un CLI con acceso (`zeus env grant --pending`). */
  approveVaultGrant: (body: { envId: string; toDevId: string }) => apiSend<ZeusVaultGrantIntent>('POST', '/zeus/vault/grant-intents', body),
  cancelVaultGrant: (id: string) => apiSend<{ ok: true }>('POST', `/zeus/vault/grant-intents/${enc(id)}/cancel`, {}),
};

/** `node:<uuid>` → uuid; null si la referencia es de una entidad derivada (dev, project, repo, runner). */
export function nodeIdOf(ref: ZeusRef): string | null {
  return ref.startsWith('node:') ? ref.slice(5) : null;
}
