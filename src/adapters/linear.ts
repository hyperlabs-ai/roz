// Linear (roz v2): cliente GraphQL y verificación del webhook. Aquí solo vive el TRANSPORTE; qué
// issue se crea, cómo se mapea a roz y el espejo en work_item viven en src/linear.
//
// `fetch` directo y no @linear/sdk, por las mismas razones que src/adapters/typesafe.ts:
//   · Controlamos exactamente qué campos se piden (un solo fragmento de issue para crear, actualizar
//     y reconciliar → el espejo siempre recibe la misma forma).
//   · Los reintentos los decide el outbox (backoff, dead-letter): aquí no se reintenta, solo se dice
//     si el error es reintentable.
//
// Un error de la API es un ERROR, nunca una respuesta vacía: "Linear no contestó" no es "no hay
// issues", y una reconciliación que lo confundiera daría por buenos datos viejos.
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { secureEqual } from '../utils/secure-compare.js';
import type { LinearPriority, LinearStateType } from '../types/roz-v2.js';

// ---------------------------------------------------------------- tipos

export interface LinearUserRef {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
}

export interface LinearCycle {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
  /** 0-1 */
  progress: number;
}

/** Un issue tal como lo pide el fragmento ISSUE_FIELDS. Es lo que recibe upsertMirrorFromLinear. */
export interface LinearIssue {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description: string | null;
  url: string;
  priority: LinearPriority;
  estimate: number | null;
  dueDate: string | null;
  branchName: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  archivedAt: string | null;
  state: { id: string; name: string; type: LinearStateType };
  assignee: LinearUserRef | null;
  creator: LinearUserRef | null;
  team: { id: string; key: string; name: string };
  project: { id: string; name: string } | null;
  labels: { id: string; name: string }[];
  cycle: LinearCycle | null;
}

export interface LinearComment {
  id: string;
  body: string;
  url: string | null;
  createdAt: string;
}

export interface LinearUser {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  active: boolean;
  avatarUrl: string | null;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: LinearStateType;
  position: number;
  teamId: string;
}

export interface LinearLabel {
  id: string;
  name: string;
  color: string | null;
  /** null = etiqueta del workspace (no de un equipo). */
  teamId: string | null;
}

export interface LinearProject {
  id: string;
  name: string;
  state: string | null;
  teamIds: string[];
}

export interface LinearIssueCreateInput {
  teamId: string;
  title: string;
  description?: string | null;
  projectId?: string | null;
  labelIds?: string[];
  estimate?: number | null;
  /** 1 urgente … 4 baja (0 = sin prioridad). */
  priority?: LinearPriority | null;
  assigneeId?: string | null;
  stateId?: string | null;
  dueDate?: string | null;
}

export interface LinearIssueUpdateInput {
  /** null = quitar asignado. undefined = no tocar. */
  assigneeId?: string | null;
  stateId?: string;
}

// ---------------------------------------------------------------- errores

export class LinearError extends Error {
  /** HTTP status; null = no hubo respuesta (red, timeout) o la respuesta no se pudo leer. */
  readonly status: number | null;
  /** true = vale la pena reintentar más tarde (rate limit, 5xx, red, timeout). */
  readonly retryable: boolean;
  /** Segundos que pidió la API antes de reintentar (rate limit), si los mandó. */
  readonly retryAfterSec: number | null;
  /** `extensions.code` del error GraphQL (RATELIMITED, AUTHENTICATION_ERROR, …) o código propio. */
  readonly code: string | null;
  /** Lo que devolvió la API como explicación, para el log del evento. */
  readonly detail: unknown;

  constructor(
    message: string,
    opts: { status: number | null; retryable: boolean; retryAfterSec?: number | null; code?: string | null; detail?: unknown },
  ) {
    super(message);
    this.name = 'LinearError';
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.code = opts.code ?? null;
    this.detail = opts.detail ?? null;
  }
}

const TIMEOUT_MS = 20_000;
const RETRYABLE_GQL_CODES = new Set(['RATELIMITED', 'INTERNAL_SERVER_ERROR']);

export function linearEnabled(): boolean {
  return config.linear.apiKey !== '';
}

/** Llave personal (lin_api_…) va tal cual; un token OAuth va como Bearer. */
function authHeader(key: string): string {
  return key.startsWith('lin_api_') ? key : `Bearer ${key}`;
}

/**
 * Segundos hasta poder reintentar. Linear manda `retry-after` (segundos) o
 * `x-ratelimit-requests-reset` (epoch en ms).
 */
function retryAfterOf(headers: { get(k: string): string | null }): number | null {
  const ra = headers.get('retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const reset = Number(headers.get('x-ratelimit-requests-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, Math.ceil((reset - Date.now()) / 1000));
  return null;
}

interface GqlError {
  message?: string;
  extensions?: { code?: string; type?: string; userPresentableMessage?: string };
}

/** Una llamada GraphQL. Devuelve `data` o lanza LinearError; nunca devuelve datos parciales. */
export async function linearGraphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (!linearEnabled()) {
    throw new LinearError('LINEAR_API_KEY no configurado', { status: null, retryable: false, code: 'not_configured' });
  }

  let res: Response;
  try {
    res = await fetch(config.linear.apiUrl, {
      method: 'POST',
      headers: { authorization: authHeader(config.linear.apiKey), 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new LinearError(timeout ? `Linear no respondió en ${TIMEOUT_MS / 1000}s` : `Linear inalcanzable: ${String(err)}`, {
      status: null,
      retryable: true,
      code: timeout ? 'timeout' : 'network',
    });
  }

  const text = await res.text().catch(() => '');
  type Body = { data?: T | null; errors?: GqlError[] };
  let body: Body | undefined;
  try {
    body = text ? (JSON.parse(text) as Body) : undefined;
  } catch {
    body = undefined;
  }

  const errors = body?.errors ?? [];
  const gqlCode = errors[0]?.extensions?.code ?? null;

  // Linear responde el rate limit como HTTP 400 con code RATELIMITED (y a veces 429).
  if (res.status === 429 || gqlCode === 'RATELIMITED') {
    throw new LinearError('Linear: límite de solicitudes', {
      status: res.status,
      retryable: true,
      retryAfterSec: retryAfterOf(res.headers),
      code: 'RATELIMITED',
      detail: errors.length ? errors : text,
    });
  }

  if (!res.ok) {
    throw new LinearError(`Linear ${res.status}`, {
      status: res.status,
      retryable: res.status >= 500,
      code: gqlCode ?? (res.status === 401 ? 'AUTHENTICATION_ERROR' : null),
      detail: errors.length ? errors : text,
    });
  }

  if (errors.length > 0) {
    const first = errors[0]!;
    throw new LinearError(`Linear: ${first.extensions?.userPresentableMessage ?? first.message ?? 'error GraphQL'}`, {
      status: res.status,
      retryable: gqlCode !== null && RETRYABLE_GQL_CODES.has(gqlCode),
      code: gqlCode,
      detail: errors,
    });
  }

  if (!body || body.data === undefined || body.data === null) {
    // Un 200 sin `data` no se arregla reintentando: es un cambio de contrato.
    throw new LinearError('respuesta_invalida de Linear', { status: res.status, retryable: false, code: 'respuesta_invalida', detail: text });
  }
  return body.data;
}

// ---------------------------------------------------------------- validación de forma

const UserRef = z.object({ id: z.string(), name: z.string(), displayName: z.string().nullish(), email: z.string().nullish() });
const IssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  number: z.number(),
  title: z.string(),
  description: z.string().nullish(),
  url: z.string(),
  priority: z.number().int().min(0).max(4),
  estimate: z.number().nullish(),
  dueDate: z.string().nullish(),
  branchName: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullish(),
  completedAt: z.string().nullish(),
  canceledAt: z.string().nullish(),
  archivedAt: z.string().nullish(),
  state: z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['backlog', 'unstarted', 'started', 'completed', 'canceled', 'triage']),
  }),
  assignee: UserRef.nullish(),
  creator: UserRef.nullish(),
  team: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  project: z.object({ id: z.string(), name: z.string() }).nullish(),
  labels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }).nullish(),
  cycle: z
    .object({
      id: z.string(),
      number: z.number(),
      name: z.string().nullish(),
      startsAt: z.string(),
      endsAt: z.string(),
      progress: z.number(),
    })
    .nullish(),
});

function userRef(u: z.infer<typeof UserRef> | null | undefined): LinearUserRef | null {
  if (!u) return null;
  return { id: u.id!, name: u.name!, displayName: u.displayName ?? null, email: u.email ?? null };
}

/** Normaliza un nodo de issue (nullish → null, labels.nodes → labels). Lanza si la forma no es la esperada. */
export function parseIssue(raw: unknown): LinearIssue {
  const parsed = IssueSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LinearError('respuesta_invalida de Linear (issue)', {
      status: 200,
      retryable: false,
      code: 'respuesta_invalida',
      detail: parsed.error.message,
    });
  }
  // Destructurado + `!`: z.infer puede marcar requeridos como opcionales en el build sin strict.
  const i = parsed.data;
  const state = i.state!;
  const team = i.team!;
  return {
    id: i.id!,
    identifier: i.identifier!,
    number: i.number!,
    title: i.title!,
    description: i.description ?? null,
    url: i.url!,
    priority: i.priority! as LinearPriority,
    estimate: i.estimate ?? null,
    dueDate: i.dueDate ?? null,
    branchName: i.branchName ?? null,
    createdAt: i.createdAt!,
    updatedAt: i.updatedAt!,
    startedAt: i.startedAt ?? null,
    completedAt: i.completedAt ?? null,
    canceledAt: i.canceledAt ?? null,
    archivedAt: i.archivedAt ?? null,
    state: { id: state.id!, name: state.name!, type: state.type! },
    assignee: userRef(i.assignee),
    creator: userRef(i.creator),
    team: { id: team.id!, key: team.key!, name: team.name! },
    project: i.project ? { id: i.project.id!, name: i.project.name! } : null,
    labels: (i.labels?.nodes ?? []).map((l) => ({ id: l.id!, name: l.name! })),
    cycle: i.cycle
      ? {
          id: i.cycle.id!,
          number: i.cycle.number!,
          name: i.cycle.name ?? null,
          startsAt: i.cycle.startsAt!,
          endsAt: i.cycle.endsAt!,
          progress: i.cycle.progress!,
        }
      : null,
  };
}

// ---------------------------------------------------------------- consultas

/** El fragmento ÚNICO de issue: crear, actualizar, leer y reconciliar piden exactamente esto. */
export const ISSUE_FIELDS = `
  id identifier number title description url priority estimate dueDate branchName
  createdAt updatedAt startedAt completedAt canceledAt archivedAt
  state { id name type }
  assignee { id name displayName email }
  creator { id name displayName email }
  team { id key name }
  project { id name }
  labels(first: 50) { nodes { id name } }
  cycle { id number name startsAt endsAt progress }
`;

/** `{ success, <entidad> }` de una mutación de Linear. */
type MutationPayload = { success: boolean } & Record<string, unknown>;

function mutationResult<T>(payload: MutationPayload | null | undefined, key: string, what: string): T {
  if (!payload?.success || !payload[key]) {
    throw new LinearError(`Linear rechazó ${what}`, { status: 200, retryable: false, code: 'mutation_failed', detail: payload ?? null });
  }
  return payload[key] as T;
}

function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function createIssue(input: LinearIssueCreateInput): Promise<LinearIssue> {
  const data = await linearGraphql<{ issueCreate: MutationPayload }>(
    `mutation RozIssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
    }`,
    {
      input: compact({
        teamId: input.teamId,
        title: input.title,
        description: input.description ?? undefined,
        projectId: input.projectId ?? undefined,
        labelIds: input.labelIds && input.labelIds.length > 0 ? input.labelIds : undefined,
        estimate: input.estimate ?? undefined,
        priority: input.priority ?? undefined,
        assigneeId: input.assigneeId ?? undefined,
        stateId: input.stateId ?? undefined,
        dueDate: input.dueDate ?? undefined,
      }),
    },
  );
  return parseIssue(mutationResult(data.issueCreate, 'issue', 'la creación del issue'));
}

export async function updateIssue(id: string, input: LinearIssueUpdateInput): Promise<LinearIssue> {
  const patch = compact({ assigneeId: input.assigneeId, stateId: input.stateId });
  if (Object.keys(patch).length === 0) throw new LinearError('updateIssue sin cambios', { status: null, retryable: false, code: 'sin_cambios' });
  const data = await linearGraphql<{ issueUpdate: MutationPayload }>(
    `mutation RozIssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
    }`,
    { id, input: patch },
  );
  return parseIssue(mutationResult(data.issueUpdate, 'issue', 'la actualización del issue'));
}

export async function createComment(issueId: string, body: string): Promise<LinearComment> {
  const data = await linearGraphql<{ commentCreate: MutationPayload }>(
    `mutation RozCommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { id body url createdAt } }
    }`,
    { input: { issueId, body } },
  );
  const c = mutationResult<{ id: string; body: string; url?: string | null; createdAt: string }>(data.commentCreate, 'comment', 'el comentario');
  return { id: c.id, body: c.body, url: c.url ?? null, createdAt: c.createdAt };
}

/** Un issue por id o por identificador ("HYP-123"). null si no existe. */
export async function getIssue(idOrIdentifier: string): Promise<LinearIssue | null> {
  try {
    const data = await linearGraphql<{ issue: unknown }>(`query RozIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, {
      id: idOrIdentifier,
    });
    return data.issue ? parseIssue(data.issue) : null;
  } catch (err) {
    // Linear contesta "Entity not found" como error GraphQL; para quien llama eso es "no existe".
    if (err instanceof LinearError && !err.retryable && /not found/i.test(err.message)) return null;
    throw err;
  }
}

interface Page<N> {
  nodes: N[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * Recorre todas las páginas de una conexión. `pick` saca la conexión de `data`. Corta en `maxPages`
 * y lo dice (`truncated`): una reconciliación incompleta tiene que saber que lo fue.
 */
async function paginate<N>(
  query: string,
  variables: Record<string, unknown>,
  pick: (data: Record<string, unknown>) => Page<N>,
  maxPages: number,
): Promise<{ nodes: N[]; truncated: boolean }> {
  const nodes: N[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await linearGraphql<Record<string, unknown>>(query, { ...variables, after });
    const conn = pick(data);
    nodes.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return { nodes, truncated: false };
    after = conn.pageInfo.endCursor;
  }
  return { nodes, truncated: true };
}

/**
 * Issues actualizados DESPUÉS de `since` (ISO), del más viejo al más nuevo, incluidos archivados
 * (un issue archivado tiene que salir del espejo). `teamId` opcional limita a un equipo.
 */
export async function issuesUpdatedSince(
  since: string,
  opts: { teamId?: string | null; pageSize?: number; maxPages?: number } = {},
): Promise<{ issues: LinearIssue[]; truncated: boolean }> {
  const filter: Record<string, unknown> = { updatedAt: { gt: since } };
  if (opts.teamId) filter.team = { id: { eq: opts.teamId } };
  const { nodes, truncated } = await paginate<unknown>(
    `query RozIssuesSince($filter: IssueFilter, $first: Int!, $after: String) {
      issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt, includeArchived: true) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { filter, first: opts.pageSize ?? 50 },
    (d) => d.issues as Page<unknown>,
    opts.maxPages ?? 20,
  );
  const issues = nodes.map(parseIssue).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return { issues, truncated };
}

export async function viewer(): Promise<LinearUserRef & { organization: { id: string; name: string; urlKey: string } | null }> {
  const data = await linearGraphql<{
    viewer: { id: string; name: string; displayName?: string | null; email?: string | null; organization?: { id: string; name: string; urlKey: string } | null };
  }>(`query RozViewer { viewer { id name displayName email organization { id name urlKey } } }`);
  const v = data.viewer;
  return { id: v.id, name: v.name, displayName: v.displayName ?? null, email: v.email ?? null, organization: v.organization ?? null };
}

export async function listUsers(): Promise<LinearUser[]> {
  const { nodes } = await paginate<{ id: string; name: string; displayName?: string | null; email?: string | null; active?: boolean; avatarUrl?: string | null }>(
    `query RozUsers($first: Int!, $after: String) {
      users(first: $first, after: $after, includeDisabled: true) {
        nodes { id name displayName email active avatarUrl }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { first: 100 },
    (d) => d.users as Page<never>,
    10,
  );
  return nodes.map((u) => ({
    id: u.id,
    name: u.name,
    displayName: u.displayName ?? null,
    email: u.email ? u.email.toLowerCase() : null,
    active: u.active ?? true,
    avatarUrl: u.avatarUrl ?? null,
  }));
}

export async function listTeams(): Promise<LinearTeam[]> {
  const { nodes } = await paginate<LinearTeam>(
    `query RozTeams($first: Int!, $after: String) {
      teams(first: $first, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } }
    }`,
    { first: 100 },
    (d) => d.teams as Page<LinearTeam>,
    5,
  );
  return nodes.map((t) => ({ id: t.id, key: t.key, name: t.name }));
}

export async function listWorkflowStates(teamId?: string | null): Promise<LinearWorkflowState[]> {
  const { nodes } = await paginate<{ id: string; name: string; type: LinearStateType; position: number; team: { id: string } }>(
    `query RozStates($filter: WorkflowStateFilter, $first: Int!, $after: String) {
      workflowStates(filter: $filter, first: $first, after: $after) {
        nodes { id name type position team { id } }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { filter: teamId ? { team: { id: { eq: teamId } } } : null, first: 100 },
    (d) => d.workflowStates as Page<never>,
    5,
  );
  return nodes.map((s) => ({ id: s.id, name: s.name, type: s.type, position: s.position, teamId: s.team.id }));
}

export async function listLabels(teamId?: string | null): Promise<LinearLabel[]> {
  const { nodes } = await paginate<{ id: string; name: string; color?: string | null; team?: { id: string } | null }>(
    `query RozLabels($filter: IssueLabelFilter, $first: Int!, $after: String) {
      issueLabels(filter: $filter, first: $first, after: $after) {
        nodes { id name color team { id } }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    // Las del equipo Y las del workspace (team null) sirven para issues de ese equipo.
    { filter: teamId ? { or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] } : null, first: 250 },
    (d) => d.issueLabels as Page<never>,
    5,
  );
  return nodes.map((l) => ({ id: l.id, name: l.name, color: l.color ?? null, teamId: l.team?.id ?? null }));
}

export async function listProjects(): Promise<LinearProject[]> {
  const { nodes } = await paginate<{ id: string; name: string; state?: string | null; teams?: { nodes: { id: string }[] } | null }>(
    `query RozProjects($first: Int!, $after: String) {
      projects(first: $first, after: $after) {
        nodes { id name state teams { nodes { id } } }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { first: 100 },
    (d) => d.projects as Page<never>,
    10,
  );
  return nodes.map((p) => ({ id: p.id, name: p.name, state: p.state ?? null, teamIds: (p.teams?.nodes ?? []).map((t) => t.id) }));
}

// ---------------------------------------------------------------- webhook

/** Ventana de frescura del webhook (anti-replay): Linear recomienda 60 s sobre webhookTimestamp. */
export const LINEAR_WEBHOOK_TOLERANCE_MS = 60_000;

/**
 * Linear: header `linear-signature: <hex>` = HMAC-SHA256(cuerpo crudo, signing secret). Se verifica
 * sobre el cuerpo CRUDO, antes de parsear JSON, y en tiempo constante. Sin secreto → false (cerrado).
 */
export function verifyLinearSignature(rawBody: string, signature: string | null | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
  return secureEqual(digest, signature.trim().toLowerCase());
}

/**
 * ¿El webhook es reciente? `webhookTimestamp` (ms epoch, dentro del cuerpo firmado) a no más de
 * `toleranceMs` de ahora. Una firma válida con timestamp viejo es una repetición: se rechaza.
 */
export function isFreshLinearWebhook(webhookTimestamp: unknown, now = Date.now(), toleranceMs = LINEAR_WEBHOOK_TOLERANCE_MS): boolean {
  const ts = typeof webhookTimestamp === 'string' ? Number(webhookTimestamp) : webhookTimestamp;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return false;
  return Math.abs(now - ts) <= toleranceMs;
}
