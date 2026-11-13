// Contrato de zeus (gestión de contexto). Tipos PUROS: los usa el back (src/zeus/*), y el front los
// copia a mano en web/src/lib/zeus.ts (mismo criterio que web/src/lib/api.ts). El detalle de rutas,
// formatos de cifrado y herramientas MCP está en docs/zeus-contracts.md.

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
  /** Datos para pintar: dev → { role, githubLogin, online }, runner → { online, devId }, project → { key, color }, resource → { type, url }. */
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

export interface ZeusNodeDetail extends ZeusNodeSummary {
  body: string;
  sourceRepo: string | null;
  sourcePath: string | null;
  meta: Record<string, unknown>;
  /** Aristas que tocan al nodo, con el título del otro extremo ya resuelto. */
  edges: Array<ZeusGraphEdge & { otherRef: ZeusRef; otherTitle: string; otherKind: ZeusGraphKind; direction: 'out' | 'in' }>;
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
  zeusAdmin: boolean;
  /** Claves de los proyectos donde está asignado. */
  projects: string[];
  skills: string[];
  /** Tiene un runner latiendo ahora. */
  online: boolean;
}

export interface ZeusOrg {
  members: ZeusOrgMember[];
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

// ---------------------------------------------------------------- bandeja

export type ZeusRequestKind = 'access' | 'permission' | 'review' | 'change' | 'other';
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

export interface ZeusMessage {
  id: string;
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
}

export interface ZeusInbox {
  messages: ZeusMessage[];
  /** Mensajes que yo envié (los más recientes). */
  sent: ZeusMessage[];
  /** Solicitudes que me toca resolver. */
  toResolve: ZeusRequest[];
  /** Solicitudes que yo abrí. */
  mine: ZeusRequest[];
  unread: number;
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

// ---------------------------------------------------------------- bóveda

export interface ZeusVaultKey {
  id: string;
  devId: string;
  devName: string;
  /** Solo en el listado de admin (`?all=1`), para dar acceso buscando por correo. */
  devEmail?: string | null;
  name: string;
  publicKey: string;
  fingerprint: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ZeusVaultEnvSummary {
  id: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  name: string;
  dekVersion: number;
  /** Solo NOMBRES: los valores nunca pasan por el back en claro. */
  secrets: Array<{ name: string; version: number; updatedAt: string; updatedByName: string | null; stale: boolean }>;
  /** Equipos con acceso vigente a la DEK actual. */
  grants: Array<{ keyId: string; devId: string; devName: string; keyName: string; fingerprint: string; grantedAt: string }>;
  /** Hay accesos revocados desde la última rotación: conviene rotar la llave del entorno. */
  needsRotation: boolean;
}

export interface ZeusVaultOverview {
  envs: ZeusVaultEnvSummary[];
  keys: ZeusVaultKey[];
  audit: Array<{ id: number; at: string; devName: string | null; action: string; envLabel: string | null; detail: Record<string, unknown> }>;
}

// ---------------------------------------------------------------- paquete de contexto del plan

export interface ZeusContextPackItem {
  ref: ZeusRef;
  kind: ZeusNodeKind;
  title: string;
  summary: string;
  /** Por qué entró: 'fijado' | 'coincide' | 'diseño' | 'regla'. */
  why: string;
}

export interface ZeusContextPack {
  generatedAt: string;
  query: string;
  items: ZeusContextPackItem[];
}
