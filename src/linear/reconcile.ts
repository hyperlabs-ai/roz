// Reconciliación con Linear (cron cada 30 min → outbox 'linear.reconcile'). El webhook es la vía
// rápida; esto es la red: un webhook perdido (Linear caído, deploy a media entrega, secreto rotado)
// no deja el espejo desfasado más de media hora.
//
// Ventana: issues con updatedAt > `since`. Sin `since` explícito, desde el último linear_synced_at
// del espejo MENOS un traslape de 2 h. El traslape importa: linear_synced_at avanza también con los
// webhooks, así que un issue cuyo webhook se perdió a las 10:00 seguido de otro que sí llegó a las
// 10:05 quedaría fuera de una ventana "desde 10:05". Releer de más no cuesta: el espejo es monótono
// y lo que no cambió sale como stale sin escribir.
import { db } from '../db/supabase.js';
import { issuesUpdatedSince } from '../adapters/linear.js';
import type { LinearReconcilePayload } from '../types/roz-v2.js';
import { emitV2 } from './emit.js';
import { linearSourceOfTruth } from './enabled.js';
import { syncLinearLinks } from './links.js';
import { upsertMirrorFromLinear } from './mirror.js';

export const RECONCILE_OVERLAP_MS = 2 * 60 * 60 * 1000;
/** Sin espejo previo (primera corrida) se reconcilia la última semana. */
export const RECONCILE_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Desde cuándo reconciliar. Puro (probado). */
export function reconcileSince(lastSyncedAt: string | null, now = Date.now()): string {
  const base = lastSyncedAt ? Date.parse(lastSyncedAt) - RECONCILE_OVERLAP_MS : now - RECONCILE_DEFAULT_WINDOW_MS;
  return new Date(Math.min(base, now - RECONCILE_OVERLAP_MS)).toISOString();
}

/** Llave del tick del cron: el ISO truncado a la media hora (dos disparos del mismo tick → un evento). */
export function reconcileTickKey(now = new Date()): string {
  const d = new Date(now);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() < 30 ? 0 : 30);
  return `linear-reconcile:${d.toISOString()}`;
}

async function lastSyncedAt(): Promise<string | null> {
  const { data } = await db()
    .from('work_item')
    .select('linear_synced_at')
    .not('linear_synced_at', 'is', null)
    .order('linear_synced_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { linear_synced_at: string } | null)?.linear_synced_at ?? null;
}

export async function reconcileLinear(
  p: LinearReconcilePayload,
  log: (msg: string, data: Record<string, unknown>) => void = (m, d) => console.warn(m, d),
): Promise<{ upserted: number; truncated: boolean }> {
  if (!linearSourceOfTruth()) return { upserted: 0, truncated: false };
  if (p.refreshLinks) await syncLinearLinks();

  const since = p.since ?? reconcileSince(await lastSyncedAt());
  const { issues, truncated } = await issuesUpdatedSince(since);
  let upserted = 0;
  for (const issue of issues) {
    const r = await upsertMirrorFromLinear(issue, { source: 'reconcile' }, log);
    if (!r.stale) upserted++;
  }
  // Cortado por páginas: el siguiente tick sigue desde donde quedó (los issues vienen del más viejo
  // al más nuevo y linear_synced_at avanzó con ellos).
  if (truncated) log('linear: reconciliación cortada por páginas; sigue en el próximo tick', { since, seen: issues.length });
  return { upserted, truncated };
}

/** Lo que llama el cron /v1/internal/linear-reconcile: encola el tick (o se salta con el flag apagado). */
export async function scheduleLinearReconcile(now = new Date()): Promise<{ ok: true; skipped?: 'flag'; eventId?: string | null }> {
  if (!linearSourceOfTruth()) return { ok: true, skipped: 'flag' };
  const payload: LinearReconcilePayload = { since: null, reason: 'cron', refreshLinks: true };
  const eventId = await emitV2('linear.reconcile', payload, { idempotencyKey: reconcileTickKey(now) });
  return { ok: true, eventId };
}

/** Outbox 'linear.reconcile'. */
export async function reconcileFromEvent(payload: Record<string, unknown>): Promise<void> {
  const reason = payload.reason === 'manual' || payload.reason === 'arranque' ? payload.reason : 'cron';
  await reconcileLinear({
    since: typeof payload.since === 'string' ? payload.since : null,
    reason,
    refreshLinks: payload.refreshLinks !== false,
  });
}
