// Correo (Resend) de la bandeja de zeus. Dos casos, a propósito pocos:
//   · inmediato: un encargo o plan NUEVO (o la versión ajustada de un plan) le llega a quien lo
//     recibe, y quien lo mandó se entera por correo si le piden ajustes o se lo rechazan. Son cosas
//     que piden acción y son raras.
//   · resumen diario: los avisos de variables de entorno que cambiaron (y que la persona no ha leído
//     en roz) van juntos en UN correo al día. Uno por cambio sería ruido: un `env push` de 30
//     variables mandaría 30 correos.
// El resto (mensajes sueltos, aceptado/hecho) se queda en la bandeja y el push.
//
// Respeta los interruptores de notificación (global y por dev). Nunca lanza: el aviso es un extra y
// no puede tumbar la acción que lo dispara. Un correo por (mensaje, evento) o (dev, día): claimOnce.
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { sendEmail } from '../adapters/email.js';
import { claimOnce, releaseOnce } from '../events/outbox.js';
import { emailAllowed } from '../notify/switches.js';
import { renderEmail, zeusEnvDigestNotice, zeusWorkNotice, type ZeusEnvChangeItem, type ZeusWorkEvent } from '../notify/copy.js';

const inboxUrl = (): string => `${config.dashboard.url.replace(/\/$/, '')}/bandeja`;

interface DevRow {
  id: string;
  name: string;
  email: string | null;
  github_login: string | null;
}

async function devsById(ids: Array<string | null>): Promise<Map<string, DevRow>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const { data, error } = await db().from('dev').select('id, name, email, github_login').in('id', uniq);
  if (error) throw error;
  return new Map(((data ?? []) as DevRow[]).map((d) => [d.id, d]));
}

/** Registro en `notification`, como los demás correos de roz. Best-effort. */
function logNotification(row: Record<string, unknown>): Promise<void> {
  return Promise.resolve(
    db()
      .from('notification')
      .insert({ channel: 'email', ...row }),
  ).then(
    () => undefined,
    () => undefined,
  );
}

/** Manda un correo una sola vez por `key`. Si el envío falla, libera la llave (se puede reintentar). */
async function sendOnce(key: string, scope: string, dev: DevRow, template: string, mail: { subject: string; html: string; text: string }): Promise<boolean> {
  if (!dev.email) return false;
  if (!(await claimOnce(key, scope))) return false;
  try {
    const res = await sendEmail({ to: dev.email, ...mail });
    await logNotification({ to_dev_id: dev.id, to_address: dev.email, template, body: mail.text, status: res.suppressed ? 'suppressed' : 'sent', provider_id: res.id });
    return !res.suppressed;
  } catch (err) {
    await logNotification({ to_dev_id: dev.id, to_address: dev.email, template, body: mail.text, status: 'failed', error: String(err) });
    await releaseOnce(key).catch(() => undefined);
    return false;
  }
}

/**
 * Correo inmediato de un encargo o plan. `event` decide a quién: lo nuevo/ajustado a quien lo
 * recibe; los ajustes pedidos y el rechazo, a quien lo mandó.
 */
export async function mailWorkEvent(messageId: string, event: ZeusWorkEvent): Promise<boolean> {
  try {
    const { data, error } = await db()
      .from('zeus_message')
      .select('id, kind, from_dev_id, to_dev_id, subject, body, status_note, project_id')
      .eq('id', messageId)
      .maybeSingle();
    if (error || !data) return false;
    const m = data as { id: string; kind: string; from_dev_id: string | null; to_dev_id: string; subject: string | null; body: string; status_note: string | null; project_id: string | null };
    if (m.kind !== 'task' && m.kind !== 'plan') return false;
    const toSender = event === 'changes_requested' || event === 'declined';
    const recipientId = toSender ? m.from_dev_id : m.to_dev_id;
    const actorId = toSender ? m.to_dev_id : m.from_dev_id;
    if (!recipientId || recipientId === actorId) return false;
    if (!(await emailAllowed(recipientId))) return false;

    const devs = await devsById([recipientId, actorId]);
    const recipient = devs.get(recipientId);
    if (!recipient) return false;
    let project: string | null = null;
    if (m.project_id) {
      const { data: p } = await db().from('project').select('name').eq('id', m.project_id).maybeSingle();
      project = (p as { name: string } | null)?.name ?? null;
    }
    const notice = zeusWorkNotice({
      seed: `zeus:${m.id}:${event}`,
      recipient: recipient.name,
      actor: actorId ? (devs.get(actorId)?.name ?? null) : null,
      actorLogin: actorId ? (devs.get(actorId)?.github_login ?? null) : null,
      kind: m.kind,
      event,
      title: m.subject ?? '',
      project,
      note: toSender ? m.status_note : null,
      excerpt: toSender ? null : m.body,
      url: inboxUrl(),
    });
    return await sendOnce(`zeus-mail:${m.id}:${event}`, 'zeus-mail', recipient, `zeus_${m.kind}_${event}`, renderEmail(notice, config.dashboard.url));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- resumen diario de variables

/** Lee lo que `notifyEnvChange` escribió en el aviso: nombres por grupo y el entorno. */
export function parseEnvNotice(subject: string | null, body: string, actor: string): ZeusEnvChangeItem | null {
  const list = (prefix: string): string[] => {
    const line = body.split('\n').find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length).split(',').map((s) => s.trim()).filter(Boolean) : [];
  };
  const cmd = /zeus env pull (\S+) (\S+)/.exec(body);
  const label = cmd ? `${cmd[1]}/${cmd[2]}` : (/de (\S+\/\S+)$/.exec(subject ?? '')?.[1] ?? null);
  if (!label) return null;
  return { label, actor, added: list('Nuevas:'), changed: list('Cambiaron:'), deleted: list('Se quitaron:'), rotated: /rotó la llave/i.test(body) };
}

export interface EnvDigestResult {
  devs: number;
  notices: number;
}

/**
 * A cada dev, UN correo con los avisos de variables de las últimas 24 h que aún no leyó en roz.
 * Lo corre el planificador una vez al día; idempotente por (dev, día).
 */
export async function sendZeusEnvDigests(now: Date = new Date()): Promise<EnvDigestResult> {
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const day = now.toISOString().slice(0, 10);
  const { data, error } = await db()
    .from('zeus_message')
    .select('id, from_dev_id, to_dev_id, subject, body, created_at')
    .eq('kind', 'env_change')
    .is('read_at', null)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(2000);
  if (error) throw error;
  type Row = { id: string; from_dev_id: string | null; to_dev_id: string; subject: string | null; body: string; created_at: string };
  const rows = (data ?? []) as Row[];
  if (!rows.length) return { devs: 0, notices: 0 };

  const devs = await devsById(rows.flatMap((r) => [r.to_dev_id, r.from_dev_id]));
  const byDev = new Map<string, Row[]>();
  for (const r of rows) byDev.set(r.to_dev_id, [...(byDev.get(r.to_dev_id) ?? []), r]);

  let sent = 0;
  let notices = 0;
  for (const [devId, list] of byDev) {
    try {
      const dev = devs.get(devId);
      if (!dev || !(await emailAllowed(devId))) continue;
      const changes = list
        .map((r) => parseEnvNotice(r.subject, r.body, r.from_dev_id ? (devs.get(r.from_dev_id)?.name ?? 'alguien') : 'zeus'))
        .filter((c): c is ZeusEnvChangeItem => !!c);
      if (!changes.length) continue;
      const notice = zeusEnvDigestNotice({ seed: `zeus-env:${devId}:${day}`, recipient: dev.name, changes, url: inboxUrl() });
      if (await sendOnce(`zeus-env-digest:${devId}:${day}`, 'zeus-env-digest', dev, 'zeus_env_digest', renderEmail(notice, config.dashboard.url))) {
        sent++;
        notices += changes.length;
      }
    } catch {
      // best-effort por dev
    }
  }
  return { devs: sent, notices };
}
