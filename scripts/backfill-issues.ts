// Backfill de issues de Linear → roz.work_item. Pagina todos los issues del workspace y hace
// upsert por linear_id, resolviendo proyecto (por linear_project_id) y assignee (por
// linear_user_id). Idempotente: re-correr es seguro. NO toca commits ni GitHub.
//
// Uso:  npx tsx scripts/backfill-issues.ts
import 'dotenv/config';
import { config } from '../src/config.js';
import { db } from '../src/db/supabase.js';
import { linearToPriority } from '../src/adapters/linear.js';

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: config.linear.apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? res.statusText));
  return json.data as T;
}

const ISSUE_FIELDS = `
  id identifier number title description priority estimate dueDate url
  createdAt updatedAt startedAt completedAt canceledAt
  state { name type }
  assignee { id }
  creator { displayName }
  project { id }
  labels { nodes { name } }
`;

async function main() {
  const supabase = db();

  // Mapas de resolución: linear_project_id → roz.project.id ; linear_user_id → roz.dev.id
  const { data: projects } = await supabase.from('project').select('id, linear_project_id');
  const projByLinear = new Map((projects ?? []).filter((p: any) => p.linear_project_id).map((p: any) => [p.linear_project_id, p.id]));
  const { data: devs } = await supabase.from('dev').select('id, linear_user_id');
  const devByLinear = new Map((devs ?? []).filter((d: any) => d.linear_user_id).map((d: any) => [d.linear_user_id, d.id]));

  let after: string | null = null;
  let total = 0;
  let withProject = 0;
  let withAssignee = 0;

  for (let page = 0; page < 50; page++) {
    const data: any = await gql(
      `query Issues($after: String) {
        issues(first: 100, after: $after, orderBy: createdAt) {
          pageInfo { hasNextPage endCursor }
          nodes { ${ISSUE_FIELDS} }
        }
      }`,
      { after },
    );
    const nodes = data.issues.nodes as any[];
    for (const i of nodes) {
      const projectId = i.project?.id ? projByLinear.get(i.project.id) ?? null : null;
      const assigneeDevId = i.assignee?.id ? devByLinear.get(i.assignee.id) ?? null : null;
      if (projectId) withProject++;
      if (assigneeDevId) withAssignee++;

      await supabase.from('work_item').upsert(
        {
          linear_id: i.id,
          identifier: i.identifier,
          number: i.number,
          title: i.title ?? '(sin título)',
          spec: i.description ?? null,
          project_id: projectId,
          assignee_dev_id: assigneeDevId,
          state: i.state?.type ?? 'backlog',
          state_name: i.state?.name ?? null,
          priority: linearToPriority(i.priority),
          estimate: i.estimate ?? null,
          due_date: i.dueDate ?? null,
          labels: (i.labels?.nodes ?? []).map((l: any) => l.name),
          creator_name: i.creator?.displayName ?? null,
          url: i.url ?? null,
          started_at: i.startedAt ?? null,
          completed_at: i.completedAt ?? null,
          canceled_at: i.canceledAt ?? null,
          linear_created_at: i.createdAt ?? null,
          linear_updated_at: i.updatedAt ?? null,
        },
        { onConflict: 'linear_id' },
      );
      total++;
    }
    if (!data.issues.pageInfo.hasNextPage) break;
    after = data.issues.pageInfo.endCursor;
  }

  console.log(`Backfill issues: ${total} | con proyecto: ${withProject} | con assignee: ${withAssignee}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
