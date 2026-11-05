import { describe, it, expect } from 'vitest';
import type { JevAnswer, ScoreAnswer } from '../src/adapters/typesafe.js';
import {
  buildJevRequest,
  pointsForType,
  NO_TYPE_MIN_LEVEL,
  needsHuman,
  readClassification,
  scoreMedian,
  scoreSplit,
  type CatalogSkill,
  type ProjectOption,
  type SolutionTypeDef,
  type TaskInput,
} from '../src/assign/classify.js';
import { NOUL_NO, NOUL_YES, SIZE_POINTS } from '../src/assign/jev-questions.js';
import { urgencyOf } from '../src/assign/policy.js';

// La clasificación es la frontera con Jev: lo que se manda (el state) y cómo se leen las respuestas.
// Aquí se prueba la FORMA y la LECTURA, nunca una probabilidad exacta del modelo: si mañana Jev
// responde 0.82 en vez de 0.87, nada debería romperse; si cambiamos qué se manda, sí.

const TODAY = '2026-11-02';
const CATALOG: CatalogSkill[] = [
  { id: 's-front', tag: 'frontend', description: 'Interfaces web con React' },
  { id: 's-back', tag: 'backend', description: 'APIs y servicios en Node' },
  { id: 's-arq', tag: 'arquitectura', description: null },
  { id: 's-pagos', tag: 'pagos', description: 'Stripe y cobros' },
];
const ref = (id: string, tag: string) => ({ id, tag });
function type(over: Partial<SolutionTypeDef> & Pick<SolutionTypeDef, 'id' | 'name'>): SolutionTypeDef {
  return {
    slug: over.id,
    description: `${over.name}: descripción`,
    primarySkill: null,
    minLevel: 2,
    secondarySkill: null,
    sizeMin: 1,
    sizeMax: 13,
    active: true,
    ...over,
  };
}
const ENDPOINT = type({ id: 't-endpoint', name: 'Endpoint / CRUD', primarySkill: ref('s-back', 'backend'), minLevel: 3, secondarySkill: ref('s-arq', 'arquitectura'), sizeMin: 2, sizeMax: 5 });
const PAGOS = type({ id: 't-pagos', name: 'Integración de pagos', primarySkill: ref('s-pagos', 'pagos'), minLevel: 4, sizeMin: 5, sizeMax: 13 });
const BUG = type({ id: 't-bug', name: 'Bug menor', primarySkill: null, minLevel: 2, sizeMin: 1, sizeMax: 2 });
const RETIRADO = type({ id: 't-viejo', name: 'Tipo retirado', primarySkill: ref('s-front', 'frontend'), active: false });
const TYPES = [ENDPOINT, PAGOS, BUG, RETIRADO];
const PROJECTS: ProjectOption[] = [
  { id: 'p1', key: 'PROPI', name: 'Propi', kind: 'client' },
  { id: 'p2', key: 'ROZ', name: 'roz', kind: 'internal' },
];

function taskInput(over: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 't1',
    name: 'Endpoint para listar pedidos por fecha',
    description: 'El cliente quiere filtrar pedidos por rango de fechas desde la API.',
    projectId: 'p1',
    projectName: 'Propi',
    projectKind: 'client',
    priority: null,
    prioritySource: 'humano',
    dueDate: '2026-11-20',
    estimate: null,
    solutionTypeId: null,
    ...over,
  };
}

const noul = (p: number): JevAnswer => ({ type: 'noul', noul: p });
const choice = (c: string): JevAnswer => ({ type: 'choice', choice: c, confidence: 0.8, probabilities: { [c]: 0.8 } });
function score(probs: number[]): ScoreAnswer {
  return {
    type: 'score',
    score: probs.reduce((s, p, i) => s + p * i, 0),
    confidence: 0.5,
    legend: {},
    probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])),
  };
}
/** Score de 6 niveles con toda la masa en la posición de `points` (1/2/3/5/8/13). */
const sizeOf = (points: number) => score(SIZE_POINTS.map((p) => (p === points ? 1 : 0)));

function answers(over: Record<string, JevAnswer> = {}): Record<string, JevAnswer> {
  return {
    solution_type: choice('Endpoint / CRUD'),
    fits_solution_type: noul(0.9),
    skill: choice('backend'),
    needs_catalog_skill: noul(0.9),
    size: sizeOf(3),
    production_broken: noul(0.05),
    client_blocked: noul(0.1),
    ...over,
  };
}

const classify = (a: Record<string, JevAnswer>, t = taskInput(), types = TYPES, projects: ProjectOption[] | null = null) =>
  readClassification(a, t, CATALOG, types, projects, TODAY);

describe('la request a Jev', () => {
  it('es UNA sola request: tipo + compañero, skill + compañero, tamaño y urgencia (sin complejidad)', () => {
    const req = buildJevRequest(taskInput(), CATALOG, TYPES, PROJECTS, 'jev-1.14.0');
    expect(req.model).toBe('jev-1.14.0');
    expect(Object.keys(req.questions).sort()).toEqual(
      ['client_blocked', 'fits_solution_type', 'needs_catalog_skill', 'production_broken', 'server_side', 'size', 'skill', 'solution_type'].sort(),
    );
    expect(Object.keys(req.state.skill_catalog as object)).toEqual(['arquitectura', 'backend', 'frontend', 'pagos']);
  });

  it('los tipos van en el orden de la tabla, solo los activos, con su descripción como criterio', () => {
    const req = buildJevRequest(taskInput(), CATALOG, TYPES, null, 'm');
    expect(Object.keys(req.state.solution_types as object)).toEqual(['Endpoint / CRUD', 'Integración de pagos', 'Bug menor']);
    expect((req.questions.solution_type as { criteria: Record<string, string> }).criteria['Bug menor']).toBe('Bug menor: descripción');
  });

  it('el tamaño tiene 6 niveles (llega a 13 pts)', () => {
    const req = buildJevRequest(taskInput(), CATALOG, TYPES, null, 'm');
    expect((req.questions.size as { criteria: string[] }).criteria).toHaveLength(SIZE_POINTS.length);
    expect(SIZE_POINTS.at(-1)).toBe(13);
  });

  it('no manda personas ni la fecha límite (esas se evalúan en código)', () => {
    const json = JSON.stringify(buildJevRequest(taskInput({ dueDate: '2026-11-20' }), CATALOG, TYPES, PROJECTS, 'm'));
    expect(json).not.toContain('2026-11-20');
    expect(json).not.toMatch(/assignee|dev_id|weekly|availability/i);
  });

  it('pregunta por el proyecto SOLO cuando la tarea no lo trae', () => {
    expect(buildJevRequest(taskInput(), CATALOG, TYPES, PROJECTS, 'm').state.active_projects).toBeUndefined();
    const sinProyecto = buildJevRequest(taskInput({ projectId: null, projectName: null }), CATALOG, TYPES, PROJECTS, 'm');
    expect(Object.keys(sinProyecto.state.active_projects as object)).toEqual(['Propi', 'roz']);
    expect(sinProyecto.questions.project).toBeDefined();
    expect(sinProyecto.questions.project_fit).toBeDefined();
  });

  it('sin tipos ni catálogo no pregunta por ellos (no habría opciones)', () => {
    const req = buildJevRequest(taskInput(), [], [], PROJECTS, 'm');
    expect(req.questions.solution_type).toBeUndefined();
    expect(req.questions.skill).toBeUndefined();
    expect(req.questions.size).toBeDefined();
  });
});

describe('lectura de Scores', () => {
  it('se lee la mediana, no la esperanza: con dos jorobas no se inventa un nivel del medio', () => {
    const bimodal = score([0.45, 0.05, 0, 0.05, 0.45]);
    expect(bimodal.score).toBeCloseTo(2, 5); // la esperanza caería en "2", que nadie eligió
    expect(scoreMedian(bimodal, 5)).toBe(1);
    expect(scoreSplit(bimodal, 5)).toBe(true);
    expect(scoreSplit(score([0, 0.1, 0.8, 0.1, 0]), 5)).toBe(false);
  });
});

describe('tipo de solución (Choice + Noul compañero) → skill y nivel de la tabla', () => {
  it('Noul ≥ 0.7: toma el tipo; la skill y el nivel salen de la tabla, no de Jev', () => {
    const c = classify(answers({ fits_solution_type: noul(NOUL_YES), skill: choice('frontend') }));
    expect(c.typeState).toBe('definido');
    expect(c.solutionType?.name).toBe('Endpoint / CRUD');
    expect(c.skill).toEqual({ id: 's-back', tag: 'backend', minLevel: 3 });
    expect(c.secondarySkill).toEqual(ref('s-arq', 'arquitectura'));
    expect(c.signals.jevSkill).toBe('frontend'); // queda registrado aunque no decidió
  });

  it('Noul ≤ 0.3: la tarea no es de ningún tipo (una junta): sin skill exigida', () => {
    const c = classify(answers({ fits_solution_type: noul(NOUL_NO), needs_catalog_skill: noul(0.2) }));
    expect(c.typeState).toBe('ninguno');
    expect(c.skillState).toBe('ninguna');
    expect(c.skill).toBeNull();
    expect(needsHuman(c, taskInput(), false)).toBeNull();
  });

  it('sin tipo pero con una skill del catálogo clara (un video): exige esa skill con nivel mínimo bajo', () => {
    const c = classify(answers({ fits_solution_type: noul(0.2), skill: choice('frontend'), needs_catalog_skill: noul(0.9) }));
    expect(c.typeState).toBe('ninguno');
    expect(c.skill).toEqual({ id: 's-front', tag: 'frontend', minLevel: NO_TYPE_MIN_LEVEL });
    expect(needsHuman(c, taskInput(), false)).toBeNull();
  });

  it('en medio: incierto, y pide a una persona en vez de excluir gente por un juicio dudoso', () => {
    const c = classify(answers({ fits_solution_type: noul(0.5) }));
    expect(c.typeState).toBe('incierto');
    expect(needsHuman(c, taskInput(), false)).toBe('clasificacion_incierta');
  });

  it('un tipo retirado no se le ofrece a Jev ni se acepta como respuesta suya', () => {
    const c = classify(answers({ solution_type: choice('Tipo retirado') }));
    expect(c.typeState).toBe('incierto');
  });

  it('sin tipos activos: incierto (no hay con qué clasificar)', () => {
    const c = classify(answers(), taskInput(), [RETIRADO]);
    expect(c.typeState).toBe('incierto');
    expect(needsHuman(c, taskInput(), false)).toBe('clasificacion_incierta');
  });

  it('el tipo que fijó una persona gana sobre Jev (también uno retirado)', () => {
    const c = classify(answers({ solution_type: choice('Bug menor') }), taskInput({ solutionTypeId: 't-pagos' }));
    expect(c.solutionType?.name).toBe('Integración de pagos');
    expect(c.typeSource).toBe('humano');
    expect(c.skill).toEqual({ id: 's-pagos', tag: 'pagos', minLevel: 4 });
    expect(c.skillSource).toBe('humano');
    expect(c.signals.jevType).toBe('Bug menor');
    expect(classify(answers(), taskInput({ solutionTypeId: 't-viejo' })).solutionType?.id).toBe('t-viejo');
  });
});

describe('tipos "del módulo afectado" (bugs, refactor)', () => {
  it('la skill es la del módulo que dice Jev, con el nivel mínimo del tipo', () => {
    const c = classify(answers({ solution_type: choice('Bug menor'), skill: choice('frontend'), needs_catalog_skill: noul(0.85) }));
    expect(c.solutionType?.module).toBe(true);
    expect(c.skill).toEqual({ id: 's-front', tag: 'frontend', minLevel: 2 });
    expect(c.skillSource).toBe('jev');
  });

  it('si no está claro qué módulo toca: incierto (pide a una persona)', () => {
    const c = classify(answers({ solution_type: choice('Bug menor'), needs_catalog_skill: noul(0.5) }));
    expect(c.typeState).toBe('definido');
    expect(c.skillState).toBe('incierta');
    expect(needsHuman(c, taskInput(), false)).toBe('clasificacion_incierta');
  });
});

describe('ticket vago en un proyecto con backend (server_side)', () => {
  const app = taskInput({ projectTypeKey: 'app_web' });
  const bugMenor = (serverSide: number, t = app) =>
    classify(answers({ solution_type: choice('Bug menor'), skill: choice('frontend'), needs_catalog_skill: noul(0.9), server_side: noul(serverSide) }), t);

  it('no está claro si es solo interfaz: no filtra por la skill que adivinó Jev (va con quien lleva el proyecto)', () => {
    const c = bugMenor(0.45);
    expect(c.moduleOpen).toBe(true);
    expect(c.skillState).toBe('ninguna');
    expect(c.skill).toBeNull();
    expect(c.signals.jevSkill).toBe('frontend'); // queda registrado
    expect(needsHuman(c, app, false)).toBeNull();
  });

  it('claramente del servidor: tampoco filtra por el módulo de Jev (puede haberlo leído como frontend)', () => {
    const c = bugMenor(0.85);
    expect(c.moduleOpen).toBe(true);
    expect(c.skill).toBeNull();
  });

  it('claramente solo interfaz: se usa el módulo que dijo Jev', () => {
    expect(bugMenor(0.1).skill?.tag).toBe('frontend');
    expect(bugMenor(0.1).moduleOpen).toBe(false);
  });

  it('en una landing (sin backend propio) o sin perfil, no aplica', () => {
    expect(bugMenor(0.45, taskInput({ projectTypeKey: 'landing' })).skill?.tag).toBe('frontend');
    expect(bugMenor(0.45, taskInput()).skill?.tag).toBe('frontend');
  });

  it('solo en tipos "del módulo": un tipo con skill primaria la conserva', () => {
    const c = classify(answers({ server_side: noul(0.45) }), app); // Endpoint / CRUD → backend
    expect(c.skill?.tag).toBe('backend');
    expect(c.moduleOpen).toBe(false);
  });
});

describe('tamaño', () => {
  it('por debajo del mínimo típico del tipo se sube al mínimo (y queda registrado)', () => {
    const chico = classify(answers({ solution_type: choice('Integración de pagos'), size: sizeOf(1) })); // 5–13
    expect(chico.points).toBe(5);
    expect(chico.signals.jevPoints).toBe(1);
    expect(chico.signals.sizeRaisedToMin).toBe(true);
    const dentro = classify(answers({ size: sizeOf(3) })); // Endpoint: 2–5
    expect(dentro.points).toBe(3);
    expect(dentro.signals.sizeRaisedToMin).toBe(false);
    expect(dentro.signals.sizeAboveTypical).toBe(false);
  });

  it('por encima del máximo típico se RESPETA (bajarla subestimaría la carga) y se avisa', () => {
    const grande = classify(answers({ size: sizeOf(13) })); // Endpoint: 2–5
    expect(grande.points).toBe(13);
    expect(grande.signals.sizeAboveTypical).toBe(true);
  });

  it('llega a 13 pts cuando el tipo lo permite', () => {
    expect(classify(answers({ solution_type: choice('Integración de pagos'), size: sizeOf(13) })).points).toBe(13);
  });

  it('sin tipo, el tamaño de Jev queda tal cual', () => {
    expect(classify(answers({ fits_solution_type: noul(0.1), size: sizeOf(8) })).points).toBe(8);
  });

  it('la estimación humana gana sobre el tamaño de Jev y sobre el rango del tipo', () => {
    const c = classify(answers({ size: sizeOf(8) }), taskInput({ estimate: 13 }));
    expect(c.points).toBe(13);
    expect(c.pointsSource).toBe('humano');
    expect(c.signals.jevPoints).toBe(8);
  });

  it('pointsForType', () => {
    expect(pointsForType(1, 2, 5)).toEqual({ points: 2, raised: true, aboveTypical: false });
    expect(pointsForType(8, 2, 5)).toEqual({ points: 8, raised: false, aboveTypical: true });
    expect(pointsForType(3, 2, 5)).toEqual({ points: 3, raised: false, aboveTypical: false });
  });
});

describe('proyecto (solo si falta)', () => {
  const sinProyecto = taskInput({ projectId: null, projectName: null });

  it('Choice + compañero claro: toma el proyecto de Jev', () => {
    const c = classify(answers({ project: choice('roz'), project_fit: noul(0.9) }), sinProyecto, TYPES, PROJECTS);
    expect(c.projectId).toBe('p2');
    expect(c.projectSource).toBe('jev');
  });

  it('compañero dudoso: pide a una persona', () => {
    const c = classify(answers({ project: choice('roz'), project_fit: noul(0.5) }), sinProyecto, TYPES, PROJECTS);
    expect(c.projectId).toBeNull();
    expect(needsHuman(c, sinProyecto, true)).toBe('proyecto_incierto');
  });

  it('compañero claramente "no": sigue sin proyecto (todos cuentan como externos)', () => {
    const c = classify(answers({ project: choice('roz'), project_fit: noul(0.1) }), sinProyecto, TYPES, PROJECTS);
    expect(c.projectId).toBeNull();
    expect(needsHuman(c, sinProyecto, true)).toBeNull();
  });
});

describe('tabla de urgencia', () => {
  const base = { priority: null, dueDate: null, today: TODAY, productionBroken: 0.1, clientBlocked: 0.1, yes: NOUL_YES, no: NOUL_NO };

  it('prioridad urgente → urgente; otra prioridad escrita → manda la persona', () => {
    expect(urgencyOf({ ...base, priority: 'urgent' }).urgency).toBe('urgente');
    expect(urgencyOf({ ...base, priority: 'medium', productionBroken: 0.95 }).urgency).toBe('no_urgente');
  });

  it('fecha límite en ≤ 2 días hábiles (o vencida) → urgente, aunque la prioridad sea baja', () => {
    expect(urgencyOf({ ...base, priority: 'low', dueDate: '2026-11-03' }).urgency).toBe('urgente');
    expect(urgencyOf({ ...base, dueDate: '2026-10-30' }).urgency).toBe('urgente');
    expect(urgencyOf({ ...base, dueDate: '2026-11-04' }).urgency).toBe('no_urgente');
  });

  it('sin prioridad: cualquier señal clara de Jev → urgente; ambas claramente no → no urgente; si no, incierta', () => {
    expect(urgencyOf({ ...base, productionBroken: 0.9 }).urgency).toBe('urgente');
    expect(urgencyOf({ ...base, clientBlocked: 0.75 }).urgency).toBe('urgente');
    expect(urgencyOf({ ...base }).urgency).toBe('no_urgente');
    expect(urgencyOf({ ...base, clientBlocked: 0.5 }).urgency).toBe('incierta');
  });
});
