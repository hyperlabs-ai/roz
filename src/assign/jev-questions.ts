// TODO lo que se le pregunta a Jev para clasificar una tarea: redacción, criterios, niveles y
// umbrales. Es lo que más se audita y se ajusta, por eso vive junto y en un solo lugar.
//
// Reglas que se siguieron (guía de TypeSafe):
//   · Jev JUZGA, el código DECIDE. Ninguna pregunta es "¿a quién asigno?": cada una es un juicio que
//     una persona haría de un vistazo leyendo la tarea; la política (policy.ts) arma la decisión.
//   · Un juicio por pregunta (sin "o"): producción caída y cliente bloqueado son dos Nouls.
//   · Un Choice siempre elige algo, así que va acompañado de un Noul que dice si alguna opción aplica.
//   · Los niveles de un Score son situaciones concretas que se entienden solos.
//   · Preguntas en INGLÉS (Jev es más preciso en inglés); el contenido de la tarea va tal cual.
//   · El state no lleva personas ni fechas: ninguna pregunta las necesita y un campo irrelevante
//     mueve otras respuestas. La fecha límite se evalúa en código (Jev lee fechas como texto).
//
// Cambiar una redacción = subir QUESTIONS_VERSION, para que el log distinga qué preguntas se usaron.
// (Los nombres y descripciones de los tipos de solución son DATOS editables en /app/skills: no suben
// la versión, pero van tal cual en el jev_request guardado de cada decisión.)
//
// q2: la tarea se clasifica en un TIPO DE SOLUCIÓN (tabla roz.solution_type) y la tabla fija skill,
// nivel mínimo y tamaño típico. Se quitó `complexity` (el nivel lo da el tipo) y `size` ganó el
// nivel de 13 pts.
// q3: el state lleva el PERFIL del proyecto (tipo principal y descripción, migración 0033), para
// que "arreglar un botón" no se lea igual en una landing que en una app con backend complejo. Y una
// pregunta nueva, `server_side`: si el ticket no es claramente solo de interfaz, en un proyecto con
// backend no se filtra por la skill que adivinó Jev (va primero con quien lleva el proyecto).
import type { JevQuestion } from '../adapters/typesafe.js';

export const QUESTIONS_VERSION = 'q3';

/** Noul ≥ 0.7 se lee como sí; ≤ 0.3 como no; en medio, la tarea no lo deja claro. */
export const NOUL_YES = 0.7;
export const NOUL_NO = 0.3;

/** Escala de puntos de roz (1 pt = 2 h) y puntos por nivel de `size` (posición 0..5). */
export const SIZE_POINTS = [1, 2, 3, 5, 8, 13] as const;

// ---------------------------------------------------------------- state

export interface JevTaskState {
  title: string;
  description: string;
  /**
   * El proyecto: nombre y si es de cliente o interno y, si tiene perfil, su tipo principal y
   * descripción. Contexto para juzgar tipo de solución, módulo, urgencia y tamaño.
   */
  project: string | { name: string; kind: string; type?: string; description?: string } | null;
}

// ---------------------------------------------------------------- preguntas

/** Qué clase de trabajo es. Opciones = nombres de los tipos activos; criterio = su descripción. */
export function solutionTypeQuestion(types: Record<string, string>): JevQuestion {
  return {
    type: 'choice',
    instructions: 'Which kind of work in `solution_types` best describes the work in `task`?',
    criteria: types,
  };
}

/** Compañero del Choice de tipo: ¿alguno de los tipos describe de verdad la tarea? */
export const FITS_SOLUTION_TYPE: JevQuestion = {
  type: 'noul',
  instructions: 'The work described in `task` is one of the kinds of work listed in `solution_types`.',
  criteria: {
    true: 'The core of the task matches one of the listed kinds of work, for example fixing a broken checkout when a payments kind is listed.',
    false:
      'The task is a meeting, a purchase, an account or access request, a pure decision, or non-technical work that none of the listed kinds describes.',
  },
};

/**
 * Qué skill del catálogo pide más la tarea. Las opciones SON los tags (descriptivos por diseño).
 * Con tipos de solución se usa para saber QUÉ MÓDULO toca un tipo "del módulo afectado" (bugs,
 * refactor).
 */
export function skillQuestion(catalog: Record<string, string | null>): JevQuestion {
  return {
    type: 'choice',
    instructions: 'Which skill area from `skill_catalog` is most needed to do the work described in `task`?',
    criteria: catalog,
  };
}

/** Compañero del Choice de skill: ¿alguna skill del catálogo cubre el núcleo del trabajo? */
export const NEEDS_CATALOG_SKILL: JevQuestion = {
  type: 'noul',
  instructions: 'Doing the work described in `task` mainly requires one of the skill areas listed in `skill_catalog`.',
  criteria: {
    true: 'The core of the work is done with one of the listed skill areas, for example building a screen when a frontend skill is listed.',
    false:
      'The work is a meeting, a purchase, an account or access request, or a pure decision, or it needs a skill area that is not in the list.',
  },
};

/** Cuánto trabajo es, para alguien que ya conoce el proyecto. Posición → SIZE_POINTS (1 pt = 2 h). */
export const SIZE: JevQuestion = {
  type: 'score',
  instructions: 'How much work does `task` involve for a developer who already knows the project?',
  criteria: [
    'One small change that takes an hour or two.',
    'A contained change in one place that takes about half a day.',
    'A few parts of one feature that take most of a working day.',
    'Several components that take about a day and a half.',
    'Several parts to build and test that take about two days.',
    'A large piece of work that takes three days or more and should probably be split.',
  ],
};

/**
 * ¿Toca el lado del servidor? Separa "se ve mal" (solo interfaz) de "no guarda / no envía / falla"
 * (backend). Un ticket vago ("arreglar el botón") queda en la franja dudosa — y eso es justo lo que
 * importa: Jev no adivina el módulo, roz se lo da a quien conoce el proyecto.
 */
export const SERVER_SIDE: JevQuestion = {
  type: 'noul',
  instructions: 'Solving `task` probably requires changing the server side of the project (backend, database, APIs or integrations), not only the user interface.',
  criteria: {
    true: 'Something fails to save, send, load or process, or the project description shows the feature depends on a backend, database, queues or external services.',
    false: 'The task is only about how something looks or is laid out, or the project has no backend of its own, such as a static landing page.',
  },
};

export const PRODUCTION_BROKEN: JevQuestion = {
  type: 'noul',
  instructions: '`task` reports that something in a live production system is broken right now.',
  criteria: {
    true: 'The task describes a live system used by real users failing at this moment: errors, an outage, or data not being saved.',
    false: 'The task describes new work, an improvement, a planned change, or a problem in a development or staging environment.',
  },
};

export const CLIENT_BLOCKED: JevQuestion = {
  type: 'noul',
  instructions: '`task` says that a client cannot continue their work until it is done.',
  criteria: {
    true: 'The task states that a client or end user is stuck or waiting and cannot move forward without this.',
    false: 'A client wants the task but can keep working in the meantime, or no client is waiting on it.',
  },
};

/** Solo cuando la tarea no trae proyecto: a cuál de los activos pertenece. */
export function projectQuestion(options: Record<string, string | null>): JevQuestion {
  return {
    type: 'choice',
    instructions: 'Which project in `active_projects` is the work in `task` for?',
    criteria: options,
  };
}

/** Compañero del Choice de proyecto. */
export const PROJECT_FIT: JevQuestion = {
  type: 'noul',
  instructions: 'The work in `task` belongs to one of the projects listed in `active_projects`.',
  criteria: {
    true: 'The task clearly refers to the product, client or system of one of the listed projects.',
    false: 'The task is about a product or client that is not in the list, or it gives no hint about which project it is for.',
  },
};
