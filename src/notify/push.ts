// Web Push para la PWA. Espeja notify/notifications.ts y infra/alerts.ts, pero por el canal push:
//   · guarda / borra suscripciones (las autoriza el usuario desde el dashboard),
//   · envía las mismas alertas de infraestructura que van por correo a quien activó el push.
// Registra cada envío en roz.notification con channel='push' (igual que el email). Degrada en
// silencio si no hay llaves VAPID o no hay suscripciones.
import { db } from '../db/supabase.js';
import { config } from '../config.js';
import { sendPush, pushEnabled, type PushPayload } from '../adapters/web-push.js';
import { renderServicePush, type ServiceTransition } from '../infra/alerts.js';

interface SubRow {
  id: string;
  dev_id: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Estructura que manda el navegador (PushSubscription.toJSON()). */
export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Guarda (o actualiza) la suscripción push de un usuario. Resuelve el dev por email para poder
 *  atarla al mismo developer que ya recorre el bucle de alertas. Upsert por endpoint (único). */
export async function savePushSubscription(input: {
  authUserId: string;
  email: string | null;
  subscription: BrowserSubscription;
  userAgent?: string | null;
}): Promise<void> {
  const supabase = db();

  let devId: string | null = null;
  if (input.email) {
    const { data } = await supabase.from('dev').select('id').ilike('email', input.email).limit(1);
    devId = (data as { id: string }[] | null)?.[0]?.id ?? null;
  }

  await supabase.from('push_subscription').upsert(
    {
      auth_user_id: input.authUserId,
      dev_id: devId,
      email: input.email,
      endpoint: input.subscription.endpoint,
      p256dh: input.subscription.keys.p256dh,
      auth: input.subscription.keys.auth,
      user_agent: input.userAgent ?? null,
      last_used_at: new Date().toISOString(),
    },
    { onConflict: 'endpoint' },
  );
}

/** Borra una suscripción (el usuario desactiva las notificaciones o el navegador la revocó). */
export async function deletePushSubscription(endpoint: string): Promise<void> {
  await db().from('push_subscription').delete().eq('endpoint', endpoint);
}

/**
 * Envía las transiciones de servicio a TODAS las suscripciones push registradas (quienes activaron
 * las notificaciones). Mismo disparador y contenido que el correo. Limpia suscripciones caducadas
 * (404/410). Registra cada envío en roz.notification. Degrada en silencio sin VAPID/suscripciones.
 */
export async function notifyServiceTransitionsPush(
  transitions: ServiceTransition[],
): Promise<{ sent: number; failed: number }> {
  if (!transitions.length || !pushEnabled()) return { sent: 0, failed: 0 };

  const supabase = db();
  const { data } = await supabase.from('push_subscription').select('id, dev_id, endpoint, p256dh, auth');
  const subs = (data ?? []) as SubRow[];
  if (!subs.length) return { sent: 0, failed: 0 };

  const base = config.dashboard.url;
  let sent = 0;
  let failed = 0;

  for (const t of transitions) {
    const { title, body } = renderServicePush(t);
    const template = t.kind === 'down' ? 'infra_service_down' : 'infra_service_up';
    const payload: PushPayload = {
      title,
      body,
      url: `${base}/app/infra`,
      tag: `infra:${t.externalRef}`,
      requireInteraction: t.kind === 'down',
    };

    for (const s of subs) {
      const res = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload);
      if (res.ok) {
        sent++;
        await supabase.from('notification').insert({
          channel: 'push', to_dev_id: s.dev_id, to_address: s.endpoint, template, body: `${title} — ${body}`, status: 'sent',
        });
      } else if (res.gone) {
        await supabase.from('push_subscription').delete().eq('id', s.id);
      } else {
        failed++;
        await supabase.from('notification').insert({
          channel: 'push', to_dev_id: s.dev_id, to_address: s.endpoint, template, body: `${title} — ${body}`, status: 'failed', error: res.error,
        });
      }
    }
  }

  return { sent, failed };
}
