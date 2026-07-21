import { describe, it, expect } from 'vitest';
import { referencesLinearIssue } from '../src/adapters/github.js';

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
