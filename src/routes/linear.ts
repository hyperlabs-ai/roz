// Webhook de Linear: POST /webhooks/linear. Mismo patrón que el de GitHub: firma sobre el cuerpo
// CRUDO antes de parsear, anti-replay por webhookTimestamp y 200 rápido.
//
// Hace tres cosas, independientes:
//   · zeus (siempre que haya LINEAR_WEBHOOK_SECRET): borra en el acto la copia en memoria de los
//     tickets que muestra la bandeja, para que un cambio hecho en Linear se vea en segundos en vez de
//     esperar a que venza la caché. Es local y barato: no encola nada.
//   · aviso de asignación (sin espejo): un ticket nuevo con asignado, o un cambio de asignado, le
//     manda a esa persona el correo y el push de "te asignaron" (src/zeus/linear-notify.ts).
//   · espejo de roz v2 (solo con ROZ_LINEAR_SOT): encola 'linear.webhook' y el drain relee el issue.
//
// Sin secreto y sin espejo responde 200 sin hacer nada: un 4xx haría que Linear reintentara en bucle
// un webhook que nadie va a usar.
import { Hono } from 'hono';
import type { RozContext } from '../types/hono.js';
import { config } from '../config.js';
import { isFreshLinearWebhook, verifyLinearSignature } from '../adapters/linear.js';
import { emitV2 } from '../linear/emit.js';
import { linearSourceOfTruth } from '../linear/enabled.js';
import { toWebhookPayload } from '../linear/webhook.js';
import { invalidateFromWebhook } from '../zeus/linear-cache.js';
import { isAssignmentEvent, notifyLinearAssignment } from '../zeus/linear-notify.js';
import { inBackground } from '../utils/background.js';

export const linearWebhookRoutes = new Hono<RozContext>();

linearWebhookRoutes.post('/linear', async (c) => {
  const mirror = linearSourceOfTruth();
  if (!mirror && !config.linear.webhookSecret) return c.json({ ok: true, skipped: 'flag' });

  const raw = await c.req.text();
  if (!verifyLinearSignature(raw, c.req.header('linear-signature'), config.linear.webhookSecret)) {
    return c.json({ error: { code: 'BAD_SIGNATURE', message: 'firma inválida' } }, 401);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'cuerpo no es JSON' } }, 400);
  }
  if (!isFreshLinearWebhook((body as { webhookTimestamp?: unknown } | null)?.webhookTimestamp)) {
    return c.json({ error: { code: 'STALE_WEBHOOK', message: 'webhook viejo (posible repetición)' } }, 401);
  }

  const payload = toWebhookPayload(body, c.req.header('linear-delivery'), raw);
  // Forma desconocida (otra versión del webhook): se acepta y se ignora, sin que Linear reintente.
  if (!payload) return c.json({ ok: true, skipped: 'forma' });

  const refreshed = invalidateFromWebhook(payload.type);
  if (!mirror) {
    // Con el espejo encendido ese camino ya avisa; aquí, en segundo plano para contestar rápido.
    if (isAssignmentEvent(payload)) {
      const actor = (body as { actor?: { id?: unknown } }).actor?.id;
      const log = c.get('logger');
      inBackground(
        () => notifyLinearAssignment(String(payload.data.id), typeof actor === 'string' ? actor : null),
        (err) => log?.warn({ err: String(err), issue: payload.data.id }, 'linear: no se pudo avisar la asignación'),
      );
    }
    return c.json({ ok: true, refreshed });
  }

  await emitV2('linear.webhook', payload, { idempotencyKey: `linear:${payload.deliveryId}` });
  return c.json({ ok: true, refreshed });
});
