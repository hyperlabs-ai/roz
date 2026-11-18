// Digest semanal por correo (equipo y por dev). Lo dispara el planificador los viernes en la noche
// (/v1/internal/weekly-digest). Resume la última semana (commits, tickets resueltos, contribuidores,
// líneas, cycle time) comparada con la semana previa, lista los proyectos con más movimiento y
// enlaza al dashboard. Destinatarios y URL son configurables (config.digest.recipients,
// config.dashboard.url). El HTML sale del layout único de correo (./email-layout.ts).
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { sendEmail } from '../adapters/email.js';
import { pushToDev, pushToEmail } from './push.js';
import { emailAllowed, emailEnabled } from './switches.js';
import { devDigestNotice, rangeLabel as fmtRange, teamDigestNotice, toPush } from './copy.js';
import { renderEmailDoc, type EmailBlock, type EmailKpi, type EmailListItem, type EmailTone } from './email-layout.js';
import { getOverview, getDeveloper, listInfra, previousPeriod, type Metric, type Period } from '../dashboard/queries.js';

export interface DigestResult {
  sent: number;
  failed: number;
  skipped?: string;
}

/** Últimos 7 días, terminando ahora (one-shot desde cron → usar la hora real es seguro). */
export function lastWeekPeriod(): Period {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function fmtNum(n: number): string {
  return Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n);
}

/** Variación vs. la semana pasada, como texto y tono (verde mejora, rojo empeora). invert: menos es mejor. */
function delta(m: Metric, invert = false): EmailKpi['delta'] {
  if (m.direction === 'none' || m.changePct === null || m.direction === 'flat') return { text: 'sin cambio', tone: 'neutral' };
  const good = invert ? m.direction === 'down' : m.direction === 'up';
  return { text: `${m.direction === 'up' ? '+' : '-'}${Math.abs(m.changePct)}%`, tone: good ? 'ok' : 'alert' };
}

const kpi = (label: string, value: string, m: Metric, invert = false): EmailKpi => ({ label, value, delta: delta(m, invert) });

// Infraestructura en el digest de equipo: estado por proyecto. Vacío si no hay servicios vinculados.
const INFRA_TONE: Record<string, EmailTone> = { healthy: 'ok', degraded: 'warn', down: 'alert', paused: 'neutral', unknown: 'neutral' };
const INFRA_LABEL: Record<string, [string, string]> = { healthy: ['operativo', 'operativos'], degraded: ['degradado', 'degradados'], down: ['caído', 'caídos'], paused: ['pausado', 'pausados'], unknown: ['sin datos', 'sin datos'] };
const INFRA_ORDER = ['down', 'degraded', 'paused', 'healthy', 'unknown'];

function infraBlocks(infra: Awaited<ReturnType<typeof listInfra>>): EmailBlock[] {
  const projects = infra.projects.filter((p) => p.services.length);
  const services = projects.flatMap((p) => p.services);
  if (!services.length) return [];
  const counts: Record<string, number> = {};
  services.forEach((s) => (counts[s.status] = (counts[s.status] ?? 0) + 1));
  const worst = (sts: string[]) => INFRA_ORDER.find((o) => sts.includes(o)) ?? 'unknown';
  const isIssue = (st: string) => st === 'down' || st === 'degraded' || st === 'paused';
  const totalReq = services.reduce((a, s) => a + (s.metrics?.requests ?? 0), 0);
  const summary = `${services.length} servicios: ${INFRA_ORDER.filter((o) => counts[o]).map((o) => `${counts[o]} ${INFRA_LABEL[o]![counts[o] === 1 ? 0 : 1]}`).join(', ')}${totalReq > 0 ? `. ${fmtNum(totalReq)} peticiones en las últimas 24 h` : ''}`;
  const items: EmailListItem[] = projects.map((p) => {
    const issues = p.services.filter((s) => isIssue(s.status)).length;
    const w = worst(p.services.map((s) => s.status));
    return {
      text: p.name,
      meta: `${p.services.length} ${p.services.length === 1 ? 'servicio' : 'servicios'}`,
      chip: issues > 0 ? { label: `${issues} con alerta`, tone: INFRA_TONE[w] ?? 'warn' } : { label: 'Todo en línea', tone: 'ok' },
    };
  });
  return [{ kind: 'callout', tone: counts.down ? 'alert' : counts.degraded ? 'warn' : 'ok', text: `Infraestructura: ${summary}.` }, { kind: 'list', title: 'Servicios por proyecto', items }];
}

export function renderDigest(opts: { overview: Awaited<ReturnType<typeof getOverview>>; infra: Awaited<ReturnType<typeof listInfra>>; url: string; rangeLabel: string }): { html: string; text: string } {
  const { overview: o, infra, url, rangeLabel } = opts;
  const k = o.kpis;
  const base = url.replace(/\/+$/, '');
  const { html, text } = renderEmailDoc({
    subject: `La semana del equipo, ${rangeLabel}`,
    preheader: `${k.commits.value} commits y ${k.ticketsResolved.value} tickets resueltos, ${rangeLabel}`,
    botFile: 'roz-bot.png',
    section: 'Resumen semanal',
    kicker: 'Resumen del equipo',
    tone: 'brand',
    headline: 'Lo que se trabajó esta semana',
    lead: `${rangeLabel}. Cada número trae su variación contra la semana anterior.`,
    blocks: [
      {
        kind: 'kpis',
        items: [
          kpi('Commits', fmtNum(k.commits.value), k.commits),
          kpi('Tickets', fmtNum(k.ticketsResolved.value), k.ticketsResolved),
          kpi('Activos', fmtNum(k.activeContributors.value), k.activeContributors),
          kpi('Líneas', fmtNum(k.linesChanged.value), k.linesChanged),
          kpi('Cycle time', k.avgCycleTimeHours.value ? `${k.avgCycleTimeHours.value}h` : 'n/d', k.avgCycleTimeHours, true),
        ],
      },
      {
        kind: 'list',
        title: 'Proyectos con más movimiento',
        empty: 'Sin actividad registrada esta semana.',
        items: o.byProject.slice(0, 5).map((p) => ({ text: p.name, meta: `${p.commits} commits y ${p.ticketsResolved} tickets` })),
      },
      ...infraBlocks(infra),
    ],
    cta: { label: 'Ver el resumen completo', url: `${base}/resumen` },
    reason: 'Te llega porque recibes el resumen semanal del equipo.',
    base,
  });
  return { html, text };
}

export function label(p: Period): string {
  const f = new Date(p.from);
  const t = new Date(p.to);
  return fmtRange(f.toISOString(), t.toISOString());
}

// ---- Digest personal por dev ----

function firstName(name: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0] || '';
}

export function renderDevDigest(opts: { profile: NonNullable<Awaited<ReturnType<typeof getDeveloper>>>; url: string; rangeLabel: string }): { html: string; text: string } {
  const { profile: p, url, rangeLabel } = opts;
  const k = p.kpis;
  const base = url.replace(/\/+$/, '');
  const name = firstName(p.dev.name);
  const { html, text } = renderEmailDoc({
    subject: `Tu semana, ${rangeLabel}`,
    preheader: `${k.commits.value} commits y ${k.ticketsResolved.value} tickets cerrados, ${rangeLabel}`,
    botFile: 'roz-bot-happy.png',
    section: 'Tu semana',
    kicker: 'Tu semana en números',
    tone: 'ok',
    headline: name ? `${name}, así te fue esta semana` : 'Así te fue esta semana',
    lead: `Revisé tu trabajo del ${rangeLabel} y lo comparé con la semana anterior.`,
    blocks: [
      {
        kind: 'kpis',
        items: [
          kpi('Commits', fmtNum(k.commits.value), k.commits),
          kpi('Tickets', fmtNum(k.ticketsResolved.value), k.ticketsResolved),
          kpi('Líneas', fmtNum(k.linesChanged.value), k.linesChanged),
          kpi('Cycle time', k.avgCycleTimeHours.value ? `${k.avgCycleTimeHours.value}h` : 'n/d', k.avgCycleTimeHours, true),
        ],
      },
      {
        kind: 'list',
        title: 'En qué trabajaste',
        empty: 'Sin commits esta semana.',
        items: p.projects.slice(0, 5).map((pr) => ({ text: pr.name, meta: `${pr.commits} commits` })),
      },
      {
        kind: 'list',
        title: 'Tickets que cerraste',
        empty: 'Sin tickets cerrados esta semana.',
        items: p.tickets.resolved.slice(0, 8).map((t) => ({ code: t.identifier, text: t.name })),
      },
    ],
    cta: { label: 'Ver tu perfil completo', url: `${base}/developers/${p.dev.id}` },
    reason: 'Te llega cada viernes si trabajaste en algo esa semana.',
    base,
  });
  return { html, text };
}

/**
 * Digest personal por dev: cada dev activo con email (EXCEPTO los destinatarios del digest de
 * equipo, p.ej. fer, para no duplicar) recibe el resumen de SU propio trabajo de la semana. Se
 * omiten los devs sin actividad (nada que resumir). Lo dispara el mismo cron del viernes.
 */
export async function sendDevWeeklyDigests(): Promise<DigestResult> {
  if (!config.resend.apiKey) return { sent: 0, failed: 0, skipped: 'RESEND_API_KEY no configurado' };
  if (!(await emailEnabled())) return { sent: 0, failed: 0, skipped: 'notificaciones por correo apagadas' };

  const period = lastWeekPeriod();
  const cmp = previousPeriod(period);
  const rangeLabel = label(period);
  const supabase = db();
  const exclude = new Set(config.digest.recipients.map((e) => e.toLowerCase()));

  const { data } = await supabase.from('dev').select('id, name, email').eq('active', true).not('email', 'is', null);
  const devs = (data ?? []) as { id: string; name: string | null; email: string | null }[];

  let sent = 0;
  let failed = 0;
  for (const dev of devs) {
    if (!dev.email || exclude.has(dev.email.toLowerCase())) continue;
    if (!(await emailAllowed(dev.id))) continue; // silenciado por esta persona
    const profile = await getDeveloper(dev.id, period, cmp);
    if (!profile) continue;
    // Sin trabajo que resumir esta semana → no se envía (evita correos vacíos).
    if (profile.kpis.commits.value === 0 && profile.kpis.ticketsResolved.value === 0) continue;

    const { html, text } = renderDevDigest({ profile, url: config.dashboard.url, rangeLabel });
    const k = profile.kpis;
    const notice = devDigestNotice({
      seed: `dev-digest:${dev.id}:${period.to.slice(0, 10)}`,
      recipient: dev.name,
      range: rangeLabel,
      stats: { commits: k.commits.value, tickets: k.ticketsResolved.value, lines: k.linesChanged.value, commitsChangePct: k.commits.changePct },
      topProject: profile.projects[0]?.name ?? null,
    });
    const subject = notice.subject;
    try {
      const res = await sendEmail({ to: dev.email, subject, html, text });
      await supabase.from('notification').insert({ channel: 'email', to_dev_id: dev.id, to_address: dev.email, template: 'dev_weekly_digest', body: text, status: 'sent', provider_id: res.id });
      await pushToDev(dev.id, dev.email, toPush(notice, { url: `${config.dashboard.url}/app/developers/${dev.id}`, tag: 'dev-weekly-digest' }), 'dev_weekly_digest');
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
  if (!(await emailEnabled())) return { sent: 0, failed: 0, skipped: 'notificaciones por correo apagadas' };

  const period = lastWeekPeriod();
  const [overview, infra] = await Promise.all([getOverview(period, previousPeriod(period)), listInfra()]);
  const { html, text } = renderDigest({ overview, infra, url: config.dashboard.url, rangeLabel: label(period) });
  const tk = overview.kpis;
  const notice = teamDigestNotice({
    seed: `team-digest:${period.to.slice(0, 10)}`,
    range: label(period),
    stats: { commits: tk.commits.value, tickets: tk.ticketsResolved.value, lines: tk.linesChanged.value, contributors: tk.activeContributors.value },
    topProject: overview.byProject[0]?.name ?? null,
  });
  const subject = notice.subject;

  const supabase = db();
  let sent = 0;
  let failed = 0;
  for (const to of config.digest.recipients) {
    try {
      const res = await sendEmail({ to, subject, html, text });
      await supabase.from('notification').insert({ channel: 'email', to_address: to, template: 'weekly_digest', body: text, status: 'sent', provider_id: res.id });
      await pushToEmail(to, toPush(notice, { url: `${config.dashboard.url}/app`, tag: 'weekly-digest' }), 'weekly_digest');
      sent++;
    } catch (err) {
      await supabase.from('notification').insert({ channel: 'email', to_address: to, template: 'weekly_digest', body: text, status: 'failed', error: String(err) });
      failed++;
    }
  }
  return { sent, failed };
}
