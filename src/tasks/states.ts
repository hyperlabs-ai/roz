// Modelo de estados de las tareas — fuente ÚNICA, reutilizada por la API, la automatización de
// código y el front (vía el endpoint de filtros). Se mantiene el vocabulario tipo-Linear que ya
// usaban el espejo y el dashboard, añadiendo `review` ("En revisión") para el ciclo de PR.
//
// Ciclo natural de una tarea nativa acompañando al código:
//   backlog/unstarted → (rama creada) started → (PR abierta) review → (PR mergeada) completed
//                                                                    ↘ canceled (manual)

export type TaskState = 'backlog' | 'unstarted' | 'started' | 'review' | 'completed' | 'canceled';

/** Etiqueta legible (español) por estado. Se guarda en work_item.state_name. */
export const STATE_LABEL: Record<TaskState, string> = {
  backlog: 'Backlog',
  unstarted: 'Por hacer',
  started: 'En curso',
  review: 'En revisión',
  completed: 'Completado',
  canceled: 'Cancelada',
};

/** Orden de columnas (backlog → done) para el tablero/lista. */
export const STATE_ORDER: TaskState[] = ['backlog', 'unstarted', 'started', 'review', 'completed', 'canceled'];

/** Estados abiertos (trabajo vivo). `triage` se conserva por compat con espejos históricos. */
export const OPEN_STATES = ['backlog', 'unstarted', 'triage', 'started', 'review'];

/** Estados cerrados. `done` se conserva por compat con espejos históricos de Linear. */
export const CLOSED_STATES = ['completed', 'done', 'canceled'];

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
  if (state === 'started' || state === 'review') return { started_at: now };
  if (state === 'completed' || state === 'done') return { completed_at: now };
  if (state === 'canceled') return { canceled_at: now };
  return {};
}
