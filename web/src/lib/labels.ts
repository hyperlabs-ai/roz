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

/** Origen del ticket (cómo nació el trabajo). */
export const SOURCE_LABEL: Record<string, string> = { pr: 'Pull Request', commit: 'Commit', native: 'Nativa', linear: 'Linear' };
export const SOURCE_COLOR: Record<string, string> = {
  pr: 'hsl(var(--chart-1))',
  commit: 'hsl(var(--chart-4))',
  native: 'hsl(var(--chart-3))',
  linear: 'hsl(var(--muted-foreground))',
};
