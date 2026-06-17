import { describe, it, expect } from 'vitest';
import { priorityToLinear, linearToPriority } from '../src/adapters/linear.js';
import { referencesLinearIssue } from '../src/adapters/github.js';

describe('priorityToLinear', () => {
  it('mapea las prioridades conocidas', () => {
    expect(priorityToLinear('urgent')).toBe(1);
    expect(priorityToLinear('high')).toBe(2);
    expect(priorityToLinear('medium')).toBe(3);
    expect(priorityToLinear('low')).toBe(4);
  });
  it('devuelve 0 (none) para desconocida o vacía', () => {
    expect(priorityToLinear()).toBe(0);
    expect(priorityToLinear('xxx')).toBe(0);
  });
});

describe('linearToPriority', () => {
  it('invierte el mapeo', () => {
    expect(linearToPriority(1)).toBe('urgent');
    expect(linearToPriority(4)).toBe('low');
    expect(linearToPriority(0)).toBeNull();
    expect(linearToPriority(null)).toBeNull();
  });
});

describe('referencesLinearIssue', () => {
  it('detecta un identifier tipo ABC-123', () => {
    expect(referencesLinearIssue('fix: resuelve ROZ-42 del login')).toBe('ROZ-42');
    expect(referencesLinearIssue('ENG-7 wip')).toBe('ENG-7');
  });
  it('devuelve null si no hay referencia', () => {
    expect(referencesLinearIssue('chore: bump deps')).toBeNull();
    expect(referencesLinearIssue('lowercase abc-1 no cuenta')).toBeNull();
  });
});
