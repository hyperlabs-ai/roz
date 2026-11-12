// Webhook de Linear (roz v2): POST /webhooks/linear. Mismo patrón que el de GitHub: firma sobre el
// cuerpo CRUDO antes de parsear, anti-replay por webhookTimestamp, un OutboxEvent y 200 rápido. El
// trabajo (releer el issue, escribir el espejo) lo hace el drain.
//
// Con ROZ_LINEAR_SOT apagado responde 200 sin emitir: un 4xx/5xx haría que Linear reintentara en
// bucle un webhook que nadie va a usar.
import { Hono } from 'hono';
import type { RozContext } from '../types/hono.js';
import { config } from '../config.js';
import { isFreshLinearWebhook, verifyLinearSignature } from '../adapters/linear.js';
import { emitV2 } from '../linear/emit.js';
import { linearSourceOfTruth } from '../linear/enabled.js';
import { toWebhookPayload } from '../linear/webhook.js';

export const linearWebhookRoutes = new Hono<RozContext>();

linearWebhookRoutes.post('/linear', async (c) => {
  if (!linearSourceOfTruth()) return c.json({ ok: true, skipped: 'flag' });

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

  await emitV2('linear.webhook', payload, { idempotencyKey: `linear:${payload.deliveryId}` });
  return c.json({ ok: true });
});
