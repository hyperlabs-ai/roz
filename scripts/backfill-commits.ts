// Backfill de commits del último mes desde GitHub → roz.commit. Lee los repos mapeados en
// roz.project_repo, lista sus commits recientes, resuelve autor→dev y baja las líneas (stats),
// y hace upsert por (repo, sha) — idempotente, se puede re-correr. NO toca Linear ni Claude.
//
// Uso:  npx tsx scripts/backfill-commits.ts [días]   (default 30)
import 'dotenv/config';
import { db } from '../src/db/supabase.js';
import { getCommit } from '../src/adapters/github.js';
import { config } from '../src/config.js';

const DAYS = Number(process.argv[2] ?? 30);
const API = 'https://api.github.com';
const MAX_STATS_CALLS = 4500; // techo para no agotar el rate limit (5000/h) de GitHub

async function ghList(path: string): Promise<any[]> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${config.github.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (res.status === 404) return []; // repo inexistente / sin acceso
  if (!res.ok) throw new Error(`GitHub ${res.status} en ${path}: ${await res.text()}`);
  return (await res.json()) as any[];
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  console.log(`Backfill desde ${since} (${DAYS} días)\n`);

  const supabase = db();
  const { data: links } = await supabase.from('project_repo').select('repo, project_id');
  const { data: devs } = await supabase.from('dev').select('id, github_login, github_email');

  const byEmail = new Map<string, string>();
  const byLogin = new Map<string, string>();
  for (const d of (devs ?? []) as any[]) {
    if (d.github_email) byEmail.set(String(d.github_email).toLowerCase(), d.id);
    if (d.github_login) byLogin.set(String(d.github_login).toLowerCase(), d.id);
  }

  let total = 0;
  let statsCalls = 0;
  let attributed = 0;

  for (const link of (links ?? []) as any[]) {
    const repo = link.repo as string;
    let page = 1;
    let repoCount = 0;
    while (page <= 10) {
      let list: any[];
      try {
        list = await ghList(`/repos/${repo}/commits?since=${encodeURIComponent(since)}&per_page=100&page=${page}`);
      } catch (e) {
        console.log(`  ${repo}: error (${String(e).slice(0, 80)})`);
        break;
      }
      if (!list.length) break;

      for (const item of list) {
        const sha = item.sha as string;
        const email = item.commit?.author?.email ? String(item.commit.author.email).toLowerCase() : null;
        const login = item.author?.login ? String(item.author.login).toLowerCase() : null;
        const devId = (email && byEmail.get(email)) || (login && byLogin.get(login)) || null;
        if (devId) attributed++;

        // Líneas (stats): requieren GET individual. Respetamos el techo de rate limit.
        let additions: number | null = null;
        let deletions: number | null = null;
        if (statsCalls < MAX_STATS_CALLS) {
          try {
            const c = await getCommit(repo, sha);
            additions = c.additions;
            deletions = c.deletions;
          } catch {
            /* sin stats */
          }
          statsCalls++;
        }

        await supabase.from('commit').upsert(
          {
            sha,
            repo,
            project_id: link.project_id,
            dev_id: devId,
            author_login: item.author?.login ?? null,
            author_email: item.commit?.author?.email ?? null,
            message: item.commit?.message ?? '',
            url: item.html_url ?? null,
            additions,
            deletions,
            committed_at: item.commit?.author?.date ?? null,
          },
          { onConflict: 'repo,sha' },
        );
        total++;
        repoCount++;
      }
      if (list.length < 100) break;
      page++;
    }
    if (repoCount) console.log(`  ${repo}: ${repoCount} commits`);
  }

  console.log(`\nTotal: ${total} commits | atribuidos a un dev: ${attributed} | con stats: ${statsCalls}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
