// Reglas puras de los tickets inteligentes (/ticket): cuándo se reutiliza una vista previa, cómo se
// aplican las correcciones de la persona y qué mensaje se manda. Sin base ni red, para probarlas
// solas (mismo patrón que src/assign/rules.ts).
import type { TaskInput } from '../assign/classify.js';

/** Lo único que escribe la persona. */
export interface TicketInput {
  title: string;
  projectId: string;
  description: string;
}

/** Lo que la persona corrigió en la vista previa. `undefined` = no lo tocó (se queda lo de roz). */
export interface TicketCorrections {
  solutionTypeId?: string | null;
  points?: number | null;
  priority?: string | null;
  dueDate?: string | null;
}

/** Una vista previa vieja ya no se reutiliza: la carga del equipo pudo cambiar y conviene volver a leer. */
export const PREVIEW_REUSE_MS = 2 * 60 * 60 * 1000;

export function normalizeTicket(i: TicketInput): TicketInput {
  return { title: i.title.trim(), projectId: i.projectId, description: i.description.trim() };
}

export function sameTicket(a: TicketInput, b: TicketInput): boolean {
  const x = normalizeTicket(a);
  const y = normalizeTicket(b);
  return x.title === y.title && x.projectId === y.projectId && x.description === y.description;
}

export interface PreviewRowLite {
  outcome: string;
  requested_by: string | null;
  created_at: string;
  decided_at: string | null;
  /** La vista previa guarda lo que escribió la persona junto a la clasificación. */
  ticket: TicketInput | null;
}

export type PreviewCheck = 'ok' | 'no_es_vista_previa' | 'otro_autor' | 'texto_cambio' | 'vencida' | 'ya_usada';

/**
 * ¿Se puede reutilizar la respuesta de Jev de esta vista previa para el mismo ticket? Solo si es de
 * la misma persona y el texto no cambió (Jev solo lee el texto: corregir el tipo, los puntos o la
 * prioridad NO requiere volver a preguntarle).
 */
export function checkPreview(row: PreviewRowLite, input: TicketInput, userId: string, now = Date.now()): PreviewCheck {
  if (row.outcome !== 'preview') return 'no_es_vista_previa';
  if (row.requested_by !== userId) return 'otro_autor';
  if (!row.ticket || !sameTicket(row.ticket, input)) return 'texto_cambio';
  if (row.decided_at) return 'ya_usada';
  if (now - Date.parse(row.created_at) > PREVIEW_REUSE_MS) return 'vencida';
  return 'ok';
}

/** La respuesta de Jev se puede reusar aunque la fila ya no sirva (vencida o ya usada): el texto es el mismo. */
export function canReuseAnswers(check: PreviewCheck): boolean {
  return check === 'ok' || check === 'vencida' || check === 'ya_usada';
}

/** Las correcciones cuentan como lo que fijó una persona (fuente `humano`), igual que en una tarea. */
export function applyCorrections(task: TaskInput, c: TicketCorrections | undefined): TaskInput {
  if (!c) return task;
  return {
    ...task,
    ...(c.solutionTypeId !== undefined ? { solutionTypeId: c.solutionTypeId } : {}),
    ...(c.points !== undefined ? { estimate: c.points } : {}),
    ...(c.priority !== undefined ? { priority: c.priority, prioritySource: 'humano' as const } : {}),
    ...(c.dueDate !== undefined ? { dueDate: c.dueDate } : {}),
  };
}

/** Prioridad que propone roz: urgente si la leyó urgente; si no, media. La persona la puede cambiar. */
export function suggestedPriority(urgency: string): 'urgent' | 'medium' {
  return urgency === 'urgente' ? 'urgent' : 'medium';
}

/** El mensaje que llega por DM, desde el perfil de quien pidió el ticket. `#KEY-12` se pinta como tarjeta. */
export function assignmentMessage(identifier: string): string {
  return `Te asigné una nueva tarea #${identifier}`;
}

/** Cambiar al responsable que propuso roz pide motivo (igual que corregir una asignación automática). */
export function needsOverrideOnCreate(rozChoice: string | null, assignee: string | null): boolean {
  return rozChoice !== null && assignee !== rozChoice;
}

/** ¿Se manda el DM? Solo si hay responsable y no es la misma persona que pidió el ticket. */
export function shouldMessage(requesterDevId: string, assignee: string | null): assignee is string {
  return !!assignee && assignee !== requesterDevId;
}
