import { describe, it, expect } from 'vitest';
import {
  POLICY,
  addBusinessDays,
  businessDaysBetween,
  capacityFor,
  decide,
  type DevFacts,
  type OpenTaskFacts,
  type TaskFacts,
} from '../src/assign/policy.js';

// La política de asignación automática, regla por regla. Es la parte que decide a quién le cae el
// trabajo: si una regla se rompe en silencio, alguien termina saturado (o el encargado deja de ser
// el primero) sin que nadie lo note. Por eso es pura y cada regla del spec tiene su caso aquí.

const TODAY = '2026-11-02'; // lunes
const P = 'proyecto-a';
const OTRO = 'proyecto-b';
const TERCERO = 'proyecto-c';
const FRONT = 'skill-front';

function dev(id: string, over: Partial<DevFacts> = {}): DevFacts {
  return {
    id,
    name: id,
    active: true,
    role: 'dev',
    availability: 1,
    weeklyHours: 40,
    skillLevels: { [FRONT]: 3 },
    projectAssignment: null,
    hasProjectHistory: false,
    openTasks: [],
    ...over,
  };
}

function task(over: Partial<TaskFacts> = {}): TaskFacts {
  return {
    id: 'nueva',
    projectId: P,
    priority: 'medium',
    dueDate: null,
    points: 3,
    urgency: 'no_urgente',
    skill: { id: FRONT, tag: 'frontend', minLevel: 2 },
    ...over,
  };
}

let seq = 0;
function open(over: Partial<OpenTaskFacts> = {}): OpenTaskFacts {
  seq++;
  return { id: `t${seq}`, identifier: `ROZ-${seq}`, projectId: P, status: 'pendiente', priority: 'medium', estimate: 1, dueDate: null, ...over };
}

const encargado = (id: string, loadPct = 50, sortOrder = 0, over: Partial<DevFacts> = {}) =>
  dev(id, { projectAssignment: { kind: 'principal', loadPct, sortOrder }, hasProjectHistory: true, ...over });
const subencargado = (id: string, over: Partial<DevFacts> = {}) =>
  dev(id, { projectAssignment: { kind: 'secondary', loadPct: 20, sortOrder: 0 }, hasProjectHistory: true, ...over });

function chosenOf(t: TaskFacts, devs: DevFacts[]) {
  return decide({ task: t, devs, today: TODAY }).chosen?.devId ?? null;
}
function evalOf(t: TaskFacts, devs: DevFacts[], id: string) {
  return decide({ task: t, devs, today: TODAY }).candidates.find((c) => c.devId === id)!;
}

describe('días hábiles', () => {
  it('cuenta lunes a viernes, ambos extremos incluidos', () => {
    expect(businessDaysBetween('2026-11-02', '2026-11-06')).toBe(5);
    expect(businessDaysBetween('2026-11-06', '2026-11-09')).toBe(2); // viernes + lunes
    expect(businessDaysBetween('2026-11-07', '2026-11-08')).toBe(0); // fin de semana
    expect(businessDaysBetween('2026-11-09', '2026-11-02')).toBe(0); // al revés
  });

  it('el horizonte por defecto (10 días hábiles) cae el viernes de la semana siguiente', () => {
    expect(addBusinessDays(TODAY, 10)).toBe('2026-11-13');
  });
});

describe('1. filtros duros (excluyen, no penalizan)', () => {
  it('excluye a quien no está activo, no tiene disponibilidad o tiene un rol que no recibe tareas', () => {
    const t = task();
    expect(evalOf(t, [dev('a', { active: false })], 'a').reasons.map((r) => r.code)).toContain('inactivo');
    expect(evalOf(t, [dev('a', { availability: 0 })], 'a').reasons.map((r) => r.code)).toContain('sin_disponibilidad');
    expect(evalOf(t, [dev('a', { role: 'pm' })], 'a').reasons.map((r) => r.code)).toContain('rol_no_asignable');
  });

  it('designer e intern sí reciben tareas', () => {
    expect(chosenOf(task(), [dev('d', { role: 'designer' })])).toBe('d');
    expect(chosenOf(task(), [dev('i', { role: 'intern' })])).toBe('i');
  });

  it('skill por debajo del mínimo, o sin registrar, excluye', () => {
    const t = task({ skill: { id: FRONT, tag: 'frontend', minLevel: 3 } });
    const bajo = evalOf(t, [dev('a', { skillLevels: { [FRONT]: 2 } })], 'a');
    expect(bajo.status).toBe('descartado');
    expect(bajo.reasons[0]!.detail).toMatch(/nivel 2, pide 3/);
    const sinRegistro = evalOf(t, [dev('a', { skillLevels: {} })], 'a');
    expect(sinRegistro.reasons[0]!.detail).toMatch(/sin registrar/);
  });

  it('tope de 3 tareas activas: en curso y en revisión cuentan; por hacer no', () => {
    const activas = [open({ status: 'en_progreso' }), open({ status: 'revision' }), open({ status: 'en_progreso' })];
    expect(evalOf(task(), [dev('a', { openTasks: activas })], 'a').reasons.map((r) => r.code)).toContain('wip_tareas');
    const porHacer = [open({ status: 'pendiente' }), open({ status: 'pendiente' }), open({ status: 'pendiente' })];
    expect(evalOf(task(), [dev('a', { openTasks: porHacer })], 'a').reasons.map((r) => r.code)).not.toContain('wip_tareas');
  });

  it('tope de 2 proyectos simultáneos: un tercero excluye, el mismo proyecto no', () => {
    const enDos = [open({ status: 'en_progreso', projectId: OTRO }), open({ status: 'en_progreso', projectId: TERCERO })];
    expect(evalOf(task(), [dev('a', { openTasks: enDos })], 'a').reasons.map((r) => r.code)).toContain('wip_proyectos');
    const unoEsEste = [open({ status: 'en_progreso', projectId: P }), open({ status: 'en_progreso', projectId: OTRO })];
    expect(evalOf(task(), [dev('a', { openTasks: unoEsEste })], 'a').reasons.map((r) => r.code)).not.toContain('wip_proyectos');
  });

  it('registra TODOS los motivos, no solo el primero', () => {
    const t = task({ skill: { id: FRONT, tag: 'frontend', minLevel: 4 } });
    const codes = evalOf(t, [dev('a', { active: false, availability: 0, skillLevels: { [FRONT]: 1 } })], 'a').reasons.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['inactivo', 'sin_disponibilidad', 'skill_insuficiente']));
  });
});

describe('2. orden de candidatos', () => {
  it('encargado → subencargado → especialista → pool', () => {
    const devs = [
      dev('pool', { hasProjectHistory: true }),
      dev('especialista', { skillLevels: { [FRONT]: 5 } }),
      subencargado('sub'),
      encargado('enc'),
    ];
    const d = decide({ task: task(), devs, today: TODAY });
    expect(d.candidates.map((c) => c.devId)).toEqual(['enc', 'sub', 'especialista', 'pool']);
    expect(d.chosen!.devId).toBe('enc');
    expect(d.candidates.filter((c) => c.status === 'alternativa').map((c) => c.devId)).toEqual(['sub', 'especialista', 'pool']);
  });

  it('con varios encargados va primero el de más % de carga en el proyecto, luego su orden', () => {
    expect(chosenOf(task(), [encargado('chico', 20), encargado('grande', 70)])).toBe('grande');
    expect(chosenOf(task(), [encargado('segundo', 50, 2), encargado('primero', 50, 1)])).toBe('primero');
  });

  it('si la skill exige nivel ≥ 4, el especialista de más nivel sube al primer lugar', () => {
    // 5 pts para que no entre el desempate (que con ≤ 3 pts haría ganar al de nivel 4, con la experta
    // de revisora — eso es correcto y se prueba en su propia sección).
    const t = task({ points: 5, skill: { id: FRONT, tag: 'frontend', minLevel: 4 } });
    const devs = [encargado('enc', 50, 0, { skillLevels: { [FRONT]: 4 } }), dev('experta', { skillLevels: { [FRONT]: 5 } })];
    expect(chosenOf(t, devs)).toBe('experta');
  });

  it('un encargado que además es especialista conserva su ×1.0', () => {
    const t = task({ skill: { id: FRONT, tag: 'frontend', minLevel: 4 } });
    const e = evalOf(t, [encargado('enc', 50, 0, { skillLevels: { [FRONT]: 5 } })], 'enc');
    expect(e.tier).toBe('especialista');
    expect(e.multiplier).toBe(1);
  });

  it('sin skill requerida no hay grupo de especialistas: en el pool va primero quien tiene historial', () => {
    const t = task({ skill: null });
    expect(chosenOf(t, [dev('nuevo', { skillLevels: { [FRONT]: 5 } }), dev('conocido', { hasProjectHistory: true })])).toBe('conocido');
  });
});

describe('2b. skill secundaria del tipo de solución (ordena, no filtra)', () => {
  const BACK = 'skill-back';
  const conSecundaria = (over: Partial<TaskFacts> = {}) => task({ points: 5, secondarySkill: { id: BACK, tag: 'backend' }, ...over });

  it('entre especialistas con el mismo nivel en la primaria, va primero quien sabe más de la secundaria', () => {
    const t = conSecundaria({ skill: { id: FRONT, tag: 'frontend', minLevel: 4 } });
    const devs = [
      dev('ana', { skillLevels: { [FRONT]: 5, [BACK]: 1 } }),
      dev('beto', { skillLevels: { [FRONT]: 5, [BACK]: 4 } }),
    ];
    expect(chosenOf(t, devs)).toBe('beto');
    expect(evalOf(t, devs, 'beto').secondaryLevel).toBe(4);
  });

  it('en el pool desempata después de la relación y la primaria', () => {
    const t = conSecundaria();
    const devs = [
      dev('ana', { skillLevels: { [FRONT]: 3, [BACK]: 1 }, hasProjectHistory: true }),
      dev('beto', { skillLevels: { [FRONT]: 3, [BACK]: 5 }, hasProjectHistory: true }),
    ];
    expect(chosenOf(t, devs)).toBe('beto');
  });

  it('la primaria pesa más que la secundaria', () => {
    const t = conSecundaria({ skill: { id: FRONT, tag: 'frontend', minLevel: 4 } });
    const devs = [dev('ana', { skillLevels: { [FRONT]: 5, [BACK]: 1 } }), dev('beto', { skillLevels: { [FRONT]: 4, [BACK]: 5 } })];
    expect(chosenOf(t, devs)).toBe('ana');
  });

  it('no excluye a nadie: sin la secundaria registrada igual es candidato', () => {
    const t = conSecundaria();
    const e = evalOf(t, [dev('ana', { skillLevels: { [FRONT]: 3 } })], 'ana');
    expect(e.status).toBe('elegido');
    expect(e.secondaryLevel).toBe(0);
  });

  it('el encargado sigue primero aunque otro sepa más de la secundaria', () => {
    const t = conSecundaria();
    expect(chosenOf(t, [encargado('enc'), dev('beto', { skillLevels: { [FRONT]: 3, [BACK]: 5 } })])).toBe('enc');
  });
});

describe('3. desempate (evita el punto único de falla)', () => {
  // Dos encargados: "senior" (nivel 4, más carga → primero por orden) y "junior" (nivel 3).
  const pareja = () => [encargado('senior', 70, 0, { skillLevels: { [FRONT]: 4 } }), encargado('junior', 30, 0, { skillLevels: { [FRONT]: 3 } })];

  it('tarea chica, no urgente y con revisor senior → gana el de nivel menor, y queda el revisor', () => {
    const d = decide({ task: task({ points: 2 }), devs: pareja(), today: TODAY });
    expect(d.chosen!.devId).toBe('junior');
    expect(d.tieBreaks).toEqual([{ tier: 'encargado', promotedDevId: 'junior', overDevIds: ['senior'], reviewerDevId: 'senior' }]);
  });

  it('no aplica con tarea de más de 3 puntos, urgente o de urgencia incierta', () => {
    expect(chosenOf(task({ points: 5 }), pareja())).toBe('senior');
    expect(chosenOf(task({ points: 2, urgency: 'urgente' }), pareja())).toBe('senior');
    expect(chosenOf(task({ points: 2, urgency: 'incierta' }), pareja())).toBe('senior');
  });

  it('no aplica sin revisor senior (nadie con nivel ≥ 4)', () => {
    const devs = [encargado('a', 70, 0, { skillLevels: { [FRONT]: 3 } }), encargado('b', 30, 0, { skillLevels: { [FRONT]: 2 } })];
    expect(chosenOf(task({ points: 2 }), devs)).toBe('a');
  });

  it('no aplica si la diferencia es de más de 1 nivel', () => {
    const devs = [encargado('a', 70, 0, { skillLevels: { [FRONT]: 5 } }), encargado('b', 30, 0, { skillLevels: { [FRONT]: 3 } })];
    expect(chosenOf(task({ points: 2, skill: { id: FRONT, tag: 'frontend', minLevel: 3 } }), devs)).toBe('a');
  });

  it('no salta entre grupos: el subencargado de menor nivel no le gana al encargado', () => {
    const devs = [encargado('enc', 50, 0, { skillLevels: { [FRONT]: 4 } }), subencargado('sub', { skillLevels: { [FRONT]: 3 } })];
    expect(chosenOf(task({ points: 2 }), devs)).toBe('enc');
  });

  it('sin skill requerida no hay desempate', () => {
    const d = decide({ task: task({ points: 1, skill: null }), devs: pareja(), today: TODAY });
    expect(d.chosen!.devId).toBe('senior');
    expect(d.tieBreaks).toEqual([]);
  });
});

describe('4. tamaño efectivo (salir del proyecto cuesta)', () => {
  it('×1.0 encargado, ×1.15 subencargado, ×1.3 externo, ×1.5 externo sin historial', () => {
    const devs = [encargado('e'), subencargado('s'), dev('x', { hasProjectHistory: true }), dev('n')];
    const d = decide({ task: task({ points: 3 }), devs, today: TODAY });
    const hours = Object.fromEntries(d.candidates.map((c) => [c.devId, c.effectiveHours]));
    expect(hours).toEqual({ e: 6, s: 6.9, x: 7.8, n: 9 });
  });

  it('sin proyecto, todos cuentan como externos (×1.3)', () => {
    const d = decide({ task: task({ projectId: null }), devs: [encargado('e')], today: TODAY });
    expect(d.candidates[0]!.relation).toBe('externo');
    expect(d.candidates[0]!.multiplier).toBe(1.3);
  });
});

describe('5. capacidad como filtro por candidato', () => {
  it('capacidad = días hábiles × horas semanales / 5 × disponibilidad; el techo es el 85%', () => {
    const c = capacityFor(dev('a'), 6, '2026-11-13', TODAY);
    expect(c).toMatchObject({ horizonDays: 10, capacityHours: 80, limitHours: 68 });
    expect(capacityFor(dev('a', { availability: 0.5 }), 6, '2026-11-13', TODAY).capacityHours).toBe(40);
    expect(capacityFor(dev('a', { weeklyHours: 20 }), 6, '2026-11-13', TODAY).capacityHours).toBe(40);
  });

  it('85% exacto cabe; una hora más, no', () => {
    // 31 pts por hacer con fecha antes del límite = 62 h; + 6 h de la tarea = 68 h = 85% de 80 h.
    const carga = (extra: number) => [8, 8, 8, 5, 2 + extra].map((estimate) => open({ estimate, dueDate: '2026-11-10' }));
    expect(chosenOf(task(), [encargado('e', 50, 0, { openTasks: carga(0) })])).toBe('e');
    expect(chosenOf(task(), [encargado('e', 50, 0, { openTasks: carga(1) })])).toBeNull();
  });

  it('una tarea que vence después del límite cuenta en proporción', () => {
    // Límite el viernes (5 días); la otra vence en 10 días: 10 h × 5/10 = 5 h.
    const c = capacityFor(dev('a', { openTasks: [open({ estimate: 5, dueDate: '2026-11-13' })] }), 6, '2026-11-06', TODAY);
    expect(c.loadHours).toBe(5);
  });

  it('por hacer sin fecha no cuenta; en curso sin fecha sí, y sin estimación vale 3 pts', () => {
    const c = capacityFor(
      dev('a', { openTasks: [open({ status: 'pendiente', dueDate: null }), open({ status: 'en_progreso', dueDate: null, estimate: null })] }),
      6,
      '2026-11-13',
      TODAY,
    );
    expect(c.loadHours).toBe(6);
    expect(c.unestimated).toBe(1);
    expect(c.counted).toHaveLength(1);
  });

  it('si el primero no cabe, baja al siguiente y deja el motivo', () => {
    const lleno = [8, 8, 8, 8, 8].map((estimate) => open({ estimate, dueDate: '2026-11-10' }));
    const d = decide({ task: task(), devs: [encargado('enc', 50, 0, { openTasks: lleno }), subencargado('sub')], today: TODAY });
    expect(d.chosen!.devId).toBe('sub');
    const enc = d.candidates.find((c) => c.devId === 'enc')!;
    expect(enc.status).toBe('descartado');
    expect(enc.reasons.map((r) => r.code)).toEqual(['capacidad']);
  });
});

describe('6. escalamiento (nadie cabe)', () => {
  it('sugiere dividir: el especialista define el approach y el encargado implementa', () => {
    // Vence hoy: 8 h de capacidad, 6.8 h de techo. La experta (externa, ×1.3) necesita 7.8 h: no
    // cabe, pero 2 h de approach sí. El encargado no tiene la skill, pero 6 h de implementación caben.
    const t = task({ dueDate: TODAY, skill: { id: FRONT, tag: 'frontend', minLevel: 4 } });
    const devs = [encargado('enc', 50, 0, { skillLevels: { [FRONT]: 2 } }), dev('experta', { skillLevels: { [FRONT]: 5 }, hasProjectHistory: true })];
    const d = decide({ task: t, devs, today: TODAY });
    expect(d.outcome).toBe('escalated');
    expect(d.suggestion!.suggested).toBe('dividir');
    expect(d.suggestion!.options[0]).toMatchObject({ kind: 'dividir', specialistDevId: 'experta', encargadoDevId: 'enc' });
  });

  it('sugiere repriorizar cuando posponer tareas de menor prioridad le haría espacio', () => {
    const baja = open({ estimate: 8, dueDate: '2026-11-10', priority: 'low' });
    const otras = [8, 8, 8, 5].map((estimate) => open({ estimate, dueDate: '2026-11-10', priority: 'high' }));
    const t = task({ priority: 'high', skill: null });
    const d = decide({ task: t, devs: [encargado('enc', 50, 0, { openTasks: [baja, ...otras] })], today: TODAY });
    expect(d.suggestion!.suggested).toBe('repriorizar');
    expect(d.suggestion!.options[0]).toMatchObject({ kind: 'repriorizar', devId: 'enc', deferIdentifiers: [baja.identifier] });
  });

  it('si no hay nada mejor, sugiere backlog — y nunca deja a nadie asignado', () => {
    const d = decide({ task: task(), devs: [dev('a', { active: false })], today: TODAY });
    expect(d.outcome).toBe('escalated');
    expect(d.chosen).toBeNull();
    expect(d.suggestion).toEqual({ suggested: 'backlog', options: [expect.objectContaining({ kind: 'backlog' })] });
  });
});

describe('determinismo', () => {
  it('la misma entrada da la misma decisión, sin importar el orden en que llegan las personas', () => {
    const devs = [dev('pool', { hasProjectHistory: true }), subencargado('sub'), encargado('enc')];
    const a = decide({ task: task(), devs, today: TODAY });
    const b = decide({ task: task(), devs: [...devs].reverse(), today: TODAY });
    expect(b).toEqual(a);
  });

  it('las constantes del spec no se movieron', () => {
    expect(POLICY.HOURS_PER_POINT).toBe(2);
    expect(POLICY.CAPACITY_CEILING).toBe(0.85);
    expect([POLICY.WIP_MAX_TASKS, POLICY.WIP_MAX_PROJECTS]).toEqual([3, 2]);
    expect(POLICY.MULTIPLIER).toEqual({ encargado: 1.0, subencargado: 1.15, externo: 1.3, externo_sin_historial: 1.5 });
  });
});
