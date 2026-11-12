// Webhook de Linear → espejo. La ruta (src/routes/linear.ts) solo verifica firma y frescura y
// encola 'linear.webhook'; esto corre en el drain del outbox, con reintentos.
//
// Para un Issue se RELEE el issue completo (getIssue): el cuerpo del webhook no trae ciclo ni
// etiquetas completas, y así el espejo recibe siempre la misma forma que en la reconciliación.
import { createHash } from 'node:crypto';
import { getIssue } from '../adapters/linear.js';
import type { LinearWebhookPayload } from '../types/roz-v2.js';
import { linearSourceOfTruth } from './enabled.js';
import { syncLinearLinks } from './links.js';
import { retireMirror, upsertMirrorFromLinear } from './mirror.js';

/** Entidades cuyo cambio refresca linear_link (etiquetas → tipos de solución, usuarios → devs…). */
const LINK_ENTITIES = new Set(['IssueLabel', 'User', 'Project', 'Team', 'WorkflowState']);

/**
 * Cuerpo crudo del webhook → payload del outbox. null si no tiene la forma mínima. Puro (probado).
 * `deliveryId` = header `linear-delivery`; si faltara, el sha256 del cuerpo (mismo cuerpo, misma llave).
 */
export function toWebhookPayload(body: unknown, deliveryHeader: string | null | undefined, rawBody: string, now = new Date()): LinearWebhookPayload | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const action = b.action;
  if (action !== 'create' && action !== 'update' && action !== 'remove') return null;
  if (typeof b.type !== 'string' || !b.data || typeof b.data !== 'object') return null;
  const ts = typeof b.webhookTimestamp === 'string' ? Number(b.webhookTimestamp) : b.webhookTimestamp;
  return {
    deliveryId: deliveryHeader?.trim() || createHash('sha256').update(rawBody).digest('hex'),
    type: b.type,
    action,
    data: b.data as Record<string, unknown>,
    updatedFrom: b.updatedFrom && typeof b.updatedFrom === 'object' ? (b.updatedFrom as Record<string, unknown>) : null,
    webhookTimestamp: typeof ts === 'number' && Number.isFinite(ts) ? ts : 0,
    receivedAt: now.toISOString(),
  };
}

export async function handleLinearWebhook(p: LinearWebhookPayload): Promise<void> {
  if (!linearSourceOfTruth()) return;

  if (p.type === 'Issue') {
    const id = typeof p.data.id === 'string' ? p.data.id : null;
    if (!id) return;
    if (p.action === 'remove') {
      await retireMirror(id);
      return;
    }
    const issue = await getIssue(id);
    // Borrado entre el webhook y la relectura: sale igual que un 'remove'.
    if (!issue) {
      await retireMirror(id);
      return;
    }
    await upsertMirrorFromLinear(issue, { source: 'webhook' });
    return;
  }

  if (LINK_ENTITIES.has(p.type)) {
    await syncLinearLinks();
  }
  // Comment, Cycle, Reaction, … no cambian el espejo.
}

/** Outbox 'linear.webhook'. */
export async function linearWebhookFromEvent(payload: Record<string, unknown>): Promise<void> {
  await handleLinearWebhook(payload as unknown as LinearWebhookPayload);
}
