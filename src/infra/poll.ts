// Sondeo de infraestructura: recorre roz.project_service, consulta el adapter de cada proveedor
// y guarda un roz.service_snapshot. Lo dispara el cron /v1/internal/infra-poll (ver vercel.json).
// El dashboard NO pega a las APIs externas: lee el último snapshot por servicio → resuelve rate
// limits y da histórico gratis. Además detecta TRANSICIONES de estado (operativo→caído/pausado y
// viceversa) y avisa por correo a los devs. Fase "solo datos": el disparo es por transición real,
// no por umbrales.
import { db } from '../db/supabase.js';
import { probeVercel } from '../adapters/vercel.js';
import { probeRailway } from '../adapters/railway.js';
import { probeSupabase } from '../adapters/supabase-admin.js';
import { degraded, type ServiceProbe } from './types.js';
import { notifyServiceTransitions, type ServiceTransition } from './alerts.js';
import { notifyServiceTransitionsPush } from '../notify/push.js';

interface ProjectServiceRow {
  id: string;
  project_id: string;
  provider: string;
  external_ref: string;
  label: string | null;
  config: Record<string, unknown> | null;
}

const DOWN_STATES = new Set(['down', 'paused']);

function probeFor(provider: string, ref: string, cfg: Record<string, unknown>): Promise<ServiceProbe> {
  switch (provider) {
    case 'vercel':
      return probeVercel(ref, cfg);
    case 'railway':
      return probeRailway(ref, cfg);
    case 'supabase':
      return probeSupabase(ref, cfg);
    default:
      return Promise.resolve(degraded(`proveedor desconocido: ${provider}`));
  }
}

/** Último estado "real" (ignora 'unknown' = no se pudo consultar), para comparar transiciones. */
async function lastRealState(serviceId: string): Promise<{ status: string; captured_at: string } | null> {
  const { data } = await db()
    .from('service_snapshot')
    .select('status, captured_at')
    .eq('project_service_id', serviceId)
    .neq('status', 'unknown')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { status: string; captured_at: string } | null) ?? null;
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

export async function pollInfra(): Promise<{ services: number; okCount: number; failed: number; alerts: number }> {
  const [{ data: svcData }, { data: projData }] = await Promise.all([
    db().from('project_service').select('id, project_id, provider, external_ref, label, config'),
    db().from('project').select('id, name'),
  ]);
  const services = (svcData ?? []) as unknown as ProjectServiceRow[];
  if (!services.length) return { services: 0, okCount: 0, failed: 0, alerts: 0 };
  const projName = new Map((projData ?? []).map((p: any) => [p.id, p.name as string]));

  // Estado previo (real) + sondeo nuevo, en paralelo. El previo se lee ANTES de insertar.
  const [prevStates, probes] = await Promise.all([
    Promise.all(services.map((s) => lastRealState(s.id))),
    Promise.all(services.map((s) => probeFor(s.provider, s.external_ref, s.config ?? {}))),
  ]);
  const results = services.map((s, i) => ({ s, prev: prevStates[i] ?? null, probe: probes[i]! }));

  // Detecta transiciones contra el último estado real (evita ruido por errores de API 'unknown'
  // y por el primer sondeo de un servicio recién vinculado).
  const transitions: ServiceTransition[] = [];
  for (const { s, prev: prevState, probe } of results) {
    const prev = prevState?.status;
    const now = probe.status;
    const base = (kind: 'down' | 'up'): Omit<ServiceTransition, 'lastSeenOkAt' | 'downtimeMs'> => ({
      kind,
      projectName: projName.get(s.project_id) ?? '—',
      provider: s.provider,
      serviceLabel: s.label || s.external_ref,
      externalRef: s.external_ref,
      status: now,
      providerStatus: probe.providerStatus,
      error: probe.error,
      deploy: probe.deploy,
    });

    if (prev && DOWN_STATES.has(now) && !DOWN_STATES.has(prev)) {
      transitions.push({ ...base('down'), lastSeenOkAt: await lastHealthyAt(s.id), downtimeMs: null });
    } else if (prev && now === 'healthy' && DOWN_STATES.has(prev)) {
      const since = await lastHealthyAt(s.id);
      transitions.push({ ...base('up'), lastSeenOkAt: since, downtimeMs: since ? Date.now() - new Date(since).getTime() : null });
    }
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
