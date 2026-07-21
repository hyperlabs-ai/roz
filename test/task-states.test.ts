import { describe, it, expect } from 'vitest';
import { referencesLinearIssue } from '../src/adapters/github.js';
import { isOpenState, isClosedState, transitionTimestamps, STATE_LABEL } from '../src/tasks/states.js';

// La convención código→tarea reusa el matcher de identificadores (KEY-N). Estos casos fijan que
// funcione en nombres de rama, títulos y cuerpos de PR — la base de toda la automatización.
describe('referencesLinearIssue (convención ROZ-123)', () => {
  it('capta el identificador en un nombre de rama', () => {
    expect(referencesLinearIssue('feat/ROZ-123-auth')).toBe('ROZ-123');
    expect(referencesLinearIssue('fix/HYP-42')).toBe('HYP-42');
  });
  it('capta el identificador en título/cuerpo de PR', () => {
    expect(referencesLinearIssue('Cierra ROZ-7: login con Google')).toBe('ROZ-7');
  });
  it('devuelve null cuando no hay identificador', () => {
    expect(referencesLinearIssue('feat/algo-sin-tarea')).toBeNull();
    expect(referencesLinearIssue('bump v2-3')).toBeNull();
  });
});

describe('estados de tarea', () => {
  it('clasifica abiertos vs cerrados', () => {
    expect(isOpenState('started')).toBe(true);
    expect(isOpenState('review')).toBe(true);
    expect(isClosedState('completed')).toBe(true);
    expect(isClosedState('canceled')).toBe(true);
    expect(isClosedState('backlog')).toBe(false);
  });
  it('setea el timestamp de transición correcto', () => {
    expect(transitionTimestamps('started', 'T')).toEqual({ started_at: 'T' });
    expect(transitionTimestamps('review', 'T')).toEqual({ started_at: 'T' });
    expect(transitionTimestamps('completed', 'T')).toEqual({ completed_at: 'T' });
    expect(transitionTimestamps('canceled', 'T')).toEqual({ canceled_at: 'T' });
    expect(transitionTimestamps('backlog', 'T')).toEqual({});
  });
  it('tiene etiqueta legible para cada estado', () => {
    expect(STATE_LABEL.review).toBe('En revisión');
    expect(STATE_LABEL.completed).toBe('Completado');
  });
});
