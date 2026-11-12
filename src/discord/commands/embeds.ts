// Fichas de roz para Discord, en Components V2 (contrato: docs/discord-commands-contract.md §7.1).
// Cada mensaje es UN Container con el naranja de roz: encabezado "### Título" + una línea tenue con el
// resumen en números, lo importante primero y lo normal colapsado (nunca una línea por elemento cuando
// todo está bien). Estados con el mapa único de v2.ts (🟢 🟡 🟣 🔴 ⚪). Personas como Section con la
// foto de GitHub de miniatura. Separadores entre grupos, no entre elementos. Botones solo donde
// aportan; los enlaces "Abrir" solo con URL pública (links.ts).
//
// Puras: reciben datos ya cargados (y los emojis de la app, si hay) y devuelven el OutgoingMessage.
// Los handlers cargan; esto solo pinta. El nombre del archivo se queda por historia (antes eran embeds).
import type { ChatTaskRef } from '../../chat/model.js';
import type { ServiceDeploy, ServiceStatus } from '../../infra/types.js';
import { CLOSED_STATES, STATE_LABEL, STATE_OPTIONS, type TaskState } from '../../tasks/states.js';
import { PLAN_RUNNING, PLAN_STATUS_LABEL, type AgentPlanSummary, type PersonState, type PlanStatus, type PulsePerson } from '../../types/roz-v2.js';
import { TEAM_TZ } from '../../utils/team-time.js';
import { buildCustomId } from './custom-id.js';
import { icon, providerIcon, withIcon, type AppEmojis } from './emojis.js';
import { appLink } from './links.js';
import { button, linkButton, row, stringSelect } from './respond.js';
import type { ActionRowComponent, ButtonComponent, ContainerChild, OutgoingMessage, SectionComponent, TextDisplayComponent } from './types.js';
import {
  ROZ_ORANGE,
  dot,
  header,
  inline,
  joinFit,
  maybeThumbnail,
  relativeTime,
  separator,
  sectionOrText,
  text,
  v2Message,
  type Tone,
} from './v2.js';

export { ROZ_ORANGE };

/** Cuántas personas/servicios/tareas con detalle caben antes de colapsar (40 componentes por mensaje). */
export const MAX_PEOPLE_SECTIONS = 10;
export const MAX_SERVICE_SECTIONS = 6;
/** Largo de un título de tarea/issue dentro de una línea. */
export const TITLE_IN_LINE = 60;

/** Foto de GitHub de un dev (pública; la misma que usa el dashboard). */
export function githubAvatar(login: string | null | undefined, size = 96): string | null {
  return login ? `https://github.com/${encodeURIComponent(login)}.png?size=${size}` : null;
}

const PRIORITY_LABEL: Record<string, string> = { urgent: 'Urgente', high: 'Alta', medium: 'Media', low: 'Baja' };

export function priorityLabel(priority: string | null | undefined): string {
  return priority ? (PRIORITY_LABEL[priority] ?? priority) : 'Sin prioridad';
}

function idCode(identifier: string): string {
  return `\`${identifier.replace(/`/g, '')}\``;
}

function openRow(...buttons: Array<ButtonComponent | null>): ActionRowComponent | null {
  const list = buttons.filter((b): b is ButtonComponent => !!b);
  return list.length ? row(...list) : null;
}

function linkTo(label: string, url: string | null | undefined): ButtonComponent | null {
  return url ? linkButton(label, url) : null;
}

// ================================================================ tareas

export interface TaskCardInput {
  id: string;
  identifier: string;
  name: string;
  status: string;
  statusLabel?: string | null;
  priority: string | null;
  projectName: string | null;
  dueDate?: string | null;
  overdue?: boolean;
  /** Responsable principal (con foto). null = sin responsable. */
  assignee: { name: string; avatarUrl: string | null } | null;
  /** Issue en Linear (con ROZ_LINEAR_SOT). */
  linearUrl?: string | null;
}

/** ChatTaskRef (src/chat/tasks.ts) → ficha, con el nombre/foto del responsable principal. */
export function taskCardFromRef(
  ref: ChatTaskRef,
  devs: Map<string, { name: string; githubLogin: string | null }>,
  linearUrl: string | null = null,
): TaskCardInput {
  const primary = ref.assigneeDevIds[0] ? devs.get(ref.assigneeDevIds[0]) : undefined;
  return {
    id: ref.id,
    identifier: ref.identifier,
    name: ref.name,
    status: ref.status,
    statusLabel: ref.statusLabel,
    priority: ref.priority,
    projectName: ref.projectName,
    dueDate: ref.dueDate,
    overdue: ref.overdue,
    assignee: primary ? { name: primary.name, avatarUrl: githubAvatar(primary.githubLogin) } : null,
    linearUrl,
  };
}

export function stateLabel(status: string, label?: string | null): string {
  return label ?? STATE_LABEL[status as TaskState] ?? status;
}

/** Emoji del estado de una tarea: en curso/hecha 🟢, en revisión 🟡, por hacer/cancelada ⚪. */
export function taskTone(status: string): Tone {
  if (status === 'en_progreso' || status === 'completada') return 'ok';
  if (status === 'revision') return 'wait';
  return 'off';
}

export function taskLink(taskId: string): string | null {
  return appLink(`/app/tasks?task=${encodeURIComponent(taskId)}`);
}

/** "`WAT-44` · 🟢 En curso · Prioridad alta · Manuel" (+ vencimiento si está abierta). */
export function taskChips(card: TaskCardInput): string {
  const closed = CLOSED_STATES.includes(card.status);
  const due = card.dueDate && !closed ? `${card.overdue ? `${dot('bad')} Vencida` : 'Vence'} ${card.dueDate.slice(0, 10)}` : null;
  return [
    idCode(card.identifier),
    `${dot(taskTone(card.status))} ${stateLabel(card.status, card.statusLabel)}`,
    card.priority ? `Prioridad ${priorityLabel(card.priority).toLowerCase()}` : null,
    card.assignee?.name ?? 'Sin responsable',
    due,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Texto de la ficha: título en negritas, chips y el proyecto tenue. */
export function taskCardText(card: TaskCardInput): string {
  return [`**${inline(card.name, 200)}**`, taskChips(card), card.projectName ? `-# ${inline(card.projectName, 80)}` : null].filter(Boolean).join('\n');
}

/** La ficha como Section (miniatura = foto del responsable) o texto si no tiene foto. */
export function taskCardSection(card: TaskCardInput): SectionComponent | TextDisplayComponent {
  return sectionOrText(taskCardText(card), maybeThumbnail(card.assignee?.avatarUrl, card.assignee?.name));
}

/** Botones de la ficha: Tomar, Abrir (roz), Linear; y el menú "Cambiar estado". */
export function taskCardComponents(card: TaskCardInput): ActionRowComponent[] {
  const closed = CLOSED_STATES.includes(card.status);
  const buttons: ButtonComponent[] = [
    button({ label: 'Tomar', customId: buildCustomId('tarea.tomar', card.id), style: 'primary', disabled: closed }),
  ];
  const openBtn = linkTo('Abrir', taskLink(card.id));
  if (openBtn) buttons.push(openBtn);
  const linearBtn = linkTo('Linear', card.linearUrl);
  if (linearBtn) buttons.push(linearBtn);
  return [
    row(...buttons),
    row(
      stringSelect({
        customId: buildCustomId('tarea.estado', card.id),
        placeholder: 'Cambiar estado',
        options: STATE_OPTIONS.map((o) => ({ label: o.label, value: o.value, default: o.value === card.status })),
      }),
    ),
  ];
}

/** Ficha completa lista para publicar. `lead` = una línea arriba (p. ej. "Ticket creado · asignado a …"). */
export function taskCardMessage(card: TaskCardInput, lead?: string): OutgoingMessage {
  return v2Message([lead ? text(lead) : null, taskCardSection(card), ...taskCardComponents(card)]);
}

/** Varias fichas en UN mensaje sin botones (citar más de 3 tareas): una entrada compacta por tarea. */
export function taskListMessage(cards: TaskCardInput[], title: string, summary?: string | null): OutgoingMessage {
  const lines = cards.map((c) => `**${inline(c.name, TITLE_IN_LINE)}**\n${taskChips(c)}`);
  return v2Message([header(title, summary), separator(), text(lines.join('\n\n') || 'Sin tareas.')]);
}

// ================================================================ status (daily)

export interface StatusInput {
  person: { name: string; avatarUrl: string | null };
  cards: TaskCardInput[];
  /** Nota libre opcional (lo que el dev escribió). */
  note?: string | null;
  /** YYYY-MM-DD del daily. */
  day?: string | null;
}

/** "miércoles 12 nov" a partir de YYYY-MM-DD (zona del equipo). */
export function dayLabel(day: string | null | undefined): string | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  // Mediodía UTC: el mismo día en cualquier zona de América.
  const d = new Date(`${day}T12:00:00Z`);
  const weekday = d.toLocaleDateString('es-MX', { weekday: 'long', timeZone: TEAM_TZ });
  const month = d.toLocaleDateString('es-MX', { month: 'short', timeZone: TEAM_TZ }).replace('.', '');
  const date = d.toLocaleDateString('es-MX', { day: 'numeric', timeZone: TEAM_TZ });
  return `${weekday} ${date} ${month}`;
}

/** Grupos del daily en orden, con su emoji. */
const STATUS_GROUPS: { label: string; tone: Tone; states: string[] }[] = [
  { label: 'En curso', tone: 'ok', states: ['en_progreso'] },
  { label: 'Por hacer', tone: 'off', states: ['pendiente', 'planificada'] },
  { label: 'En revisión', tone: 'wait', states: ['revision'] },
  { label: 'Hecho', tone: 'ok', states: ['completada'] },
  { label: 'Cancelada', tone: 'off', states: ['cancelada'] },
];

function taskLine(c: TaskCardInput): string {
  const link = taskLink(c.id);
  const name = inline(c.name, TITLE_IN_LINE);
  return `${idCode(c.identifier)} ${link ? `[${name}](${link})` : name}`;
}

/** Daily: encabezado con la foto, la nota y las tareas agrupadas por estado (una línea por tarea). */
export function statusMessage(input: StatusInput): OutgoingMessage {
  const n = input.cards.length;
  const summary = [dayLabel(input.day), `${n} tarea${n === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  const head = sectionOrText(`### Daily de ${inline(input.person.name, 80)}\n-# ${summary}`, maybeThumbnail(input.person.avatarUrl, input.person.name));
  const groups: ContainerChild[] = [];
  const known = new Set(STATUS_GROUPS.flatMap((g) => g.states));
  const buckets = [
    ...STATUS_GROUPS.map((g) => ({ ...g, cards: input.cards.filter((c) => g.states.includes(c.status)) })),
    { label: 'Otras', tone: 'off' as Tone, states: [], cards: input.cards.filter((c) => !known.has(c.status)) },
  ];
  for (const g of buckets) {
    if (!g.cards.length) continue;
    if (groups.length) groups.push(separator({ divider: false }));
    groups.push(text(`**${dot(g.tone)} ${g.label}**\n${g.cards.map(taskLine).join('\n')}`));
  }
  return v2Message([
    head,
    input.note?.trim() ? text(input.note.trim()) : null,
    separator(),
    ...(groups.length ? groups : [text('-# Sin tareas elegidas.')]),
  ]);
}

// ================================================================ plan del agente

const RISK_LABEL: Record<number, string> = {
  0: 'Riesgo bajo: planea e implementa hasta PR',
  1: 'Riesgo medio: planea y espera aprobación',
  2: 'Riesgo alto: solo plan, lo implementa una persona',
};

/** Emoji del estado de un plan: el agente trabajando 🟣, esperando 🟡, hecho 🟢, error 🔴, fuera ⚪. */
export function planTone(status: PlanStatus, failed = false): Tone {
  if (failed) return 'bad';
  if ((PLAN_RUNNING as readonly string[]).includes(status)) return 'agent';
  if (status === 'en_cola' || status === 'esperando_aprobacion' || status === 'pr_abierto') return 'wait';
  if (status === 'hecho') return 'ok';
  return 'off';
}

/** Pasos del PLAN.md: los primeros renglones de lista (numerados o con viñeta). */
export function planSteps(planMd: string | null | undefined, max = 8): string[] {
  if (!planMd) return [];
  const out: string[] = [];
  for (const line of planMd.split(/\r?\n/)) {
    const m = /^\s*(?:\d+[.)]|[-*])\s+(.+)$/.exec(line);
    if (m) out.push(m[1]!.trim());
    if (out.length === max) break;
  }
  return out;
}

export function planLink(planId: string): string | null {
  return appLink(`/app/plans?plan=${encodeURIComponent(planId)}`);
}

function planProgress(p: Pick<AgentPlanSummary, 'progress'>): string | null {
  if (!p.progress) return null;
  return [p.progress.step, p.progress.message, p.progress.pct !== null && p.progress.pct !== undefined ? `${p.progress.pct}%` : null]
    .filter(Boolean)
    .map((s) => inline(String(s), 80))
    .join(' · ');
}

/** Aprobar / Pedir cambios solo si quien mira puede (plan.actions ya viene calculado para esa persona). */
export function planComponents(plan: AgentPlanSummary): ActionRowComponent[] {
  const buttons: ButtonComponent[] = [];
  if (plan.actions.includes('aprobar')) buttons.push(button({ label: 'Aprobar', customId: buildCustomId('plan.aprobar', plan.id), style: 'success' }));
  if (plan.actions.includes('pedir_cambios')) {
    buttons.push(button({ label: 'Pedir cambios', customId: buildCustomId('plan.cambios', plan.id), style: 'secondary' }));
  }
  const openBtn = linkTo('Abrir', planLink(plan.id));
  if (openBtn) buttons.push(openBtn);
  const prBtn = linkTo('PR', plan.prUrl);
  if (prBtn) buttons.push(prBtn);
  return buttons.length ? [row(...buttons)] : [];
}

/** Ficha del plan: el issue, estado y riesgo con emoji, pasos numerados, PR y botones. */
export function planMessage(plan: AgentPlanSummary & { planMd?: string | null }, emojis?: AppEmojis | null): OutgoingMessage {
  const failed = !!plan.error;
  const tone = planTone(plan.status, failed);
  const steps = planSteps(plan.planMd);
  const progress = planProgress(plan);
  const status = `${dot(tone)} ${PLAN_STATUS_LABEL[plan.status] ?? plan.status}${progress ? ` · ${progress}` : ''}`;
  const headText = [
    `### ${withIcon(icon('roz_bot', emojis), `${idCode(plan.identifier)} ${inline(plan.issue.name, 120)}`)}`,
    status,
    `-# ${[RISK_LABEL[plan.risk] ?? `Riesgo ${plan.risk}`, plan.owner.name, plan.issue.projectName].filter(Boolean).join(' · ')}`,
  ].join('\n');
  const reasons = plan.riskReasons.length ? `-# Por qué ese riesgo: ${inline(plan.riskReasons.map((r) => r.detail).join('; '), 300)}` : null;
  const pr = plan.prUrl ? withIcon(icon('roz_github', emojis), `[PR #${plan.prNumber ?? ''}](${plan.prUrl})${plan.branch ? ` · \`${inline(plan.branch, 60)}\`` : ''}`) : null;
  return v2Message([
    sectionOrText(headText, maybeThumbnail(githubAvatar(plan.owner.githubLogin) ?? plan.owner.avatarUrl, plan.owner.name)),
    separator(),
    steps.length ? text(steps.map((s, i) => `${i + 1}. ${inline(s, 160)}`).join('\n')) : text('-# El plan todavía no tiene pasos.'),
    reasons ? text(reasons) : null,
    pr ? text(pr) : null,
    failed ? text(`${dot('bad')} **Error** · ${inline(plan.error, 300)}`) : null,
    ...planComponents(plan),
  ]);
}

// ================================================================ persona y pulso

const PERSON_STATE: Record<PersonState, { tone: Tone; label: string }> = {
  activo: { tone: 'ok', label: 'En código' },
  ocupado: { tone: 'wait', label: 'En junta' },
  inactivo: { tone: 'off', label: 'Inactivo' },
  fuera: { tone: 'off', label: 'Fuera' },
};

function agentRunning(p: PulsePerson): boolean {
  return !!p.agentPlan && (PLAN_RUNNING as readonly string[]).includes(p.agentPlan.status);
}

/** "🟢 En código" / "🟡 Ocupado hasta las 11:30" / "⚪ Fuera". */
export function personStatus(p: PulsePerson): string {
  const s = PERSON_STATE[p.state] ?? { tone: 'off' as Tone, label: p.state };
  const label = p.state === 'ocupado' && p.stateDetail ? inline(p.stateDetail, 60) : s.label;
  return `${dot(s.tone)} ${label}`;
}

function agentLine(p: PulsePerson): string | null {
  if (!p.agentPlan) return null;
  const pct = p.agentPlan.progress?.pct;
  return `${dot(planTone(p.agentPlan.status))} Agente · ${idCode(p.agentPlan.identifier)} ${PLAN_STATUS_LABEL[p.agentPlan.status] ?? p.agentPlan.status}${
    pct !== null && pct !== undefined ? ` ${pct}%` : ''
  }`;
}

function issueLine(p: PulsePerson): string | null {
  if (!p.currentIssue) return null;
  const name = inline(p.currentIssue.name, TITLE_IN_LINE);
  return `${idCode(p.currentIssue.identifier)} ${p.currentIssue.url ? `[${name}](${p.currentIssue.url})` : name}`;
}

/** Orden del pulso: el agente o en código primero, luego en junta, luego el resto. */
function pulseRank(p: PulsePerson): number {
  if (agentRunning(p) || p.state === 'activo') return 0;
  if (p.state === 'ocupado') return 1;
  return 2;
}

function avatarOf(p: PulsePerson): string | null {
  return githubAvatar(p.githubLogin) ?? p.avatarUrl;
}

export interface PulseOptions {
  /** Cuándo se calculó (para "actualizado hace X"). */
  updatedAt?: string | null;
}

/**
 * Pulso del equipo: una Section por persona CON issue en curso o agente (las demás en una sola línea
 * tenue al final). Encabezado con el conteo por estado.
 */
export function pulseMessage(people: PulsePerson[], opts: PulseOptions = {}): OutgoingMessage {
  const count = (pred: (p: PulsePerson) => boolean) => people.filter(pred).length;
  const working = count((p) => p.state === 'activo');
  const meeting = count((p) => p.state === 'ocupado');
  const away = count((p) => p.state === 'inactivo' || p.state === 'fuera');
  const agents = count(agentRunning);
  const updated = relativeTime(opts.updatedAt);
  const summary = [
    working ? `${working} trabajando` : null,
    meeting ? `${meeting} en junta` : null,
    away ? `${away} fuera` : null,
    agents ? `${agents} agente${agents === 1 ? '' : 's'}` : null,
    updated ? `actualizado ${updated}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const busy = people
    .filter((p) => p.currentIssue || p.agentPlan)
    .sort((a, b) => pulseRank(a) - pulseRank(b) || a.name.localeCompare(b.name, 'es'));
  const idle = people.filter((p) => !p.currentIssue && !p.agentPlan).sort((a, b) => pulseRank(a) - pulseRank(b) || a.name.localeCompare(b.name, 'es'));
  const shown = busy.slice(0, MAX_PEOPLE_SECTIONS);
  const hidden = busy.slice(MAX_PEOPLE_SECTIONS);

  const sections = shown.map((p) => {
    const lines = [`**${inline(p.name, 60)}** · ${personStatus(p)}`, issueLine(p) ?? '-# Sin issue en curso', agentLine(p) ? `-# ${agentLine(p)}` : null];
    return sectionOrText(lines.filter(Boolean).join('\n'), maybeThumbnail(avatarOf(p), p.name));
  });
  const tail: string[] = [];
  if (hidden.length) tail.push(`-# También con issue: ${joinFit(hidden.map((p) => p.name), 300)}`);
  if (idle.length) tail.push(`-# Sin issue en curso: ${joinFit(idle.map((p) => p.name), 400)}`);
  return v2Message([
    header('Pulso del equipo', summary || `${people.length} personas`),
    sections.length ? separator() : null,
    ...sections,
    tail.length ? separator() : null,
    tail.length ? text(tail.join('\n')) : null,
    !people.length ? text('-# Nadie con actividad.') : null,
    openRow(linkTo('Abrir pulso', appLink('/app/pulse'))),
  ]);
}

/** Detalle de una persona: estado, issue actual, plan del agente, presencia y su semana. */
export function personMessage(p: PulsePerson, emojis?: AppEmojis | null, opts: PulseOptions = {}): OutgoingMessage {
  const updated = relativeTime(opts.updatedAt);
  const projects = p.projects.length ? joinFit(p.projects.map((x) => x.name), 200) : null;
  const headText = [`### ${inline(p.name, 80)}`, personStatus(p), `-# ${[projects, updated ? `actualizado ${updated}` : null].filter(Boolean).join(' · ') || 'Pulso de roz'}`].join(
    '\n',
  );
  const issue = issueLine(p);
  const issueState = p.currentIssue ? (p.currentIssue.linearStateName ?? STATE_LABEL[p.currentIssue.status] ?? p.currentIssue.status) : null;
  const agent = agentLine(p);
  const progress = p.agentPlan?.progress ? planProgress({ progress: p.agentPlan.progress }) : null;
  const week = p.week;
  const weekLine = withIcon(
    icon('roz_github', emojis),
    `${week.commits} commit${week.commits === 1 ? '' : 's'} · ${week.prsOpened} PR${week.prsOpened === 1 ? '' : 's'} abiertos · ${week.prsMerged} mergeado${
      week.prsMerged === 1 ? '' : 's'
    } · ${week.issuesClosed} issue${week.issuesClosed === 1 ? '' : 's'} cerrado${week.issuesClosed === 1 ? '' : 's'}`,
  );
  const presence = p.stateDetail ? `**Calendario** · ${inline(p.stateDetail, 120)}` : null;
  return v2Message([
    sectionOrText(headText, maybeThumbnail(avatarOf(p), p.name)),
    separator(),
    text(`**Trabajando en**\n${issue ? `${dot(taskTone(p.currentIssue!.status))} ${issue} · ${issueState}` : `${dot('off')} Sin issue en curso`}`),
    agent ? text(`**Plan del agente**\n${agent}${progress ? `\n-# ${progress}` : ''}`) : null,
    presence ? text(presence) : null,
    separator({ divider: false }),
    text(`**Esta semana**\n${weekLine}`),
    openRow(linkTo('Abrir', appLink(`/app/developers/${encodeURIComponent(p.devId)}`))),
  ]);
}

// ================================================================ servicios (infra)

export const SERVICE_STATUS_LABEL: Record<ServiceStatus, string> = {
  healthy: 'En línea',
  degraded: 'Degradado',
  down: 'Caído',
  paused: 'Pausado',
  unknown: 'Sin datos',
};

const SERVICE_TONE: Record<ServiceStatus, Tone> = { healthy: 'ok', degraded: 'bad', down: 'bad', paused: 'off', unknown: 'off' };

const PROVIDER_LABEL: Record<string, string> = { vercel: 'Vercel', railway: 'Railway', supabase: 'Supabase', github: 'GitHub', linear: 'Linear' };
const PROVIDER_ORDER = ['vercel', 'railway', 'supabase'];

export function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider.toLowerCase()] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

export interface ServiceCardInput {
  name: string;
  provider: string;
  projectName?: string | null;
  status: ServiceStatus;
  url?: string | null;
  /** Último error del proveedor (sin secretos). */
  lastError?: string | null;
  deploy?: ServiceDeploy | null;
  /** Deploy sospechoso (el último antes de la caída), si se pudo determinar. */
  suspectDeploy?: ServiceDeploy | null;
  checkedAt?: string | null;
}

export function isServiceProblem(s: Pick<ServiceCardInput, 'status'>): boolean {
  return s.status === 'down' || s.status === 'degraded';
}

function deployLine(d: ServiceDeploy): string {
  const sha = d.sha ? `\`${d.sha.slice(0, 7)}\`` : null;
  const when = relativeTime(d.createdAt);
  return [sha, d.commitMessage ? inline(d.commitMessage.split('\n')[0]!, 70) : null, d.author ? inline(d.author, 40) : null, d.state, when].filter(Boolean).join(' · ');
}

/** Section de un servicio con problema: nombre, proveedor, último error, deploy sospechoso, "Abrir". */
export function serviceProblemSection(s: ServiceCardInput, emojis?: AppEmojis | null, withProject = true): SectionComponent | TextDisplayComponent {
  const provider = withIcon(providerIcon(s.provider, emojis), providerLabel(s.provider));
  const lines = [
    `${dot(SERVICE_TONE[s.status])} **${inline(s.name, 80)}** · ${SERVICE_STATUS_LABEL[s.status]}`,
    `-# ${[provider, withProject ? s.projectName : null].filter(Boolean).join(' · ')}`,
    s.lastError ? `-# Último error: ${inline(s.lastError, 200)}` : null,
    s.suspectDeploy ? `-# Deploy sospechoso: ${deployLine(s.suspectDeploy)}` : s.deploy ? `-# Último deploy: ${deployLine(s.deploy)}` : null,
  ];
  return sectionOrText(lines.filter(Boolean).join('\n'), linkTo('Abrir', s.url ?? appLink('/app/infra')));
}

function countLabel(n: number, status: ServiceStatus): string {
  const plural = n === 1 ? '' : 's';
  switch (status) {
    case 'healthy':
      return `${n} en línea`;
    case 'degraded':
      return `${n} degradado${plural}`;
    case 'down':
      return `${n} caído${plural}`;
    case 'paused':
      return `${n} pausado${plural}`;
    default:
      return `${n} sin datos`;
  }
}

const STATUS_ORDER: ServiceStatus[] = ['healthy', 'down', 'degraded', 'paused', 'unknown'];

/**
 * Infraestructura: encabezado con los números; primero una Section por servicio con problema; luego
 * UNA línea por proveedor ("Vercel · 🟢 11/11 en línea") con los nombres tenues debajo. Si todo está
 * bien, "🟢 Todo en línea" grande y los proveedores igual de colapsados.
 */
export function infraMessage(services: ServiceCardInput[], opts: { projectName?: string | null; emojis?: AppEmojis | null } = {}): OutgoingMessage {
  const by = (st: ServiceStatus) => services.filter((s) => s.status === st).length;
  const latest = services.map((s) => s.checkedAt ?? '').sort().pop() || null;
  const updated = relativeTime(latest);
  const summary = [
    `${services.length} servicio${services.length === 1 ? '' : 's'}`,
    ...STATUS_ORDER.filter((st) => by(st) > 0).map((st) => countLabel(by(st), st)),
    updated ? `actualizado ${updated}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const title = opts.projectName ? `Infraestructura · ${inline(opts.projectName, 60)}` : 'Infraestructura';

  const problems = services
    .filter(isServiceProblem)
    .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'down' ? -1 : 1));
  const shown = problems.slice(0, MAX_SERVICE_SECTIONS);
  const more = problems.length - shown.length;

  const providers = [...new Set(services.map((s) => s.provider.toLowerCase()))].sort((a, b) => {
    const ia = PROVIDER_ORDER.indexOf(a);
    const ib = PROVIDER_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const nameBudget = Math.max(120, Math.floor(1800 / Math.max(1, providers.length)));
  const providerLines = providers.map((prov) => {
    const list = services.filter((s) => s.provider.toLowerCase() === prov);
    const ok = list.filter((s) => s.status === 'healthy').length;
    const bad = list.filter(isServiceProblem).length;
    const tone: Tone = bad ? 'bad' : ok === list.length ? 'ok' : 'off';
    const extra = STATUS_ORDER.filter((st) => st !== 'healthy')
      .map((st) => [st, list.filter((s) => s.status === st).length] as const)
      .filter(([, n]) => n > 0)
      .map(([st, n]) => countLabel(n, st));
    const head = `${withIcon(providerIcon(prov, opts.emojis), `**${providerLabel(prov)}**`)} · ${dot(tone)} ${ok}/${list.length} en línea${extra.length ? ` · ${extra.join(' · ')}` : ''}`;
    const names = joinFit(
      list.map((s) => s.name).sort((a, b) => a.localeCompare(b)),
      nameBudget,
    );
    return `${head}\n-# ${names}`;
  });

  return v2Message([
    header(title, summary),
    separator(),
    ...(problems.length
      ? [...shown.map((s) => serviceProblemSection(s, opts.emojis, !opts.projectName)), more ? text(`-# +${more} con problemas más en roz`) : null, separator()]
      : [text(`## ${dot('ok')} Todo en línea`)]),
    text(providerLines.join('\n')),
    openRow(linkTo('Abrir infraestructura', appLink('/app/infra'))),
  ]);
}
