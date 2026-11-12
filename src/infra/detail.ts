// Detalle de infraestructura para el dashboard (solo lectura).
//
// - `getServiceStrips`: franja de disponibilidad por servicio (24 segmentos de 1 h por defecto) para
//   la lista de Infraestructura. Lee `service_snapshot` crudo PAGINADO (PostgREST corta en ~1000
//   filas y con el sondeo cada 15 min hay ~96 filas por servicio y día).
// - `getServiceDetail`: el panel lateral de un servicio: historial de deploys en vivo del proveedor
//   (con respaldo en el último snapshot), disponibilidad por bloques, incidentes, último error,
//   metadatos y enlaces al proveedor.
//
// Nada aquí escribe: el estado lo sigue poniendo el cron de infra/poll.ts.
import { db } from '../db/supabase.js';
import { config } from '../config.js';
import type { DeployState, ServiceStatus } from './types.js';
import { vercelDeployState } from '../adapters/vercel.js';
import { railwayDeployState } from '../adapters/railway.js';

const HOUR = 3_600_000;
const PAGE = 1000;
const FETCH_TIMEOUT = 8_000;

interface SnapRow {
  project_service_id: string;
  captured_at: string;
  status: ServiceStatus;
}

/** Lee snapshots desde `fromIso` (opcionalmente de un servicio), página a página. */
async function snapshotsSince(fromIso: string, serviceId?: string): Promise<SnapRow[]> {
  const out: SnapRow[] = [];
  for (let off = 0; off < 50_000; off += PAGE) {
    let q = db()
      .from('service_snapshot')
      .select('project_service_id, captured_at, status')
      .gte('captured_at', fromIso)
      .order('captured_at', { ascending: true })
      .range(off, off + PAGE - 1);
    if (serviceId) q = q.eq('project_service_id', serviceId);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as unknown as SnapRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export interface UptimeSegment {
  start: string;
  status: ServiceStatus;
  /** Muestras sanas / muestras con estado real (sin 'unknown') en el bloque. */
  up: number;
  total: number;
}

/** Peor estado presente en un bloque (down > degraded > healthy > paused > unknown). */
function worst(counts: Record<ServiceStatus, number>): ServiceStatus {
  if (counts.down) return 'down';
  if (counts.degraded) return 'degraded';
  if (counts.healthy) return 'healthy';
  if (counts.paused) return 'paused';
  return 'unknown';
}

const emptyCounts = (): Record<ServiceStatus, number> => ({ healthy: 0, degraded: 0, down: 0, paused: 0, unknown: 0 });

function segmentize(rows: SnapRow[], fromMs: number, toMs: number, segments: number) {
  const width = (toMs - fromMs) / segments;
  const buckets = Array.from({ length: segments }, emptyCounts);
  let up = 0;
  let real = 0;
  for (const r of rows) {
    const t = new Date(r.captured_at).getTime();
    const i = Math.min(segments - 1, Math.floor((t - fromMs) / width));
    if (i < 0) continue;
    buckets[i]![r.status] = (buckets[i]![r.status] ?? 0) + 1;
    // Disponibilidad: sano / (sano + degradado + caído). Pausado es intencional y 'unknown' es un
    // fallo de la API del proveedor, no del servicio: ninguno de los dos cuenta.
    if (r.status === 'healthy' || r.status === 'degraded' || r.status === 'down') {
      real++;
      if (r.status === 'healthy') up++;
    }
  }
  const segs: UptimeSegment[] = buckets.map((c, i) => ({
    start: new Date(fromMs + i * width).toISOString(),
    status: worst(c),
    up: c.healthy,
    total: c.healthy + c.degraded + c.down,
  }));
  return { segments: segs, uptimePct: real ? Math.round((up / real) * 1000) / 10 : null, samples: rows.length };
}

/** Franjas de disponibilidad de TODOS los servicios: `{ [serviceId]: { segments, uptimePct } }`. */
export async function getServiceStrips(hours = 24, segments = 24) {
  const toMs = Date.now();
  const fromMs = toMs - hours * HOUR;
  const rows = await snapshotsSince(new Date(fromMs).toISOString());
  const byService = new Map<string, SnapRow[]>();
  for (const r of rows) {
    const list = byService.get(r.project_service_id);
    if (list) list.push(r);
    else byService.set(r.project_service_id, [r]);
  }
  const services: Record<string, { segments: UptimeSegment[]; uptimePct: number | null }> = {};
  for (const [id, list] of byService) {
    const s = segmentize(list, fromMs, toMs, segments);
    services[id] = { segments: s.segments, uptimePct: s.uptimePct };
  }
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), hours, segments, services };
}

// ---- Detalle de un servicio ----

export interface DeployEntry {
  id: string | null;
  state: string;
  url: string | null;
  sha: string | null;
  branch: string | null;
  message: string | null;
  author: string | null;
  createdAt: string | null;
  durationMs: number | null;
  inspectorUrl: string | null;
  /** Resultado normalizado del intento (independiente del proveedor). */
  outcome: DeployState;
  /** Es el deploy que atiende producción ahora mismo. */
  serving: boolean;
  /** Motivo del fallo cuando el proveedor lo da en el listado (Vercel). */
  errorMessage: string | null;
}

export interface Incident {
  status: 'down' | 'degraded';
  start: string;
  end: string | null;
  durationMs: number;
}

/** Tramos seguidos en caído/degradado (ignora 'unknown', que es la API del proveedor fallando). */
function incidentsOf(rows: SnapRow[]): Incident[] {
  const out: Incident[] = [];
  let cur: { status: 'down' | 'degraded'; start: string; last: string } | null = null;
  for (const r of rows) {
    if (r.status === 'unknown') continue;
    const bad = r.status === 'down' || r.status === 'degraded' ? r.status : null;
    if (bad && cur && cur.status === bad) {
      cur.last = r.captured_at;
      continue;
    }
    if (cur) {
      out.push({ status: cur.status, start: cur.start, end: r.captured_at, durationMs: new Date(r.captured_at).getTime() - new Date(cur.start).getTime() });
      cur = null;
    }
    if (bad) cur = { status: bad, start: r.captured_at, last: r.captured_at };
  }
  if (cur) out.push({ status: cur.status, start: cur.start, end: null, durationMs: Date.now() - new Date(cur.start).getTime() });
  return out.reverse();
}

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
}

interface VercelDeploymentFull {
  uid?: string;
  url?: string;
  state?: string;
  readyState?: string;
  created?: number;
  buildingAt?: number;
  ready?: number;
  inspectorUrl?: string;
  errorMessage?: string;
  meta?: Record<string, string | undefined>;
}

async function vercelHistory(ref: string, cfg: Record<string, unknown>, limit: number) {
  if (!config.vercel.token) return null;
  const teamId = (cfg.teamId as string) || config.vercel.teamId;
  const team = teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';
  const res = await timedFetch(`https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(ref)}&target=production&limit=${limit}${team}`, {
    headers: { authorization: `Bearer ${config.vercel.token}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { deployments?: VercelDeploymentFull[] };
  return (json.deployments ?? []).map<DeployEntry>((d) => ({
    id: d.uid ?? null,
    state: d.state ?? d.readyState ?? 'UNKNOWN',
    url: d.url ? `https://${d.url}` : null,
    sha: d.meta?.githubCommitSha ?? null,
    branch: d.meta?.githubCommitRef ?? null,
    message: d.meta?.githubCommitMessage?.split('\n')[0] ?? null,
    author: d.meta?.githubCommitAuthorLogin ?? d.meta?.githubCommitAuthorName ?? null,
    createdAt: d.created ? new Date(d.created).toISOString() : null,
    durationMs: d.ready && d.buildingAt && d.ready > d.buildingAt ? d.ready - d.buildingAt : null,
    inspectorUrl: d.inspectorUrl ?? null,
    outcome: vercelDeployState(d.state ?? d.readyState),
    serving: false,
    errorMessage: d.errorMessage ?? null,
  }));
}

const RAILWAY_HISTORY = `
  query History($serviceId: String!, $environmentId: String, $first: Int) {
    deployments(first: $first, input: { serviceId: $serviceId, environmentId: $environmentId }) {
      edges { node { id status createdAt staticUrl url meta } }
    }
  }
`;
const RAILWAY_SERVICE = `query Svc($id: String!) { service(id: $id) { name projectId } }`;

async function railwayGql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  if (!config.railway.token) return null;
  const res = await timedFetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.railway.token}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json().catch(() => null)) as { data?: T; errors?: unknown } | null;
  if (!res.ok || !json || json.errors) return null;
  return json.data ?? null;
}

async function railwayHistory(ref: string, cfg: Record<string, unknown>, limit: number) {
  type Node = { id?: string; status?: string; createdAt?: string; staticUrl?: string; url?: string; meta?: Record<string, any> };
  const data = await railwayGql<{ deployments?: { edges?: { node: Node }[] } }>(RAILWAY_HISTORY, {
    serviceId: ref,
    environmentId: (cfg.environmentId as string) ?? null,
    first: limit,
  });
  if (!data) return null;
  return (data.deployments?.edges ?? []).map<DeployEntry>(({ node: n }) => ({
    id: n.id ?? null,
    state: n.status ?? 'UNKNOWN',
    url: n.staticUrl ? `https://${n.staticUrl}` : n.url ?? null,
    sha: n.meta?.commitHash ?? null,
    branch: n.meta?.branch ?? null,
    message: typeof n.meta?.commitMessage === 'string' ? (n.meta.commitMessage.split('\n')[0] ?? null) : null,
    author: n.meta?.commitAuthor ?? null,
    createdAt: n.createdAt ?? null,
    durationMs: null,
    inspectorUrl: null,
    outcome: railwayDeployState(n.status),
    serving: false,
    errorMessage: null,
  }));
}

/** Respaldo sin token o con la API caída: lo que guardó el último snapshot. */
function historyFromSnapshot(snap: any, provider: string): DeployEntry[] {
  const recent = (snap?.details?.recent ?? []) as { state: string; sha: string | null; createdAt: string | null }[];
  const d = snap?.deploy as Record<string, any> | null;
  return recent.map((r, i) => ({
    id: null,
    state: r.state,
    url: i === 0 ? d?.url ?? null : null,
    sha: r.sha,
    branch: i === 0 ? d?.branch ?? null : null,
    message: i === 0 ? d?.commitMessage ?? null : null,
    author: i === 0 ? d?.author ?? null : null,
    createdAt: r.createdAt,
    durationMs: i === 0 ? d?.durationMs ?? null : null,
    inspectorUrl: null,
    outcome: provider === 'railway' ? railwayDeployState(r.state) : vercelDeployState(r.state),
    serving: false,
    errorMessage: null,
  }));
}

export class NotFound extends Error {}

export async function getServiceDetail(serviceId: string, days = 7) {
  const { data: svc, error } = await db()
    .from('project_service')
    .select('id, project_id, provider, external_ref, label, config')
    .eq('id', serviceId)
    .maybeSingle();
  if (error) throw error;
  if (!svc) throw new NotFound('servicio no encontrado');
  const s = svc as unknown as { id: string; project_id: string; provider: string; external_ref: string; label: string | null; config: Record<string, unknown> | null };
  const cfg = s.config ?? {};

  const toMs = Date.now();
  const fromMs = toMs - days * 24 * HOUR;
  const segments = Math.min(120, days * 12); // 7 días → 84 bloques de 2 h

  const [projRes, snapRes, errRes, rows] = await Promise.all([
    db().from('project').select('name').eq('id', s.project_id).maybeSingle(),
    db()
      .from('service_snapshot')
      .select('captured_at, ok, status, provider_status, active, deploy, metrics, details, error')
      .eq('project_service_id', s.id)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db()
      .from('service_snapshot')
      .select('captured_at, status, provider_status, error')
      .eq('project_service_id', s.id)
      .or('error.not.is.null,status.eq.down')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    snapshotsSince(new Date(fromMs).toISOString(), s.id),
  ]);
  const snap = snapRes.data as any;
  const errRow = errRes.data as { captured_at: string; status: string; provider_status: string | null; error: string | null } | null;

  // Historial de deploys en vivo; si no hay token o la API falla, el del último snapshot.
  let deploys: DeployEntry[] | null = null;
  let railwayProjectId: string | null = null;
  try {
    if (s.provider === 'vercel') deploys = await vercelHistory(s.external_ref, cfg, 20);
    else if (s.provider === 'railway') {
      const [hist, meta] = await Promise.all([
        railwayHistory(s.external_ref, cfg, 20),
        railwayGql<{ service?: { name?: string; projectId?: string } }>(RAILWAY_SERVICE, { id: s.external_ref }).catch(() => null),
      ]);
      deploys = hist;
      railwayProjectId = meta?.service?.projectId ?? null;
    }
  } catch {
    deploys = null;
  }
  const deploysSource: 'live' | 'snapshot' | 'none' =
    s.provider === 'supabase' ? 'none' : deploys ? 'live' : 'snapshot';
  if (!deploys) deploys = s.provider === 'supabase' ? [] : historyFromSnapshot(snap, s.provider);

  // Cuál atiende producción: el que guardó el sondeo (respeta rollbacks); si el snapshot es del
  // modelo viejo, el intento exitoso más reciente.
  const servingRef = snap?.details?.serving as { id?: string | null; sha?: string | null } | null | undefined;
  const hasModel = !!snap?.details && 'lastDeploy' in snap.details;
  let servingIdx = -1;
  if (servingRef) servingIdx = deploys.findIndex((d) => (servingRef.id && d.id ? d.id === servingRef.id : !!servingRef.sha && d.sha === servingRef.sha && d.outcome === 'ready'));
  else if (!hasModel) servingIdx = deploys.findIndex((d) => d.outcome === 'ready');
  if (servingIdx >= 0) deploys[servingIdx]!.serving = true;

  // Resumen de los intentos recientes: cuántos fallaron y cuánto tarda un build bueno.
  const finished = deploys.filter((d) => d.outcome === 'ready' || d.outcome === 'failed');
  const failedCount = finished.filter((d) => d.outcome === 'failed').length;
  const durations = deploys.filter((d) => d.outcome === 'ready' && d.durationMs).map((d) => d.durationMs!);
  const deployStats = {
    total: deploys.length,
    finished: finished.length,
    failed: failedCount,
    successPct: finished.length ? Math.round(((finished.length - failedCount) / finished.length) * 100) : null,
    avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
  };

  // Enlaces al proveedor.
  const links: { label: string; url: string }[] = [];
  const prodUrl: string | null = snap?.details?.productionUrl ?? (s.provider !== 'supabase' ? snap?.deploy?.url ?? null : null);
  if (prodUrl) links.push({ label: 'Abrir sitio', url: prodUrl });
  if (s.provider === 'vercel') {
    const inspector = deploys.find((d) => d.inspectorUrl)?.inspectorUrl;
    // inspectorUrl = https://vercel.com/<team>/<proyecto>/<deploy>: sin el último tramo es el proyecto.
    if (inspector) links.push({ label: 'Proyecto en Vercel', url: inspector.replace(/\/[^/]+$/, '') });
  } else if (s.provider === 'railway' && railwayProjectId) {
    links.push({ label: 'Servicio en Railway', url: `https://railway.com/project/${railwayProjectId}/service/${s.external_ref}` });
  } else if (s.provider === 'supabase') {
    links.push({ label: 'Proyecto en Supabase', url: `https://supabase.com/dashboard/project/${s.external_ref}` });
  }

  const uptime = segmentize(rows, fromMs, toMs, segments);

  return {
    service: {
      id: s.id,
      projectId: s.project_id,
      projectName: ((projRes.data as { name?: string } | null)?.name ?? null) as string | null,
      provider: s.provider,
      externalRef: s.external_ref,
      label: s.label,
      config: cfg,
    },
    snapshot: snap
      ? {
          capturedAt: snap.captured_at as string,
          ok: snap.ok as boolean,
          status: snap.status as ServiceStatus,
          providerStatus: snap.provider_status as string | null,
          active: snap.active as boolean | null,
          deploy: snap.deploy ?? null,
          metrics: snap.metrics ?? null,
          details: snap.details ?? null,
          error: snap.error as string | null,
        }
      : null,
    uptime: {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      days,
      bucketMs: Math.round((toMs - fromMs) / segments),
      ...uptime,
    },
    incidents: incidentsOf(rows).slice(0, 10),
    lastError: errRow
      ? { at: errRow.captured_at, status: errRow.status, providerStatus: errRow.provider_status, message: errRow.error }
      : null,
    deploys,
    deployStats,
    deploysSource,
    links,
  };
}
