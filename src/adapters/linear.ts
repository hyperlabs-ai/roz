// Linear = fuente de verdad del trabajo. roz consume la API GraphQL directa (afuera =
// API directa). Crea issues ya asignados y lee carga (issues `in progress` por dev).
import { config } from '../config.js';

const ENDPOINT = 'https://api.linear.app/graphql';

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: config.linear.apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || json.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(json.errors ?? res.statusText)}`);
  }
  return json.data as T;
}

export interface CreateIssueInput {
  teamId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  /** Prioridad nativa de Linear: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority?: number;
  /** Estado en el que se crea (workflow state id). Si se omite, Linear usa el default del team. */
  stateId?: string;
}

export interface WorkflowState {
  id: string;
  name: string;
  type: string; // triage | backlog | unstarted | started | completed | canceled
}

// Cache simple por team (los estados casi no cambian). Vive lo que dure la función serverless.
const stateCache = new Map<string, WorkflowState[]>();

export async function getTeamStates(teamId: string): Promise<WorkflowState[]> {
  const cached = stateCache.get(teamId);
  if (cached) return cached;
  const data = await gql<{ team: { states: { nodes: WorkflowState[] } } }>(
    `query States($id: String!) { team(id: $id) { states { nodes { id name type } } } }`,
    { id: teamId },
  );
  const states = data.team.states.nodes;
  stateCache.set(teamId, states);
  return states;
}

/**
 * Resuelve el id del estado destino para issues nuevos. `targetType` por defecto 'unstarted'
 * (Todo). Si el team no tiene ese tipo, cae a backlog. Devuelve null → Linear usa su default.
 */
export async function resolveInitialStateId(
  teamId: string,
  targetType = 'unstarted',
): Promise<string | null> {
  try {
    const states = await getTeamStates(teamId);
    const match = states.find((s) => s.type === targetType) ?? states.find((s) => s.type === 'backlog');
    return match?.id ?? null;
  } catch {
    return null; // ante cualquier error, dejar el default del team
  }
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

/** Equipos del workspace — fuente del selector de proyectos. */
export async function listTeams(): Promise<LinearTeam[]> {
  const data = await gql<{ teams: { nodes: LinearTeam[] } }>(
    `query { teams { nodes { id key name } } }`,
  );
  return data.teams.nodes;
}

const PRIORITY_TO_LINEAR: Record<string, number> = { urgent: 1, high: 2, medium: 3, low: 4 };
export function priorityToLinear(p?: string): number {
  return p ? (PRIORITY_TO_LINEAR[p] ?? 0) : 0;
}

const LINEAR_TO_PRIORITY: Record<number, string | null> = {
  0: null, // none
  1: 'urgent',
  2: 'high',
  3: 'medium',
  4: 'low',
};
export function linearToPriority(n?: number | null): string | null {
  return n == null ? null : (LINEAR_TO_PRIORITY[n] ?? null);
}

export interface LinearIssue {
  id: string;
  identifier: string; // ROZ-123
  url: string;
}

export async function createIssue(input: CreateIssueInput): Promise<LinearIssue> {
  const data = await gql<{ issueCreate: { issue: LinearIssue } }>(
    `mutation Create($input: IssueCreateInput!) {
       issueCreate(input: $input) { issue { id identifier url } }
     }`,
    {
      input: {
        teamId: input.teamId,
        title: input.title,
        description: input.description,
        assigneeId: input.assigneeId,
        priority: input.priority,
        stateId: input.stateId,
      },
    },
  );
  return data.issueCreate.issue;
}

export interface LinearMember {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  active: boolean;
}

/** Miembros del workspace de Linear (la fuente de verdad de quién es quién). */
export async function listUsers(): Promise<LinearMember[]> {
  const data = await gql<{ users: { nodes: LinearMember[] } }>(
    `query { users(filter: { active: { eq: true } }) {
       nodes { id name displayName email active }
     } }`,
  );
  return data.users.nodes;
}

/** Carga derivada: nº de issues `in progress` (startedAt no nulo, no completados) por assignee. */
export async function inProgressCountByAssignee(assigneeId: string): Promise<number> {
  const data = await gql<{ issues: { nodes: unknown[] } }>(
    `query Load($assigneeId: ID!) {
       issues(filter: { assignee: { id: { eq: $assigneeId } }, state: { type: { eq: "started" } } }) {
         nodes { id }
       }
     }`,
    { assigneeId },
  );
  return data.issues.nodes.length;
}
