// Reconciliación de Pull Requests mergeadas. roz documenta el trabajo POR PR (no por commit):
//  · Un solo ticket por PR (idempotente por nº de PR) → mata la duplicación rama+squash.
//  · Atribución completa: quién commiteó (autor real), quién revisó (y su estado) y quién mergeó.
//    Se asigna al autor; revisor/merger se guardan en work_item_actor (consultable) + columnas
//    de conveniencia.
//
// Misma filosofía que reconcile/commits.ts: si la PR referencia una tarea existente (por su
// identificador, p.ej. ROZ-123), roz solo marca documentado y la cierra; si no, reglas (classify.ts,
// sin modelo) deciden si es trivial y, si no lo es, se crea una tarea nueva con el texto de la PR.
import { db } from '../db/supabase.js';
import { isTrivialChange } from './classify.js';
import {
  getPullRequest,
  listPullRequestCommits,
  listPullRequestCommitShas,
  listPullRequestReviews,
  referencesLinearIssue,
  type PrAuthor,
  type PrReview,
} from '../adapters/github.js';
import { claimOnce, releaseOnce, emit } from '../events/outbox.js';
import { resolveProjectByRepo } from '../projects/resolve.js';
import { notifyPrMerged } from '../notify/notifications.js';
import { createDocumentedTask } from '../dashboard/queries.js';
import { resolveReference } from '../linear/legacy.js';
import { linearSourceOfTruth } from '../linear/enabled.js';

export interface ReconcilePrInput {
  repo: string; // "owner/name"
  number: number;
  /** id numérico inmutable del repo (del payload del webhook): habilita la auto-sanación de renames. */
  githubId?: number | null;
}

export interface ReconcilePrResult {
  action:
    | 'skipped:already-processed'
    | 'not-merged'
    | 'linked' // la PR referencia una tarea existente por su identificador (p.ej. ROZ-123)
    | 'trivial'
    | 'matched' // resuelve un issue abierto → enlazado
    | 'documented' // trabajo sustantivo → issue creado con atribución
    | 'orphan:no-project';
  identifier?: string;
  detail?: string;
}


export async function reconcilePullRequest(input: ReconcilePrInput): Promise<ReconcilePrResult> {
  const supabase = db();
  const claimKey = `pr:${input.repo}:${input.number}`;

  // Exactamente-una-vez por PR. Se libera si algo falla ANTES de crear el issue (efecto no
  // idempotente); una vez creado, no se libera (el espejo posterior es best-effort).
  const first = await claimOnce(claimKey, 'pr');
  if (!first) return { action: 'skipped:already-processed' };

  const status = { issueCreated: false };
  try {
    return await reconcileBody(input, supabase, status);
  } catch (err) {
    if (!status.issueCreated) await releaseOnce(claimKey).catch(() => {});
    throw err;
  }
}

async function reconcileBody(
  input: ReconcilePrInput,
  supabase: ReturnType<typeof db>,
  status: { issueCreated: boolean },
): Promise<ReconcilePrResult> {
  const pr = await getPullRequest(input.repo, input.number);
  if (!pr.merged) return { action: 'not-merged', detail: `PR #${input.number} no está mergeada` };

  // Se pasa githubId para auto-sanar un repo renombrado (cuyo nombre ya no resuelve) por su id.
  const project = await resolveProjectByRepo(input.repo, input.githubId);

  // Atribución de la PR (autores reales de los commits + revisores + quién mergeó). Se necesita en
  // TODAS las ramas (linked / matched / documented) para alimentar la conexión-con-código del
  // dashboard, no solo en la huérfana. Antes solo se grababa al auto-documentar, por eso los PRs
  // que enlazan una tarea por su identificador (el flujo normal) no registraban nada.
  const [authors, reviews, prShas] = await Promise.all([
    listPullRequestCommits(input.repo, input.number).catch(() => [] as PrAuthor[]),
    listPullRequestReviews(input.repo, input.number).catch(() => [] as PrReview[]),
    listPullRequestCommitShas(input.repo, input.number).catch(() => [] as string[]),
  ]);
  const mergerDev = await resolveDevByLogin(supabase, pr.mergedByLogin);

  // Commits a ligar al work_item para su esfuerzo real: el merge/squash commit (único persistido
  // en un squash) + los commits de la rama (los persistidos en un merge/rebase). linkPrCommits solo
  // actualiza los que EXISTEN en roz.commit, así que pasar la unión cubre cualquier estrategia.
  const commitShas = [pr.mergeCommitSha, ...prShas].filter(Boolean) as string[];

  // 1. ¿La PR referencia una tarea por su identificador (rama "feat/ROZ-12", título o cuerpo)?
  //    roz la marca documentada y la cierra; no duplica.
  const linked = await resolveReference(referencesLinearIssue(`${pr.title}\n${pr.body ?? ''}\n${pr.headRef ?? ''}`));
  // Aviso al autor cuando OTRA persona integró su PR (best-effort, una vez por PR y autor).
  await notifyPrMerged({
    pr: { repo: input.repo, number: pr.number, title: pr.title, branch: pr.headRef ?? null, identifier: linked },
    authorLogins: [pr.authorLogin, ...authors.map((a) => a.login)],
    mergedByLogin: pr.mergedByLogin,
    reviewerLogins: reviews.map((r) => r.login),
  });
  if (linked) {
    await supabase.from('work_item').update({ documented: true }).eq('identifier', linked);
    await attributePr(supabase, linked, input, pr, authors, reviews, mergerDev?.id ?? null, commitShas);
    await completeLinkedIssue(supabase, linked);
    return { action: 'linked', identifier: linked, detail: 'enlazado por identificador de tarea' };
  }

  // Sin modelo: una PR sin identificador NO se intenta emparejar con una tarea abierta. Lo trivial se
  // descarta por reglas y el resto se documenta con el título y la descripción de la propia PR.
  if (isTrivialChange(pr.title)) {
    return { action: 'trivial', detail: 'PR trivial, no se documenta' };
  }

  // 3b. Sustantivo huérfano → documentar creando una TAREA NATIVA (completada), asignada al autor.
  if (!project?.id) {
    return {
      action: 'orphan:no-project',
      detail: `repo ${input.repo} sin proyecto mapeado; no se puede documentar`,
    };
  }

  // Resolver dev del autor principal (quien abrió la PR). El merger ya se resolvió arriba.
  const authorDev = await resolveDevByLogin(supabase, pr.authorLogin);

  const mention = (login: string | null) => (login ? `@${login}` : 'desconocido');
  const reviewerLine = reviews.length
    ? reviews.map((r) => `${mention(r.login)} (${r.state})`).join(', ')
    : '— sin revisiones';
  const authorsLine = authors.length
    ? authors.map((a) => mention(a.login)).join(', ')
    : mention(pr.authorLogin);

  const name = (pr.title || `PR #${pr.number}`).slice(0, 120);
  const description =
    `> 🔗 **Auto-documentado desde PR #${pr.number}** (sin tarea previa)\n` +
    `> Repo \`${input.repo}\` · [ver PR](${pr.url})\n` +
    `> **Commiteó:** ${authorsLine} · **Revisó:** ${reviewerLine} · **Mergeó:** ${mention(pr.mergedByLogin)}` +
    `\n\n${pr.body || pr.title}`;

  // Sin modelo no hay de dónde inferir la prioridad: la tarea nace sin ella.
  const priority = null;

  // Tarea nativa completada (source='pr') con atribución. Crear la tarea es un efecto NO idempotente
  // (un reintento duplicaría), así que a partir de aquí no se libera la llave del claim.
  const task = await createDocumentedTask({
    projectId: project.id,
    name,
    description: description,
    priority,
    assigneeDevId: authorDev?.id ?? null,
    mergerDevId: mergerDev?.id ?? null,
    source: 'pr',
    repo: input.repo,
    prNumber: pr.number,
    prState: 'merged',
    headRef: pr.headRef ?? null,
    completedAt: pr.mergedAt, // fecha real del merge (no el momento del reproceso)
  });
  status.issueCreated = true;

  await persistActors(supabase, task.id, { authors, reviews, mergerLogin: pr.mergedByLogin });
  await linkPrCommits(supabase, input.repo, task.id, commitShas);

  // Notificar al autor (un solo correo agrupado de "cambio documentado").
  if (authorDev?.id) {
    await emit(
      'change.documented',
      { devId: authorDev.id },
      { idempotencyKey: `change-doc:pr:${input.repo}:${pr.number}`, delaySeconds: 30 },
    ).catch(() => {});
  }

  return { action: 'documented', identifier: task.identifier, detail: 'tarea nativa creada desde PR con atribución' };
}

/** Resuelve un dev de roz por su github_login. */
export async function resolveDevByLogin(
  supabase: ReturnType<typeof db>,
  login: string | null,
): Promise<{ id: string } | null> {
  if (!login) return null;
  // Los logins de GitHub son case-insensitive y la API los devuelve con casing variable
  // (p.ej. "GermanMorelli" en la PR vs "germanmorelli" guardado). Se compara sin distinguir
  // mayúsculas (ilike sin comodines = igualdad case-insensitive; los logins no llevan % ni _).
  const { data } = await supabase
    .from('dev')
    .select('id')
    .ilike('github_login', login)
    .maybeSingle();
  return (data as { id: string }) ?? null;
}

/**
 * Graba la conexión-con-código en un work_item EXISTENTE (ramas linked/matched): el PR que lo
 * resolvió (repo + nº + quién mergeó) y los actores normalizados. NO toca `source`: preserva el
 * origen con el que nació la tarea (nativa, o histórico de Linear) aunque un PR la haya cerrado.
 */
async function attributePr(
  supabase: ReturnType<typeof db>,
  identifier: string,
  input: ReconcilePrInput,
  pr: { number: number; mergedByLogin: string | null; headRef?: string | null },
  authors: PrAuthor[],
  reviews: PrReview[],
  mergerDevId: string | null,
  commitShas: string[],
): Promise<void> {
  const { data: wi } = await supabase.from('work_item').select('id').eq('identifier', identifier).maybeSingle();
  if (!wi?.id) return;
  await supabase
    .from('work_item')
    .update({ repo: input.repo, pr_number: pr.number, merger_dev_id: mergerDevId, pr_state: 'merged', head_ref: pr.headRef ?? null })
    .eq('id', wi.id);
  await persistActors(supabase, wi.id, { authors, reviews, mergerLogin: pr.mergedByLogin });
  await linkPrCommits(supabase, input.repo, wi.id, commitShas);
}

/**
 * Liga los commits de una PR a su work_item (roz.commit.work_item_id) → así la tarea suma su
 * esfuerzo real (commits/líneas/hyperpoints) en el dashboard. Antes ningún commit se ligaba desde
 * el flujo de PR, así que una tarea nacida/cerrada por PR mostraba 0/0/0 salvo que el mensaje del
 * commit trajera el identificador. Solo actualiza filas que YA existen (repo+sha) → idempotente y
 * a prueba de la estrategia de merge. Casing canónico del repo en minúsculas (como en persistCommit).
 * Best-effort: un fallo no debe tumbar la reconciliación de la PR.
 */
async function linkPrCommits(
  supabase: ReturnType<typeof db>,
  repo: string,
  workItemId: string,
  shas: string[],
): Promise<void> {
  const clean = [...new Set(shas.filter(Boolean))];
  if (!clean.length) return;
  await supabase
    .from('commit')
    .update({ work_item_id: workItemId })
    .eq('repo', repo.toLowerCase())
    .in('sha', clean)
    .then(() => {}, () => {});
}

/**
 * Cierra (mueve a Completado) un work_item EXISTENTE que una PR mergeada resolvió. roz es la única
 * fuente de verdad del trabajo, así que se cierra directamente en local → PR mergeada implica tarea
 * Completada, sea auto-creada o pre-existente (consistencia entre devs). Emite `work_item.done` para
 * disparar los efectos de cierre (documentación al brain + aviso al proposer), idempotente por
 * identifier. Best-effort: un fallo del emit no debe tumbar la reconciliación de la PR.
 */
async function completeLinkedIssue(supabase: ReturnType<typeof db>, identifier: string): Promise<void> {
  // Con Linear como fuente de verdad el cierre lo hace la integración de GitHub de Linear y llega por
  // el espejo (que además emite work_item.done): escribir aquí chocaría con él y duplicaría el aviso.
  if (linearSourceOfTruth()) return;
  const { data: wi } = await supabase
    .from('work_item')
    .select('id, status')
    .eq('identifier', identifier)
    .maybeSingle();
  if (!wi?.id) return;
  if (wi.status === 'completada' || wi.status === 'cancelada') return; // ya cerrado: no re-tocar

  await supabase
    .from('work_item')
    .update({ status: 'completada', completed_at: new Date().toISOString() })
    .eq('id', wi.id);

  await emit('work_item.done', { identifier }, { idempotencyKey: `done:${identifier}` }).catch(() => {});
}

/**
 * Guarda la atribución normalizada (work_item_actor): autor(es), revisor(es) con su estado y
 * quién mergeó. github_login SIEMPRE se guarda (aunque el actor no esté mapeado a un dev), para
 * no perder el crédito de quien aún no está en roz.dev. Upsert idempotente por (work_item, login, rol).
 */
export async function persistActors(
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
