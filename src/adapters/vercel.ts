// Adapter de Vercel (REST). Lee los últimos deploys de producción de un proyecto + metadatos del
// proyecto (framework, dominio de producción). Solo lectura, incluido en cualquier plan: NO usa
// Web Analytics (de pago, sin API de lectura). El conteo de peticiones/bandwidth vive en
// /billing/charges (nuevo, poco documentado) → de momento metrics queda null.
import { config } from '../config.js';
import { degraded, type ServiceProbe, type ServiceStatus } from '../infra/types.js';

const BASE = 'https://api.vercel.com';

function mapState(state: string | undefined): ServiceStatus {
  switch ((state ?? '').toUpperCase()) {
    case 'READY':
      return 'healthy';
    case 'ERROR':
      return 'down';
    case 'BUILDING':
    case 'QUEUED':
    case 'INITIALIZING':
      return 'degraded';
    case 'CANCELED':
    case 'DELETED':
      return 'unknown';
    default:
      return 'unknown';
  }
}

interface VercelDeployment {
  url?: string;
  state?: string;
  readyState?: string;
  created?: number;
  buildingAt?: number;
  ready?: number;
  meta?: {
    githubCommitSha?: string;
    githubCommitRef?: string;
    githubCommitMessage?: string;
    githubCommitAuthorName?: string;
    githubCommitAuthorLogin?: string;
    githubCommitRepo?: string;
  };
}

/** Sondea un proyecto de Vercel. `ref` = projectId; cfg.teamId override del team por defecto. */
export async function probeVercel(ref: string, cfg: Record<string, unknown> = {}): Promise<ServiceProbe> {
  if (!config.vercel.token) return degraded('VERCEL_API_TOKEN no configurado');
  const teamId = (cfg.teamId as string) || config.vercel.teamId;
  const auth = { authorization: `Bearer ${config.vercel.token}` };
  const team = teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';

  try {
    const res = await fetch(`${BASE}/v6/deployments?projectId=${encodeURIComponent(ref)}&target=production&limit=5${team}`, { headers: auth });
    if (!res.ok) return degraded(`Vercel ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    const json = (await res.json()) as { deployments?: VercelDeployment[] };
    const deps = json.deployments ?? [];
    const d = deps[0];

    // Metadatos del proyecto (framework + dominio de producción), best-effort.
    let framework: string | null = null;
    let productionUrl: string | null = null;
    try {
      const pRes = await fetch(`${BASE}/v9/projects/${encodeURIComponent(ref)}?${team.slice(1)}`, { headers: auth });
      if (pRes.ok) {
        const p = (await pRes.json()) as { framework?: string; targets?: { production?: { alias?: string[] } } };
        framework = p.framework ?? null;
        const alias = p.targets?.production?.alias?.find((a) => !a.includes('-git-')) ?? p.targets?.production?.alias?.[0];
        productionUrl = alias ? `https://${alias}` : null;
      }
    } catch {
      /* opcional */
    }

    if (!d) {
      return { ok: true, status: 'unknown', providerStatus: null, active: false, deploy: null, metrics: null, details: { framework, productionUrl, recent: [] }, error: null };
    }

    const state = d.state ?? d.readyState;
    const status = mapState(state);
    const durationMs = d.ready && d.buildingAt ? d.ready - d.buildingAt : null;
    return {
      ok: true,
      status,
      providerStatus: state ?? null,
      active: status === 'healthy',
      deploy: {
        state: state ?? 'UNKNOWN',
        url: productionUrl ?? (d.url ? `https://${d.url}` : null),
        sha: d.meta?.githubCommitSha ?? null,
        createdAt: d.created ? new Date(d.created).toISOString() : null,
        commitMessage: d.meta?.githubCommitMessage ?? null,
        branch: d.meta?.githubCommitRef ?? null,
        author: d.meta?.githubCommitAuthorLogin ?? d.meta?.githubCommitAuthorName ?? null,
        repo: d.meta?.githubCommitRepo ?? null,
        durationMs,
      },
      metrics: null,
      details: {
        framework,
        productionUrl,
        recent: deps.map((x) => ({ state: x.state ?? x.readyState ?? 'UNKNOWN', sha: x.meta?.githubCommitSha ?? null, createdAt: x.created ? new Date(x.created).toISOString() : null })),
      },
      error: null,
    };
  } catch (err) {
    return degraded(`Vercel: ${String(err)}`);
  }
}
