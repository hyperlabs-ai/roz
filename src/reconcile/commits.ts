// Reconciliación de commits [fase 5]. Por cada commit de GitHub:
//  1. ¿referencia una tarea por su identificador (ABC-123)? → roz solo marca el work_item como
//     documentado. No duplica.
//  2. Si no → trabajo HUÉRFANO. SIN modelo: reglas (classify.ts) deciden si es trivial.
//  3. Trivial → se ignora. El resto → roz crea una tarea nativa completada con el mensaje del commit
//     tal cual (para que todo quede registrado). Ya no se empareja con tareas abiertas por
//     razonamiento: solo el identificador en el mensaje enlaza.
//  4. Idempotencia por sha (claimOnce) — cada commit se procesa una sola vez.
import { db } from '../db/supabase.js';
import { isTrivialChange } from './classify.js';
import { getCommit, commitPullRequests, pushCommitShas, referencesLinearIssue, type CommitMeta } from '../adapters/github.js';
import { claimOnce, releaseOnce, emit } from '../events/outbox.js';
import { resolveProjectByRepo } from '../projects/resolve.js';
import { createDocumentedTask } from '../dashboard/queries.js';
import { resolveReference } from '../linear/legacy.js';
import { shasInOtherRepos } from './backfill.js';

export interface ReconcileInput {
  repo: string; // "owner/name"
  sha: string;
  /** id numérico inmutable del repo (del payload del webhook): habilita la auto-sanación de renames. */
  githubId?: number | null;
  /** Para pruebas: si se pasa, no se consulta la API de GitHub. */
  commit?: CommitMeta;
}

export interface ReconcileResult {
  action:
    | 'skipped:already-processed'
    | 'skipped:in-pr' // pertenece a una PR → lo documenta reconcilePullRequest
    | 'linked' // referencia una tarea por su identificador (p.ej. ROZ-123)
    | 'trivial' // chore/merge/lint: se ignora
    | 'matched' // resuelve una tarea abierta → enlazado
    | 'documented' // trabajo sustantivo huérfano → tarea creada
    | 'orphan:no-project' // repo sin proyecto mapeado
    | 'skipped:merge' // merge commit: no es trabajo nuevo (recontaría líneas), no se persiste
    | 'skipped:cloned' // el sha ya está en otro repo (historial de un clon): ya contó allá
    ;
  identifier?: string;
  detail?: string;
}


/**
 * Backfill de un push truncado (>20 commits): enumera el rango completo before...after vía la API
 * de compare y encola un `commit.received` por sha. Idempotente por sha (los ya emitidos por el
 * webhook no se duplican). Cada commit se reconcilia luego por su propio camino (incluido el
 * descarte de merges), así que aquí solo se hace fan-out.
 */
export async function backfillPushCommits(input: { repo: string; before: string; after: string; githubId?: number | null }): Promise<{ enqueued: number }> {
  if (!input.repo || !input.before || !input.after) return { enqueued: 0 };
  const shas = await pushCommitShas(input.repo, input.before, input.after);
  for (const sha of shas) {
    await emit('commit.received', { repo: input.repo, sha, githubId: input.githubId ?? null }, { idempotencyKey: `commit:${input.repo}:${sha}` });
  }
  return { enqueued: shas.length };
}

export async function reconcileCommit(input: ReconcileInput): Promise<ReconcileResult> {
  const supabase = db();
  const claimKey = `commit:${input.repo}:${input.sha}`;

  // Exactamente-una-vez por commit. La llave se reclama ANTES del trabajo para no procesar
  // el mismo commit dos veces; pero si algo falla ANTES de crear la tarea, se LIBERA
  // (releaseOnce) para que el reintento del outbox vuelva a intentarlo. Una vez creada la
  // tarea (efecto no idempotente), ya no se libera.
  const first = await claimOnce(claimKey, 'commit');
  if (!first) return { action: 'skipped:already-processed' };

  const status = { issueCreated: false };
  try {
    const commit = input.commit ?? (await getCommit(input.repo, input.sha));
    return await reconcileBody(input, supabase, commit, status);
  } catch (err) {
    if (!status.issueCreated) await releaseOnce(claimKey).catch(() => {});
    throw err;
  }
}

async function reconcileBody(
  input: ReconcileInput,
  supabase: ReturnType<typeof db>,
  commit: CommitMeta,
  status: { issueCreated: boolean },
): Promise<ReconcileResult> {
  // Un merge commit no es trabajo nuevo: su diff combinado recontaría líneas ya atribuidas a los
  // commits que el merge trae. No se persiste → no cuenta como commit ni como líneas. (La rama por
  // defecto ya se filtra en el webhook; aquí se descarta el merge que sí aterriza en ella.)
  if (commit.isMerge) {
    return { action: 'skipped:merge', detail: 'merge commit: no cuenta commits ni líneas' };
  }

  // Commit heredado de un repo clonado: ya se registró (y documentó) en el repo original. Ni se
  // persiste otra vez ni se manda a Claude — sería el mismo trabajo contado y documentado dos veces.
  if ((await shasInOtherRepos(input.repo, [commit.sha])).size) {
    return { action: 'skipped:cloned', detail: 'el sha ya está registrado en otro repo (clon)' };
  }

  // Resolver proyecto y dev autor una sola vez: se usan para persistir el commit (dashboard) y,
  // en el camino huérfano, para asignar el issue resultante. Se pasa githubId para que un repo
  // renombrado (cuyo nombre ya no resuelve) se auto-sane por su id inmutable.
  const project = await resolveProjectByRepo(input.repo, input.githubId);
  const dev = await resolveDevByCommit(supabase, commit);

  // ¿El mensaje referencia una tarea (ROZ-123)? Se resuelve su work_item para LIGAR el commit
  // (work_item_id) → así la tarea suma su esfuerzo real (commits/líneas/hyperpoints). El vínculo se
  // hace aunque el commit pertenezca a una PR (el esfuerzo cuenta igual).
  // resolveReference: con Linear como fuente de verdad, un ROZ-123 viejo lleva a su issue vigente.
  const referenced = await resolveReference(referencesLinearIssue(commit.message));
  const linkedWorkItemId = referenced
    ? ((await supabase.from('work_item').select('id').eq('identifier', referenced).maybeSingle()).data as { id: string } | null)?.id ?? null
    : null;

  // Persistir el commit SIEMPRE (el dashboard cuenta TODO el trabajo, incluso el de ramas y PRs):
  // las métricas de commits no dependen de la documentación. Upsert por (repo, sha) → idempotente.
  await persistCommit(supabase, input, commit, project?.id ?? null, dev?.id ?? null, linkedWorkItemId);

  // Dedup con el flujo de PR: si el commit pertenece a una PR (abierta o mergeada), NO se documenta
  // aquí — lo hace reconcilePullRequest en un solo ticket con atribución. Cubre cualquier estrategia
  // de merge (squash/merge/rebase). El commit ya quedó persistido (y ligado) arriba para las métricas.
  const prs = await commitPullRequests(input.repo, commit.sha).catch(() => []);
  if (prs.length) {
    // Fallback de ligado: si el commit no se ligó por su mensaje pero pertenece a una PR YA
    // reconciliada (su work_item tiene pr_number), se liga a esa tarea. Cubre la carrera entre el
    // evento push (este commit) y pr.merged: si el push llega primero, reconcilePullRequest ligará
    // el commit después; si llega segundo, lo liga aquí. Idempotente.
    if (!linkedWorkItemId) {
      for (const pr of prs) {
        const { data: wi } = await supabase
          .from('work_item')
          .select('id')
          .ilike('repo', input.repo)
          .eq('pr_number', pr.number)
          .limit(1)
          .maybeSingle();
        if ((wi as { id: string } | null)?.id) {
          await supabase
            .from('commit')
            .update({ work_item_id: (wi as { id: string }).id })
            .eq('repo', input.repo.toLowerCase())
            .eq('sha', commit.sha);
          break;
        }
      }
    }
    return { action: 'skipped:in-pr', detail: `commit en PR #${prs[0]!.number}; lo documenta el flujo de PR` };
  }

  // 1. ¿Referencia una tarea existente? Marca documentada (el commit ya quedó ligado arriba).
  if (referenced) {
    await supabase
      .from('work_item')
      .update({ documented: true })
      .eq('identifier', referenced); // best-effort
    return { action: 'linked', identifier: referenced, detail: 'commit ligado a la tarea referenciada' };
  }

  // Sin modelo: un commit sin referencia NO se intenta emparejar con una tarea abierta (eso solo lo
  // hace el identificador en el mensaje). Lo trivial se descarta por reglas y el resto se documenta
  // con el mensaje tal cual lo escribió el autor.
  if (isTrivialChange(commit.message)) {
    return { action: 'trivial', detail: 'commit trivial, no se documenta' };
  }

  // 4b. Sustantivo huérfano sin match → documentar creando una TAREA NATIVA (completada).
  if (!project?.id) {
    return {
      action: 'orphan:no-project',
      detail: `repo ${input.repo} sin proyecto mapeado; no se puede documentar`,
    };
  }

  const name = (commit.message.split('\n')[0] || 'Trabajo desde commit').slice(0, 120);
  const description =
    `> 🔗 **Auto-documentado desde un commit** (sin tarea previa)\n` +
    `> Repo \`${input.repo}\` · commit [\`${commit.sha.slice(0, 8)}\`](${commit.url})` +
    (commit.author ? ` · autor: ${commit.author}` : '') +
    `\n\n${commit.message}`;

  // Sin modelo no hay de dónde inferir la prioridad: la tarea nace sin ella.
  const priority = null;

  // El trabajo YA existe en el código, así que la tarea nace COMPLETADA, asignada al autor (crédito).
  // Crear la tarea es un efecto NO idempotente → a partir de aquí no se libera la llave del claim.
  const task = await createDocumentedTask({
    projectId: project.id,
    name,
    description: description,
    priority,
    assigneeDevId: dev?.id ?? null,
    source: 'commit',
    repo: input.repo.toLowerCase(),
    completedAt: commit.committedAt, // fecha real del commit (no el momento del reproceso)
  });
  status.issueCreated = true;

  // Liga el commit que originó la tarea a ella (esfuerzo real).
  await supabase.from('commit').update({ work_item_id: task.id }).eq('repo', input.repo.toLowerCase()).eq('sha', commit.sha);

  // Correo agrupado de "cambio documentado" (por dev, dedup por sha). El delay da tiempo a que
  // se inserten todos los work_items del push antes de armar el correo.
  if (dev?.id) {
    await emit(
      'change.documented',
      { devId: dev.id },
      { idempotencyKey: `change-doc:${input.sha}`, delaySeconds: 120 },
    ).catch(() => {});
  }

  return { action: 'documented', identifier: task.identifier, detail: 'tarea nativa completada creada desde commit huérfano' };
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
    // Login case-insensitive: GitHub devuelve casing variable y en roz.dev puede estar en minúsculas.
    const { data } = await supabase
      .from('dev')
      .select('id, linear_user_id')
      .ilike('github_login', commit.author)
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
  workItemId: string | null = null,
): Promise<void> {
  // Los merge commits ya se descartaron en reconcileBody, así que aquí solo llegan commits reales.
  await supabase.from('commit').upsert(
    {
      sha: commit.sha,
      // Casing canónico en minúsculas: el upsert (repo,sha) deduplica aunque el webhook y el
      // backfill traigan el repo con distinto casing (p.ej. "owner/Mind-playground").
      repo: input.repo.toLowerCase(),
      project_id: projectId,
      dev_id: devId,
      work_item_id: workItemId, // tarea referenciada (ROZ-123) → esfuerzo real por tarea
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
