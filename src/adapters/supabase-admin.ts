// Adapter de Supabase Management API (api.supabase.com, beta). Lee estado del proyecto, salud por
// subsistema (db/auth/rest/realtime/storage), región/versión y conteo de peticiones por tipo. Todo
// gratis con un Personal Access Token (PAT). El PAT es a nivel de cuenta (no se puede scopear a un
// proyecto) → conviene crearlo bajo una service account dedicada.
import { config } from '../config.js';
import { degraded, type ServiceProbe, type ServiceStatus } from '../infra/types.js';

const BASE = 'https://api.supabase.com';

function mapStatus(s: string | undefined): ServiceStatus {
  switch ((s ?? '').toUpperCase()) {
    case 'ACTIVE_HEALTHY':
      return 'healthy';
    case 'ACTIVE_UNHEALTHY':
    case 'INIT_FAILED':
    case 'RESTORE_FAILED':
    case 'PAUSE_FAILED':
      return 'down';
    case 'INACTIVE':
      return 'paused';
    case 'COMING_UP':
    case 'GOING_DOWN':
    case 'RESTORING':
    case 'UPGRADING':
    case 'PAUSING':
    case 'RESTARTING':
    case 'RESIZING':
      return 'degraded';
    default:
      return 'unknown';
  }
}

function headers() {
  return { authorization: `Bearer ${config.supabaseAdmin.token}` };
}

interface ApiCountRow {
  total_auth_requests?: number;
  total_rest_requests?: number;
  total_realtime_requests?: number;
  total_storage_requests?: number;
}

/** Peticiones por tipo en las últimas 24 h (best-effort, aislado). interval válido: 1day. */
async function fetchRequests(ref: string): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`${BASE}/v1/projects/${ref}/analytics/endpoints/usage.api-counts?interval=1day`, { headers: headers() });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: ApiCountRow[] };
    const rows = json.result ?? [];
    const acc = { rest: 0, auth: 0, realtime: 0, storage: 0 };
    for (const r of rows) {
      acc.rest += r.total_rest_requests ?? 0;
      acc.auth += r.total_auth_requests ?? 0;
      acc.realtime += r.total_realtime_requests ?? 0;
      acc.storage += r.total_storage_requests ?? 0;
    }
    return { requests: acc.rest + acc.auth + acc.realtime + acc.storage, ...acc };
  } catch {
    return null;
  }
}

interface HealthEntry {
  name?: string;
  healthy?: boolean;
  status?: string;
}

/** Sondea un proyecto de Supabase. `ref` = project ref (subdominio, p.ej. abcd1234). */
export async function probeSupabase(ref: string, _cfg: Record<string, unknown> = {}): Promise<ServiceProbe> {
  if (!config.supabaseAdmin.token) return degraded('SUPABASE_ACCESS_TOKEN no configurado');
  try {
    const projRes = await fetch(`${BASE}/v1/projects/${ref}`, { headers: headers() });
    if (!projRes.ok) return degraded(`Supabase ${projRes.status}: ${await projRes.text().catch(() => projRes.statusText)}`);
    const proj = (await projRes.json()) as { status?: string; region?: string; database?: { version?: string; postgres_engine?: string } };

    // Salud por subsistema (best-effort): si algún servicio no está healthy, degradamos.
    let health: HealthEntry[] = [];
    try {
      const q = ['db', 'auth', 'rest', 'realtime', 'storage'].map((s) => `services=${s}`).join('&');
      const hRes = await fetch(`${BASE}/v1/projects/${ref}/health?${q}`, { headers: headers() });
      if (hRes.ok) health = (await hRes.json()) as HealthEntry[];
    } catch {
      /* salud opcional */
    }

    let status = mapStatus(proj.status);
    const subsystems = health.map((h) => ({ name: h.name ?? '?', healthy: h.healthy ?? (h.status ?? '').toUpperCase() === 'ACTIVE_HEALTHY' }));
    if (status === 'healthy' && subsystems.some((s) => !s.healthy)) status = 'degraded';

    const metrics = await fetchRequests(ref);

    return {
      ok: true,
      status,
      providerStatus: proj.status ?? null,
      active: status === 'healthy' || status === 'degraded',
      deploy: null, // Supabase no tiene "deploys"; la salud va en status/subsystems
      metrics,
      details: {
        region: proj.region ?? null,
        dbVersion: proj.database?.version ?? null,
        postgresEngine: proj.database?.postgres_engine ?? null,
        subsystems,
      },
      error: null,
    };
  } catch (err) {
    return degraded(`Supabase: ${String(err)}`);
  }
}
