// Patrón outbox sobre Supabase, drenado por Vercel Cron (sin servicio externo).
// emit() escribe el evento (idealmente en la misma transacción que el cambio de dato).
// drainOutbox() —invocado por /v1/internal/drain cada minuto— toma los pendientes y los
// procesa de forma idempotente, con reintentos (backoff exponencial) y dead-letter.
import { db } from '../db/supabase.js';
import { notifyAssignment, notifyChangesDocumented, notifyRepoDetected } from '../notify/notifications.js';
import { syncIssueFromWebhook, removeMirror } from '../sync/linear-issue.js';
import { reconcileCommit, backfillPushCommits } from '../reconcile/commits.js';
import { reconcilePullRequest } from '../reconcile/pull-request.js';
import { handleRepoDetected } from '../reconcile/repos.js';
import type { RepoMeta } from '../adapters/github.js';
import { upsertLinearProject } from '../projects/resolve.js';
import { documentCompletedWork } from '../brain/document.js';

export type OutboxEventType =
  | 'work_item.created'
  | 'work_item.assigned'
  | 'work_item.done'
  | 'linear.issue_upserted'
  | 'linear.issue_removed'
  | 'linear.project_upserted'
  | 'commit.received'
  | 'commits.backfill'
  | 'pr.merged'
  | 'change.documented'
  | 'repo.detected'
  | 'repo.notify'
  | 'notification.requested';

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_SEC = 60; // 1er reintento ~2min, luego 4, 8, 16... tope 1h
// Un evento que lleva más de esto en `processing` se considera huérfano (la función
// serverless murió a media ejecución; maxDuration son 120s). El reaper lo devuelve a `failed`.
const STUCK_PROCESSING_SEC = 300;

export interface EmitOptions {
  /** Llave de deduplicación a nivel de evento (única). */
  idempotencyKey?: string;
  /** Retraso antes del primer intento (p.ej. nudges). */
  delaySeconds?: number;
}

/** Escribe un OutboxEvent `pending`. Devuelve el id (o null si era duplicado). */
export async function emit(
  type: OutboxEventType,
  payload: Record<string, unknown>,
  opts: EmitOptions = {},
): Promise<string | null> {
  const nextAttemptAt = new Date(Date.now() + (opts.delaySeconds ?? 0) * 1000).toISOString();
  const { data, error } = await db()
    .from('outbox_event')
    .insert({
      type,
      payload,
      status: 'pending',
      idempotency_key: opts.idempotencyKey ?? null,
      next_attempt_at: nextAttemptAt,
    })
    .select('id')
    .single();

  // 23505 = unique violation sobre idempotency_key → ya existe, no-op.
  if (error) {
    if ((error as { code?: string }).code === '23505') return null;
    throw error;
  }
  return data.id as string;
}

export interface DrainResult {
  processed: number;
  failed: number;
}

/**
 * Toma un lote de eventos listos (pending/failed con next_attempt_at vencido) y los
 * procesa. Pensado para correr periódicamente (Vercel Cron). Idempotente y reentrante:
 * el claim optimista evita que dos ticks solapados procesen el mismo evento.
 */
export async function drainOutbox(batchSize = 20): Promise<DrainResult> {
  const supabase = db();

  // Reaper: rescata eventos atascados en `processing` (proceso muerto a media ejecución) y los
  // devuelve a `failed` para que este mismo tick (o el siguiente) los reintente. Sin esto
  // quedarían colgados para siempre, porque el drain solo toma pending/failed.
  const stuckBefore = new Date(Date.now() - STUCK_PROCESSING_SEC * 1000).toISOString();
  await supabase
    .from('outbox_event')
    .update({ status: 'failed', next_attempt_at: new Date().toISOString() })
    .eq('status', 'processing')
    .lt('updated_at', stuckBefore);

  const { data: events, error } = await supabase
    .from('outbox_event')
    .select('*')
    .in('status', ['pending', 'failed'])
    .lte('next_attempt_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(batchSize);
  if (error) throw error;

  let processed = 0;
  let failed = 0;
  for (const ev of events ?? []) {
    const ok = await processEvent(ev);
    if (ok === true) processed++;
    else if (ok === false) failed++;
    // ok === null => otro tick lo reclamó; no cuenta.
  }
  return { processed, failed };
}

/** Procesa un evento por id (para drenado manual / push opcional). */
export async function consume(eventId: string): Promise<void> {
  const { data: ev, error } = await db().from('outbox_event').select('*').eq('id', eventId).single();
  if (error || !ev) throw error ?? new Error(`event ${eventId} not found`);
  if (ev.status === 'done') return;
  const ok = await processEvent(ev);
  if (ok === false) throw new Error(`event ${eventId} failed`);
}

/**
 * Claim optimista + ejecuta el efecto. Devuelve true (done), false (falló y se reprogramó
 * o murió) o null (no se pudo reclamar: otro tick lo tomó / ya estaba done).
 */
async function processEvent(ev: any): Promise<boolean | null> {
  const supabase = db();

  // Reclamar: pasar a `processing` solo si sigue pending/failed. Sella `updated_at` para que
  // el reaper pueda medir cuánto lleva un evento atascado (no hay trigger que lo bumpee).
  const { data: claimed } = await supabase
    .from('outbox_event')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', ev.id)
    .in('status', ['pending', 'failed'])
    .select('id')
    .maybeSingle();
  if (!claimed) return null;

  try {
    await dispatch(ev.type as OutboxEventType, ev.payload as Record<string, unknown>);
    await supabase.from('outbox_event').update({ status: 'done', error: null }).eq('id', ev.id);
    return true;
  } catch (err) {
    const attempts = (ev.attempts ?? 0) + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    const backoffSec = Math.min(BACKOFF_BASE_SEC * 2 ** attempts, 3600);
    await supabase
      .from('outbox_event')
      .update({
        status: dead ? 'dead' : 'failed',
        attempts,
        error: String(err),
        next_attempt_at: new Date(Date.now() + backoffSec * 1000).toISOString(),
      })
      .eq('id', ev.id);
    return false;
  }
}

/**
 * Mapea tipo de evento -> efecto. Cada efecto maneja su idempotencia fina vía la tabla
 * `idempotency_key` (helper claimOnce). Stubs por fase.
 */
async function dispatch(type: OutboxEventType, payload: Record<string, unknown>): Promise<void> {
  switch (type) {
    case 'work_item.created':
    case 'work_item.assigned':
      await notifyAssignment(payload as { workItemId?: string; devId?: string; identifier?: string });
      return;

    // Espejo bidireccional: issue creado/actualizado en Linear (de cualquier origen).
    case 'linear.issue_upserted': {
      const r = await syncIssueFromWebhook(payload.data);
      // Si Linear asignó a un dev conocido, notifícalo (misma vía que el chat). La clave
      // de idempotencia es compartida con confirm_proposal → nunca hay doble aviso.
      if (r.assigneeToNotify) {
        await emit('work_item.assigned', r.assigneeToNotify, {
          idempotencyKey: `assigned:${(payload.data as any)?.id}:${r.assigneeToNotify.devId}`,
        });
      }
      return;
    }
    case 'linear.issue_removed':
      await removeMirror(String(payload.linearId ?? ''));
      return;

    // Auto-onboarding de proyectos: Linear Project nuevo/actualizado → roz.project.
    case 'linear.project_upserted': {
      const d = payload.data as { id: string; name?: string; teamIds?: string[]; team?: { id?: string } };
      await upsertLinearProject({
        id: d.id,
        name: d.name,
        teamId: d.team?.id ?? d.teamIds?.[0] ?? null,
      });
      return;
    }

    case 'work_item.done':
      await documentCompletedWork(payload as { linearId?: string; identifier?: string });
      return;
    case 'commit.received':
      await reconcileCommit({
        repo: String(payload.repo ?? ''),
        sha: String(payload.sha ?? ''),
      });
      return;
    // Backfill de un push truncado (>20 commits): enumera el rango completo y encola cada commit.
    case 'commits.backfill':
      await backfillPushCommits({
        repo: String(payload.repo ?? ''),
        before: String(payload.before ?? ''),
        after: String(payload.after ?? ''),
      });
      return;
    // PR mergeada: documentar el trabajo en UN ticket con atribución (autor/revisor/merger).
    case 'pr.merged':
      await reconcilePullRequest({
        repo: String(payload.repo ?? ''),
        number: Number(payload.number ?? 0),
      });
      return;
    // Resumen de cambios documentados (auto-creados desde commits). Agrupado por dev+ventana
    // para que una PR con muchos commits genere UN solo correo, no uno por commit.
    case 'change.documented':
      await notifyChangesDocumented(String(payload.devId ?? ''));
      return;

    // Repo nuevo detectado (primer push de un repo desconocido): vincular a un proyecto si hay
    // match y emitir el aviso a los devs. El propio handler hace no-op si ya estaba trackeado.
    case 'repo.detected':
      // `meta` viene del evento `repository` de GitHub (evita pegarle a la API); si no está,
      // handleRepoDetected hace el fetch.
      await handleRepoDetected({
        repo: String(payload.repo ?? ''),
        meta: (payload.meta as RepoMeta | undefined) ?? undefined,
      });
      return;
    // Broadcast a todos los devs: se detectó/vinculó un repo.
    case 'repo.notify':
      await notifyRepoDetected(payload as { repo?: string; repoUrl?: string | null; projectName?: string | null; linked?: boolean });
      return;
    case 'notification.requested':
      // fase 3: enviar la notificación encolada
      return;
    default:
      return;
  }
}

/**
 * Reclama una llave de idempotencia: true si es la primera vez (procede el efecto), false
 * si ya se aplicó. Insert atómico; 23505 => ya existía.
 */
export async function claimOnce(key: string, scope: string): Promise<boolean> {
  const { error } = await db().from('idempotency_key').insert({ key, scope });
  if (error) {
    if ((error as { code?: string }).code === '23505') return false;
    throw error;
  }
  return true;
}

/**
 * Libera una llave reclamada. Úsalo cuando el efecto idempotente FALLA después de reclamar:
 * sin esto, el reintento ve la llave ocupada y se salta el trabajo para siempre. Llamar solo
 * tras un fallo, antes de relanzar, y nunca después de un efecto NO idempotente ya aplicado.
 */
export async function releaseOnce(key: string): Promise<void> {
  await db().from('idempotency_key').delete().eq('key', key);
}
