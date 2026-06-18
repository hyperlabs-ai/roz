// Reconciliación de commits [fase 5]. Por cada commit de GitHub:
//  1. ¿referencia un issue de Linear (ABC-123)? → la integración nativa Linear↔GitHub ya lo
//     enlaza; roz solo marca el work_item como documentado. No duplica.
//  2. Si no → trabajo HUÉRFANO. Una sola pasada de Claude clasifica (trivial vs sustantivo) y,
//     contra los issues ABIERTOS del proyecto, decide si el commit RESUELVE alguno (dedup
//     semántico por razonamiento, sin infra de embeddings).
//  3. Trivial → se ignora. Sustantivo que resuelve un issue → se enlaza. Sustantivo SIN match
//     → roz crea un issue en Linear documentando el trabajo (para que todo quede registrado).
//  4. Idempotencia por sha (claimOnce) — cada commit se procesa una sola vez.
import { db } from '../db/supabase.js';
import { complete } from '../adapters/anthropic.js';
import { getCommit, referencesLinearIssue, type CommitMeta } from '../adapters/github.js';
import { createIssue, priorityToLinear, resolveInitialStateId } from '../adapters/linear.js';
import { claimOnce, releaseOnce } from '../events/outbox.js';
import { resolveProjectByRepo } from '../projects/resolve.js';

export interface ReconcileInput {
  repo: string; // "owner/name"
  sha: string;
  /** Para pruebas: si se pasa, no se consulta la API de GitHub. */
  commit?: CommitMeta;
}

export interface ReconcileResult {
  action:
    | 'skipped:already-processed'
    | 'linked' // referencia un issue de Linear
    | 'trivial' // chore/merge/lint: se ignora
    | 'matched' // resuelve un issue abierto → enlazado
    | 'documented' // trabajo sustantivo huérfano → issue creado
    | 'orphan:no-project' // repo sin proyecto mapeado y sin team para crear
    ;
  identifier?: string;
  detail?: string;
}

interface CommitAnalysis {
  category: 'trivial' | 'substantive';
  matchedIdentifier: string | null; // issue abierto que el commit resuelve, o null
  title: string; // título sugerido si hay que documentarlo
  summary: string; // resumen del cambio (markdown)
  kind: string;
  priority: string;
}

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

export async function reconcileCommit(input: ReconcileInput): Promise<ReconcileResult> {
  const supabase = db();
  const claimKey = `commit:${input.repo}:${input.sha}`;

  // Exactamente-una-vez por commit. La llave se reclama ANTES del trabajo para no procesar
  // el mismo commit dos veces; pero si algo falla ANTES de crear el issue en Linear, se
  // LIBERA (releaseOnce) para que el reintento del outbox vuelva a intentarlo. Una vez creado
  // el issue (efecto no idempotente), ya no se libera: el espejo posterior es best-effort.
  const first = await claimOnce(claimKey, 'commit');
  if (!first) return { action: 'skipped:already-processed' };

  const state = { issueCreated: false };
  try {
    const commit = input.commit ?? (await getCommit(input.repo, input.sha));
    return await reconcileBody(input, supabase, commit, state);
  } catch (err) {
    if (!state.issueCreated) await releaseOnce(claimKey).catch(() => {});
    throw err;
  }
}

async function reconcileBody(
  input: ReconcileInput,
  supabase: ReturnType<typeof db>,
  commit: CommitMeta,
  state: { issueCreated: boolean },
): Promise<ReconcileResult> {
  // Resolver proyecto y dev autor una sola vez: se usan para persistir el commit (dashboard) y,
  // en el camino huérfano, para asignar el issue resultante.
  const project = await resolveProjectByRepo(input.repo);
  const dev = await resolveDevByCommit(supabase, commit);

  // Persistir el commit SIEMPRE (linked/trivial/matched/documented): el dashboard cuenta todo el
  // trabajo, no solo el huérfano. Upsert por (repo, sha) → reprocesar es idempotente.
  await persistCommit(supabase, input, commit, project?.id ?? null, dev?.id ?? null);

  // 1. ¿Referencia un issue de Linear? La integración nativa lo enlaza; roz documenta.
  const linked = referencesLinearIssue(commit.message);
  if (linked) {
    await supabase
      .from('work_item')
      .update({ documented: true })
      .eq('identifier', linked); // best-effort; columna opcional
    return { action: 'linked', identifier: linked, detail: 'enlazado por la integración nativa' };
  }

  // Issues ABIERTOS del proyecto (candidatos a que el commit los resuelva).
  const openItems = project
    ? (
        await supabase
          .from('work_item')
          .select('identifier, title, spec')
          .eq('project_id', project.id)
          .not('state', 'in', '("completed","canceled")')
          .limit(40)
      ).data ?? []
    : [];

  // 3. Una sola pasada de Claude: clasifica + intenta hacer match contra los abiertos.
  const openList = openItems.length
    ? openItems.map((i: any) => `- ${i.identifier}: ${i.title}`).join('\n')
    : '(no hay issues abiertos)';
  const raw = await complete({
    system:
      'Eres roz, reconciliando un commit de GitHub que NO referencia ningún issue. Decide:\n' +
      '- "category": "trivial" (merge, lint, formato, bump de versión, typo, comentarios) o ' +
      '"substantive" (cambia comportamiento, agrega/arregla algo real).\n' +
      '- "matchedIdentifier": si el commit claramente RESUELVE uno de los issues abiertos ' +
      'listados, su identificador (p.ej. "ROZ-12"); si no, null.\n' +
      '- Si es substantive y SIN match, propón "title" (corto), "summary" (markdown: qué cambió ' +
      'y por qué, según el mensaje), "kind" ∈ [feature,bug,chore,refactor], "priority" ∈ ' +
      '[urgent,high,medium,low].\n' +
      'Responde SOLO JSON: {"category":"","matchedIdentifier":null,"title":"","summary":"","kind":"","priority":""}.',
    user:
      `Repo: ${input.repo}\nProyecto: ${project?.name ?? '(sin mapear)'}\n\n` +
      `Commit ${commit.sha.slice(0, 8)} por ${commit.author ?? 'desconocido'}:\n${commit.message}\n\n` +
      `Issues abiertos del proyecto:\n${openList}`,
    maxTokens: 800,
  });

  const a = (extractJson(raw) ?? {}) as Partial<CommitAnalysis>;
  const category = a.category === 'substantive' ? 'substantive' : 'trivial';

  if (category === 'trivial') {
    return { action: 'trivial', detail: 'commit trivial, no se documenta' };
  }

  // 4a. Sustantivo que resuelve un issue abierto → enlazar (sin duplicar).
  const matched = a.matchedIdentifier && openItems.find((i: any) => i.identifier === a.matchedIdentifier);
  if (matched) {
    await supabase
      .from('work_item')
      .update({ documented: true })
      .eq('identifier', a.matchedIdentifier!);
    return {
      action: 'matched',
      identifier: a.matchedIdentifier!,
      detail: 'el commit resuelve un issue abierto existente',
    };
  }

  // 4b. Sustantivo huérfano sin match → documentar creando un issue en Linear.
  if (!project?.linear_team_id) {
    return {
      action: 'orphan:no-project',
      detail: `repo ${input.repo} sin proyecto/team mapeado; no se puede crear issue`,
    };
  }

  const title = (a.title || commit.message.split('\n')[0] || 'Trabajo desde commit').slice(0, 120);
  const description =
    `> 🔗 **Auto-documentado desde un commit** (sin issue previo)\n` +
    `> Repo \`${input.repo}\` · commit [\`${commit.sha.slice(0, 8)}\`](${commit.url})` +
    (commit.author ? ` · autor: ${commit.author}` : '') +
    `\n\n${a.summary || commit.message}`;

  // Autor del commit → dev (resuelto arriba) → su linear_user_id para asignar el issue.
  const assigneeId = dev?.linear_user_id ?? undefined;

  const stateId = await resolveInitialStateId(project.linear_team_id);
  const issue = await createIssue({
    teamId: project.linear_team_id,
    projectId: project.linear_project_id ?? undefined,
    title,
    description,
    assigneeId,
    priority: priorityToLinear(a.priority),
    stateId: stateId ?? undefined,
  });
  // A partir de aquí el issue YA existe en Linear: no liberar la llave (evita duplicados).
  state.issueCreated = true;

  // Espejo (upsert por linear_id; idempotente con el webhook eventual). Best-effort: si falla,
  // el webhook de Linear creará/actualizará el espejo igualmente — no re-crear el issue.
  await supabase.from('work_item').upsert(
    {
      linear_id: issue.id,
      identifier: issue.identifier,
      project_id: project.id,
      title,
      spec: description,
      state: 'unstarted',
      priority: a.priority ?? null,
      documented: true,
      url: issue.url,
    },
    { onConflict: 'linear_id' },
  ); // se ignora el error: el issue ya existe; el webhook reconciliará el espejo.

  return { action: 'documented', identifier: issue.identifier, detail: 'issue creado desde commit huérfano' };
}

/** Resuelve el dev autor de un commit: por email de git (preferente) y luego por login. */
async function resolveDevByCommit(
  supabase: ReturnType<typeof db>,
  commit: CommitMeta,
): Promise<{ id: string; linear_user_id: string | null } | null> {
  if (commit.authorEmail) {
    const { data } = await supabase
      .from('dev')
      .select('id, linear_user_id')
      .eq('github_email', commit.authorEmail)
      .maybeSingle();
    if (data) return data as { id: string; linear_user_id: string | null };
  }
  if (commit.author) {
    const { data } = await supabase
      .from('dev')
      .select('id, linear_user_id')
      .eq('github_login', commit.author)
      .maybeSingle();
    if (data) return data as { id: string; linear_user_id: string | null };
  }
  return null;
}

/**
 * Persiste el commit para las métricas del dashboard. Upsert por (repo, sha): reprocesar el
 * mismo commit es idempotente. Best-effort — un fallo aquí no debe tumbar la reconciliación,
 * pero lo dejamos propagar para que el outbox reintente (la llave se libera si no hubo issue).
 */
async function persistCommit(
  supabase: ReturnType<typeof db>,
  input: ReconcileInput,
  commit: CommitMeta,
  projectId: string | null,
  devId: string | null,
): Promise<void> {
  await supabase.from('commit').upsert(
    {
      sha: commit.sha,
      repo: input.repo,
      project_id: projectId,
      dev_id: devId,
      author_login: commit.author,
      author_email: commit.authorEmail,
      message: commit.message,
      url: commit.url,
      additions: commit.additions,
      deletions: commit.deletions,
      committed_at: commit.committedAt,
    },
    { onConflict: 'repo,sha' },
  );
}
