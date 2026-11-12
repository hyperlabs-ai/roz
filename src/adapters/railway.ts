// Adapter de Railway (GraphQL, no hay REST). Lee los últimos deploys de un servicio + metadatos
// (commit, réplicas, región, runtime). Solo lectura, incluido en todos los planes. Las métricas de
// recursos (CPU/mem/red) existen y son gratis pero la firma del query `metrics` no está documentada
// → se deja para una iteración posterior.
//
// Salud del servicio ≠ resultado del último deploy. En Railway, al entrar un deploy nuevo el
// anterior pasa a REMOVED; si el nuevo FALLA al construir, el anterior se queda en SUCCESS y sigue
// atendiendo. Por eso la salud sale del deploy ACTIVO (SUCCESS / SLEEPING / CRASHED), no del último.
import { config } from '../config.js';
import {
  degraded,
  pickLogTail,
  type DeployRef,
  type DeployState,
  type FailureInfo,
  type ProbeHint,
  type ServiceProbe,
  type ServiceStatus,
} from '../infra/types.js';

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const TIMEOUT = 8_000;

export function railwayDeployState(s: string | undefined): DeployState {
  switch ((s ?? '').toUpperCase()) {
    case 'SUCCESS':
    case 'SLEEPING':
      return 'ready';
    case 'FAILED':
    case 'CRASHED':
      return 'failed';
    case 'INITIALIZING':
    case 'BUILDING':
    case 'DEPLOYING':
    case 'WAITING':
    case 'QUEUED':
    case 'NEEDS_APPROVAL':
      return 'building';
    case 'REMOVED':
    case 'REMOVING':
    case 'SKIPPED':
      return 'canceled';
    default:
      return 'unknown';
  }
}

/** Estados en los que un deploy es (o era) el que atiende el servicio. */
const ACTIVE = new Set(['SUCCESS', 'SLEEPING', 'CRASHED']);

const QUERY = `
  query Deployments($serviceId: String!, $environmentId: String) {
    deployments(first: 10, input: { serviceId: $serviceId, environmentId: $environmentId }) {
      edges { node { id status createdAt statusUpdatedAt staticUrl url meta } }
    }
  }
`;
const BUILD_LOGS = `query Logs($id: String!) { buildLogs(deploymentId: $id, limit: 300) { message severity } }`;
const DEPLOY_LOGS = `query Logs($id: String!) { deploymentLogs(deploymentId: $id, limit: 300) { message severity } }`;

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
export interface RailwayNode {
  id?: string;
  status?: string;
  createdAt?: string;
  statusUpdatedAt?: string;
  staticUrl?: string;
  url?: string;
  meta?: RailwayMeta;
}

function runtimeOf(meta: RailwayMeta | undefined): string | null {
  const m = meta?.railpackInfo?.metadata;
  if (!m) return null;
  return [m.providers, m.pythonRuntime, m.nodeRuntime].filter(Boolean).join(' · ') || null;
}

export function railwayDeployRef(n: RailwayNode): DeployRef {
  const native = (n.status ?? 'UNKNOWN').toUpperCase();
  // Railway no expone el tiempo de build. Para un intento que terminó (bien o mal) y sigue siendo
  // el último cambio de estado, createdAt→statusUpdatedAt es lo que tardó; en los demás estados
  // (REMOVED, CRASHED, SLEEPING) esa marca es de otra cosa y no se usa.
  let durationMs: number | null = null;
  if ((native === 'FAILED' || native === 'SUCCESS') && n.createdAt && n.statusUpdatedAt) {
    const ms = new Date(n.statusUpdatedAt).getTime() - new Date(n.createdAt).getTime();
    if (ms > 0 && ms < 2 * 3_600_000) durationMs = ms;
  }
  return {
    id: n.id ?? null,
    state: railwayDeployState(native),
    nativeState: native,
    sha: n.meta?.commitHash ?? null,
    branch: n.meta?.branch ?? null,
    message: typeof n.meta?.commitMessage === 'string' ? (n.meta.commitMessage.split('\n')[0] ?? null) : null,
    author: n.meta?.commitAuthor ?? null,
    createdAt: n.createdAt ?? null,
    durationMs,
    url: n.staticUrl ? `https://${n.staticUrl}` : n.url ?? null,
    inspectorUrl: null,
  };
}

/**
 * Salud del servicio a partir de la lista de deploys (más reciente primero). Pura, para probarla.
 * `active` = el deploy que atiende (o atendía hasta caerse); null si no hay ninguno.
 */
export function railwayServiceStatus(nodes: RailwayNode[]): { status: ServiceStatus; active: RailwayNode | null } {
  const active = nodes.find((n) => ACTIVE.has((n.status ?? '').toUpperCase())) ?? null;
  if (active) {
    const s = (active.status ?? '').toUpperCase();
    return { status: s === 'SUCCESS' ? 'healthy' : s === 'SLEEPING' ? 'paused' : 'down', active };
  }
  const latest = nodes[0];
  if (!latest) return { status: 'unknown', active: null };
  const st = railwayDeployState(latest.status);
  // Sin ningún deploy activo: si el único intento falló no hay nada sirviendo.
  return { status: st === 'failed' ? 'down' : st === 'building' ? 'degraded' : 'unknown', active: null };
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.railway.token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const json = (await res.json().catch(() => null)) as { data?: T; errors?: unknown } | null;
  if (!res.ok || !json || json.errors) return null;
  return json.data ?? null;
}

/** Cola del log del deploy que falló: de build si no llegó a arrancar, de ejecución si tronó. */
async function fetchFailure(n: RailwayNode): Promise<FailureInfo> {
  const crashed = (n.status ?? '').toUpperCase() === 'CRASHED';
  const out: FailureInfo = {
    scope: crashed ? 'runtime' : 'deploy',
    deployId: n.id ?? null,
    step: crashed ? 'ejecución' : 'build',
    code: null,
    message: null,
    logTail: [],
    helpUrl: null,
  };
  if (!n.id) return out;
  try {
    type Log = { message?: string; severity?: string };
    const data = await gql<{ buildLogs?: Log[]; deploymentLogs?: Log[] }>(crashed ? DEPLOY_LOGS : BUILD_LOGS, { id: n.id });
    const logs = (crashed ? data?.deploymentLogs : data?.buildLogs) ?? [];
    // Railway marca la severidad: si hay líneas de error, son la causa; si no, la cola tal cual.
    const errs = logs.filter((l) => /err|fatal|crit/i.test(l.severity ?? '')).map((l) => l.message ?? '');
    out.logTail = pickLogTail(errs.length ? errs : logs.map((l) => l.message ?? ''));
    out.message = out.logTail[out.logTail.length - 1] ?? null;
  } catch {
    /* los logs son opcionales */
  }
  return out;
}

/** Sondea un servicio de Railway. `ref` = serviceId; cfg.environmentId opcional. */
export async function probeRailway(ref: string, cfg: Record<string, unknown> = {}, hint: ProbeHint = {}): Promise<ServiceProbe> {
  if (!config.railway.token) return degraded('RAILWAY_API_TOKEN no configurado');
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.railway.token}` },
      body: JSON.stringify({ query: QUERY, variables: { serviceId: ref, environmentId: (cfg.environmentId as string) ?? null } }),
    });
    const json = (await res.json()) as { data?: { deployments?: { edges?: { node: RailwayNode }[] } }; errors?: unknown };
    if (!res.ok || json.errors) return degraded(`Railway: ${JSON.stringify(json.errors ?? res.statusText)}`);
    const nodes = (json.data?.deployments?.edges ?? []).map((e) => e.node);
    const node = nodes[0];
    if (!node) {
      return { ok: true, status: 'unknown', providerStatus: null, active: false, deploy: null, metrics: null, details: { recent: [], lastDeploy: null, serving: null, failure: null }, error: null };
    }
    const { status, active } = railwayServiceStatus(nodes);
    const latest = railwayDeployRef(node);
    const activeState = (active?.status ?? '').toUpperCase();
    // "Sirviendo" solo si de verdad atiende: un deploy CRASHED era el activo pero ya no sirve.
    const serving = active && activeState !== 'CRASHED' ? railwayDeployRef(active) : null;

    // Qué explicar: el proceso caído manda sobre un build fallido; si no, el último intento.
    const failedNode = activeState === 'CRASHED' ? active! : latest.state === 'failed' ? node : null;
    let failure: FailureInfo | null = null;
    if (failedNode) {
      failure = hint.failure?.deployId && hint.failure.deployId === failedNode.id ? hint.failure : await fetchFailure(failedNode);
    }

    // Metadatos del servicio: del deploy activo si hay (es lo que corre), si no del último.
    const m = (active ?? node).meta;
    const deploy = m?.serviceManifest?.deploy;
    const regions = deploy?.multiRegionConfig ? Object.keys(deploy.multiRegionConfig) : [];
    return {
      ok: true,
      status,
      providerStatus: (active ?? node).status ?? null,
      active: status === 'healthy',
      deploy: {
        state: latest.nativeState,
        url: (serving ?? latest).url,
        sha: latest.sha,
        createdAt: latest.createdAt,
        commitMessage: latest.message,
        branch: latest.branch,
        author: latest.author,
        repo: node.meta?.repo ?? null,
        durationMs: latest.durationMs,
      },
      metrics: null,
      details: {
        replicas: deploy?.numReplicas ?? null,
        region: regions.join(', ') || null,
        runtime: runtimeOf(m),
        plan: m?.plan ?? null,
        recent: nodes.slice(0, 8).map((n) => ({ state: n.status ?? 'UNKNOWN', sha: n.meta?.commitHash ?? null, createdAt: n.createdAt ?? null })),
        lastDeploy: latest,
        serving,
        failure,
      },
      error: null,
    };
  } catch (err) {
    return degraded(`Railway: ${String(err)}`);
  }
}
