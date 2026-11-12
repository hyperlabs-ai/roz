// Reglas PURAS de los planes del agente (roz v2): quién puede hacer qué, riesgo por reglas, horario
// del runner, cuándo un plan es reclamable y cuándo el watchdog lo regresa a la cola. Sin base ni
// red: las usan el servicio (src/plans/service.ts), la API del runner y el watchdog, y se prueban
// por separado (test/plans-rules.test.ts).
//
// QUÉ estado sigue lo decide SOLO `nextPlanState` (src/types/roz-v2.ts). Aquí se agrega lo que la
// máquina de estados no sabe: la persona que actúa (dueño, quien jaló) y el reloj.
import { businessDaysBetween } from '../assign/policy.js';
import { TEAM_TZ } from '../utils/team-time.js';
import {
  DEFAULT_RUNNER_SCHEDULE,
  PLAN_HEARTBEAT_STALE_MS,
  PLAN_OWNER_OFFLINE_MS,
  PLAN_QUEUE_STALE_BUSINESS_DAYS,
  PLAN_RUNNING,
  RUNNER_HEARTBEAT_INTERVAL_MS,
  nextPlanState,
  type PlanHumanAction,
  type PlanNext,
  type PlanPhase,
  type PlanRisk,
  type PlanStatus,
  type RiskCode,
  type RiskReason,
  type RunnerSchedule,
} from '../types/roz-v2.js';

// ================================================================ acciones de personas

/** Lo mínimo de un plan para decidir si una persona puede actuar sobre él. */
export interface PlanActorView {
  status: PlanStatus;
  phase: PlanPhase;
  risk: PlanRisk;
  ownerDevId: string;
  pulledByDevId: string | null;
}

export const HUMAN_ACTIONS: readonly PlanHumanAction[] = ['aprobar', 'pedir_cambios', 'reclamar', 'jalar', 'soltar', 'cancelar'];

export type ActionCheck =
  | { ok: true; next: PlanNext }
  | { ok: false; code: 'PLAN_CONFLICT' | 'PLAN_FORBIDDEN'; message: string };

/**
 * ¿Puede `actorDevId` hacer `action` sobre el plan ahora? Primero la máquina de estados (si la
 * transición no existe desde ese estado → PLAN_CONFLICT); después quién:
 *  · reclamar: cualquier dev que NO sea el dueño (el dueño ya lo tiene).
 *  · soltar: en cola / esperando aprobación, solo el dueño; jalado, solo quien lo jaló.
 *  · aprobar, pedir cambios, jalar, cancelar: cualquier persona del equipo (queda registrado quién).
 */
export function checkAction(plan: PlanActorView, action: PlanHumanAction, actorDevId: string): ActionCheck {
  const next = nextPlanState(plan, action);
  if (!next) {
    return { ok: false, code: 'PLAN_CONFLICT', message: conflictMessage(plan, action) };
  }
  if (action === 'reclamar' && plan.ownerDevId === actorDevId) {
    return { ok: false, code: 'PLAN_FORBIDDEN', message: 'Este plan ya está en tu cola.' };
  }
  if (action === 'soltar') {
    if (plan.status === 'jalado') {
      if (plan.pulledByDevId !== actorDevId) {
        return { ok: false, code: 'PLAN_FORBIDDEN', message: 'Solo quien jaló el plan puede soltarlo.' };
      }
    } else if (plan.ownerDevId !== actorDevId) {
      return { ok: false, code: 'PLAN_FORBIDDEN', message: 'Solo el dueño de la cola puede soltar este plan.' };
    }
  }
  return { ok: true, next };
}

function conflictMessage(plan: PlanActorView, action: PlanHumanAction): string {
  if (action === 'aprobar' && plan.status === 'esperando_aprobacion' && plan.risk === 2) {
    return 'Un plan de riesgo 2 no lo implementa el agente: jálalo para implementarlo tú.';
  }
  return `No se puede "${ACTION_LABEL[action].toLowerCase()}" un plan en estado "${plan.status}".`;
}

export const ACTION_LABEL: Record<PlanHumanAction, string> = {
  aprobar: 'Aprobar',
  pedir_cambios: 'Pedir cambios',
  reclamar: 'Reclamar',
  jalar: 'Jalar',
  soltar: 'Soltar',
  cancelar: 'Cancelar',
};

/** Las acciones que esta persona puede hacer ahora (el front pinta solo esos botones). */
export function availableActions(plan: PlanActorView, actorDevId: string): PlanHumanAction[] {
  return HUMAN_ACTIONS.filter((a) => checkAction(plan, a, actorDevId).ok);
}

// ================================================================ riesgo por reglas

export interface RiskInput {
  title: string;
  description: string | null;
  labels: readonly string[];
  /** project.client_sla */
  clientSla: boolean;
  /** project.agent_risk_paths */
  riskPaths: readonly string[];
  /**
   * El texto del issue lo escribió alguien de fuera (intake de un cliente) o salió de una junta.
   * Ese texto llega tal cual al prompt del agente, así que nunca corre sin que una persona apruebe
   * el plan: una instrucción inyectada en la descripción no puede terminar ejecutando código.
   */
  externalOrigin?: boolean;
}

/** Rastros que createIssueFromTicket deja al pie de la descripción (src/linear/issues.ts). */
const EXTERNAL_TRAILS = ['creado por roz desde una solicitud externa', 'desde la junta', 'desde una junta'];

/** ¿La descripción trae el rastro de intake o de junta que pone roz al crear el issue? */
export function hasExternalTrail(description: string | null): boolean {
  if (!description) return false;
  const text = normalizeText(description);
  return EXTERNAL_TRAILS.some((t) => text.includes(t));
}

/** minúsculas, sin acentos: "Migración" y "migracion" son lo mismo para una regla. */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

interface TextRule {
  code: RiskCode;
  risk: PlanRisk;
  patterns: RegExp[];
}

// Sobre texto normalizado (sin acentos). Los \b evitan falsos positivos obvios ("author" no es auth,
// "repago" no es pago); preferimos de más a de menos: un riesgo alto de más solo pide aprobación.
const TEXT_RULES: readonly TextRule[] = [
  {
    code: 'migracion',
    risk: 2,
    patterns: [/migrations\//, /\bmigracion(es)?\b/, /\bmigrations?\b/, /\bschema\b/, /\balter table\b/],
  },
  {
    code: 'auth_rls',
    risk: 2,
    patterns: [/\b(o?auth|authn|authz|authenticat\w*|authoriz\w*)\b/, /\bautentica\w*/, /\brls\b/, /\bpolic(y|ies)\b/, /\blogin\b/, /\btokens?\b/, /\bpermis\w*/],
  },
  {
    code: 'pagos',
    risk: 2,
    patterns: [/\bpagos?\b/, /\bpayments?\b/, /\bstripe\b/, /\bfactura\w*/, /\bbilling\b/],
  },
  {
    code: 'ruta_sensible',
    risk: 1,
    patterns: [/\.env\b/, /\bsecrets?\b/, /\binfra\//, /\.github\/workflows/, /\bvercel\.json\b/],
  },
];

const RULE_LABEL: Record<RiskCode, string> = {
  migracion: 'migración de base de datos',
  auth_rls: 'auth, permisos o RLS',
  pagos: 'pagos o facturación',
  ruta_sensible: 'ruta sensible',
  cliente_sla: 'cliente con SLA',
  ruta_proyecto: 'ruta marcada en el proyecto',
  origen_externo: 'texto de un cliente o de una junta',
};

/**
 * Riesgo 0/1/2 por reglas, sin IA: el máximo de las que disparan gana. Lee el título, la
 * descripción y las etiquetas del issue (las rutas que mencione van dentro de ese texto), y el
 * proyecto (cliente con SLA, rutas marcadas como riesgosas).
 */
export function computeRisk(input: RiskInput): { risk: PlanRisk; reasons: RiskReason[] } {
  const text = normalizeText([input.title, input.description ?? '', ...input.labels].join('\n'));
  const reasons: RiskReason[] = [];
  let risk: PlanRisk = 0;
  const hit = (code: RiskCode, r: PlanRisk, detail: string) => {
    reasons.push({ code, detail });
    if (r > risk) risk = r;
  };

  for (const rule of TEXT_RULES) {
    for (const re of rule.patterns) {
      const m = text.match(re);
      if (m) {
        hit(rule.code, rule.risk, `${RULE_LABEL[rule.code]}: menciona «${m[0]}»`);
        break; // una razón por regla basta
      }
    }
  }
  if (input.clientSla) hit('cliente_sla', 1, 'cliente con SLA');
  if (input.externalOrigin || hasExternalTrail(input.description)) {
    hit('origen_externo', 1, 'el texto viene de un cliente o de una junta: el plan se aprueba antes de implementar');
  }
  for (const path of input.riskPaths) {
    const p = normalizeText(path.trim());
    if (p && text.includes(p)) hit('ruta_proyecto', 1, `toca ${path.trim()}`);
  }
  return { risk, reasons };
}

// ================================================================ horario del runner

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Horario válido o el de por defecto. La columna es jsonb libre: una fila vieja o a medio llenar no rompe. */
export function normalizeSchedule(raw: unknown): RunnerSchedule {
  const r = (raw ?? {}) as Partial<RunnerSchedule>;
  const tz = typeof r.tz === 'string' && isValidTimeZone(r.tz) ? r.tz : DEFAULT_RUNNER_SCHEDULE.tz;
  const days = Array.isArray(r.days)
    ? [...new Set(r.days.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b)
    : null;
  const start = typeof r.start === 'string' && HHMM.test(r.start) ? r.start : DEFAULT_RUNNER_SCHEDULE.start;
  const end = typeof r.end === 'string' && HHMM.test(r.end) ? r.end : DEFAULT_RUNNER_SCHEDULE.end;
  return { tz, days: days && days.length ? days : [...DEFAULT_RUNNER_SCHEDULE.days], start, end };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Diferencia (ms) entre la hora local en `tz` y UTC en el instante `t`. */
function tzOffsetMs(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** "YYYY-MM-DD" + "HH:MM" en `tz` → instante UTC (ms). Corrige una vez por el cambio de horario. */
export function localToUtc(date: string, hhmm: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = tzOffsetMs(guess, tz);
  const t = guess - off1;
  const off2 = tzOffsetMs(t, tz);
  return off2 === off1 ? t : guess - off2;
}

/** Fecha local YYYY-MM-DD en `tz`. */
export function localDate(t: number, tz: string): string {
  return new Date(t).toLocaleDateString('en-CA', { timeZone: tz });
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 1 = lunes … 7 = domingo. */
function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/**
 * Ventanas de trabajo [inicio, fin) en UTC que tocan el rango [from, to]. Un horario que cruza la
 * medianoche (22:00–06:00) pertenece al día en que EMPIEZA; inicio = fin significa el día completo.
 */
export function scheduleWindows(schedule: RunnerSchedule, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  const first = addDays(localDate(from, schedule.tz), -1);
  const last = localDate(to, schedule.tz);
  // Tope de 31 días: nadie pregunta por más y protege de un rango absurdo.
  for (let day = first, i = 0; day <= last && i < 33; day = addDays(day, 1), i++) {
    if (!schedule.days.includes(isoWeekday(day))) continue;
    const start = localToUtc(day, schedule.start, schedule.tz);
    const endDay = schedule.end > schedule.start ? day : addDays(day, 1);
    const end = localToUtc(endDay, schedule.end, schedule.tz);
    if (end > from && start <= to) out.push([start, end]);
  }
  return out;
}

export function inSchedule(schedule: RunnerSchedule, now: Date = new Date()): boolean {
  const t = now.getTime();
  return scheduleWindows(schedule, t, t).some(([s, e]) => t >= s && t < e);
}

/** ms hasta que empieza el siguiente bloque del horario (0 si ya está dentro). */
export function msUntilScheduleStart(schedule: RunnerSchedule, now: Date = new Date()): number {
  const t = now.getTime();
  if (inSchedule(schedule, now)) return 0;
  const next = scheduleWindows(schedule, t, t + 8 * DAY_MS)
    .map(([s]) => s)
    .filter((s) => s > t)
    .sort((a, b) => a - b)[0];
  return next === undefined ? DAY_MS : next - t;
}

/** Cuánto pide esperar next-job fuera de horario: hasta el inicio, con tope para que un cambio de
 *  horario desde el dashboard se note pronto. */
export const NEXT_JOB_IDLE_MS = 30_000;
export const NEXT_JOB_MAX_WAIT_MS = 15 * 60 * 1000;
export function nextJobRetryAfter(schedule: RunnerSchedule, now: Date = new Date()): number {
  const ms = msUntilScheduleStart(schedule, now);
  if (ms === 0) return NEXT_JOB_IDLE_MS;
  return Math.min(Math.max(ms, NEXT_JOB_IDLE_MS), NEXT_JOB_MAX_WAIT_MS);
}

/** Milisegundos DENTRO de alguno de los horarios entre `from` y `to` (los horarios se unen). */
export function scheduledMsBetween(schedules: readonly RunnerSchedule[], from: number, to: number): number {
  if (to <= from) return 0;
  // scheduleWindows cubre a lo más ~un mes: se cuenta solo el último (basta para cualquier umbral).
  from = Math.max(from, to - 30 * DAY_MS);
  const windows = schedules
    .flatMap((s) => scheduleWindows(s, from, to))
    .map(([s, e]): [number, number] => [Math.max(s, from), Math.min(e, to)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = -1;
  let curE = -1;
  for (const [s, e] of windows) {
    if (s > curE) {
      if (curE > curS) total += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) {
      curE = e;
    }
  }
  if (curE > curS) total += curE - curS;
  return total;
}

// ================================================================ runner en línea / latido

/** Un runner está en línea si habló hace menos de 3 latidos. */
export const RUNNER_ONLINE_MS = 3 * RUNNER_HEARTBEAT_INTERVAL_MS;

export function runnerOnline(lastSeenAt: string | null, now: Date = new Date()): boolean {
  return !!lastSeenAt && now.getTime() - Date.parse(lastSeenAt) < RUNNER_ONLINE_MS;
}

/** Watchdog: un plan corriendo sin latido en 10 min regresa a la cola (con lo que ya escribió). */
export function isHeartbeatStale(status: PlanStatus, heartbeatAt: string | null, now: Date = new Date()): boolean {
  if (!PLAN_RUNNING.includes(status)) return false;
  if (!heartbeatAt) return true;
  return now.getTime() - Date.parse(heartbeatAt) > PLAN_HEARTBEAT_STALE_MS;
}

/** El evento `progress` se registra como mucho una vez por minuto por plan (el latido no). */
export const PROGRESS_EVENT_MIN_MS = 60 * 1000;
export function shouldLogProgress(lastEventAt: string | null, now: Date = new Date()): boolean {
  return !lastEventAt || now.getTime() - Date.parse(lastEventAt) >= PROGRESS_EVENT_MIN_MS;
}

// ================================================================ reclamable

export type AutoClaimableReason = 'dueño_fuera_de_linea' | 'mucho_en_cola';

export interface OwnerRunnerView {
  lastSeenAt: string | null;
  schedule: RunnerSchedule;
  revoked: boolean;
}

export interface ClaimableInput {
  status: PlanStatus;
  claimable: boolean;
  /** Desde cuándo está en este estado (agent_plan.updated_at: en cola no cambia hasta la siguiente transición). */
  since: string;
  ownerRunners: readonly OwnerRunnerView[];
  now: Date;
}

/** Días hábiles completos (lun–vie, zona del equipo) entre el día de `sinceIso` y hoy, sin contar el primero. */
export function businessDaysElapsed(sinceIso: string, now: Date): number {
  const from = addDays(localDate(Date.parse(sinceIso), TEAM_TZ), 1);
  const to = localDate(now.getTime(), TEAM_TZ);
  return businessDaysBetween(from, to);
}

/**
 * ¿El watchdog debe marcar el plan como reclamable? Solo en cola o esperando aprobación, y si nadie
 * lo marcó antes.
 *  · dueño_fuera_de_linea (solo en cola: es lo que necesita un runner): ningún runner del dueño habló
 *    en más de 2 h DE SU HORARIO. Se cuenta tiempo dentro del horario (de la unión de sus runners
 *    activos; sin runners, el horario por defecto), desde lo último entre su último latido y la
 *    llegada del plan a la cola: un plan que entró a las 18:50 no amanece reclamable a las 9:00.
 *  · mucho_en_cola: más de 1 día hábil en ese estado.
 */
export function claimableReason(i: ClaimableInput): AutoClaimableReason | null {
  if (i.claimable) return null;
  if (i.status !== 'en_cola' && i.status !== 'esperando_aprobacion') return null;
  const now = i.now.getTime();

  if (i.status === 'en_cola') {
    const active = i.ownerRunners.filter((r) => !r.revoked);
    const lastSeen = Math.max(0, ...active.map((r) => (r.lastSeenAt ? Date.parse(r.lastSeenAt) : 0)));
    const offlineSince = Math.max(lastSeen, Date.parse(i.since));
    const schedules = active.length ? active.map((r) => r.schedule) : [DEFAULT_RUNNER_SCHEDULE];
    const nowInSchedule = schedules.some((s) => inSchedule(s, i.now));
    if (nowInSchedule && scheduledMsBetween(schedules, offlineSince, now) > PLAN_OWNER_OFFLINE_MS) {
      return 'dueño_fuera_de_linea';
    }
  }
  if (businessDaysElapsed(i.since, i.now) > PLAN_QUEUE_STALE_BUSINESS_DAYS) return 'mucho_en_cola';
  return null;
}

// ================================================================ rama y plantilla

/** Slug ASCII para la rama: "Arreglar el login de Ana" → "arreglar-el-login-de-ana". */
export function slugify(s: string, max = 40): string {
  const slug = normalizeText(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/g, '');
}

/** Rama sugerida: la de Linear si existe; si no `<identifier en minúsculas>-<slug del título>`. */
export function suggestedBranch(identifier: string, title: string, linearBranchName: string | null | undefined): string {
  if (linearBranchName && linearBranchName.trim()) return linearBranchName.trim();
  const id = identifier.toLowerCase();
  const slug = slugify(title);
  return slug ? `${id}-${slug}` : id;
}

/** PLAN.md cuando todavía no hay plan (jalar antes de que el agente planee). */
export function planTemplate(input: { identifier: string; title: string; description: string | null; url: string | null }): string {
  const lines = [
    `# ${input.identifier} — ${input.title}`,
    '',
    input.url ? `Issue: ${input.url}` : null,
    '',
    '## Contexto',
    '',
    input.description?.trim() || '_Sin descripción en el issue._',
    '',
    '## Objetivo',
    '',
    '- ',
    '',
    '## Pasos',
    '',
    '1. ',
    '',
    '## Archivos que se tocan',
    '',
    '- ',
    '',
    '## Riesgos',
    '',
    '- ',
    '',
    '## Cómo se prueba',
    '',
    '- ',
    '',
  ];
  return lines.filter((l) => l !== null).join('\n');
}
