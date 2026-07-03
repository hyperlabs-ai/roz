// Backfill del HISTORIAL de commits al vincular un repo/proyecto. roz solo reacciona a webhooks
// en vivo, así que todo lo anterior a la vinculación es invisible: este módulo lo recupera.
//
// Es backfill SOLO de métricas (roz.commit para el dashboard): NO llama a Claude ni crea/enlaza
// tickets en Linear (eso inundaría Linear con cientos de issues históricos). Mismas reglas de
// conteo que el flujo en vivo: rama por defecto, cada sha una vez, merges NO cuentan (recontarían
// líneas ya atribuidas). Idempotente por (repo, sha) → re-correr es seguro.
//
// Se procesa una PÁGINA (100 commits) por evento y se re-encola la siguiente: cada invocación del
// drain queda acotada muy por debajo del maxDuration serverless, aunque el repo tenga miles de
// commits. El stats (líneas) es un GET por commit; 100 por página caben de sobra en una invocación.
import { db } from '../db/supabase.js';
import { listRepoCommits, getCommit } from '../adapters/github.js';
import { emit } from '../events/outbox.js';

export const BACKFILL_DAYS = 30;

export interface DevMaps {
  byEmail: Map<string, string>; // email (minúsculas) → dev_id
  byLogin: Map<string, string>; // login (minúsculas) → dev_id
}

/** Carga los devs una vez en mapas (login/email en minúsculas) para atribuir en lote sin N queries.
 *  El match en minúsculas es case-insensitive por construcción (GitHub varía el casing del login). */
export async function loadDevMaps(): Promise<DevMaps> {
  const { data: devs } = await db().from('dev').select('id, github_login, github_email');
  const byEmail = new Map<string, string>();
  const byLogin = new Map<string, string>();
  for (const d of (devs ?? []) as { id: string; github_login: string | null; github_email: string | null }[]) {
    if (d.github_email) byEmail.set(d.github_email.toLowerCase(), d.id);
    if (d.github_login) byLogin.set(d.github_login.toLowerCase(), d.id);
  }
  return { byEmail, byLogin };
}

export interface BackfillRepoInput {
  repo: string;
  projectId: string | null;
  sinceISO: string;
  page?: number;
  /** Mapas de dev precargados (para loops del script: se cargan una sola vez). */
  devMaps?: DevMaps;
  /** Si es false, no toca el estado de sync (roz.project_repo.sync_*). Default true. */
  trackStatus?: boolean;
}

export interface BackfillRepoResult {
  persisted: number;
  skippedMerges: number;
  attributed: number;
  hasMore: boolean; // la página vino llena (100) → puede haber más
  nextPage: number;
}

/** Actualiza el estado de sync del repo (best-effort: si las columnas no existen, no rompe). */
async function updateRepoSync(repo: string, patch: Record<string, unknown>): Promise<void> {
  await db()
    .from('project_repo')
    .update({ ...patch, sync_updated_at: new Date().toISOString() })
    .eq('repo', repo.toLowerCase())
    .then(undefined, () => {});
}

/** Marca el repo en estado de error (lo llama el outbox al agotar los reintentos del backfill). */
export async function markRepoSyncError(repo: string, message: string): Promise<void> {
  await updateRepoSync(repo, { sync_status: 'error', sync_error: message.slice(0, 500) });
}

/** Procesa UNA página del historial de un repo: persiste commits no-merge con su atribución y líneas. */
export async function backfillRepoCommits(input: BackfillRepoInput): Promise<BackfillRepoResult> {
  const supabase = db();
  const page = input.page ?? 1;
  const track = input.trackStatus ?? true;
  const maps = input.devMaps ?? (await loadDevMaps());

  const { items: list, lastPage } = await listRepoCommits(input.repo, input.sinceISO, page);
  let persisted = 0;
  let skippedMerges = 0;
  let attributed = 0;

  // Estado: entramos a "syncing"; en la página 1 fijamos el total de páginas (para el % de la barra).
  if (track) {
    await updateRepoSync(input.repo, {
      sync_status: 'syncing',
      sync_pages: page,
      ...(page === 1 ? { sync_total_pages: lastPage } : {}),
    });
  }

  for (const item of list) {
    // Merge commit: su diff combinado recontaría líneas ya atribuidas a los commits que trae. No
    // se persiste (mismo criterio que reconcileBody en el flujo en vivo).
    if (item.isMerge) {
      skippedMerges++;
      continue;
    }

    const email = item.authorEmail?.toLowerCase() ?? null;
    const login = item.authorLogin?.toLowerCase() ?? null;
    const devId = (email && maps.byEmail.get(email)) || (login && maps.byLogin.get(login)) || null;
    if (devId) attributed++;

    // Líneas (stats): requieren un GET por commit. Best-effort: si falla, se persiste sin líneas.
    let additions: number | null = null;
    let deletions: number | null = null;
    try {
      const c = await getCommit(input.repo, item.sha);
      additions = c.additions;
      deletions = c.deletions;
    } catch {
      /* sin stats: el commit igual cuenta, solo no suma líneas */
    }

    await supabase.from('commit').upsert(
      {
        sha: item.sha,
        repo: input.repo.toLowerCase(), // casing canónico: deduplica (repo,sha) con el flujo en vivo
        project_id: input.projectId,
        dev_id: devId,
        author_login: item.authorLogin,
        author_email: item.authorEmail,
        message: item.message,
        url: item.url,
        additions,
        deletions,
        committed_at: item.committedAt,
      },
      { onConflict: 'repo,sha' },
    );
    persisted++;
  }

  const hasMore = list.length >= 100;
  // Acumular commits de esta corrida y cerrar en "done" cuando ya no hay más páginas. Sin concurrencia
  // por repo (la página N+1 se encola solo tras terminar la N), así que el read-modify-write es seguro.
  if (track) {
    const { data: cur } = await supabase.from('project_repo').select('sync_commits').eq('repo', input.repo.toLowerCase()).maybeSingle();
    const total = ((cur as { sync_commits?: number } | null)?.sync_commits ?? 0) + persisted;
    await updateRepoSync(input.repo, { sync_commits: total, ...(hasMore ? {} : { sync_status: 'done' }) });
  }

  return { persisted, skippedMerges, attributed, hasMore, nextPage: page + 1 };
}

export interface EnqueueBackfillOptions {
  /** Fuerza reprocesar aunque ya se haya backfilleado: usa un runKey único que evita la idempotencia
   *  once-only. El upsert por (repo, sha) mantiene los datos sin duplicar (recalcula líneas). */
  force?: boolean;
}

/**
 * Encola el backfill del historial (últimos BACKFILL_DAYS días) de un repo. Por defecto la llave de
 * idempotencia (runKey '1') hace que cada repo se backfillee una sola vez; con `force` se usa un
 * runKey único (timestamp) para re-sincronizar bajo demanda. El drain re-encola las páginas
 * siguientes arrastrando el mismo runKey. Marca el estado en `queued` reseteando los contadores.
 */
export async function enqueueRepoBackfill(repo: string, projectId: string | null, opts: EnqueueBackfillOptions = {}): Promise<void> {
  const sinceISO = new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString();
  const runKey = opts.force ? String(Date.now()) : '1';
  await updateRepoSync(repo, {
    sync_status: 'queued',
    sync_pages: 0,
    sync_commits: 0,
    sync_total_pages: null,
    sync_error: null,
    sync_started_at: new Date().toISOString(),
  });
  await emit(
    'repo.backfill',
    { repo, projectId, sinceISO, page: 1, runKey },
    { idempotencyKey: `repo-backfill:${repo}:${runKey}:1` },
  );
}
