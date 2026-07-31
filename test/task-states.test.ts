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
    expect(isOpenState('en_progreso')).toBe(true);
    expect(isOpenState('revision')).toBe(true);
    expect(isClosedState('completada')).toBe(true);
    expect(isClosedState('cancelada')).toBe(true);
    expect(isClosedState('planificada')).toBe(false);
  });
  it('setea el timestamp de transición correcto', () => {
    expect(transitionTimestamps('en_progreso', 'T')).toEqual({ started_at: 'T' });
    expect(transitionTimestamps('revision', 'T')).toEqual({ started_at: 'T' });
    expect(transitionTimestamps('completada', 'T')).toEqual({ completed_at: 'T' });
    expect(transitionTimestamps('cancelada', 'T')).toEqual({ canceled_at: 'T' });
    expect(transitionTimestamps('planificada', 'T')).toEqual({});
  });
  it('tiene etiqueta legible para cada estado', () => {
    expect(STATE_LABEL.revision).toBe('En revisión');
    expect(STATE_LABEL.completada).toBe('Completada');
  });
});
