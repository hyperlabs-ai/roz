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
      },
    },
  );
  return data.issueCreate.issue;
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
