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
  /** Datos para el service worker (p. ej. `{ kind: 'chat', conversationId }` para no avisar de una
   *  conversación que la persona ya tiene abierta y enfocada). */
  data?: Record<string, unknown>;
}

/** Opciones de ENTREGA (cabeceras del push service, no viajan en el payload). */
export interface PushSendOptions {
  /** `high` despierta a un Android en reposo (Doze) al momento; `normal` puede esperar a la
   *  siguiente ventana de mantenimiento. Para chat, asignaciones y caídas: `high`. */
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Segundos que el push service guarda el aviso si el dispositivo está apagado o sin red. */
  ttl?: number;
}

// 24 h: un teléfono sin señal o apagado unas horas sigue recibiendo lo que pasó al reconectar
// (antes era 1 h y esos avisos se perdían). El `tag` evita que se apilen repetidos.
const DEFAULT_TTL = 24 * 60 * 60;

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

export async function sendPush(
  sub: PushSubscriptionKeys,
  payload: PushPayload,
  opts: PushSendOptions = {},
): Promise<PushSendResult> {
  if (!ensure()) return { ok: false, gone: false, error: 'web push no configurado' };
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: opts.ttl ?? DEFAULT_TTL, urgency: opts.urgency ?? 'normal' },
    );
    return { ok: true, gone: false };
  } catch (err) {
    const e = err as { statusCode?: number; body?: string; message?: string };
    const gone = e.statusCode === 404 || e.statusCode === 410;
    return { ok: false, gone, error: e.body || e.message || String(err) };
  }
}
