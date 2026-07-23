// Fuente ÚNICA de etiquetas y colores de estado / prioridad / origen. Antes cada página
// (Overview, Tickets, Tasks, ProjectDetail) y bits.tsx redefinían estos mapas con variantes
// ligeramente distintas; centralizarlos evita que se desincronicen.

/** Estado del work_item → etiqueta en español. */
export const STATE_LABEL: Record<string, string> = {
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

/** Variante de Badge para un estado (verde = cerrado, azul = en curso, gris = pendiente). */
export function stateBadgeVariant(state: string): 'success' | 'default' | 'secondary' {
  if (['completed', 'done'].includes(state)) return 'success';
  if (['started', 'in_progress'].includes(state)) return 'default';
  return 'secondary';
}

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
