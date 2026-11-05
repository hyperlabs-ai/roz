import { describe, it, expect } from 'vitest';
import type { TaskInput } from '../src/assign/classify.js';
import {
  PREVIEW_REUSE_MS,
  applyCorrections,
  assignmentMessage,
  canReuseAnswers,
  checkPreview,
  needsOverrideOnCreate,
  shouldMessage,
  suggestedPriority,
  type PreviewRowLite,
} from '../src/tickets/rules.js';
import { POINT_SCALE, slugify, solutionTypeProblem } from '../src/dashboard/solution-types.js';
import { extractTaskIdentifiers } from '../src/chat/text.js';
import { slashHint, ticketCommand } from '../web/src/lib/chat-text.js';

// Tickets inteligentes (/ticket): cuándo se reusa la respuesta de Jev, cómo cuentan las correcciones
// de la persona, qué mensaje sale y cuándo hay que explicar un cambio de responsable.

const T0 = Date.parse('2026-11-04T10:00:00Z');
const TICKET = { title: 'Checkout no cobra', projectId: 'p1', description: 'El botón de pagar falla con tarjeta.' };
function row(over: Partial<PreviewRowLite> = {}): PreviewRowLite {
  return { outcome: 'preview', requested_by: 'u1', created_at: new Date(T0).toISOString(), decided_at: null, ticket: TICKET, ...over };
}

describe('reusar una vista previa', () => {
  it('misma persona y mismo texto → se reusa (corregir tipo o puntos no vuelve a llamar a Jev)', () => {
    expect(checkPreview(row(), TICKET, 'u1', T0 + 60_000)).toBe('ok');
  });

  it('espacios de más no cuentan como cambio de texto', () => {
    expect(checkPreview(row(), { ...TICKET, title: `  ${TICKET.title} ` }, 'u1', T0)).toBe('ok');
  });

  it('otra persona, otro texto u otro proyecto → no se reusa', () => {
    expect(checkPreview(row(), TICKET, 'u2', T0)).toBe('otro_autor');
    expect(checkPreview(row(), { ...TICKET, description: 'otra cosa' }, 'u1', T0)).toBe('texto_cambio');
    expect(checkPreview(row(), { ...TICKET, projectId: 'p2' }, 'u1', T0)).toBe('texto_cambio');
    expect(checkPreview(row({ ticket: null }), TICKET, 'u1', T0)).toBe('texto_cambio');
  });

  it('vieja o ya usada: la fila no se reusa, pero la respuesta de Jev sí (el texto es el mismo)', () => {
    const vencida = checkPreview(row(), TICKET, 'u1', T0 + PREVIEW_REUSE_MS + 1);
    const usada = checkPreview(row({ decided_at: new Date(T0).toISOString() }), TICKET, 'u1', T0);
    expect(vencida).toBe('vencida');
    expect(usada).toBe('ya_usada');
    expect(canReuseAnswers(vencida)).toBe(true);
    expect(canReuseAnswers(usada)).toBe(true);
    expect(canReuseAnswers('texto_cambio')).toBe(false);
    expect(canReuseAnswers('otro_autor')).toBe(false);
  });

  it('una decisión que ya no es vista previa no se toca', () => {
    expect(checkPreview(row({ outcome: 'assigned' }), TICKET, 'u1', T0)).toBe('no_es_vista_previa');
  });
});

describe('correcciones de la persona (cuentan como "humano")', () => {
  const base: TaskInput = {
    id: 'ticket',
    name: 'x',
    description: null,
    projectId: 'p1',
    projectName: 'P',
    projectKind: 'client',
    priority: null,
    prioritySource: 'humano',
    dueDate: null,
    estimate: null,
    solutionTypeId: null,
  };

  it('solo cambia lo que la persona tocó', () => {
    expect(applyCorrections(base, undefined)).toEqual(base);
    expect(applyCorrections(base, {})).toEqual(base);
    const c = applyCorrections(base, { solutionTypeId: 't1', points: 8 });
    expect(c.solutionTypeId).toBe('t1');
    expect(c.estimate).toBe(8);
    expect(c.priority).toBeNull();
  });

  it('prioridad y fecha escritas por la persona', () => {
    const c = applyCorrections(base, { priority: 'high', dueDate: '2026-11-10' });
    expect(c.priority).toBe('high');
    expect(c.prioritySource).toBe('humano');
    expect(c.dueDate).toBe('2026-11-10');
  });

  it('roz propone urgente solo si la leyó urgente', () => {
    expect(suggestedPriority('urgente')).toBe('urgent');
    expect(suggestedPriority('no_urgente')).toBe('medium');
    expect(suggestedPriority('incierta')).toBe('medium');
  });
});

describe('al crear', () => {
  it('cambiar al responsable que propuso roz pide motivo; aceptarlo o no tener propuesta, no', () => {
    expect(needsOverrideOnCreate('roz', 'otra')).toBe(true);
    expect(needsOverrideOnCreate('roz', null)).toBe(true);
    expect(needsOverrideOnCreate('roz', 'roz')).toBe(false);
    expect(needsOverrideOnCreate(null, 'otra')).toBe(false);
  });

  it('el DM sale solo si hay responsable y no es quien pidió el ticket', () => {
    expect(shouldMessage('yo', 'otra')).toBe(true);
    expect(shouldMessage('yo', 'yo')).toBe(false);
    expect(shouldMessage('yo', null)).toBe(false);
  });

  it('el mensaje cita la tarea con #KEY-N para que el chat la pinte como tarjeta', () => {
    const body = assignmentMessage('PROPI-42');
    expect(body).toBe('Te asigné una nueva tarea #PROPI-42');
    expect(extractTaskIdentifiers(body)).toEqual(['PROPI-42']);
  });
});

describe('tipos de solución (tabla editable)', () => {
  const ok = { name: 'Endpoint / CRUD', description: 'APIs', primarySkillId: 's1', secondarySkillId: 's2', minLevel: 3, sizeMin: 2, sizeMax: 5 };

  it('un tipo válido no tiene problemas (también "del módulo", sin primaria)', () => {
    expect(solutionTypeProblem(ok)).toBeNull();
    expect(solutionTypeProblem({ ...ok, primarySkillId: null })).toBeNull();
  });

  it('nivel 1–5, tamaño en la escala y mínimo ≤ máximo', () => {
    expect(solutionTypeProblem({ ...ok, minLevel: 0 })).toMatch(/nivel/);
    expect(solutionTypeProblem({ ...ok, minLevel: 6 })).toMatch(/nivel/);
    expect(solutionTypeProblem({ ...ok, sizeMin: 4 })).toMatch(/escala/);
    expect(solutionTypeProblem({ ...ok, sizeMin: 8, sizeMax: 5 })).toMatch(/mayor/);
    expect(POINT_SCALE).toEqual([1, 2, 3, 5, 8, 13]);
  });

  it('nombre y descripción obligatorios (la descripción es lo que lee roz); secundaria ≠ primaria', () => {
    expect(solutionTypeProblem({ ...ok, name: '  ' })).toMatch(/nombre/);
    expect(solutionTypeProblem({ ...ok, description: '' })).toMatch(/descripción/);
    expect(solutionTypeProblem({ ...ok, secondarySkillId: 's1' })).toMatch(/secundaria/);
  });

  it('slug legible y estable', () => {
    expect(slugify('Endpoint / CRUD')).toBe('endpoint-crud');
    expect(slugify('Migración / modelo de datos')).toBe('migracion-modelo-de-datos');
    expect(slugify('¿?')).toBe('tipo');
  });
});

describe('/ticket en el chat', () => {
  it('abre el formulario con lo que siga como nombre (no se envía como mensaje)', () => {
    expect(ticketCommand('/ticket')).toEqual({ title: '' });
    expect(ticketCommand('  /ticket Arreglar el login  ')).toEqual({ title: 'Arreglar el login' });
    expect(ticketCommand('/TICKET checkout')).toEqual({ title: 'checkout' });
  });

  it('cualquier otro texto es un mensaje normal', () => {
    expect(ticketCommand('/tickets')).toBeNull();
    expect(ticketCommand('hola /ticket')).toBeNull();
    expect(ticketCommand('/status')).toBeNull();
  });

  it('sugiere el comando mientras se escribe su prefijo', () => {
    expect(slashHint('/')).toBe(true);
    expect(slashHint('/tic')).toBe(true);
    expect(slashHint('/ticket')).toBe(true);
    expect(slashHint('/ticket algo')).toBe(false);
    expect(slashHint('/x')).toBe(false);
    expect(slashHint('hola')).toBe(false);
  });
});
