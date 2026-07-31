// Modelo de estados de las tareas — fuente ÚNICA, reutilizada por la API, la automatización de
// código y el front (vía el endpoint de filtros).
//
// Vocabulario ALINEADO con public.tasks de HyperOps (migración 0020): una tarea que cruza de Ops
// a roz —o de vuelta— no necesita traducirse. Los seis estados mapean 1:1 con los de Ops, así que
// `status` se copia tal cual en ambas direcciones.
//
// Ciclo natural de una tarea nativa acompañando al código:
//   planificada/pendiente → (rama creada) en_progreso → (PR abierta) revision → (PR mergeada) completada
//                                                                              ↘ cancelada (manual)

export type TaskState =
  | 'planificada'
  | 'pendiente'
  | 'en_progreso'
  | 'revision'
  | 'completada'
  | 'cancelada';

/** Etiqueta legible por estado. Se deriva en presentación; ya no se guarda en la tabla. */
export const STATE_LABEL: Record<TaskState, string> = {
  planificada: 'Planificada',
  pendiente: 'Por hacer',
  en_progreso: 'En curso',
  revision: 'En revisión',
  completada: 'Completada',
  cancelada: 'Cancelada',
};

/** Orden de columnas (planificada → cerrada) para el tablero/lista. */
export const STATE_ORDER: TaskState[] = [
  'planificada',
  'pendiente',
  'en_progreso',
  'revision',
  'completada',
  'cancelada',
];

/** Estados abiertos (trabajo vivo). */
export const OPEN_STATES = ['planificada', 'pendiente', 'en_progreso', 'revision'];

/** Estados cerrados. */
export const CLOSED_STATES = ['completada', 'cancelada'];

export function isOpenState(state: string): boolean {
  return OPEN_STATES.includes(state);
}

export function isClosedState(state: string): boolean {
  return CLOSED_STATES.includes(state);
}

/** Opciones {value,label} para selects del front. */
export const STATE_OPTIONS = STATE_ORDER.map((value) => ({ value, label: STATE_LABEL[value] }));

/**
 * Columnas de timestamp a setear al transicionar a `state` (work_item ya tiene started_at /
 * completed_at / canceled_at, migración 0004). Solo setea si aún no tienen valor lo maneja el caller
 * con coalesce; aquí devolvemos el instante de la transición para la columna correspondiente.
 */
export function transitionTimestamps(state: string, now = new Date().toISOString()): Record<string, string> {
  if (state === 'en_progreso' || state === 'revision') return { started_at: now };
  if (state === 'completada') return { completed_at: now };
  if (state === 'cancelada') return { canceled_at: now };
  return {};
}
