// Paso 1 del flujo: clasificar la tarea. PURO — arma la request a Jev y convierte sus respuestas en
// una Classification tipada; quien llama hace la red (src/adapters/typesafe.ts).
//
// q2: Jev clasifica la tarea en un TIPO DE SOLUCIÓN (roz.solution_type) y la tabla decide skill
// primaria, nivel mínimo, skill secundaria y rango de tamaño. Para los tipos "del módulo afectado"
// (bugs, refactor) la skill sale de la pregunta de skill: qué parte del sistema toca.
//
// Lo que fijó una persona GANA sobre lo que juzga Jev (proyecto, tipo, prioridad, fecha y
// estimación). Igual se le pregunta todo a Jev: su respuesta queda guardada y sirve para comparar
// después contra lo que puso la persona.
import type { ChoiceAnswer, JevAnswer, JevQuestion, NoulAnswer, ScoreAnswer, SystemOneRequest } from '../adapters/typesafe.js';
import {
  CLIENT_BLOCKED,
  FITS_SOLUTION_TYPE,
  NEEDS_CATALOG_SKILL,
  NOUL_NO,
  NOUL_YES,
  PRODUCTION_BROKEN,
  PROJECT_FIT,
  SERVER_SIDE,
  SIZE,
  SIZE_POINTS,
  projectQuestion,
  skillQuestion,
  solutionTypeQuestion,
} from './jev-questions.js';
import { urgencyOf, type Urgency } from './policy.js';

// ---------------------------------------------------------------- entrada

export interface TaskInput {
  id: string;
  name: string;
  description: string | null;
  projectId: string | null;
  projectName: string | null;
  projectKind: string | null;
  /** Perfil del proyecto (0033): tipo principal (etiqueta) y descripción. Contexto para Jev. */
  projectType?: string | null;
  projectDescription?: string | null;
  /** El tipo como valor (`app_web`, `landing`…): decide si el proyecto tiene backend propio. */
  projectTypeKey?: string | null;
  priority: string | null;
  /** De dónde salió la prioridad: una persona o el intake (Claude, pero quedó escrita y es editable). */
  prioritySource: 'humano' | 'intake';
  dueDate: string | null;
  estimate: number | null;
  /** Tipo de solución que fijó una persona (en la tarea o al corregir la vista previa de un ticket). */
  solutionTypeId: string | null;
}

export interface CatalogSkill {
  id: string;
  tag: string;
  description: string | null;
}

export interface SkillRef {
  id: string;
  tag: string;
}

/** Una fila de roz.solution_type, ya con sus skills resueltas. */
export interface SolutionTypeDef {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** null = "la skill del módulo afectado" (la dice Jev con la pregunta de skill). */
  primarySkill: SkillRef | null;
  minLevel: number;
  secondarySkill: SkillRef | null;
  sizeMin: number;
  sizeMax: number;
  active: boolean;
}

export interface ProjectOption {
  id: string;
  key: string;
  name: string;
  kind: string | null;
  /** Etiqueta del tipo principal (p.ej. "App web con backend") y descripción, si las tiene. */
  type?: string | null;
  description?: string | null;
  /** El tipo como valor (`app_web`…). */
  typeKey?: string | null;
}

/** Tipos de proyecto con backend propio (ver PROJECT_TYPES en src/projects/profile.ts). */
export const PROJECT_TYPES_WITH_BACKEND = ['ecommerce', 'app_web', 'app_movil', 'api_backend', 'ia'];

// ---------------------------------------------------------------- salida

export type Source = 'humano' | 'intake' | 'jev' | 'regla';

export interface Classification {
  projectId: string | null;
  projectSource: Source;
  /** definido = hay tipo; ninguno = la tarea no es de ningún tipo (junta, compra…); incierto = no está claro. */
  typeState: 'definido' | 'ninguno' | 'incierto';
  solutionType: {
    id: string;
    slug: string;
    name: string;
    minLevel: number;
    module: boolean;
    sizeMin: number;
    sizeMax: number;
  } | null;
  typeSource: Source;
  skillState: 'requerida' | 'ninguna' | 'incierta';
  skill: { id: string; tag: string; minLevel: number } | null;
  skillSource: Source;
  /** Skill que ayuda (no filtra: ordena entre iguales). */
  secondarySkill: SkillRef | null;
  /**
   * Tipo "del módulo" en un proyecto con backend y un ticket que no es claramente solo interfaz:
   * no se filtra por la skill que adivinó Jev; va primero con quien lleva el proyecto.
   */
  moduleOpen: boolean;
  points: number;
  pointsSource: Source;
  priority: string | null;
  dueDate: string | null;
  urgency: Urgency;
  urgencyWhy: string;
  /** Lecturas crudas de Jev, para el log y la UI (nunca como compuerta). */
  signals: {
    fitsSolutionType: number | null;
    /** Nombre del tipo que eligió Jev, aunque haya ganado el de una persona. */
    jevType: string | null;
    needsCatalogSkill: number | null;
    /** Skill (módulo) que eligió Jev. */
    jevSkill: string | null;
    /** ¿Toca el lado del servidor? (Noul) */
    serverSide: number | null;
    productionBroken: number | null;
    clientBlocked: number | null;
    projectFit: number | null;
    jevPoints: number | null;
    /** Jev leyó menos que el mínimo típico del tipo: se subió al mínimo. */
    sizeRaisedToMin: boolean;
    /** Jev leyó más que el máximo típico del tipo: se respeta (subestimar satura a alguien), pero se avisa. */
    sizeAboveTypical: boolean;
    /** La distribución tiene dos jorobas: Jev duda entre lecturas lejanas. Solo informativo. */
    sizeSplit: boolean;
  };
}

export type NeedsHumanReason = 'clasificacion_incierta' | 'proyecto_incierto';

// ---------------------------------------------------------------- request

/** Nombres de opción por proyecto: el nombre (descriptivo) y, si se repite, con su clave. */
export function projectOptionNames(projects: ProjectOption[]): Map<string, ProjectOption> {
  const counts = new Map<string, number>();
  for (const p of projects) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  const out = new Map<string, ProjectOption>();
  for (const p of [...projects].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))) {
    out.set((counts.get(p.name) ?? 0) > 1 ? `${p.name} (${p.key})` : p.name, p);
  }
  return out;
}

function kindLabel(kind: string | null): string {
  return kind === 'client' ? 'client project' : 'internal project';
}

/** Cómo se presenta un proyecto a Jev en una opción: cliente/interno, tipo y descripción. */
function projectOptionLabel(p: ProjectOption): string {
  return [kindLabel(p.kind), p.type, p.description?.trim()].filter(Boolean).join(' · ');
}

/**
 * El proyecto de la tarea tal como lo ve Jev. Con perfil, es un objeto (nombre, cliente/interno,
 * tipo y descripción): es lo que distingue "arreglar un botón" en una landing de lo mismo en una
 * app con backend complejo. Sin perfil, el texto de siempre.
 */
export function projectState(task: TaskInput): string | Record<string, string> | null {
  if (!task.projectName) return null;
  if (!task.projectType && !task.projectDescription?.trim()) return `${task.projectName} (${kindLabel(task.projectKind)})`;
  return {
    name: task.projectName,
    kind: kindLabel(task.projectKind),
    ...(task.projectType ? { type: task.projectType } : {}),
    ...(task.projectDescription?.trim() ? { description: task.projectDescription.trim() } : {}),
  };
}

/** Catálogo ordenado por tag: orden fijo para que el sesgo de Choice hacia la 1ª opción sea estable. */
export function catalogCriteria(catalog: CatalogSkill[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const s of [...catalog].sort((a, b) => a.tag.localeCompare(b.tag))) out[s.tag] = s.description?.trim() || null;
  return out;
}

/** Tipos ACTIVOS en el orden de la tabla (sort_order lo trae quien carga): nombre → descripción. */
export function solutionTypeCriteria(types: SolutionTypeDef[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of types) if (t.active) out[t.name] = t.description.trim();
  return out;
}

/**
 * Una sola request por tarea: todas las preguntas comparten el mismo state, se pagan una vez y se
 * responden en paralelo. Las de proyecto solo van si la tarea no lo trae.
 */
export function buildJevRequest(
  task: TaskInput,
  catalog: CatalogSkill[],
  types: SolutionTypeDef[],
  projects: ProjectOption[] | null,
  model: string,
): SystemOneRequest {
  const state: Record<string, unknown> = {
    task: {
      title: task.name,
      description: task.description?.trim() || '(sin descripción)',
      project: projectState(task),
    },
  };
  const questions: Record<string, JevQuestion> = {};

  const typeCriteria = solutionTypeCriteria(types);
  if (Object.keys(typeCriteria).length) {
    state.solution_types = typeCriteria;
    questions.solution_type = solutionTypeQuestion(typeCriteria);
    questions.fits_solution_type = FITS_SOLUTION_TYPE;
  }
  if (catalog.length) {
    state.skill_catalog = catalogCriteria(catalog);
    questions.skill = skillQuestion(catalogCriteria(catalog));
    questions.needs_catalog_skill = NEEDS_CATALOG_SKILL;
  }
  questions.size = SIZE;
  questions.server_side = SERVER_SIDE;
  questions.production_broken = PRODUCTION_BROKEN;
  questions.client_blocked = CLIENT_BLOCKED;

  if (!task.projectId && projects?.length) {
    const options = projectOptionNames(projects);
    state.active_projects = Object.fromEntries([...options].map(([name, p]) => [name, projectOptionLabel(p)]));
    questions.project = projectQuestion(Object.fromEntries([...options].map(([name, p]) => [name, projectOptionLabel(p)])));
    questions.project_fit = PROJECT_FIT;
  }

  return { model, state, questions };
}

// ---------------------------------------------------------------- lectura de respuestas

function noul(a: JevAnswer | undefined): number | null {
  return a?.type === 'noul' ? (a as NoulAnswer).noul : null;
}
function choice(a: JevAnswer | undefined): ChoiceAnswer | null {
  return a?.type === 'choice' ? (a as ChoiceAnswer) : null;
}
function score(a: JevAnswer | undefined): ScoreAnswer | null {
  return a?.type === 'score' ? (a as ScoreAnswer) : null;
}

/** Probabilidades por posición (0..n-1) de un Score. Las llaves son las del `legend` ("0", "1", …). */
function levelProbabilities(a: ScoreAnswer, levels: number): number[] {
  return Array.from({ length: levels }, (_, i) => a.probabilities[String(i)] ?? 0);
}

/**
 * Mediana de la distribución de un Score: el menor nivel cuya probabilidad acumulada llega a 0.5.
 * Se usa en vez de `score` (la esperanza) porque TypeSafe advierte no tomar la esperanza como una
 * magnitud: con dos jorobas, la esperanza cae en un nivel que nadie eligió.
 */
export function scoreMedian(a: ScoreAnswer, levels: number): number {
  const p = levelProbabilities(a, levels);
  const total = p.reduce((s, x) => s + x, 0) || 1;
  let acc = 0;
  for (let i = 0; i < levels; i++) {
    acc += p[i]! / total;
    if (acc >= 0.5) return i;
  }
  return levels - 1;
}

/** Dos jorobas: hay masa real tanto abajo como arriba. Solo se muestra; nunca decide. */
export function scoreSplit(a: ScoreAnswer, levels: number): boolean {
  const p = levelProbabilities(a, levels);
  const low = p.slice(0, 2).reduce((s, x) => s + x, 0);
  const high = p.slice(3).reduce((s, x) => s + x, 0);
  return low >= 0.3 && high >= 0.3;
}

/**
 * Puntos de Jev contra el rango típico del tipo: por debajo del mínimo se suben al mínimo (un tipo
 * tiene un piso: integrar pagos nunca es de 1 pt); por encima del máximo se RESPETAN y se avisa —
 * bajar una tarea grande al máximo típico subestima la carga y satura a quien la recibe.
 */
export function pointsForType(points: number, min: number, max: number): { points: number; raised: boolean; aboveTypical: boolean } {
  if (points < min) return { points: min, raised: true, aboveTypical: false };
  return { points, raised: false, aboveTypical: points > max };
}

/** Sin tipo de solución (trabajo no técnico) pero con una skill del catálogo clara: nivel mínimo. */
export const NO_TYPE_MIN_LEVEL = 2;

function typeSummary(t: SolutionTypeDef): NonNullable<Classification['solutionType']> {
  return { id: t.id, slug: t.slug, name: t.name, minLevel: t.minLevel, module: !t.primarySkill, sizeMin: t.sizeMin, sizeMax: t.sizeMax };
}

export function readClassification(
  answers: Record<string, JevAnswer>,
  task: TaskInput,
  catalog: CatalogSkill[],
  types: SolutionTypeDef[],
  projects: ProjectOption[] | null,
  today: string,
): Classification {
  // Proyecto.
  let projectId = task.projectId;
  let projectSource: Source = task.projectId ? 'humano' : 'regla';
  const projectFit = noul(answers.project_fit);
  if (!projectId && projects?.length) {
    const picked = choice(answers.project);
    const option = picked ? projectOptionNames(projects).get(picked.choice) : undefined;
    if (option && projectFit !== null && projectFit >= NOUL_YES) {
      projectId = option.id;
      projectSource = 'jev';
    }
  }

  // Tipo de solución: el de una persona gana; si no, el de Jev con su Noul compañero.
  const activeTypes = types.filter((t) => t.active);
  const fits = noul(answers.fits_solution_type);
  const pickedType = choice(answers.solution_type);
  const jevType = pickedType ? activeTypes.find((t) => t.name === pickedType.choice) ?? null : null;
  const humanType = task.solutionTypeId ? types.find((t) => t.id === task.solutionTypeId) ?? null : null;
  let type: SolutionTypeDef | null = null;
  let typeState: Classification['typeState'];
  let typeSource: Source;
  if (humanType) {
    type = humanType;
    typeState = 'definido';
    typeSource = 'humano';
  } else if (!activeTypes.length) {
    typeState = 'incierto';
    typeSource = 'regla';
  } else if (fits !== null && fits >= NOUL_YES && jevType) {
    type = jevType;
    typeState = 'definido';
    typeSource = 'jev';
  } else if (fits !== null && fits <= NOUL_NO) {
    typeState = 'ninguno';
    typeSource = 'jev';
  } else {
    typeState = 'incierto';
    typeSource = 'jev';
  }

  // Skill exigida: la primaria del tipo, o —si el tipo es "del módulo"— la que dice Jev que toca.
  // Excepción: en un proyecto con backend, si el ticket NO es claramente solo interfaz (server_side >
  // 0.3: dudoso o claramente del servidor), el módulo que "adivina" Jev no filtra — un botón que "no
  // funciona" puede ser frontend o backend, y quien lleva el proyecto conoce los dos.
  const serverSide = noul(answers.server_side);
  const projectHasBackend = !!task.projectTypeKey && PROJECT_TYPES_WITH_BACKEND.includes(task.projectTypeKey);
  const needs = noul(answers.needs_catalog_skill);
  const pickedSkill = choice(answers.skill);
  const jevSkill = pickedSkill ? catalog.find((s) => s.tag === pickedSkill.choice) ?? null : null;
  let skillState: Classification['skillState'];
  let skill: Classification['skill'] = null;
  let skillSource: Source;
  let moduleOpen = false;
  if (type && !type.primarySkill && projectHasBackend && serverSide !== null && serverSide > NOUL_NO) {
    skillState = 'ninguna';
    skillSource = 'regla';
    moduleOpen = true;
  } else if (type?.primarySkill) {
    skillState = 'requerida';
    skill = { id: type.primarySkill.id, tag: type.primarySkill.tag, minLevel: type.minLevel };
    skillSource = typeSource;
  } else if (type) {
    if (needs !== null && needs >= NOUL_YES && jevSkill) {
      skillState = 'requerida';
      skill = { id: jevSkill.id, tag: jevSkill.tag, minLevel: type.minLevel };
      skillSource = 'jev';
    } else {
      skillState = 'incierta';
      skillSource = 'jev';
    }
  } else if (typeState === 'ninguno') {
    // No es trabajo técnico de la tabla (un video, una campaña…), pero si Jev ve clara una skill del
    // catálogo, esa skill sigue sirviendo para llegar a quien sabe hacerlo.
    if (needs !== null && needs >= NOUL_YES && jevSkill) {
      skillState = 'requerida';
      skill = { id: jevSkill.id, tag: jevSkill.tag, minLevel: NO_TYPE_MIN_LEVEL };
    } else {
      skillState = 'ninguna';
    }
    skillSource = 'jev';
  } else {
    skillState = 'incierta';
    skillSource = typeSource;
  }
  const secondarySkill = type?.secondarySkill && type.secondarySkill.id !== skill?.id ? type.secondarySkill : null;

  // Tamaño: lo de una persona gana; si no, lo de Jev con el piso del tipo (ver pointsForType).
  const size = score(answers.size);
  const jevPoints = size ? SIZE_POINTS[scoreMedian(size, SIZE_POINTS.length)]! : null;
  let points: number;
  let pointsSource: Source;
  let sizeRaisedToMin = false;
  let sizeAboveTypical = false;
  if (task.estimate !== null && task.estimate > 0) {
    points = task.estimate;
    pointsSource = 'humano';
  } else if (jevPoints !== null) {
    if (type) {
      const r = pointsForType(jevPoints, type.sizeMin, type.sizeMax);
      points = r.points;
      sizeRaisedToMin = r.raised;
      sizeAboveTypical = r.aboveTypical;
    } else {
      points = jevPoints;
    }
    pointsSource = 'jev';
  } else if (type) {
    points = type.sizeMin;
    pointsSource = 'regla';
  } else {
    points = 3;
    pointsSource = 'regla';
  }

  // Urgencia (tabla en policy.ts).
  const productionBroken = noul(answers.production_broken);
  const clientBlocked = noul(answers.client_blocked);
  const { urgency, why } = urgencyOf({
    priority: task.priority,
    dueDate: task.dueDate,
    today,
    productionBroken,
    clientBlocked,
    yes: NOUL_YES,
    no: NOUL_NO,
  });

  return {
    projectId,
    projectSource,
    typeState,
    solutionType: type ? typeSummary(type) : null,
    typeSource,
    skillState,
    skill,
    skillSource,
    secondarySkill,
    moduleOpen,
    points,
    pointsSource,
    priority: task.priority,
    dueDate: task.dueDate,
    urgency,
    urgencyWhy: why,
    signals: {
      fitsSolutionType: fits,
      jevType: pickedType?.choice ?? null,
      needsCatalogSkill: needs,
      jevSkill: pickedSkill?.choice ?? null,
      serverSide,
      productionBroken,
      clientBlocked,
      projectFit,
      jevPoints,
      sizeRaisedToMin,
      sizeAboveTypical,
      sizeSplit: size ? scoreSplit(size, SIZE_POINTS.length) : false,
    },
  };
}

/**
 * ¿Hace falta una persona antes de decidir? Si no está claro qué clase de trabajo es (o qué módulo
 * toca), excluir gente por skill sobre un juicio dudoso es peor que preguntar.
 */
export function needsHuman(c: Classification, task: TaskInput, projectsOffered: boolean): NeedsHumanReason | null {
  if (c.typeState === 'incierto' || c.skillState === 'incierta') return 'clasificacion_incierta';
  if (!task.projectId && projectsOffered && c.projectId === null) {
    const fit = c.signals.projectFit;
    if (fit === null || fit > NOUL_NO) return 'proyecto_incierto';
  }
  return null;
}
