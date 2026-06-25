// GitHub = fuente de verdad del código. roz solo lee (commits/PRs) para reconciliar;
// la integración nativa Linear<->GitHub ya enlaza por branch/magic words, así que roz
// NO reimplementa eso — solo procesa el trabajo huérfano.
import { config } from '../config.js';

const API = 'https://api.github.com';

/** Codifica un "owner/name" por segmento (preserva el `/` del path, evita traversal). */
function encRepo(repo: string): string {
  return repo.split('/').map(encodeURIComponent).join('/');
}

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${config.github.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export interface CommitMeta {
  sha: string;
  message: string;
  url: string;
  author: string | null; // login de GitHub (si se resolvió)
  authorEmail: string | null; // email del autor del commit (git config) — match más confiable
  committedAt: string | null; // fecha del commit (ISO), para métricas time-series del dashboard
  additions: number | null; // líneas agregadas (stats de la API)
  deletions: number | null; // líneas eliminadas
  // Un merge commit (≥2 padres) trae en sus stats el diff COMBINADO de la rama que entra, lo que
  // recontaría líneas ya atribuidas a los commits individuales. Se marca para no contar sus líneas.
  isMerge: boolean;
}

export async function getCommit(repo: string, sha: string): Promise<CommitMeta> {
  const data = await gh<{
    sha: string;
    html_url: string;
    commit: { message: string; author?: { email?: string; date?: string } };
    author: { login: string } | null;
    stats?: { additions?: number; deletions?: number };
    parents?: unknown[];
  }>(`/repos/${encRepo(repo)}/commits/${sha}`);
  return {
    sha: data.sha,
    message: data.commit.message,
    url: data.html_url,
    author: data.author?.login ?? null,
    authorEmail: data.commit.author?.email ?? null,
    committedAt: data.commit.author?.date ?? null,
    additions: data.stats?.additions ?? null,
    deletions: data.stats?.deletions ?? null,
    isMerge: (data.parents?.length ?? 0) >= 2,
  };
}

export interface RepoCommitListItem {
  sha: string;
  message: string;
  url: string;
  authorLogin: string | null; // login de GitHub (si el email del commit está enlazado a una cuenta)
  authorEmail: string | null; // email de git (match de dev más confiable)
  committedAt: string | null;
  isMerge: boolean; // ≥2 padres → no es trabajo nuevo (no cuenta líneas)
}

/**
 * Commits de la RAMA POR DEFECTO desde `sinceISO` (una página de 100). Para backfill del historial:
 * el endpoint de listado NO trae stats (additions/deletions) —esas requieren un GET por sha—, pero
 * sí trae `parents` para descartar merges sin una llamada extra. La lista omite ramas no mergeadas
 * (default branch), igual que el conteo en vivo. Devuelve [] en 404 (repo sin acceso).
 */
export async function listRepoCommits(repo: string, sinceISO: string, page = 1): Promise<RepoCommitListItem[]> {
  const data = await gh<
    {
      sha: string;
      html_url: string;
      commit: { message: string; author?: { email?: string; date?: string } };
      author: { login?: string } | null;
      parents?: unknown[];
    }[]
  >(`/repos/${encRepo(repo)}/commits?since=${encodeURIComponent(sinceISO)}&per_page=100&page=${page}`).catch((e) => {
    if (String(e).includes('404')) return [] as never[];
    throw e;
  });
  return data.map((d) => ({
    sha: d.sha,
    message: d.commit.message,
    url: d.html_url,
    authorLogin: d.author?.login ?? null,
    authorEmail: d.commit.author?.email ?? null,
    committedAt: d.commit.author?.date ?? null,
    isMerge: (d.parents?.length ?? 0) >= 2,
  }));
}

export interface RepoMeta {
  fullName: string; // "owner/name"
  name: string; // solo el nombre del repo (sin owner)
  description: string | null;
  url: string; // html_url
}

/** Metadata del repo (para matching de proyecto y el correo de detección). */
export async function getRepo(repo: string): Promise<RepoMeta> {
  const d = await gh<{ full_name: string; name: string; description: string | null; html_url: string }>(
    `/repos/${encRepo(repo)}`,
  );
  return { fullName: d.full_name, name: d.name, description: d.description ?? null, url: d.html_url };
}

/** Heurística barata: ¿el mensaje del commit referencia un issue de Linear (ABC-123)? */
export function referencesLinearIssue(message: string): string | null {
  const m = message.match(/\b([A-Z]{2,}-\d+)\b/);
  return m ? m[1]! : null;
}

export interface PullRequestMeta {
  number: number;
  title: string;
  body: string | null;
  url: string;
  headRef: string | null; // rama de origen (para detectar referencia a Linear, p.ej. "feat/HYP-12")
  baseRef: string | null; // rama destino
  merged: boolean;
  mergeCommitSha: string | null;
  authorLogin: string | null; // quién abrió la PR
  mergedByLogin: string | null; // quién la mergeó (solo existe a nivel de PR, no del commit)
}

/** Metadata de una PR (autor, quién mergeó, ramas). El "quién mergeó" solo vive aquí. */
export async function getPullRequest(repo: string, number: number): Promise<PullRequestMeta> {
  const d = await gh<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    merged: boolean;
    merge_commit_sha: string | null;
    head: { ref?: string } | null;
    base: { ref?: string } | null;
    user: { login?: string } | null;
    merged_by: { login?: string } | null;
  }>(`/repos/${encRepo(repo)}/pulls/${number}`);
  return {
    number: d.number,
    title: d.title,
    body: d.body ?? null,
    url: d.html_url,
    headRef: d.head?.ref ?? null,
    baseRef: d.base?.ref ?? null,
    merged: !!d.merged,
    mergeCommitSha: d.merge_commit_sha ?? null,
    authorLogin: d.user?.login ?? null,
    mergedByLogin: d.merged_by?.login ?? null,
  };
}

export interface PrAuthor {
  login: string | null;
  email: string | null;
}

/** Autores reales de los commits de una PR (puede haber varios), deduplicados. */
export async function listPullRequestCommits(repo: string, number: number): Promise<PrAuthor[]> {
  const data = await gh<
    { author: { login?: string } | null; commit: { author?: { email?: string } } }[]
  >(`/repos/${encRepo(repo)}/pulls/${number}/commits?per_page=100`);
  const seen = new Set<string>();
  const out: PrAuthor[] = [];
  for (const c of data) {
    const login = c.author?.login ?? null;
    const email = c.commit?.author?.email ?? null;
    const key = `${login ?? ''}|${email ?? ''}`;
    if (key === '|' || seen.has(key)) continue;
    seen.add(key);
    out.push({ login, email });
  }
  return out;
}

export interface PrReview {
  login: string | null;
  state: string; // approved | changes_requested | commented | dismissed | pending
}

/** Revisiones de una PR. Se queda con el ÚLTIMO estado por revisor (el que cuenta). */
export async function listPullRequestReviews(repo: string, number: number): Promise<PrReview[]> {
  const data = await gh<{ user: { login?: string } | null; state: string }[]>(
    `/repos/${encRepo(repo)}/pulls/${number}/reviews?per_page=100`,
  );
  const latest = new Map<string, string>(); // login -> state (las reviews llegan en orden cronológico)
  for (const r of data) {
    const login = r.user?.login;
    if (!login) continue;
    latest.set(login, (r.state ?? '').toLowerCase());
  }
  return [...latest.entries()].map(([login, state]) => ({ login, state }));
}

export interface AssociatedPr {
  number: number;
  merged: boolean;
  state: string; // open | closed
}

/**
 * Todos los SHAs que introduce un push (rango `before...after`), vía la API de compare. Se usa
 * cuando el webhook de push pudo venir truncado: GitHub limita el array `commits` del push a 20,
 * así que para un merge de PR con más commits hay que enumerar el rango aquí. La API de compare
 * calcula el conjunto real (no un recorrido por fecha), así que cubre bien historiales no lineales
 * y merges. Tope práctico ~250 (límite de compare); de sobra para un PR normal.
 */
export async function pushCommitShas(repo: string, before: string, after: string): Promise<string[]> {
  const shas: string[] = [];
  let page = 1;
  for (;;) {
    const d = await gh<{ total_commits?: number; commits?: { sha: string }[] }>(
      `/repos/${encRepo(repo)}/compare/${before}...${after}?per_page=100&page=${page}`,
    );
    const batch = d.commits ?? [];
    for (const c of batch) shas.push(c.sha);
    if (batch.length < 100 || shas.length >= (d.total_commits ?? shas.length)) break;
    page++;
    if (page > 5) break; // 5×100 = 500, muy por encima del cap de la API de compare
  }
  return shas;
}

/** PRs asociadas a un commit. Permite deduplicar: si un commit pertenece a una PR, lo documenta
 *  el flujo de PR (no el de commit), sin importar la estrategia de merge (squash/merge/rebase). */
export async function commitPullRequests(repo: string, sha: string): Promise<AssociatedPr[]> {
  const data = await gh<{ number: number; merged_at: string | null; state: string }[]>(
    `/repos/${encRepo(repo)}/commits/${sha}/pulls?per_page=20`,
  );
  return data.map((p) => ({ number: p.number, merged: !!p.merged_at, state: p.state }));
}
