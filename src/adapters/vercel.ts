// Adapter de Vercel (REST). Lee los últimos deploys de producción de un proyecto + metadatos del
// proyecto (framework, dominio de producción, deploy que está sirviendo). Solo lectura, incluido
// en cualquier plan: NO usa Web Analytics (de pago, sin API de lectura). El conteo de
// peticiones/bandwidth vive en /billing/charges (nuevo, poco documentado) → metrics queda null.
//
// Salud del servicio ≠ resultado del último deploy: en Vercel un build que falla NO sustituye al
// deploy que atiende el dominio. El servicio solo está 'down' si no hay ningún deploy sirviendo.
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

const BASE = 'https://api.vercel.com';
const TIMEOUT = 8_000;

export function vercelDeployState(state: string | undefined): DeployState {
  switch ((state ?? '').toUpperCase()) {
    case 'READY':
      return 'ready';
    case 'ERROR':
      return 'failed';
    case 'BUILDING':
    case 'QUEUED':
    case 'INITIALIZING':
      return 'building';
    case 'CANCELED':
    case 'DELETED':
      return 'canceled';
    default:
      return 'unknown';
  }
}

export interface VercelDeployment {
  uid?: string;
  id?: string;
  url?: string;
  state?: string;
  readyState?: string;
  created?: number;
  createdAt?: number;
  buildingAt?: number;
  ready?: number;
  readyAt?: number;
  inspectorUrl?: string;
  errorMessage?: string;
  errorCode?: string;
  errorStep?: string;
  errorLink?: string;
  readyStateReason?: string;
  meta?: {
    githubCommitSha?: string;
    githubCommitRef?: string;
    githubCommitMessage?: string;
    githubCommitAuthorName?: string;
    githubCommitAuthorLogin?: string;
    githubCommitRepo?: string;
  };
}

export function vercelDeployRef(d: VercelDeployment): DeployRef {
  const native = d.state ?? d.readyState ?? 'UNKNOWN';
  const created = d.created ?? d.createdAt ?? null;
  const ready = d.ready ?? d.readyAt ?? null;
  // Un deploy bloqueado antes de construir trae ready === buildingAt: 0 ms no es una duración real.
  const dur = ready && d.buildingAt && ready > d.buildingAt ? ready - d.buildingAt : null;
  return {
    id: d.uid ?? d.id ?? null,
    state: vercelDeployState(native),
    nativeState: native,
    sha: d.meta?.githubCommitSha ?? null,
    branch: d.meta?.githubCommitRef ?? null,
    message: d.meta?.githubCommitMessage?.split('\n')[0] ?? null,
    author: d.meta?.githubCommitAuthorLogin ?? d.meta?.githubCommitAuthorName ?? null,
    createdAt: created ? new Date(created).toISOString() : null,
    durationMs: dur,
    url: d.url ? `https://${d.url}` : null,
    inspectorUrl: d.inspectorUrl ?? null,
  };
}

/**
 * Decide la salud del servicio a partir del último intento y del deploy que sirve producción.
 * Pura (sin red) para poder probarla.
 */
export function vercelServiceStatus(input: { latest: DeployRef | null; serving: DeployRef | null; paused?: boolean }): ServiceStatus {
  if (input.paused) return 'paused';
  if (input.serving) return 'healthy';
  if (!input.latest) return 'unknown';
  // Nada sirviendo producción: el estado lo decide el único intento que hay.
  if (input.latest.state === 'failed') return 'down';
  if (input.latest.state === 'building') return 'degraded';
  return 'unknown';
}

interface VercelEvent {
  type?: string;
  text?: string;
  payload?: { text?: string };
}

/** Causa de un deploy fallido: campos de error del deployment + cola del log de build. */
async function fetchFailure(d: VercelDeployment, auth: Record<string, string>, teamQs: string): Promise<FailureInfo> {
  const id = d.uid ?? d.id ?? null;
  const out: FailureInfo = {
    scope: 'deploy',
    deployId: id,
    step: d.errorStep ?? null,
    code: d.errorCode ?? null,
    message: d.errorMessage ?? d.readyStateReason ?? null,
    logTail: [],
    helpUrl: d.errorLink ?? null,
  };
  if (!id) return out;
  try {
    const res = await fetch(`${BASE}/v13/deployments/${encodeURIComponent(id)}?${teamQs}`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT) });
    if (res.ok) {
      const full = (await res.json()) as VercelDeployment;
      out.step = full.errorStep ?? out.step;
      out.code = full.errorCode ?? out.code;
      out.message = full.errorMessage ?? full.readyStateReason ?? out.message;
      out.helpUrl = full.errorLink ?? out.helpUrl;
    }
  } catch {
    /* el detalle es opcional */
  }
  try {
    const res = await fetch(`${BASE}/v3/deployments/${encodeURIComponent(id)}/events?builds=1&limit=-1&${teamQs}`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT) });
    if (res.ok) {
      const ev = (await res.json()) as unknown;
      if (Array.isArray(ev)) {
        const lines = (ev as VercelEvent[])
          .filter((e) => e.type === 'stdout' || e.type === 'stderr' || e.type === 'fatal' || e.type === 'command')
          .map((e) => e.text ?? e.payload?.text ?? '');
        out.logTail = pickLogTail(lines.slice(-400));
      }
    }
  } catch {
    /* los logs son opcionales */
  }
  return out;
}

/** Sondea un proyecto de Vercel. `ref` = projectId; cfg.teamId override del team por defecto. */
export async function probeVercel(ref: string, cfg: Record<string, unknown> = {}, hint: ProbeHint = {}): Promise<ServiceProbe> {
  if (!config.vercel.token) return degraded('VERCEL_API_TOKEN no configurado');
  const teamId = (cfg.teamId as string) || config.vercel.teamId;
  const auth = { authorization: `Bearer ${config.vercel.token}` };
  const teamQs = teamId ? `teamId=${encodeURIComponent(teamId)}` : '';
  const team = teamQs ? `&${teamQs}` : '';

  try {
    const res = await fetch(`${BASE}/v6/deployments?projectId=${encodeURIComponent(ref)}&target=production&limit=10${team}`, { headers: auth });
    if (!res.ok) return degraded(`Vercel ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    const json = (await res.json()) as { deployments?: VercelDeployment[] };
    const deps = json.deployments ?? [];
    const d = deps[0];

    // Metadatos del proyecto (framework, dominio y el deploy que atiende producción), best-effort.
    let framework: string | null = null;
    let productionUrl: string | null = null;
    let paused = false;
    let prodTarget: (VercelDeployment & { alias?: string[] }) | null = null;
    try {
      const pRes = await fetch(`${BASE}/v9/projects/${encodeURIComponent(ref)}?${teamQs}`, { headers: auth });
      if (pRes.ok) {
        const p = (await pRes.json()) as { framework?: string; paused?: boolean; targets?: { production?: VercelDeployment & { alias?: string[] } } };
        framework = p.framework ?? null;
        paused = p.paused === true;
        prodTarget = p.targets?.production ?? null;
        const alias = prodTarget?.alias?.find((a) => !a.includes('-git-')) ?? prodTarget?.alias?.[0];
        productionUrl = alias ? `https://${alias}` : null;
      }
    } catch {
      /* opcional */
    }

    // El que sirve: lo que el proyecto declara como producción (respeta rollbacks/promociones);
    // si no vino, el deploy READY más reciente de la lista.
    const prodReady = prodTarget && (prodTarget.readyState ?? prodTarget.state ?? '').toUpperCase() === 'READY' ? prodTarget : null;
    const prodId = prodReady ? prodReady.id ?? prodReady.uid ?? null : null;
    const servingRaw =
      (prodId ? deps.find((x) => (x.uid ?? x.id) === prodId) : undefined) ??
      prodReady ??
      deps.find((x) => vercelDeployState(x.state ?? x.readyState) === 'ready') ??
      null;
    const serving = servingRaw ? vercelDeployRef(servingRaw) : null;
    const latest = d ? vercelDeployRef(d) : serving;

    const status = vercelServiceStatus({ latest, serving, paused });
    if (!latest) {
      return {
        ok: true,
        status,
        providerStatus: paused ? 'PAUSED' : null,
        active: false,
        deploy: null,
        metrics: null,
        details: { framework, productionUrl, recent: [], lastDeploy: null, serving: null, failure: null },
        error: null,
      };
    }

    let failure: FailureInfo | null = null;
    if (latest.state === 'failed' && d) {
      failure = hint.failure?.deployId && hint.failure.deployId === latest.id ? hint.failure : await fetchFailure(d, auth, teamQs);
    }

    return {
      ok: true,
      status,
      providerStatus: paused ? 'PAUSED' : (serving ?? latest).nativeState,
      active: status === 'healthy',
      // `deploy` sigue siendo el ÚLTIMO intento (compatibilidad con lo ya guardado).
      deploy: {
        state: latest.nativeState,
        url: productionUrl ?? latest.url,
        sha: latest.sha,
        createdAt: latest.createdAt,
        commitMessage: latest.message,
        branch: latest.branch,
        author: latest.author,
        repo: d?.meta?.githubCommitRepo ?? null,
        durationMs: latest.durationMs,
      },
      metrics: null,
      details: {
        framework,
        productionUrl,
        recent: deps.slice(0, 8).map((x) => ({
          state: x.state ?? x.readyState ?? 'UNKNOWN',
          sha: x.meta?.githubCommitSha ?? null,
          createdAt: x.created ? new Date(x.created).toISOString() : null,
        })),
        lastDeploy: latest,
        serving,
        failure,
      },
      error: null,
    };
  } catch (err) {
    return degraded(`Vercel: ${String(err)}`);
  }
}
