// Web Push (VAPID) vía la librería `web-push`. Firma y entrega un payload cifrado al push service
// del navegador (FCM/APNs/Mozilla, según el dispositivo). Mismo espíritu que adapters/email.ts:
// una primitiva de envío; el "a quién / qué" vive en notify/push.ts. Degrada si no hay llaves.
import webpush from 'web-push';
import { config } from '../config.js';

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// Lo que recibe el service worker en el evento `push` (ver web/public/sw.js).
export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
  requireInteraction?: boolean;
}

export interface PushSendResult {
  ok: boolean;
  gone: boolean; // 404/410 → la suscripción ya no existe; el caller debe borrarla
  error?: string;
}

let configured = false;

/** ¿Hay llaves VAPID? Si no, el push degrada en silencio (igual que Resend sin API key). */
export function pushEnabled(): boolean {
  return !!(config.webPush.publicKey && config.webPush.privateKey);
}

function ensure(): boolean {
  if (!pushEnabled()) return false;
  if (!configured) {
    webpush.setVapidDetails(config.webPush.subject, config.webPush.publicKey, config.webPush.privateKey);
    configured = true;
  }
  return true;
}

export async function sendPush(sub: PushSubscriptionKeys, payload: PushPayload): Promise<PushSendResult> {
  if (!ensure()) return { ok: false, gone: false, error: 'web push no configurado' };
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 3600 },
    );
    return { ok: true, gone: false };
  } catch (err) {
    const e = err as { statusCode?: number; body?: string; message?: string };
    const gone = e.statusCode === 404 || e.statusCode === 410;
    return { ok: false, gone, error: e.body || e.message || String(err) };
  }
}
