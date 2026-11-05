// Asignación automática del lado del cliente: la regla de override (espejo de isOverride en
// src/assign/rules.ts) y las etiquetas en español de lo que devuelve el backend. Módulo PURO (sin
// React) para poder probarlo y reutilizarlo en el diálogo y en la tabla.
// Solo TIPOS de ./api (que carga el cliente de Supabase): así este módulo se prueba en Node.
import type { AssignCandidate, Ticket } from './api';

/**
 * ¿Cambiar los responsables a `next` corrige a roz? Solo si roz eligió al responsable actual, nadie
 * lo ha corregido aún y el nuevo principal es otro (o nadie). Agregar apoyo no cuenta. El backend
 * aplica la misma regla y responde 409 si falta el motivo: esto solo evita el viaje de ida y vuelta.
 */
export function needsOverride(task: Ticket | null | undefined, next: string[]): boolean {
  const a = task?.autoAssign;
  if (!task || !a || a.state !== 'assigned' || !a.chosenDevId) return false;
  const current = task.assignees?.[0]?.id ?? task.assignee?.id ?? null;
  if (current !== a.chosenDevId) return false;
  return (next[0] ?? null) !== a.chosenDevId;
}

/** ¿El backend pidió motivo (409 OVERRIDE_REASON_REQUIRED)? Por el código, no por la clase del error. */
export function isOverrideRequired(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'OVERRIDE_REASON_REQUIRED';
}

export const TIER_LABEL: Record<NonNullable<AssignCandidate['tier']>, string> = {
  encargado: 'Encargado del proyecto',
  subencargado: 'Subencargado',
  especialista: 'Especialista',
  pool: 'Equipo general',
};

export const RELATION_LABEL: Record<AssignCandidate['relation'], string> = {
  encargado: 'encargado',
  subencargado: 'subencargado',
  externo: 'externo con historial',
  externo_sin_historial: 'externo sin historial',
};

export const REASON_LABEL: Record<string, string> = {
  inactivo: 'Inactivo',
  rol_no_asignable: 'Rol sin asignación automática',
  sin_disponibilidad: 'Sin disponibilidad',
  skill_insuficiente: 'Skill insuficiente',
  wip_tareas: 'Tope de tareas activas',
  wip_proyectos: 'Tope de proyectos',
  capacidad: 'Sin capacidad antes de la fecha',
};

export const SUGGESTION_LABEL: Record<string, string> = {
  dividir: 'Dividir la tarea',
  repriorizar: 'Repriorizar',
  backlog: 'Mandar a backlog',
  clasificar: 'Falta información',
};

/** Puntos → texto corto ("3 pts ≈ 6 h"). 1 pt = 2 h. */
export function pointsLabel(p: number): string {
  return `${p} ${p === 1 ? 'pt' : 'pts'} ≈ ${p * 2} h`;
}

export const URGENCY_LABEL: Record<string, string> = {
  urgente: 'Urgente',
  no_urgente: 'No urgente',
  incierta: 'Urgencia incierta',
};

/** Quién dio cada dato de la clasificación. */
export const SOURCE_LABEL: Record<string, string> = {
  humano: 'tú',
  intake: 'intake',
  jev: 'roz',
  regla: 'regla',
};

export const FAILED_REASON_LABEL: Record<string, string> = {
  error_jev: 'TypeSafe no respondió',
  error_interno: 'Error interno',
  abandonada: 'La corrida no terminó',
};
