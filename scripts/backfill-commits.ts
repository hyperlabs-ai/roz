// Backfill manual de commits del historial → roz.commit (solo métricas, sin Linear ni Claude).
// Reúsa el mismo core que el backfill automático (reconcile/backfill.ts): rama por defecto, cada
// sha una vez, merges descartados, upsert idempotente por (repo, sha). Atribuye autor→dev.
//
// Cubre AMBAS fuentes de repos vinculados:
//   · roz.project_repo                       (mapeo directo: internos y clientes)
//   · public.github_repositories (HyperOps)  → roz.project por hyperops_project_id (fallback)
//
// Uso:  npx tsx scripts/backfill-commits.ts [días] [filtro-repo]   (default 90 días)
import 'dotenv/config';
import { db, dbPublic } from '../src/db/supabase.js';
import { backfillRepoCommits, loadDevMaps, BACKFILL_DAYS } from '../src/reconcile/backfill.js';

const DAYS = Number(process.argv[2] ?? BACKFILL_DAYS);
const REPO_FILTER = process.argv[3] ?? ''; // opcional: solo repos cuyo full_name incluya esto

/** Junta los repos vinculados (mapeo directo + fallback HyperOps) → { repo, projectId roz }. */
async function resolveLinkedRepos(): Promise<Map<string, string | null>> {
  const supabase = db();
  const repos = new Map<string, string | null>(); // full_name → roz project_id

  const { data: links } = await supabase.from('project_repo').select('repo, project_id');
  for (const l of (links ?? []) as { repo: string; project_id: string }[]) {
    if (l.repo) repos.set(l.repo, l.project_id ?? null);
  }

  // Fallback HyperOps: github_repositories activos → roz.project por hyperops_project_id.
  const { data: projects } = await supabase.from('project').select('id, hyperops_project_id');
  const rozByHyperops = new Map<string, string>();
  for (const p of (projects ?? []) as { id: string; hyperops_project_id: string | null }[]) {
    if (p.hyperops_project_id) rozByHyperops.set(p.hyperops_project_id, p.id);
  }
  const { data: ghRepos } = await dbPublic()
    .from('github_repositories')
    .select('full_name, project_id')
    .eq('active', true);
  for (const r of (ghRepos ?? []) as { full_name: string; project_id: string | null }[]) {
    if (!r.full_name || repos.has(r.full_name)) continue; // el mapeo directo manda
    repos.set(r.full_name, (r.project_id && rozByHyperops.get(r.project_id)) || null);
  }

  return repos;
}

async function main() {
  const sinceISO = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  console.log(`Backfill desde ${sinceISO} (${DAYS} días)\n`);

  const devMaps = await loadDevMaps();
  const repos = await resolveLinkedRepos();

  let totalPersisted = 0;
  let totalAttributed = 0;
  let totalMerges = 0;

  for (const [repo, projectId] of repos) {
    if (REPO_FILTER && !repo.includes(REPO_FILTER)) continue;
    let page = 1;
    let repoCount = 0;
    for (;;) {
      let r;
      try {
        r = await backfillRepoCommits({ repo, projectId, sinceISO, page, devMaps });
      } catch (e) {
        console.log(`  ${repo}: error (${String(e).slice(0, 80)})`);
        break;
      }
      totalPersisted += r.persisted;
      totalAttributed += r.attributed;
      totalMerges += r.skippedMerges;
      repoCount += r.persisted;
      if (!r.hasMore) break;
      page = r.nextPage;
    }
    if (repoCount) console.log(`  ${repo}: ${repoCount} commits`);
  }

  console.log(
    `\nTotal: ${totalPersisted} commits | atribuidos a un dev: ${totalAttributed} | merges descartados: ${totalMerges}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
