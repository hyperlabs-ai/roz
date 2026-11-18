// Estado del MCP de zeus para el dashboard (página "MCP"): el servidor, quién está conectado y
// cuándo lo usó su Claude o su CLI, el último trabajo hecho por esas vías, lo pendiente del equipo,
// los runners y la salud de la ingesta de repos. Todo sale de la base; nada se inventa.
//
// Cada sección es tolerante: si una tabla no está (o falla una consulta), esa parte sale vacía y el
// resto de la página sigue sirviendo.
import { db } from '../db/supabase.js';
import { runnerOnline } from '../plans/rules.js';
import {
  ZEUS_OPEN_STATUSES,
  type ZeusActivityEvent,
  type ZeusMcpActivityStats,
  type ZeusMcpConnection,
  type ZeusMcpPending,
  type ZeusMcpPendingItem,
  type ZeusMcpRunner,
  type ZeusMcpSources,
  type ZeusMcpStatus,
} from '../types/zeus.js';
import { listSources } from './ingest.js';
import { ZEUS_MCP_INSTRUCTIONS, ZEUS_MCP_PROMPTS, zeusTools } from './mcp.js';

/** Lo que anuncia el `initialize` de src/routes/mcp.ts (serverInfo). */
export const MCP_SERVER_NAME = 'zeus';
/** Versión que anuncia el MCP en su initialize (src/routes/mcp.ts la usa). */
export const MCP_SERVER_VERSION = '0.3.0';

const HOUR = 3600_000;
/** Lo que se considera "trabajo por MCP/CLI": lo que hace el Claude o la terminal de alguien. */
const AGENT_ACTORS = ['mcp', 'cli', 'runner'] as const;

async function safe<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

type DevRow = { id: string; name: string; email: string | null; github_login: string | null };
type ActRow = { id: number; at: string; dev_id: string | null; actor: ZeusActivityEvent['actor']; action: string; ref: string | null; detail: Record<string, unknown> | null };

export async function mcpStatus(now: Date = new Date()): Promise<ZeusMcpStatus> {
  const supabase = db();
  const since7d = new Date(now.getTime() - 7 * 24 * HOUR).toISOString();
  const since24h = now.getTime() - 24 * HOUR;

  const [devs, tokens, acts, runnersRaw] = await Promise.all([
    safe<DevRow[]>([], async () => {
      const { data, error } = await supabase.from('dev').select('id, name, email, github_login').eq('active', true);
      if (error) throw error;
      return (data ?? []) as DevRow[];
    }),
    safe<Array<{ dev_id: string; last_used_at: string | null }>>([], async () => {
      const { data, error } = await supabase.from('zeus_token').select('dev_id, last_used_at').is('revoked_at', null);
      if (error) throw error;
      return (data ?? []) as Array<{ dev_id: string; last_used_at: string | null }>;
    }),
    safe<ActRow[]>([], async () => {
      const { data, error } = await supabase
        .from('zeus_activity')
        .select('id, at, dev_id, actor, action, ref, detail')
        .in('actor', [...AGENT_ACTORS])
        .gte('at', since7d)
        .order('at', { ascending: false })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as ActRow[];
    }),
    safe<Array<{ id: string; dev_id: string; name: string; platform: string | null; last_seen_at: string | null }>>([], async () => {
      const { data, error } = await supabase.from('runner').select('id, dev_id, name, platform, last_seen_at').is('revoked_at', null);
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; dev_id: string; name: string; platform: string | null; last_seen_at: string | null }>;
    }),
  ]);
  const devById = new Map(devs.map((d) => [d.id, d]));
  const nameOf = (id: string | null) => (id ? (devById.get(id)?.name ?? null) : null);

  // ---- servidor
  const uptimeSec = Math.round(process.uptime());
  const server = {
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    startedAt: new Date(now.getTime() - uptimeSec * 1000).toISOString(),
    uptimeSec,
    tools: zeusTools.length,
    readOnlyTools: zeusTools.filter((t) => t.readOnly).length,
    prompts: ZEUS_MCP_PROMPTS.map((p) => p.name),
    instructionsChars: ZEUS_MCP_INSTRUCTIONS.length,
  };

  // ---- runners
  const runners: ZeusMcpRunner[] = runnersRaw
    .map((r) => ({
      id: r.id,
      devId: r.dev_id,
      devName: nameOf(r.dev_id) ?? 'alguien',
      name: r.name,
      platform: r.platform,
      lastSeenAt: r.last_seen_at,
      online: runnerOnline(r.last_seen_at, now),
    }))
    .sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''));
  const onlineDevs = new Set(runners.filter((r) => r.online).map((r) => r.devId));

  // ---- conexiones: quien tiene token o usó zeus por MCP/CLI esta semana
  const conn = new Map<string, ZeusMcpConnection>();
  const ensure = (devId: string): ZeusMcpConnection | null => {
    const d = devById.get(devId);
    if (!d) return null;
    let c = conn.get(devId);
    if (!c) {
      c = {
        devId,
        name: d.name,
        githubLogin: d.github_login,
        email: d.email,
        tokens: 0,
        lastTokenUseAt: null,
        lastMcpAt: null,
        lastCliAt: null,
        events24h: 0,
        events7d: 0,
        runnerOnline: onlineDevs.has(devId),
      };
      conn.set(devId, c);
    }
    return c;
  };
  const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
  for (const t of tokens) {
    const c = ensure(t.dev_id);
    if (!c) continue;
    c.tokens++;
    c.lastTokenUseAt = later(c.lastTokenUseAt, t.last_used_at);
  }

  // ---- actividad
  const hourly = Array.from({ length: 24 }, () => 0);
  const actions = new Map<string, number>();
  const active24 = new Set<string>();
  const active7 = new Set<string>();
  let events24h = 0;
  let mcp24h = 0;
  let cli24h = 0;
  for (const a of acts) {
    const t = Date.parse(a.at);
    const in24 = t >= since24h;
    if (a.dev_id) {
      active7.add(a.dev_id);
      if (in24) active24.add(a.dev_id);
      const c = ensure(a.dev_id);
      if (c) {
        c.events7d++;
        if (in24) c.events24h++;
        if (a.actor === 'mcp' || a.actor === 'runner') c.lastMcpAt = later(c.lastMcpAt, a.at);
        if (a.actor === 'cli') c.lastCliAt = later(c.lastCliAt, a.at);
      }
    }
    if (!in24) continue;
    events24h++;
    if (a.actor === 'cli') cli24h++;
    else mcp24h++;
    actions.set(a.action, (actions.get(a.action) ?? 0) + 1);
    const bucket = 23 - Math.floor((now.getTime() - t) / HOUR);
    if (bucket >= 0 && bucket < 24) hourly[bucket]!++;
  }
  const activity: ZeusMcpActivityStats = {
    events24h,
    events7d: acts.length,
    mcp24h,
    cli24h,
    activeDevs24h: active24.size,
    activeDevs7d: active7.size,
    hourly,
    topActions: [...actions].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([action, count]) => ({ action, count })),
  };
  const connections = [...conn.values()].sort(
    (a, b) => b.events7d - a.events7d || (later(b.lastMcpAt, b.lastCliAt) ?? '').localeCompare(later(a.lastMcpAt, a.lastCliAt) ?? '') || a.name.localeCompare(b.name),
  );

  const recent: ZeusActivityEvent[] = acts.slice(0, 20).map((r) => ({
    id: Number(r.id),
    at: r.at,
    devId: r.dev_id,
    devName: nameOf(r.dev_id),
    actor: r.actor,
    action: r.action,
    ref: r.ref,
    detail: r.detail ?? {},
  }));

  // ---- pendientes del equipo
  const [work, requests, plans] = await Promise.all([
    safe<Array<{ id: string; kind: 'task' | 'plan'; from_dev_id: string | null; to_dev_id: string; subject: string | null; status: string; created_at: string }>>([], async () => {
      const { data, error } = await supabase
        .from('zeus_message')
        .select('id, kind, from_dev_id, to_dev_id, subject, status, created_at')
        .in('status', [...ZEUS_OPEN_STATUSES])
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; kind: 'task' | 'plan'; from_dev_id: string | null; to_dev_id: string; subject: string | null; status: string; created_at: string }>;
    }),
    safe<Array<{ id: string; title: string; requester_dev_id: string; approver_dev_id: string | null; created_at: string }>>([], async () => {
      const { data, error } = await supabase
        .from('zeus_request')
        .select('id, title, requester_dev_id, approver_dev_id, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; title: string; requester_dev_id: string; approver_dev_id: string | null; created_at: string }>;
    }),
    safe<Array<{ id: string; identifier: string; owner_dev_id: string; status: string; updated_at: string }>>([], async () => {
      const { data, error } = await supabase
        .from('agent_plan')
        .select('id, identifier, owner_dev_id, status, updated_at')
        .in('status', ['en_cola', 'planeando', 'implementando', 'esperando_aprobacion'])
        .order('updated_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; identifier: string; owner_dev_id: string; status: string; updated_at: string }>;
    }),
  ]);
  const items: ZeusMcpPendingItem[] = [
    ...work.map((m) => ({ kind: m.kind, id: m.id, title: m.subject ?? '(sin título)', from: nameOf(m.from_dev_id), to: nameOf(m.to_dev_id), status: m.status, at: m.created_at })),
    ...requests.map((r) => ({ kind: 'request' as const, id: r.id, title: r.title, from: nameOf(r.requester_dev_id), to: nameOf(r.approver_dev_id), status: 'pending', at: r.created_at })),
    ...plans.map((p) => ({ kind: 'agent_plan' as const, id: p.id, title: p.identifier, from: null, to: nameOf(p.owner_dev_id), status: p.status, at: p.updated_at })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const pending: ZeusMcpPending = {
    tasks: work.filter((m) => m.kind === 'task').length,
    plans: work.filter((m) => m.kind === 'plan').length,
    requests: requests.length,
    queuedPlans: plans.filter((p) => p.status === 'en_cola').length,
    runningPlans: plans.filter((p) => p.status === 'planeando' || p.status === 'implementando').length,
    items: items.slice(0, 12),
  };

  // ---- ingesta de repos
  const sources = await safe<ZeusMcpSources>(
    { total: 0, withDocs: 0, empty: 0, errored: 0, pending: 0, docs: 0, lastSyncedAt: null, attention: [] },
    async () => {
      const list = await listSources();
      const attention = list.filter((s) => s.lastError || s.pending).sort((a, b) => Number(!!b.lastError) - Number(!!a.lastError) || a.repo.localeCompare(b.repo));
      return {
        total: list.length,
        withDocs: list.filter((s) => s.nodeCount > 0).length,
        empty: list.filter((s) => s.nodeCount === 0 && !s.lastError).length,
        errored: list.filter((s) => s.lastError).length,
        pending: list.filter((s) => s.pending).length,
        docs: list.reduce((n, s) => n + s.nodeCount, 0),
        lastSyncedAt: list.reduce<string | null>((m, s) => later(m, s.lastSyncedAt), null),
        attention: attention.slice(0, 40),
      };
    },
  );

  return { server, connections, activity, recent, pending, runners, sources, now: now.toISOString() };
}
