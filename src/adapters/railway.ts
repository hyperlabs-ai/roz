// Adapter de Railway (GraphQL, no hay REST). Lee los últimos deploys de un servicio + metadatos
// (commit, réplicas, región, runtime). Solo lectura, incluido en todos los planes. Las métricas de
// recursos (CPU/mem/red) existen y son gratis pero la firma del query `metrics` no está documentada
// → se deja para una iteración posterior.
import { config } from '../config.js';
import { degraded, type ServiceProbe, type ServiceStatus } from '../infra/types.js';

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';

function mapStatus(s: string | undefined): ServiceStatus {
  switch ((s ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'healthy';
    case 'FAILED':
    case 'CRASHED':
      return 'down';
    case 'INITIALIZING':
    case 'BUILDING':
    case 'DEPLOYING':
    case 'WAITING':
    case 'QUEUED':
      return 'degraded';
    case 'SLEEPING':
      return 'paused';
    default:
      return 'unknown';
  }
}

const QUERY = `
  query Deployments($serviceId: String!, $environmentId: String) {
    deployments(first: 5, input: { serviceId: $serviceId, environmentId: $environmentId }) {
      edges { node { status createdAt staticUrl url meta } }
    }
  }
`;

interface RailwayMeta {
  repo?: string;
  branch?: string;
  commitHash?: string;
  commitAuthor?: string;
  commitMessage?: string;
  plan?: string;
  serviceManifest?: { deploy?: { numReplicas?: number; multiRegionConfig?: Record<string, unknown> } };
  railpackInfo?: { metadata?: Record<string, string> };
}
interface RailwayNode {
  status?: string;
  createdAt?: string;
  staticUrl?: string;
  url?: string;
  meta?: RailwayMeta;
}

function runtimeOf(meta: RailwayMeta | undefined): string | null {
  const m = meta?.railpackInfo?.metadata;
  if (!m) return null;
  return [m.providers, m.pythonRuntime, m.nodeRuntime].filter(Boolean).join(' · ') || null;
}

/** Sondea un servicio de Railway. `ref` = serviceId; cfg.environmentId opcional. */
export async function probeRailway(ref: string, cfg: Record<string, unknown> = {}): Promise<ServiceProbe> {
  if (!config.railway.token) return degraded('RAILWAY_API_TOKEN no configurado');
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.railway.token}` },
      body: JSON.stringify({ query: QUERY, variables: { serviceId: ref, environmentId: (cfg.environmentId as string) ?? null } }),
    });
    const json = (await res.json()) as { data?: { deployments?: { edges?: { node: RailwayNode }[] } }; errors?: unknown };
    if (!res.ok || json.errors) return degraded(`Railway: ${JSON.stringify(json.errors ?? res.statusText)}`);
    const edges = json.data?.deployments?.edges ?? [];
    const node = edges[0]?.node;
    if (!node) {
      return { ok: true, status: 'unknown', providerStatus: null, active: false, deploy: null, metrics: null, details: { recent: [] }, error: null };
    }
    const status = mapStatus(node.status);
    const m = node.meta;
    const deploy = m?.serviceManifest?.deploy;
    const regions = deploy?.multiRegionConfig ? Object.keys(deploy.multiRegionConfig) : [];
    return {
      ok: true,
      status,
      providerStatus: node.status ?? null,
      active: status === 'healthy',
      deploy: {
        state: node.status ?? 'UNKNOWN',
        url: node.staticUrl ? `https://${node.staticUrl}` : node.url ?? null,
        sha: m?.commitHash ?? null,
        createdAt: node.createdAt ?? null,
        commitMessage: m?.commitMessage?.split('\n')[0] ?? null,
        branch: m?.branch ?? null,
        author: m?.commitAuthor ?? null,
        repo: m?.repo ?? null,
        durationMs: null,
      },
      metrics: null,
      details: {
        replicas: deploy?.numReplicas ?? null,
        region: regions.join(', ') || null,
        runtime: runtimeOf(m),
        plan: m?.plan ?? null,
        recent: edges.map((e) => ({ state: e.node.status ?? 'UNKNOWN', sha: e.node.meta?.commitHash ?? null, createdAt: e.node.createdAt ?? null })),
      },
      error: null,
    };
  } catch (err) {
    return degraded(`Railway: ${String(err)}`);
  }
}
