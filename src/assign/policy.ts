// Política de asignación automática. PURA: sin base, sin red, sin config — entra todo lo que hace
// falta y sale la decisión completa con el porqué de cada candidato. Así se prueba regla por regla
// (test/assign-policy.test.ts) y cualquier decisión del log se puede reproducir.
//
// El flujo (en este orden):
//   1. Filtrar duro — excluye, no penaliza: inactivo, rol, disponibilidad, skill mínima, WIP.
//   2. Ordenar — encargado → subencargado → especialista → pool. Si la skill exige ≥ 4, el
//      especialista va primero. La skill secundaria del tipo de solución no filtra: entre
//      especialistas y en el pool, ordena a quienes empatan en la primaria.
//   3. Desempatar — dentro de cada grupo, entre candidatos a ≤ 1 nivel, gana el de nivel menor si la
//      tarea es chica (≤ 3 pts), no urgente y hay un revisor senior. Evita el punto único de falla.
//   4. Tamaño efectivo — salir del proyecto cuesta: ×1.0 / ×1.15 / ×1.3 / ×1.5.
//   5. Capacidad como FILTRO por candidato, en orden: carga + tamaño efectivo ≤ 85% de lo que le
//      queda antes de la fecha límite. El primero que cabe gana.
//   6. Si nadie cabe, escalar con una sugerencia (dividir / repriorizar / backlog). Nunca divide sola.

// ---------------------------------------------------------------- constantes

export const POLICY_VERSION = 'p2';

export const POLICY = {
  HOURS_PER_POINT: 2,
  /** Puntos que se asumen para una tarea abierta sin estimación. */
  DEFAULT_POINTS_UNESTIMATED: 3,
  CAPACITY_CEILING: 0.85,
  WIP_MAX_TASKS: 3,
  WIP_MAX_PROJECTS: 2,
  MULTIPLIER: { encargado: 1.0, subencargado: 1.15, externo: 1.3, externo_sin_historial: 1.5 },
  /** Nivel desde el que alguien cuenta como especialista en una skill. */
  SPECIALIST_LEVEL: 4,
  /** Si la tarea exige este nivel o más, el especialista va primero. */
  SPECIALIST_FIRST_MIN_LEVEL: 4,
  /** Nivel desde el que alguien puede ser revisor senior (cualquier rol). */
  SENIOR_REVIEWER_LEVEL: 4,
  TIEBREAK_MAX_GAP: 1,
  TIEBREAK_MAX_POINTS: 3,
  /** Horizonte cuando la tarea no tiene fecha límite. */
  DEFAULT_HORIZON_BD: 10,
  /** Fecha límite a ≤ este número de días hábiles (incluido hoy) = urgente. */
  URGENT_DUE_BD: 2,
  /** Días hacia atrás para considerar que alguien tiene historial en un proyecto. */
  HISTORY_DAYS: 90,
  /** Horas que el especialista dedica a definir el approach cuando se sugiere dividir. */
  SPLIT_SPIKE_HOURS: 2,
  ASSIGNABLE_ROLES: ['dev', 'designer', 'intern'] as readonly string[],
} as const;

/** Estados que cuentan como trabajo activo para el tope de WIP. */
export const ACTIVE_STATUSES = ['en_progreso', 'revision'];

// ---------------------------------------------------------------- tipos

export type Relation = 'encargado' | 'subencargado' | 'externo' | 'externo_sin_historial';
export type Tier = 'encargado' | 'subencargado' | 'especialista' | 'pool';
export type Urgency = 'urgente' | 'no_urgente' | 'incierta';
export type Priority = 'urgent' | 'high' | 'medium' | 'low';

export type DiscardCode =
  | 'inactivo'
  | 'rol_no_asignable'
  | 'sin_disponibilidad'
  | 'skill_insuficiente'
  | 'wip_tareas'
  | 'wip_proyectos'
  | 'capacidad';

export interface OpenTaskFacts {
  id: string;
  identifier: string;
  projectId: string | null;
  status: string;
  priority: string | null;
  estimate: number | null;
  dueDate: string | null;
}

export interface DevFacts {
  id: string;
  name: string;
  active: boolean;
  role: string;
  /** 0..1: fracción de su tiempo disponible para tareas. */
  availability: number;
  weeklyHours: number;
  /** skill_id → nivel 1..5. */
  skillLevels: Record<string, number>;
  /** Su asignación (Capacidad) en el proyecto de la tarea, si la tiene. */
  projectAssignment: { kind: 'principal' | 'secondary'; loadPct: number; sortOrder: number } | null;
  hasProjectHistory: boolean;
  /** Tareas abiertas donde es responsable PRINCIPAL, sin contar la tarea que se asigna. */
  openTasks: OpenTaskFacts[];
}

export interface TaskFacts {
  id: string;
  projectId: string | null;
  priority: string | null;
  dueDate: string | null;
  points: number;
  urgency: Urgency;
  skill: { id: string; tag: string; minLevel: number } | null;
  /** Skill que ayuda (del tipo de solución). No filtra a nadie. */
  secondarySkill?: { id: string; tag: string } | null;
}

export interface PolicyInput {
  task: TaskFacts;
  devs: DevFacts[];
  /** YYYY-MM-DD en la zona del equipo. */
  today: string;
}

export interface Reason {
  code: DiscardCode;
  detail: string;
}

export interface CapacityEval {
  horizonDays: number;
  capacityHours: number;
  /** 85% de la capacidad: el techo real. */
  limitHours: number;
  loadHours: number;
  effectiveHours: number;
  fits: boolean;
  /** Tareas que suman carga, para poder explicar (y limpiar) el número. */
  counted: { id: string; identifier: string; hours: number; status: string; priority: string | null }[];
  unestimated: number;
}

export interface CandidateEval {
  devId: string;
  name: string;
  relation: Relation;
  tier: Tier | null;
  /** Posición en el orden final (0 = primero en intentarse); null si lo excluyó un filtro. */
  position: number | null;
  skillLevel: number | null;
  /** Nivel en la skill secundaria (null si el tipo no tiene). */
  secondaryLevel: number | null;
  multiplier: number;
  effectiveHours: number;
  capacity: CapacityEval | null;
  status: 'elegido' | 'alternativa' | 'descartado';
  reasons: Reason[];
}

export interface TieBreak {
  tier: Tier;
  promotedDevId: string;
  overDevIds: string[];
  reviewerDevId: string;
}

export type EscalationOption =
  | { kind: 'dividir'; specialistDevId: string; encargadoDevId: string; spikeHours: number; detail: string }
  | { kind: 'repriorizar'; devId: string; deferIdentifiers: string[]; detail: string }
  | { kind: 'backlog'; detail: string };

export interface Suggestion {
  suggested: EscalationOption['kind'];
  options: EscalationOption[];
}

export interface PolicyDecision {
  outcome: 'assigned' | 'escalated';
  chosen: CandidateEval | null;
  candidates: CandidateEval[];
  tieBreaks: TieBreak[];
  suggestion: Suggestion | null;
  horizonDays: number;
  /** Fecha límite efectiva (la de la tarea o el horizonte por defecto). */
  deadline: string;
}

// ---------------------------------------------------------------- calendario (días hábiles)

function toUtc(date: string): Date {
  return new Date(`${date.slice(0, 10)}T00:00:00Z`);
}
function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function isWeekday(d: Date): boolean {
  const w = d.getUTCDay();
  return w !== 0 && w !== 6;
}

/** Días hábiles (lun–vie) entre dos fechas, ambas incluidas. 0 si `to` es anterior a `from`. */
export function businessDaysBetween(from: string, to: string): number {
  const a = toUtc(from);
  const b = toUtc(to);
  if (b < a) return 0;
  let n = 0;
  for (const d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) if (isWeekday(d)) n++;
  return n;
}

/** La fecha en la que se completan `n` días hábiles contando desde `from` (incluido). */
export function addBusinessDays(from: string, n: number): string {
  const d = toUtc(from);
  let count = 0;
  for (;;) {
    if (isWeekday(d)) count++;
    if (count >= n) return fromUtc(d);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

// ---------------------------------------------------------------- urgencia

export interface UrgencyInput {
  /** Prioridad escrita en la tarea (por una persona o por el intake). */
  priority: string | null;
  dueDate: string | null;
  today: string;
  /** Nouls de Jev; null si no se preguntaron. */
  productionBroken: number | null;
  clientBlocked: number | null;
  yes: number;
  no: number;
}

/**
 * Tabla de urgencia. La prioridad escrita manda (una persona ya lo decidió); la fecha límite cercana
 * siempre vuelve urgente; solo sin prioridad se usan los juicios de Jev, y si no son claros la
 * urgencia queda "incierta" (lo que desactiva el desempate, que exige "no urgente").
 */
export function urgencyOf(i: UrgencyInput): { urgency: Urgency; why: string } {
  const dueSoon = i.dueDate !== null && (i.dueDate < i.today || businessDaysBetween(i.today, i.dueDate) <= POLICY.URGENT_DUE_BD);
  if (i.priority === 'urgent') return { urgency: 'urgente', why: 'prioridad urgente' };
  if (dueSoon) return { urgency: 'urgente', why: 'fecha límite en ≤ 2 días hábiles' };
  if (i.priority) return { urgency: 'no_urgente', why: `prioridad ${i.priority}` };
  const pb = i.productionBroken;
  const cb = i.clientBlocked;
  if ((pb !== null && pb >= i.yes) || (cb !== null && cb >= i.yes)) {
    return { urgency: 'urgente', why: pb !== null && pb >= i.yes ? 'producción caída' : 'cliente bloqueado' };
  }
  if (pb !== null && cb !== null && pb <= i.no && cb <= i.no) return { urgency: 'no_urgente', why: 'sin señales de urgencia' };
  return { urgency: 'incierta', why: 'la tarea no deja clara la urgencia' };
}

// ---------------------------------------------------------------- piezas

const RELATION_RANK: Record<Relation, number> = { encargado: 0, subencargado: 1, externo: 2, externo_sin_historial: 3 };
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function relationOf(dev: DevFacts, task: TaskFacts): Relation {
  if (!task.projectId) return 'externo';
  if (dev.projectAssignment?.kind === 'principal') return 'encargado';
  if (dev.projectAssignment?.kind === 'secondary') return 'subencargado';
  return dev.hasProjectHistory ? 'externo' : 'externo_sin_historial';
}

function levelOf(dev: DevFacts, task: TaskFacts): number | null {
  return task.skill ? dev.skillLevels[task.skill.id] ?? 0 : null;
}

function secondaryLevelOf(dev: DevFacts, task: TaskFacts): number | null {
  return task.secondarySkill ? dev.skillLevels[task.secondarySkill.id] ?? 0 : null;
}

function activeTasks(dev: DevFacts): OpenTaskFacts[] {
  return dev.openTasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Filtros duros. Devuelve TODOS los motivos (no solo el primero): el log debe explicar todo. */
function hardFilters(dev: DevFacts, task: TaskFacts, opts: { skipSkill?: boolean } = {}): Reason[] {
  const out: Reason[] = [];
  if (!dev.active) out.push({ code: 'inactivo', detail: 'no está activo' });
  if (!POLICY.ASSIGNABLE_ROLES.includes(dev.role)) out.push({ code: 'rol_no_asignable', detail: `su rol (${dev.role}) no recibe tareas automáticas` });
  if (!(dev.availability > 0)) out.push({ code: 'sin_disponibilidad', detail: 'disponibilidad en 0' });
  if (task.skill && !opts.skipSkill) {
    const lvl = dev.skillLevels[task.skill.id];
    if (lvl === undefined) out.push({ code: 'skill_insuficiente', detail: `${task.skill.tag}: sin registrar (pide nivel ${task.skill.minLevel})` });
    else if (lvl < task.skill.minLevel) out.push({ code: 'skill_insuficiente', detail: `${task.skill.tag}: nivel ${lvl}, pide ${task.skill.minLevel}` });
  }
  const active = activeTasks(dev);
  if (active.length >= POLICY.WIP_MAX_TASKS) {
    out.push({
      code: 'wip_tareas',
      detail: `${active.length} tareas activas (tope ${POLICY.WIP_MAX_TASKS}): ${active.map((t) => t.identifier).join(', ')}`,
    });
  }
  if (task.projectId) {
    const projects = new Set(active.map((t) => t.projectId).filter((p): p is string => !!p));
    if (!projects.has(task.projectId) && projects.size >= POLICY.WIP_MAX_PROJECTS) {
      out.push({ code: 'wip_proyectos', detail: `ya está en ${projects.size} proyectos activos (tope ${POLICY.WIP_MAX_PROJECTS})` });
    }
  }
  return out;
}

/**
 * Capacidad de alguien para una tarea con fecha límite `deadline`:
 *   capacidad = días hábiles(hoy → deadline) × horas semanales / 5 × disponibilidad
 *   carga     = horas de sus tareas abiertas (como principal) que vencen antes; las que vencen
 *               después cuentan en proporción; una activa sin fecha se asume a 10 días hábiles;
 *               una por-hacer sin fecha no cuenta.
 * Cabe si carga + horas efectivas ≤ 85% de la capacidad.
 */
export function capacityFor(dev: DevFacts, effectiveHours: number, deadline: string, today: string): CapacityEval {
  const horizonDays = Math.max(1, businessDaysBetween(today, deadline));
  const capacityHours = round2(horizonDays * (dev.weeklyHours / 5) * Math.max(0, Math.min(1, dev.availability)));
  const limitHours = round2(capacityHours * POLICY.CAPACITY_CEILING);
  const defaultDue = addBusinessDays(today, POLICY.DEFAULT_HORIZON_BD);

  let loadHours = 0;
  let unestimated = 0;
  const counted: CapacityEval['counted'] = [];
  for (const t of dev.openTasks) {
    const points = t.estimate ?? POLICY.DEFAULT_POINTS_UNESTIMATED;
    const due = t.dueDate ?? (ACTIVE_STATUSES.includes(t.status) ? defaultDue : null);
    if (!due) continue;
    const full = points * POLICY.HOURS_PER_POINT;
    let hours: number;
    if (due <= deadline || due < today) hours = full;
    else hours = (full * horizonDays) / Math.max(1, businessDaysBetween(today, due));
    if (hours <= 0) continue;
    if (t.estimate === null) unestimated++;
    loadHours += hours;
    counted.push({ id: t.id, identifier: t.identifier, hours: round2(hours), status: t.status, priority: t.priority });
  }
  loadHours = round2(loadHours);
  return {
    horizonDays,
    capacityHours,
    limitHours,
    loadHours,
    effectiveHours: round2(effectiveHours),
    // Una centésima de tolerancia: 85% exacto cabe, y el redondeo no debe decidir.
    fits: loadHours + effectiveHours <= limitHours + 0.005,
    counted,
    unestimated,
  };
}

// ---------------------------------------------------------------- decisión

interface Eligible {
  dev: DevFacts;
  relation: Relation;
  level: number | null;
  secondaryLevel: number | null;
  tier: Tier;
}

function byName(a: Eligible, b: Eligible): number {
  return a.dev.name.localeCompare(b.dev.name) || a.dev.id.localeCompare(b.dev.id);
}

function sortTier(tier: Tier, list: Eligible[]): Eligible[] {
  const assignmentKey = (a: Eligible, b: Eligible) =>
    (b.dev.projectAssignment?.loadPct ?? 0) - (a.dev.projectAssignment?.loadPct ?? 0) ||
    (a.dev.projectAssignment?.sortOrder ?? 0) - (b.dev.projectAssignment?.sortOrder ?? 0) ||
    byName(a, b);
  const secondaryKey = (a: Eligible, b: Eligible) => (b.secondaryLevel ?? 0) - (a.secondaryLevel ?? 0);
  const levelKey = (a: Eligible, b: Eligible) =>
    (b.level ?? 0) - (a.level ?? 0) || secondaryKey(a, b) || RELATION_RANK[a.relation] - RELATION_RANK[b.relation] || byName(a, b);
  const poolKey = (a: Eligible, b: Eligible) =>
    RELATION_RANK[a.relation] - RELATION_RANK[b.relation] || (b.level ?? 0) - (a.level ?? 0) || secondaryKey(a, b) || byName(a, b);
  const key = tier === 'encargado' || tier === 'subencargado' ? assignmentKey : tier === 'especialista' ? levelKey : poolKey;
  return [...list].sort(key);
}

/** Revisor senior para `candidate`: otra persona activa, de cualquier rol, con nivel ≥ 4 en la skill. */
function seniorReviewer(devs: DevFacts[], task: TaskFacts, candidateId: string): DevFacts | null {
  if (!task.skill) return null;
  const skillId = task.skill.id;
  const pool = devs
    .filter((d) => d.id !== candidateId && d.active && (d.skillLevels[skillId] ?? 0) >= POLICY.SENIOR_REVIEWER_LEVEL)
    .sort(
      (a, b) =>
        (b.skillLevels[skillId] ?? 0) - (a.skillLevels[skillId] ?? 0) ||
        RELATION_RANK[relationOf(a, task)] - RELATION_RANK[relationOf(b, task)] ||
        a.name.localeCompare(b.name),
    );
  return pool[0] ?? null;
}

/**
 * Desempate dentro de un grupo: entre quienes están a ≤ 1 nivel del mejor, gana el de nivel menor
 * — solo si la tarea es chica, no urgente, exige skill y hay alguien senior que pueda revisar.
 */
function tieBreak(tier: Tier, ordered: Eligible[], input: PolicyInput): { list: Eligible[]; applied: TieBreak | null } {
  const { task, devs } = input;
  if (!task.skill || task.points > POLICY.TIEBREAK_MAX_POINTS || task.urgency !== 'no_urgente' || ordered.length < 2) {
    return { list: ordered, applied: null };
  }
  const top = Math.max(...ordered.map((e) => e.level ?? 0));
  const group = ordered.filter((e) => (e.level ?? 0) >= top - POLICY.TIEBREAK_MAX_GAP);
  const levels = new Set(group.map((e) => e.level));
  if (group.length < 2 || levels.size < 2) return { list: ordered, applied: null };

  const regrouped = [...group].sort((a, b) => (a.level ?? 0) - (b.level ?? 0)); // estable: respeta el orden previo
  const promoted = regrouped[0]!;
  const reviewer = seniorReviewer(devs, task, promoted.dev.id);
  if (!reviewer) return { list: ordered, applied: null };

  const rest = ordered.filter((e) => !group.includes(e));
  const list = [...regrouped, ...rest];
  if (list[0] === ordered[0]) return { list: ordered, applied: null };
  return {
    list,
    applied: {
      tier,
      promotedDevId: promoted.dev.id,
      overDevIds: group.filter((e) => e !== promoted && (e.level ?? 0) > (promoted.level ?? 0)).map((e) => e.dev.id),
      reviewerDevId: reviewer.id,
    },
  };
}

function effectiveHoursFor(task: TaskFacts, relation: Relation): number {
  return task.points * POLICY.HOURS_PER_POINT * POLICY.MULTIPLIER[relation];
}

export function decide(input: PolicyInput): PolicyDecision {
  const { task, devs, today } = input;
  const deadline = task.dueDate ?? addBusinessDays(today, POLICY.DEFAULT_HORIZON_BD);
  const horizonDays = Math.max(1, businessDaysBetween(today, deadline));

  // 1. Filtros duros.
  const evals = new Map<string, CandidateEval>();
  const eligible: Eligible[] = [];
  for (const dev of devs) {
    const relation = relationOf(dev, task);
    const level = levelOf(dev, task);
    const secondaryLevel = secondaryLevelOf(dev, task);
    const reasons = hardFilters(dev, task);
    evals.set(dev.id, {
      devId: dev.id,
      name: dev.name,
      relation,
      tier: null,
      position: null,
      skillLevel: level,
      secondaryLevel,
      multiplier: POLICY.MULTIPLIER[relation],
      effectiveHours: round2(effectiveHoursFor(task, relation)),
      capacity: null,
      status: 'descartado',
      reasons,
    });
    if (!reasons.length) {
      const isSpecialist = level !== null && level >= POLICY.SPECIALIST_LEVEL;
      const specialistFirst = !!task.skill && task.skill.minLevel >= POLICY.SPECIALIST_FIRST_MIN_LEVEL;
      let tier: Tier;
      if (specialistFirst && isSpecialist) tier = 'especialista';
      else if (relation === 'encargado') tier = 'encargado';
      else if (relation === 'subencargado') tier = 'subencargado';
      else if (isSpecialist) tier = 'especialista';
      else tier = 'pool';
      eligible.push({ dev, relation, level, secondaryLevel, tier });
    }
  }

  // 2 y 3. Orden por grupo + desempate dentro de cada grupo.
  const specialistFirst = !!task.skill && task.skill.minLevel >= POLICY.SPECIALIST_FIRST_MIN_LEVEL;
  const tierOrder: Tier[] = specialistFirst
    ? ['especialista', 'encargado', 'subencargado', 'pool']
    : ['encargado', 'subencargado', 'especialista', 'pool'];
  const ordered: Eligible[] = [];
  const tieBreaks: TieBreak[] = [];
  for (const tier of tierOrder) {
    const sorted = sortTier(tier, eligible.filter((e) => e.tier === tier));
    const { list, applied } = tieBreak(tier, sorted, input);
    if (applied) tieBreaks.push(applied);
    ordered.push(...list);
  }

  // 4 y 5. Tamaño efectivo + capacidad como filtro, candidato por candidato.
  let chosen: CandidateEval | null = null;
  ordered.forEach((e, position) => {
    const ev = evals.get(e.dev.id)!;
    ev.tier = e.tier;
    ev.position = position;
    ev.capacity = capacityFor(e.dev, ev.effectiveHours, deadline, today);
    if (ev.capacity.fits) {
      ev.status = chosen ? 'alternativa' : 'elegido';
      if (!chosen) chosen = ev;
    } else {
      ev.reasons.push({
        code: 'capacidad',
        detail: `carga ${ev.capacity.loadHours} h + ${ev.capacity.effectiveHours} h > ${ev.capacity.limitHours} h (85% de ${ev.capacity.capacityHours} h en ${ev.capacity.horizonDays} días hábiles)`,
      });
    }
  });

  // Orden de salida: intentados primero (en su orden), luego excluidos por nombre.
  const candidates = [...evals.values()].sort(
    (a, b) =>
      (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name) ||
      a.devId.localeCompare(b.devId),
  );

  if (chosen) {
    return { outcome: 'assigned', chosen, candidates, tieBreaks, suggestion: null, horizonDays, deadline };
  }
  return {
    outcome: 'escalated',
    chosen: null,
    candidates,
    tieBreaks,
    suggestion: escalate(input, ordered, evals, deadline),
    horizonDays,
    deadline,
  };
}

// ---------------------------------------------------------------- escalamiento

function escalate(input: PolicyInput, ordered: Eligible[], evals: Map<string, CandidateEval>, deadline: string): Suggestion {
  const { task, devs, today } = input;
  const options: EscalationOption[] = [];

  // a) Dividir: el especialista define el approach (1–2 h) y el encargado implementa. Al encargado se
  //    le perdona la skill (cubrir ese hueco es justo el punto de dividir), no la capacidad ni el WIP.
  if (task.skill && task.projectId) {
    const minSpecialist = Math.max(task.skill.minLevel, POLICY.SPECIALIST_LEVEL);
    const specialist = devs
      .filter((d) => (d.skillLevels[task.skill!.id] ?? 0) >= minSpecialist && !hardFilters(d, task, { skipSkill: true }).length)
      .filter((d) => capacityFor(d, POLICY.SPLIT_SPIKE_HOURS, deadline, today).fits)
      .sort((a, b) => (b.skillLevels[task.skill!.id] ?? 0) - (a.skillLevels[task.skill!.id] ?? 0) || a.name.localeCompare(b.name))[0];
    const encargado = devs
      .filter((d) => d.projectAssignment?.kind === 'principal' && d.id !== specialist?.id)
      .filter((d) => !hardFilters(d, task, { skipSkill: true }).length)
      .filter((d) => capacityFor(d, task.points * POLICY.HOURS_PER_POINT * POLICY.MULTIPLIER.encargado, deadline, today).fits)
      .sort((a, b) => (b.projectAssignment?.loadPct ?? 0) - (a.projectAssignment?.loadPct ?? 0) || a.name.localeCompare(b.name))[0];
    if (specialist && encargado) {
      options.push({
        kind: 'dividir',
        specialistDevId: specialist.id,
        encargadoDevId: encargado.id,
        spikeHours: POLICY.SPLIT_SPIKE_HOURS,
        detail: `${specialist.name} (especialista en ${task.skill.tag}) define el approach en 1–2 h y ${encargado.name} (encargado) implementa`,
      });
    }
  }

  // b) Repriorizar: el primero que solo falló por capacidad cabría si pospone tareas de menor prioridad
  //    que aún no empezó.
  const taskRank = task.urgency === 'urgente' ? 0 : PRIORITY_RANK[task.priority ?? 'medium'] ?? 2;
  for (const e of ordered) {
    const ev = evals.get(e.dev.id)!;
    const cap = ev.capacity;
    if (!cap || cap.fits) continue;
    const deferrable = cap.counted.filter(
      (c) => !ACTIVE_STATUSES.includes(c.status) && (c.priority ? PRIORITY_RANK[c.priority] ?? 4 : 4) > taskRank,
    );
    const freed = deferrable.reduce((s, c) => s + c.hours, 0);
    if (deferrable.length && cap.loadHours - freed + cap.effectiveHours <= cap.limitHours + 0.005) {
      options.push({
        kind: 'repriorizar',
        devId: e.dev.id,
        deferIdentifiers: deferrable.map((c) => c.identifier),
        detail: `${e.dev.name} cabe si se posponen ${deferrable.map((c) => c.identifier).join(', ')}`,
      });
      break;
    }
  }

  options.push({ kind: 'backlog', detail: 'nadie tiene capacidad antes de la fecha límite: mandar a backlog o mover la fecha' });
  return { suggested: options[0]!.kind, options };
}
