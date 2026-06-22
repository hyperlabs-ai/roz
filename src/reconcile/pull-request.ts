// Reconciliación de Pull Requests mergeadas. roz documenta el trabajo POR PR (no por commit):
//  · Un solo ticket por PR (idempotente por nº de PR) → mata la duplicación rama+squash.
//  · Atribución completa: quién commiteó (autor real), quién revisó (y su estado) y quién mergeó.
//    Se asigna al autor; revisor/merger se guardan en work_item_actor (consultable) + columnas
//    de conveniencia.
//
// Misma filosofía que reconcile/commits.ts: si la PR referencia un issue de Linear, la
// integración nativa ya enlaza (roz solo marca documentado); si no, Claude clasifica
// (trivial/sustantivo) y decide si resuelve un issue abierto antes de crear uno nuevo.
import { db } from '../db/supabase.js';
import { complete } from '../adapters/anthropic.js';
import {
  getPullRequest,
  listPullRequestCommits,
  listPullRequestReviews,
  referencesLinearIssue,
  type PrAuthor,
  type PrReview,
} from '../adapters/github.js';
import { createIssue, priorityToLinear, resolveInitialStateId } from '../adapters/linear.js';
import { claimOnce, releaseOnce, emit } from '../events/outbox.js';
import { resolveProjectByRepo } from '../projects/resolve.js';

export interface ReconcilePrInput {
  repo: string; // "owner/name"
  number: number;
}

export interface ReconcilePrResult {
  action:
    | 'skipped:already-processed'
    | 'not-merged'
    | 'linked' // la PR referencia un issue de Linear
    | 'trivial'
    | 'matched' // resuelve un issue abierto → enlazado
    | 'documented' // trabajo sustantivo → issue creado con atribución
    | 'orphan:no-project';
  identifier?: string;
  detail?: string;
}

interface PrAnalysis {
  category: 'trivial' | 'substantive';
  matchedIdentifier: string | null;
  title: string;
  summary: string;
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

export async function reconcilePullRequest(input: ReconcilePrInput): Promise<ReconcilePrResult> {
  const supabase = db();
  const claimKey = `pr:${input.repo}:${input.number}`;

  // Exactamente-una-vez por PR. Se libera si algo falla ANTES de crear el issue (efecto no
  // idempotente); una vez creado, no se libera (el espejo posterior es best-effort).
  const first = await claimOnce(claimKey, 'pr');
  if (!first) return { action: 'skipped:already-processed' };

  const state = { issueCreated: false };
  try {
    return await reconcileBody(input, supabase, state);
  } catch (err) {
    if (!state.issueCreated) await releaseOnce(claimKey).catch(() => {});
    throw err;
  }
}

async function reconcileBody(
  input: ReconcilePrInput,
  supabase: ReturnType<typeof db>,
  state: { issueCreated: boolean },
): Promise<ReconcilePrResult> {
  const pr = await getPullRequest(input.repo, input.number);
  if (!pr.merged) return { action: 'not-merged', detail: `PR #${input.number} no está mergeada` };

  const project = await resolveProjectByRepo(input.repo);

  // 1. ¿La PR referencia un issue de Linear (rama "feat/HYP-12", título o cuerpo)? La integración
  //    nativa Linear↔GitHub ya lo enlaza; roz solo marca documentado, no duplica.
  const linked = referencesLinearIssue(`${pr.title}\n${pr.body ?? ''}\n${pr.headRef ?? ''}`);
  if (linked) {
    await supabase.from('work_item').update({ documented: true }).eq('identifier', linked);
    return { action: 'linked', identifier: linked, detail: 'enlazado por la integración nativa' };
  }

  // Autores reales (commits) y revisores de la PR.
  const [authors, reviews] = await Promise.all([
    listPullRequestCommits(input.repo, input.number).catch(() => [] as PrAuthor[]),
    listPullRequestReviews(input.repo, input.number).catch(() => [] as PrReview[]),
  ]);

  // Issues ABIERTOS del proyecto (candidatos a que la PR los resuelva).
  const openItems = project
    ? (
        await supabase
          .from('work_item')
          .select('identifier, title')
          .eq('project_id', project.id)
          .not('state', 'in', '("completed","canceled")')
          .limit(40)
      ).data ?? []
    : [];

  // 2. Una sola pasada de Claude: clasifica + intenta match contra los abiertos.
  const openList = openItems.length
    ? openItems.map((i: any) => `- ${i.identifier}: ${i.title}`).join('\n')
    : '(no hay issues abiertos)';
  const authorList = authors.map((a) => a.login ?? a.email ?? '?').join(', ') || pr.authorLogin || 'desconocido';
  const raw = await complete({
    system:
      'Eres roz, reconciliando una Pull Request YA MERGEADA que NO referencia ningún issue de ' +
      'Linear. Decide:\n' +
      '- "category": "trivial" (merge, lint, formato, bump de versión, typo, comentarios) o ' +
      '"substantive" (cambia comportamiento, agrega/arregla algo real).\n' +
      '- "matchedIdentifier": si la PR claramente RESUELVE uno de los issues abiertos listados, ' +
      'su identificador (p.ej. "HYP-12"); si no, null.\n' +
      '- Si es substantive y SIN match, propón "title" (corto), "summary" (markdown: qué cambió ' +
      'y por qué), "kind" ∈ [feature,bug,chore,refactor], "priority" ∈ [urgent,high,medium,low].\n' +
      'Responde SOLO JSON: {"category":"","matchedIdentifier":null,"title":"","summary":"","kind":"","priority":""}.',
    user:
      `Repo: ${input.repo}\nProyecto: ${project?.name ?? '(sin mapear)'}\n\n` +
      `PR #${pr.number}: ${pr.title}\nAutores: ${authorList}\n\n${pr.body ?? '(sin descripción)'}\n\n` +
      `Issues abiertos del proyecto:\n${openList}`,
    maxTokens: 800,
  });

  const a = (extractJson(raw) ?? {}) as Partial<PrAnalysis>;
  const category = a.category === 'substantive' ? 'substantive' : 'trivial';

  if (category === 'trivial') {
    return { action: 'trivial', detail: 'PR trivial, no se documenta' };
  }

  // 3a. Sustantivo que resuelve un issue abierto → enlazar (sin duplicar).
  const matched = a.matchedIdentifier && openItems.find((i: any) => i.identifier === a.matchedIdentifier);
  if (matched) {
    await supabase.from('work_item').update({ documented: true }).eq('identifier', a.matchedIdentifier!);
    return {
      action: 'matched',
      identifier: a.matchedIdentifier!,
      detail: 'la PR resuelve un issue abierto existente',
    };
  }

  // 3b. Sustantivo huérfano → documentar creando un issue en Linear, asignado al autor.
  if (!project?.linear_team_id) {
    return {
      action: 'orphan:no-project',
      detail: `repo ${input.repo} sin proyecto/team mapeado; no se puede crear issue`,
    };
  }

  // Resolver devs por login (autor principal = quien abrió la PR; merger; revisores).
  const authorDev = await resolveDevByLogin(supabase, pr.authorLogin);
  const mergerDev = await resolveDevByLogin(supabase, pr.mergedByLogin);

  const mention = (login: string | null) => (login ? `@${login}` : 'desconocido');
  const reviewerLine = reviews.length
    ? reviews.map((r) => `${mention(r.login)} (${r.state})`).join(', ')
    : '— sin revisiones';
  const authorsLine = authors.length
    ? authors.map((a) => mention(a.login)).join(', ')
    : mention(pr.authorLogin);

  const title = (a.title || pr.title || `PR #${pr.number}`).slice(0, 120);
  const description =
    `> 🔗 **Auto-documentado desde PR #${pr.number}** (sin issue previo)\n` +
    `> Repo \`${input.repo}\` · [ver PR](${pr.url})\n` +
    `> **Commiteó:** ${authorsLine} · **Revisó:** ${reviewerLine} · **Mergeó:** ${mention(pr.mergedByLogin)}` +
    `\n\n${a.summary || pr.body || pr.title}`;

  const assigneeId = authorDev?.linear_user_id ?? undefined;
  const stateId = await resolveInitialStateId(project.linear_team_id, 'completed');
  const issue = await createIssue({
    teamId: project.linear_team_id,
    projectId: project.linear_project_id ?? undefined,
    title,
    description,
    assigneeId,
    priority: priorityToLinear(a.priority),
    stateId: stateId ?? undefined,
  });
  state.issueCreated = true;

  // Suprime el correo de "te asignaron una tarea": el espejo del webhook de Linear vería un
  // assignee nuevo y dispararía notifyAssignment. Pre-reclamamos su llave (la misma que usa
  // notifyAssignment) para que el eco se salte el envío — no tiene sentido por trabajo ya hecho.
  // En su lugar emitimos "cambio documentado" (un solo correo agrupado al autor).
  if (authorDev?.id) {
    await claimOnce(`notify-assign:${issue.identifier}:${authorDev.id}`, 'notify-assign').catch(() => {});
  }

  // Espejo (idempotente con el webhook). source='pr' + atribución por columnas de conveniencia.
  await supabase.from('work_item').upsert(
    {
      linear_id: issue.id,
      identifier: issue.identifier,
      project_id: project.id,
      title,
      spec: description,
      state: 'completed',
      completed_at: new Date().toISOString(),
      assignee_dev_id: authorDev?.id ?? null,
      merger_dev_id: mergerDev?.id ?? null,
      priority: a.priority ?? null,
      documented: true,
      change_notified: false,
      url: issue.url,
      source: 'pr',
      repo: input.repo,
      pr_number: pr.number,
    },
    { onConflict: 'linear_id' },
  );

  // Recuperar el id del work_item para la atribución normalizada.
  const { data: wi } = await supabase
    .from('work_item')
    .select('id')
    .eq('linear_id', issue.id)
    .maybeSingle();
  if (wi?.id) {
    await persistActors(supabase, wi.id, { authors, reviews, mergerLogin: pr.mergedByLogin });
  }

  // Notificar al autor (un solo correo agrupado de "cambio documentado").
  if (authorDev?.id) {
    await emit(
      'change.documented',
      { devId: authorDev.id },
      { idempotencyKey: `change-doc:pr:${input.repo}:${pr.number}`, delaySeconds: 30 },
    ).catch(() => {});
  }

  return { action: 'documented', identifier: issue.identifier, detail: 'issue creado desde PR con atribución' };
}

/** Resuelve un dev de roz por su github_login. */
async function resolveDevByLogin(
  supabase: ReturnType<typeof db>,
  login: string | null,
): Promise<{ id: string; linear_user_id: string | null } | null> {
  if (!login) return null;
  const { data } = await supabase
    .from('dev')
    .select('id, linear_user_id')
    .eq('github_login', login)
    .maybeSingle();
  return (data as { id: string; linear_user_id: string | null }) ?? null;
}

/**
 * Guarda la atribución normalizada (work_item_actor): autor(es), revisor(es) con su estado y
 * quién mergeó. github_login SIEMPRE se guarda (aunque el actor no esté mapeado a un dev), para
 * no perder el crédito de quien aún no está en roz.dev. Upsert idempotente por (work_item, login, rol).
 */
async function persistActors(
  supabase: ReturnType<typeof db>,
  workItemId: string,
  data: { authors: PrAuthor[]; reviews: PrReview[]; mergerLogin: string | null },
): Promise<void> {
  const rows: Record<string, unknown>[] = [];

  // Cache login → dev_id para no consultar el mismo dev varias veces.
  const devCache = new Map<string, string | null>();
  const devIdOf = async (login: string): Promise<string | null> => {
    if (devCache.has(login)) return devCache.get(login)!;
    const dev = await resolveDevByLogin(supabase, login);
    devCache.set(login, dev?.id ?? null);
    return dev?.id ?? null;
  };

  for (const a of data.authors) {
    if (!a.login) continue;
    rows.push({ work_item_id: workItemId, github_login: a.login, role: 'author', dev_id: await devIdOf(a.login) });
  }
  for (const r of data.reviews) {
    if (!r.login) continue;
    rows.push({
      work_item_id: workItemId,
      github_login: r.login,
      role: 'reviewer',
      review_state: r.state,
      dev_id: await devIdOf(r.login),
    });
  }
  if (data.mergerLogin) {
    rows.push({
      work_item_id: workItemId,
      github_login: data.mergerLogin,
      role: 'merger',
      dev_id: await devIdOf(data.mergerLogin),
    });
  }

  if (rows.length) {
    await supabase
      .from('work_item_actor')
      .upsert(rows, { onConflict: 'work_item_id,github_login,role' })
      .then(() => {}, () => {}); // best-effort: la atribución no debe tumbar la reconciliación
  }
}
