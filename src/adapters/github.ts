// GitHub = fuente de verdad del código. roz solo lee (commits/PRs) para reconciliar;
// la integración nativa Linear<->GitHub ya enlaza por branch/magic words, así que roz
// NO reimplementa eso — solo procesa el trabajo huérfano.
import { config } from '../config.js';

const API = 'https://api.github.com';

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
}

export async function getCommit(repo: string, sha: string): Promise<CommitMeta> {
  const data = await gh<{
    sha: string;
    html_url: string;
    commit: { message: string; author?: { email?: string; date?: string } };
    author: { login: string } | null;
    stats?: { additions?: number; deletions?: number };
  }>(`/repos/${repo}/commits/${sha}`);
  return {
    sha: data.sha,
    message: data.commit.message,
    url: data.html_url,
    author: data.author?.login ?? null,
    authorEmail: data.commit.author?.email ?? null,
    committedAt: data.commit.author?.date ?? null,
    additions: data.stats?.additions ?? null,
    deletions: data.stats?.deletions ?? null,
  };
}

/** Heurística barata: ¿el mensaje del commit referencia un issue de Linear (ABC-123)? */
export function referencesLinearIssue(message: string): string | null {
  const m = message.match(/\b([A-Z]{2,}-\d+)\b/);
  return m ? m[1]! : null;
}
