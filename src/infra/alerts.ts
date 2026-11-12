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

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    return { title: `Falló un deploy en ${svc} · ${t.projectName}`, body: parts.filter(Boolean).join(' ') };
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
    return { title: `${svc} ${verb} · ${t.projectName}`, body: parts.filter(Boolean).join(' ') };
  }

  const parts = [
    `${svc} (${provider}) volvió a estar en línea${t.downtimeMs ? ` tras ${fmtDuration(t.downtimeMs)} fuera` : ''}.`,
    t.serving?.sha ? `Está sirviendo ${shortSha(t.serving.sha)}${author ? `, de ${self ? 'tu commit' : author}` : ''}.` : null,
  ];
  return { title: `${svc} volvió a estar en línea · ${t.projectName}`, body: parts.filter(Boolean).join(' ') };
}

const TONE: Record<TransitionKind, { accent: string; bg: string; tag: string }> = {
  down: { accent: '#c2410c', bg: '#ffe4d6', tag: 'Servicio sin atender' },
  deploy_failed: { accent: '#a16207', bg: '#fef3c7', tag: 'Deploy fallido · producción en línea' },
  up: { accent: '#15803d', bg: '#dcfce7', tag: 'Servicio recuperado' },
};

export function render(t: ServiceTransition, dashboardUrl: string, to: { name: string | null; self: boolean }): { subject: string; html: string; text: string } {
  const provider = PROVIDER_NAME[t.provider] ?? t.provider;
  const copy = serviceCopy(t, to.self);
  const tone = TONE[t.kind];
  const failed = t.kind !== 'up';
  const first = to.name?.trim().split(/\s+/)[0];
  const hello = first ? `Hola ${first}.` : 'Hola.';

  // Filas de detalle (label → valor). Solo lo que se sabe.
  const rows: [string, string][] = [
    ['Proyecto', esc(t.projectName)],
    ['Servicio', `${esc(t.serviceLabel)} · ${esc(provider)}`],
    ['Estado del servicio', t.status === 'healthy' ? 'En línea' : t.status === 'paused' ? 'Pausado' : t.status === 'down' ? 'Caído' : esc(t.status)],
  ];
  const last = t.lastDeploy;
  if (last && failed) {
    const sha = shortSha(last.sha);
    const label = t.kind === 'deploy_failed' ? 'Deploy que falló' : 'Último deploy';
    rows.push([label, [last.message ? esc(clip(last.message, 90)) : null, sha ? `<code style="font-family:ui-monospace,monospace;font-size:12px">${sha}</code>` : null].filter(Boolean).join(' · ') || esc(last.nativeState)]);
    const by = who(t);
    if (by) rows.push(['Autor', esc(by)]);
    if (last.branch) rows.push(['Rama', esc(last.branch)]);
    if (last.durationMs) rows.push(['Duró', fmtDuration(last.durationMs)]);
  }
  if (failed && t.failure?.step) rows.push(['Falló en', esc(t.failure.step)]);
  const cause = causeLine(t);
  if (failed && cause) rows.push(['Causa', esc(cause)]);
  if (t.kind === 'deploy_failed' && t.serving) {
    const sha = shortSha(t.serving.sha);
    rows.push(['Sigue sirviendo', [sha ? `<code style="font-family:ui-monospace,monospace;font-size:12px">${sha}</code>` : null, t.serving.message ? esc(clip(t.serving.message, 70)) : null].filter(Boolean).join(' · ') || 'El deploy anterior']);
  }
  if (t.kind === 'down' && t.lastSeenOkAt) rows.push(['Visto bien por última vez', fmtDateTime(t.lastSeenOkAt)]);
  if (t.kind === 'up') rows.push(['Tiempo fuera', fmtDuration(t.downtimeMs)]);

  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:7px 0;color:#7a7268;font-size:13px;width:38%;vertical-align:top">${k}</td>
         <td style="padding:7px 0;color:#1c1917;font-size:13px;vertical-align:top">${v}</td></tr>`,
    )
    .join('');

  const tail = failed ? (t.failure?.logTail ?? []).slice(-6) : [];
  const logHtml = tail.length
    ? `<p style="margin:16px 0 6px;color:#7a7268;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase">Últimas líneas del log</p>
       <pre style="margin:0;background:#1c1917;color:#f5efe6;border-radius:10px;padding:12px 14px;font-family:ui-monospace,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word">${esc(tail.join('\n'))}</pre>`
    : '';

  const inspect = failed && last?.inspectorUrl ? `<a href="${last.inspectorUrl}" style="color:#c2410c;font-size:13px;margin-left:14px">Abrir el deploy en ${esc(provider)}</a>` : '';
  const button = `<a href="${dashboardUrl}/app/infra" style="display:inline-block;background:#ff6b35;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px">Ver en roz</a>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f5efe6;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="540" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e7dfd3">
      <tr><td style="background:#1c1917;padding:18px 28px">
        <span style="color:#ff6b35;font-size:18px;font-weight:800">roz</span>
        <span style="color:#a8a096;font-size:13px;margin-left:8px">Roz-bot · infraestructura</span>
      </td></tr>
      <tr><td style="padding:24px 28px 4px">
        <span style="display:inline-block;background:${tone.bg};color:${tone.accent};border-radius:8px;padding:4px 10px;font-size:12px;font-weight:700">${esc(tone.tag)}</span>
        <p style="margin:14px 0 18px;color:#1c1917;font-size:16px;line-height:1.5">${esc(hello)} ${esc(copy.body)}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #efe8dc">${rowsHtml}</table>
        ${logHtml}
      </td></tr>
      <tr><td style="padding:20px 28px 26px">${button}${inspect}</td></tr>
      <tr><td style="padding:14px 28px;border-top:1px solid #efe8dc">
        <span style="color:#a8a096;font-size:12px">Te lo cuenta Roz-bot. Reviso tus servicios cada pocos minutos.</span>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const textRows = rows.map(([k, v]) => `${k}: ${v.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')}`).join('\n');
  const textLog = tail.length ? `\n\nÚltimas líneas del log:\n${tail.join('\n')}` : '';
  const text = `${hello} ${copy.body}\n\n${textRows}${textLog}\n\nVer en roz: ${dashboardUrl}/app/infra\n\nRoz-bot`;

  return { subject: `Roz: ${copy.title}`, html, text };
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
