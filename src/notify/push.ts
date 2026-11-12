// Web Push para la PWA. Espeja notify/notifications.ts y infra/alerts.ts, pero por el canal push:
//   · guarda / borra suscripciones (las autoriza el usuario desde el dashboard),
//   · envía las mismas alertas de infraestructura que van por correo a quien activó el push.
// Registra cada envío en roz.notification con channel='push' (igual que el email). Degrada en
// silencio si no hay llaves VAPID o no hay suscripciones.
import { db } from '../db/supabase.js';
import { config } from '../config.js';
import { sendPush, pushEnabled, type PushPayload, type PushSendOptions } from '../adapters/web-push.js';
import { pushAllowed, pushEnabledGlobally } from './switches.js';
import { renderServicePush, type ServiceTransition } from '../infra/alerts.js';
import { botIcon, testNotice } from './copy.js';

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

const SELECT = 'id, dev_id, endpoint, p256dh, auth';

// Núcleo de entrega: manda `payload` a un set de suscripciones, registra en roz.notification y
// limpia las caducadas (404/410). No lanza; el caller decide el best-effort.
/** `logSent: false` registra solo los fallos: el chat manda un push por mensaje, y registrar cada
 *  envío exitoso inundaría roz.notification (que es el historial de avisos que sí importa). */
export interface DeliverOptions {
  logSent?: boolean;
  /** Prioridad de entrega en el push service (ver PushSendOptions). Por defecto `normal`. */
  urgency?: PushSendOptions['urgency'];
}

async function deliver(subs: SubRow[], payload: PushPayload, template: string, opts: DeliverOptions = {}): Promise<{ sent: number; failed: number }> {
  // Interruptores (roz.notification_switch): el global apaga el push de todo el entorno; el de cada
  // dev lo silencia en TODOS sus dispositivos. El toggle por dispositivo es la suscripción misma.
  // Se filtra aquí, el único punto por el que pasan todos los envíos.
  if (!(await pushEnabledGlobally())) return { sent: 0, failed: 0 };
  const targets: SubRow[] = [];
  for (const sub of subs) if (await pushAllowed(sub.dev_id)) targets.push(sub);

  const supabase = db();
  const logBody = `${payload.title} · ${payload.body}`;
  let sent = 0;
  let failed = 0;
  for (const s of targets) {
    const res = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload, { urgency: opts.urgency });
    if (res.ok) {
      sent++;
      if (opts.logSent === false) continue;
      await supabase.from('notification').insert({ channel: 'push', to_dev_id: s.dev_id, to_address: s.endpoint, template, body: logBody, status: 'sent' });
    } else if (res.gone) {
      await supabase.from('push_subscription').delete().eq('id', s.id);
    } else {
      failed++;
      await supabase.from('notification').insert({ channel: 'push', to_dev_id: s.dev_id, to_address: s.endpoint, template, body: logBody, status: 'failed', error: res.error });
    }
  }
  return { sent, failed };
}

function dedupe(rows: SubRow[]): SubRow[] {
  const seen = new Set<string>();
  return rows.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

/** Push a un developer concreto: sus suscripciones por dev_id y/o por email (por si se suscribió
 *  antes de resolverse el dev). Best-effort: nunca lanza, no debe romper el flujo de email/outbox. */
export async function pushToDev(
  devId: string | null | undefined,
  email: string | null | undefined,
  payload: PushPayload,
  template: string,
  opts: DeliverOptions = {},
): Promise<void> {
  if (!pushEnabled() || (!devId && !email)) return;
  try {
    const supabase = db();
    const rows: SubRow[] = [];
    if (devId) {
      const { data } = await supabase.from('push_subscription').select(SELECT).eq('dev_id', devId);
      rows.push(...((data ?? []) as SubRow[]));
    }
    if (email) {
      const { data } = await supabase.from('push_subscription').select(SELECT).ilike('email', email);
      rows.push(...((data ?? []) as SubRow[]));
    }
    const subs = dedupe(rows);
    if (subs.length) await deliver(subs, payload, template, opts);
  } catch { /* best-effort */ }
}

/** Push a las suscripciones de un email (cuando solo tenemos el correo, no el dev). Best-effort. */
export async function pushToEmail(email: string | null | undefined, payload: PushPayload, template: string): Promise<void> {
  if (!pushEnabled() || !email) return;
  try {
    const { data } = await db().from('push_subscription').select(SELECT).ilike('email', email);
    const subs = (data ?? []) as SubRow[];
    if (subs.length) await deliver(subs, payload, template);
  } catch { /* best-effort */ }
}

/** Push a TODAS las suscripciones (avisos de equipo, p. ej. repo nuevo). Best-effort. */
export async function pushBroadcast(payload: PushPayload, template: string): Promise<void> {
  if (!pushEnabled()) return;
  try {
    const { data } = await db().from('push_subscription').select(SELECT);
    const subs = (data ?? []) as SubRow[];
    if (subs.length) await deliver(subs, payload, template);
  } catch { /* best-effort */ }
}

/** "Windows · Chrome", "Android · Chrome", "iPhone · Safari"… a partir del user agent guardado al
 *  suscribirse. Solo para que la persona reconozca sus dispositivos en Configuración. */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'Dispositivo desconocido';
  const os =
    /iphone/i.test(ua) ? 'iPhone'
    : /ipad/i.test(ua) ? 'iPad'
    : /android/i.test(ua) ? 'Android'
    : /windows/i.test(ua) ? 'Windows'
    : /mac os x|macintosh/i.test(ua) ? 'Mac'
    : /cros/i.test(ua) ? 'ChromeOS'
    : /linux/i.test(ua) ? 'Linux'
    : 'Otro';
  // El orden importa: Edge, Opera y Samsung también dicen "Chrome"; Chrome también dice "Safari".
  const browser =
    /edg\//i.test(ua) ? 'Edge'
    : /opr\/|opera/i.test(ua) ? 'Opera'
    : /samsungbrowser/i.test(ua) ? 'Samsung Internet'
    : /firefox|fxios/i.test(ua) ? 'Firefox'
    : /chrome|crios/i.test(ua) ? 'Chrome'
    : /safari/i.test(ua) ? 'Safari'
    : 'Navegador';
  return `${os} · ${browser}`;
}

export interface TestDevice {
  label: string;
  ok: boolean;
  /** La suscripción ya no existía (se borró): ese dispositivo debe volver a activar. */
  gone: boolean;
  lastUsedAt: string | null;
}

export interface TestPushResult {
  /** Por qué no salió nada, si no salió: sin VAPID, push del equipo apagado o el mío silenciado. */
  blocked: 'vapid' | 'global' | 'muted' | null;
  devices: TestDevice[];
}

/**
 * Aviso de prueba a TODOS los dispositivos de la persona (por cuenta, dev y correo: una suscripción
 * puede haberse guardado antes de resolverse el dev). Sirve para comprobar que llega al teléfono y a
 * la computadora. A diferencia de `deliver`, reporta el resultado por dispositivo y la razón de un
 * bloqueo, en vez de omitir en silencio. No se registra en roz.notification (no es un aviso real).
 */
export async function sendTestPush(input: { authUserId: string; devId: string | null; email: string | null }): Promise<TestPushResult> {
  if (!pushEnabled()) return { blocked: 'vapid', devices: [] };
  if (!(await pushEnabledGlobally())) return { blocked: 'global', devices: [] };
  if (!(await pushAllowed(input.devId))) return { blocked: 'muted', devices: [] };

  const supabase = db();
  const cols = `${SELECT}, user_agent, last_used_at`;
  const queries = [supabase.from('push_subscription').select(cols).eq('auth_user_id', input.authUserId)];
  if (input.devId) queries.push(supabase.from('push_subscription').select(cols).eq('dev_id', input.devId));
  if (input.email) queries.push(supabase.from('push_subscription').select(cols).ilike('email', input.email));
  type Row = SubRow & { user_agent: string | null; last_used_at: string | null };
  const rows = (await Promise.all(queries)).flatMap((r) => (r.data ?? []) as Row[]);
  const subs = dedupe(rows) as Row[];

  let recipient: string | null = null;
  if (input.devId) {
    const { data: me } = await supabase.from('dev').select('name').eq('id', input.devId).maybeSingle();
    recipient = (me as { name: string | null } | null)?.name ?? null;
  }
  const payload: PushPayload = {
    ...testNotice(recipient),
    icon: botIcon('happy'),
    url: `${config.dashboard.url}/app/settings`,
    tag: 'push-test',
    data: { kind: 'test' },
  };
  const devices = await Promise.all(
    subs.map(async (s): Promise<TestDevice> => {
      const res = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload, { urgency: 'high', ttl: 300 });
      if (res.gone) await supabase.from('push_subscription').delete().eq('id', s.id);
      return { label: deviceLabel(s.user_agent), ok: res.ok, gone: res.gone, lastUsedAt: s.last_used_at };
    }),
  );
  return { blocked: null, devices };
}

/**
 * Envía las transiciones de servicio a TODAS las suscripciones push (quienes activaron las
 * notificaciones). Mismo disparador y contenido que el correo. Degrada en silencio sin
 * VAPID/suscripciones; limpia suscripciones caducadas.
 */
export async function notifyServiceTransitionsPush(
  transitions: ServiceTransition[],
): Promise<{ sent: number; failed: number }> {
  if (!transitions.length || !pushEnabled()) return { sent: 0, failed: 0 };

  const supabase = db();
  const { data } = await supabase.from('push_subscription').select(SELECT);
  const subs = (data ?? []) as SubRow[];
  if (!subs.length) return { sent: 0, failed: 0 };

  const base = config.dashboard.url;
  let sent = 0;
  let failed = 0;
  for (const t of transitions) {
    const { title, body } = renderServicePush(t);
    const template =
      t.kind === 'down' ? 'infra_service_down' : t.kind === 'deploy_failed' ? 'infra_deploy_failed' : 'infra_service_up';
    const icon = botIcon(t.kind === 'up' ? 'happy' : 'alert');
    const r = await deliver(
      subs,
      { title, body, icon, url: `${base}/app/infra`, tag: `infra:${t.externalRef}`, requireInteraction: t.kind === 'down' },
      template,
      { urgency: t.kind === 'down' ? 'high' : 'normal' },
    );
    sent += r.sent;
    failed += r.failed;
  }
  return { sent, failed };
}
