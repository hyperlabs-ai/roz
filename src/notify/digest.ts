// Digest semanal por correo. Lo dispara el cron de Vercel los viernes en la noche
// (ver vercel.json → /v1/internal/weekly-digest). Resume la última semana (commits, tickets
// resueltos, contribuidores, líneas, cycle time) comparada con la semana previa, lista los
// proyectos con más movimiento y enlaza al Resumen del dashboard. Destinatarios y URL son
// configurables (config.digest.recipients, config.dashboard.url).
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { sendEmail } from '../adapters/email.js';
import { getOverview, getDeveloper, previousPeriod, type Metric, type Period } from '../dashboard/queries.js';

export interface DigestResult {
  sent: number;
  failed: number;
  skipped?: string;
}

/** Últimos 7 días, terminando ahora (one-shot desde cron → usar la hora real es seguro). */
function lastWeekPeriod(): Period {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function fmtNum(n: number): string {
  return Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n);
}

/** Chip de variación vs. semana pasada (verde sube / rojo baja). invert: menos es mejor. */
function deltaChip(m: Metric, invert = false): string {
  if (m.direction === 'none' || m.changePct === null || m.direction === 'flat') {
    return `<span style="color:#9ca3af;font-size:12px">—</span>`;
  }
  const good = invert ? m.direction === 'down' : m.direction === 'up';
  const color = good ? '#16a34a' : '#dc2626';
  const bg = good ? '#dcfce7' : '#fee2e2';
  const arrow = m.direction === 'up' ? '▲' : '▼';
  return `<span style="display:inline-block;background:${bg};color:${color};border-radius:6px;padding:2px 7px;font-size:11px;font-weight:700">${arrow} ${Math.abs(m.changePct)}%</span>`;
}

function kpiCell(label: string, value: string, m: Metric, invert = false): string {
  return `<td style="padding:14px 10px;text-align:center;border:1px solid #eef0f2;border-radius:10px">
    <div style="color:#111827;font-size:22px;font-weight:800;line-height:1">${value}</div>
    <div style="color:#6b7280;font-size:12px;margin:6px 0 8px">${label}</div>
    ${deltaChip(m, invert)}
  </td>`;
}

function renderDigest(opts: { overview: Awaited<ReturnType<typeof getOverview>>; url: string; rangeLabel: string }): { html: string; text: string } {
  const { overview: o, url, rangeLabel } = opts;
  const k = o.kpis;
  const topProjects = o.byProject.slice(0, 5);

  const projectRows = topProjects.length
    ? topProjects
        .map(
          (p) =>
            `<tr><td style="padding:8px 0;color:#111827;font-size:14px">${p.name}</td>
             <td style="padding:8px 0;text-align:right;color:#6b7280;font-size:13px">${p.commits} commits · ${p.ticketsResolved} tickets</td></tr>`,
        )
        .join('')
    : `<tr><td style="padding:8px 0;color:#9ca3af;font-size:13px">Sin actividad registrada esta semana</td></tr>`;

  const button = `<a href="${url}/" style="display:inline-block;background:#2853ff;color:#ffffff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:600;font-size:14px">Ver el resumen completo →</a>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="540" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e8eb">
      <tr><td style="background:#0d0d12;padding:20px 28px">
        <span style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:3px">ROZ</span>
        <span style="color:#8b8f9a;font-size:13px;margin-left:8px">Resumen semanal</span>
      </td></tr>
      <tr><td style="padding:28px 28px 8px">
        <p style="margin:0 0 4px;color:#111827;font-size:18px;font-weight:700">Lo que se trabajó esta semana</p>
        <p style="margin:0 0 20px;color:#6b7280;font-size:13px">${rangeLabel} · comparado con la semana anterior</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate"><tr>
          ${kpiCell('Commits', fmtNum(k.commits.value), k.commits)}
          ${kpiCell('Tickets', fmtNum(k.ticketsResolved.value), k.ticketsResolved)}
          ${kpiCell('Activos', fmtNum(k.activeContributors.value), k.activeContributors)}
        </tr><tr style="height:6px"></tr><tr>
          ${kpiCell('Líneas', fmtNum(k.linesChanged.value), k.linesChanged)}
          ${kpiCell('Cycle time', k.avgCycleTimeHours.value ? `${k.avgCycleTimeHours.value}h` : '—', k.avgCycleTimeHours, true)}
          <td style="border:1px solid #ffffff"></td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:12px 28px 8px">
        <p style="margin:0 0 6px;color:#111827;font-size:14px;font-weight:700">Proyectos con más movimiento</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${projectRows}</table>
      </td></tr>
      <tr><td style="padding:20px 28px 28px" align="center">${button}</td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #eef0f2">
        <span style="color:#9ca3af;font-size:12px">Enviado por ROZ · siempre observando el progreso 👁️</span>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const text =
    `ROZ · Resumen semanal (${rangeLabel})\n\n` +
    `Commits: ${k.commits.value}\nTickets resueltos: ${k.ticketsResolved.value}\n` +
    `Contribuidores activos: ${k.activeContributors.value}\nLíneas cambiadas: ${k.linesChanged.value}\n` +
    `Cycle time: ${k.avgCycleTimeHours.value}h\n\n` +
    `Ver el resumen completo: ${url}/\n\n— ROZ`;

  return { html, text };
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function label(p: Period): string {
  const f = new Date(p.from);
  const t = new Date(p.to);
  return `${f.getDate()} ${MONTHS[f.getMonth()]} – ${t.getDate()} ${MONTHS[t.getMonth()]}`;
}

// ---- Digest personal por dev ----

function firstName(name: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0] || '';
}

function renderDevDigest(opts: { profile: NonNullable<Awaited<ReturnType<typeof getDeveloper>>>; url: string; rangeLabel: string }): { html: string; text: string } {
  const { profile: p, url, rangeLabel } = opts;
  const k = p.kpis;
  const greeting = p.dev.name ? `Hola ${firstName(p.dev.name)},` : 'Hola,';
  const projects = p.projects.slice(0, 5);
  const resolved = p.tickets.resolved.slice(0, 8);

  const projectRows = projects.length
    ? projects
        .map(
          (pr) =>
            `<tr><td style="padding:7px 0;color:#111827;font-size:14px">${pr.name}</td>
             <td style="padding:7px 0;text-align:right;color:#6b7280;font-size:13px">${pr.commits} commits</td></tr>`,
        )
        .join('')
    : `<tr><td style="padding:7px 0;color:#9ca3af;font-size:13px">Sin commits esta semana</td></tr>`;

  const resolvedRows = resolved.length
    ? resolved
        .map(
          (t) =>
            `<tr><td style="padding:6px 0;color:#6b7280;font-size:12px;font-family:ui-monospace,monospace;white-space:nowrap;padding-right:10px;vertical-align:top">${t.identifier}</td>
             <td style="padding:6px 0;color:#111827;font-size:13px">${t.title}</td></tr>`,
        )
        .join('')
    : `<tr><td style="padding:6px 0;color:#9ca3af;font-size:13px">Sin tickets cerrados esta semana</td></tr>`;

  const button = `<a href="${url}/developers/${p.dev.id}" style="display:inline-block;background:#2853ff;color:#ffffff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:600;font-size:14px">Ver tu perfil completo →</a>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="540" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e8eb">
      <tr><td style="background:#0d0d12;padding:20px 28px">
        <span style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:3px">ROZ</span>
        <span style="color:#8b8f9a;font-size:13px;margin-left:8px">Tu semana</span>
      </td></tr>
      <tr><td style="padding:28px 28px 8px">
        <p style="margin:0 0 4px;color:#111827;font-size:18px;font-weight:700">${greeting}</p>
        <p style="margin:0 0 20px;color:#6b7280;font-size:13px">Esto fue tu trabajo · ${rangeLabel} · vs. la semana anterior</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate"><tr>
          ${kpiCell('Commits', fmtNum(k.commits.value), k.commits)}
          ${kpiCell('Tickets', fmtNum(k.ticketsResolved.value), k.ticketsResolved)}
        </tr><tr style="height:6px"></tr><tr>
          ${kpiCell('Líneas', fmtNum(k.linesChanged.value), k.linesChanged)}
          ${kpiCell('Cycle time', k.avgCycleTimeHours.value ? `${k.avgCycleTimeHours.value}h` : '—', k.avgCycleTimeHours, true)}
        </tr></table>
      </td></tr>
      <tr><td style="padding:12px 28px 4px">
        <p style="margin:0 0 6px;color:#111827;font-size:14px;font-weight:700">En qué trabajaste</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${projectRows}</table>
      </td></tr>
      <tr><td style="padding:14px 28px 4px">
        <p style="margin:0 0 6px;color:#111827;font-size:14px;font-weight:700">Tickets que cerraste</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${resolvedRows}</table>
      </td></tr>
      <tr><td style="padding:20px 28px 28px" align="center">${button}</td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #eef0f2">
        <span style="color:#9ca3af;font-size:12px">Enviado por ROZ · siempre observando el progreso 👁️</span>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const text =
    `ROZ · Tu semana (${rangeLabel})\n\n${greeting}\n\n` +
    `Commits: ${k.commits.value}\nTickets resueltos: ${k.ticketsResolved.value}\n` +
    `Líneas cambiadas: ${k.linesChanged.value}\nCycle time: ${k.avgCycleTimeHours.value}h\n\n` +
    `En qué trabajaste:\n${projects.map((pr) => `- ${pr.name}: ${pr.commits} commits`).join('\n') || '- Sin commits esta semana'}\n\n` +
    `Tickets que cerraste:\n${resolved.map((t) => `- ${t.identifier}: ${t.title}`).join('\n') || '- Ninguno'}\n\n` +
    `Tu perfil: ${url}/developers/${p.dev.id}\n\n— ROZ`;

  return { html, text };
}

/**
 * Digest personal por dev: cada dev activo con email (EXCEPTO los destinatarios del digest de
 * equipo, p.ej. fer, para no duplicar) recibe el resumen de SU propio trabajo de la semana. Se
 * omiten los devs sin actividad (nada que resumir). Lo dispara el mismo cron del viernes.
 */
export async function sendDevWeeklyDigests(): Promise<DigestResult> {
  if (!config.resend.apiKey) return { sent: 0, failed: 0, skipped: 'RESEND_API_KEY no configurado' };

  const period = lastWeekPeriod();
  const cmp = previousPeriod(period);
  const rangeLabel = label(period);
  const subject = `ROZ · Tu semana (${rangeLabel})`;
  const supabase = db();
  const exclude = new Set(config.digest.recipients.map((e) => e.toLowerCase()));

  const { data } = await supabase.from('dev').select('id, name, email').eq('active', true).not('email', 'is', null);
  const devs = (data ?? []) as { id: string; name: string | null; email: string | null }[];

  let sent = 0;
  let failed = 0;
  for (const dev of devs) {
    if (!dev.email || exclude.has(dev.email.toLowerCase())) continue;
    const profile = await getDeveloper(dev.id, period, cmp);
    if (!profile) continue;
    // Sin trabajo que resumir esta semana → no se envía (evita correos vacíos).
    if (profile.kpis.commits.value === 0 && profile.kpis.ticketsResolved.value === 0) continue;

    const { html, text } = renderDevDigest({ profile, url: config.dashboard.url, rangeLabel });
    try {
      const res = await sendEmail({ to: dev.email, subject, html, text });
      await supabase.from('notification').insert({ channel: 'email', to_dev_id: dev.id, to_address: dev.email, template: 'dev_weekly_digest', body: text, status: 'sent', provider_id: res.id });
      sent++;
    } catch (err) {
      await supabase.from('notification').insert({ channel: 'email', to_dev_id: dev.id, to_address: dev.email, template: 'dev_weekly_digest', body: text, status: 'failed', error: String(err) });
      failed++;
    }
  }
  return { sent, failed };
}

/** Genera y envía el digest a los destinatarios configurados. Registra cada envío. */
export async function sendWeeklyDigest(): Promise<DigestResult> {
  if (!config.digest.recipients.length) return { sent: 0, failed: 0, skipped: 'sin destinatarios' };
  if (!config.resend.apiKey) return { sent: 0, failed: 0, skipped: 'RESEND_API_KEY no configurado' };

  const period = lastWeekPeriod();
  const overview = await getOverview(period, previousPeriod(period));
  const { html, text } = renderDigest({ overview, url: config.dashboard.url, rangeLabel: label(period) });
  const subject = `ROZ · Resumen semanal (${label(period)})`;

  const supabase = db();
  let sent = 0;
  let failed = 0;
  for (const to of config.digest.recipients) {
    try {
      const res = await sendEmail({ to, subject, html, text });
      await supabase.from('notification').insert({ channel: 'email', to_address: to, template: 'weekly_digest', body: text, status: 'sent', provider_id: res.id });
      sent++;
    } catch (err) {
      await supabase.from('notification').insert({ channel: 'email', to_address: to, template: 'weekly_digest', body: text, status: 'failed', error: String(err) });
      failed++;
    }
  }
  return { sent, failed };
}
