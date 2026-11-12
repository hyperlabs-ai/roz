// Sondeo de infraestructura: recorre roz.project_service, consulta el adapter de cada proveedor
// y guarda un roz.service_snapshot. Lo dispara el cron /v1/internal/infra-poll (ver vercel.json).
// El dashboard NO pega a las APIs externas: lee el último snapshot por servicio → resuelve rate
// limits y da histórico gratis. Además detecta EVENTOS entre un sondeo y el siguiente y avisa:
// servicio caído/pausado, servicio recuperado y deploy fallido con producción en línea (son cosas
// distintas: ver infra/transitions.ts). Fase "solo datos": el disparo es por cambio real, no por
// umbrales.
import { db } from '../db/supabase.js';
import { probeVercel } from '../adapters/vercel.js';
import { probeRailway } from '../adapters/railway.js';
import { probeSupabase } from '../adapters/supabase-admin.js';
import { degraded, type ProbeHint, type ServiceProbe } from './types.js';
import { notifyServiceTransitions, type ServiceTransition } from './alerts.js';
import { detectTransition, failureOf, lastDeployOf, servingOf, type SnapshotState } from './transitions.js';
import { notifyServiceTransitionsPush } from '../notify/push.js';

interface ProjectServiceRow {
  id: string;
  project_id: string;
  provider: string;
  external_ref: string;
  label: string | null;
  config: Record<string, unknown> | null;
}

function probeFor(provider: string, ref: string, cfg: Record<string, unknown>, hint: ProbeHint): Promise<ServiceProbe> {
  switch (provider) {
    case 'vercel':
      return probeVercel(ref, cfg, hint);
    case 'railway':
      return probeRailway(ref, cfg, hint);
    case 'supabase':
      return probeSupabase(ref, cfg);
    default:
      return Promise.resolve(degraded(`proveedor desconocido: ${provider}`));
  }
}

/** Último estado "real" (ignora 'unknown' = no se pudo consultar), para comparar transiciones. */
async function lastRealState(serviceId: string): Promise<(SnapshotState & { captured_at: string }) | null> {
  const { data } = await db()
    .from('service_snapshot')
    .select('status, captured_at, details')
    .eq('project_service_id', serviceId)
    .neq('status', 'unknown')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as (SnapshotState & { captured_at: string }) | null) ?? null;
}

/** Última vez que el servicio se vio 'healthy' (para calcular cuánto lleva/estuvo caído). */
async function lastHealthyAt(serviceId: string): Promise<string | null> {
  const { data } = await db()
    .from('service_snapshot')
    .select('captured_at')
    .eq('project_service_id', serviceId)
    .eq('status', 'healthy')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { captured_at: string } | null)?.captured_at ?? null;
}

/** Usuario de GitHub (o nombre) del commit → dev de roz, para nombrarlo en el aviso. */
async function devsByAuthor(): Promise<(author: string | null | undefined) => { id: string; name: string } | null> {
  const { data } = await db().from('dev').select('id, name, github_login');
  const rows = (data ?? []) as { id: string; name: string | null; github_login: string | null }[];
  const byLogin = new Map<string, { id: string; name: string }>();
  const byName = new Map<string, { id: string; name: string }>();
  for (const r of rows) {
    if (!r.name) continue;
    if (r.github_login) byLogin.set(r.github_login.toLowerCase(), { id: r.id, name: r.name });
    byName.set(r.name.toLowerCase(), { id: r.id, name: r.name });
  }
  return (author) => {
    if (!author) return null;
    const k = author.toLowerCase();
    return byLogin.get(k) ?? byName.get(k) ?? null;
  };
}

export async function pollInfra(): Promise<{ services: number; okCount: number; failed: number; alerts: number }> {
  const [{ data: svcData }, { data: projData }] = await Promise.all([
    db().from('project_service').select('id, project_id, provider, external_ref, label, config'),
    db().from('project').select('id, name'),
  ]);
  const services = (svcData ?? []) as unknown as ProjectServiceRow[];
  if (!services.length) return { services: 0, okCount: 0, failed: 0, alerts: 0 };
  const projName = new Map((projData ?? []).map((p: any) => [p.id, p.name as string]));

  // El estado previo (real) se lee ANTES de sondear: da la base de comparación y, de paso, la
  // causa ya averiguada de un deploy fallido, para no volver a bajar sus logs en cada ciclo.
  const prevStates = await Promise.all(services.map((s) => lastRealState(s.id)));
  const probes = await Promise.all(
    services.map((s, i) => probeFor(s.provider, s.external_ref, s.config ?? {}, { failure: failureOf(prevStates[i]?.details) })),
  );
  const results = services.map((s, i) => ({ s, prev: prevStates[i] ?? null, probe: probes[i]! }));

  const transitions: ServiceTransition[] = [];
  let findDev: Awaited<ReturnType<typeof devsByAuthor>> | null = null;
  for (const { s, prev, probe } of results) {
    const kind = detectTransition(prev, { status: probe.status, details: probe.details }, s.provider);
    if (!kind) continue;
    findDev ??= await devsByAuthor();
    const lastDeploy = lastDeployOf(probe.details);
    const author = findDev(lastDeploy?.author ?? probe.deploy?.author);
    const since = kind === 'deploy_failed' ? null : await lastHealthyAt(s.id);
    transitions.push({
      kind,
      projectName: projName.get(s.project_id) ?? 'Sin proyecto',
      provider: s.provider,
      serviceLabel: s.label || s.external_ref,
      externalRef: s.external_ref,
      status: probe.status,
      providerStatus: probe.providerStatus,
      error: probe.error,
      deploy: probe.deploy,
      lastSeenOkAt: since,
      downtimeMs: kind === 'up' && since ? Date.now() - new Date(since).getTime() : null,
      lastDeploy,
      serving: servingOf(probe.details),
      failure: failureOf(probe.details),
      authorDevId: author?.id ?? null,
      authorName: author?.name ?? null,
    });
  }

  const rows = results.map(({ s, probe }) => ({
    project_service_id: s.id,
    ok: probe.ok,
    status: probe.status,
    provider_status: probe.providerStatus,
    active: probe.active,
    deploy: probe.deploy,
    metrics: probe.metrics,
    details: probe.details,
    error: probe.error,
    raw: probe.raw ?? null,
  }));

  const { error } = await db().from('service_snapshot').insert(rows);
  if (error) throw error;

  // Poda: acota el crecimiento de la tabla. El dashboard solo lee el último por servicio; 14 días
  // de histórico bastan para tendencias. Best-effort (no rompe el sondeo si falla).
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  await db().from('service_snapshot').delete().lt('captured_at', cutoff);

  // Alertas por correo + push a la PWA (ambos degradan en silencio si no están configurados).
  const { sent } = await notifyServiceTransitions(transitions);
  await notifyServiceTransitionsPush(transitions);

  const okCount = probes.filter((p) => p.ok).length;
  return { services: services.length, okCount, failed: services.length - okCount, alerts: sent };
}
