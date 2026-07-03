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
  return (await ghRes<T>(path)).data;
}

/** Igual que gh() pero devuelve también los headers (para leer el `Link` de paginación). */
async function ghRes<T>(path: string): Promise<{ data: T; headers: Headers }> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${config.github.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  return { data: (await res.json()) as T, headers: res.headers };
}

/** Nº de la última página del header `Link` (rel="last"), o null si no hay más páginas. */
function parseLastPage(link: string | null): number | null {
  if (!link) return null;
  const m = link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return m ? Number(m[1]) : null;
}

// Rutas de "trabajo no-real": dependencias, artefactos generados y lockfiles. Sus líneas NO cuentan
// como contribución (un commit que versiona node_modules metía cientos de miles de líneas basura).
// Se filtran por commit recalculando additions/deletions solo sobre los archivos que SÍ son código.
const GENERATED_DIRS = [
  'node_modules/', 'vendor/', 'dist/', 'build/', '.next/', 'out/', 'coverage/', '.venv/',
  'venv/', '__pycache__/', 'bin/', 'obj/', '.turbo/', 'target/',
];
const GENERATED_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'gemfile.lock',
  'poetry.lock', 'cargo.lock', 'go.sum', 'podfile.lock', 'flake.lock',
]);
const GENERATED_SUFFIXES = ['.lock', '.min.js', '.min.css', '.map', '.snap'];

/** ¿La ruta es de trabajo generado/dependencias (no cuenta como líneas)? Case-insensitive. */
export function isGeneratedPath(filename: string): boolean {
  const f = filename.toLowerCase();
  const base = f.split('/').pop() ?? f;
  if (GENERATED_FILES.has(base)) return true;
  if (GENERATED_SUFFIXES.some((s) => base.endsWith(s))) return true;
  // Directorio generado en cualquier nivel del path (p.ej. "apps/web/node_modules/...").
  return GENERATED_DIRS.some((d) => f.startsWith(d) || f.includes(`/${d}`));
}

/** Llama a la GraphQL API v4 (la REST v3 no expone el calendario de contribuciones). */
async function ghGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.github.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL error ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`GitHub GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
  return json.data as T;
}

export interface ContributionDay {
  date: string; // YYYY-MM-DD
  count: number;
  level: 0 | 1 | 2 | 3 | 4; // intensidad (igual que la cuadrícula del perfil)
  weekday: number; // 0=Dom … 6=Sáb (para alinear semanas parciales)
}
export interface ContributionCalendar {
  totalContributions: number;
  weeks: { days: ContributionDay[] }[]; // una columna por semana, hasta 7 días (Dom→Sáb)
}

const LEVEL: Record<string, 0 | 1 | 2 | 3 | 4> = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

/**
 * Cuadrícula de contribuciones de un usuario tal cual aparece en su perfil de GitHub, en el rango
 * [fromISO, toISO] (máx. 1 año por restricción de la API). Incluye contribuciones públicas; las
 * privadas solo si el PAT tiene visibilidad sobre ellas. Devuelve null si el usuario no existe.
 */
export async function getContributionCalendar(
  login: string,
  fromISO: string,
  toISO: string,
): Promise<ContributionCalendar | null> {
  const data = await ghGraphQL<{
    user: {
      contributionsCollection: {
        contributionCalendar: {
          totalContributions: number;
          weeks: { contributionDays: { date: string; contributionCount: number; contributionLevel: string; weekday: number }[] }[];
        };
      };
    } | null;
  }>(
    `query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount contributionLevel weekday } }
          }
        }
      }
    }`,
    { login, from: fromISO, to: toISO },
  );
  if (!data.user) return null;
  const cal = data.user.contributionsCollection.contributionCalendar;
  return {
    totalContributions: cal.totalContributions,
    weeks: cal.weeks.map((w) => ({
      days: w.contributionDays.map((d) => ({
        date: d.date,
        count: d.contributionCount,
        level: LEVEL[d.contributionLevel] ?? 0,
        weekday: d.weekday,
      })),
    })),
  };
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
  type FileEntry = { filename: string; additions?: number; deletions?: number };
  type CommitResp = {
    sha: string;
    html_url: string;
    commit: { message: string; author?: { email?: string; date?: string } };
    author: { login: string } | null;
    stats?: { additions?: number; deletions?: number };
    parents?: unknown[];
    files?: FileEntry[];
  };

  // El endpoint devuelve el desglose por archivo (`files`), paginado a 100. Un commit que versiona
  // node_modules trae miles de archivos: paginamos hasta un tope defensivo para poder filtrarlos.
  const enc = `/repos/${encRepo(repo)}/commits/${encodeURIComponent(sha)}`;
  const data = await gh<CommitResp>(`${enc}?per_page=100&page=1`);
  const files: FileEntry[] = [...(data.files ?? [])];
  const MAX_FILE_PAGES = 30; // 30×100 = 3000 archivos: de sobra para código real; acota los dumps.
  let batchLen = data.files?.length ?? 0;
  for (let page = 2; batchLen === 100 && page <= MAX_FILE_PAGES; page++) {
    const next = await gh<CommitResp>(`${enc}?per_page=100&page=${page}`);
    const batch = next.files ?? [];
    files.push(...batch);
    batchLen = batch.length;
  }

  // Recalcular líneas contando SOLO archivos que no son generados/dependencias. Si el desglose no
  // vino (caso raro), se cae a los stats totales del commit para no quedarnos sin dato.
  let additions = 0;
  let deletions = 0;
  if (data.files != null) {
    for (const f of files) {
      if (isGeneratedPath(f.filename)) continue;
      additions += f.additions ?? 0;
      deletions += f.deletions ?? 0;
    }
  } else {
    additions = data.stats?.additions ?? 0;
    deletions = data.stats?.deletions ?? 0;
  }

  return {
    sha: data.sha,
    message: data.commit.message,
    url: data.html_url,
    author: data.author?.login ?? null,
    authorEmail: data.commit.author?.email ?? null,
    committedAt: data.commit.author?.date ?? null,
    additions,
    deletions,
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
export interface RepoCommitsPage {
  items: RepoCommitListItem[];
  lastPage: number; // total de páginas (del header Link); = page actual si es la única/última.
}

export async function listRepoCommits(repo: string, sinceISO: string, page = 1): Promise<RepoCommitsPage> {
  type Row = {
    sha: string;
    html_url: string;
    commit: { message: string; author?: { email?: string; date?: string } };
    author: { login?: string } | null;
    parents?: unknown[];
  };
  let res: { data: Row[]; headers: Headers };
  try {
    res = await ghRes<Row[]>(
      `/repos/${encRepo(repo)}/commits?since=${encodeURIComponent(sinceISO)}&per_page=100&page=${page}`,
    );
  } catch (e) {
    if (String(e).includes('404')) return { items: [], lastPage: page }; // repo sin acceso
    throw e;
  }
  const items = res.data.map((d) => ({
    sha: d.sha,
    message: d.commit.message,
    url: d.html_url,
    authorLogin: d.author?.login ?? null,
    authorEmail: d.commit.author?.email ?? null,
    committedAt: d.commit.author?.date ?? null,
    isMerge: (d.parents?.length ?? 0) >= 2,
  }));
  return { items, lastPage: parseLastPage(res.headers.get('link')) ?? page };
}

/**
 * Todos los repos de la organización (full_name en minúsculas), para el autocomplete al vincular.
 * Ordenados por push reciente. Best-effort: si una página falla, corta y devuelve lo acumulado.
 */
export async function listOrgRepos(org = 'hyperlabs-ai'): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await gh<{ full_name: string }[]>(
      `/orgs/${encodeURIComponent(org)}/repos?per_page=100&sort=pushed&page=${page}`,
    ).catch(() => [] as { full_name: string }[]);
    for (const r of batch) out.push(r.full_name.toLowerCase());
    if (batch.length < 100) break;
  }
  return out;
}

export interface RepoMeta {
  githubId: number; // id numérico INMUTABLE del repo (no cambia al renombrar/transferir)
  fullName: string; // "owner/name"
  name: string; // solo el nombre del repo (sin owner)
  description: string | null;
  url: string; // html_url
}

/** Metadata del repo (para matching de proyecto y el correo de detección). */
export async function getRepo(repo: string): Promise<RepoMeta> {
  const d = await gh<{ id: number; full_name: string; name: string; description: string | null; html_url: string }>(
    `/repos/${encRepo(repo)}`,
  );
  return { githubId: d.id, fullName: d.full_name, name: d.name, description: d.description ?? null, url: d.html_url };
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
