// Alertas de infraestructura por correo (Resend). Cuando un servicio cambia de estado —se cae,
// se detiene/apaga, o se recupera— avisamos a TODOS los devs activos con email, con el detalle
// para que lo revisen. Fase "solo datos": el disparo es por TRANSICIÓN de estado (lo detecta el
// poller), no por umbrales. Cada evento = un correo a cada dev, registrado en roz.notification.
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { sendEmail } from '../adapters/email.js';

const PROVIDER_NAME: Record<string, string> = { vercel: 'Vercel', railway: 'Railway', supabase: 'Supabase' };

export interface ServiceTransition {
  kind: 'down' | 'up';
  projectName: string;
  provider: string;
  serviceLabel: string;     // label o ref
  externalRef: string;
  status: string;           // normalizado (down | paused | healthy)
  providerStatus: string | null; // nativo (CRASHED, INACTIVE, SLEEPING…)
  error: string | null;
  deploy: { commitMessage?: string | null; branch?: string | null; author?: string | null } | null;
  lastSeenOkAt: string | null;  // para "down": última vez visto OK
  downtimeMs: number | null;    // para "up": cuánto estuvo caído
}

/** "2 h 15 min", "45 min", "3 d 4 h". Aproximado y legible. */
function fmtDuration(ms: number | null): string {
  if (!ms || ms <= 0) return 'un momento';
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
  if (!iso) return '—';
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${hh}:${mm}`;
}

/** Verbo legible del evento según el estado normalizado + el nativo del proveedor. */
function eventVerb(t: ServiceTransition): string {
  if (t.kind === 'up') return 'se recuperó';
  if (t.status === 'paused') {
    const ps = (t.providerStatus ?? '').toUpperCase();
    if (ps === 'SLEEPING') return 'se durmió';
    if (ps === 'INACTIVE') return 'se apagó';
    return 'se detuvo';
  }
  return 'se cayó';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render(t: ServiceTransition, dashboardUrl: string): { subject: string; html: string; text: string } {
  const provider = PROVIDER_NAME[t.provider] ?? t.provider;
  const verb = eventVerb(t);
  const svc = `${t.serviceLabel} (${provider})`;
  const down = t.kind === 'down';
  const accent = down ? '#dc2626' : '#16a34a';
  const bg = down ? '#fee2e2' : '#dcfce7';
  const icon = down ? '🔴' : '✅';

  const subject = down
    ? `${icon} ROZ · ${t.projectName}: ${t.serviceLabel} ${verb}`
    : `${icon} ROZ · ${t.projectName}: ${t.serviceLabel} se recuperó`;

  // Filas de detalle (label → valor).
  const rows: [string, string][] = [
    ['Proyecto', esc(t.projectName)],
    ['Servicio', esc(svc)],
    ['Estado', `${esc(t.providerStatus ?? t.status)}`],
  ];
  if (down && t.lastSeenOkAt) rows.push(['Visto OK por última vez', fmtDateTime(t.lastSeenOkAt)]);
  if (!down) rows.push(['Tiempo fuera de servicio', fmtDuration(t.downtimeMs)]);
  if (t.deploy?.commitMessage) rows.push(['Último deploy', esc(t.deploy.commitMessage)]);
  if (t.deploy?.branch) rows.push(['Branch', esc(t.deploy.branch)]);
  if (t.deploy?.author) rows.push(['Autor', `@${esc(t.deploy.author)}`]);
  rows.push(['Referencia', `<code style="font-family:ui-monospace,monospace;font-size:12px">${esc(t.externalRef)}</code>`]);
  if (down && t.error) rows.push(['Detalle', esc(t.error)]);

  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:7px 0;color:#6b7280;font-size:13px;width:42%;vertical-align:top">${k}</td>
         <td style="padding:7px 0;color:#111827;font-size:13px;vertical-align:top">${v}</td></tr>`,
    )
    .join('');

  const headline = down ? `Un servicio ${verb}` : `Servicio recuperado`;
  const sub = down
    ? `${esc(svc)} en <b>${esc(t.projectName)}</b> ${verb}. Revisa el estado.`
    : `${esc(svc)} en <b>${esc(t.projectName)}</b> volvió a estar operativo tras <b>${fmtDuration(t.downtimeMs)}</b>.`;

  const button = `<a href="${dashboardUrl}/app/infra" style="display:inline-block;background:#2853ff;color:#ffffff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:600;font-size:14px">Ver en el dashboard →</a>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="540" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e8eb">
      <tr><td style="background:#0d0d12;padding:20px 28px">
        <span style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:3px">ROZ</span>
        <span style="color:#8b8f9a;font-size:13px;margin-left:8px">Alerta de infraestructura</span>
      </td></tr>
      <tr><td style="padding:24px 28px 4px">
        <span style="display:inline-block;background:${bg};color:${accent};border-radius:8px;padding:4px 10px;font-size:12px;font-weight:700">${icon} ${esc(headline)}</span>
        <p style="margin:14px 0 18px;color:#111827;font-size:16px;line-height:1.5">${sub}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eef0f2">${rowsHtml}</table>
      </td></tr>
      <tr><td style="padding:18px 28px 26px" align="center">${button}</td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #eef0f2">
        <span style="color:#9ca3af;font-size:12px">Enviado por ROZ · siempre observando el progreso 👁️</span>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const textRows = rows.map(([k, v]) => `${k}: ${v.replace(/<[^>]+>/g, '')}`).join('\n');
  const text = `ROZ · ${subject}\n\n${sub.replace(/<[^>]+>/g, '')}\n\n${textRows}\n\nDashboard: ${dashboardUrl}/app/infra\n\n— ROZ`;

  return { subject, html, text };
}

/** Contenido compacto (título + cuerpo) para una notificación push de una transición. Reusa la
 *  misma lógica de verbo/proveedor que el correo, para que ambos canales digan lo mismo. */
export function renderServicePush(t: ServiceTransition): { title: string; body: string } {
  const provider = PROVIDER_NAME[t.provider] ?? t.provider;
  const verb = eventVerb(t);
  const icon = t.kind === 'down' ? '🔴' : '✅';
  const title = `${icon} ${t.projectName}: ${t.serviceLabel} ${verb}`;
  const body =
    t.kind === 'down'
      ? `${t.serviceLabel} (${provider}) ${verb}.${t.error ? ` ${t.error}` : ''}`
      : `${t.serviceLabel} (${provider}) volvió a estar operativo tras ${fmtDuration(t.downtimeMs)}.`;
  return { title, body };
}

/**
 * Notifica una lista de transiciones de servicio a TODOS los devs activos con email. Un correo por
 * evento por dev. Degrada en silencio si Resend no está configurado o no hay devs. Registra cada
 * envío en roz.notification (igual que el resto de notificaciones de roz).
 */
export async function notifyServiceTransitions(transitions: ServiceTransition[]): Promise<{ sent: number; failed: number }> {
  if (!transitions.length) return { sent: 0, failed: 0 };
  if (!config.resend.apiKey) return { sent: 0, failed: 0 };

  const supabase = db();
  const { data } = await supabase.from('dev').select('id, name, email').eq('active', true).not('email', 'is', null);
  const devs = (data ?? []) as { id: string; name: string | null; email: string | null }[];
  if (!devs.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  for (const t of transitions) {
    const { subject, html, text } = render(t, config.dashboard.url);
    const template = t.kind === 'down' ? 'infra_service_down' : 'infra_service_up';
    for (const dev of devs) {
      if (!dev.email) continue;
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
