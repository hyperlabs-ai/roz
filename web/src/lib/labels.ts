// Fuente ÚNICA de etiquetas y colores de estado / prioridad / origen. Antes cada página
// (Overview, Tickets, Tasks, ProjectDetail) y bits.tsx redefinían estos mapas con variantes
// ligeramente distintas; centralizarlos evita que se desincronicen.

// Vocabulario de estado: el MISMO que public.tasks de Ops (migración 0020). Los nombres viejos
// de Linear (backlog/started/completed…) siguen mapeados porque hay work items históricos que
// nunca se reconvirtieron; sin ellos la UI mostraría el valor crudo.
export const STATE_LABEL: Record<string, string> = {
  planificada: 'Planificada',
  pendiente: 'Por hacer',
  en_progreso: 'En curso',
  revision: 'En revisión',
  completada: 'Completada',
  cancelada: 'Cancelada',
  // Heredados de Linear
  backlog: 'Backlog',
  unstarted: 'Sin empezar',
  triage: 'Triage',
  started: 'En curso',
  in_progress: 'En curso',
  review: 'En revisión',
  completed: 'Completado',
  done: 'Hecho',
  canceled: 'Cancelado',
};

/** Orden de estados (planificada → cerrada). Espeja STATE_ORDER del backend. */
export const STATE_ORDER = ['planificada', 'pendiente', 'en_progreso', 'revision', 'completada', 'cancelada'] as const;

/** Opciones para selects de estado. */
export const STATE_OPTIONS = STATE_ORDER.map((value) => ({ value, label: STATE_LABEL[value] }));

export const OPEN_STATES: string[] = ['planificada', 'pendiente', 'en_progreso', 'revision'];
export const CLOSED_STATES: string[] = ['completada', 'cancelada'];

/** Variante de Badge para un estado (verde = cerrado, azul = en curso, gris = pendiente). */
export function stateBadgeVariant(state: string): 'success' | 'default' | 'secondary' {
  if (['completada', 'completed', 'done'].includes(state)) return 'success';
  if (['en_progreso', 'started', 'in_progress'].includes(state)) return 'default';
  return 'secondary';
}

/** Opciones para selects de prioridad, de más urgente a menos. */
export const PRIO_OPTIONS = [
  { value: 'urgent', label: 'Urgente' },
  { value: 'high', label: 'Alta' },
  { value: 'medium', label: 'Media' },
  { value: 'low', label: 'Baja' },
];

/** Prioridad → etiqueta en español (incluye el caso "sin prioridad"). */
export const PRIO_LABEL: Record<string, string> = {
  urgent: 'Urgente',
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
  'sin prioridad': 'Sin prioridad',
};

/** Prioridad → clase de fondo (para dots/indicadores). */
export const PRIO_DOT: Record<string, string> = {
  urgent: 'bg-destructive',
  high: 'bg-warning',
  medium: 'bg-chart-1',
  low: 'bg-muted-foreground',
};

/** Prioridad → color CSS resoluble (para charts que reciben un string de color). */
export const PRIO_COLOR_VAR: Record<string, string> = {
  urgent: 'hsl(var(--destructive))',
  high: 'hsl(var(--warning))',
  medium: 'hsl(var(--chart-1))',
  low: 'hsl(var(--muted-foreground))',
};

/** Prioridad → { etiqueta, dot } (conveniencia para vistas que necesitan ambos, p.ej. el calendario). */
export const PRIO: Record<string, { label: string; dot: string }> = {
  urgent: { label: 'Urgente', dot: 'bg-destructive' },
  high: { label: 'Alta', dot: 'bg-warning' },
  medium: { label: 'Media', dot: 'bg-chart-1' },
  low: { label: 'Baja', dot: 'bg-muted-foreground' },
};

/** Orden de prioridad (para ordenar de más urgente a menos). */
export const PRIO_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Color de barra por etiqueta de estado (heurístico): verde terminado, azul en curso, gris pendiente. */
export function stateColorVar(label: string): string {
  const l = label.toLowerCase();
  if (/(done|complet|hecho|cerrad)/.test(l)) return 'hsl(var(--success))';
  if (/(progress|curso|review|revis|sprint)/.test(l)) return 'hsl(var(--chart-1))';
  return 'hsl(var(--muted-foreground))';
}

// ---- Cola de procesamiento (outbox) ----
// Los tipos crudos ('commit.received') no significan nada para quien mira. Cada uno lleva DOS
// textos: el gerundio de lo que está pasando y el resultado de lo que pasó. El sufijo con la
// persona ("de Sebas" / "a Sebastián") lo concatena la fila, solo si hay persona.

export type QueueFamily = 'commit' | 'pr' | 'task' | 'doc' | 'repo';

export interface QueueEventLabel {
  /** Mientras está en cola o ejecutándose. */
  doing: string;
  /** Ya resuelto (lo que quedó hecho). */
  done: string;
  family: QueueFamily;
}

export const QUEUE_EVENT: Record<string, QueueEventLabel> = {
  'commit.received': { doing: 'Procesando commit', done: 'Commit acreditado', family: 'commit' },
  'commits.backfill': { doing: 'Enumerando commits del push', done: 'Push enumerado', family: 'commit' },
  'repo.backfill': { doing: 'Importando historial', done: 'Historial importado', family: 'repo' },
  'branch.created': { doing: 'Ligando la rama a su tarea', done: 'Rama ligada', family: 'pr' },
  'pr.opened': { doing: 'Ligando la PR a su tarea', done: 'PR abierta y ligada', family: 'pr' },
  'pr.reviewed': { doing: 'Registrando la revisión', done: 'Revisión registrada', family: 'pr' },
  'pr.merged': { doing: 'Documentando la PR', done: 'PR integrada', family: 'pr' },
  'work_item.created': { doing: 'Avisando al responsable', done: 'Tarea creada', family: 'task' },
  'work_item.assigned': { doing: 'Avisando al responsable', done: 'Tarea asignada', family: 'task' },
  'work_item.done': { doing: 'Documentando el trabajo', done: 'Tarea documentada', family: 'task' },
  'change.documented': { doing: 'Notificando los cambios', done: 'Cambios documentados', family: 'doc' },
  'repo.detected': { doing: 'Vinculando el repo', done: 'Repo vinculado', family: 'repo' },
  'repo.renamed': { doing: 'Moviendo el historial', done: 'Repo renombrado', family: 'repo' },
  'repo.notify': { doing: 'Avisando al equipo', done: 'Aviso enviado', family: 'repo' },
  'notification.requested': { doing: 'Enviando la notificación', done: 'Notificación enviada', family: 'doc' },
  // Heredados de Linear (previos al teardown). Ya no se emiten, pero el histórico del outbox tiene
  // cientos y sin esto se leerían como el string crudo. Mismo criterio que STATE_LABEL.
  'linear.issue_upserted': { doing: 'Sincronizando ticket', done: 'Ticket sincronizado (Linear)', family: 'task' },
  'linear.issue_removed': { doing: 'Quitando ticket', done: 'Ticket eliminado (Linear)', family: 'task' },
  'linear.project_upserted': { doing: 'Sincronizando proyecto', done: 'Proyecto sincronizado (Linear)', family: 'repo' },
};

/** Clases COMPLETAS y estáticas: Tailwind no detecta las construidas en runtime. */
export const QUEUE_FAMILY: Record<QueueFamily, string> = {
  commit: 'bg-chart-1/12 text-chart-1',
  pr: 'bg-chart-3/12 text-chart-3',
  task: 'bg-chart-4/12 text-chart-4',
  doc: 'bg-chart-2/12 text-chart-2',
  repo: 'bg-muted text-muted-foreground',
};

/**
 * Cómo se nombra un evento que NO llegó a completarse (fallido o muerto).
 *
 * Sin esto, un evento muerto mostraba su etiqueta de éxito —"Commit acreditado", "Tarea
 * documentada"— afirmando exactamente lo contrario de lo que pasó, y justo en la lista que existe
 * para diagnosticar fallos. Se agrupa por familia porque el detalle real lo da el error de abajo.
 */
export const QUEUE_FAMILY_FAILED: Record<QueueFamily, string> = {
  commit: 'Commit sin procesar',
  pr: 'PR sin procesar',
  task: 'Tarea sin documentar',
  doc: 'Aviso sin enviar',
  repo: 'Repo sin sincronizar',
};

/** Salud de la cola. Mismo shape que el STATUS de Infra, para que las dos vistas se lean igual. */
export const QUEUE_HEALTH: Record<string, { label: string; dot: string; pill: string }> = {
  idle: { label: 'Al día', dot: 'bg-success', pill: 'bg-success/12 text-success' },
  working: { label: 'Procesando', dot: 'bg-primary', pill: 'bg-primary/12 text-primary' },
  delayed: { label: 'Retrasada', dot: 'bg-warning', pill: 'bg-warning/12 text-warning' },
  failing: { label: 'Con fallas', dot: 'bg-destructive', pill: 'bg-destructive/12 text-destructive' },
  unknown: { label: 'Sin contacto', dot: 'bg-muted-foreground/40', pill: 'bg-muted text-muted-foreground' },
};

/** Origen del ticket (cómo nació el trabajo). */
export const SOURCE_LABEL: Record<string, string> = { pr: 'Pull Request', commit: 'Commit', native: 'Nativa', linear: 'Linear' };
export const SOURCE_COLOR: Record<string, string> = {
  pr: 'hsl(var(--chart-1))',
  commit: 'hsl(var(--chart-4))',
  native: 'hsl(var(--chart-3))',
  linear: 'hsl(var(--muted-foreground))',
};

/**
 * Presencia del dev según su calendario. Mismo shape que QUEUE_HEALTH, para que las dos se lean igual.
 *
 * `busy` dice "En un evento" y no "Ocupado": es un respaldo para cuando no se conoce el título, y
 * "ocupado" sería un juicio sobre una actividad que puede ser perfectamente interrumpible.
 */
export const DEV_PRESENCE: Record<string, { label: string; dot: string; pill: string }> = {
  busy: { label: 'En un evento', dot: 'bg-warning', pill: 'bg-warning/12 text-warning' },
  free: { label: 'Sin actividad', dot: 'bg-success', pill: 'bg-success/12 text-success' },
  unknown: { label: 'Sin calendario', dot: 'bg-muted-foreground/40', pill: 'bg-muted text-muted-foreground' },
};
