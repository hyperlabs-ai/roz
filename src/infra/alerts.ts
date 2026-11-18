// Alertas de infraestructura por correo (Resend). El poller detecta el evento y aquí se redacta.
// Tres eventos que NO se confunden entre sí:
//   - 'down'          el servicio dejó de atender (caído, dormido o apagado).
//   - 'deploy_failed' falló un intento de deploy; producción sigue en línea con el anterior.
//   - 'up'            el servicio volvió a atender.
// Lo firma Roz-bot en primera persona, con el nombre de quien hizo el commit cuando se sabe y la
// causa tal cual la reporta el proveedor (paso, mensaje, cola del log). Texto fijo, sin AI.
// Cada evento = un correo a cada dev activo, registrado en roz.notification.
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { sendEmail } from '../adapters/email.js';
import { emailAllowed, emailEnabled } from '../notify/switches.js';
import type { DeployRef, FailureInfo } from './types.js';
import type { TransitionKind } from './transitions.js';
import { renderEmailDoc, type EmailBlock, type EmailFact, type EmailTone } from '../notify/email-layout.js';

const PROVIDER_NAME: Record<string, string> = { vercel: 'Vercel', railway: 'Railway', supabase: 'Supabase' };

export interface ServiceTransition {
  kind: TransitionKind;
  projectName: string;
  provider: string;
  serviceLabel: string;     // label o ref
  externalRef: string;
  status: string;           // normalizado (down | paused | healthy)
  providerStatus: string | null; // nativo (CRASHED, INACTIVE, SLEEPING…)
  error: string | null;
  deploy: { commitMessage?: string | null; branch?: string | null; author?: string | null; sha?: string | null } | null;
  lastSeenOkAt: string | null;  // para "down": última vez visto OK
  downtimeMs: number | null;    // para "up": cuánto estuvo caído
  /** Último intento de deploy y el que atiende producción (Vercel/Railway). */
  lastDeploy?: DeployRef | null;
  serving?: DeployRef | null;
  /** Causa reportada por el proveedor; null si no se pudo leer. */
  failure?: FailureInfo | null;
  /** Dev de roz dueño del commit del último intento, si su usuario de GitHub está dado de alta. */
  authorDevId?: string | null;
  authorName?: string | null;
}

/** "2 h 15 min", "45 min", "3 d 4 h". Aproximado y legible. */
export function fmtDuration(ms: number | null): string {
  if (!ms || ms <= 0) return 'un momento';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const remMin = min % 60;
  if (h < 24) return remMin ? `${h} h ${remMin} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d} d ${remH} h` : `${d} d`;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fmtDateTime(iso: string | null): string {
  if (!iso) return 'sin dato';
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${hh}:${mm}`;
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : null);

/** Quién hizo el commit, como se le nombra en el aviso. `self` = el aviso va para esa persona. */
function who(t: ServiceTransition): string | null {
  return t.authorName ?? (t.lastDeploy?.author ? `@${t.lastDeploy.author}` : t.deploy?.author ? `@${t.deploy.author}` : null);
}

/** "en el paso buildStep" / "al construir" / "" según lo que el proveedor haya dicho. */
function stepPhrase(f: FailureInfo | null | undefined): string {
  if (!f?.step) return '';
  if (f.step === 'build') return ' al construir';
  if (f.step === 'ejecución') return ' al arrancar';
  return ` en el paso ${f.step}`;
}

/** La mejor línea de causa: mensaje del proveedor, o la última línea de error del log. */
function causeLine(t: ServiceTransition): string | null {
  const f = t.failure;
  const msg = f?.message ?? f?.logTail?.[f.logTail.length - 1] ?? (t.kind === 'down' ? t.error : null);
  if (!msg) return null;
  return clip(f?.code && !msg.includes(f.code) ? `${f.code}: ${msg}` : msg, 180);
}

/** Qué le pasó al servicio en un 'down', distinguiendo dormido/apagado de caído. */
function downVerb(t: ServiceTransition): string {
  if (t.status === 'paused') {
    const ps = (t.providerStatus ?? '').toUpperCase();
    if (ps === 'SLEEPING') return 'se durmió';
    if (ps === 'INACTIVE' || ps === 'PAUSED') return 'está pausado';
    return 'se detuvo';
  }
  return 'está caído';
}

/** "con el deploy anterior (abc1234, de Alan)" cuando se sabe cuál sirve. */
function servingPhrase(t: ServiceTransition): string {
  const s = t.serving;
  if (!s) return 'con el deploy anterior';
  const sha = shortSha(s.sha);
  const bits = [sha, s.createdAt ? `del ${fmtDateTime(s.createdAt)}` : null].filter(Boolean);
  return bits.length ? `con el deploy anterior (${bits.join(', ')})` : 'con el deploy anterior';
}

interface Copy {
  /** Título corto (asunto del correo y título del push). */
  title: string;
  /** Una o dos frases, en primera persona. */
  body: string;
}

/**
 * El texto del aviso. `self` = quien lo recibe es quien hizo el commit (le habla de "tu deploy").
 * Es la única redacción: correo y push salen de aquí.
 */
export function serviceCopy(t: ServiceTransition, self = false): Copy {
  const provider = PROVIDER_NAME[t.provider] ?? t.provider;
  const svc = t.serviceLabel;
  const author = who(t);
  const cause = causeLine(t);
  const branch = t.lastDeploy?.branch ?? t.deploy?.branch ?? null;

  if (t.kind === 'deploy_failed') {
    const whose = self ? 'Tu deploy' : author ? `El deploy de ${author}` : 'El último deploy';
    const where = branch ? ` (${branch})` : '';
    const parts = [
      `${whose} en ${svc}${where} falló${stepPhrase(t.failure)}.`,
      cause ? `${provider} dice: ${cause}` : null,
      `Producción sigue en línea ${servingPhrase(t)}.`,
    ];
    return { title: `Falló un deploy de ${svc} en ${t.projectName}`, body: parts.filter(Boolean).join(' ') };
  }

  if (t.kind === 'down') {
    const verb = downVerb(t);
    const paused = t.status === 'paused';
    const parts = [
      `${svc} (${provider}) ${verb}${paused ? '' : ' y no está atendiendo'}.`,
      cause ? `${provider} dice: ${cause}` : null,
      !paused && t.failure?.scope === 'deploy' && author ? `El último deploy fue ${self ? 'tuyo' : `de ${author}`} y no hay otro sirviendo.` : null,
      t.lastSeenOkAt ? `Lo vi bien por última vez el ${fmtDateTime(t.lastSeenOkAt)}.` : null,
    ];
    return { title: `${svc} de ${t.projectName} ${verb}`, body: parts.filter(Boolean).join(' ') };
  }

  const parts = [
    `${svc} (${provider}) volvió a estar en línea${t.downtimeMs ? ` tras ${fmtDuration(t.downtimeMs)} fuera` : ''}.`,
    t.serving?.sha ? `Está sirviendo ${shortSha(t.serving.sha)}${author ? `, de ${self ? 'tu commit' : author}` : ''}.` : null,
  ];
  return { title: `${svc} de ${t.projectName} volvió a estar en línea`, body: parts.filter(Boolean).join(' ') };
}

const TONE: Record<TransitionKind, { tone: EmailTone; tag: string; bot: string }> = {
  down: { tone: 'alert', tag: 'Servicio sin atender', bot: 'roz-bot-alert.png' },
  deploy_failed: { tone: 'warn', tag: 'Deploy fallido, producción en línea', bot: 'roz-bot-thinking.png' },
  up: { tone: 'ok', tag: 'Servicio recuperado', bot: 'roz-bot-happy.png' },
};

const STATUS_CHIP: Record<string, { label: string; tone: EmailTone }> = {
  healthy: { label: 'En línea', tone: 'ok' },
  paused: { label: 'Pausado', tone: 'neutral' },
  down: { label: 'Caído', tone: 'alert' },
  degraded: { label: 'Degradado', tone: 'warn' },
};

/** El correo de una transición, en el layout único de roz (src/notify/email-layout.ts). */
export function render(t: ServiceTransition, dashboardUrl: string, to: { name: string | null; self: boolean }): { subject: string; html: string; text: string } {
  const provider = PROVIDER_NAME[t.provider] ?? t.provider;
  const copy = serviceCopy(t, to.self);
  const tone = TONE[t.kind];
  const failed = t.kind !== 'up';
  const first = to.name?.trim().split(/\s+/)[0];
  const base = dashboardUrl.replace(/\/+$/, '');

  // Detalle: solo lo que se sabe.
  const status = STATUS_CHIP[t.status] ?? { label: t.status, tone: 'neutral' as EmailTone };
  const facts: EmailFact[] = [
    { label: 'Proyecto', value: t.projectName },
    { label: 'Servicio', value: `${t.serviceLabel} en ${provider}` },
    { label: 'Estado', value: status.label, chip: status.tone },
  ];
  const last = t.lastDeploy;
  if (last && failed) {
    const sha = shortSha(last.sha);
    facts.push({ label: t.kind === 'deploy_failed' ? 'Deploy que falló' : 'Último deploy', value: last.message ? clip(last.message, 90) : last.nativeState });
    if (sha) facts.push({ label: 'Commit', value: sha, mono: true });
    const by = who(t);
    if (by) facts.push({ label: 'Autor', value: by, ...(last.author ? { person: { name: by, login: last.author } } : {}) });
    if (last.branch) facts.push({ label: 'Rama', value: last.branch, mono: true });
    if (last.durationMs) facts.push({ label: 'Duró', value: fmtDuration(last.durationMs) });
  }
  if (failed && t.failure?.step) facts.push({ label: 'Falló en', value: t.failure.step });
  if (t.kind === 'deploy_failed' && t.serving) {
    const sha = shortSha(t.serving.sha);
    facts.push({ label: 'Sigue sirviendo', value: (sha ? `${sha}${t.serving.message ? ` (${clip(t.serving.message, 70)})` : ''}` : t.serving.message ? clip(t.serving.message, 70) : '') || 'El deploy anterior' });
  }
  if (t.kind === 'down' && t.lastSeenOkAt) facts.push({ label: 'Visto bien por última vez', value: fmtDateTime(t.lastSeenOkAt) });
  if (t.kind === 'up') facts.push({ label: 'Tiempo fuera', value: fmtDuration(t.downtimeMs) });

  const cause = failed ? causeLine(t) : null;
  const tail = failed ? (t.failure?.logTail ?? []).slice(-6) : [];
  const blocks: EmailBlock[] = [
    ...(cause ? [{ kind: 'callout' as const, tone: tone.tone, text: `${provider} dice: ${cause}` }] : []),
    { kind: 'facts', rows: facts },
    ...(tail.length ? [{ kind: 'code' as const, title: 'Últimas líneas del log', lines: tail }] : []),
  ];

  return renderEmailDoc({
    subject: copy.title,
    preheader: copy.body,
    botFile: tone.bot,
    section: 'Infraestructura',
    kicker: tone.tag,
    tone: tone.tone,
    headline: copy.title,
    // La causa va en su recuadro: en el texto no se repite.
    lead: `${first ? `Hola ${first}. ` : ''}${cause ? copy.body.replace(`${provider} dice: ${cause}`, '').replace(/\s+/g, ' ').trim() : copy.body}`,
    blocks,
    cta: { label: 'Ver en roz', url: `${base}/infra` },
    secondary: failed && last?.inspectorUrl ? { label: `Abrir el deploy en ${provider}`, url: last.inspectorUrl } : null,
    reason: 'Reviso tus servicios cada pocos minutos y te aviso cuando cambian de estado.',
    base,
  });
}

/** Contenido compacto (título + cuerpo) para una notificación push de una transición. Reusa la
 *  misma redacción que el correo, para que ambos canales digan lo mismo. */
export function renderServicePush(t: ServiceTransition): { title: string; body: string } {
  const copy = serviceCopy(t);
  return { title: copy.title, body: clip(copy.body, 220) };
}

const TEMPLATE: Record<TransitionKind, string> = {
  down: 'infra_service_down',
  up: 'infra_service_up',
  deploy_failed: 'infra_deploy_failed',
};

/**
 * Notifica una lista de transiciones de servicio a TODOS los devs activos con email. Un correo por
 * evento por dev, con saludo por nombre (y "tu deploy" para quien hizo el commit). Degrada en
 * silencio si Resend no está configurado o no hay devs. Registra cada envío en roz.notification.
 */
export async function notifyServiceTransitions(transitions: ServiceTransition[]): Promise<{ sent: number; failed: number }> {
  if (!transitions.length) return { sent: 0, failed: 0 };
  await inboxTransitions(transitions);
  if (!config.resend.apiKey) return { sent: 0, failed: 0 };
  if (!(await emailEnabled())) return { sent: 0, failed: 0 }; // killswitch de equipo

  const supabase = db();
  const { data } = await supabase.from('dev').select('id, name, email').eq('active', true).not('email', 'is', null);
  const devs = (data ?? []) as { id: string; name: string | null; email: string | null }[];
  if (!devs.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  for (const t of transitions) {
    const template = TEMPLATE[t.kind];
    for (const dev of devs) {
      if (!dev.email) continue;
      if (!(await emailAllowed(dev.id))) continue; // silenciado por esta persona
      const { subject, html, text } = render(t, config.dashboard.url, { name: dev.name, self: !!t.authorDevId && t.authorDevId === dev.id });
      try {
        const res = await sendEmail({ to: dev.email, subject, html, text });
        await supabase.from('notification').insert({ channel: 'email', to_dev_id: dev.id, to_address: dev.email, template, body: text, status: 'sent', provider_id: res.id });
        sent++;
      } catch (err) {
        await supabase.from('notification').insert({ channel: 'email', to_dev_id: dev.id, to_address: dev.email, template, body: text, status: 'failed', error: String(err) });
        failed++;
      }
    }
  }
  return { sent, failed };
}

/**
 * Bandeja de zeus: un servicio caído o un deploy fallido es trabajo pendiente de alguien. Le queda a
 * quien hizo el último deploy (si es dev de roz) o, sin autor conocido, a quien administra zeus. La
 * recuperación no deja mensaje (no pide nada). Independiente del correo; nunca lanza.
 */
async function inboxTransitions(transitions: ServiceTransition[]): Promise<void> {
  try {
    const pending = transitions.filter((t) => t.kind !== 'up');
    if (!pending.length) return;
    // Import diferido: la bandeja arrastra config de zeus que el poller no necesita para el correo.
    const { inboxNotice } = await import('../zeus/inbox.js');
    let admins: string[] | null = null;
    for (const t of pending) {
      let targets: string[];
      if (t.authorDevId) targets = [t.authorDevId];
      else {
        if (!admins) {
          const { data } = await db().from('dev').select('id, role, zeus_admin').eq('active', true);
          admins = ((data ?? []) as Array<{ id: string; role: string | null; zeus_admin: boolean | null }>).filter((d) => d.zeus_admin || d.role === 'ceo').map((d) => d.id);
        }
        targets = admins;
      }
      const marker = t.lastDeploy?.sha ?? t.lastSeenOkAt ?? t.providerStatus ?? '';
      for (const devId of targets) {
        const copy = serviceCopy(t, devId === t.authorDevId);
        await inboxNotice({ toDevId: devId, subject: copy.title, body: copy.body, dedupeKey: `infra:${t.kind}:${t.externalRef}:${marker}:${devId}` });
      }
    }
  } catch {
    // best-effort: el correo y el push siguen su curso
  }
}
